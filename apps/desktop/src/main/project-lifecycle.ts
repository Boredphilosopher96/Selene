import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual, types } from 'node:util';

import {
  validateDesignBaselineState,
  validateReactSourceWorkspace,
  type ReactSourceWorkspace
} from '@selene/core';
import { parseSnapshot, serializeSnapshot } from '@selene/collaboration';
import type { DesignBaselineState } from '@selene/core';
import type {
  DesignerSetupReceipts,
  DesignSystemIntakeReceipt,
  MarkdownIntakeReceipt,
  OrderedDesignSystemInput,
  OrderedDesignLanguageInput
} from '../shared/designer-api';

export interface LocalDesignerState {
  readonly format: 'selene-local-designer-state/v1';
  readonly version: 1;
  readonly baseline: DesignBaselineState;
  readonly collaborationSnapshot: string;
  /** Inert staging receipts only; project storage never contains package source or Markdown input. */
  readonly setup?: DesignerSetupReceipts;
}

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
  readonly designerState?: LocalDesignerState;
  /** Host-only Markdown guidance; never projected through DesignerSnapshot. */
  readonly designLanguageGuidance?: readonly {
    readonly digest: string;
    readonly markdown: string;
  }[];
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
  readonly normalized: boolean;
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

const MAX_VERSION_ID_LENGTH = 256;
const projectIdPattern = /^[a-z][a-z0-9-]{0,63}$/;
const versionIdPattern = new RegExp(`^[A-Za-z][A-Za-z0-9._:-]{0,${MAX_VERSION_ID_LENGTH - 1}}$`);
const MAX_NAME_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 512;
const DEFAULT_MAX_VERSIONS = 50;
const DEFAULT_MAX_QUARANTINE_ENTRIES = 20;
const DEFAULT_MAX_QUARANTINE_BYTES = 64 * 1024;
const DEFAULT_MAX_IMPORT_BYTES = 1024 * 1024;
const MAX_QUARANTINE_REASON_LENGTH = 1024;
const designInputPackageName =
  /^(?:@[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9][a-z0-9._-]{0,127}|[a-z0-9][a-z0-9._-]{0,127})$/;
const designInputSemver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;
const provenanceProvider = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const exactSource = Symbol('exact project source');

interface ExactProjectSource {
  readonly [exactSource]: {
    readonly path: string;
    readonly device: number;
    readonly inode: number;
    readonly size: number;
  };
}

