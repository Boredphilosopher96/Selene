import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { PublishAdapterError, type GeneratedCodePublishPort, type GeneratedCodePublishRequest } from './designer-host-ports';
import type { GeneratedCodePublishReceipt } from '../shared/designer-api';
import type { GeneratedProjectMaterialization, GeneratedProjectMaterializationPort } from './generated-project-materializer';
import { validateGeneratedProjectFilePlan, type GeneratedProjectFilePlan } from './generated-project-template';

export const BUN_LOCK_ONLY_ARGS = Object.freeze(['install', '--lockfile-only', '--ignore-scripts', '--no-progress', '--no-summary'] as const);

export interface GeneratedProjectRegistryPolicyPort {
  /** Main-process policy may inject credentials directly into this child-only map; it never returns them. */
  configureBunEnvironment(environment: Record<string, string>, context: { readonly bundleDigest: string; readonly filePlanDigest: string }): void;
}

export class NoGeneratedProjectRegistryPolicy implements GeneratedProjectRegistryPolicyPort {
  public configureBunEnvironment(_environment: Record<string, string>, _context: { readonly bundleDigest: string; readonly filePlanDigest: string }): void {}
}

export interface GeneratedProjectCommandPort {
  runBunLockOnly(materialization: GeneratedProjectMaterialization, context: { readonly bundleDigest: string; readonly filePlanDigest: string; readonly signal: AbortSignal; readonly progress: (message: string) => void }): Promise<void>;
}

export class GeneratedProjectCommandError extends Error {
  public constructor(public readonly code: 'CANCELLED' | 'TIMEOUT' | 'TOOL_UNAVAILABLE' | 'PROCESS_FAILED', message: string) { super(message); }
}

function stablePublishError(error: unknown): PublishAdapterError {
  if (error instanceof PublishAdapterError) return error;
  if (error instanceof GeneratedProjectCommandError)
    return new PublishAdapterError(error.code, error.message);
  return new PublishAdapterError('INTEGRITY', error instanceof Error ? error.message : 'Generated project validation failed.');
}

/** Fixed-identity Bun runner. It accepts neither renderer argv nor a renderer-selected cwd. */
export class HostAttestedBunCommandPort implements GeneratedProjectCommandPort {
  public constructor(
    private readonly bunExecutable: string,
    private readonly isolatedCacheDirectory: string,
    private readonly isolatedConfigurationDirectory: string,
    private readonly registryPolicy: GeneratedProjectRegistryPolicyPort = new NoGeneratedProjectRegistryPolicy(),
    private readonly timeoutMs = 120_000,
    private readonly terminateGraceMs = 5_000
  ) {
    if (!isAbsolute(bunExecutable) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000 || !Number.isSafeInteger(terminateGraceMs) || terminateGraceMs < 250 || terminateGraceMs > 30_000)
      throw new Error('generated project Bun command configuration is invalid');
  }

