import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';

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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForOutput(child, expected) {
  let output = '';
  const onData = (chunk) => {
    output += chunk;
  };
  child.stdout.on('data', onData);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(reject, new Error(`Timed out waiting for ${expected}: ${output}`)),
      5_000
    );
    const onError = (error) => finish(reject, error);
    const onExit = (code, signal) =>
      finish(
        reject,
        new Error(`Harness exited before ${expected} (code ${code}, signal ${signal}): ${output}`)
      );
    const checkOutput = () => {
      if (output.includes(expected)) finish(resolve);
    };
    const finish = (complete, value) => {
      clearTimeout(timeout);
      child.stdout.removeListener('data', checkOutput);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      complete(value);
    };
    child.stdout.on('data', checkOutput);
    child.once('error', onError);
    child.once('exit', onExit);
  });
  return () => output;
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

async function expectPortReusable(port, remainingAttempts = 20) {
  try {
    await assertHarnessPortAvailable('grandchild fixture', port);
  } catch (error) {
    if (remainingAttempts === 1) throw error;
    await delay(50);
    await expectPortReusable(port, remainingAttempts - 1);
  }
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
  "for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => console.log(`ignored-${signal}`));"
].join('');

const processTreeFixture = [
  "const { spawn } = require('node:child_process');",
  'const port = process.argv[1];',
  `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildFixture)}, port], { stdio: ['ignore', 'pipe', 'inherit'] });`,
  "grandchild.stdout.on('data', (chunk) => process.stdout.write(chunk));",
  "process.once('SIGTERM', () => { console.log('fixture-child-sigterm'); process.exit(0); });",
  "process.once('SIGINT', () => { console.log('fixture-child-sigint'); process.exit(0); });"
].join('');

function exitingProcessTreeFixture(grandchild, code) {
  return [
    "const { spawn } = require('node:child_process');",
    'const port = process.argv[1];',
    `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, port], { stdio: ['ignore', 'pipe', 'inherit'] });`,
    `grandchild.stdout.on('data', (chunk) => { process.stdout.write(chunk); if (chunk.includes('ready')) setTimeout(() => process.exit(${code}), 25); });`
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
  return { child, output: await waitForOutput(child, 'ready') };
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
  return { child, output: await waitForOutput(child, 'grandchild-ready') };
}

function windowsSupervisorFixture(expectedArguments, exitCode) {
  return [
    "const { spawn } = require('node:child_process');",
    `const expectedArguments = ${JSON.stringify(expectedArguments)};`,
    'const receivedArguments = process.argv.slice(1);',
    'if (JSON.stringify(receivedArguments) !== JSON.stringify(expectedArguments)) { console.error(JSON.stringify({ expectedArguments, receivedArguments })); process.exit(91); }',
    "console.log('argument-fidelity-ok');",
    'const port = Number(process.argv[1]);',
    `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildFixture)}, String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });`,
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

afterEach(async () => {
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
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    })
  );
});

describe('Playwright harness ports', () => {
  it('uses aligned local port blocks, every harness offset, adjacent buckets, and fixed hosted-CI ports', () => {
    const leftWorktree = '/private/tmp/selene-left';
    const left = harnessPorts({}, leftWorktree);
    const base = left.browser;
    expect(base % 10).toBe(0);
    expect(Object.values(left).sort((a, b) => a - b)).toEqual(
      [0, 1, 2, 3, 4, 5].map((offset) => base + offset)
    );

    const [lowerWorktree, higherWorktree] = findAdjacentWorktreeBlocks();
    const lower = harnessPorts({}, lowerWorktree);
    const higher = harnessPorts({}, higherWorktree);
    expect(higher.browser - lower.browser).toBe(10);
    expect(new Set([...Object.values(lower), ...Object.values(higher)])).toHaveLength(12);

    const hostedPorts = {
      browser: 4173,
      accessibilityWeb: 4174,
      accessibilityStorybook: 6009,
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

  it('starts separate harnesses concurrently and proves each worktree identity', async () => {
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
  });

  it('terminates the harness process tree and releases its grandchild port', async () => {
    const port = await reservePort();
    const { child } = await startHarness(port, 'unused', processTreeFixture);
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    const [, signal] = await exit;

    expect(signal).toBe('SIGTERM');
    await expectPortReusable(port);
  });

  it.each([0, 23])(
    'forces cleanup of a stubborn grandchild after direct-child exit code %i',
    async (expectedCode) => {
      const port = await reservePort();
      const { child } = await startHarness(
        port,
        'unused',
        exitingProcessTreeFixture(stubbornGrandchildFixture, expectedCode)
      );
      const [code, signal] = await once(child, 'exit');

      expect(code).toBe(expectedCode);
      expect(signal).toBeNull();
      await expectPortReusable(port);
    }
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
    expect(a11y).toContain('bun x --bun storybook');
    expect(visual).toContain('bun x --bun storybook');
    expect(storybook).toContain("command: 'bun'");
    expect(`${browser}${a11y}${startup}${visual}`).not.toContain('process.env.CI');
    for (const config of [browser, a11y, startup, visual]) {
      expect(config).toContain('const hostedCi = isHostedCi();');
    }
    expect(windowsJob).toContain('JobObjectLimitKillOnJobClose');
    expect(windowsJob).toContain('CreateSuspended');
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
  it('cleans descendants and releases the port after the wrapper is SIGKILLed', async () => {
    const port = await reservePort();
    const { child } = await startHarness(port, 'unused', processTreeFixture);
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    const [, signal] = await exit;

    expect(signal).toBe('SIGKILL');
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
        ''
      ];
      const { child, output } = await startHarnessWithArguments(
        port,
        windowsSupervisorFixture(commandArguments, expectedCode),
        commandArguments
      );
      const [code, signal] = await once(child, 'exit');

      expect(output()).toContain('argument-fidelity-ok');
      expect(code).toBe(expectedCode);
      expect(signal).toBeNull();
      await expectPortReusable(port);
    }
  );

  it('kills the Job Object descendants when the wrapper dies abruptly', async () => {
    const port = await reservePort();
    const commandArguments = [String(port), 'wrapper-death'];
    const { child, output } = await startHarnessWithArguments(
      port,
      windowsSupervisorFixture(commandArguments),
      commandArguments
    );
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    await exit;

    expect(output()).toContain('argument-fidelity-ok');
    await expectPortReusable(port);
  });
});
