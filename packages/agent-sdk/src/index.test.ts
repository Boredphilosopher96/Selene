import { describe, expect, it } from 'vitest';

import {
  AGENT_PROTOCOL_VERSION,
  AgentProtocolError,
  AgentProtocolSession,
  DeterministicFakeAdapter,
  parseJsonlEnvelope
} from './index';

const hello = {
  protocolVersion: AGENT_PROTOCOL_VERSION,
  kind: 'hello' as const,
  messageId: 'host-1',
  sentAt: '2026-07-23T20:30:00Z',
  capabilities: ['project.inspect', 'simulation.run']
};

describe('agent protocol', () => {
  it('parses and negotiates a schema-compatible hello frame', () => {
    const parsed = parseJsonlEnvelope(JSON.stringify(hello));
    expect(parsed).toEqual(hello);
    const session = new AgentProtocolSession(['simulation.run']);
    session.acceptHello(parsed);
    expect(session.supports('simulation.run')).toBe(true);
    expect(session.supports('project.inspect')).toBe(false);
  });

  it('rejects malformed JSON and duplicate keys', () => {
    expect(() => parseJsonlEnvelope('{not json}')).toThrow(AgentProtocolError);
    expect(() =>
      parseJsonlEnvelope(
        '{"protocolVersion":"1.0","protocolVersion":"1.0","kind":"hello","messageId":"one","sentAt":"2026-07-23T20:30:00Z","capabilities":[]}'
      )
    ).toThrow(/Duplicate JSON object key/);
  });

  it('streams deterministic events and cooperatively observes cancellation', async () => {
    const adapter = new DeterministicFakeAdapter({
      'simulation.run': {
        events: [
          { event: 'progress', output: { percent: 50 } },
          { event: 'completed', output: { snapshotId: 'snapshot-1' } }
        ]
      }
    });
    const controller = new AbortController();
    const stream = adapter.stream({
      requestId: 'request-1',
      capability: 'simulation.run',
      input: {},
      signal: controller.signal
    });
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { event: 'progress' } });
    controller.abort();
    await expect(iterator.next()).rejects.toThrow(/cancelled/);
  });
});
