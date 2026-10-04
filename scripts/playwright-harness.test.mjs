import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertHarnessPortAvailable,
  harnessIdentity,
  harnessPorts,
  isHostedCi
} from './playwright-harness.mjs';
import { terminateProcessTree } from './harness-server-process.mjs';

const servers = [];
const children = [];
const observations = new WeakMap();
// Hosted Windows PowerShell startup can cross the generic 5 s test ceiling.
// Keep POSIX unchanged and preserve independently enforced startup, exit,
// descendant, port-release and whole-test budgets on Windows.
const harnessStartupTimeoutMs = process.platform === 'win32' ? 10_000 : 5_000;
const concurrentIdentityTimeoutMs = process.platform === 'win32' ? 15_000 : 5_000;
const harnessExitTimeoutMs = 5_000;
const harnessCleanupTimeoutMs = 5_000;
const harnessLifecycleTimeoutMs =
  process.platform === 'win32'
    ? harnessStartupTimeoutMs + harnessExitTimeoutMs + harnessCleanupTimeoutMs * 2 + 1_000
    : 5_000;

function observeHarnessChild(child) {
  let output = '';
  let stderr = '';
  let exitResult;
  let spawnError;
  let closed = false;
  const updates = new EventEmitter();
  child.stdout.on('data', (chunk) => {
    output += chunk;
    updates.emit('change');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  // Register before waiting for readiness. Fast fixtures can exit immediately
  // after their ready line, and an exit event cannot be subscribed to later.
  child.once('error', (error) => {
    spawnError = error;
    updates.emit('change');
  });
  child.once('exit', (code, signal) => {
    exitResult = [code, signal];
    updates.emit('change');
  });
  child.once('close', () => {
    closed = true;
    updates.emit('change');
  });
  const diagnostics = () => `stdout: ${output}\nstderr: ${stderr}`;
  const wait = (check, timeoutMs, description) =>
    new Promise((resolve, reject) => {
      const finish = (complete, value) => {
        clearTimeout(timeout);
        updates.removeListener('change', onChange);
        complete(value);
      };
      const onChange = () => {
        try {
          if (spawnError) throw spawnError;
          const result = check();
          if (result !== undefined) finish(resolve, result);
        } catch (error) {
          finish(reject, error);
        }
      };
      const timeout = setTimeout(
        () => finish(reject, new Error(`Timed out waiting for ${description}: ${diagnostics()}`)),
        timeoutMs
      );
      updates.on('change', onChange);
      onChange();
    });
  const observation = {
    output: () => output,
    stderr: () => stderr,
    waitForOutput: (expected, timeoutMs = harnessStartupTimeoutMs) =>
      wait(
        () => {
          if (output.includes(expected)) return () => output;
          if (closed) {
            const [code, signal] = exitResult ?? [child.exitCode, child.signalCode];
            throw new Error(
              `Harness exited before ${expected} (code ${code}, signal ${signal}): ${diagnostics()}`
            );
          }
        },
        timeoutMs,
        expected
      ),
    // close follows exit and drained stdio, including inherited descendant
    // handles. Checking the cached result also covers an already-ended fixture.
    waitForExit: () =>
      wait(
        () => (closed ? exitResult : undefined),
        harnessExitTimeoutMs,
        'harness exit and closed stdio'
      )
  };
  observations.set(child, observation);
  return observation;
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address.');
  const { port } = address;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}

async function expectPortReusableBefore(port, timeoutAt) {
  try {
    await assertHarnessPortAvailable('grandchild fixture', port);
  } catch (error) {
    const occupied =
      error instanceof Error &&
      error.message.includes(`127.0.0.1:${port} is already occupied by an unrelated service`);
    if (!occupied || Date.now() >= timeoutAt) throw error;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expectPortReusableBefore(port, timeoutAt);
  }
}

async function expectPortReusable(port) {
  await expectPortReusableBefore(port, Date.now() + harnessCleanupTimeoutMs);
}

function expectProcessGone(pid) {
  if (processIsGone(pid)) return;
  throw new Error(`Expected process ${pid} to be gone.`);
}

function processIsGone(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return true;
    throw error;
  }
  return false;
}

async function waitForProcessGone(pid) {
  return new Promise((resolve, reject) => {
    let timer;
    let timeout;
    const finish = () => {
      clearInterval(timer);
      clearTimeout(timeout);
      resolve();
    };
    const check = () => {
      try {
        if (processIsGone(pid)) finish();
      } catch (error) {
        clearInterval(timer);
        clearTimeout(timeout);
        reject(error);
      }
    };
    timer = setInterval(check, 10);
    timeout = setTimeout(() => {
      clearInterval(timer);
      reject(new Error(`Timed out waiting for process ${pid} to exit.`));
    }, harnessCleanupTimeoutMs);
    check();
  });
}

function grandchildPid(output) {
  const match = /grandchild-pid:(\d+)/.exec(output());
  if (!match) throw new Error(`Missing grandchild PID in harness output: ${output()}`);
  return Number(match[1]);
}

const fixture = [
  "const { createServer } = require('node:http');",
  'const port = Number(process.argv[1]);',
  'const identity = process.argv[2];',
  'const server = createServer((_, response) => response.end(identity));',
  "server.listen({ host: '127.0.0.1', port }, () => console.log('fixture-ready'));",
  "process.once('SIGTERM', () => { console.log('fixture-sigterm'); server.close(() => process.exit(0)); });",
  "process.once('SIGINT', () => { console.log('fixture-sigint'); server.close(() => process.exit(0)); });"
].join('');

const grandchildFixture = [
  "const { createServer } = require('node:http');",
  'const port = Number(process.argv[1]);',
  "const server = createServer((_, response) => response.end('grandchild'));",
  "server.listen({ host: '127.0.0.1', port }, () => console.log('grandchild-ready'));",
  "for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));"
].join('');

const stubbornGrandchildFixture = [
  "const { createServer } = require('node:http');",
  'const port = Number(process.argv[1]);',
  "const server = createServer((_, response) => response.end('stubborn grandchild'));",
  "server.listen({ host: '127.0.0.1', port }, () => console.log('stubborn-grandchild-ready'));",
  "for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {});"
].join('');

function signalProcessTreeFixture(grandchild) {
  return [
    "const { spawn } = require('node:child_process');",
    'const port = process.argv[1];',
    `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, port], { stdio: ['ignore', 'pipe', 'inherit'] });`,
    'console.log(`grandchild-pid:${grandchild.pid}`);',
    "grandchild.stdout.on('data', (chunk) => process.stdout.write(chunk));",
    "process.once('SIGTERM', () => { console.log('fixture-child-sigterm'); process.exit(0); });",
    "process.once('SIGINT', () => { console.log('fixture-child-sigint'); process.exit(0); });"
  ].join('');
}

const processTreeFixture = signalProcessTreeFixture(grandchildFixture);
const stubbornProcessTreeFixture = signalProcessTreeFixture(stubbornGrandchildFixture);

function exitingProcessTreeFixture(grandchild, code) {
  return [
    "const { spawn } = require('node:child_process');",
    'const port = process.argv[1];',
    `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, port], { stdio: ['ignore', 'pipe', 'inherit'] });`,
    'console.log(`grandchild-pid:${grandchild.pid}`);',
    `grandchild.stdout.on('data', (chunk) => { process.stdout.write(chunk); if (chunk.includes('ready')) process.exit(${code}); });`
  ].join('');
}

async function startHarness(port, identity = 'fixture', commandFixture = fixture) {
  const child = spawn(
    process.execPath,
    [
      'scripts/playwright-web-server.mjs',
      'fixture-harness',
      String(port),
      process.execPath,
      '-e',
      commandFixture,
      String(port),
      identity
    ],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  children.push(child);
  const observation = observeHarnessChild(child);
  return { child, ...observation, output: await observation.waitForOutput('ready') };
}

async function startHarnessWithArguments(port, commandFixture, commandArguments) {
  const child = spawn(
    process.execPath,
    [
      'scripts/playwright-web-server.mjs',
      'fixture-harness',
      String(port),
      process.execPath,
      '-e',
      commandFixture,
      ...commandArguments
    ],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  children.push(child);
  const observation = observeHarnessChild(child);
  return { child, ...observation, output: await observation.waitForOutput('grandchild-ready') };
}

function windowsSupervisorFixture(expectedArguments, exitCode) {
  return [
    "const { spawn } = require('node:child_process');",
    `const expectedArguments = ${JSON.stringify(expectedArguments)};`,
    'const receivedArguments = process.argv.slice(1);',
    'if (JSON.stringify(receivedArguments) !== JSON.stringify(expectedArguments)) { console.error(JSON.stringify({ expectedArguments, receivedArguments })); process.exit(91); }',
    "console.log('argument-fidelity-ok');",
    "console.error('argument-fidelity-stderr');",
    'const port = Number(process.argv[1]);',
    `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildFixture)}, String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });`,
    'console.log(`grandchild-pid:${grandchild.pid}`);',
    "grandchild.stdout.on('data', (chunk) => { process.stdout.write(chunk); if (chunk.includes('grandchild-ready')) {",
    exitCode === undefined ? '' : `  setTimeout(() => process.exit(${exitCode}), 25);`,
    '}});'
  ].join('');
}

function findAdjacentWorktreeBlocks() {
  const worktreesByBase = new Map();
  for (let index = 0; index < 5_000; index += 1) {
    const worktree = `/private/tmp/selene-port-bucket-${index}`;
    const ports = harnessPorts({}, worktree);
    const previousWorktree = worktreesByBase.get(ports.browser - 10);
    if (previousWorktree) return [previousWorktree, worktree];
    worktreesByBase.set(ports.browser, worktree);
  }
  throw new Error('Could not find adjacent deterministic port buckets.');
}

afterEach(
  async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve()))
            )
        )
    );
    await Promise.all(
      children.splice(0).map(async (child) => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await observations.get(child).waitForExit();
      })
    );
  },
  process.platform === 'win32' ? 10_000 : 5_000
);

