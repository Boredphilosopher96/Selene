import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import {
  createHostEffectAdmissionPool,
  createHostEffectSupervisorOptions,
  HostEffectSupervisor,
  isHostEffectSupervisorError,
  type HostCallContext
} from '@selene/host-runtime';

import { PublishAdapterError } from './designer-host-ports';
import type { GeneratedCodePublishPort, GeneratedCodePublishRequest } from './designer-host-ports';
import type { GeneratedCodePublishReceipt, GitHubPublishSetup } from '../shared/designer-api';
import { canonicalGitHubRepository } from '../shared/github-repository';
import type {
  GeneratedProjectMaterialization,
  GeneratedProjectMaterializationPort,
  GeneratedProjectQuarantineRecord
} from './generated-project-materializer';
import {
  GeneratedProjectCommandError,
  type GeneratedProjectLockPort
} from './generated-project-lock';

const homebrewPrefixes = Object.freeze(['/opt/homebrew', '/usr/local']);
const maximumExecutableBytes = 512 * 1024 * 1024;
const maximumRecoveryBytes = 8 * 1024;
const maximumSourceFileBytes = 1024 * 1024;
const maximumBlobRequestBytes = Math.ceil((maximumSourceFileBytes * 4) / 3) + 1024;
const maximumMetadataRequestBytes = 256 * 1024;
const maximumResponseBytes = 2 * 1024 * 1024;
const maximumErrorBytes = 128 * 1024;
const commandDeadlineMs = 90_000;
const terminateGraceMs = 5_000;
const orphanWatchdogMs = 15_000;
const processPollMs = 100;
const shaPattern = /^[a-f0-9]{40}$/;

export type GitHubPublishSetupState = GitHubPublishSetup;
export type GitHubRepositoryVisibility = 'public' | 'private';
export interface GitHubRepositoryProvisioning {
  readonly owner:
    | { readonly kind: 'current-user'; readonly login: string }
    | { readonly kind: 'organization'; readonly login: string };
  readonly name: string;
  readonly visibility: GitHubRepositoryVisibility;
  /** Explicit host-consent evidence, never a token or renderer-supplied command. */
  readonly provisioningConsent: true;
}
export interface GitHubRepositoryRecord {
  readonly full_name: string;
  readonly default_branch: string;
  readonly private: boolean;
}
export interface GitHubCommitRecord {
  readonly sha: string;
  readonly tree: { readonly sha: string };
  readonly parents: readonly { readonly sha: string }[];
}
export interface GitHubTreeRecord {
  readonly sha: string;
  readonly tree: readonly {
    readonly path: string;
    readonly mode: string;
    readonly type: string;
    readonly sha?: string;
  }[];
}
export interface GitHubPullRequestRecord {
  readonly html_url: string;
  readonly title: string;
  readonly body: string;
  readonly draft: true;
  readonly state: 'open';
  readonly head: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string };
}
export interface GitHubRefRecord {
  readonly ref: string;
  readonly object: { readonly sha: string; readonly type: 'commit'; readonly url: string };
}

interface ExecutableAttestation {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly digest: string;
}
interface OperationSpec {
  readonly argv: readonly string[];
  readonly stdin?: Buffer;
  readonly requestLimit: number;
  readonly responseLimit: number;
}
interface RecoveryRecord {
  readonly format: 'selene-github-cli-orphan/v1';
  readonly processGroupId: number;
  readonly createdAt: string;
}
type RunnerEnvelope = Readonly<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: PublishAdapterError['code'] | 'NOT_FOUND' }
>;
class GitHubTransportNotFoundError extends Error {
  public constructor() {
    super('GitHub resource was not found.');
  }
}

