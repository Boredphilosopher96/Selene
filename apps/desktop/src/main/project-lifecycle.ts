import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

interface LifecycleOptions {
  readonly now?: () => string;
}

interface DecodedRecord {
  readonly record: LocalProjectRecord;
  readonly migrated: boolean;
}

const projectIdPattern = /^[a-z][a-z0-9-]{0,63}$/;

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

function timestamp(value: unknown, name: string): string {
  const result = text(value, name);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${name} must be an ISO timestamp`);
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
    return clone(value as ReactSourceWorkspace);
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
    name: text(input.name, 'project.name'),
    origin: origin as LocalProjectOrigin,
    status,
    createdAt: timestamp(input.createdAt, 'project.createdAt'),
    updatedAt: timestamp(input.updatedAt, 'project.updatedAt'),
    ...(lastOpenedAt === undefined ? {} : { lastOpenedAt })
  };
}

function version(value: unknown): LocalProjectVersion {
  const input = record(value, 'version');
  return {
    id: text(input.id, 'version.id'),
    createdAt: timestamp(input.createdAt, 'version.createdAt'),
    summary: text(input.summary, 'version.summary'),
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
  if (project.id !== current.projectId)
    throw new Error('project ID must match workspace project ID');
  if (!Array.isArray(input.versions) || input.versions.length === 0)
    throw new Error('project record must retain at least one version');
  const versions = input.versions.map(version);
  if (versions.at(-1)?.workspace.revision.id !== current.revision.id)
    throw new Error('latest version must match the last known-good workspace');
  return {
    format: LOCAL_PROJECT_RECORD_FORMAT,
    schemaVersion: 2,
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
    return { record: migrateV1(input), migrated: true };
  throw new Error('unsupported project record format');
}

function now(options: LifecycleOptions): string {
  return (options.now ?? (() => new Date().toISOString()))();
}

function nextVersion(
  projectRecord: LocalProjectRecord,
  source: ReactSourceWorkspace,
  summary: string,
  prefix: 'recovery' | 'restore',
  createdAt: string
): LocalProjectRecord {
  const revision = {
    ...source.revision,
    id: `${prefix}-${source.revision.id}-${projectRecord.versions.length + 1}`,
    parentId: projectRecord.current.revision.id,
    createdAt,
    summary
  };
  const current = { ...clone(source), revision };
  const project = { ...projectRecord.project, updatedAt: createdAt };
  const { autosave: _autosave, ...withoutAutosave } = projectRecord;
  return {
    ...withoutAutosave,
    project,
    current,
    versions: [
      ...projectRecord.versions,
      { id: `version-${revision.id}`, createdAt, summary, workspace: current }
    ]
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

  public async create(input: {
    readonly id: string;
    readonly name: string;
    readonly origin: LocalProjectOrigin;
    readonly workspace: ReactSourceWorkspace;
  }): Promise<LocalProjectRecord> {
    const id = projectId(input.id);
    const existing = await this.storage.read(id);
    if (existing !== undefined)
      throw new ProjectLifecycleError('ALREADY_EXISTS', `project already exists: ${id}`);
    const current = workspace(input.workspace, 'workspace');
    if (current.projectId !== id)
      throw new ProjectLifecycleError(
        'INVALID_PROJECT',
        'workspace project ID must match new project ID'
      );
    const createdAt = now(this.options);
    const projectRecord: LocalProjectRecord = {
      format: LOCAL_PROJECT_RECORD_FORMAT,
      schemaVersion: 2,
      project: {
        id,
        name: text(input.name, 'project name'),
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
          summary: current.revision.summary,
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
  }

  public async listRecent(includeArchived = false): Promise<readonly LocalProjectMetadata[]> {
    const entries = await Promise.all(
      (await this.storage.listProjectIds()).map((id) => this.readRecord(id))
    );
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
    const source = await this.readRecord(id);
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
  }

  public async recoverAutosave(id: string): Promise<LocalProjectRecord> {
    const current = await this.readRecord(id);
    if (current.autosave === undefined)
      throw new ProjectLifecycleError('NO_AUTOSAVE', 'no recoverable autosave exists');
    const next = nextVersion(
      current,
      current.autosave.workspace,
      'Recovered autosave after interruption',
      'recovery',
      now(this.options)
    );
    await this.storage.commit(current.project.id, next);
    return clone(next);
  }

  public async discardAutosave(id: string): Promise<LocalProjectRecord> {
    const current = await this.readRecord(id);
    const { autosave: _autosave, ...next } = current;
    await this.storage.commit(current.project.id, next);
    return clone(next);
  }

  public async versions(id: string): Promise<readonly LocalProjectVersion[]> {
    return clone((await this.readRecord(id)).versions);
  }

  public async restoreVersion(id: string, versionId: string): Promise<LocalProjectRecord> {
    const current = await this.readRecord(id);
    const target = current.versions.find((entry) => entry.id === versionId);
    if (target === undefined)
      throw new ProjectLifecycleError('VERSION_NOT_FOUND', `version does not exist: ${versionId}`);
    const next = nextVersion(
      current,
      target.workspace,
      `Safely restored ${versionId}`,
      'restore',
      now(this.options)
    );
    await this.storage.commit(current.project.id, next);
    return clone(next);
  }

  public async undo(id: string): Promise<LocalProjectRecord> {
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
    return this.restoreVersion(id, previous.id);
  }

  /** Import validates and migrates a detached payload before any active project is changed. */
  public async importRecord(raw: unknown): Promise<LocalProjectRecord> {
    let decoded: DecodedRecord;
    try {
      decoded = decode(raw);
    } catch (error) {
      const id = this.quarantineId(raw);
      await this.storage.quarantine({
        projectId: id,
        detectedAt: now(this.options),
        reason: `Import rejected: ${error instanceof Error ? error.message : 'invalid project'}`,
        raw: clone(raw)
      });
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
    const current = await this.readRecord(id);
    const next = {
      ...current,
      project: { ...current.project, status, updatedAt: now(this.options) }
    };
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
      await this.storage.quarantine({
        projectId: resolvedId,
        detectedAt: now(this.options),
        reason: error instanceof Error ? error.message : 'invalid project record',
        raw: clone(raw)
      });
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
    get quarantined() {
      return clone(quarantined);
    }
  };
}

/** Electron-main filesystem adapter. Atomic rename means a failed autosave keeps the previous record. */
export class FileProjectLifecycleStoragePort implements ProjectLifecycleStoragePort {
  public constructor(private readonly root: string) {}

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
      contents = await readFile(this.projectPath(id), 'utf8');
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
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    await rename(temporary, target);
  }

  public async quarantine(entry: ProjectQuarantineEntry): Promise<void> {
    await mkdir(this.quarantineDirectory(), { recursive: true });
    const target = join(
      this.quarantineDirectory(),
      `${entry.projectId}-${Date.now()}-${randomUUID()}.json`
    );
    await writeFile(target, `${JSON.stringify(entry, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    await rm(this.projectPath(entry.projectId), { force: true });
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
}
