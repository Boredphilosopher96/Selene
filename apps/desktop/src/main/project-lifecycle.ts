import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { validateReactSourceWorkspace, type ReactSourceWorkspace } from '@selene/core';

/** Current durable, local-only project record. Network delivery is intentionally absent. */
export const LOCAL_PROJECT_RECORD_FORMAT = 'selene-local-project/v2' as const;
const LEGACY_PROJECT_RECORD_FORMAT = 'selene-local-project/v1' as const;

export type LocalProjectOrigin = 'sample' | 'template' | 'created' | 'imported' | 'duplicated';
export type LocalProjectStatus = 'active' | 'archived';

export interface LocalProjectMetadata {
  readonly id: string;
  readonly name: string;
  readonly origin: LocalProjectOrigin;
  readonly status: LocalProjectStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastOpenedAt?: string;
}

export interface LocalProjectVersion {
  readonly id: string;
  readonly createdAt: string;
  readonly summary: string;
  readonly workspace: ReactSourceWorkspace;
}

export interface AutosaveDraft {
  readonly savedAt: string;
  readonly workspace: ReactSourceWorkspace;
}

export interface LocalProjectRecord {
  readonly format: typeof LOCAL_PROJECT_RECORD_FORMAT;
  readonly schemaVersion: 2;
  /** Monotonic across retention pruning; prevents version-ID reuse. */
  readonly versionSequence: number;
  readonly project: LocalProjectMetadata;
  /** The last known-good, explicitly committed design source. */
  readonly current: ReactSourceWorkspace;
  readonly versions: readonly LocalProjectVersion[];
  /** A crash-recoverable draft. It never replaces `current` until recovery is explicit. */
  readonly autosave?: AutosaveDraft;
}

export interface ProjectQuarantineEntry {
  readonly projectId: string;
  readonly detectedAt: string;
  readonly reason: string;
  readonly raw: unknown;
}

/**
 * The sole persistence boundary. `commit` must replace one record atomically;
 * callers build and validate the complete next record before invoking it.
 */
export interface ProjectLifecycleStoragePort {
  listProjectIds(): Promise<readonly string[]>;
  read(projectId: string): Promise<unknown | undefined>;
  commit(projectId: string, record: LocalProjectRecord): Promise<void>;
  /** Preserve the raw failing data before removing it from the active project set. */
  quarantine(entry: ProjectQuarantineEntry): Promise<void>;
  /** Shared storage-scoped serialization for every project read-modify-write operation. */
  withProjectLock<T>(projectId: string, operation: () => Promise<T>): Promise<T>;
}

export class ProjectLifecycleError extends Error {
  public constructor(
    public readonly code:
      | 'NOT_FOUND'
      | 'ARCHIVED'
      | 'ALREADY_EXISTS'
      | 'NO_AUTOSAVE'
      | 'NO_UNDO'
      | 'VERSION_NOT_FOUND'
      | 'PROJECT_QUARANTINED'
      | 'INVALID_PROJECT',
    message: string
  ) {
    super(message);
    this.name = 'ProjectLifecycleError';
  }
}

export interface LifecycleOptions {
  readonly now?: () => string;
  /** Retain enough history for safe undo while bounding durable project size. */
  readonly maxVersions?: number;
  /** Bound captured corrupt payloads before they reach any quarantine storage port. */
  readonly maxQuarantineBytes?: number;
  /** Reject oversized imports before parsing/migrating them. */
  readonly maxImportBytes?: number;
}

interface DecodedRecord {
  readonly record: LocalProjectRecord;
  readonly migrated: boolean;
}

const storageLocks = new Map<string, Promise<void>>();

async function withSharedLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = storageLocks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => gate);
  storageLocks.set(key, chain);
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (storageLocks.get(key) === chain) storageLocks.delete(key);
  }
}