function hostError(code: PublishAdapterError['code'], message: string): PublishAdapterError {
  return new PublishAdapterError(code, message);
}
function safeSegment(value: string, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    /[\\/?#%\u0000-\u001f\u007f]/.test(value)
  )
    throw hostError('INTEGRITY', 'GitHub ' + name + ' is invalid.');
  return encodeURIComponent(value);
}
function repository(value: string): string {
  try {
    return canonicalGitHubRepository(value);
  } catch {
    throw hostError('CONFLICT', 'GitHub repository is not canonical.');
  }
}
function sameRepository(left: string, right: string): boolean {
  return (
    repository(left).toLocaleLowerCase('en-US') === repository(right).toLocaleLowerCase('en-US')
  );
}
function validRef(value: string, prefix = ''): boolean {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return false;
  const rest = value.slice(prefix.length);
  if (
    rest.length === 0 ||
    rest.length > 200 ||
    rest.includes('//') ||
    rest.includes('@{') ||
    /[\u0000-\u001f\u007f ~^:?*[\\]/.test(rest)
  )
    return false;
  const components = rest.split('/');
  return (
    components.length >= 2 &&
    components.every(
      (component) =>
        component.length > 0 &&
        !component.startsWith('.') &&
        !component.endsWith('.') &&
        !component.endsWith('.lock') &&
        !component.includes('..')
    )
  );
}
function jsonBody(value: unknown, maximum: number): Buffer {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw hostError('INTEGRITY', 'GitHub request body is invalid.');
  }
  const result = Buffer.from(serialized, 'utf8');
  if (result.byteLength > maximum)
    throw hostError('INTEGRITY', 'GitHub request exceeds its operation bound.');
  return result;
}
function gitBlobSha(bytes: Buffer): string {
  return createHash('sha1')
    .update(Buffer.from('blob ' + bytes.byteLength + '\u0000', 'utf8'))
    .update(bytes)
    .digest('hex');
}
function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function stringField(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum)
    throw hostError('INTEGRITY', 'GitHub response ' + name + ' is invalid.');
  return value;
}
function parseRepository(value: unknown): GitHubRepositoryRecord {
  if (!isPlainRecord(value)) throw hostError('INTEGRITY', 'GitHub repository response is invalid.');
  const fullName = stringField(value.full_name, 'full_name', 142);
  repository(fullName);
  const defaultBranch = stringField(value.default_branch, 'default_branch', 200);
  if (!validRef('heads/' + defaultBranch))
    throw hostError('INTEGRITY', 'GitHub default branch is invalid.');
  if (typeof value.private !== 'boolean')
    throw hostError('INTEGRITY', 'GitHub repository visibility is invalid.');
  return Object.freeze({
    full_name: fullName,
    default_branch: defaultBranch,
    private: value.private
  });
}
function parseCommit(value: unknown): GitHubCommitRecord {
  if (
    !isPlainRecord(value) ||
    typeof value.sha !== 'string' ||
    !shaPattern.test(value.sha) ||
    !isPlainRecord(value.tree) ||
    typeof value.tree.sha !== 'string' ||
    !shaPattern.test(value.tree.sha) ||
    !Array.isArray(value.parents) ||
    value.parents.length > 32
  )
    throw hostError('INTEGRITY', 'GitHub commit response is invalid.');
  const parents = value.parents.map((parent) => {
    if (!isPlainRecord(parent) || typeof parent.sha !== 'string' || !shaPattern.test(parent.sha))
      throw hostError('INTEGRITY', 'GitHub commit parents are invalid.');
    return Object.freeze({ sha: parent.sha });
  });
  return Object.freeze({
    sha: value.sha,
    tree: Object.freeze({ sha: value.tree.sha }),
    parents: Object.freeze(parents)
  });
}
function hasExactParents(commit: GitHubCommitRecord, expected: readonly string[]): boolean {
  return (
    commit.parents.length === expected.length &&
    commit.parents.every((parent, index) => parent.sha === expected[index])
  );
}
function parseTree(value: unknown, requireComplete = false): GitHubTreeRecord {
  if (
    !isPlainRecord(value) ||
    typeof value.sha !== 'string' ||
    !shaPattern.test(value.sha) ||
    (requireComplete && value.truncated !== false) ||
    !Array.isArray(value.tree) ||
    value.tree.length > 32_768
  )
    throw hostError('INTEGRITY', 'GitHub tree response is invalid.');
  const tree = value.tree.map((entry) => {
    if (
      !isPlainRecord(entry) ||
      typeof entry.path !== 'string' ||
      entry.path.length === 0 ||
      entry.path.length > 1024 ||
      typeof entry.mode !== 'string' ||
      typeof entry.type !== 'string' ||
      (entry.sha !== undefined && (typeof entry.sha !== 'string' || !shaPattern.test(entry.sha)))
    )
      throw hostError('INTEGRITY', 'GitHub tree entry is invalid.');
    return Object.freeze({
      path: entry.path,
      mode: entry.mode,
      type: entry.type,
      ...(entry.sha === undefined ? {} : { sha: entry.sha })
    });
  });
  return Object.freeze({ sha: value.sha, tree: Object.freeze(tree) });
}
function parsePullRequest(value: unknown): GitHubPullRequestRecord {
  if (
    !isPlainRecord(value) ||
    !isPlainRecord(value.head) ||
    !isPlainRecord(value.base) ||
    value.draft !== true ||
    value.state !== 'open' ||
    typeof value.head.sha !== 'string' ||
    !shaPattern.test(value.head.sha)
  )
    throw hostError('INTEGRITY', 'GitHub pull request response is invalid.');
  return Object.freeze({
    html_url: stringField(value.html_url, 'html_url', 2048),
    title: stringField(value.title, 'title', 256),
    body:
      typeof value.body === 'string' && value.body.length <= 16_384
        ? value.body
        : (() => {
            throw hostError('INTEGRITY', 'GitHub pull request body is invalid.');
          })(),
    draft: true,
    state: 'open',
    head: Object.freeze({ ref: stringField(value.head.ref, 'head.ref', 200), sha: value.head.sha }),
    base: Object.freeze({ ref: stringField(value.base.ref, 'base.ref', 200) })
  });
}
function parseRef(value: unknown): GitHubRefRecord {
  if (
    !isPlainRecord(value) ||
    typeof value.ref !== 'string' ||
    !validRef(value.ref, 'refs/') ||
    !isPlainRecord(value.object) ||
    typeof value.object.sha !== 'string' ||
    !shaPattern.test(value.object.sha) ||
    value.object.type !== 'commit' ||
    typeof value.object.url !== 'string' ||
    value.object.url.length > 2048
  )
    throw hostError('INTEGRITY', 'GitHub ref response is invalid.');
  return Object.freeze({
    ref: value.ref,
    object: Object.freeze({ sha: value.object.sha, type: 'commit', url: value.object.url })
  });
}
function classifiedFailure(
  exitCode: number | null,
  stderr: Buffer
): PublishAdapterError | GitHubTransportNotFoundError {
  if (exitCode === 4) return hostError('AUTH_REQUIRED', 'GitHub authentication is required.');
  const text = stderr.toString('utf8').toLowerCase();
  if (/rate limit|\b429\b/.test(text))
    return hostError('OFFLINE', 'GitHub publishing is temporarily rate limited.');
  if (/\bhttp\s*404\b|\bstatus\s*404\b/.test(text)) return new GitHubTransportNotFoundError();
  if (/\b401\b|\b403\b|authentication|not logged in/.test(text))
    return hostError('AUTH_REQUIRED', 'GitHub authentication is required.');
  if (/network|timed out|connection|dns|\b5\d\d\b/.test(text))
    return hostError('OFFLINE', 'GitHub service is unavailable.');
  if (/\b409\b|\b422\b|already exists|reference update failed/.test(text))
    return hostError('CONFLICT', 'GitHub publish state conflicts with immutable inputs.');
  return hostError('PROCESS_FAILED', 'GitHub publish command failed.');
}
function scheduler() {
  return Object.freeze({
    schedule: (delay: number, task: () => void) => {
      const timer = setTimeout(task, delay);
      return Object.freeze({ cancel: () => clearTimeout(timer) });
    }
  });
}

/** Host-only transport. Its public surface exposes named GitHub operations, never argv, endpoints, or arbitrary JSON. */
export class HomebrewGitHubCliTransport {
  private readonly supervisor: HostEffectSupervisor;
  private readonly executionRoot: string;
  private readonly userConfigDirectory: string;
  private readonly owner: object;
  private recoveryRequired = false;
  public constructor(appUserDataRoot: string, userHomeDirectory: string) {
    if (!isAbsolute(appUserDataRoot) || !isAbsolute(userHomeDirectory))
      throw new Error('GitHub host root must be absolute.');
    this.executionRoot = join(appUserDataRoot, 'github-publish-execution-v1');
    this.userConfigDirectory = join(userHomeDirectory, '.config', 'gh');
    const pool = createHostEffectAdmissionPool({
      clock: Object.freeze({ now: () => Date.now() }),
      maxConcurrentEffects: 2,
      maxConcurrentEffectsPerOwner: 1
    });
    this.supervisor = new HostEffectSupervisor(
      createHostEffectSupervisorOptions({ admissionPool: pool, scheduler: scheduler() })
    );
    this.owner = Object.freeze({
      run: (context: HostCallContext, spec: OperationSpec): Promise<RunnerEnvelope> =>
        this.runPrivate(context, spec)
          .then((value) => Object.freeze({ ok: true as const, value }))
          .catch((error: unknown) =>
            Object.freeze({
              ok: false as const,
              code:
                error instanceof GitHubTransportNotFoundError
                  ? 'NOT_FOUND'
                  : error instanceof PublishAdapterError
                    ? error.code
                    : 'INTEGRITY'
            })
          )
    });
  }

