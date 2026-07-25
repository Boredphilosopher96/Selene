import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, opendir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  validateGeneratedProjectFilePlan,
  type GeneratedProjectFile,
  type GeneratedProjectFilePlan
} from './generated-project-template';

const maximumRecoveryEntries = 1_024;
const maximumRecoveryItems = 128;
const maximumRecoveryMarkerBytes = 16 * 1024;

export interface GeneratedProjectMaterialization {
  readonly format: 'selene-generated-project-materialization/v1';
  readonly leaseId: string;
  /** Host-owned temporary path. It is never accepted from or exposed to a renderer API. */
  readonly root: string;
  readonly bundleDigest: string;
  readonly filePlanDigest: string;
  readonly expiresAt: string;
}

export interface GeneratedProjectMaterializationPort {
  materialize(
    plan: GeneratedProjectFilePlan,
    options?: { readonly signal?: AbortSignal }
  ): Promise<GeneratedProjectMaterialization>;
  assertLease(materialization: GeneratedProjectMaterialization): Promise<void>;
  /** Keeps a lease intact when a child process could not be proven terminated. */
  quarantine(
    materialization: GeneratedProjectMaterialization,
    record: GeneratedProjectQuarantineRecord
  ): Promise<void>;
  cleanup(leaseId: string): Promise<void>;
  cleanupExpired(now?: Date): Promise<number>;
  /** Host recovery inventory. It intentionally never signals or deletes a discovered orphan. */
  recoveryInventory(): Promise<GeneratedProjectRecoveryInventory>;
}

export interface GeneratedProjectQuarantineRecord {
  readonly reason: 'PROCESS_ORPHANED';
  readonly processGroupId: number;
}

export interface GeneratedProjectRecoveryItem extends GeneratedProjectQuarantineRecord {
  readonly format: 'selene-generated-project-orphan/v1';
  readonly root: string;
  readonly bundleDigest: string;
  readonly filePlanDigest: string;
  readonly quarantinedAt: string;
  /** PID reuse cannot be excluded at a later startup. This is observational only. */
  readonly groupObservation: 'absent' | 'present-or-reused' | 'unknown';
}

export interface GeneratedProjectRecoveryInventory {
  readonly items: readonly GeneratedProjectRecoveryItem[];
  /** Number of directory entries inspected before this bounded inventory returned. */
  readonly examined: number;
  /** True when the entry or item cap may have omitted additional orphan roots. */
  readonly truncated: boolean;
}

export class GeneratedProjectMaterializationError extends Error {
  public constructor(
    public readonly code:
      'CANCELLED' | 'UNSAFE_PATH' | 'WRITE_FAILED' | 'UNKNOWN_LEASE' | 'QUARANTINED',
    message: string
  ) {
    super(message);
  }
}

interface LeaseRecord {
  readonly root: string;
  readonly expiresAt: number;
  readonly bundleDigest: string;
  readonly filePlanDigest: string;
  readonly quarantine?: GeneratedProjectQuarantineRecord & { readonly at: number };
}

/**
 * A host-composed file-plan materializer. It accepts no renderer paths or
 * commands, never invokes Bun/Git/gh, and writes only under its own mkdtemp
 * directory with exclusive no-follow file creation.
 */
export class MktempGeneratedProjectMaterializer implements GeneratedProjectMaterializationPort {
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly leaseMilliseconds: number;

  public constructor(
    private readonly hostTemporaryParent: string,
    leaseMilliseconds = 15 * 60 * 1_000
  ) {
    if (
      !Number.isSafeInteger(leaseMilliseconds) ||
      leaseMilliseconds < 60_000 ||
      leaseMilliseconds > 24 * 60 * 60 * 1_000
    )
      throw new Error('generated project lease duration is invalid');
    this.leaseMilliseconds = leaseMilliseconds;
  }

