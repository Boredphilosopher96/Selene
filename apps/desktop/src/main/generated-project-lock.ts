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
const maximumExecutableBytes = 512 * 1024 * 1024;
const maximumCommandOutputBytes = 64 * 1024;

export interface BunExecutableAttestation {
  readonly bunVersion: '1.3.14';
  readonly arch: 'arm64' | 'x64';
  /** SHA-256 of the extracted executable, verified directly before spawn. */
  readonly executableSha256: string;
  /** Archive digest is packaging provenance; B2B verifies it before extraction. */
  readonly archiveSha256: string;
}

/** Official Bun v1.3.14 release provenance, kept in one host-only source. */
export const BUN_1_3_14_EXECUTABLE_ATTESTATIONS: Readonly<Record<BunExecutableAttestation['arch'], BunExecutableAttestation>> = Object.freeze({
  arm64: Object.freeze({ bunVersion: '1.3.14', arch: 'arm64', executableSha256: 'e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233', archiveSha256: 'd8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620' }),
  x64: Object.freeze({ bunVersion: '1.3.14', arch: 'x64', executableSha256: 'ea2f223e94bb2f4bf3050895113c3cf346438f6fa0501c8532284e063f72f7a0', archiveSha256: '4183df3374623e5bab315c547cfa0974533cd457d86b73b639f7a87974cd6633' })
});

export function packagedBunExecutable(resourcesPath: string, arch: string): string {
  // Packaging is a later concern; selecting by runtime architecture here makes
  // an absent resource a truthful TOOL_UNAVAILABLE outcome rather than PATH fallback.
  return join(resourcesPath, 'bun', arch, 'bun');
}

export interface GeneratedProjectRegistryPolicyPort {
  /** Returns inert registry metadata only; credentials and arbitrary child env are forbidden. */
  bunConfiguration(context: { readonly bundleDigest: string; readonly filePlanDigest: string }): { readonly registryUrl?: string };
}

export class NoGeneratedProjectRegistryPolicy implements GeneratedProjectRegistryPolicyPort {
  public bunConfiguration(_context: { readonly bundleDigest: string; readonly filePlanDigest: string }): { readonly registryUrl?: string } { return Object.freeze({}); }
}

export interface GeneratedProjectCommandPort {
  runBunLockOnly(materialization: GeneratedProjectMaterialization, context: { readonly bundleDigest: string; readonly filePlanDigest: string; readonly signal: AbortSignal; readonly progress: (message: string) => void }): Promise<void>;
}

export class GeneratedProjectCommandError extends Error {
  public constructor(public readonly code: 'CANCELLED' | 'TIMEOUT' | 'TOOL_UNAVAILABLE' | 'PROCESS_FAILED' | 'PROCESS_ORPHANED', message: string) { super(message); }
}

const stableMessages: Readonly<Record<PublishAdapterError['code'], string>> = Object.freeze({
  OFFLINE: 'The host registry is unavailable.',
  AUTH_REQUIRED: 'Explicit host publish consent is required.',
  CONFLICT: 'The immutable publish inputs no longer match.',
  CANCELLED: 'Generated project validation was cancelled.',
  CLEANUP_FAILED: 'Temporary generated project cleanup requires host recovery.',
  TOOL_UNAVAILABLE: 'The verified Bun tool is unavailable.',
  TIMEOUT: 'Generated project validation timed out.',
  PROCESS_FAILED: 'Generated project validation process failed.',
  PROCESS_ORPHANED: 'Generated project process termination could not be confirmed; the lease was quarantined.',
  INTEGRITY: 'Generated project validation integrity check failed.'
});

function stablePublishError(error: unknown): PublishAdapterError {
  if (error instanceof PublishAdapterError) return error;
  if (error instanceof GeneratedProjectCommandError)
    return new PublishAdapterError(error.code, stableMessages[error.code]);
  return new PublishAdapterError('INTEGRITY', stableMessages.INTEGRITY);
}