  private async directory(path: string): Promise<string> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const before = await lstat(path);
    const actual = await realpath(path);
    const after = await lstat(path);
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      actual !== path
    )
      throw hostError('TOOL_UNAVAILABLE', 'GitHub host directory is unsafe.');
    return actual;
  }
  private async existingDirectory(path: string): Promise<string | undefined> {
    try {
      const before = await lstat(path);
      const actual = await realpath(path);
      const after = await lstat(path);
      if (
        !before.isDirectory() ||
        before.isSymbolicLink() ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        actual !== path
      )
        throw hostError('TOOL_UNAVAILABLE', 'GitHub configuration directory is unsafe.');
      return actual;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  private async executable(): Promise<ExecutableAttestation> {
    if (process.platform !== 'darwin')
      throw hostError(
        'TOOL_UNAVAILABLE',
        'GitHub publishing is available only in packaged macOS desktop builds.'
      );
    for (const prefix of homebrewPrefixes) {
      const configured = join(prefix, 'bin', 'gh');
      try {
        const link = await lstat(configured);
        if (!link.isSymbolicLink()) continue;
        const actual = await realpath(configured);
        const linkAfter = await lstat(configured);
        const stat = await lstat(actual);
        const expected = /^Cellar\/gh\/[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9._-]+)?\/bin\/gh$/;
        if (
          link.dev !== linkAfter.dev ||
          link.ino !== linkAfter.ino ||
          !expected.test(relative(prefix, actual)) ||
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          (stat.mode & 0o111) === 0 ||
          stat.size <= 0 ||
          stat.size > maximumExecutableBytes
        )
          continue;
        return this.attest(actual, stat.dev, stat.ino, stat.size);
      } catch {
        /* Continue only through the other fixed Homebrew prefix. */
      }
    }
    throw hostError('TOOL_UNAVAILABLE', 'GitHub CLI is unavailable in trusted Homebrew locations.');
  }
  private async attest(
    path: string,
    expectedDev?: number,
    expectedIno?: number,
    expectedSize?: number
  ): Promise<ExecutableAttestation> {
    if (typeof constants.O_NOFOLLOW !== 'number')
      throw hostError('TOOL_UNAVAILABLE', 'GitHub CLI cannot be safely attested.');
    const pathBefore = await lstat(path);
    if (
      !pathBefore.isFile() ||
      pathBefore.isSymbolicLink() ||
      (expectedDev !== undefined &&
        (pathBefore.dev !== expectedDev ||
          pathBefore.ino !== expectedIno ||
          pathBefore.size !== expectedSize))
    )
      throw hostError('TOOL_UNAVAILABLE', 'GitHub CLI changed while being verified.');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (position < before.size) {
        const read = await handle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, before.size - position),
          position
        );
        if (read.bytesRead <= 0)
          throw hostError('TOOL_UNAVAILABLE', 'GitHub CLI changed while being read.');
        hash.update(buffer.subarray(0, read.bytesRead));
        position += read.bytesRead;
      }
      const after = await handle.stat();
      const pathAfter = await lstat(path);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        pathAfter.dev !== before.dev ||
        pathAfter.ino !== before.ino ||
        pathAfter.size !== before.size
      )
        throw hostError('TOOL_UNAVAILABLE', 'GitHub CLI changed while being read.');
      return Object.freeze({
        path,
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        digest: hash.digest('hex')
      });
    } finally {
      await handle.close();
    }
  }
  private async marker(groupId: number): Promise<boolean> {
    try {
      const root = await this.directory(this.executionRoot);
      const path = join(root, 'orphan-' + groupId + '-' + randomUUID() + '.json');
      const record: RecoveryRecord = Object.freeze({
        format: 'selene-github-cli-orphan/v1',
        processGroupId: groupId,
        createdAt: new Date().toISOString()
      });
      const bytes = Buffer.from(JSON.stringify(record), 'utf8');
      if (bytes.byteLength > maximumRecoveryBytes) return false;
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return true;
    } catch {
      return false;
    }
  }
  private async hasPersistedOrphan(): Promise<boolean> {
    const root = await this.directory(this.executionRoot);
    const directory = await opendir(root);
    let examined = 0;
    try {
      while (examined < 128) {
        const entry = await directory.read();
        if (entry === null) return false;
        examined += 1;
        if (entry.name.startsWith('orphan-')) return true;
      }
      return true;
    } finally {
      await directory.close().catch(() => undefined);
    }
  }
  private async operation(spec: OperationSpec, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw hostError('CANCELLED', 'GitHub publishing was cancelled.');
    if (this.recoveryRequired || (await this.hasPersistedOrphan())) {
      this.recoveryRequired = true;
      throw hostError('PROCESS_ORPHANED', 'GitHub command recovery is required.');
    }
    const abortPort =
      signal === undefined
        ? undefined
        : Object.freeze({
            isAborted: () => signal.aborted,
            addAbortListener: (listener: () => void) =>
              signal.addEventListener('abort', listener, { once: true }),
            removeAbortListener: (listener: () => void) =>
              signal.removeEventListener('abort', listener)
          });
    // The supervisor deadline exceeds the private command deadline plus termination proof, so it cannot settle a live process group.
    let envelope: RunnerEnvelope;
    try {
      envelope = await this.supervisor.run<RunnerEnvelope>(this.owner, 'run', [spec], {
        deadlineMs: Date.now() + commandDeadlineMs + orphanWatchdogMs + 5_000,
        ...(abortPort === undefined ? {} : { signal: abortPort })
      });
    } catch (error) {
      if (isHostEffectSupervisorError(error)) {
        if (error.code === 'CALLER_ABORTED')
          throw hostError('CANCELLED', 'GitHub publishing was cancelled.');
        if (error.code === 'DEADLINE_EXCEEDED')
          throw hostError('TIMEOUT', 'GitHub publishing timed out.');
        if (error.code === 'OWNER_QUARANTINED') {
          this.recoveryRequired = true;
          throw hostError('PROCESS_ORPHANED', 'GitHub command recovery is required.');
        }
        if (error.code === 'OWNER_CAPACITY_REACHED' || error.code === 'PROCESS_CAPACITY_REACHED')
          throw hostError('CONFLICT', 'GitHub publishing is already active.');
      }
      throw hostError('PROCESS_FAILED', 'GitHub host effect could not be completed.');
    }
    if (envelope.ok) return envelope.value;
    if (envelope.code === 'NOT_FOUND') throw new GitHubTransportNotFoundError();
    throw hostError(
      envelope.code,
      envelope.code === 'PROCESS_ORPHANED'
        ? 'GitHub command recovery is required.'
        : 'GitHub host operation failed.'
    );
  }
  private async runPrivate(context: HostCallContext, spec: OperationSpec): Promise<unknown> {
    const execution = await this.directory(this.executionRoot);
    const config = await this.existingDirectory(this.userConfigDirectory);
    const executable = await this.executable();
    const reattested = await this.attest(
      executable.path,
      executable.dev,
      executable.ino,
      executable.size
    );
    if (reattested.digest !== executable.digest)
      throw hostError('TOOL_UNAVAILABLE', 'GitHub CLI changed before execution.');
    if (context.cancellation.isCancellationRequested())
      throw hostError('CANCELLED', 'GitHub publishing was cancelled.');
    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const child = spawn(
        reattested.path,
        [
          ...spec.argv,
          '-H',
          'Accept: application/vnd.github+json',
          '-H',
          'X-GitHub-Api-Version: 2026-03-10'
        ],
        {
          shell: false,
          detached: true,
          cwd: execution,
          env: Object.freeze({
            HOME: execution,
            ...(config === undefined ? {} : { GH_CONFIG_DIR: config }),
            GH_HOST: 'github.com',
            GH_PROMPT_DISABLED: '1',
            GH_NO_UPDATE_NOTIFIER: '1',
            GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
            GH_SPINNER_DISABLED: '1',
            GH_BROWSER: 'none',
            DO_NOT_TRACK: '1',
            NO_COLOR: '1',
            LANG: 'C',
            LC_ALL: 'C'
          }),
          stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
        }
      );
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let terminating = false;
      let pending: PublishAdapterError | GitHubTransportNotFoundError | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let poll: ReturnType<typeof setTimeout> | undefined;
      const groupGone = () => {
        if (!child.pid) return true;
        try {
          process.kill(-child.pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ESRCH';
        }
      };
      const clear = () => {
        if (timeout) clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        if (watchdog) clearTimeout(watchdog);
        if (poll) clearTimeout(poll);
        unsubscribe();
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        clear();
        if (pending !== undefined) {
          rejectPromise(pending);
          return;
        }
        try {
          const bytes = Buffer.concat(stdoutChunks, stdoutBytes);
          resolvePromise(JSON.parse(bytes.toString('utf8')));
        } catch {
          rejectPromise(hostError('INTEGRITY', 'GitHub CLI returned invalid JSON.'));
        }
      };
      const probe = () => {
        if (groupGone()) {
          finish();
          return;
        }
        poll = setTimeout(probe, processPollMs);
      };
      const terminate = (error: PublishAdapterError) => {
        if (pending === undefined) pending = error;
        if (terminating) return;
        terminating = true;
        try {
          if (child.pid) process.kill(-child.pid, 'SIGTERM');
        } catch {}
        killTimer = setTimeout(() => {
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
          } catch {}
        }, terminateGraceMs);
        watchdog = setTimeout(() => {
          void (async () => {
            if (!groupGone()) {
              this.recoveryRequired = true;
              await this.marker(child.pid ?? 0);
              pending = hostError('PROCESS_ORPHANED', 'GitHub command recovery is required.');
            }
            finish();
          })();
        }, orphanWatchdogMs);
        probe();
      };
      const cancellation = () =>
        terminate(hostError('CANCELLED', 'GitHub publishing was cancelled.'));
      const unsubscribe = context.cancellation.subscribe(() => cancellation());
      timeout = setTimeout(
        () => terminate(hostError('TIMEOUT', 'GitHub publishing timed out.')),
        commandDeadlineMs
      );
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > spec.responseLimit)
          terminate(hostError('PROCESS_FAILED', 'GitHub response exceeded its operation bound.'));
        else stdoutChunks.push(Buffer.from(chunk));
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > maximumErrorBytes)
          terminate(hostError('PROCESS_FAILED', 'GitHub command diagnostics exceeded its bound.'));
        else stderrChunks.push(Buffer.from(chunk));
      });
      child.once('error', () =>
        terminate(hostError('TOOL_UNAVAILABLE', 'GitHub CLI could not start.'))
      );
      child.once('close', (code) => {
        if (pending === undefined && code !== 0)
          pending = classifiedFailure(code, Buffer.concat(stderrChunks, stderrBytes));
        if (groupGone()) finish();
        else
          terminate(
            pending instanceof PublishAdapterError
              ? pending
              : hostError('PROCESS_FAILED', 'GitHub command retained descendants.')
          );
      });
      if (context.cancellation.isCancellationRequested()) {
        cancellation();
        return;
      }
      if (spec.stdin !== undefined && child.stdin !== null) {
        child.stdin.once('error', (error: NodeJS.ErrnoException) => {
          terminate(
            hostError(
              error.code === 'EPIPE' ? 'PROCESS_FAILED' : 'TOOL_UNAVAILABLE',
              'GitHub CLI input failed.'
            )
          );
        });
        child.stdin.end(spec.stdin);
      }
    });
  }
  private api(
    repositoryName: string,
    method: 'GET' | 'POST' | 'PATCH',
    endpoint: readonly string[],
    body: unknown | undefined,
    requestLimit: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    const repositoryValue = repository(repositoryName);
    const input = body === undefined ? undefined : jsonBody(body, requestLimit);
    const route = [
      'repos',
      ...repositoryValue.split('/').map((part) => safeSegment(part, 'repository')),
      ...endpoint.map((part) => safeSegment(part, 'route'))
    ].join('/');
    return this.operation(
      Object.freeze({
        argv: Object.freeze([
          'api',
          route,
          '--method',
          method,
          ...(input === undefined ? [] : ['--input', '-'])
        ]),
        ...(input === undefined ? {} : { stdin: input }),
        requestLimit,
        responseLimit: maximumResponseBytes
      }),
      signal
    );
  }
  public async setup(signal?: AbortSignal): Promise<GitHubPublishSetupState> {
    try {
      const raw = await this.operation(
        Object.freeze({
          argv: Object.freeze(['api', 'user', '--method', 'GET']),
          requestLimit: 0,
          responseLimit: 64 * 1024
        }),
        signal
      );
      if (!isPlainRecord(raw)) throw hostError('INTEGRITY', 'GitHub account response is invalid.');
      return Object.freeze({
        status: 'available',
        authentication: 'authenticated',
        account: stringField(raw.login, 'login', 100)
      });
    } catch (error) {
      if (error instanceof PublishAdapterError && error.code === 'PROCESS_ORPHANED')
        return Object.freeze({ status: 'recovery-required', reason: 'PROCESS_ORPHANED' });
      if (error instanceof PublishAdapterError && error.code === 'AUTH_REQUIRED')
        return Object.freeze({ status: 'available', authentication: 'required' });
      if (error instanceof PublishAdapterError && error.code === 'TOOL_UNAVAILABLE')
        return Object.freeze({ status: 'unavailable', reason: 'TOOL_UNAVAILABLE' });
      if (error instanceof PublishAdapterError && error.code === 'OFFLINE')
        return Object.freeze({ status: 'offline', reason: 'OFFLINE' });
      throw error;
    }
  }
  public async readRepository(name: string, signal?: AbortSignal): Promise<GitHubRepositoryRecord> {
    const expected = repository(name);
    const result = parseRepository(await this.api(expected, 'GET', [], undefined, 0, signal));
    if (!sameRepository(result.full_name, expected))
      throw hostError('INTEGRITY', 'GitHub repository response did not match its request.');
    return result;
  }
  public async createRepository(
    input: GitHubRepositoryProvisioning,
    signal?: AbortSignal
  ): Promise<GitHubRepositoryRecord> {
    if (
      !isPlainRecord(input) ||
      !isPlainRecord(input.owner) ||
      input.provisioningConsent !== true ||
      (input.owner.kind !== 'current-user' && input.owner.kind !== 'organization') ||
      typeof input.owner.login !== 'string' ||
      typeof input.name !== 'string' ||
      (input.visibility !== 'public' && input.visibility !== 'private') ||
      !repository(input.owner.login + '/' + input.name)
    )
      throw hostError('AUTH_REQUIRED', 'Explicit repository provisioning consent is required.');
    const body = Object.freeze({
      name: input.name,
      private: input.visibility === 'private',
      auto_init: false
    });
    const endpoint =
      input.owner.kind === 'current-user'
        ? ['user', 'repos']
        : ['orgs', safeSegment(input.owner.login, 'organization'), 'repos'];
    const raw = await this.operation(
      Object.freeze({
        argv: Object.freeze(['api', endpoint.join('/'), '--method', 'POST', '--input', '-']),
        stdin: jsonBody(body, maximumMetadataRequestBytes),
        requestLimit: maximumMetadataRequestBytes,
        responseLimit: maximumResponseBytes
      }),
      signal
    );
    const created = parseRepository(raw);
    if (
      !sameRepository(created.full_name, input.owner.login + '/' + input.name) ||
      created.private !== (input.visibility === 'private')
    )
      throw hostError('CONFLICT', 'GitHub created a different repository than consented.');
    return created;
  }
  public async createBlob(
    name: string,
    contentBase64: string,
    signal?: AbortSignal
  ): Promise<{ readonly sha: string }> {
    if (
      typeof contentBase64 !== 'string' ||
      Buffer.byteLength(contentBase64, 'utf8') > maximumBlobRequestBytes
    )
      throw hostError('INTEGRITY', 'GitHub blob content exceeds its bound.');
    const bytes = Buffer.from(contentBase64, 'base64');
    if (bytes.byteLength > maximumSourceFileBytes || bytes.toString('base64') !== contentBase64)
      throw hostError('INTEGRITY', 'GitHub blob request is invalid.');
    const expected = gitBlobSha(bytes);
    const raw = await this.api(
      name,
      'POST',
      ['git', 'blobs'],
      Object.freeze({ content: contentBase64, encoding: 'base64' }),
      maximumBlobRequestBytes,
      signal
    );
    if (!isPlainRecord(raw) || typeof raw.sha !== 'string' || raw.sha !== expected)
      throw hostError('INTEGRITY', 'GitHub blob response did not match its bytes.');
    return Object.freeze({ sha: raw.sha });
  }
  public async createTree(
    name: string,
    body: Readonly<{
      readonly base_tree?: string;
      readonly tree: readonly {
        readonly path: string;
        readonly mode: '100644';
        readonly type: 'blob';
        readonly sha: string;
      }[];
    }>,
    signal?: AbortSignal
  ): Promise<GitHubTreeRecord> {
    if (
      !Array.isArray(body.tree) ||
      body.tree.length === 0 ||
      body.tree.length > 4096 ||
      body.tree.some(
        (entry) =>
          !entry ||
          typeof entry.path !== 'string' ||
          entry.path.length === 0 ||
          entry.path.length > 1024 ||
          entry.mode !== '100644' ||
          entry.type !== 'blob' ||
          !shaPattern.test(entry.sha)
      ) ||
      (body.base_tree !== undefined && !shaPattern.test(body.base_tree))
    )
      throw hostError('INTEGRITY', 'GitHub tree request is invalid.');
    return parseTree(
      await this.api(name, 'POST', ['git', 'trees'], body, maximumMetadataRequestBytes, signal)
    );
  }
  public async createCommit(
    name: string,
    body: Readonly<{
      readonly message: string;
      readonly tree: string;
      readonly parents: readonly string[];
    }>,
    signal?: AbortSignal
  ): Promise<GitHubCommitRecord> {
    if (
      typeof body.message !== 'string' ||
      body.message.length === 0 ||
      body.message.length > 4096 ||
      !shaPattern.test(body.tree) ||
      !Array.isArray(body.parents) ||
      body.parents.length > 1 ||
      body.parents.some((parent) => !shaPattern.test(parent))
    )
      throw hostError('INTEGRITY', 'GitHub commit request is invalid.');
    const commit = parseCommit(
      await this.api(name, 'POST', ['git', 'commits'], body, maximumMetadataRequestBytes, signal)
    );
    if (commit.tree.sha !== body.tree || !hasExactParents(commit, body.parents))
      throw hostError('INTEGRITY', 'GitHub commit response did not match its request.');
    return commit;
  }
  public async readCommit(
    name: string,
    sha: string,
    signal?: AbortSignal
  ): Promise<GitHubCommitRecord> {
    if (!shaPattern.test(sha)) throw hostError('INTEGRITY', 'GitHub commit SHA is invalid.');
    const result = parseCommit(
      await this.api(name, 'GET', ['git', 'commits', sha], undefined, 0, signal)
    );
    if (result.sha !== sha)
      throw hostError('INTEGRITY', 'GitHub commit response did not match its request.');
    return result;
  }
  public async readTree(
    name: string,
    sha: string,
    signal?: AbortSignal
  ): Promise<GitHubTreeRecord> {
    if (!shaPattern.test(sha)) throw hostError('INTEGRITY', 'GitHub tree SHA is invalid.');
    const result = parseTree(
      await this.api(name, 'GET', ['git', 'trees', sha], undefined, 0, signal)
    );
    if (result.sha !== sha)
      throw hostError('INTEGRITY', 'GitHub tree response did not match its request.');
    return result;
  }
  public async readRecursiveTree(
    name: string,
    sha: string,
    signal?: AbortSignal
  ): Promise<GitHubTreeRecord> {
    if (!shaPattern.test(sha)) throw hostError('INTEGRITY', 'GitHub tree SHA is invalid.');
    const route =
      'repos/' +
      repository(name)
        .split('/')
        .map((part) => safeSegment(part, 'repository'))
        .join('/') +
      '/git/trees/' +
      sha +
      '?recursive=1';
    const result = parseTree(
      await this.operation(
        Object.freeze({
          argv: Object.freeze(['api', route, '--method', 'GET']),
          requestLimit: 0,
          responseLimit: maximumResponseBytes
        }),
        signal
      ),
      true
    );
    if (result.sha !== sha)
      throw hostError('INTEGRITY', 'GitHub tree response did not match its request.');
    return result;
  }
  public async readBlob(name: string, sha: string, signal?: AbortSignal): Promise<Buffer> {
    if (!shaPattern.test(sha)) throw hostError('INTEGRITY', 'GitHub blob SHA is invalid.');
    const raw = await this.api(name, 'GET', ['git', 'blobs', sha], undefined, 0, signal);
    if (
      !isPlainRecord(raw) ||
      raw.sha !== sha ||
      raw.encoding !== 'base64' ||
      typeof raw.content !== 'string' ||
      raw.content.length > maximumBlobRequestBytes
    )
      throw hostError('INTEGRITY', 'GitHub blob response is invalid.');
    const encoded = raw.content.replace(/\s/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
      throw hostError('INTEGRITY', 'GitHub blob encoding is invalid.');
    const bytes = Buffer.from(encoded, 'base64');
    if (
      bytes.byteLength > maximumSourceFileBytes ||
      bytes.toString('base64') !== encoded ||
      gitBlobSha(bytes) !== sha
    )
      throw hostError('INTEGRITY', 'GitHub blob response did not match its request.');
    return bytes;
  }
  public async readRef(name: string, ref: string, signal?: AbortSignal): Promise<GitHubRefRecord> {
    if (!validRef(ref) || !ref.startsWith('heads/'))
      throw hostError('INTEGRITY', 'GitHub ref is invalid.');
    const result = parseRef(
      await this.api(name, 'GET', ['git', 'ref', ...ref.split('/')], undefined, 0, signal)
    );
    if (result.ref !== 'refs/' + ref)
      throw hostError('INTEGRITY', 'GitHub ref response did not match its request.');
    return result;
  }
  public async listHeads(name: string, signal?: AbortSignal): Promise<readonly GitHubRefRecord[]> {
    const raw = await this.api(
      name,
      'GET',
      ['git', 'matching-refs', 'heads'],
      undefined,
      0,
      signal
    );
    if (!Array.isArray(raw) || raw.length > 512)
      throw hostError('INTEGRITY', 'GitHub heads response is invalid.');
    const heads = raw.map(parseRef);
    if (
      heads.some((head) => !head.ref.startsWith('refs/heads/')) ||
      new Set(heads.map((head) => head.ref)).size !== heads.length
    )
      throw hostError('INTEGRITY', 'GitHub heads response is invalid.');
    return Object.freeze(heads.sort((left, right) => left.ref.localeCompare(right.ref)));
  }
  public async createRef(
    name: string,
    ref: string,
    sha: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (!shaPattern.test(sha) || !validRef(ref) || !ref.startsWith('heads/'))
      throw hostError('INTEGRITY', 'GitHub ref is invalid.');
    await this.api(
      name,
      'POST',
      ['git', 'refs'],
      Object.freeze({ ref: 'refs/' + ref, sha }),
      maximumMetadataRequestBytes,
      signal
    );
  }
  public async createDraftPullRequest(
    name: string,
    body: Readonly<{
      readonly title: string;
      readonly head: string;
      readonly base: string;
      readonly body: string;
    }>,
    signal?: AbortSignal
  ): Promise<GitHubPullRequestRecord> {
    if (
      typeof body.title !== 'string' ||
      body.title.length === 0 ||
      body.title.length > 256 ||
      typeof body.head !== 'string' ||
      !validRef('heads/' + body.head) ||
      typeof body.base !== 'string' ||
      !validRef('heads/' + body.base) ||
      typeof body.body !== 'string' ||
      body.body.length > 16_384
    )
      throw hostError('INTEGRITY', 'GitHub pull request request is invalid.');
    return parsePullRequest(
      await this.api(
        name,
        'POST',
        ['pulls'],
        Object.freeze({
          title: body.title,
          head: body.head,
          base: body.base,
          body: body.body,
          draft: true
        }),
        maximumMetadataRequestBytes,
        signal
      )
    );
  }
  public async readPullRequest(
    name: string,
    head: string,
    base: string,
    signal?: AbortSignal
  ): Promise<GitHubPullRequestRecord | undefined> {
    const canonical = repository(name);
    if (!validRef('heads/' + head) || !validRef('heads/' + base))
      throw hostError('INTEGRITY', 'GitHub pull request refs are invalid.');
    const owner = canonical.split('/')[0]!;
    const route =
      'repos/' +
      canonical
        .split('/')
        .map((part) => safeSegment(part, 'repository'))
        .join('/') +
      '/pulls?head=' +
      encodeURIComponent(owner + ':' + head) +
      '&base=' +
      encodeURIComponent(base);
    const raw = await this.operation(
      Object.freeze({
        argv: Object.freeze(['api', route, '--method', 'GET']),
        requestLimit: 0,
        responseLimit: maximumResponseBytes
      }),
      signal
    );
    if (!Array.isArray(raw))
      throw hostError('INTEGRITY', 'GitHub pull request response is invalid.');
    if (raw.length === 0) return undefined;
    if (raw.length !== 1)
      throw hostError('CONFLICT', 'Multiple GitHub pull requests match the immutable branch.');
    return parsePullRequest(raw[0]);
  }
}

