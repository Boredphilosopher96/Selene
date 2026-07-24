import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { assertHarnessPortAvailable, harnessPorts } from './playwright-harness.mjs';

const servers = [];
const children = [];

async function waitForOutput(child, expected) {
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${expected}: ${output}`)),
      5_000
    );
    const checkOutput = () => {
      if (!output.includes(expected)) return;
      clearTimeout(timeout);
      child.stdout.removeListener('data', checkOutput);
      resolve();
    };
    child.stdout.on('data', checkOutput);
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      reject(
        new Error(`Harness exited before ${expected} (code ${code}, signal ${signal}): ${output}`)
      )
    );
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

async function startFixtureHarness(port) {
  const fixture = [
    "const { createServer } = require('node:http');",
    "const server = createServer((_, response) => response.end('fixture'));",
    "server.listen({ host: '127.0.0.1', port: Number(process.argv[1]) }, () => console.log('fixture-ready'));",
    "process.once('SIGTERM', () => { console.log('fixture-sigterm'); server.close(() => process.exit(0)); });",
    "process.once('SIGINT', () => { console.log('fixture-sigint'); server.close(() => process.exit(0)); });"
  ].join('');
  const child = spawn(
    process.execPath,
    [
      'scripts/playwright-web-server.mjs',
      'fixture-harness',
      String(port),
      process.execPath,
      '-e',
      fixture,
      String(port)
    ],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  children.push(child);
  return { child, output: await waitForOutput(child, 'fixture-ready') };
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
  it('uses deterministic, distinct local port blocks per worktree and fixed hosted-CI ports', () => {
    const left = harnessPorts({}, '/private/tmp/selene-left');
    const right = harnessPorts({}, '/private/tmp/selene-right');
    expect(left).not.toEqual(right);
    expect(harnessPorts({ CI: 'true' }, '/private/tmp/selene-left')).toEqual({
      browser: 4173,
      accessibilityWeb: 4174,
      accessibilityStorybook: 6009,
      startup: 4176,
      visualStorybook: 6008,
      storybook: 6006
    });
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

  it('starts separate harnesses concurrently on their distinct worktree ports', async () => {
    const left = harnessPorts({}, '/private/tmp/selene-left');
    const right = harnessPorts({}, '/private/tmp/selene-right');
    expect(left.browser).not.toBe(right.browser);

    const [leftHarness, rightHarness] = await Promise.all([
      startFixtureHarness(left.browser),
      startFixtureHarness(right.browser)
    ]);
    expect(await fetch(`http://127.0.0.1:${left.browser}`)).toHaveProperty('ok', true);
    expect(await fetch(`http://127.0.0.1:${right.browser}`)).toHaveProperty('ok', true);
    expect(leftHarness.output()).toContain('fixture-ready');
    expect(rightHarness.output()).toContain('fixture-ready');
  });

  it('forwards SIGTERM to a harness child and exits with the same signal', async () => {
    const { child, output } = await startFixtureHarness(await reservePort());
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    const [, signal] = await exit;

    expect(signal).toBe('SIGTERM');
    expect(output()).toContain('fixture-sigterm');
  });

  it('requires strict ports for Vite and Storybook harnesses', async () => {
    const [browser, a11y, startup, visual, storybook] = await Promise.all([
      readFile('playwright.config.ts', 'utf8'),
      readFile('playwright.a11y.config.ts', 'utf8'),
      readFile('playwright.startup.config.ts', 'utf8'),
      readFile('playwright.visual.config.ts', 'utf8'),
      readFile('scripts/start-storybook.mjs', 'utf8')
    ]);

    expect(browser).toContain('--strictPort');
    expect(a11y).toContain('--strictPort');
    expect(startup).toContain('--strictPort');
    expect(a11y).toContain('--exact-port');
    expect(visual).toContain('--exact-port');
    expect(storybook).toContain('--exact-port');
  });
});