/** Fixed-identity Bun runner. It accepts neither renderer argv nor a renderer-selected cwd. */
export class HostAttestedBunCommandPort implements GeneratedProjectCommandPort {
  public constructor(
    private readonly bunExecutable: string,
    private readonly attestation: BunExecutableAttestation | undefined,
    private readonly isolatedCacheDirectory: string,
    private readonly registryPolicy: GeneratedProjectRegistryPolicyPort = new NoGeneratedProjectRegistryPolicy(),
    private readonly timeoutMs = 120_000,
    private readonly terminateGraceMs = 5_000
  ) {
    if (!isAbsolute(bunExecutable) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000 || !Number.isSafeInteger(terminateGraceMs) || terminateGraceMs < 250 || terminateGraceMs > 30_000)
      throw new Error('generated project Bun command configuration is invalid');
  }

  private async privateDirectory(path: string): Promise<string> {
    try {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project host directory is unsafe.');
      return await realpath(path);
    } catch (error) {
      if (error instanceof GeneratedProjectCommandError) throw error;
      throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project host directory is unavailable.');
    }
  }

  private async executable(): Promise<string> {
    try {
      if (this.attestation === undefined || this.attestation.arch !== process.arch)
        throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'No verified Bun executable is packaged for this architecture.');
      // Inspect the configured pathname before resolution: a final-component
      // symlink is never accepted as the trusted executable identity.
      const configured = await lstat(this.bunExecutable);
      if (!configured.isFile() || configured.isSymbolicLink() || (configured.mode & 0o111) === 0)
        throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project Bun executable is unsafe.');
      const actual = await realpath(this.bunExecutable);
      const configuredAfterResolution = await lstat(this.bunExecutable);
      if (configuredAfterResolution.isSymbolicLink() || configuredAfterResolution.dev !== configured.dev || configuredAfterResolution.ino !== configured.ino)
        throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project Bun executable changed while being verified.');
      const stat = await lstat(actual);
      if (!stat.isFile() || stat.isSymbolicLink() || !isAbsolute(actual) || (stat.mode & 0o111) === 0 || stat.size <= 0 || stat.size > maximumExecutableBytes)
        throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project Bun executable is unsafe.');
      if (typeof constants.O_NOFOLLOW !== 'number')
        throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'This platform cannot safely verify the Bun executable.');
      const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size !== stat.size) throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project Bun executable changed while being verified.');
        const hash = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024);
        for (let position = 0; position < before.size; position += buffer.byteLength) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, before.size - position), position);
          if (bytesRead === 0) throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project Bun executable changed while being verified.');
          hash.update(buffer.subarray(0, bytesRead));
        }
        const after = await handle.stat();
        const pathAfter = await lstat(actual);
        if (after.size !== before.size || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || hash.digest('hex') !== this.attestation.executableSha256)
          throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project Bun executable does not match packaged provenance.');
      } finally { await handle.close(); }
      return actual;
    } catch (error) {
      if (error instanceof GeneratedProjectCommandError) throw error;
      throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project Bun executable is unavailable.');
    }
  }

  private async leaseConfigurationPath(materialization: GeneratedProjectMaterialization): Promise<string> {
    try {
      const configDirectory = resolve(materialization.root, 'selene');
      if (relative(materialization.root, configDirectory) !== 'selene')
        throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project Bun configuration path is unsafe.');
      const configDirectoryStat = await lstat(configDirectory);
      const actualConfigDirectory = await realpath(configDirectory);
      if (!configDirectoryStat.isDirectory() || configDirectoryStat.isSymbolicLink() || actualConfigDirectory !== configDirectory)
        throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project Bun configuration path is unsafe.');
      const path = resolve(actualConfigDirectory, '.bunfig.lock-only.toml');
      if (relative(materialization.root, path) !== 'selene/.bunfig.lock-only.toml' || typeof constants.O_NOFOLLOW !== 'number')
        throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project Bun configuration path is unsafe.');
      return path;
    } catch (error) {
      if (error instanceof GeneratedProjectCommandError) throw error;
      throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project Bun configuration path is unavailable.');
    }
  }

  private async bunConfiguration(materialization: GeneratedProjectMaterialization, context: { readonly bundleDigest: string; readonly filePlanDigest: string }): Promise<string> {
    const configured = this.registryPolicy.bunConfiguration(context);
    if (typeof configured !== 'object' || configured === null || Array.isArray(configured) || Object.keys(configured).some((key) => key !== 'registryUrl'))
      throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project registry policy is invalid.');
    let registry = '[install]\n';
    if (configured.registryUrl !== undefined) {
      if (typeof configured.registryUrl !== 'string' || configured.registryUrl.length === 0 || configured.registryUrl.length > 2_048)
        throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project registry policy is invalid.');
      let url: URL;
      try { url = new URL(configured.registryUrl); } catch { throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project registry policy is invalid.'); }
      if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '')
        throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project registry policy is invalid.');
      registry += `registry = ${JSON.stringify(url.toString())}\n`;
    }
    // This lives inside the host-owned lease, not a shared app config root:
    // two consented operations can never overwrite one another's registry file.
    const path = await this.leaseConfigurationPath(materialization);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(registry, 'utf8'); await handle.sync();
    } catch {
      throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project Bun configuration could not be prepared.');
    } finally { await handle?.close().catch(() => undefined); }
    return path;
  }

  public async runBunLockOnly(materialization: GeneratedProjectMaterialization, context: { readonly bundleDigest: string; readonly filePlanDigest: string; readonly signal: AbortSignal; readonly progress: (message: string) => void }): Promise<void> {
    if (context.signal.aborted) throw new GeneratedProjectCommandError('CANCELLED', 'Generated project lock generation was cancelled.');
    const executable = await this.executable();
    const cwd = await realpath(materialization.root);
    const cwdStat = await lstat(cwd);
    if (!cwdStat.isDirectory() || cwdStat.isSymbolicLink() || cwd !== materialization.root)
      throw new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project working directory is not an attested lease root.');
    const cache = await this.privateDirectory(this.isolatedCacheDirectory);
    const configFile = await this.bunConfiguration(materialization, { bundleDigest: context.bundleDigest, filePlanDigest: context.filePlanDigest });
    const environment: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
    for (const name of ['LANG', 'LC_ALL', 'LC_CTYPE', 'NO_COLOR'] as const) if (process.env[name] !== undefined) environment[name] = process.env[name]!;
    context.progress('Generating Bun lockfile with scripts disabled.');
    if (context.signal.aborted) throw new GeneratedProjectCommandError('CANCELLED', 'Generated project lock generation was cancelled.');
    await new Promise<void>((resolvePromise, rejectPromise) => {
      // This immediate guard is intentionally adjacent to spawn: an already
      // cancelled operation must not start a child process.
      if (context.signal.aborted) { rejectPromise(new GeneratedProjectCommandError('CANCELLED', 'Generated project lock generation was cancelled.')); return; }
      const child = spawn(executable, [...BUN_LOCK_ONLY_ARGS, '--cache-dir', cache, '--config', configFile], { cwd, env: environment, shell: false, detached: process.platform === 'darwin', stdio: ['ignore', 'pipe', 'pipe'] });
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
        // A process group that survives SIGKILL is never considered cleaned.
        // The caller quarantines its lease instead of racing recursive cleanup.
        watchdog = setTimeout(() => finish(new GeneratedProjectCommandError('PROCESS_ORPHANED', 'Generated project Bun process termination could not be confirmed.')), this.terminateGraceMs + 5_000);
      };
      requestAbort = () => terminate(new GeneratedProjectCommandError('CANCELLED', 'Generated project lock generation was cancelled.'));
      timeout = setTimeout(() => terminate(new GeneratedProjectCommandError('TIMEOUT', 'Generated project Bun lock generation timed out.')), this.timeoutMs);
      context.signal.addEventListener('abort', requestAbort, { once: true });
      if (context.signal.aborted) requestAbort();
      const consume = (stream: NodeJS.ReadableStream, kind: 'stdout' | 'stderr') => stream.on('data', (chunk: Buffer) => {
        if (kind === 'stdout') stdout += chunk.byteLength; else stderr += chunk.byteLength;
        if (stdout > maximumCommandOutputBytes || stderr > maximumCommandOutputBytes) terminate(new GeneratedProjectCommandError('PROCESS_FAILED', 'Generated project Bun output exceeded its bound.'));
      });
      consume(child.stdout, 'stdout'); consume(child.stderr, 'stderr');
      child.once('error', () => {
        // During termination, wait for close or the orphan watchdog. An error
        // event alone does not prove the detached macOS process group is gone.
        if (!terminating) finish(new GeneratedProjectCommandError('TOOL_UNAVAILABLE', 'Generated project Bun process could not start.'));
      });
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
    catch { throw new PublishAdapterError('INTEGRITY', stableMessages.INTEGRITY); }
    await this.command.runBunLockOnly(materialization, { bundleDigest: validated.bundle.digest, filePlanDigest: validated.filePlanDigest, signal: options.signal, progress: options.progress });
    if (options.signal.aborted) throw new PublishAdapterError('CANCELLED', 'Generated project lock generation was cancelled.');
    const nodeModules = join(materialization.root, 'node_modules');
    try { await lstat(nodeModules); throw new PublishAdapterError('INTEGRITY', 'Lock-only validation must not create node_modules.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const lock = resolve(materialization.root, 'bun.lock');
    if (relative(materialization.root, lock) !== 'bun.lock' || typeof constants.O_NOFOLLOW !== 'number') throw new PublishAdapterError('INTEGRITY', 'Generated Bun lockfile path is unsafe.');
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try { handle = await open(lock, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch { throw new PublishAdapterError('INTEGRITY', stableMessages.INTEGRITY); }
    const lockHandle = handle;
    if (lockHandle === undefined) throw new PublishAdapterError('INTEGRITY', 'Generated Bun lockfile is unavailable.');
    try {
      const stat = await lockHandle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > 1_024 * 1_024) throw new PublishAdapterError('INTEGRITY', 'Generated Bun lockfile is invalid.');
      const content = await lockHandle.readFile();
      if (content.byteLength !== stat.size) throw new PublishAdapterError('INTEGRITY', 'Generated Bun lockfile changed while being read.');
      const lockDigest = createHash('sha256').update(content).digest('hex');
      const artifactDigest = createHash('sha256').update(`${validated.bundle.digest}\u0000${validated.filePlanDigest}\u0000${lockDigest}`).digest('hex');
      options.progress('Validated the temporary generated Bun lockfile.');
      return { lockDigest, artifactDigest, lockBytes: stat.size, filePlanDigest: validated.filePlanDigest };
    } finally { await handle?.close(); }
  }
}

/** Local validation materializes only the supplied immutable plan and releases it unless termination is unconfirmed. */
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
      return { mode: 'local-preview', status: 'local-bundle-validated', bundleDigest: request.bundle.bundleDigest, filePlanDigest: receipt.filePlanDigest, artifactDigest: receipt.artifactDigest, validation: 'materialized-lock', immutableId: request.bundle.immutableId };
    } catch (error) {
      const normalized = stablePublishError(error);
      // Cancellation may be the initiating event, but an unconfirmed
      // post-SIGKILL process is more important: its directory cannot be cleaned.
      primary = normalized.code === 'PROCESS_ORPHANED'
        ? normalized
        : options.signal.aborted
          ? new PublishAdapterError('CANCELLED', stableMessages.CANCELLED)
          : normalized;
      throw primary;
    } finally {
      if (materialization !== undefined) {
        if (primary instanceof PublishAdapterError && primary.code === 'PROCESS_ORPHANED') {
          try {
            await this.materializer.quarantine(materialization, 'PROCESS_ORPHANED');
            options.progress('Retained the generated project lease for host recovery.');
          } catch {
            throw new PublishAdapterError('CLEANUP_FAILED', stableMessages.CLEANUP_FAILED);
          }
        } else {
          try { await this.materializer.cleanup(materialization.leaseId); options.progress('Cleaned the temporary generated project lease.'); }
          catch { throw new PublishAdapterError('CLEANUP_FAILED', stableMessages.CLEANUP_FAILED); }
        }
      }
    }
  }
}