function exactSourceFor(value: unknown): ExactProjectSource[typeof exactSource] | undefined {
  try {
    if (typeof value !== 'object' || value === null || types.isProxy(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, exactSource);
    return descriptor !== undefined && 'value' in descriptor
      ? (descriptor.value as ExactProjectSource[typeof exactSource])
      : undefined;
  } catch {
    return undefined;
  }
}

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

function collisionFreeId(
  prefix: string,
  sourceId: string,
  discriminator: string,
  occupied: ReadonlySet<string> = new Set<string>()
): string {
  const direct = `${prefix}-${sourceId}${discriminator === '' ? '' : `-${discriminator}`}`;
  if (direct.length <= MAX_VERSION_ID_LENGTH && !occupied.has(direct)) return direct;
  for (let attempt = 0; ; attempt += 1) {
    const digest = createHash('sha256')
      .update(`${prefix}\u0000${sourceId}\u0000${discriminator}\u0000${attempt}`)
      .digest('hex')
      .slice(0, 24);
    const tail = discriminator === '' ? digest : `${discriminator}-${digest}`;
    const sourceLength = MAX_VERSION_ID_LENGTH - prefix.length - tail.length - 2;
    const candidate = `${prefix}-${sourceId.slice(0, sourceLength)}-${tail}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

function derivedVersionId(prefix: string, revisionId: string): string {
  return collisionFreeId(prefix, revisionId, '');
}

function decodeV2(value: unknown, maxVersions: number): DecodedRecord {
  const input = record(value, 'project record');
  if (input.format !== LOCAL_PROJECT_RECORD_FORMAT || input.schemaVersion !== 2)
    throw new Error('unsupported project record format');
  const current = workspace(input.current, 'current');
  const project = metadata(input.project);
  if (!Number.isSafeInteger(input.versionSequence) || (input.versionSequence as number) < 1)
    throw new Error('versionSequence must be a positive safe integer');
  if ((input.versionSequence as number) >= Number.MAX_SAFE_INTEGER)
    throw new Error('versionSequence must remain below Number.MAX_SAFE_INTEGER');
  if (project.id !== current.projectId)
    throw new Error('project ID must match workspace project ID');
  if (project.createdAt > project.updatedAt)
    throw new Error('project.createdAt cannot be after project.updatedAt');
  if (
    project.lastOpenedAt !== undefined &&
    (project.lastOpenedAt < project.createdAt || project.lastOpenedAt > project.updatedAt)
  )
    throw new Error('project.lastOpenedAt must be within the project lifecycle');
  if (!Array.isArray(input.versions) || input.versions.length === 0)
    throw new Error('project record must retain at least one version');
  const allVersions = input.versions.map(version);
  if ((input.versionSequence as number) < allVersions.length)
    throw new Error('versionSequence cannot be behind retained history');
  const ids = new Set<string>();
  const revisionIds = new Set<string>();
  for (const [index, entry] of allVersions.entries()) {
    const previous = index === 0 ? undefined : allVersions[index - 1];
    if (ids.has(entry.id)) throw new Error('version IDs must be unique');
    if (revisionIds.has(entry.workspace.revision.id))
      throw new Error('version workspace revisions must be unique');
    if (previous !== undefined && previous.createdAt >= entry.createdAt)
      throw new Error('version timestamps must be strictly increasing');
    if (entry.workspace.revision.createdAt > entry.createdAt)
      throw new Error('version timestamp cannot predate its workspace revision');
    if (
      entry.createdAt < project.createdAt ||
      entry.workspace.revision.createdAt < project.createdAt
    )
      throw new Error('version history cannot predate project creation');
    if (entry.createdAt > project.updatedAt)
      throw new Error('version timestamp cannot be after project.updatedAt');
    if (entry.workspace.projectId !== project.id)
      throw new Error('version workspace project ID must match project ID');
    ids.add(entry.id);
    revisionIds.add(entry.workspace.revision.id);
  }
  if (!isDeepStrictEqual(allVersions.at(-1)?.workspace, current))
    throw new Error('latest version must match the last known-good workspace');
  const draft = input.autosave === undefined ? undefined : autosave(input.autosave);
  const designerState =
    input.designerState === undefined
      ? undefined
      : decodeDesignerState(input.designerState, project.id);
  if (designerState !== undefined) validateDesignerStateCurrent(designerState, current);
  const designLanguageGuidance =
    input.designLanguageGuidance === undefined
      ? undefined
      : (() => {
          if (
            !Array.isArray(input.designLanguageGuidance) ||
            input.designLanguageGuidance.length > 32
          )
            throw new Error('design language guidance is invalid');
          let total = 0;
          const entries = input.designLanguageGuidance.map((entry) => {
            const item = record(entry, 'design language guidance');
            exactReceiptKeys(item, ['digest', 'markdown'], 'design language guidance');
            if (
              typeof item.digest !== 'string' ||
              !/^[a-f0-9]{64}$/.test(item.digest) ||
              typeof item.markdown !== 'string'
            )
              throw new Error('design language guidance is invalid');
            total += Buffer.byteLength(item.markdown, 'utf8');
            if (
              total === 0 ||
              total > 256 * 1024 ||
              createHash('sha256').update(item.markdown).digest('hex') !== item.digest
            )
              throw new Error('design language guidance is invalid');
            return Object.freeze({ digest: item.digest, markdown: item.markdown });
          });
          if (new Set(entries.map((entry) => entry.digest)).size !== entries.length)
            throw new Error('design language guidance is invalid');
          return Object.freeze(entries);
        })();
  if (draft !== undefined && draft.workspace.projectId !== project.id)
    throw new Error('autosave workspace project ID must match project ID');
  if (
    current.revision.createdAt < project.createdAt ||
    current.revision.createdAt > project.updatedAt
  )
    throw new Error('current revision must be within the project lifecycle');
  if (
    draft !== undefined &&
    (draft.workspace.revision.createdAt < project.createdAt ||
      draft.workspace.revision.createdAt > draft.savedAt ||
      draft.savedAt < allVersions.at(-1)!.createdAt ||
      draft.savedAt > project.updatedAt)
  )
    throw new Error('autosave timestamp must follow the latest committed version');
  const versions = allVersions.slice(-maxVersions);
  return {
    record: {
      format: LOCAL_PROJECT_RECORD_FORMAT,
      schemaVersion: 2,
      versionSequence: input.versionSequence as number,
      project,
      current,
      versions,
      ...(draft === undefined ? {} : { autosave: draft }),
      ...(designerState === undefined ? {} : { designerState }),
      ...(designLanguageGuidance === undefined ? {} : { designLanguageGuidance })
    },
    migrated: false,
    normalized: versions.length !== allVersions.length
  };
}

function receiptText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum)
    throw new Error(`${name} is invalid`);
  return value;
}

function exactReceiptKeys(
  input: Record<string, unknown>,
  keys: readonly string[],
  name: string
): void {
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new Error(`${name} keys are invalid`);
}

function receiptDigest(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new Error(`${name} digest is invalid`);
  return value;
}

function receiptProvenance(value: unknown, name: string) {
  const provenance = record(value, `${name} provenance`);
  exactReceiptKeys(provenance, ['provider', 'location'], `${name} provenance`);
  const provider = receiptText(provenance.provider, `${name} provider`, 64);
  const location = receiptText(provenance.location, `${name} location`, 2_048);
  if (!provenanceProvider.test(provider) || /(?:^|:)\/\/[^/]*@|[\\]/.test(location))
    throw new Error(`${name} provenance is invalid`);
  return {
    provider,
    location
  };
}

function designSystemReceipt(value: unknown): DesignSystemIntakeReceipt {
  const receipt = record(value, 'design system receipt');
  exactReceiptKeys(
    receipt,
    [
      'status',
      'packageName',
      'version',
      'exports',
      'peerCompatibility',
      'provenance',
      'artifactDigest',
      ...(Object.hasOwn(receipt, 'fixture') ? ['fixture'] : [])
    ],
    'design system receipt'
  );
  if (receipt.status !== 'staged' || receipt.peerCompatibility !== 'compatible')
    throw new Error('design system receipt status is invalid');
  if (!Array.isArray(receipt.exports) || receipt.exports.length > 256)
    throw new Error('design system receipt exports are invalid');
  const exports = receipt.exports.map((entry) => receiptText(entry, 'design system export', 256));
  if (new Set(exports).size !== exports.length)
    throw new Error('design system receipt exports must be unique');
  const packageName = receiptText(receipt.packageName, 'design system package', 256);
  const packageVersion = receiptText(receipt.version, 'design system version', 128);
  if (!designInputPackageName.test(packageName) || !designInputSemver.test(packageVersion))
    throw new Error('design system package identity is invalid');
  const fixture = Object.hasOwn(receipt, 'fixture') ? receipt.fixture : undefined;
  return {
    status: 'staged',
    packageName,
    version: packageVersion,
    exports,
    peerCompatibility: 'compatible',
    provenance: receiptProvenance(receipt.provenance, 'design system'),
    artifactDigest: receiptDigest(receipt.artifactDigest, 'design system'),
    ...(fixture === undefined
      ? {}
      : { fixture: receiptText(fixture, 'design system fixture', 256) })
  };
}

function orderedDesignSystemInputs(value: unknown): readonly OrderedDesignSystemInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32)
    throw new Error('ordered design-system inputs are invalid');
  const inputs = value.map((entry) => {
    const input = record(entry, 'ordered design-system input');
    exactReceiptKeys(input, ['id', 'enabled', 'receipt'], 'ordered design-system input');
    if (
      typeof input.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.id) ||
      typeof input.enabled !== 'boolean'
    )
      throw new Error('ordered design-system input is invalid');
    const receipt = designSystemReceipt(input.receipt);
    if (receipt.artifactDigest !== input.id)
      throw new Error('ordered design-system input receipt does not match its ID');
    return Object.freeze({ id: input.id, enabled: input.enabled, receipt });
  });
  if (new Set(inputs.map((input) => input.id)).size !== inputs.length)
    throw new Error('ordered design-system inputs must be unique');
  const identities = new Set(inputs.map((input) => input.receipt.packageName));
  if (identities.size !== inputs.length)
    throw new Error('ordered design-system inputs must not repeat a package');
  return Object.freeze(inputs);
}

function designLanguageReceipt(value: unknown): MarkdownIntakeReceipt {
  const receipt = record(value, 'design language receipt');
  exactReceiptKeys(
    receipt,
    ['status', 'provenance', 'artifactDigest', 'sectionCount'],
    'design language receipt'
  );
  if (
    receipt.status !== 'staged' ||
    !Number.isSafeInteger(receipt.sectionCount) ||
    (receipt.sectionCount as number) < 0 ||
    (receipt.sectionCount as number) > 10_000
  )
    throw new Error('design language receipt is invalid');
  return {
    status: 'staged',
    provenance: receiptProvenance(receipt.provenance, 'design language'),
    artifactDigest: receiptDigest(receipt.artifactDigest, 'design language'),
    sectionCount: receipt.sectionCount as number
  };
}

function orderedDesignLanguageInputs(value: unknown): readonly OrderedDesignLanguageInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32)
    throw new Error('ordered design-language inputs are invalid');
  const inputs = value.map((entry) => {
    const input = record(entry, 'ordered design-language input');
    exactReceiptKeys(input, ['id', 'enabled', 'receipt'], 'ordered design-language input');
    if (
      typeof input.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.id) ||
      typeof input.enabled !== 'boolean'
    )
      throw new Error('ordered design-language input is invalid');
    const receipt = designLanguageReceipt(input.receipt);
    if (receipt.artifactDigest !== input.id)
      throw new Error('ordered design-language input receipt does not match its ID');
    return Object.freeze({ id: input.id, enabled: input.enabled, receipt });
  });
  if (new Set(inputs.map((input) => input.id)).size !== inputs.length)
    throw new Error('ordered design-language inputs must be unique');
  return Object.freeze(inputs);
}

function setupReceipts(value: unknown): DesignerSetupReceipts {
  const input = record(value, 'designerState setup receipts');
  exactReceiptKeys(
    input,
    [
      ...(Object.hasOwn(input, 'designSystem') ? ['designSystem'] : []),
      ...(Object.hasOwn(input, 'designSystems') ? ['designSystems'] : []),
      ...(Object.hasOwn(input, 'designLanguage') ? ['designLanguage'] : []),
      ...(Object.hasOwn(input, 'designLanguages') ? ['designLanguages'] : [])
    ],
    'designerState setup receipts'
  );
  const designSystem =
    input.designSystem === undefined ? undefined : designSystemReceipt(input.designSystem);
  const designSystems =
    input.designSystems === undefined ? undefined : orderedDesignSystemInputs(input.designSystems);
  const designLanguage =
    input.designLanguage === undefined ? undefined : designLanguageReceipt(input.designLanguage);
  const designLanguages =
    input.designLanguages === undefined
      ? undefined
      : orderedDesignLanguageInputs(input.designLanguages);
  if (
    designSystem !== undefined &&
    designSystems !== undefined &&
    designSystems[0]?.receipt.artifactDigest !== designSystem.artifactDigest
  )
    throw new Error('designerState primary design-system receipt does not match ordered inputs');
  if (
    designSystem === undefined &&
    designSystems === undefined &&
    designLanguage === undefined &&
    designLanguages === undefined
  )
    throw new Error('designerState setup receipts must not be empty');
  if (
    designLanguage !== undefined &&
    designLanguages !== undefined &&
    designLanguages[0]?.receipt.artifactDigest !== designLanguage.artifactDigest
  )
    throw new Error('designerState primary design-language receipt does not match ordered inputs');
  return {
    ...(designSystem === undefined ? {} : { designSystem }),
    ...(designSystems === undefined ? {} : { designSystems }),
    ...(designLanguage === undefined ? {} : { designLanguage }),
    ...(designLanguages === undefined ? {} : { designLanguages })
  };
}

function decodeDesignerState(value: unknown, expectedProjectId: string): LocalDesignerState {
  const input = record(value, 'designerState');
  if (
    input.format !== 'selene-local-designer-state/v1' ||
    input.version !== 1 ||
    typeof input.collaborationSnapshot !== 'string'
  )
    throw new Error('designerState format is invalid');
  const collaboration = parseSnapshot(input.collaborationSnapshot);
  if (collaboration.project.id !== expectedProjectId)
    throw new Error('designerState collaboration belongs to another project');
  const baselineRecord = record(input.baseline, 'designerState baseline');
  let canonicalBaseline: DesignBaselineState;
  if (collaboration.designReviewState === undefined) {
    canonicalBaseline = {
      projectId: expectedProjectId,
      readiness: 'draft',
      currency: 'none',
      changesSinceBaseline: [],
      approvalsStale: false
    };
  } else {
    const { format: _format, ...reviewState } = collaboration.designReviewState;
    canonicalBaseline = reviewState;
  }
  try {
    validateDesignBaselineState(canonicalBaseline);
  } catch {
    throw new Error('designerState baseline is invalid');
  }
  if (canonicalBaseline.projectId !== expectedProjectId)
    throw new Error('designerState baseline belongs to another project');
  if (!isDeepStrictEqual(baselineRecord, canonicalBaseline))
    throw new Error('designerState baseline disagrees with the canonical collaboration snapshot');
  return {
    format: 'selene-local-designer-state/v1',
    version: 1,
    baseline: structuredClone(canonicalBaseline),
    collaborationSnapshot: serializeSnapshot(collaboration),
    ...(input.setup === undefined ? {} : { setup: setupReceipts(input.setup) })
  };
}

function validateDesignerStateCurrent(
  state: LocalDesignerState,
  current: ReactSourceWorkspace
): void {
  const collaboration = parseSnapshot(state.collaborationSnapshot);
  const latest = collaboration.revisions.reduce(
    (previous, revision) =>
      previous === undefined || revision.sequence > previous.sequence ? revision : previous,
    undefined as (typeof collaboration.revisions)[number] | undefined
  );
  const digest = createHash('sha256').update(JSON.stringify(current)).digest('hex');
  if (latest === undefined || latest.id !== current.revision.id || latest.contentSha256 !== digest)
    throw new Error('designerState canonical latest revision must match the current workspace');
}

/** v1 had a single committed workspace and optional history but no explicit recovery draft. */
function migrateV1(value: Record<string, unknown>, maxVersions: number): DecodedRecord {
  const project = metadata(value.project);
  const current = workspace(value.workspace, 'legacy workspace');
  if (project.id !== current.projectId)
    throw new Error('legacy project ID must match workspace project ID');
  const versions = Array.isArray(value.versions)
    ? value.versions.map(version)
    : [
        {
          id: derivedVersionId('initial', current.revision.id),
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
            id: derivedVersionId('migrated', current.revision.id),
            createdAt: monotonicTimestamp(
              current.revision.createdAt,
              latest?.createdAt ?? current.revision.createdAt
            ),
            summary: current.revision.summary,
            workspace: current
          }
        ];
  return decodeV2(
    {
      format: LOCAL_PROJECT_RECORD_FORMAT,
      schemaVersion: 2,
      versionSequence: normalizedVersions.length,
      project,
      current,
      versions: normalizedVersions,
      ...(value.autosave === undefined ? {} : { autosave: autosave(value.autosave) })
    },
    maxVersions
  );
}

function decode(value: unknown, maxVersions: number): DecodedRecord {
  const input = record(value, 'project record');
  if (input.format === LOCAL_PROJECT_RECORD_FORMAT) return decodeV2(input, maxVersions);
  if (input.format === LEGACY_PROJECT_RECORD_FORMAT && input.schemaVersion === 1)
    return { ...migrateV1(input, maxVersions), migrated: true };
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
  // Even an empty JSON string is two bytes, so a smaller quarantine cap cannot be honored.
  const minimum = key === 'maxVersions' || key === 'maxQuarantineBytes' ? 2 : 1;
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${key} must be an integer of at least ${minimum}`);
  return value;
}

function monotonicTimestamp(candidate: string, previous: string): string {
  return candidate > previous ? candidate : new Date(Date.parse(previous) + 1).toISOString();
}

function latestTimestamp(candidate: string, ...minimums: readonly string[]): string {
  return minimums.reduce((latest, minimum) => monotonicTimestamp(latest, minimum), candidate);
}

interface BoundedCapture {
  readonly value: unknown;
  readonly truncated: boolean;
}

function errorText(error: unknown): string {
  try {
    return error instanceof Error && typeof error.message === 'string'
      ? error.message
      : 'invalid project record';
  } catch {
    return 'invalid project record';
  }
}

const CAPTURE_KEYS = [
  'format',
  'schemaVersion',
  'project',
  'current',
  'workspace',
  'versions',
  'autosave',
  'versionSequence',
  'id',
  'name',
  'origin',
  'status',
  'createdAt',
  'updatedAt',
  'lastOpenedAt',
  'savedAt',
  'summary',
  'parentId',
  'projectId',
  'revision',
  'entrypoint',
  'files',
  'dependencies',
  'nodes',
  'path',
  'language',
  'content',
  'nodeId',
  'exportName'
] as const;

function ownData(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/** Bounded structural preview: it rejects proxies and only reads allowlisted own data descriptors. */
function capture(value: unknown, maximumBytes: number): BoundedCapture {
  const seen = new WeakSet<object>();
  let remaining = maximumBytes;
  let truncated = false;
  const marker = (label: string): string => {
    truncated = true;
    return label;
  };
  const consumeText = (input: string): string => {
    // Slice before measuring: Buffer.byteLength on an attacker-controlled string would otherwise
    // traverse an unbounded value merely to decide that it must be truncated.
    const candidate = input.slice(0, Math.max(0, remaining));
    const byteLength = Buffer.byteLength(candidate, 'utf8');
    if (input.length <= remaining && byteLength <= remaining) {
      remaining -= byteLength;
      return input;
    }
    const suffix = '[truncated]';
    const budget = Math.max(0, remaining - Buffer.byteLength(suffix, 'utf8'));
    let prefix = candidate.slice(0, budget);
    while (Buffer.byteLength(prefix, 'utf8') > budget) prefix = prefix.slice(0, -1);
    remaining = 0;
    return marker(`${prefix}${suffix}`);
  };
  const visit = (input: unknown, depth: number): unknown => {
    if (remaining <= 0 || depth > 8) {
      return marker('[truncated]');
    }
    if (typeof input === 'string') return consumeText(input);
    if (input === null || typeof input === 'number' || typeof input === 'boolean') {
      remaining -= 16;
      return input;
    }
    if (typeof input === 'bigint') return consumeText(`${input}n`);
    if (typeof input === 'symbol') return marker('[symbol]');
    if (typeof input === 'function') return marker('[function]');
    if (typeof input !== 'object') {
      remaining -= 16;
      return marker('[unsupported]');
    }
    if (types.isProxy(input)) return marker('[proxy]');
    if (seen.has(input)) {
      return marker('[circular]');
    }
    seen.add(input);
    if (Array.isArray(input)) {
      const values: unknown[] = [];
      const length = Math.min(input.length, 128);
      if (input.length > length) truncated = true;
      for (let index = 0; index < length; index += 1) {
        if (remaining <= 0) return values;
        let item: unknown;
        try {
          item = ownData(input, String(index));
        } catch {
          values.push(marker('[uninspectable]'));
          continue;
        }
        values.push(visit(item, depth + 1));
      }
      return values;
    }
    const result: Record<string, unknown> = {};
    for (const key of CAPTURE_KEYS) {
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      let item: unknown;
      try {
        item = ownData(input, key);
      } catch {
        result[key] = marker('[uninspectable]');
        continue;
      }
      if (item === undefined) continue;
      remaining -= Buffer.byteLength(key, 'utf8');
      result[key] = visit(item, depth + 1);
    }
    return Object.keys(result).length === 0 ? marker('[uninspectable object]') : result;
  };
  let captured: unknown;
  try {
    captured = visit(value, 0);
  } catch {
    captured = '[uninspectable]';
    truncated = true;
  }
  const serialized = JSON.stringify(captured);
  if (Buffer.byteLength(serialized, 'utf8') <= maximumBytes) return { value: captured, truncated };
  // JSON adds two quotes around this ASCII marker, so it cannot exceed the requested byte cap.
  return { value: 'x'.repeat(Math.max(0, maximumBytes - 2)), truncated: true };
}

function nextVersion(
  projectRecord: LocalProjectRecord,
  source: ReactSourceWorkspace,
  summary: string,
  prefix: 'recovery' | 'restore' | 'commit',
  createdAt: string,
  maxVersions: number
): LocalProjectRecord {
  if (projectRecord.versionSequence >= Number.MAX_SAFE_INTEGER - 1)
    throw new Error('versionSequence cannot be incremented safely');
  const versionCreatedAt = latestTimestamp(
    createdAt,
    source.revision.createdAt,
    projectRecord.versions.at(-1)?.createdAt ?? createdAt
  );
  const nextSequence = projectRecord.versionSequence + 1;
  const revisionIds = new Set([
    projectRecord.current.revision.id,
    ...projectRecord.versions.map((entry) => entry.workspace.revision.id)
  ]);
  const revisionId = collisionFreeId(prefix, source.revision.id, String(nextSequence), revisionIds);
  if (!versionIdPattern.test(revisionId)) throw new Error('generated revision ID is invalid');
  const revision =
    prefix === 'commit'
      ? clone(source.revision)
      : {
          ...source.revision,
          id: revisionId,
          parentId: projectRecord.current.revision.id,
          createdAt: versionCreatedAt,
          summary: normalizedText(summary, 'version.summary', MAX_SUMMARY_LENGTH)
        };
  const current = { ...clone(source), revision };
  const project = { ...projectRecord.project, updatedAt: versionCreatedAt };
  const { autosave: _autosave, ...withoutAutosave } = projectRecord;
  return {
    ...withoutAutosave,
    versionSequence: nextSequence,
    project,
    current,
    versions: [
      ...projectRecord.versions,
      {
        id: collisionFreeId(
          'version',
          revision.id,
          String(nextSequence),
          new Set(projectRecord.versions.map((entry) => entry.id))
        ),
        createdAt: versionCreatedAt,
        summary: revision.summary,
        workspace: current
      }
    ].slice(-maxVersions)
  };
}

function quarantineReason(value: string, payloadTruncated: boolean): string {
  const sanitized = value
    .normalize('NFC')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const suffix = payloadTruncated ? ' (payload truncated)' : '';
  const base = sanitized || 'invalid project record';
  return `${base.slice(0, MAX_QUARANTINE_REASON_LENGTH - suffix.length)}${suffix}`;
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
    return this.withProjectLock(id, () => this.createLocked(input, id));
  }

  private async createLocked(
    input: {
      readonly id: string;
      readonly name: string;
      readonly origin: LocalProjectOrigin;
      readonly workspace: ReactSourceWorkspace;
    },
    id: string
  ): Promise<LocalProjectRecord> {
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
    const createdAt = [now(this.options), current.revision.createdAt].sort()[0]!;
    const versionCreatedAt = monotonicTimestamp(createdAt, current.revision.createdAt);
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
        updatedAt: versionCreatedAt
      },
      current,
      versions: [
        {
          id: derivedVersionId('version', current.revision.id),
          createdAt: versionCreatedAt,
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
      const openedAt = monotonicTimestamp(now(this.options), current.project.updatedAt);
      const next = {
        ...current,
        project: { ...current.project, lastOpenedAt: openedAt, updatedAt: openedAt }
      };
      await this.storage.commit(next.project.id, next);
      return clone(next);
    });
  }
  public async designerState(id: string): Promise<LocalDesignerState | undefined> {
    return this.withProjectLock(id, async () => clone((await this.readRecord(id)).designerState));
  }
  public async storeDesignLanguageGuidance(
    id: string,
    digest: string,
    markdown: string
  ): Promise<void> {
    await this.withProjectLock(id, async () => {
      const current = await this.readRecord(id);
      this.assertActive(current);
      if (
        !/^[a-f0-9]{64}$/.test(digest) ||
        typeof markdown !== 'string' ||
        Buffer.byteLength(markdown, 'utf8') === 0 ||
        Buffer.byteLength(markdown, 'utf8') > 256 * 1024 ||
        createHash('sha256').update(markdown).digest('hex') !== digest
      )
        throw new ProjectLifecycleError('INVALID_PROJECT', 'design language guidance is invalid');
      const existing = current.designLanguageGuidance ?? [];
      const matched = existing.find((entry) => entry.digest === digest);
      if (matched?.markdown === markdown) return;
      const next = [
        ...existing.filter((entry) => entry.digest !== digest),
        Object.freeze({ digest, markdown })
      ];
      if (
        next.length > 32 ||
        next.reduce((total, entry) => total + Buffer.byteLength(entry.markdown, 'utf8'), 0) >
          256 * 1024
      )
        throw new ProjectLifecycleError(
          'INVALID_PROJECT',
          'design language guidance exceeds its bounded limit'
        );
      await this.storage.commit(id, { ...current, designLanguageGuidance: Object.freeze(next) });
    });
  }
  public async resolveDesignLanguageGuidance(
    id: string,
    digest: string
  ): Promise<string | undefined> {
    return this.withProjectLock(id, async () => {
      if (!/^[a-f0-9]{64}$/.test(digest))
        throw new ProjectLifecycleError('INVALID_PROJECT', 'guidance digest is invalid');
      const current = await this.readRecord(id);
      this.assertActive(current);
      const entry = current.designLanguageGuidance?.find((item) => item.digest === digest);
      return entry === undefined ? undefined : `${entry.markdown}`;
    });
  }
  public async removeDesignLanguageGuidance(id: string, digest: string): Promise<void> {
    await this.withProjectLock(id, async () => {
      const current = await this.readRecord(id);
      this.assertActive(current);
      if (!/^[a-f0-9]{64}$/.test(digest))
        throw new ProjectLifecycleError('INVALID_PROJECT', 'guidance digest is invalid');
      const next = (current.designLanguageGuidance ?? []).filter(
        (entry) => entry.digest !== digest
      );
      const { designLanguageGuidance: _removed, ...withoutGuidance } = current;
      await this.storage.commit(
        id,
        next.length === 0
          ? withoutGuidance
          : { ...withoutGuidance, designLanguageGuidance: Object.freeze(next) }
      );
    });
  }
  public async saveDesignerState(id: string, state: LocalDesignerState): Promise<void> {
    await this.withProjectLock(id, async () => {
      const current = await this.readRecord(id);
      this.assertActive(current);
      const designerState = decodeDesignerState(state, id);
      validateDesignerStateCurrent(designerState, current.current);
      const next = { ...current, designerState };
      await this.storage.commit(id, next);
    });
  }
  /** Atomically advances the durable workspace and its canonical collaboration projection. */
  public async commitDesignerRevision(
    id: string,
    nextWorkspace: ReactSourceWorkspace,
    state: LocalDesignerState
  ): Promise<LocalProjectRecord> {
    return this.withProjectLock(id, async () => {
      const current = await this.readRecord(id);
      this.assertActive(current);
      const saved = workspace(nextWorkspace, 'designer revision');
      if (saved.projectId !== current.project.id)
        throw new ProjectLifecycleError(
          'INVALID_PROJECT',
          'designer revision project ID must match the current project'
        );
      if (
        saved.revision.id === current.current.revision.id ||
        current.versions.some((entry) => entry.workspace.revision.id === saved.revision.id)
      )
        throw new ProjectLifecycleError('INVALID_PROJECT', 'designer revision ID must be new');
      if (saved.revision.parentId !== current.current.revision.id)
        throw new ProjectLifecycleError(
          'INVALID_PROJECT',
          'designer revision parent must be the current lifecycle revision'
        );
      if (saved.revision.createdAt <= current.versions.at(-1)!.createdAt)
        throw new ProjectLifecycleError(
          'INVALID_PROJECT',
          'designer revision timestamp must be strictly newer than the current lifecycle revision'
        );
      const next = nextVersion(
        current,
        saved,
        saved.revision.summary,
        'commit',
        now(this.options),
        this.maxVersions()
      );
      if (next.current.revision.id !== saved.revision.id)
        throw new ProjectLifecycleError(
          'INVALID_PROJECT',
          'lifecycle commit changed the proposed designer revision identity'
        );
      const designerState = decodeDesignerState(state, id);
      validateDesignerStateCurrent(designerState, next.current);
      const canonical = parseSnapshot(designerState.collaborationSnapshot);
      const latest = canonical.revisions.reduce(
        (previous, revision) =>
          previous === undefined || revision.sequence > previous.sequence ? revision : previous,
        undefined as (typeof canonical.revisions)[number] | undefined
      );
      const digest = createHash('sha256').update(JSON.stringify(next.current)).digest('hex');
      if (
        latest === undefined ||
        latest.id !== next.current.revision.id ||
        latest.contentSha256 !== digest
      )
        throw new ProjectLifecycleError(
          'INVALID_PROJECT',
          'canonical collaboration latest revision must match the committed lifecycle workspace'
        );
      const committed = { ...next, designerState };
      await this.storage.commit(id, committed);
      return clone(committed);
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
    this.assertActive(source);
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
        id: derivedVersionId('copy', source.current.revision.id),
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
      this.assertActive(current);
      const saved = workspace(draft, 'autosave draft');
      if (saved.projectId !== current.project.id)
        throw new ProjectLifecycleError(
          'INVALID_PROJECT',
          'autosave project ID must match the current project'
        );
      const savedAt = latestTimestamp(
        now(this.options),
        current.project.updatedAt,
        current.versions.at(-1)!.createdAt,
        saved.revision.createdAt
      );
      const next: LocalProjectRecord = {
        ...current,
        project: {
          ...current.project,
          updatedAt: savedAt
        },
        autosave: {
          savedAt,
          workspace: saved
        }
      };
      await this.storage.commit(current.project.id, next);
      return clone(next);
    });
  }

  public async recoverAutosave(id: string): Promise<LocalProjectRecord> {
    return this.withProjectLock(id, async () => {
      const current = await this.readRecord(id);
      this.assertActive(current);
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
      this.assertActive(current);
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
      this.assertActive(current);
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
      decoded = decode(raw, this.maxVersions());
    } catch (error) {
      const id = this.quarantineId(raw);
      await this.quarantine(id, `Import rejected: ${errorText(error)}`, raw);
      throw new ProjectLifecycleError(
        'PROJECT_QUARANTINED',
        `import was quarantined: ${errorText(error)}`
      );
    }
    if (await this.storage.read(decoded.record.project.id))
      throw new ProjectLifecycleError(
        'ALREADY_EXISTS',
        `project already exists: ${decoded.record.project.id}`
      );
    const imported: LocalProjectRecord = {
      ...decoded.record,
      project: {
        ...decoded.record.project,
        origin: 'imported',
        updatedAt: monotonicTimestamp(now(this.options), decoded.record.project.updatedAt)
      }
    };
    await this.storage.commit(imported.project.id, imported);
    return clone(imported);
  }

  private async setStatus(id: string, status: LocalProjectStatus): Promise<LocalProjectRecord> {
    return this.withProjectLock(id, async () => {
      const current = await this.readRecord(id);
      const next = {
        ...current,
        project: {
          ...current.project,
          status,
          updatedAt: monotonicTimestamp(now(this.options), current.project.updatedAt)
        }
      };
      await this.storage.commit(current.project.id, next);
      return clone(next);
    });
  }

  private async restoreVersionLocked(id: string, versionId: string): Promise<LocalProjectRecord> {
    const current = await this.readRecord(id);
    this.assertActive(current);
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
      const decoded = decode(raw, this.maxVersions());
      if (decoded.record.project.id !== resolvedId)
        throw new Error('stored project ID does not match its storage key');
      if (decoded.migrated || decoded.normalized)
        await this.storage.commit(resolvedId, decoded.record);
      return decoded.record;
    } catch (error) {
      await this.quarantine(resolvedId, errorText(error), raw);
      throw new ProjectLifecycleError(
        'PROJECT_QUARANTINED',
        `project was quarantined: ${errorText(error)}`
      );
    }
  }

  private quarantineId(raw: unknown): string {
    try {
      if (typeof raw !== 'object' || raw === null || types.isProxy(raw)) throw new Error();
      const project = ownData(raw, 'project');
      if (typeof project !== 'object' || project === null || types.isProxy(project))
        throw new Error();
      return projectId(ownData(project, 'id'));
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
      reason: quarantineReason(reason, captured.truncated),
      // The filesystem adapter owns this opaque, identity-checked token. Keep it intact so it
      // can retain exact on-disk bytes; every ordinary input still goes through bounded capture.
      raw: exactSourceFor(raw) === undefined ? captured.value : raw
    });
  }

  private maxVersions(): number {
    return limit(this.options, 'maxVersions', DEFAULT_MAX_VERSIONS);
  }

  private assertActive(projectRecord: LocalProjectRecord): void {
    if (projectRecord.project.status === 'archived')
      throw new ProjectLifecycleError('ARCHIVED', 'restore this project before changing it');
  }

  private async withProjectLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return this.storage.withProjectLock(projectId(id), operation);
  }
}

