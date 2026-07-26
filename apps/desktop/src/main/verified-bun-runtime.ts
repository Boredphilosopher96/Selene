import {
  spawn,
  type ChildProcessByStdio,
  type SpawnOptionsWithStdioTuple,
  type StdioNull,
  type StdioPipe
} from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';

import type { BunExecutableAttestation, VerifiedBunRuntimePort } from './generated-project-lock';
import { VerifiedBunRuntimeError } from './bun-runtime-error';
import {
  pinBunRuntimeDirectory,
  type BunRuntimeResourceLocation,
  type BunRuntimeResourceLocatorPort,
  type PinnedBunRuntimeDirectory
} from './bun-runtime-location';

export { VerifiedBunRuntimeError } from './bun-runtime-error';

const maximumArchiveBytes = 128 * 1024 * 1024;
const maximumBinaryBytes = 512 * 1024 * 1024;
const maximumProvenanceBytes = 16 * 1024;
const maximumToolOutputBytes = 64 * 1024;
const extractionTimeoutMs = 30_000;
const terminationGraceMs = 5_000;
const processGroupSettleMs = 5_000;
const processGroupPollMs = 100;
const maximumRecoveryEntries = 1_024;
const maximumRecoveryItems = 128;

type RuntimeArch = 'arm64' | 'x64';
interface PackagedBunArchive {
  readonly fileName: string;
  readonly releaseUrl: string;
  readonly archiveSha256: string;
  readonly binarySha256: string;
  readonly binaryPath: string;
}

// This compiled authority is compared field-for-field with the copied data
// resource. A mutable resource JSON can therefore never select a new URL,
// archive, layout, or digest at runtime.
const officialBunArchives: Readonly<Record<RuntimeArch, PackagedBunArchive>> = Object.freeze({
  arm64: Object.freeze({
    fileName: 'bun-darwin-aarch64.zip',
    releaseUrl:
      'https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-darwin-aarch64.zip',
    archiveSha256: 'd8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620',
    binarySha256: 'e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233',
    binaryPath: 'bun-darwin-aarch64/bun'
  }),
  x64: Object.freeze({
    fileName: 'bun-darwin-x64.zip',
    releaseUrl: 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-darwin-x64.zip',
    archiveSha256: '4183df3374623e5bab315c547cfa0974533cd457d86b73b639f7a87974cd6633',
    binarySha256: 'ea2f223e94bb2f4bf3050895113c3cf346438f6fa0501c8532284e063f72f7a0',
    binaryPath: 'bun-darwin-x64/bun'
  })
});

export interface BunUnzipSpawnOptions extends SpawnOptionsWithStdioTuple<
  StdioNull,
  StdioPipe,
  StdioPipe
> {
  readonly cwd: string;
  readonly shell: false;
  readonly detached: true;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: ['ignore', 'pipe', 'pipe'];
}

export type BunUnzipChild = ChildProcessByStdio<null, Readable, Readable>;

export interface BunRuntimeSystemPort {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  fixedUnzip(): Promise<string>;
  spawnUnzip(
    executable: string,
    argumentsList: readonly string[],
    options: BunUnzipSpawnOptions
  ): BunUnzipChild;
}

export interface RuntimeStageRecoveryInventory {
  readonly items: readonly RuntimeStageRecoveryItem[];
  readonly examined: number;
  readonly truncated: boolean;
}
export type RuntimeStageRecoveryItem =
  | Readonly<{
      stageId: string;
      cleanupScope: 'runtime-stage';
      state: 'marked';
      processGroupId: number;
      createdAt: string;
      groupObservation: 'unknown';
    }>
  | Readonly<{
      stageId: string;
      cleanupScope: 'runtime-stage';
      state: 'unmarked-or-malformed';
    }>;