  private async privateDirectory(path: string): Promise<string> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project host directory is unsafe.');
    return realpath(path);
  }

  private async executable(): Promise<string> {
    try {
      const actual = await realpath(this.bunExecutable);
      const stat = await lstat(actual);
      if (!stat.isFile() || stat.isSymbolicLink() || !isAbsolute(actual))
        throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project Bun executable is unsafe.');
      return actual;
    } catch (error) {
      if (error instanceof GeneratedProjectCommandError) throw error;
      throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project Bun executable is unavailable.');
    }
  }

  public async runBunLockOnly(materialization: GeneratedProjectMaterialization, context: { readonly bundleDigest: string; readonly filePlanDigest: string; readonly signal: AbortSignal; readonly progress: (message: string) => void }): Promise<void> {
    if (context.signal.aborted) throw new GeneratedProjectCommandError('CANCELLED', 'Generated project lock generation was cancelled.');
    const executable = await this.executable();
    const cwd = await realpath(materialization.root);
    const cwdStat = await lstat(cwd);
    if (!cwdStat.isDirectory() || cwdStat.isSymbolicLink() || cwd !== materialization.root)
      throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project working directory is not an attested lease root.');
    const cache = await this.privateDirectory(this.isolatedCacheDirectory);
    const configuration = await this.privateDirectory(this.isolatedConfigurationDirectory);
    const environment: Record<string, string> = {};
    for (const name of ['LANG', 'LC_ALL', 'LC_CTYPE', 'NO_COLOR'] as const) if (process.env[name] !== undefined) environment[name] = process.env[name]!;
    environment.BUN_INSTALL_CACHE_DIR = cache;
    environment.BUN_CONFIG_DIR = configuration;
    environment.HOME = configuration;
    environment.XDG_CONFIG_HOME = configuration;
    this.registryPolicy.configureBunEnvironment(environment, { bundleDigest: context.bundleDigest, filePlanDigest: context.filePlanDigest });
    context.progress('Generating Bun lockfile with scripts disabled.');
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(executable, [...BUN_LOCK_ONLY_ARGS], { cwd, env: environment, shell: false, detached: process.platform === 'darwin', stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = 0; let stderr = 0; let settled = false; let terminating = false;
      let pending: Error | undefined; let escalation: ReturnType<typeof setTimeout> | undefined; let timeout: ReturnType<typeof setTimeout> | undefined; let watchdog: ReturnType<typeof setTimeout> | undefined;
      let requestAbort: () => void = () => undefined;
      const finish = (error?: Error) => {
        if (settled) return; settled = true;
        if (timeout) clearTimeout(timeout); if (escalation) clearTimeout(escalation); if (watchdog) clearTimeout(watchdog);
        context.signal.removeEventListener('abort', requestAbort);
        if (error) rejectPromise(error); else resolvePromise();
      };
      const signalTree = (signal: NodeJS.Signals) => {
        try {
          if (process.platform === 'darwin' && child.pid !== undefined) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { /* The process may have already closed; close/error settles the operation. */ }
      };
      const terminate = (error: Error) => {
        if (pending === undefined) pending = error;
        if (terminating) return;
        terminating = true;
        signalTree('SIGTERM');
        escalation = setTimeout(() => signalTree('SIGKILL'), this.terminateGraceMs);
        watchdog = setTimeout(() => finish(pending), this.terminateGraceMs + 5_000);
      };
      requestAbort = () => terminate(new GeneratedProjectCommandError('CANCELLED', 'Generated project lock generation was cancelled.'));
      timeout = setTimeout(() => terminate(new GeneratedProjectCommandError('TIMEOUT', 'Generated project Bun lock generation timed out.')), this.timeoutMs);
      context.signal.addEventListener('abort', requestAbort, { once: true });
      if (context.signal.aborted) requestAbort();
      const consume = (stream: NodeJS.ReadableStream, kind: 'stdout' | 'stderr') => stream.on('data', (chunk: Buffer) => {
        if (kind === 'stdout') stdout += chunk.byteLength; else stderr += chunk.byteLength;
        if (stdout > 64 * 1_024 || stderr > 64 * 1_024) terminate(new GeneratedProjectCommandError('PROCESS_FAILED', 'Generated project Bun output exceeded its bound.'));
      });
      consume(child.stdout, 'stdout'); consume(child.stderr, 'stderr');
      child.once('error', () => finish(pending ?? new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project Bun process could not start.')));
      child.once('close', (code, signal) => {
        if (pending !== undefined) finish(pending);
        else if (code !== 0 || signal !== null) finish(new GeneratedProjectCommandError('PROCESS_FAILED', 'Generated project Bun lock generation failed.'));
        else finish();
      });
      if (context.signal.aborted) requestAbort();
    });
  }
}

export interface GeneratedProjectLockReceipt {
  readonly lockDigest: string;
  readonly artifactDigest: string;
  readonly lockBytes: number;
  readonly filePlanDigest: string;
}

export interface GeneratedProjectLockPort {
  resolve(materialization: GeneratedProjectMaterialization, plan: GeneratedProjectFilePlan, options: { readonly signal: AbortSignal; readonly progress: (message: string) => void }): Promise<GeneratedProjectLockReceipt>;
}

/** Runs only the fixed Bun lock-only operation, then validates its bounded no-follow artifact. */
export class BunLockOnlyGeneratedProjectLockPort implements GeneratedProjectLockPort {
  public constructor(private readonly materializer: GeneratedProjectMaterializationPort, private readonly command: GeneratedProjectCommandPort) {}

  public async resolve(materialization: GeneratedProjectMaterialization, plan: GeneratedProjectFilePlan, options: { readonly signal: AbortSignal; readonly progress: (message: string) => void }): Promise<GeneratedProjectLockReceipt> {
    const validated = validateGeneratedProjectFilePlan(plan);
    if (validated.filePlanDigest !== materialization.filePlanDigest || validated.bundle.digest !== materialization.bundleDigest)
      throw new PublishAdapterError('CONFLICT', 'Generated project lease does not match the immutable publish plan.');
    try { await this.materializer.assertLease(materialization); }
    catch (error) { throw new PublishAdapterError('INTEGRITY', error instanceof Error ? error.message : 'Generated project lease is invalid.'); }
    await this.command.runBunLockOnly(materialization, { bundleDigest: validated.bundle.digest, filePlanDigest: validated.filePlanDigest, signal: options.signal, progress: options.progress });
    if (options.signal.aborted) throw new PublishAdapterError('CANCELLED', 'Generated project lock generation was cancelled.');
    const nodeModules = join(materialization.root, 'node_modules');
    try { await lstat(nodeModules); throw new PublishAdapterError('INTEGRITY', 'Lock-only validation must not create node_modules.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const lock = resolve(materialization.root, 'bun.lock');
    if (relative(materialization.root, lock) !== 'bun.lock' || typeof constants.O_NOFOLLOW !== 'number') throw new PublishAdapterError('INTEGRITY', 'Generated Bun lockfile path is unsafe.');
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try { handle = await open(lock, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { throw new PublishAdapterError('INTEGRITY', error instanceof Error ? error.message : 'Generated Bun lockfile is unavailable.'); }
    const lockHandle = handle;
    if (lockHandle === undefined) throw new PublishAdapterError('INTEGRITY', 'Generated Bun lockfile is unavailable.');
    try {
      const stat = await lockHandle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > 1_024 * 1_024) throw new PublishAdapterError('INTEGRITY', 'Generated Bun lockfile is invalid.');
      const content = await lockHandle.readFile();
      if (content.byteLength !== stat.size) throw new PublishAdapterError('INTEGRITY', 'Generated Bun lockfile changed while being read.');
      const lockDigest = createHash('sha256').update(content).digest('hex');
      const artifactDigest = createHash('sha256').update(`${validated.bundle.digest}\u0000${validated.filePlanDigest}\u0000${lockDigest}`).digest('hex');
      options.progress('Validated generated Bun lockfile without retaining the project.');
      return { lockDigest, artifactDigest, lockBytes: stat.size, filePlanDigest: validated.filePlanDigest };
    } finally { await handle?.close(); }
  }
}

/** Local validation materializes only the supplied immutable plan and always releases its lease. */
export class LocalGeneratedProjectValidationAdapter implements GeneratedCodePublishPort {
  public readonly id = 'local-generated-project-validation-v1';
  public readonly mode = 'local-preview' as const;
  public constructor(private readonly materializer: GeneratedProjectMaterializationPort, private readonly lock: GeneratedProjectLockPort) {}

  public async publish(request: GeneratedCodePublishRequest, options: { readonly signal: AbortSignal; readonly progress: (message: string) => void }): Promise<GeneratedCodePublishReceipt> {
    if (request.mode !== 'local-preview') throw new PublishAdapterError('CONFLICT', 'The local validation adapter cannot publish remotely.');
    if (request.plan.filePlanDigest === '' || request.plan.bundle.digest !== request.bundle.bundleDigest) throw new PublishAdapterError('CONFLICT', 'Local validation received an inconsistent immutable plan.');
    let materialization: GeneratedProjectMaterialization | undefined;
    let primary: unknown;
    try {
      options.progress('Materializing the immutable generated project plan.');
      materialization = await this.materializer.materialize(request.plan, { signal: options.signal });
      const receipt = await this.lock.resolve(materialization, request.plan, options);
      return { mode: 'local-preview', status: 'local-bundle-validated', bundleDigest: request.bundle.bundleDigest, filePlanDigest: receipt.filePlanDigest, artifactDigest: receipt.artifactDigest, immutableId: request.bundle.immutableId };
    } catch (error) {
      primary = options.signal.aborted
        ? new PublishAdapterError('CANCELLED', 'Local generated project validation was cancelled.')
        : stablePublishError(error);
      throw primary;
    } finally {
      if (materialization !== undefined) {
        try { await this.materializer.cleanup(materialization.leaseId); options.progress('Cleaned the temporary generated project lease.'); }
        catch (cleanupError) { throw new PublishAdapterError('CLEANUP_FAILED', `Temporary generated project cleanup failed${primary instanceof Error ? ` after: ${primary.message}` : ''}.`); }
      }
    }
  }
}