const projectIdPattern = /^[a-z][a-z0-9-]{0,63}$/;
const versionIdPattern = /^[A-Za-z][A-Za-z0-9._:-]{0,255}$/;
const MAX_NAME_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 512;
const DEFAULT_MAX_VERSIONS = 50;
const DEFAULT_MAX_QUARANTINE_ENTRIES = 20;
const DEFAULT_MAX_QUARANTINE_BYTES = 64 * 1024;
const DEFAULT_MAX_IMPORT_BYTES = 1024 * 1024;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`${name} is required`);
  return value;
}

function normalizedText(value: unknown, name: string, maximum: number): string {
  const result = text(value, name).trim().normalize('NFC');
  if (result.length > maximum) throw new Error(`${name} must be at most ${maximum} characters`);
  return result;
}

function timestamp(value: unknown, name: string): string {
  const result = text(value, name);
  if (Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result)
    throw new Error(`${name} must be a canonical ISO timestamp`);
  return result;
}

function projectId(value: unknown, name = 'project id'): string {
  const result = text(value, name);
  if (!projectIdPattern.test(result))
    throw new Error(`${name} must be a lowercase identifier up to 64 characters`);
  return result;
}

function workspace(value: unknown, name: string): ReactSourceWorkspace {
  try {
    validateReactSourceWorkspace(value as ReactSourceWorkspace);
    const validated = clone(value as ReactSourceWorkspace);
    const revisionId = text(validated.revision.id, 'workspace.revision.id');
    if (!versionIdPattern.test(revisionId)) throw new Error('workspace.revision.id is invalid');
    return {
      ...validated,
      revision: {
        ...validated.revision,
        id: revisionId,
        createdAt: timestamp(validated.revision.createdAt, 'workspace.revision.createdAt'),
        summary: normalizedText(
          validated.revision.summary,
          'workspace.revision.summary',
          MAX_SUMMARY_LENGTH
        )
      }
    };
  } catch (error) {
    throw new Error(
      `${name} is not a valid portable React workspace: ${error instanceof Error ? error.message : 'invalid workspace'}`,
      { cause: error }
    );
  }
}

function metadata(value: unknown): LocalProjectMetadata {
  const input = record(value, 'project');
  const origin = input.origin;
  const status = input.status;
  if (!['sample', 'template', 'created', 'imported', 'duplicated'].includes(String(origin)))
    throw new Error('project.origin is invalid');
  if (status !== 'active' && status !== 'archived') throw new Error('project.status is invalid');
  const lastOpenedAt =
    input.lastOpenedAt === undefined
      ? undefined
      : timestamp(input.lastOpenedAt, 'project.lastOpenedAt');
  return {
    id: projectId(input.id),
    name: normalizedText(input.name, 'project.name', MAX_NAME_LENGTH),
    origin: origin as LocalProjectOrigin,
    status,
    createdAt: timestamp(input.createdAt, 'project.createdAt'),
    updatedAt: timestamp(input.updatedAt, 'project.updatedAt'),
    ...(lastOpenedAt === undefined ? {} : { lastOpenedAt })
  };
}

function version(value: unknown): LocalProjectVersion {
  const input = record(value, 'version');
  const id = text(input.id, 'version.id');
  if (!versionIdPattern.test(id)) throw new Error('version.id is invalid');
  return {
    id,
    createdAt: timestamp(input.createdAt, 'version.createdAt'),
    summary: normalizedText(input.summary, 'version.summary', MAX_SUMMARY_LENGTH),
    workspace: workspace(input.workspace, 'version.workspace')
  };
}

function autosave(value: unknown): AutosaveDraft {
  const input = record(value, 'autosave');
  return {
    savedAt: timestamp(input.savedAt, 'autosave.savedAt'),
    workspace: workspace(input.workspace, 'autosave.workspace')
  };
}

