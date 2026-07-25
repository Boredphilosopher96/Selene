import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { validateGeneratedProjectFilePlan, type GeneratedProjectFile, type GeneratedProjectFilePlan } from './generated-project-template';

export interface GeneratedProjectMaterialization {
  readonly format: 'selene-generated-project-materialization/v1';
  readonly leaseId: string;
  /** Host-owned temporary path. It is never accepted from or exposed to a renderer API. */
  readonly root: string;
  readonly bundleDigest: string;
  readonly expiresAt: string;
}

export interface GeneratedProjectMaterializationPort {
  materialize(plan: GeneratedProjectFilePlan, options?: { readonly signal?: AbortSignal }): Promise<GeneratedProjectMaterialization>;
  cleanup(leaseId: string): Promise<void>;
  cleanupExpired(now?: Date): Promise<number>;
}

export class GeneratedProjectMaterializationError extends Error {
  public constructor(public readonly code: 'CANCELLED' | 'UNSAFE_PATH' | 'WRITE_FAILED' | 'UNKNOWN_LEASE', message: string) { super(message); }
}

interface LeaseRecord {
  readonly root: string;
  readonly expiresAt: number;
}

/**
 * A host-composed file-plan materializer. It accepts no renderer paths or
 * commands, never invokes Bun/Git/gh, and writes only under its own mkdtemp
 * directory with exclusive no-follow file creation.
 */
export class MktempGeneratedProjectMaterializer implements GeneratedProjectMaterializationPort {
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly leaseMilliseconds: number;

  public constructor(private readonly hostTemporaryParent: string, leaseMilliseconds = 15 * 60 * 1_000) {
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 60_000 || leaseMilliseconds > 24 * 60 * 60 * 1_000)
      throw new Error('generated project lease duration is invalid');
    this.leaseMilliseconds = leaseMilliseconds;
  }

  private assertNotCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new GeneratedProjectMaterializationError('CANCELLED', 'Generated project materialization was cancelled.');
  }

  private contained(root: string, candidate: string): boolean {
    const path = relative(root, candidate);
    return path !== '' && !path.startsWith('..') && !isAbsolute(path);
  }

  private async prepareParent(): Promise<string> {
    await mkdir(this.hostTemporaryParent, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.hostTemporaryParent);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new GeneratedProjectMaterializationError('UNSAFE_PATH', 'Generated project parent is unsafe.');
    const root = await realpath(this.hostTemporaryParent);
    return root;
  }

  private async assertDirectory(root: string, candidate: string): Promise<string> {
    if (!this.contained(root, candidate))
      throw new GeneratedProjectMaterializationError('UNSAFE_PATH', 'Generated project path escaped its host root.');
    const stat = await lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new GeneratedProjectMaterializationError('UNSAFE_PATH', 'Generated project directory is unsafe.');
    const actual = await realpath(candidate);
    if (!this.contained(root, actual))
      throw new GeneratedProjectMaterializationError('UNSAFE_PATH', 'Generated project directory escaped its host root.');
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

  private async writeExclusive(root: string, file: GeneratedProjectFile, signal: AbortSignal | undefined): Promise<void> {
    this.assertNotCancelled(signal);
    const parent = await this.ensureDirectories(root, file.path);
    const target = resolve(parent, file.path.split('/').at(-1)!);
    if (!this.contained(root, target))
      throw new GeneratedProjectMaterializationError('UNSAFE_PATH', 'Generated project file escaped its host root.');
    if (typeof constants.O_NOFOLLOW !== 'number')
      throw new GeneratedProjectMaterializationError('UNSAFE_PATH', 'This platform cannot safely materialize generated project files.');
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(file.content, 'utf8');
      await handle.sync();
    } catch (error) {
      if (error instanceof GeneratedProjectMaterializationError) throw error;
      throw new GeneratedProjectMaterializationError('WRITE_FAILED', error instanceof Error ? error.message : 'Could not write generated project file.');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async completionMarker(root: string, plan: GeneratedProjectFilePlan, signal: AbortSignal | undefined): Promise<void> {
    await this.writeExclusive(root, {
      path: 'selene/.complete.json',
      content: `${JSON.stringify({ format: 'selene-generated-project-complete/v1', bundleDigest: plan.bundle.digest, template: plan.template })}\n`
    }, signal);
  }

  private async removeKnownRoot(parent: string, root: string): Promise<void> {
    if (!this.contained(parent, root) || !root.startsWith(join(parent, 'selene-generated-')))
      throw new GeneratedProjectMaterializationError('UNSAFE_PATH', 'Refusing to clean an unknown generated project path.');
    try {
      const stat = await lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new GeneratedProjectMaterializationError('UNSAFE_PATH', 'Generated project cleanup root is unsafe.');
      await rm(root, { recursive: true, force: true, maxRetries: 1 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  public async materialize(plan: GeneratedProjectFilePlan, options: { readonly signal?: AbortSignal } = {}): Promise<GeneratedProjectMaterialization> {
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
      this.leases.set(leaseId, { root, expiresAt });
      return Object.freeze({ format: 'selene-generated-project-materialization/v1', leaseId, root, bundleDigest: validated.bundle.digest, expiresAt: new Date(expiresAt).toISOString() });
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
    if (lease === undefined) throw new GeneratedProjectMaterializationError('UNKNOWN_LEASE', 'Generated project lease is unknown.');
    const parent = await this.prepareParent();
    await this.removeKnownRoot(parent, lease.root);
    this.leases.delete(leaseId);
  }

  public async cleanupExpired(now = new Date()): Promise<number> {
    const timestamp = now.getTime();
    if (!Number.isFinite(timestamp)) throw new GeneratedProjectMaterializationError('UNSAFE_PATH', 'Generated project cleanup time is invalid.');
    let removed = 0;
    for (const [leaseId, lease] of this.leases) {
      if (lease.expiresAt > timestamp) continue;
      await this.cleanup(leaseId);
      removed += 1;
    }
    return removed;
  }
}
