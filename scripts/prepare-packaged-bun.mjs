import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import https from 'node:https';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsRoot = resolve(root, 'artifacts', 'desktop-runtime', 'bun');
const maximumArchiveBytes = 128 * 1024 * 1024;
const maximumBinaryBytes = 512 * 1024 * 1024;
const maximumOutputBytes = 64 * 1024;
const timeoutMs = 30_000;
const terminateGraceMs = 5_000;
const groupSettleMs = 5_000;
const groupPollMs = 100;
const maximumRedirects = 3;
const releaseHosts = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com'
]);
const official = Object.freeze({
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
class ProcessGroupOrphanError extends Error {}

function contained(rootPath, candidate) {
  const value = relative(rootPath, candidate);
  return value !== '' && !value.startsWith('..') && !isAbsolute(value);
}
function selectedArchitectures() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--arch')
    throw new Error('Usage: prepare-packaged-bun.mjs --arch <arm64|x64|universal>.');
  if (args[1] === 'universal') return ['arm64', 'x64'];
  if (args[1] === 'arm64' || args[1] === 'x64') return [args[1]];
  throw new Error('Packaged Bun architecture must be arm64, x64, or universal.');
}
async function hashNoFollow(path, maximumBytes) {
  if (typeof constants.O_NOFOLLOW !== 'number')
    throw new Error('This platform cannot safely verify a Bun release asset.');
  const pathBefore = await lstat(path);
  if (
    !pathBefore.isFile() ||
    pathBefore.isSymbolicLink() ||
    pathBefore.size <= 0 ||
    pathBefore.size > maximumBytes
  )
    throw new Error('Bun release asset is unsafe.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== pathBefore.size)
      throw new Error('Bun release asset changed while being verified.');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    for (let position = 0; position < before.size; position += buffer.byteLength) {
      // oxlint-disable-next-line no-await-in-loop -- Archive hashing consumes ordered bounded descriptor reads.
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - position),
        position
      );
      if (result.bytesRead === 0)
        throw new Error('Bun release asset changed while being verified.');
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (after.size !== before.size || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino)
      throw new Error('Bun release asset changed while being verified.');
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}
async function readBoundedNoFollow(path, maximumBytes) {
  if (typeof constants.O_NOFOLLOW !== 'number')
    throw new Error('This platform cannot safely read Bun provenance.');
  const pathBefore = await lstat(path);
  if (
    !pathBefore.isFile() ||
    pathBefore.isSymbolicLink() ||
    pathBefore.size <= 0 ||
    pathBefore.size > maximumBytes
  )
    throw new Error('Bun provenance is unsafe.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== pathBefore.size)
      throw new Error('Bun provenance changed while being read.');
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.byteLength) {
      // oxlint-disable-next-line no-await-in-loop -- Provenance bytes are read in sequence from one no-follow descriptor.
      const result = await handle.read(content, offset, content.byteLength - offset, offset);
      if (result.bytesRead === 0) throw new Error('Bun provenance changed while being read.');
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (after.size !== before.size || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino)
      throw new Error('Bun provenance changed while being read.');
    return content;
  } finally {
    await handle.close();
  }
}
async function writeExclusive(path, data) {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  const content = Buffer.from(data, 'utf8');
  try {
    await writeAll(handle, content);
    if ((await handle.stat()).size !== content.byteLength)
      throw new Error('Bun staging provenance size is invalid.');
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function writeAll(handle, data) {
  if (!Buffer.isBuffer(data)) throw new Error('Bun staging writes require a Buffer.');
  let offset = 0;
  while (offset < data.byteLength) {
    // oxlint-disable-next-line no-await-in-loop -- Partial descriptor writes must advance the same file cursor in order.
    const result = await handle.write(data, offset, data.byteLength - offset, null);
    if (result.bytesWritten <= 0) throw new Error('Bun staging write did not make progress.');
    offset += result.bytesWritten;
  }
}
async function copyNoFollowExclusive(source, destination) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    const before = await input.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maximumArchiveBytes)
      throw new Error('Bun archive staging source is unsafe.');
    output = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    const buffer = Buffer.alloc(64 * 1024);
    for (let position = 0; position < before.size; position += buffer.byteLength) {
      // oxlint-disable-next-line no-await-in-loop -- Copy source chunks in order before appending each to the exclusive destination.
      const result = await input.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - position),
        position
      );
      if (result.bytesRead === 0)
        throw new Error('Bun archive staging source changed while being read.');
      // oxlint-disable-next-line no-await-in-loop -- Destination writes follow the corresponding attested source chunk.
      await writeAll(output, buffer.subarray(0, result.bytesRead));
    }
    if ((await output.stat()).size !== before.size)
      throw new Error('Bun archive staging destination size is invalid.');
    await output.sync();
    const after = await input.stat();
    const sourceAfter = await lstat(source);
    if (
      after.size !== before.size ||
      sourceAfter.dev !== before.dev ||
      sourceAfter.ino !== before.ino
    )
      throw new Error('Bun archive staging source changed while being read.');
  } finally {
    await output?.close().catch(() => undefined);
    await input.close();
  }
}
function fixedGithubUrl(value) {
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    url.hostname === 'github.com' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === ''
  );
}
async function responseFor(urlValue, deadline, redirectCount = 0) {
  const url = new URL(urlValue);
  if (url.protocol !== 'https:' || url.username || url.password || !releaseHosts.has(url.hostname))
    throw new Error('Bun release redirect is not approved HTTPS.');
  const remaining = deadline - Date.now();
  if (!Number.isSafeInteger(remaining) || remaining <= 0)
    throw new Error('Bun release download timed out.');
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let totalTimer;
    const settle = (value, error) => {
      if (settled) return;
      settled = true;
      if (totalTimer) clearTimeout(totalTimer);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const request = https.get(
      url,
      { timeout: remaining, headers: { 'user-agent': 'selene-packaged-bun-preparer/1' } },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          response.resume();
          if (redirectCount >= maximumRedirects || typeof location !== 'string') {
            settle(undefined, new Error('Bun release redirect limit exceeded.'));
            return;
          }
          responseFor(new URL(location, url).toString(), deadline, redirectCount + 1).then(
            (next) => settle(next),
            (error) => settle(undefined, error)
          );
          return;
        }
        if (status !== 200) {
          response.resume();
          settle(undefined, new Error('Bun release download did not return HTTP 200.'));
          return;
        }
        settle(response);
      }
    );
    totalTimer = setTimeout(
      () => request.destroy(new Error('Bun release download timed out.')),
      remaining
    );
    request.once('timeout', () => request.destroy(new Error('Bun release download timed out.')));
    request.once('error', (error) => settle(undefined, error));
  });
}
async function downloadNoFollow(url, destination) {
  const output = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  const deadline = Date.now() + timeoutMs;
  let response;
  const wallClock = setTimeout(
    () => response?.destroy(new Error('Bun release download timed out.')),
    timeoutMs
  );
  try {
    response = await responseFor(url, deadline);
    let bytes = 0;
    for await (const chunk of response) {
      const data = Buffer.from(chunk);
      bytes += data.byteLength;
      if (bytes > maximumArchiveBytes) throw new Error('Bun release archive exceeded its bound.');
      await writeAll(output, data);
    }
    if (bytes <= 0 || (await output.stat()).size !== bytes)
      throw new Error('Bun release archive size is invalid.');
    await output.sync();
  } catch (error) {
    await output.close().catch(() => undefined);
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(wallClock);
  }
  await output.close();
}
async function fixedUnzip(argumentsList, cwd) {
  const configured = await lstat('/usr/bin/unzip');
  const executable = await realpath('/usr/bin/unzip');
  const after = await lstat('/usr/bin/unzip');
  const target = await lstat(executable);
  if (
    executable !== '/usr/bin/unzip' ||
    !configured.isFile() ||
    configured.isSymbolicLink() ||
    (configured.mode & 0o111) === 0 ||
    after.dev !== configured.dev ||
    after.ino !== configured.ino ||
    !target.isFile() ||
    target.isSymbolicLink() ||
    (target.mode & 0o111) === 0
  )
    throw new Error('Fixed macOS unzip tool is unsafe.');
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, argumentsList, {
      cwd,
      shell: false,
      detached: true,
      env: Object.create(null),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let outputBytes = 0;
    let pending;
    let terminating = false;
    let closed = false;
    let settled = false;
    let timeout;
    let escalation;
    let watchdog;
    let poll;
    const groupAlive = () => {
      try {
        if (!child.pid) return false;
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return error.code !== 'ESRCH';
      }
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      for (const timer of [timeout, escalation, watchdog, poll]) if (timer) clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(output);
    };
    const afterGroup = () => {
      if (pending) finish(pending);
      else if (closed) finish();
    };
    const probe = () => {
      if (settled) return;
      if (!groupAlive()) {
        afterGroup();
        return;
      }
      poll = setTimeout(probe, groupPollMs);
    };
    const signal = (value) => {
      try {
        if (child.pid) process.kill(-child.pid, value);
      } catch {}
    };
    const terminate = (error) => {
      if (!pending) pending = error;
      if (terminating) return;
      terminating = true;
      signal('SIGTERM');
      escalation = setTimeout(() => signal('SIGKILL'), terminateGraceMs);
      watchdog = setTimeout(() => {
        if (groupAlive())
          finish(
            new ProcessGroupOrphanError(
              'Bun archive verification process group could not be terminated.'
            )
          );
        else afterGroup();
      }, terminateGraceMs + groupSettleMs);
      probe();
    };
    timeout = setTimeout(
      () => terminate(new Error('Bun archive verification timed out.')),
      timeoutMs
    );
    const collect = (stream) =>
      stream.on('data', (chunk) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > maximumOutputBytes) {
          terminate(new Error('Bun archive verification output exceeded its bound.'));
          return;
        }
        output += chunk.toString('utf8');
      });
    collect(child.stdout);
    collect(child.stderr);
    child.once('error', () => {
      if (child.pid) terminate(new Error('Fixed macOS unzip tool could not start.'));
      else finish(new Error('Fixed macOS unzip tool could not start.'));
    });
    child.once('close', (code, signalValue) => {
      closed = true;
      if (!pending && (code !== 0 || signalValue !== null))
        pending = new Error('Bun archive verification failed.');
      if (groupAlive()) {
        if (!terminating) terminate(new Error('Bun archive verification retained descendants.'));
        probe();
      } else afterGroup();
    });
  });
}
async function validateProvenance() {
  const parsed = JSON.parse(
    (
      await readBoundedNoFollow(
        resolve(root, 'apps/desktop/bun-runtime-provenance.json'),
        16 * 1024
      )
    ).toString('utf8')
  );
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(',') !== 'archives,bunVersion,format' ||
    parsed.format !== 'selene-packaged-bun-runtime/v1' ||
    parsed.bunVersion !== '1.3.14' ||
    !parsed.archives ||
    typeof parsed.archives !== 'object' ||
    Object.keys(parsed.archives).sort().join(',') !== 'arm64,x64'
  )
    throw new Error('Bundled Bun provenance schema is invalid.');
  for (const arch of ['arm64', 'x64']) {
    const source = parsed.archives[arch];
    if (
      !source ||
      typeof source !== 'object' ||
      Object.keys(source).sort().join(',') !==
        'archiveSha256,binaryPath,binarySha256,fileName,releaseUrl'
    )
      throw new Error('Bundled Bun provenance schema is invalid.');
    for (const pair of Object.entries(official[arch]))
      if (source[pair[0]] !== pair[1])
        throw new Error('Bundled Bun provenance does not match fixed release constants.');
  }
  return parsed;
}
async function stageExclusive(source, destination, digest) {
  const temporary = destination + '.' + randomUUID() + '.tmp';
  try {
    await copyNoFollowExclusive(source, temporary);
    try {
      await link(temporary, destination);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if ((await hashNoFollow(destination, maximumArchiveBytes)) !== digest)
        throw new Error('Concurrent Bun resource staging produced a different archive.', {
          cause: error
        });
    }
    if ((await hashNoFollow(destination, maximumArchiveBytes)) !== digest)
      throw new Error('Linked Bun staging archive does not match fixed provenance.');
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

const selected = selectedArchitectures();
const provenance = await validateProvenance();
const realRepoRoot = await realpath(root);
const rootStat = await lstat(realRepoRoot);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
  throw new Error('Repository root is unsafe for Bun staging.');
await mkdir(artifactsRoot, { recursive: true, mode: 0o700 });
const realArtifactsRoot = await realpath(artifactsRoot);
const artifactsStat = await lstat(realArtifactsRoot);
if (
  !artifactsStat.isDirectory() ||
  artifactsStat.isSymbolicLink() ||
  !contained(realRepoRoot, realArtifactsRoot)
)
  throw new Error('Bun artifacts root is unsafe.');
const stage = await mkdtemp(join(realArtifactsRoot, '.prepare-'));
const realStage = await realpath(stage);
const stageStat = await lstat(realStage);
if (
  !stageStat.isDirectory() ||
  stageStat.isSymbolicLink() ||
  realStage !== stage ||
  !contained(realArtifactsRoot, realStage)
)
  throw new Error('Bun preparation stage is unsafe.');
let retainStage = false;
try {
  for (const arch of selected) {
    const metadata = official[arch];
    if (!fixedGithubUrl(metadata.releaseUrl))
      throw new Error('Bun release URL is not fixed GitHub HTTPS.');
    const archive = join(realStage, metadata.fileName);
    // oxlint-disable-next-line no-await-in-loop -- Each architecture stays isolated through download, extraction, and attestation.
    await downloadNoFollow(metadata.releaseUrl, archive);
    // oxlint-disable-next-line no-await-in-loop -- Verify the downloaded archive before any extraction.
    if ((await hashNoFollow(archive, maximumArchiveBytes)) !== metadata.archiveSha256)
      throw new Error('Bun release archive digest did not match fixed provenance.');
    const extracted = join(realStage, 'extract-' + arch);
    // oxlint-disable-next-line no-await-in-loop -- Create the per-architecture extraction root before inspecting it.
    await mkdir(extracted, { mode: 0o700 });
    // oxlint-disable-next-line no-await-in-loop -- Resolve the new extraction root before validating containment.
    const extractedActual = await realpath(extracted);
    // oxlint-disable-next-line no-await-in-loop -- Inspect the same extraction root for symlink replacement.
    const extractedStat = await lstat(extracted);
    if (
      extractedActual !== extracted ||
      !extractedStat.isDirectory() ||
      extractedStat.isSymbolicLink() ||
      !contained(realStage, extractedActual)
    )
      throw new Error('Bun verification extraction directory is unsafe.');
    // oxlint-disable-next-line no-await-in-loop -- Validate archive layout before extraction for this architecture.
    const entries = (await fixedUnzip(['-Z1', archive], extractedActual))
      .split(/\r?\n/)
      .filter(Boolean)
      .sort();
    const directory = metadata.binaryPath.slice(0, metadata.binaryPath.indexOf('/'));
    if (entries.join('\n') !== [directory + '/', metadata.binaryPath].sort().join('\n'))
      throw new Error('Bun release archive layout is invalid.');
    // oxlint-disable-next-line no-await-in-loop -- Extract only after the exact archive entry layout has been accepted.
    await fixedUnzip(['-q', archive, '-d', extractedActual], extractedActual);
    // oxlint-disable-next-line no-await-in-loop -- Re-resolve after extraction to detect root replacement.
    const extractedAfter = await realpath(extracted);
    // oxlint-disable-next-line no-await-in-loop -- Reinspect the root identity before using extracted files.
    const extractedAfterStat = await lstat(extracted);
    if (
      extractedAfter !== extractedActual ||
      extractedAfterStat.isSymbolicLink() ||
      !extractedAfterStat.isDirectory() ||
      extractedAfterStat.dev !== extractedStat.dev ||
      extractedAfterStat.ino !== extractedStat.ino ||
      !contained(realStage, extractedAfter)
    )
      throw new Error('Bun verification extraction directory changed while unpacking.');
    const binary = join(extractedActual, metadata.binaryPath);
    // oxlint-disable-next-line no-await-in-loop -- Inspect the fixed binary path before hashing it.
    const binaryStat = await lstat(binary);
    const binaryDirectory = join(extractedActual, directory);
    // oxlint-disable-next-line no-await-in-loop -- Inspect its parent directory before accepting the binary.
    const directoryStat = await lstat(binaryDirectory);
    if (
      !binaryStat.isFile() ||
      binaryStat.isSymbolicLink() ||
      (binaryStat.mode & 0o111) === 0 ||
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      // oxlint-disable-next-line no-await-in-loop -- Hash the inspected binary before staging this architecture.
      (await hashNoFollow(binary, maximumBinaryBytes)) !== metadata.binarySha256
    )
      throw new Error('Bun release binary digest did not match fixed provenance.');
    const destinationDirectory = resolve(realArtifactsRoot, arch);
    if (!contained(realArtifactsRoot, destinationDirectory))
      throw new Error('Bun staging destination is unsafe.');
    // oxlint-disable-next-line no-await-in-loop -- Create the architecture destination before proving it is contained.
    await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
    // oxlint-disable-next-line no-await-in-loop -- Resolve the created destination before writing an archive into it.
    const destinationActual = await realpath(destinationDirectory);
    // oxlint-disable-next-line no-await-in-loop -- Inspect the destination identity after resolution.
    const destinationStat = await lstat(destinationActual);
    if (
      destinationActual !== destinationDirectory ||
      !destinationStat.isDirectory() ||
      destinationStat.isSymbolicLink() ||
      !contained(realArtifactsRoot, destinationActual)
    )
      throw new Error('Bun staging destination is unsafe.');
    // oxlint-disable-next-line no-await-in-loop -- Stage and digest-verify one architecture before continuing to the next.
    await stageExclusive(
      archive,
      join(destinationDirectory, metadata.fileName),
      metadata.archiveSha256
    );
  }
  const provenanceSource = join(realStage, 'provenance.json');
  const serializedProvenance = JSON.stringify(provenance) + '\n';
  await writeExclusive(provenanceSource, serializedProvenance);
  const provenanceDestination = join(realArtifactsRoot, 'provenance.json');
  try {
    await link(provenanceSource, provenanceDestination);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (
      (await readBoundedNoFollow(provenanceDestination, 16 * 1024)).toString('utf8') !==
      serializedProvenance
    )
      throw new Error('Concurrent Bun provenance staging produced different data.', {
        cause: error
      });
  }
  if (
    (await readBoundedNoFollow(provenanceDestination, 16 * 1024)).toString('utf8') !==
    serializedProvenance
  )
    throw new Error('Linked Bun provenance staging produced different data.');
} catch (error) {
  if (error instanceof ProcessGroupOrphanError) retainStage = true;
  throw error;
} finally {
  if (!retainStage) await rm(realStage, { recursive: true, force: true });
}

console.log('Prepared verified Bun 1.3.14 ZIP data resources for ' + selected.join(', ') + '.');