/** Main-process adapter; raw Markdown never crosses the designer snapshot boundary. */
export class DurableDesignLanguageGuidancePort {
  public constructor(private readonly lifecycle: LocalProjectLifecycleService) {}
  public store(id: string, artifactDigest: string, markdown: string): Promise<void> {
    return this.lifecycle.storeDesignLanguageGuidance(id, artifactDigest, markdown);
  }
  public resolve(id: string, artifactDigest: string): Promise<string | undefined> {
    return this.lifecycle.resolveDesignLanguageGuidance(id, artifactDigest);
  }
  public remove(id: string, artifactDigest: string): Promise<void> {
    return this.lifecycle.removeDesignLanguageGuidance(id, artifactDigest);
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
  /** Maximum serialized quarantine record size, including its diagnostic envelope. */
  readonly maxQuarantineBytes?: number;
  /** Test seam for simulating an interrupted temporary write. */
  readonly writeTemporary?: (path: string, contents: string) => Promise<void>;
  /** Test seam for simulating a failed temporary-file durability barrier. */
  readonly syncTemporary?: (path: string) => Promise<void>;
  /** Test seam for simulating a failed atomic rename. */
  readonly rename?: (from: string, to: string) => Promise<void>;
  /** Test seam for directory durability barriers after publication, removal, and pruning. */
  readonly syncDirectory?: (path: string) => Promise<void>;
  /** Test seam for active-source and retained-quarantine removal failures. */
  readonly remove?: (path: string) => Promise<void>;
  /** Test seam invoked after a bounded descriptor read and before its final fstat. */
  readonly afterBoundedRead?: (path: string) => Promise<void>;
  readonly maxProjectBytes?: number;
}

/**
 * Electron-main filesystem adapter. Atomic rename means a failed autosave keeps the previous
 * record. Its locking contract is deliberately single-process: production must compose it only
 * after Electron's `app.requestSingleInstanceLock()` succeeds. Within that owner process, the
 * canonical-root queue below serializes every conflicting lifecycle operation. It never tries to
 * infer or steal another process's on-disk lock, because pathname operations are not CAS-safe.
 */
export class FileProjectLifecycleStoragePort implements ProjectLifecycleStoragePort {
  public constructor(
    private readonly root: string,
    private readonly options: FileProjectLifecycleStorageOptions = {}
  ) {}