  private assertNotCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted)
      throw new GeneratedProjectMaterializationError(
        'CANCELLED',
        'Generated project materialization was cancelled.'
      );
  }

  private contained(root: string, candidate: string): boolean {
    const path = relative(root, candidate);
    return path !== '' && !path.startsWith('..') && !isAbsolute(path);
  }

  private async prepareParent(): Promise<string> {
    await mkdir(this.hostTemporaryParent, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.hostTemporaryParent);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new GeneratedProjectMaterializationError(
        'UNSAFE_PATH',
        'Generated project parent is unsafe.'
      );
    const root = await realpath(this.hostTemporaryParent);
    return root;
  }

  private async assertDirectory(root: string, candidate: string): Promise<string> {
    if (!this.contained(root, candidate))
      throw new GeneratedProjectMaterializationError(
        'UNSAFE_PATH',
        'Generated project path escaped its host root.'
      );
    const stat = await lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new GeneratedProjectMaterializationError(
        'UNSAFE_PATH',
        'Generated project directory is unsafe.'
      );
    const actual = await realpath(candidate);
    if (!this.contained(root, actual))
      throw new GeneratedProjectMaterializationError(
        'UNSAFE_PATH',
        'Generated project directory escaped its host root.'
      );
    return actual;
  }

  private async ensureDirectories(root: string, file: string): Promise<string> {
    let current = root;
    const parent = dirname(file);
    if (parent === '.') return current;
    for (const segment of parent.split('/')) {
      const next = join(current, segment);
      try {
        await mkdir(next, { mode: 0o700 });
      } catch (error) {
        // Reuse only a verified directory below our private root; never rely
        // on recursive mkdir or an unvalidated EEXIST node.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      current = await this.assertDirectory(root, next);
    }
    return current;
  }

  private async writeExclusive(
    root: string,
    file: GeneratedProjectFile,
    signal: AbortSignal | undefined
  ): Promise<void> {
    this.assertNotCancelled(signal);
    const parent = await this.ensureDirectories(root, file.path);
    const target = resolve(parent, file.path.split('/').at(-1)!);
    if (!this.contained(root, target))
      throw new GeneratedProjectMaterializationError(
        'UNSAFE_PATH',
        'Generated project file escaped its host root.'
      );
    if (typeof constants.O_NOFOLLOW !== 'number')
      throw new GeneratedProjectMaterializationError(
        'UNSAFE_PATH',
        'This platform cannot safely materialize generated project files.'
      );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      await handle.writeFile(file.content, 'utf8');
      await handle.sync();
    } catch (error) {
      if (error instanceof GeneratedProjectMaterializationError) throw error;
      throw new GeneratedProjectMaterializationError(
        'WRITE_FAILED',
        error instanceof Error ? error.message : 'Could not write generated project file.'
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async completionMarker(
    root: string,
    plan: GeneratedProjectFilePlan,
    signal: AbortSignal | undefined
  ): Promise<void> {
    await this.writeExclusive(
      root,
      {
        path: 'selene/.complete.json',
        content: `${JSON.stringify({ format: 'selene-generated-project-complete/v1', bundleDigest: plan.bundle.digest, filePlanDigest: plan.filePlanDigest, template: plan.template })}\n`
      },
      signal
    );
  }

  private async removeKnownRoot(parent: string, root: string): Promise<void> {
    if (!this.contained(parent, root) || !root.startsWith(join(parent, 'selene-generated-')))
      throw new GeneratedProjectMaterializationError(
        'UNSAFE_PATH',
        'Refusing to clean an unknown generated project path.'
      );
    try {
      const stat = await lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new GeneratedProjectMaterializationError(
          'UNSAFE_PATH',
          'Generated project cleanup root is unsafe.'
        );
      await rm(root, { recursive: true, force: true, maxRetries: 1 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  public async materialize(
    plan: GeneratedProjectFilePlan,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<GeneratedProjectMaterialization> {
    const validated = validateGeneratedProjectFilePlan(plan);
    this.assertNotCancelled(options.signal);
    const parent = await this.prepareParent();
    let root: string | undefined;
    try {
      root = await mkdtemp(join(parent, 'selene-generated-'));
      root = await this.assertDirectory(parent, root);
      await chmod(root, 0o700);
      root = await this.assertDirectory(parent, root);
      for (const file of validated.files) await this.writeExclusive(root, file, options.signal);
      await this.completionMarker(root, validated, options.signal);
      this.assertNotCancelled(options.signal);
      const leaseId = `generated-project-${randomUUID()}`;
      const expiresAt = Date.now() + this.leaseMilliseconds;
      this.leases.set(leaseId, {
        root,
        expiresAt,
        bundleDigest: validated.bundle.digest,
        filePlanDigest: validated.filePlanDigest
      });
      return Object.freeze({
        format: 'selene-generated-project-materialization/v1',
        leaseId,
        root,
        bundleDigest: validated.bundle.digest,
        filePlanDigest: validated.filePlanDigest,
        expiresAt: new Date(expiresAt).toISOString()
      });
    } catch (error) {
      if (root !== undefined) {
        try {
          await this.removeKnownRoot(parent, root);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Generated project materialization failed and its temporary directory could not be cleaned.'
          );
        }
      }
      throw error;
    }
  }

  public async cleanup(leaseId: string): Promise<void> {
    const lease = this.leases.get(leaseId);
    if (lease === undefined)
      throw new GeneratedProjectMaterializationError(
        'UNKNOWN_LEASE',
        'Generated project lease is unknown.'
      );
    if (lease.quarantine !== undefined)
      throw new GeneratedProjectMaterializationError(
        'QUARANTINED',
        'Generated project lease is retained for host recovery.'
      );
    const parent = await this.prepareParent();
    await this.removeKnownRoot(parent, lease.root);
    this.leases.delete(leaseId);
  }

  public async assertLease(materialization: GeneratedProjectMaterialization): Promise<void> {
    const lease = this.leases.get(materialization.leaseId);
    if (
      lease === undefined ||
      lease.quarantine !== undefined ||
      lease.root !== materialization.root ||
      lease.bundleDigest !== materialization.bundleDigest ||
      lease.filePlanDigest !== materialization.filePlanDigest ||
      materialization.expiresAt !== new Date(lease.expiresAt).toISOString() ||
      lease.expiresAt <= Date.now()
    )
      throw new GeneratedProjectMaterializationError(
        'UNKNOWN_LEASE',
        'Generated project lease is no longer active.'
      );
    const parent = await this.prepareParent();
    await this.assertDirectory(parent, lease.root);
  }

  public async quarantine(
    materialization: GeneratedProjectMaterialization,
    record: GeneratedProjectQuarantineRecord
  ): Promise<void> {
    const lease = this.leases.get(materialization.leaseId);
    if (
      lease === undefined ||
      lease.root !== materialization.root ||
      lease.bundleDigest !== materialization.bundleDigest ||
      lease.filePlanDigest !== materialization.filePlanDigest
    )
      throw new GeneratedProjectMaterializationError(
        'UNKNOWN_LEASE',
        'Generated project lease is no longer active.'
      );
    if (
      record.reason !== 'PROCESS_ORPHANED' ||
      !Number.isSafeInteger(record.processGroupId) ||
      record.processGroupId <= 0
    )
      throw new GeneratedProjectMaterializationError(
        'UNSAFE_PATH',
        'Generated project quarantine record is invalid.'
      );
    // Fail closed before any marker I/O. If the marker cannot be written, this
    // active-process lease remains ineligible for cleanup in this process.
    const quarantinedAt = Date.now();
    this.leases.set(materialization.leaseId, {
      ...lease,
      quarantine: { ...record, at: quarantinedAt }
    });
    const parent = await this.prepareParent();
    await this.assertDirectory(parent, lease.root);
    await this.writeExclusive(
      lease.root,
      {
        path: 'selene/.orphaned.json',
        content: `${JSON.stringify({ format: 'selene-generated-project-orphan/v1', reason: record.reason, processGroupId: record.processGroupId, bundleDigest: lease.bundleDigest, filePlanDigest: lease.filePlanDigest, quarantinedAt: new Date(quarantinedAt).toISOString() })}\n`
      },
      undefined
    );
  }

  private observeProcessGroup(
    processGroupId: number
  ): GeneratedProjectRecoveryItem['groupObservation'] {
    if (process.platform !== 'darwin') return 'unknown';
    // Signal 0 performs no delivery; it is only a conservative liveness probe.
    try {
      process.kill(-processGroupId, 0);
      return 'present-or-reused';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return 'absent';
      if (code === 'EPERM') return 'present-or-reused';
      return 'unknown';
    }
  }

  private canonicalTimestamp(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value
    );
  }

  private async recoveryItem(
    parent: string,
    entry: string
  ): Promise<GeneratedProjectRecoveryItem | undefined> {
    if (!entry.startsWith('selene-generated-')) return undefined;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const root = resolve(parent, entry);
      const actual = await this.assertDirectory(parent, root);
      const marker = resolve(actual, 'selene', '.orphaned.json');
      if (!this.contained(actual, marker) || typeof constants.O_NOFOLLOW !== 'number')
        return undefined;
      handle = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > maximumRecoveryMarkerBytes)
        return undefined;
      const bytes = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
      const after = await handle.stat();
      if (bytesRead !== bytes.byteLength || after.size !== stat.size) return undefined;
      const value = JSON.parse(bytes.toString('utf8')) as unknown;
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
      )
        return undefined;
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const expectedKeys = [
        'bundleDigest',
        'filePlanDigest',
        'format',
        'processGroupId',
        'quarantinedAt',
        'reason'
      ];
      if (
        keys.length !== expectedKeys.length ||
        keys.some((key, index) => key !== expectedKeys[index]) ||
        record.format !== 'selene-generated-project-orphan/v1' ||
        record.reason !== 'PROCESS_ORPHANED' ||
        !Number.isSafeInteger(record.processGroupId) ||
        (record.processGroupId as number) <= 0 ||
        typeof record.bundleDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.bundleDigest) ||
        typeof record.filePlanDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.filePlanDigest) ||
        !this.canonicalTimestamp(record.quarantinedAt)
      )
        return undefined;
      return Object.freeze({
        format: 'selene-generated-project-orphan/v1',
        root: actual,
        reason: 'PROCESS_ORPHANED',
        processGroupId: record.processGroupId as number,
        bundleDigest: record.bundleDigest,
        filePlanDigest: record.filePlanDigest,
        quarantinedAt: record.quarantinedAt,
        groupObservation: this.observeProcessGroup(record.processGroupId as number)
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  public async recoveryInventory(): Promise<GeneratedProjectRecoveryInventory> {
    const parent = await this.prepareParent();
    const inventory: GeneratedProjectRecoveryItem[] = [];
    const directory = await opendir(parent);
    let examined = 0;
    try {
      while (examined < maximumRecoveryEntries && inventory.length < maximumRecoveryItems) {
        const entry = await directory.read();
        if (entry === null) break;
        examined += 1;
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const item = await this.recoveryItem(parent, entry.name);
        if (item !== undefined) inventory.push(item);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    const items = Object.freeze(
      inventory.sort((left, right) =>
        left.root < right.root ? -1 : left.root > right.root ? 1 : 0
      )
    );
    return Object.freeze({
      items,
      examined,
      truncated: examined >= maximumRecoveryEntries || items.length >= maximumRecoveryItems
    });
  }

  public async cleanupExpired(now = new Date()): Promise<number> {
    const timestamp = now.getTime();
    if (!Number.isFinite(timestamp))
      throw new GeneratedProjectMaterializationError(
        'UNSAFE_PATH',
        'Generated project cleanup time is invalid.'
      );
    let removed = 0;
    for (const [leaseId, lease] of this.leases) {
      // An orphaned process can still own this directory. Recovery must make
      // an explicit containment decision before any deletion is attempted.
      if (lease.quarantine !== undefined) continue;
      if (lease.expiresAt > timestamp) continue;
      await this.cleanup(leaseId);
      removed += 1;
    }
    return removed;
  }
}