function runtimeArch(value: string): RuntimeArch | undefined {
  return value === 'arm64' || value === 'x64' ? value : undefined;
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

async function hashRegularFile(path: string, maximumBytes: number): Promise<string> {
  if (typeof constants.O_NOFOLLOW !== 'number')
    throw new VerifiedBunRuntimeError(
      'TOOL_UNAVAILABLE',
      'This platform cannot safely inspect the packaged Bun archive.'
    );
  const beforePath = await lstat(path);
  if (
    !beforePath.isFile() ||
    beforePath.isSymbolicLink() ||
    beforePath.size <= 0 ||
    beforePath.size > maximumBytes
  )
    throw new VerifiedBunRuntimeError(
      'TOOL_UNAVAILABLE',
      'The packaged Bun data resource is unsafe.'
    );
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== beforePath.size)
      throw new VerifiedBunRuntimeError(
        'TOOL_UNAVAILABLE',
        'The packaged Bun data resource changed while being verified.'
      );
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    for (let position = 0; position < before.size; position += buffer.byteLength) {
      // oxlint-disable-next-line no-await-in-loop -- A no-follow descriptor is hashed in ordered bounded reads for TOCTOU attestation.
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - position),
        position
      );
      if (bytesRead === 0)
        throw new VerifiedBunRuntimeError(
          'TOOL_UNAVAILABLE',
          'The packaged Bun data resource changed while being verified.'
        );
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const afterPath = await lstat(path);
    if (after.size !== before.size || afterPath.dev !== before.dev || afterPath.ino !== before.ino)
      throw new VerifiedBunRuntimeError(
        'TOOL_UNAVAILABLE',
        'The packaged Bun data resource changed while being verified.'
      );
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function readBoundedRegularFile(path: string, maximumBytes: number): Promise<Buffer> {
  if (typeof constants.O_NOFOLLOW !== 'number')
    throw new VerifiedBunRuntimeError(
      'TOOL_UNAVAILABLE',
      'This platform cannot safely inspect packaged Bun provenance.'
    );
  const pathBefore = await lstat(path);
  if (
    !pathBefore.isFile() ||
    pathBefore.isSymbolicLink() ||
    pathBefore.size <= 0 ||
    pathBefore.size > maximumBytes
  )
    throw new VerifiedBunRuntimeError(
      'TOOL_UNAVAILABLE',
      'Packaged Bun provenance is unavailable.'
    );
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== pathBefore.size || before.size > maximumBytes)
      throw new VerifiedBunRuntimeError(
        'TOOL_UNAVAILABLE',
        'Packaged Bun provenance changed while being verified.'
      );
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.byteLength) {
      // oxlint-disable-next-line no-await-in-loop -- Provenance bytes must be read sequentially from the same attested descriptor.
      const { bytesRead } = await handle.read(data, offset, data.byteLength - offset, offset);
      if (bytesRead === 0)
        throw new VerifiedBunRuntimeError(
          'TOOL_UNAVAILABLE',
          'Packaged Bun provenance changed while being verified.'
        );
      offset += bytesRead;
    }
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (after.size !== before.size || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino)
      throw new VerifiedBunRuntimeError(
        'TOOL_UNAVAILABLE',
        'Packaged Bun provenance changed while being verified.'
      );
    return data;
  } finally {
    await handle.close();
  }
}

async function attestedFixedMacTool(path: '/usr/bin/unzip'): Promise<string> {
  const configured = await lstat(path);
  if (!configured.isFile() || configured.isSymbolicLink() || (configured.mode & 0o111) === 0)
    throw new VerifiedBunRuntimeError(
      'TOOL_UNAVAILABLE',
      'The fixed macOS archive tool is unavailable.'
    );
  const actual = await realpath(path);
  const after = await lstat(path);
  const target = await lstat(actual);
  if (
    actual !== path ||
    after.dev !== configured.dev ||
    after.ino !== configured.ino ||
    !target.isFile() ||
    target.isSymbolicLink() ||
    (target.mode & 0o111) === 0
  )
    throw new VerifiedBunRuntimeError(
      'TOOL_UNAVAILABLE',
      'The fixed macOS archive tool is unsafe.'
    );
  return actual;
}

function expectedEntries(provenance: PackagedBunArchive): readonly string[] {
  const directory = provenance.binaryPath.slice(0, provenance.binaryPath.indexOf('/'));
  return Object.freeze([`${directory}/`, provenance.binaryPath]);
}

const nodeBunRuntimeSystem: BunRuntimeSystemPort = Object.freeze({
  platform: process.platform,
  arch: process.arch,
  fixedUnzip: () => attestedFixedMacTool('/usr/bin/unzip'),
  spawnUnzip: (
    executable: string,
    argumentsList: readonly string[],
    options: BunUnzipSpawnOptions
  ): BunUnzipChild =>
    // The fixed tuple guarantees null stdin and piped output. Bun's Node types
    // expose a non-generic overload here, so assert only at this native boundary.
    spawn(executable, [...argumentsList], options) as BunUnzipChild
});