describe('Harness process observation', () => {
  function childFixture() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    return child;
  }

  it('retains readiness and exit when a fixture finishes before the next await', async () => {
    const child = childFixture();
    const observation = observeHarnessChild(child);
    child.stdout.write('fixture-ready');
    child.emit('exit', 23, null);
    child.stderr.write('final diagnostic');
    child.emit('close', 23, null);

    const output = await observation.waitForOutput('fixture-ready');
    expect(output()).toBe('fixture-ready');
    expect(await observation.waitForExit()).toEqual([23, null]);
    expect(observation.stderr()).toBe('final diagnostic');
  });

  it('reports stdout, stderr and exit status when readiness is missing', async () => {
    const child = childFixture();
    const observation = observeHarnessChild(child);
    child.stdout.write('partial startup');
    child.stderr.write('native supervisor failed');
    child.emit('exit', 91, null);
    child.emit('close', 91, null);

    await expect(observation.waitForOutput('fixture-ready')).rejects.toThrow(
      'Harness exited before fixture-ready (code 91, signal null): stdout: partial startup\nstderr: native supervisor failed'
    );
  });

  it('keeps a finite readiness budget and does not accept stderr as readiness', async () => {
    const child = childFixture();
    const observation = observeHarnessChild(child);
    child.stderr.write('fixture-ready');

    await expect(observation.waitForOutput('fixture-ready', 10)).rejects.toThrow(
      'Timed out waiting for fixture-ready: stdout: \nstderr: fixture-ready'
    );
  });

  it('surfaces a cached spawn error instead of hanging on readiness or exit', async () => {
    const child = childFixture();
    const observation = observeHarnessChild(child);
    const error = Object.assign(new Error('missing supervisor'), { code: 'ENOENT' });
    child.emit('error', error);

    await expect(observation.waitForOutput('ready')).rejects.toBe(error);
    await expect(observation.waitForExit()).rejects.toBe(error);
  });
});