async function readPlanFile(
  root: string,
  path: string,
  expected?: Buffer,
  maximum = maximumSourceFileBytes
): Promise<Buffer> {
  if (
    typeof constants.O_NOFOLLOW !== 'number' ||
    path.includes('..') ||
    path.startsWith('/') ||
    path.includes('\\')
  )
    throw hostError('INTEGRITY', 'Generated project file path is unsafe.');
  const target = join(root, ...path.split('/'));
  if (!target.startsWith(root + '/'))
    throw hostError('INTEGRITY', 'Generated project file escaped its lease.');
  const before = await lstat(target);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > maximum ||
    (expected !== undefined && before.size !== expected.byteLength)
  )
    throw hostError('INTEGRITY', 'Generated project file is invalid.');
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const bytes = await handle.readFile();
    const after = await lstat(target);
    if (
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      (expected !== undefined && !bytes.equals(expected))
    )
      throw hostError('INTEGRITY', 'Generated project file changed while being read.');
    return bytes;
  } finally {
    await handle.close();
  }
}
function ownershipMarker(
  request: Extract<GeneratedCodePublishRequest, { readonly mode: 'github-remote' }>,
  lockDigest: string,
  artifactDigest: string
): Buffer {
  return Buffer.from(
    JSON.stringify(
      Object.freeze({
        format: 'selene-generated-project-ownership/v1',
        projectId: request.bundle.projectId,
        bundleDigest: request.bundle.bundleDigest,
        filePlanDigest: request.plan.filePlanDigest,
        lockDigest,
        artifactDigest
      })
    ) + '\n',
    'utf8'
  );
}
function parseOwnershipMarker(bytes: Buffer): { readonly projectId: string } {
  if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024)
    throw hostError('CONFLICT', 'GitHub repository ownership marker is invalid.');
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw hostError('CONFLICT', 'GitHub repository ownership marker is invalid.');
  }
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(',') !==
      'artifactDigest,bundleDigest,filePlanDigest,format,lockDigest,projectId' ||
    value.format !== 'selene-generated-project-ownership/v1' ||
    typeof value.projectId !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(value.projectId) ||
    !['artifactDigest', 'bundleDigest', 'filePlanDigest', 'lockDigest'].every(
      (key) => typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key] as string)
    )
  )
    throw hostError('CONFLICT', 'GitHub repository ownership marker is invalid.');
  return Object.freeze({ projectId: value.projectId });
}
function branchFor(
  request: Extract<GeneratedCodePublishRequest, { readonly mode: 'github-remote' }>
): string {
  const project = request.bundle.projectId;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(project))
    throw hostError('INTEGRITY', 'Publish project ID is invalid.');
  return 'selene/publish/' + project + '-' + request.bundle.bundleDigest.slice(0, 16);
}
function publishTitle(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw hostError('INTEGRITY', 'Publish title is invalid.');
  return value;
}
function pullRequestUrlMatches(url: string, canonicalRepository: string): boolean {
  return new RegExp(
    '^https://github\\.com/' + canonicalRepository.replaceAll('.', '\\.') + '/pull/[1-9][0-9]*$'
  ).test(url);
}