/** Fixed-command process seam shared by production extraction and behavioral host tests. */
export class FixedMacUnzipProcessRunner {
  public constructor(private readonly system: BunRuntimeSystemPort = nodeBunRuntimeSystem) {}

  public async run(
    argumentsList: readonly string[],
    cwd: string,
    signal: AbortSignal
  ): Promise<string> {
    if (signal.aborted)
      throw new VerifiedBunRuntimeError('CANCELLED', 'Packaged Bun extraction was cancelled.');
    const executable = await this.system.fixedUnzip();
    if (signal.aborted)
      throw new VerifiedBunRuntimeError('CANCELLED', 'Packaged Bun extraction was cancelled.');
    return new Promise<string>((resolvePromise, rejectPromise) => {
      if (signal.aborted) {
        rejectPromise(
          new VerifiedBunRuntimeError('CANCELLED', 'Packaged Bun extraction was cancelled.')
        );
        return;
      }
      const environment: NodeJS.ProcessEnv = {};
      Object.setPrototypeOf(environment, null);
      const child = this.system.spawnUnzip(executable, argumentsList, {
        cwd,
        shell: false,
        detached: true,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let output = '';
      let outputBytes = 0;
      let settled = false;
      let terminating = false;
      let childClosed = false;
      let pending: VerifiedBunRuntimeError | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let groupPoll: ReturnType<typeof setTimeout> | undefined;
      let abort: () => void = () => undefined;
      const groupExists = (): boolean => {
        if (child.pid === undefined || child.pid <= 0) return false;
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (escalation) clearTimeout(escalation);
        if (watchdog) clearTimeout(watchdog);
        if (groupPoll) clearTimeout(groupPoll);
        signal.removeEventListener('abort', abort);
        if (error) rejectPromise(error);
        else resolvePromise(output);
      };
      const finishAfterGroup = () => {
        if (pending !== undefined) {
          finish(pending);
          return;
        }
        if (childClosed) finish();
      };
      const probeGroup = () => {
        if (settled) return;
        if (!groupExists()) {
          finishAfterGroup();
          return;
        }
        groupPoll = setTimeout(() => {
          groupPoll = undefined;
          probeGroup();
        }, processGroupPollMs);
      };
      const signalGroup = (kind: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, kind);
        } catch {
          /* ESRCH is handled by probe. */
        }
      };
      const terminate = (error: VerifiedBunRuntimeError) => {
        if (pending === undefined) pending = error;
        if (terminating) return;
        terminating = true;
        signalGroup('SIGTERM');
        escalation = setTimeout(() => signalGroup('SIGKILL'), terminationGraceMs);
        watchdog = setTimeout(() => {
          if (groupExists()) {
            finish(
              new VerifiedBunRuntimeError(
                'PROCESS_ORPHANED',
                'Packaged Bun extraction process-group termination could not be confirmed.',
                child.pid
              )
            );
            return;
          }
          finishAfterGroup();
        }, terminationGraceMs + processGroupSettleMs);
        probeGroup();
      };
      abort = () =>
        terminate(
          new VerifiedBunRuntimeError('CANCELLED', 'Packaged Bun extraction was cancelled.')
        );
      signal.addEventListener('abort', abort, { once: true });
      timeout = setTimeout(
        () =>
          terminate(new VerifiedBunRuntimeError('TIMEOUT', 'Packaged Bun extraction timed out.')),
        extractionTimeoutMs
      );
      const collect = (stream: NodeJS.ReadableStream) =>
        stream.on('data', (chunk: Buffer) => {
          outputBytes += chunk.byteLength;
          if (outputBytes > maximumToolOutputBytes) {
            terminate(
              new VerifiedBunRuntimeError(
                'TOOL_UNAVAILABLE',
                'Packaged Bun extraction output exceeded its bound.'
              )
            );
            return;
          }
          output += chunk.toString('utf8');
        });
      collect(child.stdout);
      collect(child.stderr);
      child.once('error', () => {
        if (!terminating && child.pid !== undefined && child.pid > 0)
          terminate(
            new VerifiedBunRuntimeError(
              'TOOL_UNAVAILABLE',
              'The fixed macOS archive tool could not start.'
            )
          );
        else if (!terminating)
          finish(
            new VerifiedBunRuntimeError(
              'TOOL_UNAVAILABLE',
              'The fixed macOS archive tool could not start.'
            )
          );
      });
      child.once('close', (code, processSignal) => {
        childClosed = true;
        if (pending === undefined && (code !== 0 || processSignal !== null))
          pending = new VerifiedBunRuntimeError(
            'PROCESS_FAILED',
            'Packaged Bun extraction failed.'
          );
        if (groupExists()) {
          if (!terminating)
            terminate(
              new VerifiedBunRuntimeError(
                'PROCESS_FAILED',
                'Packaged Bun extraction retained unexpected descendants.'
              )
            );
          probeGroup();
          return;
        }
        finishAfterGroup();
      });
      if (signal.aborted) abort();
    });
  }
}

