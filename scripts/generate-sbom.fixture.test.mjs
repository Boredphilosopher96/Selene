import { createPackage } from '@electron/asar';
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const hostPlatform = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform];
const hostArch = { x64: 'x64', arm64: 'arm64' }[process.arch];
const subprocessTimeoutMs = 5_000;
const subprocessOutputCap = 64 * 1024;
const subprocessKillGraceMs = 250;
const subprocessPostKillDeadlineMs = 1_000;

class PostKillSettlementTimeoutError extends Error {
  constructor(command) {
    super(`SBOM subprocess ${command} did not settle after SIGKILL.`);
    this.name = 'PostKillSettlementTimeoutError';
    this.code = 'SBOM_SUBPROCESS_POST_KILL_TIMEOUT';
  }
}

function createInjectedChild({ killError } = {}) {
  const child = new EventEmitter();
  const killSignals = [];
  const releases = {
    stdout: { destroyed: 0, paused: 0 },
    stderr: { destroyed: 0, paused: 0 }
  };
  const createStream = (name) => {
    const stream = new EventEmitter();
    stream.destroy = () => {
      releases[name].destroyed += 1;
    };
    stream.pause = () => {
      releases[name].paused += 1;
    };
    return stream;
  };
  child.stdout = createStream('stdout');
  child.stderr = createStream('stderr');
  child.kill = (signal) => {
    killSignals.push(signal);
    if (killError) throw killError;
    return true;
  };
  return { child, killSignals, releases };
}

async function runBounded(
  cwd,
  command,
  commandArguments,
  {
    spawnChild = (childCommand, childArguments, options) =>
      spawn(childCommand, childArguments, options),
    timeoutMs = subprocessTimeoutMs,
    outputCap = subprocessOutputCap,
    killGraceMs = subprocessKillGraceMs,
    postKillDeadlineMs = subprocessPostKillDeadlineMs
  } = {}
) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    let child;
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    let terminating = false;
    let timeout;
    let killTimer;
    let postKillTimer;
    let cleanedUp = false;
    let onStdoutData;
    let onStderrData;
    let onChildError;
    let onChildClose;
    const releaseStream = (stream) => {
      if (!stream) return;
      try {
        if (typeof stream.destroy === 'function') {
          stream.destroy();
          return;
        }
      } catch {
        // A stream can already be closed by the child; pausing is a safe fallback.
      }
      try {
        stream.pause?.();
      } catch {
        // Cleanup is best effort and must not replace the terminal child outcome.
      }
    };
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(postKillTimer);
      child?.stdout?.removeListener('data', onStdoutData);
      child?.stderr?.removeListener('data', onStderrData);
      child?.removeListener('error', onChildError);
      child?.removeListener('close', onChildClose);
      releaseStream(child?.stdout);
      releaseStream(child?.stderr);
    };
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (outcome instanceof Error) {
        rejectPromise(outcome);
        return;
      }
      resolvePromise({
        ...outcome,
        stderr,
        stdout,
        timedOut,
        outputLimitExceeded,
        outputBytes,
        elapsedMs: Date.now() - startedAt
      });
    };
    const terminate = () => {
      if (settled || terminating) return;
      terminating = true;
      const sendSignal = (signal) => {
        try {
          child.kill(signal);
          return true;
        } catch (error) {
          settle(error);
          return false;
        }
      };
      if (!sendSignal('SIGTERM')) return;
      killTimer = setTimeout(() => {
        if (settled) return;
        if (!sendSignal('SIGKILL')) return;
        postKillTimer = setTimeout(() => {
          settle(new PostKillSettlementTimeoutError(command));
        }, postKillDeadlineMs);
      }, killGraceMs);
    };
    const append = (current, chunk) => {
      const remaining = outputCap - outputBytes;
      if (remaining <= 0) {
        outputLimitExceeded = true;
        terminate();
        return current;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const captured = bytes.subarray(0, remaining);
      outputBytes += captured.byteLength;
      if (bytes.byteLength > remaining) {
        outputLimitExceeded = true;
        terminate();
      }
      return current + captured.toString('utf8');
    };
    try {
      child = spawnChild(command, commandArguments, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      settle(error);
      return;
    }
    onStdoutData = (chunk) => {
      if (settled) return;
      stdout = append(stdout, chunk);
    };
    onStderrData = (chunk) => {
      if (settled) return;
      stderr = append(stderr, chunk);
    };
    onChildError = (error) => {
      settle(error);
    };
    onChildClose = (code, signal) => {
      settle({ code, signal });
    };
    child.stdout.on('data', onStdoutData);
    child.stderr.on('data', onStderrData);
    timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.once('error', onChildError);
    child.once('close', onChildClose);
  });
}

async function runGenerator(cwd, ...argumentsList) {
  return runBounded(cwd, 'bun', ['run', 'sbom', '--', ...argumentsList]);
}