/** Remote host adapter. It owns temporary materialization and only sends bytes attested against the immutable plan. */
export class GitHubGeneratedProjectPublishAdapter implements GeneratedCodePublishPort {
  public readonly id = 'github-git-data-publish-v1';
  public readonly mode = 'github-remote' as const;
  public constructor(
    private readonly materializer: GeneratedProjectMaterializationPort,
    private readonly lock: GeneratedProjectLockPort,
    private readonly github: HomebrewGitHubCliTransport
  ) {}
  public async publish(
    request: GeneratedCodePublishRequest,
    options: { readonly signal: AbortSignal; readonly progress: (message: string) => void }
  ): Promise<GeneratedCodePublishReceipt> {
    if (
      request.mode !== 'github-remote' ||
      request.plan.bundle.digest !== request.bundle.bundleDigest ||
      request.plan.filePlanDigest.length !== 64
    )
      throw hostError('CONFLICT', 'Remote publish did not receive the immutable plan.');
    const title = publishTitle(request.title);
    const branch = branchFor(request);
    let lease: GeneratedProjectMaterialization | undefined;
    let quarantine: GeneratedProjectQuarantineRecord | undefined;
    try {
      options.progress('Materializing the immutable generated project plan.');
      lease = await this.materializer.materialize(request.plan, { signal: options.signal });
      let locked: Awaited<ReturnType<GeneratedProjectLockPort['resolve']>>;
      try {
        locked = await this.lock.resolve(lease, request.plan, options);
      } catch (error) {
        if (
          error instanceof GeneratedProjectCommandError &&
          error.code === 'PROCESS_ORPHANED' &&
          error.cleanupScope === 'generated-project-lease' &&
          Number.isSafeInteger(error.processGroupId) &&
          error.processGroupId! > 0
        )
          quarantine = Object.freeze({
            reason: 'PROCESS_ORPHANED',
            processGroupId: error.processGroupId!
          });
        throw error;
      }
      await this.materializer.assertLease(lease);
      if (request.plan.files.length > 512)
        throw hostError('INTEGRITY', 'Immutable publish plan exceeds its remote file bound.');
      const files: { readonly path: string; readonly content: Buffer }[] = [];
      let sourceBytes = 0;
      for (const file of request.plan.files) {
        if (options.signal.aborted)
          throw hostError('CANCELLED', 'GitHub publishing was cancelled.');
        const content = await readPlanFile(
          lease.root,
          file.path,
          Buffer.from(file.content, 'utf8')
        );
        sourceBytes += content.byteLength;
        if (content.byteLength > maximumSourceFileBytes || sourceBytes > 16 * 1024 * 1024)
          throw hostError('INTEGRITY', 'Immutable publish source exceeds its remote bound.');
        files.push(Object.freeze({ path: file.path, content }));
      }
      const lockBytes = await readPlanFile(lease.root, 'bun.lock', undefined, 1024 * 1024);
      if (
        lockBytes.byteLength === 0 ||
        lockBytes.byteLength > 1024 * 1024 ||
        lockBytes.byteLength !== locked.lockBytes
      )
        throw hostError('INTEGRITY', 'Generated Bun lockfile is invalid.');
      const lockDigest = createHash('sha256').update(lockBytes).digest('hex');
      if (lockDigest !== locked.lockDigest)
        throw hostError('INTEGRITY', 'Generated Bun lockfile changed after verification.');
      const marker = ownershipMarker(request, locked.lockDigest, locked.artifactDigest);
      const upload = [
        ...files,
        Object.freeze({ path: 'SELENE_OWNERSHIP.json', content: marker }),
        Object.freeze({ path: 'bun.lock', content: lockBytes })
      ];
      const seen = new Set<string>();
      if (upload.some((file) => seen.has(file.path) || !seen.add(file.path)))
        throw hostError('INTEGRITY', 'Remote publish file paths conflict.');
      let repositoryRecord: GitHubRepositoryRecord;
      let provisioned = false;
      try {
        repositoryRecord = await this.github.readRepository(request.repository, options.signal);
      } catch (error) {
        if (!(error instanceof GitHubTransportNotFoundError) || request.provisioning === undefined)
          throw error;
        const [owner, name] = request.repository.split('/');
        const setup = await this.github.setup(options.signal);
        if (
          setup.status !== 'available' ||
          setup.authentication !== 'authenticated' ||
          name === undefined ||
          request.provisioning.owner.login !== owner ||
          (request.provisioning.owner.kind === 'current-user' &&
            setup.account.toLocaleLowerCase('en-US') !== owner)
        )
          throw hostError(
            'AUTH_REQUIRED',
            'Repository provisioning does not match the authenticated and consent-bound owner.'
          );
        repositoryRecord = await this.github.createRepository(
          Object.freeze({
            owner: request.provisioning.owner,
            name,
            visibility: request.provisioning.visibility,
            provisioningConsent: true
          }),
          options.signal
        );
        if (!sameRepository(repositoryRecord.full_name, request.repository))
          throw hostError('CONFLICT', 'GitHub provisioned a different repository than consented.');
        provisioned = true;
      }
      const repositoryName = repositoryRecord.full_name;
      let baseCommit: GitHubCommitRecord | undefined;
      let initializedBaseline:
        Readonly<{ readonly sha: string; readonly treeSha: string }> | undefined;
      let baseRef: GitHubRefRecord | undefined;
      try {
        baseRef = await this.github.readRef(
          repositoryName,
          'heads/' + repositoryRecord.default_branch,
          options.signal
        );
      } catch (error) {
        if (!(error instanceof GitHubTransportNotFoundError)) throw error;
      }
      if (baseRef === undefined) {
        const heads = await this.github.listHeads(repositoryName, options.signal);
        if (!provisioned || heads.length !== 0)
          throw hostError(
            'CONFLICT',
            'Repository has no verified default branch and cannot be safely published.'
          );
        const baselineMarker = ownershipMarker(request, locked.lockDigest, locked.artifactDigest);
        const baselineBlob = await this.github.createBlob(
          repositoryName,
          baselineMarker.toString('base64'),
          options.signal
        );
        const baselineTree = await this.github.createTree(
          repositoryName,
          Object.freeze({
            tree: [
              Object.freeze({
                path: 'SELENE_OWNERSHIP.json',
                mode: '100644' as const,
                type: 'blob' as const,
                sha: baselineBlob.sha
              })
            ]
          }),
          options.signal
        );
        const baselineCommit = await this.github.createCommit(
          repositoryName,
          Object.freeze({
            message: 'Selene repository baseline ' + request.bundle.immutableId,
            tree: baselineTree.sha,
            parents: Object.freeze([])
          }),
          options.signal
        );
        if (!hasExactParents(baselineCommit, []))
          throw hostError('INTEGRITY', 'GitHub baseline commit did not remain parentless.');
        initializedBaseline = Object.freeze({ sha: baselineCommit.sha, treeSha: baselineTree.sha });
        await this.github.createRef(
          repositoryName,
          'heads/' + repositoryRecord.default_branch,
          baselineCommit.sha,
          options.signal
        );
        baseRef = await this.github.readRef(
          repositoryName,
          'heads/' + repositoryRecord.default_branch,
          options.signal
        );
        if (baseRef.object.sha !== baselineCommit.sha)
          throw hostError('INTEGRITY', 'GitHub default branch initialization did not verify.');
      }
      if (baseRef !== undefined) {
        baseCommit = await this.github.readCommit(
          repositoryName,
          baseRef.object.sha,
          options.signal
        );
        if (
          initializedBaseline !== undefined &&
          (baseCommit.sha !== initializedBaseline.sha ||
            baseCommit.tree.sha !== initializedBaseline.treeSha ||
            !hasExactParents(baseCommit, []))
        )
          throw hostError(
            'INTEGRITY',
            'GitHub baseline commit readback did not match initialization.'
          );
        const baseTree = await this.github.readRecursiveTree(
          repositoryName,
          baseCommit.tree.sha,
          options.signal
        );
        const markerEntry = baseTree.tree.find(
          (entry) =>
            entry.path === 'SELENE_OWNERSHIP.json' &&
            entry.mode === '100644' &&
            entry.type === 'blob' &&
            entry.sha !== undefined
        );
        if (
          markerEntry?.sha === undefined ||
          parseOwnershipMarker(
            await this.github.readBlob(repositoryName, markerEntry.sha, options.signal)
          ).projectId !== request.bundle.projectId
        )
          throw hostError(
            'CONFLICT',
            'A nonempty GitHub repository is not owned by this Selene project.'
          );
      }
      options.progress('Uploading immutable source blobs to the selected GitHub repository.');
      const blobs: { readonly path: string; readonly sha: string }[] = [];
      for (const file of upload) {
        if (options.signal.aborted)
          throw hostError('CANCELLED', 'GitHub publishing was cancelled.');
        blobs.push(
          Object.freeze({
            path: file.path,
            sha: (
              await this.github.createBlob(
                repositoryName,
                file.content.toString('base64'),
                options.signal
              )
            ).sha
          })
        );
      }
      const tree = await this.github.createTree(
        repositoryName,
        Object.freeze({
          tree: blobs.map((blob) =>
            Object.freeze({
              path: blob.path,
              mode: '100644' as const,
              type: 'blob' as const,
              sha: blob.sha
            })
          )
        }),
        options.signal
      );
      if (baseCommit === undefined)
        throw hostError('INTEGRITY', 'GitHub default branch commit is unavailable.');
      const commit = await this.github.createCommit(
        repositoryName,
        Object.freeze({
          message: 'Selene generated project ' + request.bundle.immutableId,
          tree: tree.sha,
          parents: Object.freeze([baseCommit.sha])
        }),
        options.signal
      );
      try {
        await this.github.createRef(repositoryName, branch, commit.sha, options.signal);
      } catch (error) {
        if (!(error instanceof PublishAdapterError) || error.code !== 'CONFLICT') throw error;
        const ref = await this.github.readRef(repositoryName, branch, options.signal);
        if (ref.object.sha !== commit.sha)
          throw hostError('CONFLICT', 'GitHub branch conflicts with immutable publish content.');
      }
      const verifiedRef = await this.github.readRef(repositoryName, branch, options.signal);
      const verifiedCommit = await this.github.readCommit(
        repositoryName,
        verifiedRef.object.sha,
        options.signal
      );
      const verifiedTree = await this.github.readRecursiveTree(
        repositoryName,
        verifiedCommit.tree.sha,
        options.signal
      );
      if (
        verifiedRef.ref !== 'refs/heads/' + branch ||
        verifiedCommit.sha !== commit.sha ||
        verifiedCommit.tree.sha !== tree.sha ||
        !hasExactParents(verifiedCommit, [baseCommit.sha]) ||
        verifiedTree.sha !== tree.sha ||
        verifiedTree.tree.length !== blobs.length ||
        blobs.some(
          (blob) =>
            !verifiedTree.tree.some(
              (entry) =>
                entry.path === blob.path &&
                entry.mode === '100644' &&
                entry.type === 'blob' &&
                entry.sha === blob.sha
            )
        )
      )
        throw hostError(
          'INTEGRITY',
          'GitHub tree does not exactly match the immutable publish files.'
        );
      let pullRequest = await this.github.readPullRequest(
        repositoryName,
        branch,
        repositoryRecord.default_branch,
        options.signal
      );
      const body =
        'Immutable Selene bundle ' +
        request.bundle.bundleDigest +
        '\nFile plan ' +
        request.plan.filePlanDigest +
        '\nLock ' +
        locked.lockDigest +
        '\nArtifact ' +
        locked.artifactDigest;
      if (pullRequest === undefined)
        pullRequest = await this.github.createDraftPullRequest(
          repositoryName,
          Object.freeze({ title, head: branch, base: repositoryRecord.default_branch, body }),
          options.signal
        );
      if (
        pullRequest.title !== title ||
        pullRequest.body !== body ||
        pullRequest.draft !== true ||
        pullRequest.state !== 'open' ||
        pullRequest.head.ref !== branch ||
        pullRequest.head.sha !== commit.sha ||
        pullRequest.base.ref !== repositoryRecord.default_branch ||
        !pullRequestUrlMatches(pullRequest.html_url, repositoryName)
      )
        throw hostError('CONFLICT', 'GitHub pull request does not match the immutable branch.');
      options.progress(
        'Verified the GitHub ref, commit, tree, ownership marker, and draft pull request.'
      );
      return Object.freeze({
        mode: 'github-remote',
        status: 'remote-published',
        repository: repositoryName,
        bundleDigest: request.bundle.bundleDigest,
        filePlanDigest: request.plan.filePlanDigest,
        lockDigest: locked.lockDigest,
        artifactDigest: locked.artifactDigest,
        treeSha: verifiedTree.sha,
        commitSha: verifiedCommit.sha,
        ref: verifiedRef.ref,
        pullRequestUrl: pullRequest.html_url,
        immutableId: request.bundle.immutableId,
        hostedReview: Object.freeze({
          staticReview: Object.freeze({
            status: 'not-generated' as const,
            reason: 'STATIC_REVIEW_NOT_GENERATED' as const
          }),
          collaboration: Object.freeze({
            status: 'pending' as const,
            reason: 'SYNCHRONIZATION_QUEUED' as const
          })
        })
      });
    } finally {
      if (lease !== undefined) {
        if (quarantine !== undefined)
          await this.materializer.quarantine(lease, quarantine).catch(() => {
            throw hostError(
              'CLEANUP_FAILED',
              'Temporary GitHub publish project cleanup requires host recovery.'
            );
          });
        else
          await this.materializer.cleanup(lease.leaseId).catch(() => {
            throw hostError(
              'CLEANUP_FAILED',
              'Temporary GitHub publish project cleanup requires host recovery.'
            );
          });
      }
    }
  }
}
