import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  createSafeEnvironment,
  ElectronAgentHost,
  redactEnvironment,
  validateAgentLaunchConfig
} from './agent-host';

const fixturePath = fileURLToPath(new URL('./agent-host.fixture.mjs', import.meta.url));

function host(
  mode: string,
  overrides: Partial<ConstructorParameters<typeof ElectronAgentHost>[0]> = {}
) {
  return new ElectronAgentHost({
    command: process.execPath,
    args: [fixturePath, mode],
    capabilityGrants: ['simulation.run'],
    workspace: { root: process.cwd(), readOnly: true },
    helloTimeoutMs: 1_000,
    cancellationTimeoutMs: 20,
    ...overrides
  });
}

describe('ElectronAgentHost', () => {
  it('streams events from a directly spawned argv process', async () => {
    const events: string[] = [];
    const agent = host('stream');
    await expect(
      agent.request(
        'simulation.run',
        { source: 'test' },
        { onEvent: (event) => events.push(event.event) }
      )
    ).resolves.toEqual({ snapshotId: 'fixture-1' });
    expect(events).toEqual(['progress', 'completed']);
    agent.stop();
  });

  it('rejects malformed JSONL, hello timeout, and nonzero process failures', async () => {
    await expect(host('malformed').start()).rejects.toMatchObject({ code: 'MALFORMED_PROTOCOL' });
    await expect(host('silent', { helloTimeoutMs: 50 }).start()).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT'
    });
    await expect(host('nonzero').start()).rejects.toMatchObject({ code: 'PROCESS_FAILURE' });
  });

  it('sends cancellation and terminates a request that ignores its timeout', async () => {
    const controller = new AbortController();
    const cancellable = host('cancel');
    await cancellable.start();
    const pending = cancellable.request('simulation.run', {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    cancellable.stop();

    const timed = host('stuck');
    await expect(timed.request('simulation.run', {}, { timeoutMs: 5 })).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT'
    });
    timed.stop();
  });

  it('allows only explicit safe environment keys and redacts diagnostics', () => {
    expect(createSafeEnvironment({ LANG: 'en_US.UTF-8', API_TOKEN: 'secret' })).toEqual({
      LANG: 'en_US.UTF-8'
    });
    expect(redactEnvironment({ API_TOKEN: 'secret', LANG: 'en_US.UTF-8' })).toEqual({
      API_TOKEN: '[REDACTED]',
      LANG: 'en_US.UTF-8'
    });
  });

  it('rejects unsafe launch configuration before spawning', () => {
    expect(() =>
      validateAgentLaunchConfig({
        command: ' node',
        args: ['-e'],
        capabilityGrants: [],
        workspace: { root: 'relative', readOnly: true }
      })
    ).toThrow(/command/);
  });
});