function decodeV2(value: unknown): LocalProjectRecord {
  const input = record(value, 'project record');
  if (input.format !== LOCAL_PROJECT_RECORD_FORMAT || input.schemaVersion !== 2)
    throw new Error('unsupported project record format');
  const current = workspace(input.current, 'current');
  const project = metadata(input.project);
  if (!Number.isSafeInteger(input.versionSequence) || (input.versionSequence as number) < 1)
    throw new Error('versionSequence must be a positive safe integer');
  if (project.id !== current.projectId)
    throw new Error('project ID must match workspace project ID');
  if (!Array.isArray(input.versions) || input.versions.length === 0)
    throw new Error('project record must retain at least one version');
  const versions = input.versions.map(version);
  if ((input.versionSequence as number) < versions.length)
    throw new Error('versionSequence cannot be behind retained history');
  const ids = new Set<string>();
  const revisionIds = new Set<string>();
  for (const [index, entry] of versions.entries()) {
    const previous = index === 0 ? undefined : versions[index - 1];
    if (ids.has(entry.id)) throw new Error('version IDs must be unique');
    if (revisionIds.has(entry.workspace.revision.id))
      throw new Error('version workspace revisions must be unique');
    if (previous !== undefined && previous.createdAt >= entry.createdAt)
      throw new Error('version timestamps must be strictly increasing');
    if (entry.workspace.projectId !== project.id)
      throw new Error('version workspace project ID must match project ID');
    ids.add(entry.id);
    revisionIds.add(entry.workspace.revision.id);
  }
  if (versions.at(-1)?.workspace.revision.id !== current.revision.id)
    throw new Error('latest version must match the last known-good workspace');
  return {
    format: LOCAL_PROJECT_RECORD_FORMAT,
    schemaVersion: 2,
    versionSequence: input.versionSequence as number,
    project,
    current,
    versions,
    ...(input.autosave === undefined ? {} : { autosave: autosave(input.autosave) })
  };
}

/** v1 had a single committed workspace and optional history but no explicit recovery draft. */
function migrateV1(value: Record<string, unknown>): LocalProjectRecord {
  const project = metadata(value.project);
  const current = workspace(value.workspace, 'legacy workspace');
  if (project.id !== current.projectId)
    throw new Error('legacy project ID must match workspace project ID');
  const versions = Array.isArray(value.versions)
    ? value.versions.map(version)
    : [
        {
          id: `initial-${current.revision.id}`,
          createdAt: current.revision.createdAt,
          summary: current.revision.summary,
          workspace: current
        }
      ];
  const latest = versions.at(-1);
  const normalizedVersions =
    latest?.workspace.revision.id === current.revision.id
      ? versions
      : [
          ...versions,
          {
            id: `migrated-${current.revision.id}`,
            createdAt: current.revision.createdAt,
            summary: current.revision.summary,
            workspace: current
          }
        ];
  return {
    format: LOCAL_PROJECT_RECORD_FORMAT,
    schemaVersion: 2,
    versionSequence: versions.length,
    project,
    current,
    versions: normalizedVersions,
    ...(value.autosave === undefined ? {} : { autosave: autosave(value.autosave) })
  };
}

function decode(value: unknown): DecodedRecord {
  const input = record(value, 'project record');
  if (input.format === LOCAL_PROJECT_RECORD_FORMAT)
    return { record: decodeV2(input), migrated: false };
  if (input.format === LEGACY_PROJECT_RECORD_FORMAT && input.schemaVersion === 1)
    return { record: decodeV2(migrateV1(input)), migrated: true };
  throw new Error('unsupported project record format');
}

function now(options: LifecycleOptions): string {
  return timestamp((options.now ?? (() => new Date().toISOString()))(), 'clock');
}