describe('packaged-runtime SBOM executable fixture', () => {
  it('runs the real no-argument command and fails closed for invalid inputs and archive counts', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'selene-sbom-fixture-'));
    try {
      const source = join(temporaryRoot, 'source');
      const build = join(
        temporaryRoot,
        'artifacts',
        'desktop-build',
        `${hostPlatform}-${hostArch}`
      );
      const resources = join(build, 'one', 'resources');
      const output = join(
        temporaryRoot,
        'artifacts',
        'release-assets',
        `${hostPlatform}-${hostArch}`,
        `Selene-0.1.0-alpha.0-${hostPlatform}-${hostArch}.sbom.cdx.json`
      );
      await mkdir(join(temporaryRoot, 'scripts'), { recursive: true });
      await mkdir(join(temporaryRoot, 'apps', 'desktop'), { recursive: true });
      await cp(
        join(root, 'scripts', 'generate-sbom.mjs'),
        join(temporaryRoot, 'scripts', 'generate-sbom.mjs')
      );
      await cp(
        join(root, 'scripts', 'runtime-sbom.mjs'),
        join(temporaryRoot, 'scripts', 'runtime-sbom.mjs')
      );
      const desktopManifest = JSON.parse(
        await readFile(join(root, 'apps', 'desktop', 'package.json'), 'utf8')
      );
      await writeFile(
        join(temporaryRoot, 'package.json'),
        JSON.stringify({
          name: 'selene',
          version: '0.1.0-alpha.0',
          scripts: { sbom: 'bun scripts/generate-sbom.mjs' }
        })
      );
      await writeFile(
        join(temporaryRoot, 'apps', 'desktop', 'package.json'),
        JSON.stringify({ devDependencies: { electron: desktopManifest.devDependencies.electron } })
      );
      await mkdir(join(source, 'node_modules', 'fixture-runtime'), { recursive: true });
      await writeFile(
        join(source, 'package.json'),
        JSON.stringify({ name: 'selene', version: '0.1.0-alpha.0' })
      );
      await writeFile(
        join(source, 'node_modules', 'fixture-runtime', 'package.json'),
        JSON.stringify({ name: 'fixture-runtime', version: '1.2.3', license: 'MIT' })
      );
      await mkdir(resources, { recursive: true });
      await mkdir(join(resources, 'app.asar.unpacked', 'node_modules'), { recursive: true });
      await createPackage(source, join(resources, 'app.asar'));

      const success = await runGenerator(temporaryRoot);
      expect(success.code).toBe(0);
      expect(success.timedOut).toBe(false);
      expect(success.outputLimitExceeded).toBe(false);
      expect(success.stdout).toContain(output);
      expect(output).toContain(`${hostPlatform}-${hostArch}`);
      const document = JSON.parse(await readFile(output, 'utf8'));
      expect(document.bomFormat).toBe('CycloneDX');
      expect(document.metadata.component).toMatchObject({
        type: 'application',
        name: 'selene',
        version: '0.1.0-alpha.0'
      });
      expect(document.components).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'electron',
            version: desktopManifest.devDependencies.electron,
            type: 'framework'
          }),
          expect.objectContaining({ name: 'fixture-runtime', version: '1.2.3', type: 'library' })
        ])
      );

      const targetPlatform = hostPlatform === 'linux' ? 'macos' : 'linux';
      const targetArch = 'x64';
      const targetBuild = join(temporaryRoot, 'target-build');
      const targetResources = join(targetBuild, 'resources');
      const targetOutput = join(temporaryRoot, 'target-output', 'Selene-target.sbom.cdx.json');
      await mkdir(targetResources, { recursive: true });
      await mkdir(join(targetResources, 'app.asar.unpacked', 'node_modules'), { recursive: true });
      await createPackage(source, join(targetResources, 'app.asar'));
      const targeted = await runGenerator(
        temporaryRoot,
        '--platform',
        targetPlatform,
        '--arch',
        targetArch,
        '--build-directory',
        targetBuild,
        '--output',
        targetOutput
      );
      expect(targeted.code).toBe(0);
      expect(targeted.timedOut).toBe(false);
      expect(targeted.outputLimitExceeded).toBe(false);
      expect(JSON.parse(await readFile(targetOutput))).toMatchObject({
        bomFormat: 'CycloneDX',
        metadata: { component: { name: 'selene', version: '0.1.0-alpha.0' } }
      });

      await Promise.all(
        [
          [['--unknown'], 'Unknown or positional SBOM argument'],
          [['--output', 'one', '--output', 'two'], 'Duplicate SBOM option'],
          [['--output'], 'Missing value for SBOM option'],
          [['positional'], 'Unknown or positional SBOM argument'],
          [['--platform', 'plan9'], 'Unsupported SBOM platform'],
          [['--platform', 'linux', '--arch', 'universal'], 'Unsupported SBOM architecture']
        ].map(async ([argumentsList, message]) => {
          const invalid = await runGenerator(temporaryRoot, ...argumentsList);
          expect(invalid.code).not.toBe(0);
          expect(invalid.timedOut).toBe(false);
          expect(invalid.outputLimitExceeded).toBe(false);
          expect(invalid.stderr).toContain(message);
        })
      );

      const universalOutput = join(
        temporaryRoot,
        'universal-output',
        'Selene-macos-universal.sbom.cdx.json'
      );
      const universal = await runGenerator(
        temporaryRoot,
        '--platform',
        'macos',
        '--arch',
        'universal',
        '--build-directory',
        targetBuild,
        '--output',
        universalOutput
      );
      expect(universal.code).toBe(0);
      expect(JSON.parse(await readFile(universalOutput))).toMatchObject({
        bomFormat: 'CycloneDX'
      });

      await rm(join(resources, 'app.asar'));
      const absent = await runGenerator(temporaryRoot);
      expect(absent.code).not.toBe(0);
      expect(absent.outputLimitExceeded).toBe(false);
      expect(absent.stderr).toContain('Expected exactly one packaged app.asar');

      await createPackage(source, join(resources, 'app.asar'));
      const secondResources = join(build, 'two', 'resources');
      await mkdir(secondResources, { recursive: true });
      await createPackage(source, join(secondResources, 'app.asar'));
      const multiple = await runGenerator(temporaryRoot);
      expect(multiple.code).not.toBe(0);
      expect(multiple.outputLimitExceeded).toBe(false);
      expect(multiple.stderr).toContain('Expected exactly one packaged app.asar');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe('bounded SBOM subprocess runner', () => {
  it('caps combined stdout and stderr, then settles once after TERM and KILL', async () => {
    const { child, killSignals, releases } = createInjectedChild();
    const overflowPromise = runBounded(tmpdir(), 'injected-child', [], {
      spawnChild: () => child,
      outputCap: 5,
      timeoutMs: 1_000,
      killGraceMs: 1,
      postKillDeadlineMs: 1_000
    });
    child.stdout.emit('data', Buffer.from('abc'));
    child.stderr.emit('data', Buffer.from('def'));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    child.emit('close', null, 'SIGKILL');
    const overflow = await overflowPromise;
    expect(overflow.outputLimitExceeded).toBe(true);
    expect(overflow.outputBytes).toBe(5);
    expect(Buffer.byteLength(overflow.stdout) + Buffer.byteLength(overflow.stderr)).toBe(5);
    expect(killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(releases).toEqual({
      stdout: { destroyed: 1, paused: 0 },
      stderr: { destroyed: 1, paused: 0 }
    });
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('cleans only runner-owned listeners after normal close and error outcomes', async () => {
    const closed = createInjectedChild();
    const retainedClose = () => {};
    closed.child.on('close', retainedClose);
    const closeResult = runBounded(tmpdir(), 'injected-child', [], {
      spawnChild: () => closed.child
    });
    closed.child.emit('close', 0, null);
    await expect(closeResult).resolves.toMatchObject({ code: 0 });
    expect(closed.child.listenerCount('close')).toBe(1);
    expect(closed.child.listeners('close')).toEqual([retainedClose]);
    expect(closed.child.listenerCount('error')).toBe(0);
    expect(closed.child.stdout.listenerCount('data')).toBe(0);
    expect(closed.child.stderr.listenerCount('data')).toBe(0);

    const failed = createInjectedChild();
    const retainedError = () => {};
    failed.child.on('error', retainedError);
    const failure = runBounded(tmpdir(), 'injected-child', [], {
      spawnChild: () => failed.child
    });
    const childFailure = new Error('injected child failure');
    failed.child.emit('error', childFailure);
    await expect(failure).rejects.toBe(childFailure);
    expect(failed.child.listenerCount('error')).toBe(1);
    expect(failed.child.listeners('error')).toEqual([retainedError]);
    expect(failed.child.listenerCount('close')).toBe(0);
    expect(failed.child.stdout.listenerCount('data')).toBe(0);
    expect(failed.child.stderr.listenerCount('data')).toBe(0);
  });

  it('raises a typed error and makes late injected child events inert after KILL', async () => {
    const { child, killSignals, releases } = createInjectedChild();
    const lateErrors = [];
    child.on('error', (error) => lateErrors.push(error));
    const pending = runBounded(tmpdir(), 'injected-child', [], {
      spawnChild: () => child,
      timeoutMs: 1,
      killGraceMs: 1,
      postKillDeadlineMs: 1
    });
    await expect(pending).rejects.toMatchObject({
      name: 'PostKillSettlementTimeoutError',
      code: 'SBOM_SUBPROCESS_POST_KILL_TIMEOUT'
    });
    expect(killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(releases).toEqual({
      stdout: { destroyed: 1, paused: 0 },
      stderr: { destroyed: 1, paused: 0 }
    });
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('error')).toBe(1);

    const lateError = new Error('late error');
    expect(() => {
      child.stdout.emit('data', Buffer.from('late stdout'));
      child.stderr.emit('data', Buffer.from('late stderr'));
      child.emit('error', lateError);
      child.emit('close', 0, null);
    }).not.toThrow();
    expect(lateErrors).toEqual([lateError]);
  });

  it('rejects safely when an injected child throws while receiving TERM', async () => {
    const killError = new Error('cannot terminate child');
    const { child, killSignals } = createInjectedChild({ killError });
    await expect(
      runBounded(tmpdir(), 'injected-child', [], {
        spawnChild: () => child,
        timeoutMs: 1
      })
    ).rejects.toBe(killError);
    expect(killSignals).toEqual(['SIGTERM']);
  });
});