/** Resolves only a copied Bun ZIP data resource and atomically installs its verified binary under app user data. */
export class PackagedMacBunRuntimeProvider implements VerifiedBunRuntimePort {
  private readonly unzip: FixedMacUnzipProcessRunner;

  public constructor(
    private readonly resourceLocator: BunRuntimeResourceLocatorPort,
    private readonly appUserDataRoot: string,
    private readonly system: BunRuntimeSystemPort = nodeBunRuntimeSystem
  ) {
    if (!isAbsolute(appUserDataRoot))
      throw new Error('Packaged Bun runtime paths must be absolute.');
    this.unzip = new FixedMacUnzipProcessRunner(system);
  }

  private resourceFailure(location: BunRuntimeResourceLocation): VerifiedBunRuntimeError {
    return new VerifiedBunRuntimeError(
      location.kind === 'development' ? 'SETUP_REQUIRED' : 'TOOL_UNAVAILABLE',
      location.kind === 'development'
        ? 'Verified Bun development setup is required. Restart Selene and retry.'
        : 'Packaged Bun resources are unavailable or unsafe.'
    );
  }

  private async assertResourcePinned(
    location: BunRuntimeResourceLocation,
    expectedArch: PinnedBunRuntimeDirectory
  ): Promise<void> {
    await this.resourceLocator.assertPinned(location);
    const actualArch = await pinBunRuntimeDirectory(expectedArch.path, location.kind);
    if (actualArch.device !== expectedArch.device || actualArch.inode !== expectedArch.inode)
      throw this.resourceFailure(location);
  }

  private async assertArchivePinned(
    location: BunRuntimeResourceLocation,
    expectedArch: PinnedBunRuntimeDirectory,
    archive: string,
    expectedSha256: string
  ): Promise<void> {
    await this.assertResourcePinned(location, expectedArch);
    if ((await hashRegularFile(archive, maximumArchiveBytes)) !== expectedSha256)
      throw this.resourceFailure(location);
    await this.assertResourcePinned(location, expectedArch);
  }

  private selected(): readonly [RuntimeArch, PackagedBunArchive] {
    if (this.system.platform !== 'darwin')
      throw new VerifiedBunRuntimeError(
        'TOOL_UNAVAILABLE',
        'Verified packaged Bun is available only on macOS.'
      );
    const arch = runtimeArch(this.system.arch);
    if (arch === undefined)
      throw new VerifiedBunRuntimeError(
        'TOOL_UNAVAILABLE',
        'No verified packaged Bun exists for this CPU architecture.'
      );
    return [arch, officialBunArchives[arch]] as const;
  }

