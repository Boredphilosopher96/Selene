import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { PublishAdapterError } from './designer-host-ports';

const maximumStdoutBytes = 256 * 1024;
const maximumStderrBytes = 64 * 1024;
const maximumRequestBytes = 256 * 1024;
const fixedHomebrewPrefixes = Object.freeze(['/opt/homebrew', '/usr/local']);

export interface GitHubPublishSetupState {
  readonly status: 'available' | 'unavailable';
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly account?: string;
  readonly repository?: string;
}
export type GitHubPublishOperation =
  | { readonly kind: 'repository-read'; readonly repository: string }
  | { readonly kind: 'repository-create'; readonly repository: string; readonly body: Readonly<Record<string, unknown>> }
  | { readonly kind: 'blob-create' | 'tree-create' | 'commit-create' | 'ref-create' | 'pull-request-create'; readonly repository: string; readonly body: Readonly<Record<string, unknown>> }
  | { readonly kind: 'ref-read'; readonly repository: string; readonly ref: string }
  | { readonly kind: 'tree-read'; readonly repository: string; readonly sha: string }
  | { readonly kind: 'commit-read'; readonly repository: string; readonly sha: string }
  | { readonly kind: 'pull-request-read'; readonly repository: string; readonly head: string; readonly base: string };