describe('Playwright harness ports', () => {
  it('uses aligned local port blocks, every harness offset, adjacent buckets, and fixed hosted-CI ports', () => {
    const leftWorktree = '/private/tmp/selene-left';
    const left = harnessPorts({}, leftWorktree);
    const base = left.browser;
    expect(base % 10).toBe(0);
    expect(Object.values(left).sort((a, b) => a - b)).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map((offset) => base + offset)
    );

    const [lowerWorktree, higherWorktree] = findAdjacentWorktreeBlocks();
    const lower = harnessPorts({}, lowerWorktree);
    const higher = harnessPorts({}, higherWorktree);
    expect(higher.browser - lower.browser).toBe(10);
    expect(new Set([...Object.values(lower), ...Object.values(higher)])).toHaveLength(14);

    const hostedPorts = {
      browser: 4173,
      accessibilityWeb: 4174,
      accessibilityStorybook: 6009,
      pages: 4177,
      startup: 4176,
      visualStorybook: 6008,
      storybook: 6006
    };
    expect(harnessPorts({ CI: 'true' }, leftWorktree)).toEqual(hostedPorts);
    expect(harnessPorts({ CI: '1' }, leftWorktree)).toEqual(hostedPorts);
    expect(harnessPorts({ CI: 'false' }, leftWorktree)).toEqual(left);
    expect(harnessPorts({ CI: false }, leftWorktree)).toEqual(left);
    expect(harnessPorts({ CI: '' }, leftWorktree)).toEqual(left);
    expect(harnessPorts({ CI: '0' }, leftWorktree)).toEqual(left);
    expect(() => harnessPorts({ SELENE_HARNESS_PORT_BASE: '46001' }, leftWorktree)).toThrow(
      'must align to 10-port blocks'
    );
    expect(isHostedCi({ CI: true })).toBe(true);
    expect(isHostedCi({ CI: 'TRUE' })).toBe(true);
    expect(isHostedCi({ CI: 'false' })).toBe(false);
    expect(isHostedCi({ CI: '' })).toBe(false);
  });

  it('fails clearly when an unrelated service occupies the harness port', async () => {
    const port = await reservePort();
    const server = createServer((_, response) => response.end('unrelated service'));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port }, resolve);
    });
    servers.push(server);

    await expect(assertHarnessPortAvailable('browser E2E', port)).rejects.toThrow(
      'already occupied by an unrelated service'
    );
  });

  it(
    'starts separate harnesses concurrently and proves each worktree identity',
    async () => {
      const leftWorktree = '/private/tmp/selene-left';
      const rightWorktree = '/private/tmp/selene-right';
      const left = harnessPorts({}, leftWorktree);
      const right = harnessPorts({}, rightWorktree);
      const leftIdentity = harnessIdentity(leftWorktree);
      const rightIdentity = harnessIdentity(rightWorktree);
      expect(left.browser).not.toBe(right.browser);
      expect(leftIdentity).not.toBe(rightIdentity);

      await Promise.all([
        startHarness(left.browser, leftIdentity),
        startHarness(right.browser, rightIdentity)
      ]);
      expect(await (await fetch(`http://127.0.0.1:${left.browser}`)).text()).toBe(leftIdentity);
      expect(await (await fetch(`http://127.0.0.1:${right.browser}`)).text()).toBe(rightIdentity);
    },
    concurrentIdentityTimeoutMs
  );

  it.each(['SIGTERM', 'SIGINT'])(
    'terminates the harness process tree with %s and releases its grandchild port',
    async (requestedSignal) => {
      const port = await reservePort();
      const { child, output, waitForExit } = await startHarness(port, 'unused', processTreeFixture);
      const pid = grandchildPid(output);
      child.kill(requestedSignal);
      const [, signal] = await waitForExit();

      expect(signal).toBe(requestedSignal);
      // Windows kills the wrapper unconditionally; its Job Object watcher
      // handles descendants. On POSIX, prove actual signal forwarding too.
      if (process.platform !== 'win32')
        expect(output()).toContain(`fixture-child-${requestedSignal.toLowerCase()}`);
      await waitForProcessGone(pid);
      expectProcessGone(pid);
      await expectPortReusable(port);
    },
    harnessLifecycleTimeoutMs
  );

  it.each([0, 23])(
    'forces cleanup of a stubborn grandchild after direct-child exit code %i',
    async (expectedCode) => {
      const port = await reservePort();
      const { output, waitForExit } = await startHarness(
        port,
        'unused',
        exitingProcessTreeFixture(stubbornGrandchildFixture, expectedCode)
      );
      const pid = grandchildPid(output);
      const [code, signal] = await waitForExit();

      expect(code).toBe(expectedCode);
      expect(signal).toBeNull();
      await waitForProcessGone(pid);
      expectProcessGone(pid);
      await expectPortReusable(port);
    },
    harnessLifecycleTimeoutMs
  );

  it('only ignores an absent POSIX process group and surfaces termination failures', async () => {
    const absent = Object.assign(new Error('gone'), { code: 'ESRCH' });
    await expect(
      terminateProcessTree({ pid: 123 }, 'SIGTERM', false, {
        platform: 'linux',
        killProcess: () => {
          throw absent;
        }
      })
    ).resolves.toBeUndefined();

    const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
    await expect(
      terminateProcessTree({ pid: 123 }, 'SIGTERM', false, {
        platform: 'linux',
        killProcess: () => {
          throw denied;
        }
      })
    ).rejects.toBe(denied);
  });

  it('treats an already-gone Windows supervisor as completed cleanup', async () => {
    const gone = Object.assign(new Error('gone'), { code: 'ESRCH' });
    await expect(
      terminateProcessTree({ pid: 456 }, 'SIGTERM', false, {
        platform: 'win32',
        killProcess: () => {
          throw gone;
        }
      })
    ).resolves.toBeUndefined();
  });

  it('requires strict ports, portable Storybook invocations, strict CI configuration, and a race-free Windows job supervisor', async () => {
    const [browser, a11y, startup, visual, storybook, windowsJob, supervisor, ci] =
      await Promise.all([
        readFile('playwright.config.ts', 'utf8'),
        readFile('playwright.a11y.config.ts', 'utf8'),
        readFile('playwright.startup.config.ts', 'utf8'),
        readFile('playwright.visual.config.ts', 'utf8'),
        readFile('scripts/start-storybook.mjs', 'utf8'),
        readFile('scripts/harness-windows-job.ps1', 'utf8'),
        readFile('scripts/harness-server-process.mjs', 'utf8'),
        readFile('.github/workflows/ci.yml', 'utf8')
      ]);

    expect(browser).toContain('--strictPort');
    expect(a11y).toContain('--strictPort');
    expect(startup).toContain('--strictPort');
    expect(a11y).toContain('--exact-port');
    expect(visual).toContain('--exact-port');
    expect(storybook).toContain('--exact-port');
    expect(`${a11y}${visual}${storybook}`).not.toContain('./node_modules/.bin/storybook');
    expect(browser).toContain('bun run --cwd apps/web dev');
    expect(a11y).toContain('bun run --cwd apps/web preview');
    expect(startup).toContain('bun run --cwd apps/web preview');
    expect(a11y).toContain('bun run storybook:serve');
    expect(visual).toContain('bun run storybook:serve');
    expect(`${browser}${a11y}${startup}${visual}`).not.toContain('bun x');
    expect(storybook).toContain("command: 'bun'");
    expect(storybook).toContain("'storybook:serve'");
    expect(`${browser}${a11y}${startup}${visual}`).not.toContain('process.env.CI');
    for (const config of [browser, a11y, startup, visual]) {
      expect(config).toContain('const hostedCi = isHostedCi();');
    }
    expect(windowsJob).toContain('JobObjectLimitKillOnJobClose');
    expect(windowsJob).toContain('CreateSuspended');
    expect(windowsJob).toContain('startupInfo.dwFlags = StartfUseStdHandles');
    expect(windowsJob).toContain('startupInfo.hStdInput = input');
    expect(windowsJob).toContain('startupInfo.hStdOutput = output');
    expect(windowsJob).toContain('startupInfo.hStdError = error');
    expect(windowsJob).toContain(
      'DuplicateHandle(current, source, current, out duplicate, 0, true'
    );
    expect(windowsJob.indexOf('Require(AssignProcessToJobObject')).toBeLessThan(
      windowsJob.indexOf('if (ResumeThread')
    );
    expect(windowsJob).toContain('OpenProcess(Synchronize');
    expect(supervisor).not.toContain('taskkill');
    expect(ci).toContain('windows-harness-supervisor');
    expect(ci).toContain('name: Windows harness supervisor');
    expect(ci).toContain('runs-on: windows-latest');
  });
});

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('POSIX harness supervisor', () => {
  it('uses parent-death cleanup to force a silent stubborn descendant after wrapper SIGKILL', async () => {
    const port = await reservePort();
    const { child, output, waitForExit } = await startHarness(
      port,
      'unused',
      stubbornProcessTreeFixture
    );
    const pid = grandchildPid(output);
    child.kill('SIGKILL');
    const [, signal] = await waitForExit();

    expect(signal).toBe('SIGKILL');
    await waitForProcessGone(pid);
    expectProcessGone(pid);
    await expectPortReusable(port);
  });
});