  public async listProjectIds(): Promise<readonly string[]> {
    let directory: Awaited<ReturnType<typeof opendir>> | undefined;
    try {
      directory = await opendir(this.projectsDirectory());
      const ids: string[] = [];
      for await (const entry of directory) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const id = entry.name.slice(0, -'.json'.length);
        if (projectIdPattern.test(id)) ids.push(id);
      }
      return ids;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    } finally {
      await directory?.close().catch(() => undefined);
    }
  }

  public async read(id: string): Promise<unknown | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const path = this.projectPath(id);
      const maximum = this.projectByteLimit();
      const pathStat = await lstat(path);
      if (!pathStat.isFile()) return undefined;
      handle = await open(path, this.noFollowFlags(constants.O_RDONLY));
      const before = await handle.stat();
      // On platforms without O_NOFOLLOW, verify the opened descriptor is the lstat'ed file
      // before reading any bytes. This detects replacement with a symlink without following it.
      if (!before.isFile() || before.dev !== pathStat.dev || before.ino !== pathStat.ino)
        return undefined;
      if (before.size > maximum) return this.sourceReference(path, before);
      const bytes = Buffer.allocUnsafe(maximum + 1);
      const byteLength = await this.readBounded(handle, bytes, 0);
      await this.options.afterBoundedRead?.(path);
      const after = await handle.stat();
      if (before.size !== after.size || after.size > maximum || byteLength > maximum)
        return this.sourceReference(path, after);
      const contents = bytes.subarray(0, byteLength).toString('utf8');
      try {
        const parsed = JSON.parse(contents) as object;
        // Preserve an identity-checked path to the original bytes for quarantine. The symbol is
        // intentionally invisible to the decoder and JSON capture, but available to this adapter
        // when it can atomically retain the exact source instead of a synthetic marker.
        Object.defineProperty(parsed, exactSource, {
          value: { path, device: before.dev, inode: before.ino, size: before.size }
        });
        return parsed;
      } catch {
        return this.sourceReference(path, before);
      }
    } catch (error) {
      if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? ''))
        return undefined;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  public async commit(id: string, value: LocalProjectRecord): Promise<void> {
    const contents = `${JSON.stringify(value, null, 2)}\n`;
    const maximum = this.projectByteLimit();
    if (Buffer.byteLength(contents, 'utf8') > maximum)
      throw new Error(`project record exceeds ${maximum} bytes`);
    await mkdir(this.projectsDirectory(), { recursive: true });
    const target = this.projectPath(id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      await (this.options.writeTemporary ?? this.writeAndSyncTemporary.bind(this))(
        temporary,
        contents
      );
      await (this.options.rename ?? rename)(temporary, target);
      renamed = true;
      await this.syncDirectory(this.projectsDirectory());
    } catch (error) {
      if (!renamed) await this.removeFile(temporary).catch(() => undefined);
      throw error;
    }
  }

  public async quarantine(entry: ProjectQuarantineEntry): Promise<void> {
    const contents = this.quarantineContents(entry);
    const quarantineDirectory = this.quarantineDirectory();
    await mkdir(quarantineDirectory, { recursive: true });
    const target = join(
      quarantineDirectory,
      `${entry.detectedAt.replace(/[^0-9]/g, '')}-${entry.projectId}-${randomUUID()}.json`
    );
    const temporary = `${target}.${randomUUID()}.tmp`;
    let published = false;
    try {
      await (this.options.writeTemporary ?? this.writeAndSyncTemporary.bind(this))(
        temporary,
        contents
      );
      await (this.options.rename ?? rename)(temporary, target);
      published = true;
      // The corrupt source cannot be removed until this durable quarantine publication succeeds.
      await this.syncDirectory(quarantineDirectory);
      await mkdir(this.projectsDirectory(), { recursive: true });
      const retainedRaw = await this.moveExactSource(entry, `${target}.raw`);
      if (!retainedRaw) await this.removeFile(this.projectPath(entry.projectId));
      await this.syncDirectory(this.projectsDirectory());
      if (retainedRaw) await this.syncDirectory(quarantineDirectory);
    } catch (error) {
      if (!published) await this.removeFile(temporary).catch(() => undefined);
      throw error;
    }
    await this.pruneQuarantine();
  }

  public async withProjectLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const resolvedId = projectId(id);
    const canonicalRoot = await this.canonicalRoot();
    return withSharedLock(`file:${canonicalRoot}:${resolvedId}`, operation);
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

  private projectByteLimit(): number {
    const maximum = this.options.maxProjectBytes ?? DEFAULT_MAX_IMPORT_BYTES;
    if (!Number.isSafeInteger(maximum) || maximum < 1)
      throw new Error('maxProjectBytes must be a positive safe integer');
    return maximum;
  }

  private quarantineByteLimit(): number {
    const maximum = this.options.maxQuarantineBytes ?? DEFAULT_MAX_QUARANTINE_BYTES + 4 * 1024;
    if (!Number.isSafeInteger(maximum) || maximum < 2_048)
      throw new Error('maxQuarantineBytes must be an integer of at least 2048');
    return maximum;
  }

  private quarantineContents(entry: ProjectQuarantineEntry): string {
    const maximum = this.quarantineByteLimit();
    const source = this.sourceFor(entry.raw);
    const raw =
      source === undefined
        ? capture(entry.raw, Math.max(2, Math.floor(maximum / 2)))
        : {
            value: `[source bytes not materialized; ${source.size} bytes may be retained as a paired raw file]`,
            truncated: source.size > maximum
          };
    const safeEntry = {
      projectId: projectId(entry.projectId),
      detectedAt: timestamp(entry.detectedAt, 'quarantine.detectedAt'),
      reason: quarantineReason(entry.reason, raw.truncated),
      raw: raw.value
    } satisfies ProjectQuarantineEntry;
    let contents = `${JSON.stringify(safeEntry, null, 2)}\n`;
    if (Buffer.byteLength(contents, 'utf8') <= maximum) return contents;
    contents = `${JSON.stringify({ ...safeEntry, raw: '[truncated]' }, null, 2)}\n`;
    if (Buffer.byteLength(contents, 'utf8') > maximum)
      throw new Error(`quarantine record exceeds ${maximum} bytes`);
    return contents;
  }

  private sourceReference(
    path: string,
    stat: { readonly dev: number; readonly ino: number; readonly size: number }
  ): ExactProjectSource {
    return { [exactSource]: { path, device: stat.dev, inode: stat.ino, size: stat.size } };
  }

  private sourceFor(value: unknown): ExactProjectSource[typeof exactSource] | undefined {
    return exactSourceFor(value);
  }

  private async moveExactSource(entry: ProjectQuarantineEntry, target: string): Promise<boolean> {
    const source = this.sourceFor(entry.raw);
    if (source === undefined || source.size > this.quarantineByteLimit()) return false;
    const expectedPath = this.projectPath(entry.projectId);
    if (source.path !== expectedPath) return false;
    const stat = await lstat(expectedPath).catch(() => undefined);
    if (
      stat === undefined ||
      !stat.isFile() ||
      stat.dev !== source.device ||
      stat.ino !== source.inode ||
      stat.size !== source.size
    )
      return false;
    await (this.options.rename ?? rename)(expectedPath, target);
    return true;
  }

  private noFollowFlags(flags: number): number {
    const noFollow = constants.O_NOFOLLOW;
    return typeof noFollow === 'number' ? flags | noFollow : flags;
  }

  private async readBounded(
    handle: Awaited<ReturnType<typeof open>>,
    bytes: Buffer,
    offset: number
  ): Promise<number> {
    let position = offset;
    while (position < bytes.length) {
      // oxlint-disable-next-line no-await-in-loop -- bounded descriptor reads must advance in order.
      const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
      if (bytesRead === 0) break;
      position += bytesRead;
    }
    return position;
  }

  private async canonicalRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true });
    return realpath(this.root);
  }

  private async writeAndSyncTemporary(path: string, contents: string): Promise<void> {
    if (this.options.writeTemporary !== undefined) {
      await this.options.writeTemporary(path, contents);
    } else {
      const handle = await open(
        path,
        this.noFollowFlags(constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL),
        0o600
      );
      try {
        await handle.writeFile(contents, 'utf8');
      } finally {
        await handle.close();
      }
    }
    await (this.options.syncTemporary ?? this.syncTemporary.bind(this))(path);
  }

  private async syncTemporary(path: string): Promise<void> {
    const handle = await open(path, this.noFollowFlags(constants.O_WRONLY));
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    if (this.options.syncDirectory !== undefined) {
      await this.options.syncDirectory(path);
      return;
    }
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
    let directory: Awaited<ReturnType<typeof opendir>> | undefined;
    let removed = false;
    try {
      directory = await opendir(this.quarantineDirectory());
      // Keep only the newest names seen so far. This bounds memory even if a hostile directory
      // contains many entries, and produces the same retained set as sorting the full listing.
      const retained: string[] = [];
      for await (const entry of directory) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        retained.push(entry.name);
        retained.sort((left, right) => left.localeCompare(right));
        if (retained.length > maximum) {
          const oldest = retained.shift();
          if (oldest !== undefined) {
            // Exact retained bytes are paired with their metadata. Remove the raw companion first:
            // an interruption can leave metadata behind, but never metadata pointing at a missing
            // active record without at least its bounded diagnostic evidence.
            // oxlint-disable-next-line no-await-in-loop -- sequential deletion preserves pairing.
            await this.removeFile(join(this.quarantineDirectory(), `${oldest}.raw`));
            // oxlint-disable-next-line no-await-in-loop -- publish the metadata removal last.
            await this.removeFile(join(this.quarantineDirectory(), oldest));
            removed = true;
          }
        }
      }
    } finally {
      await directory?.close().catch(() => undefined);
    }
    if (removed) await this.syncDirectory(this.quarantineDirectory());
  }

  private async removeFile(path: string): Promise<void> {
    if (this.options.remove !== undefined) return this.options.remove(path);
    await rm(path, { force: true });
  }
}
