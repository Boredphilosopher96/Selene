import { createServer } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { assertHarnessPortAvailable, harnessPorts } from './playwright-harness.mjs';

const servers = [];

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
    const port = 54_321;
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
});