const describeWindows = process.platform === 'win32' ? describe : describe.skip;

describeWindows('Windows harness supervisor', () => {
  it.each([0, 23])(
    'preserves arguments and releases descendants after child exit %i',
    async (expectedCode) => {
      const port = await reservePort();
      const commandArguments = [
        String(port),
        'spaces stay intact',
        'embedded"quote',
        'trailing\\',
        'spaces with trailing\\',
        'slashes\\before"quote',
        'unicode-π',
        ''
      ];
      const { output, stderr, waitForExit } = await startHarnessWithArguments(
        port,
        windowsSupervisorFixture(commandArguments, expectedCode),
        commandArguments
      );
      const pid = grandchildPid(output);
      const [code, signal] = await waitForExit();

      expect(output()).toContain('argument-fidelity-ok');
      expect(stderr()).toContain('argument-fidelity-stderr');
      expect(code).toBe(expectedCode);
      expect(signal).toBeNull();
      await waitForProcessGone(pid);
      expectProcessGone(pid);
      await expectPortReusable(port);
    },
    harnessLifecycleTimeoutMs
  );

  it(
    'kills the Job Object descendants when the wrapper dies abruptly',
    async () => {
      const port = await reservePort();
      const commandArguments = [String(port), 'wrapper-death'];
      const { child, output, stderr, waitForExit } = await startHarnessWithArguments(
        port,
        windowsSupervisorFixture(commandArguments),
        commandArguments
      );
      const pid = grandchildPid(output);
      child.kill('SIGTERM');
      const [, signal] = await waitForExit();

      expect(signal).toBe('SIGTERM');
      expect(output()).toContain('argument-fidelity-ok');
      expect(stderr()).toContain('argument-fidelity-stderr');
      await waitForProcessGone(pid);
      expectProcessGone(pid);
      await expectPortReusable(port);
    },
    harnessLifecycleTimeoutMs
  );
});