/** Host-only, fixed-operation transport. Renderer code can neither select argv/endpoints nor supply environment/token values. */
export class HomebrewGitHubCliTransport {
  public constructor(private readonly homeDirectory: string, private readonly configDirectory: string) {
    if (!isAbsolute(homeDirectory) || !isAbsolute(configDirectory)) throw new Error('GitHub host paths must be absolute.');
  }
  private async executable(): Promise<string> {
    for (const prefix of fixedHomebrewPrefixes) {
      const configured = resolve(prefix, 'bin', 'gh');
      try {
        const configuredStat = await lstat(configured);
        if (!configuredStat.isFile() && !configuredStat.isSymbolicLink()) continue;
        const actual = await realpath(configured);
        const configuredAfter = await lstat(configured);
        const contained = relative(prefix, actual);
        const stat = await lstat(actual);
        if (configuredAfter.dev !== configuredStat.dev || configuredAfter.ino !== configuredStat.ino || !/^Cellar\/gh\/[0-9][A-Za-z0-9._-]*\/bin\/gh$/.test(contained) || stat.isFile() === false || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) continue;
        return actual;
      } catch { /* Only the second fixed Homebrew candidate may be tried. */ }
    }
    throw new PublishAdapterError('TOOL_UNAVAILABLE', 'GitHub CLI is unavailable in trusted Homebrew locations.');
  }
  private async attest(path: string): Promise<void> {
    if (typeof constants.O_NOFOLLOW !== 'number') throw new PublishAdapterError('TOOL_UNAVAILABLE', 'GitHub CLI cannot be safely attested on this platform.');
    const pathStat = await lstat(path);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size <= 0 || pathStat.size > 512 * 1024 * 1024) throw new PublishAdapterError('TOOL_UNAVAILABLE', 'GitHub CLI is unsafe.');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat(); const hash = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024);
      for (let offset = 0; offset < before.size; offset += buffer.byteLength) {
        const result = await handle.read(buffer, 0, Math.min(buffer.byteLength, before.size - offset), offset);
        if (result.bytesRead === 0) throw new PublishAdapterError('TOOL_UNAVAILABLE', 'GitHub CLI changed while being read.');
        hash.update(buffer.subarray(0, result.bytesRead));
      }
      const after = await handle.stat(); const afterPath = await lstat(path);
      if (after.size !== before.size || afterPath.dev !== before.dev || afterPath.ino !== before.ino || !/^[a-f0-9]{64}$/.test(hash.digest('hex')))
        throw new PublishAdapterError('TOOL_UNAVAILABLE', 'GitHub CLI changed while being read.');
    } finally { await handle.close(); }
  }
  /** Typed inert fields select the complete fixed argv/method/route/stdin schema. */
  public async fixedJson(operation: GitHubPublishOperation, signal: AbortSignal): Promise<unknown> {
    const repository = operation.repository;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) throw new PublishAdapterError('CONFLICT', 'GitHub repository is not canonical.');
    const body = 'body' in operation ? operation.body : undefined;
    const input = body === undefined ? undefined : JSON.stringify(body);
    if (input !== undefined && Buffer.byteLength(input) > maximumRequestBytes) throw new PublishAdapterError('INTEGRITY', 'GitHub publish input exceeds its bound.');
    if (signal.aborted) throw new PublishAdapterError('CANCELLED', 'GitHub publish was cancelled.');
    const executable = await this.executable(); await this.attest(executable);
    const endpoint = operation.kind === 'repository-read' ? 'repos/' + repository
      : operation.kind === 'repository-create' ? 'user/repos'
      : operation.kind === 'pull-request-create' ? 'repos/' + repository + '/pulls'
      : operation.kind === 'pull-request-read' ? 'repos/' + repository + '/pulls?head=' + encodeURIComponent(operation.head) + '&base=' + encodeURIComponent(operation.base)
      : operation.kind === 'ref-read' ? 'repos/' + repository + '/git/ref/' + encodeURIComponent(operation.ref)
      : operation.kind === 'tree-read' ? 'repos/' + repository + '/git/trees/' + operation.sha
      : operation.kind === 'commit-read' ? 'repos/' + repository + '/git/commits/' + operation.sha
      : 'repos/' + repository + '/git/' + (operation.kind === 'blob-create' ? 'blobs' : operation.kind === 'tree-create' ? 'trees' : operation.kind === 'commit-create' ? 'commits' : 'refs');
    const argv = body === undefined ? ['api', endpoint, '--method', 'GET'] : ['api', endpoint, '--method', 'POST', '--input', '-'];
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(executable, argv, { shell: false, detached: process.platform === 'darwin', cwd: this.configDirectory, env: Object.freeze({ HOME: this.homeDirectory, GH_CONFIG_DIR: this.configDirectory, GH_HOST: 'github.com', LANG: 'C', LC_ALL: 'C', NO_COLOR: '1' }), stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stdoutBytes = 0; let stderrBytes = 0; let settled = false; let terminating = false; let closed = false; let pending: PublishAdapterError | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined; let escalation: ReturnType<typeof setTimeout> | undefined; let watchdog: ReturnType<typeof setTimeout> | undefined; let poll: ReturnType<typeof setTimeout> | undefined;
      const groupExists = () => { try { if (!child.pid) return false; process.kill(-child.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
      const settle = (error?: Error) => { if (settled) return; settled = true; if (timeout) clearTimeout(timeout); if (escalation) clearTimeout(escalation); if (watchdog) clearTimeout(watchdog); if (poll) clearTimeout(poll); signal.removeEventListener('abort', abort); if (error) { rejectPromise(error); return; } try { resolvePromise(JSON.parse(stdout)); } catch { rejectPromise(new PublishAdapterError('INTEGRITY', 'GitHub publish returned invalid JSON.')); } };
      const terminate = () => { try { if (process.platform === 'darwin' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch {} };
      const finishAfterGroup = () => { if (pending) settle(pending); else if (closed) settle(); };
      const probe = () => { if (!groupExists()) { finishAfterGroup(); return; } poll = setTimeout(probe, 100); };
      const beginTermination = (error: PublishAdapterError) => { if (pending === undefined) pending = error; if (terminating) return; terminating = true; terminate(); escalation = setTimeout(() => { try { if (process.platform === 'darwin' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} }, 5_000); watchdog = setTimeout(() => { if (groupExists()) settle(new PublishAdapterError('PROCESS_ORPHANED', 'GitHub command recovery is required.')); else finishAfterGroup(); }, 10_000); probe(); };
      const abort = () => beginTermination(new PublishAdapterError('CANCELLED', 'GitHub publish was cancelled.'));
      timeout = setTimeout(() => beginTermination(new PublishAdapterError('TIMEOUT', 'GitHub publish timed out.')), 90_000);
      child.stdout.on('data', (chunk: Buffer) => { stdoutBytes += chunk.byteLength; if (stdoutBytes > maximumStdoutBytes) beginTermination(new PublishAdapterError('PROCESS_FAILED', 'GitHub publish stdout exceeded its bound.')); else stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.byteLength; if (stderrBytes > maximumStderrBytes) beginTermination(new PublishAdapterError('PROCESS_FAILED', 'GitHub publish stderr exceeded its bound.')); });
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      child.once('error', () => { if (child.pid) beginTermination(new PublishAdapterError('TOOL_UNAVAILABLE', 'GitHub CLI could not start.')); else settle(new PublishAdapterError('TOOL_UNAVAILABLE', 'GitHub CLI could not start.')); });
      child.once('close', (code) => { closed = true; if (pending === undefined && code !== 0) pending = new PublishAdapterError('PROCESS_FAILED', 'GitHub publish command failed.'); if (groupExists()) { if (!terminating) beginTermination(new PublishAdapterError('PROCESS_FAILED', 'GitHub command retained descendants.')); else probe(); } else finishAfterGroup(); });
      if (input !== undefined) child.stdin.end(input, 'utf8');
    });
  }
}