  private async copiedProvenance(
    location: BunRuntimeResourceLocation,
    arch: RuntimeArch,
    expected: PackagedBunArchive
  ): Promise<void> {
    const path = join(location.resourceRoot, 'bun', 'provenance.json');
    let parsed: unknown;
    try {
      await this.resourceLocator.assertPinned(location);
      parsed = JSON.parse(
        (await readBoundedRegularFile(path, maximumProvenanceBytes)).toString('utf8')
      );
      await this.resourceLocator.assertPinned(location);
    } catch (error) {
      if (error instanceof VerifiedBunRuntimeError && error.code !== 'TOOL_UNAVAILABLE')
        throw error;
      throw this.resourceFailure(location);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw this.resourceFailure(location);
    const record = parsed as Record<string, unknown>;
    const archives = record.archives;
    if (
      Object.keys(record).sort().join(',') !== 'archives,bunVersion,format' ||
      record.format !== 'selene-packaged-bun-runtime/v1' ||
      record.bunVersion !== '1.3.14' ||
      !archives ||
      typeof archives !== 'object' ||
      Array.isArray(archives) ||
      Object.keys(archives).sort().join(',') !== 'arm64,x64'
    )
      throw this.resourceFailure(location);
    for (const key of ['arm64', 'x64'] as const) {
      const candidate = (archives as Record<string, unknown>)[key];
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate) ||
        Object.keys(candidate).sort().join(',') !==
          'archiveSha256,binaryPath,binarySha256,fileName,releaseUrl'
      )
        throw this.resourceFailure(location);
      const source = candidate as Record<string, unknown>;
      for (const [field, value] of Object.entries(officialBunArchives[key]))
        if (source[field] !== value) throw this.resourceFailure(location);
    }
    if (expected !== officialBunArchives[arch]) throw this.resourceFailure(location);
  }

  private async runtimeRoot(arch: RuntimeArch): Promise<string> {
    await mkdir(this.appUserDataRoot, { recursive: true, mode: 0o700 });
    const configuredStat = await lstat(this.appUserDataRoot);
    const root = await realpath(this.appUserDataRoot);
    const configuredAfter = await lstat(this.appUserDataRoot);
    const rootStat = await lstat(root);
    if (
      !configuredStat.isDirectory() ||
      configuredStat.isSymbolicLink() ||
      root !== this.appUserDataRoot ||
      configuredAfter.isSymbolicLink() ||
      configuredAfter.dev !== configuredStat.dev ||
      configuredAfter.ino !== configuredStat.ino ||
      rootStat.dev !== configuredStat.dev ||
      rootStat.ino !== configuredStat.ino
    )
      throw new VerifiedBunRuntimeError(
        'TOOL_UNAVAILABLE',
        'Packaged Bun installation root is unsafe.'
      );
    const child = async (parent: string, name: string): Promise<string> => {
      const candidate = resolve(parent, name);
      if (!contained(parent, candidate))
        throw new VerifiedBunRuntimeError(
          'TOOL_UNAVAILABLE',
          'Packaged Bun installation path is unsafe.'
        );
      await mkdir(candidate, { recursive: false, mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        }
      );
      const stat = await lstat(candidate);
      const actual = await realpath(candidate);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        actual !== candidate ||
        !contained(parent, actual)
      )
        throw new VerifiedBunRuntimeError(
          'TOOL_UNAVAILABLE',
          'Packaged Bun installation path is unsafe.'
        );
      return actual;
    };
    const namespace = await child(root, 'generated-project-bun-runtime-v1');
    return child(namespace, arch);
  }

  private async createStage(root: string): Promise<string> {
    const stage = resolve(root, `.stage-${randomUUID()}`);
    if (!contained(root, stage))
      throw new VerifiedBunRuntimeError('TOOL_UNAVAILABLE', 'Packaged Bun staging path is unsafe.');
    try {
      await mkdir(stage, { recursive: false, mode: 0o700 });
    } catch {
      throw new VerifiedBunRuntimeError(
        'TOOL_UNAVAILABLE',
        'Packaged Bun staging directory is unavailable.'
      );
    }
    try {
      const stat = await lstat(stage);
      const actual = await realpath(stage);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        actual !== stage ||
        !contained(root, actual)
      )
        throw new VerifiedBunRuntimeError(
          'TOOL_UNAVAILABLE',
          'Packaged Bun staging directory is unsafe.'
        );
      return actual;
    } catch (error) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof VerifiedBunRuntimeError) throw error;
      throw new VerifiedBunRuntimeError(
        'TOOL_UNAVAILABLE',
        'Packaged Bun staging directory is unavailable.'
      );
    }
  }

  private async recordRuntimeStageOrphan(
    stage: string,
    error: VerifiedBunRuntimeError
  ): Promise<void> {
    const marker = join(stage, '.selene-runtime-stage-orphan.json');
    if (typeof constants.O_NOFOLLOW !== 'number')
      throw new VerifiedBunRuntimeError(
        'PROCESS_ORPHANED',
        'Packaged Bun extraction requires runtime-stage recovery.',
        error.processGroupId
      );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        marker,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      await handle.writeFile(
        JSON.stringify({
          format: 'selene-runtime-stage-orphan/v1',
          cleanupScope: 'runtime-stage',
          processGroupId: error.processGroupId,
          createdAt: new Date().toISOString()
        }),
        'utf8'
      );
      await handle.sync();
    } catch {
      throw new VerifiedBunRuntimeError(
        'PROCESS_ORPHANED',
        'Packaged Bun extraction requires runtime-stage recovery.',
        error.processGroupId
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async runUnzip(
    argumentsList: readonly string[],
    cwd: string,
    signal: AbortSignal
  ): Promise<string> {
    return this.unzip.run(argumentsList, cwd, signal);
  }

  private async verifyInstalled(path: string, expected: PackagedBunArchive): Promise<void> {
    const hash = await hashRegularFile(path, maximumBinaryBytes);
    const stat = await lstat(path);
    if ((stat.mode & 0o111) === 0 || hash !== expected.binarySha256)
      throw new VerifiedBunRuntimeError(
        'TOOL_UNAVAILABLE',
        'Installed Bun does not match packaged provenance.'
      );
  }

  private async verifyInstallation(root: string, expected: PackagedBunArchive): Promise<string> {
    const installation = resolve(root, expected.binarySha256);
    if (!contained(root, installation))
      throw new VerifiedBunRuntimeError(
        'TOOL_UNAVAILABLE',
        'Packaged Bun installation path is unsafe.'
      );
    const stat = await lstat(installation);
    const actual = await realpath(installation);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      actual !== installation ||
      !contained(root, actual)
    )
      throw new VerifiedBunRuntimeError(
        'TOOL_UNAVAILABLE',
        'Packaged Bun installation path is unsafe.'
      );
    const binary = join(actual, 'bun');
    await this.verifyInstalled(binary, expected);
    return binary;
  }

  /** Bounded observation only. Recovery never signals or deletes an orphan stage. */
  public async recoveryInventory(): Promise<RuntimeStageRecoveryInventory> {
    if (this.system.platform !== 'darwin' || runtimeArch(this.system.arch) === undefined)
      return Object.freeze({ items: Object.freeze([]), examined: 0, truncated: false });
    const activeArch = runtimeArch(this.system.arch);
    if (activeArch === undefined)
      return Object.freeze({ items: Object.freeze([]), examined: 0, truncated: false });
    const root = await this.runtimeRoot(activeArch);
    const directory = await opendir(root);
    const items: RuntimeStageRecoveryItem[] = [];
    let examined = 0;
    let truncated = false;
    try {
      for await (const entry of directory) {
        if (examined >= maximumRecoveryEntries || items.length >= maximumRecoveryItems) {
          truncated = true;
          break;
        }
        examined += 1;
        if (!/^\.stage-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(entry.name)) continue;
        const stage = resolve(root, entry.name);
        try {
          if (!entry.isDirectory() || entry.isSymbolicLink())
            throw new Error('runtime stage is malformed');
          const stat = await lstat(stage);
          const actual = await realpath(stage);
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            actual !== stage ||
            !contained(root, actual)
          )
            throw new Error('runtime stage is unsafe');
          const marker = JSON.parse(
            (
              await readBoundedRegularFile(
                join(actual, '.selene-runtime-stage-orphan.json'),
                maximumProvenanceBytes
              )
            ).toString('utf8')
          ) as unknown;
          if (!marker || typeof marker !== 'object' || Array.isArray(marker))
            throw new Error('runtime stage marker is malformed');
          const record = marker as Record<string, unknown>;
          const createdAt = record.createdAt;
          if (
            Object.keys(record).sort().join(',') !==
              'cleanupScope,createdAt,format,processGroupId' ||
            record.format !== 'selene-runtime-stage-orphan/v1' ||
            record.cleanupScope !== 'runtime-stage' ||
            !Number.isSafeInteger(record.processGroupId) ||
            (record.processGroupId as number) <= 0 ||
            typeof createdAt !== 'string' ||
            !Number.isFinite(Date.parse(createdAt)) ||
            new Date(createdAt).toISOString() !== createdAt
          )
            throw new Error('runtime stage marker is malformed');
          items.push(
            Object.freeze({
              stageId: entry.name,
              cleanupScope: 'runtime-stage',
              state: 'marked',
              processGroupId: record.processGroupId as number,
              createdAt,
              groupObservation: 'unknown'
            })
          );
        } catch {
          // A canonical private stage without a valid marker is never safe to
          // remove automatically; expose it as recovery-required instead.
          items.push(
            Object.freeze({
              stageId: entry.name,
              cleanupScope: 'runtime-stage',
              state: 'unmarked-or-malformed'
            })
          );
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    items.sort((left, right) => left.stageId.localeCompare(right.stageId));
    return Object.freeze({ items: Object.freeze(items), examined, truncated });
  }

  public async resolve(options: {
    readonly signal: AbortSignal;
  }): Promise<Readonly<{ executable: string; attestation: BunExecutableAttestation }>> {
    if (options.signal.aborted)
      throw new VerifiedBunRuntimeError('CANCELLED', 'Packaged Bun extraction was cancelled.');
    const [arch, expected] = this.selected();
    const location = await this.resourceLocator.locate();
    await this.copiedProvenance(location, arch, expected);
    const archRoot = join(location.resourceRoot, 'bun', arch);
    let pinnedArch: PinnedBunRuntimeDirectory;
    try {
      pinnedArch = await pinBunRuntimeDirectory(archRoot, location.kind);
      await this.resourceLocator.assertPinned(location);
      const archive = join(pinnedArch.path, expected.fileName);
      await this.assertArchivePinned(location, pinnedArch, archive, expected.archiveSha256);
      const pinnedArchAfter = await pinBunRuntimeDirectory(archRoot, location.kind);
      await this.resourceLocator.assertPinned(location);
      if (
        pinnedArchAfter.device !== pinnedArch.device ||
        pinnedArchAfter.inode !== pinnedArch.inode
      )
        throw this.resourceFailure(location);
    } catch (error) {
      if (error instanceof VerifiedBunRuntimeError && error.code !== 'TOOL_UNAVAILABLE')
        throw error;
      throw this.resourceFailure(location);
    }
    const archive = join(pinnedArch.path, expected.fileName);
    const root = await this.runtimeRoot(arch);
    const installation = resolve(root, expected.binarySha256);
    let binary: string;
    try {
      binary = await this.verifyInstallation(root, expected);
    } catch {
      const stage = await this.createStage(root);
      let retainedForRecovery = false;
      try {
        await this.assertArchivePinned(location, pinnedArch, archive, expected.archiveSha256);
        const entries = (await this.runUnzip(['-Z1', archive], stage, options.signal))
          .split(/\r?\n/)
          .filter(Boolean)
          .sort();
        if (entries.join('\n') !== [...expectedEntries(expected)].sort().join('\n'))
          throw new VerifiedBunRuntimeError(
            'TOOL_UNAVAILABLE',
            'Packaged Bun archive layout is invalid.'
          );
        await this.assertArchivePinned(location, pinnedArch, archive, expected.archiveSha256);
        await this.runUnzip(['-q', archive, '-d', stage], stage, options.signal);
        const extracted = join(stage, expected.binaryPath);
        const extractedDirectory = join(
          stage,
          expected.binaryPath.slice(0, expected.binaryPath.indexOf('/'))
        );
        const directoryStat = await lstat(extractedDirectory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
          throw new VerifiedBunRuntimeError(
            'TOOL_UNAVAILABLE',
            'Packaged Bun archive contains an unsafe directory.'
          );
        await this.verifyInstalled(extracted, expected);
        await mkdir(resolve(stage, 'install'), { mode: 0o700 });
        await rename(extracted, join(stage, 'install', 'bun'));
        await rename(resolve(stage, 'install'), installation).catch(
          async (error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
            await this.verifyInstallation(root, expected);
          }
        );
      } catch (error) {
        if (error instanceof VerifiedBunRuntimeError && error.code === 'PROCESS_ORPHANED') {
          retainedForRecovery = true;
          await this.recordRuntimeStageOrphan(stage, error);
        }
        throw error;
      } finally {
        // A detached archive tool may still have this stage as its cwd. Its
        // marker is retained for an explicit host recovery flow; never rm it.
        if (!retainedForRecovery)
          await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    binary = await this.verifyInstallation(root, expected);
    if (options.signal.aborted)
      throw new VerifiedBunRuntimeError('CANCELLED', 'Packaged Bun extraction was cancelled.');
    return Object.freeze({
      executable: binary,
      attestation: Object.freeze({
        bunVersion: '1.3.14',
        arch,
        executableSha256: expected.binarySha256,
        archiveSha256: expected.archiveSha256
      })
    });
  }
}