function limit(
  options: LifecycleOptions,
  key: 'maxVersions' | 'maxQuarantineBytes' | 'maxImportBytes',
  fallback: number
): number {
  const value = options[key] ?? fallback;
  const minimum = key === 'maxVersions' ? 2 : 1;
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${key} must be an integer of at least ${minimum}`);
  return value;
}

function monotonicTimestamp(candidate: string, previous: string): string {
  return candidate > previous ? candidate : new Date(Date.parse(previous) + 1).toISOString();
}

interface BoundedCapture {
  readonly value: unknown;
  readonly truncated: boolean;
}

/** Bounded structural preview: protects quarantine storage from hostile huge/cyclic input. */
function capture(value: unknown, maximumBytes: number): BoundedCapture {
  const seen = new WeakSet<object>();
  let remaining = maximumBytes;
  let truncated = false;
  const visit = (input: unknown, depth: number): unknown => {
    if (remaining <= 0 || depth > 8) {
      truncated = true;
      return '[truncated]';
    }
    if (typeof input === 'string') {
      const encoded = new TextEncoder().encode(input);
      if (encoded.byteLength <= remaining) {
        remaining -= encoded.byteLength;
        return input;
      }
      truncated = true;
      const prefix = input.slice(0, Math.max(0, Math.floor(remaining / 2)));
      remaining = 0;
      return `${prefix}[truncated]`;
    }
    if (input === null || typeof input === 'number' || typeof input === 'boolean') {
      remaining -= 16;
      return input;
    }
    if (typeof input !== 'object') {
      remaining -= 16;
      return String(input);
    }
    if (seen.has(input)) {
      truncated = true;
      return '[circular]';
    }
    seen.add(input);
    if (Array.isArray(input)) {
      const values: unknown[] = [];
      for (const item of input.slice(0, 128)) values.push(visit(item, depth + 1));
      if (input.length > values.length) truncated = true;
      return values;
    }
    const result: Record<string, unknown> = {};
    const entries = Object.entries(input).slice(0, 128);
    for (const [key, item] of entries) {
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      remaining -= new TextEncoder().encode(key).byteLength;
      result[key] = visit(item, depth + 1);
    }
    if (Object.keys(input).length > entries.length) truncated = true;
    return result;
  };
  const captured = visit(value, 0);
  const serialized = JSON.stringify(captured);
  if (new TextEncoder().encode(serialized).byteLength <= maximumBytes)
    return { value: captured, truncated };
  // JSON adds two quotes around this ASCII marker, so it cannot exceed the requested byte cap.
  return { value: 'x'.repeat(Math.max(0, maximumBytes - 2)), truncated: true };
}

function nextVersion(
  projectRecord: LocalProjectRecord,
  source: ReactSourceWorkspace,
  summary: string,
  prefix: 'recovery' | 'restore',
  createdAt: string,
  maxVersions: number
): LocalProjectRecord {
  const versionCreatedAt = monotonicTimestamp(
    createdAt,
    projectRecord.versions.at(-1)?.createdAt ?? createdAt
  );
  const revision = {
    ...source.revision,
    id: `${prefix}-${source.revision.id}-${projectRecord.versionSequence + 1}`,
    parentId: projectRecord.current.revision.id,
    createdAt: versionCreatedAt,
    summary: normalizedText(summary, 'version.summary', MAX_SUMMARY_LENGTH)
  };
  const current = { ...clone(source), revision };
  const project = { ...projectRecord.project, updatedAt: versionCreatedAt };
  const { autosave: _autosave, ...withoutAutosave } = projectRecord;
  return {
    ...withoutAutosave,
    versionSequence: projectRecord.versionSequence + 1,
    project,
    current,
    versions: [
      ...projectRecord.versions,
      {
        id: `version-${revision.id}`,
        createdAt: versionCreatedAt,
        summary: revision.summary,
        workspace: current
      }
    ].slice(-maxVersions)
  };
}

/** Pure application service: all disk access is supplied through its storage port. */
export class LocalProjectLifecycleService {
  public constructor(
    private readonly storage: ProjectLifecycleStoragePort,
    private readonly options: LifecycleOptions = {}
  ) {}

  public async firstRun(): Promise<{
    readonly isFirstRun: boolean;
    readonly projects: readonly LocalProjectMetadata[];
  }> {
    const projects = await this.listRecent(true);
    return { isFirstRun: projects.length === 0, projects };
  }

  public async create(
    input: {
      readonly id: string;
      readonly name: string;
      readonly origin: LocalProjectOrigin;
      readonly workspace: ReactSourceWorkspace;
    },
    alreadyLocked = false
  ): Promise<LocalProjectRecord> {
    const id = projectId(input.id);
    if (!alreadyLocked) return this.withProjectLock(id, () => this.create(input, true));
    const existing = await this.storage.read(id);
    if (existing !== undefined)
      throw new ProjectLifecycleError('ALREADY_EXISTS', `project already exists: ${id}`);
    const current = workspace(input.workspace, 'workspace');
    if (current.projectId !== id)
      throw new ProjectLifecycleError(
        'INVALID_PROJECT',
        'workspace project ID must match new project ID'
      );
    if (!['sample', 'template', 'created', 'imported', 'duplicated'].includes(input.origin))
      throw new ProjectLifecycleError('INVALID_PROJECT', 'project origin is invalid');
    const createdAt = now(this.options);
    const projectRecord: LocalProjectRecord = {
      format: LOCAL_PROJECT_RECORD_FORMAT,
      schemaVersion: 2,
      versionSequence: 1,
      project: {
        id,
        name: normalizedText(input.name, 'project name', MAX_NAME_LENGTH),
        origin: input.origin,
        status: 'active',
        createdAt,
        updatedAt: createdAt
      },
      current,
      versions: [
        {
          id: `version-${current.revision.id}`,
          createdAt,
          summary: normalizedText(current.revision.summary, 'version.summary', MAX_SUMMARY_LENGTH),
          workspace: current
        }
      ]
    };
    await this.storage.commit(id, projectRecord);
    return clone(projectRecord);
  }

  public async createSample(
    input: Omit<Parameters<LocalProjectLifecycleService['create']>[0], 'origin'>
  ): Promise<LocalProjectRecord> {
    return this.create({ ...input, origin: 'sample' });
  }

  public async open(id: string): Promise<LocalProjectRecord> {
    return this.withProjectLock(id, async () => {
      const current = await this.readRecord(id);
      if (current.project.status === 'archived')
        throw new ProjectLifecycleError('ARCHIVED', 'restore this project before opening it');
      const openedAt = now(this.options);
      const next = {
        ...current,
        project: { ...current.project, lastOpenedAt: openedAt, updatedAt: openedAt }
      };
      await this.storage.commit(next.project.id, next);
      return clone(next);
    });
  }

  public async listRecent(includeArchived = false): Promise<readonly LocalProjectMetadata[]> {
    const results = await Promise.allSettled(
      (await this.storage.listProjectIds()).map((id) =>
        this.withProjectLock(id, () => this.readRecord(id))
      )
    );
    const entries = results.flatMap((result) => {
      if (result.status === 'fulfilled') return [result.value];
      if (
        result.reason instanceof ProjectLifecycleError &&
        result.reason.code === 'PROJECT_QUARANTINED'
      )
        return [];
      throw result.reason;
    });
    return entries
      .map((entry) => entry.project)
      .filter((entry) => includeArchived || entry.status === 'active')
      .sort((left, right) =>
        (right.lastOpenedAt ?? right.updatedAt).localeCompare(left.lastOpenedAt ?? left.updatedAt)
      );
  }

  public async duplicate(
    id: string,
    input: { readonly id: string; readonly name: string }
  ): Promise<LocalProjectRecord> {
    const source = await this.withProjectLock(id, () => this.readRecord(id));
    const targetId = projectId(input.id);
    if (await this.storage.read(targetId))
      throw new ProjectLifecycleError('ALREADY_EXISTS', `project already exists: ${targetId}`);
    const createdAt = now(this.options);
    const { parentId: _parentId, ...sourceRevision } = source.current.revision;
    const copied = {
      ...clone(source.current),
      projectId: targetId,
      revision: {
        ...sourceRevision,
        id: `copy-${source.current.revision.id}`,
        createdAt,
        summary: `Copy of ${source.project.name}`
      }
    };
    return this.create({ id: targetId, name: input.name, origin: 'duplicated', workspace: copied });
  }

  public async archive(id: string): Promise<LocalProjectRecord> {
    return this.setStatus(id, 'archived');
  }

  public async restore(id: string): Promise<LocalProjectRecord> {
    return this.setStatus(id, 'active');
  }

  public async autosave(id: string, draft: ReactSourceWorkspace): Promise<LocalProjectRecord> {
    return this.withProjectLock(id, async () => {
      const current = await this.readRecord(id);
      const saved = workspace(draft, 'autosave draft');
      if (saved.projectId !== current.project.id)
        throw new ProjectLifecycleError(
          'INVALID_PROJECT',
          'autosave project ID must match the current project'
        );
      const next: LocalProjectRecord = {
        ...current,
        autosave: { savedAt: now(this.options), workspace: saved }
      };
      await this.storage.commit(current.project.id, next);
      return clone(next);
    });
  }

  public async recoverAutosave(id: string): Promise<LocalProjectRecord> {
    return this.withProjectLock(id, async () => {
      const current = await this.readRecord(id);
      if (current.autosave === undefined)
        throw new ProjectLifecycleError('NO_AUTOSAVE', 'no recoverable autosave exists');
      const next = nextVersion(
        current,
        current.autosave.workspace,
        'Recovered autosave after interruption',
        'recovery',
        now(this.options),
        limit(this.options, 'maxVersions', DEFAULT_MAX_VERSIONS)
      );
      await this.storage.commit(current.project.id, next);
      return clone(next);
    });
  }

  public async discardAutosave(id: string): Promise<LocalProjectRecord> {
    return this.withProjectLock(id, async () => {
      const current = await this.readRecord(id);
      const { autosave: _autosave, ...next } = current;
      await this.storage.commit(current.project.id, next);
      return clone(next);
    });
  }

  public async versions(id: string): Promise<readonly LocalProjectVersion[]> {
    return this.withProjectLock(id, async () => clone((await this.readRecord(id)).versions));
  }

  public async restoreVersion(id: string, versionId: string): Promise<LocalProjectRecord> {
    return this.withProjectLock(id, () => this.restoreVersionLocked(id, versionId));
  }

  public async undo(id: string): Promise<LocalProjectRecord> {
    return this.withProjectLock(id, async () => {
      const current = await this.readRecord(id);
      if (current.versions.length < 2)
        throw new ProjectLifecycleError(
          'NO_UNDO',
          'there is no earlier committed version to restore'
        );
      const previous = current.versions.at(-2);
      if (previous === undefined)
        throw new ProjectLifecycleError(
          'NO_UNDO',
          'there is no earlier committed version to restore'
        );
      return this.restoreVersionLocked(id, previous.id);
    });
  }

  /** Import validates and migrates a detached payload before any active project is changed. */
  public async importRecord(raw: unknown): Promise<LocalProjectRecord> {
    return this.withProjectLock(this.quarantineId(raw), () => this.importRecordLocked(raw));
  }

  private async importRecordLocked(raw: unknown): Promise<LocalProjectRecord> {
    let decoded: DecodedRecord;
    try {
      if (capture(raw, limit(this.options, 'maxImportBytes', DEFAULT_MAX_IMPORT_BYTES)).truncated)
        throw new Error('import exceeds the configured maximum size');
      decoded = decode(raw);
    } catch (error) {
      const id = this.quarantineId(raw);
      await this.quarantine(
        id,
        `Import rejected: ${error instanceof Error ? error.message : 'invalid project'}`,
        raw
      );
      throw new ProjectLifecycleError(
        'PROJECT_QUARANTINED',
        `import was quarantined: ${error instanceof Error ? error.message : 'invalid project'}`
      );
    }
    if (await this.storage.read(decoded.record.project.id))
      throw new ProjectLifecycleError(
        'ALREADY_EXISTS',
        `project already exists: ${decoded.record.project.id}`
      );
    const imported: LocalProjectRecord = {
      ...decoded.record,
      project: { ...decoded.record.project, origin: 'imported', updatedAt: now(this.options) }
    };
    await this.storage.commit(imported.project.id, imported);
    return clone(imported);
  }

  private async setStatus(id: string, status: LocalProjectStatus): Promise<LocalProjectRecord> {
    return this.withProjectLock(id, async () => {
      const current = await this.readRecord(id);
      const next = {
        ...current,
        project: { ...current.project, status, updatedAt: now(this.options) }
      };
      await this.storage.commit(current.project.id, next);
      return clone(next);
    });
  }

  private async restoreVersionLocked(id: string, versionId: string): Promise<LocalProjectRecord> {
    const current = await this.readRecord(id);
    const target = current.versions.find((entry) => entry.id === versionId);
    if (target === undefined)
      throw new ProjectLifecycleError('VERSION_NOT_FOUND', `version does not exist: ${versionId}`);
    const next = nextVersion(
      current,
      target.workspace,
      `Safely restored ${versionId}`,
      'restore',
      now(this.options),
      limit(this.options, 'maxVersions', DEFAULT_MAX_VERSIONS)
    );
    await this.storage.commit(current.project.id, next);
    return clone(next);
  }

  private async readRecord(id: string): Promise<LocalProjectRecord> {
    const resolvedId = projectId(id);
    const raw = await this.storage.read(resolvedId);
    if (raw === undefined)
      throw new ProjectLifecycleError('NOT_FOUND', `project does not exist: ${resolvedId}`);
    try {
      const decoded = decode(raw);
      if (decoded.record.project.id !== resolvedId)
        throw new Error('stored project ID does not match its storage key');
      if (decoded.migrated) await this.storage.commit(resolvedId, decoded.record);
      return decoded.record;
    } catch (error) {
      await this.quarantine(
        resolvedId,
        error instanceof Error ? error.message : 'invalid project record',
        raw
      );
      throw new ProjectLifecycleError(
        'PROJECT_QUARANTINED',
        `project was quarantined: ${error instanceof Error ? error.message : 'invalid project record'}`
      );
    }
  }

  private quarantineId(raw: unknown): string {
    try {
      return projectId(record(record(raw, 'import').project, 'project').id);
    } catch {
      return `quarantine-${randomUUID()}`;
    }
  }

  private async quarantine(id: string, reason: string, raw: unknown): Promise<void> {
    const captured = capture(
      raw,
      limit(this.options, 'maxQuarantineBytes', DEFAULT_MAX_QUARANTINE_BYTES)
    );
    await this.storage.quarantine({
      projectId: id,
      detectedAt: now(this.options),
      reason: captured.truncated ? `${reason} (payload truncated)` : reason,
      raw: captured.value
    });
  }

  private async withProjectLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return this.storage.withProjectLock(projectId(id), operation);
  }
}

/** Test and preview adapter with copy-on-read/write semantics. */
export function createInMemoryProjectLifecycleStorage(): ProjectLifecycleStoragePort & {
  readonly quarantined: readonly ProjectQuarantineEntry[];
} {
  const records = new Map<string, unknown>();
  const quarantined: ProjectQuarantineEntry[] = [];
  return {
    async listProjectIds() {
      return [...records.keys()];
    },
    async read(id) {
      const value = records.get(id);
      return value === undefined ? undefined : clone(value);
    },
    async commit(id, value) {
      records.set(id, clone(value));
    },
    async quarantine(entry) {
      quarantined.push(clone(entry));
      records.delete(entry.projectId);
    },
    async withProjectLock(id, operation) {
      return withSharedLock(`memory:${id}`, operation);
    },
    get quarantined() {
      return clone(quarantined);
    }
  };
}

export interface FileProjectLifecycleStorageOptions {
  readonly maxQuarantineEntries?: number;
  /** Test seam for simulating an interrupted temporary write. */
  readonly writeTemporary?: (path: string, contents: string) => Promise<void>;
  /** Test seam for simulating a failed atomic rename. */
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly maxProjectBytes?: number;
}

/** Electron-main filesystem adapter. Atomic rename means a failed autosave keeps the previous record. */
export class FileProjectLifecycleStoragePort implements ProjectLifecycleStoragePort {
  public constructor(
    private readonly root: string,
    private readonly options: FileProjectLifecycleStorageOptions = {}
  ) {}

  public async listProjectIds(): Promise<readonly string[]> {
    try {
      return (await readdir(this.projectsDirectory()))
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length))
        .filter((id) => projectIdPattern.test(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  public async read(id: string): Promise<unknown | undefined> {
    let contents: string;
    try {
      const details = await stat(this.projectPath(id));
      const maximum = this.options.maxProjectBytes ?? DEFAULT_MAX_IMPORT_BYTES;
      if (details.size > maximum) return `[project record exceeds ${maximum} bytes]`;
      contents = await readFile(this.projectPath(id), 'utf8');
      if (Buffer.byteLength(contents, 'utf8') > maximum)
        return `[project record exceeds ${maximum} bytes]`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      return JSON.parse(contents) as unknown;
    } catch {
      // Return the exact bytes to the service so it can quarantine them with a diagnostic.
      return contents;
    }
  }

  public async commit(id: string, value: LocalProjectRecord): Promise<void> {
    await mkdir(this.projectsDirectory(), { recursive: true });
    const target = this.projectPath(id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const contents = `${JSON.stringify(value, null, 2)}\n`;
      await (this.options.writeTemporary ?? this.writeAndSyncTemporary.bind(this))(
        temporary,
        contents
      );
      await (this.options.rename ?? rename)(temporary, target);
      renamed = true;
      await this.syncDirectory(this.projectsDirectory());
    } catch (error) {
      if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  public async quarantine(entry: ProjectQuarantineEntry): Promise<void> {
    await mkdir(this.quarantineDirectory(), { recursive: true });
    const target = join(
      this.quarantineDirectory(),
      `${entry.detectedAt.replace(/[^0-9]/g, '')}-${entry.projectId}-${randomUUID()}.json`
    );
    await writeFile(target, `${JSON.stringify(entry, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    await rm(this.projectPath(entry.projectId), { force: true });
    await this.pruneQuarantine();
  }

  public async withProjectLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return withSharedLock(`file:${this.root}:${projectId(id)}`, operation);
  }

  private projectsDirectory(): string {
    return join(this.root, 'projects');
  }

  private quarantineDirectory(): string {
    return join(this.root, 'quarantine');
  }

  private projectPath(id: string): string {
    return join(this.projectsDirectory(), `${projectId(id)}.json`);
  }

  private async writeAndSyncTemporary(path: string, contents: string): Promise<void> {
    const handle = await open(path, 'w', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, 'r');
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(code ?? '')) throw error;
    } finally {
      await handle?.close();
    }
  }

  private async pruneQuarantine(): Promise<void> {
    const maximum = this.options.maxQuarantineEntries ?? DEFAULT_MAX_QUARANTINE_ENTRIES;
    if (!Number.isSafeInteger(maximum) || maximum < 1)
      throw new Error('maxQuarantineEntries must be a positive safe integer');
    const entries = (await readdir(this.quarantineDirectory()))
      .filter((entry) => entry.endsWith('.json'))
      .sort((left, right) => left.localeCompare(right));
    await Promise.all(
      entries
        .slice(0, Math.max(0, entries.length - maximum))
        .map((entry) => rm(join(this.quarantineDirectory(), entry), { force: true }))
    );
  }
}
