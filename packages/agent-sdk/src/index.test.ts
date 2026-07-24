import { describe, expect, it } from 'vitest';

import {
  AGENT_PROTOCOL_VERSION,
  AgentProtocolError,
  AgentProtocolSession,
  createAgentProviderRuntimeError,
  DeterministicFakeAdapter,
  MAX_JSONL_LINE_BYTES,
  normalizeAdapterError,
  parseJsonlEnvelope,
  recoverAdapterGeneration,
  replaceAdapterGeneration,
  snapshotJsonValue,
  streamValidatedEvents,
  validateAdapter,
  validateExecution
} from './index';

const providerContext = {
  ownerGeneration: 1,
  cancellation: {
    isCancellationRequested: () => false,
    reason: () => undefined,
    subscribe: () => () => undefined
  }
} as const;
function directRuntime(
  run: <T>(owner: object, effect: (context: typeof providerContext) => T) => Promise<T>
) {
  return {
    run,
    runCleanup: run,
    replaceGeneration: () => undefined,
    recover: () => undefined
  };
}

const providerRuntime = directRuntime(
  async <T>(_owner: object, effect: (context: typeof providerContext) => T) =>
    effect(providerContext)
);
const streamOptions = { runtime: providerRuntime };

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
    expect(() =>
      session.acceptIncoming({
        protocolVersion: '1.0',
        kind: 'error',
        messageId: parsed.messageId,
        sentAt: '2026-07-23T20:30:01Z',
        code: 'DUPLICATE',
        message: 'duplicate'
      })
    ).toThrow(/Duplicate messageId/);
  });

  it('rejects malformed JSON and duplicate keys', () => {
    expect(() => parseJsonlEnvelope('{not json}')).toThrow(AgentProtocolError);
    expect(() =>
      parseJsonlEnvelope(
        '{"protocolVersion":"1.0","protocolVersion":"1.0","kind":"hello","messageId":"one","sentAt":"2026-07-23T20:30:00Z","capabilities":[]}'
      )
    ).toThrow(/Duplicate JSON object key/);
  });

  it('streams deterministic terminal events', async () => {
    const adapter = new DeterministicFakeAdapter({
      'simulation.run': {
        events: [
          { event: 'progress', output: { percent: 50 } },
          { event: 'completed', output: { snapshotId: 'snapshot-1' } }
        ]
      }
    });
    const stream = adapter.stream(providerContext, {
      requestId: 'request-1',
      capability: 'simulation.run',
      input: {}
    });
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { event: 'progress' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { event: 'completed' } });
  });

  it('enforces byte, depth, value, string, number, duplicate, and dangerous-key budgets', () => {
    const valid = JSON.stringify(hello);
    expect(() => parseJsonlEnvelope(valid, valid.length - 1)).toThrow(/exceeds/);
    expect(() => parseJsonlEnvelope('[[[[[]]]]]', { maximumDepth: 4 })).toThrow(/depth/);
    expect(() => parseJsonlEnvelope('[0,1,2]', { maximumValues: 2 })).toThrow(/count/);
    expect(() => parseJsonlEnvelope('"toolong"', { maximumStringBytes: 3 })).toThrow(/string/);
    expect(() => parseJsonlEnvelope('123456', { maximumNumberCharacters: 3 })).toThrow(/number/);
    expect(() =>
      parseJsonlEnvelope(
        '{"protocolVersion":"1.0","kind":"hello","messageId":"one","sentAt":"2026-07-23T20:30:00Z","capabilities":[],"__proto__":{}}'
      )
    ).toThrow(/Dangerous/);
    let budgetGetterCalls = 0;
    expect(() =>
      parseJsonlEnvelope(JSON.stringify(hello), {
        get maximumBytes() {
          budgetGetterCalls += 1;
          return MAX_JSONL_LINE_BYTES;
        }
      } as never)
    ).toThrow(/data properties/);
    expect(budgetGetterCalls).toBe(0);
  });

  it('rejects noncanonical time, non-JSON whitespace, and caller-owned cancellation signals', () => {
    expect(() =>
      parseJsonlEnvelope(JSON.stringify({ ...hello, sentAt: '2026-02-30T20:30:00Z' }))
    ).toThrow(/date-time/);
    expect(() => parseJsonlEnvelope(`\u00a0${JSON.stringify(hello)}`)).toThrow(AgentProtocolError);
    expect(() =>
      validateExecution({
        requestId: 'request-1',
        capability: 'simulation.run',
        input: {},
        signal: { aborted: false }
      })
    ).toThrow(/unknown field/);
    expect(() =>
      validateExecution({
        requestId: 'request-1',
        capability: 'simulation.run',
        input: {},
        unexpected: true
      })
    ).toThrow(/unknown field/);
  });

  it('takes deep immutable snapshots without invoking accessors or accepting cycles', () => {
    let getterCalls = 0;
    const hostile = {};
    Object.defineProperty(hostile, 'input', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return {};
      }
    });
    expect(() =>
      validateExecution({ requestId: 'r-1', capability: 'simulation.run', input: hostile })
    ).toThrow(/accessor|data properties|JSON objects/);
    expect(getterCalls).toBe(0);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => snapshotJsonValue(cyclic)).toThrow(/Cyclic/);

    const source = { nested: { list: [{ value: 1 }] } };
    const snapshot = snapshotJsonValue(source) as { nested: { list: Array<{ value: number }> } };
    source.nested.list[0]!.value = 2;
    expect(snapshot.nested.list[0]!.value).toBe(1);
    expect(Object.isFrozen(snapshot.nested.list)).toBe(true);
    expect(Object.isFrozen(snapshot.nested.list[0]!)).toBe(true);

    class HostileArray extends Array<unknown> {}
    expect(() => snapshotJsonValue(new HostileArray())).toThrow(/plain prototypes/);
    expect(() => snapshotJsonValue([1, 2], { maximumArrayLength: 1 })).toThrow(/array length/);
    expect(() =>
      snapshotJsonValue(
        { first: 'value', second: 'value' },
        { maximumBytes: 20, maximumStringBytes: 16 }
      )
    ).toThrow(/byte budget/);
    expect(() => snapshotJsonValue([[]], { maximumDepth: 1 })).toThrow(/nesting depth/);
  });

  it('revalidates forged hello and execution values, and permits only one hello per session', () => {
    const session = new AgentProtocolSession(['simulation.run']);
    const mutableHello = { ...hello, capabilities: ['simulation.run'] } as typeof hello;
    session.acceptHello(mutableHello);
    mutableHello.capabilities[0] = 'project.inspect';
    expect(session.supports('simulation.run')).toBe(true);
    expect(() => session.acceptHello(hello)).toThrow(/already been accepted/);
    expect(() =>
      validateExecution({ requestId: 'request-1', capability: 'SIMULATION.RUN', input: {} })
    ).toThrow(/capability/);
    const tooManyCapabilities = Array.from({ length: 129 }, (_, index) => `capability.${index}`);
    expect(() => new AgentProtocolSession(tooManyCapabilities)).toThrow(/at most 128/);
  });

  it('snapshots fake scenarios and normalizes hostile adapter errors and events', async () => {
    const source = {
      'simulation.run': {
        events: [
          { event: 'progress', output: { percent: 50 } },
          { event: 'completed', output: {} }
        ]
      }
    };
    const adapter = new DeterministicFakeAdapter(source);
    source['simulation.run']!.events[0]!.output!.percent = 100;
    const events = [];
    for await (const event of adapter.stream(providerContext, {
      requestId: 'request-1',
      capability: 'simulation.run',
      input: {}
    }))
      events.push(event);
    expect(events[0]?.output).toEqual({ percent: 50 });
    expect(Object.isFrozen(events[0]?.output)).toBe(true);

    const broken = {
      capabilities: ['simulation.run'],
      stream() {
        throw new Error('x'.repeat(2_000));
      }
    };
    const iterator = streamValidatedEvents(
      broken,
      {
        requestId: 'request-1',
        capability: 'simulation.run',
        input: {}
      },
      streamOptions
    );
    await expect(iterator.next()).rejects.toMatchObject({ code: 'ADAPTER_FAILURE' });
    expect(normalizeAdapterError(new Error('x'.repeat(2_000))).message.length).toBeLessThanOrEqual(
      512
    );
    expect(
      new AgentProtocolError('ADAPTER_FAILURE', '\ud83d\ude00'.repeat(1_000)).message
    ).toSatisfy((message) => new TextEncoder().encode(message).byteLength <= 512);
  });

  it('rejects forged adapter accessors, undeclared capabilities, and invalid stream lifecycles', async () => {
    let getterCalls = 0;
    const forged = {
      get capabilities() {
        getterCalls += 1;
        return ['simulation.run'];
      },
      async *stream() {}
    };
    expect(() => validateAdapter(forged)).toThrow(/data property/);
    expect(getterCalls).toBe(0);

    const undeclared = {
      capabilities: ['project.inspect'],
      async *stream() {
        yield {};
      }
    };
    const undeclaredIterator = streamValidatedEvents(
      undeclared,
      {
        requestId: 'request-1',
        capability: 'simulation.run',
        input: {}
      },
      streamOptions
    );
    await expect(undeclaredIterator.next()).rejects.toThrow(/does not declare/);

    const wrongRequest = {
      capabilities: ['simulation.run'],
      async *stream() {
        yield {
          protocolVersion: '1.0',
          kind: 'event' as const,
          messageId: 'event-1',
          sentAt: '2026-07-23T20:30:00Z',
          requestId: 'other-request',
          event: 'completed'
        };
      }
    };
    const wrongRequestIterator = streamValidatedEvents(
      wrongRequest,
      {
        requestId: 'request-1',
        capability: 'simulation.run',
        input: {}
      },
      streamOptions
    );
    await expect(wrongRequestIterator.next()).rejects.toThrow(/active request/);

    const noTerminal = {
      capabilities: ['simulation.run'],
      async *stream() {
        yield {
          protocolVersion: '1.0',
          kind: 'event' as const,
          messageId: 'event-1',
          sentAt: '2026-07-23T20:30:00Z',
          requestId: 'request-1',
          event: 'progress'
        };
      }
    };
    const noTerminalIterator = streamValidatedEvents(
      noTerminal,
      {
        requestId: 'request-1',
        capability: 'simulation.run',
        input: {}
      },
      streamOptions
    );
    await expect(noTerminalIterator.next()).resolves.toMatchObject({
      value: { event: 'progress' }
    });
    await expect(noTerminalIterator.next()).rejects.toThrow(/terminal event/);
  });

  it('does not observe accessor-bearing iterator results', async () => {
    let getterCalls = 0;
    const result = {};
    Object.defineProperty(result, 'done', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return true;
      }
    });
    const adapter = {
      capabilities: ['simulation.run'],
      stream() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                return Promise.resolve(result);
              },
              return() {
                return Promise.resolve({ done: true });
              }
            };
          }
        };
      }
    };
    const iterator = streamValidatedEvents(
      adapter,
      {
        requestId: 'request-1',
        capability: 'simulation.run',
        input: {}
      },
      streamOptions
    );
    await expect(iterator.next()).rejects.toThrow(/data properties/);
    expect(getterCalls).toBe(0);
  });

  it('closes an adapter iterator when its consumer cancels', async () => {
    let closed = false;
    const adapter = {
      capabilities: ['simulation.run'],
      stream() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                return Promise.resolve({
                  done: false,
                  value: {
                    protocolVersion: '1.0',
                    kind: 'event',
                    messageId: 'event-1',
                    sentAt: '2026-07-23T20:30:00Z',
                    requestId: 'request-1',
                    event: 'progress'
                  }
                });
              },
              return() {
                closed = true;
                return Promise.resolve({ done: true });
              }
            };
          }
        };
      }
    };
    const iterator = streamValidatedEvents(
      adapter,
      {
        requestId: 'request-1',
        capability: 'simulation.run',
        input: {}
      },
      streamOptions
    )[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(closed).toBe(true);
  });

  it('does not trust an adapter-forged protocol classification', async () => {
    const adapter = {
      capabilities: ['simulation.run'],
      stream() {
        throw new AgentProtocolError('BUDGET_EXCEEDED', 'forged');
      }
    };
    const iterator = streamValidatedEvents(
      adapter,
      {
        requestId: 'request-1',
        capability: 'simulation.run',
        input: {}
      },
      streamOptions
    );
    await expect(iterator.next()).rejects.toMatchObject({ code: 'ADAPTER_FAILURE' });
  });

  it('preserves host validation classifications while normalizing adapter failures', async () => {
    const invalidEvent = {
      capabilities: ['simulation.run'],
      async *stream() {
        yield { event: 'not-an-envelope' };
      }
    };
    const iterator = streamValidatedEvents(
      invalidEvent,
      {
        requestId: 'request-1',
        capability: 'simulation.run',
        input: {}
      },
      streamOptions
    );
    await expect(iterator.next()).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });
  });

  it('rejects forged runtime ports and gives each adapter one stable runtime owner', async () => {
    const owners = new Set<object>();
    const trackingRuntime = directRuntime(
      async <T>(owner: object, effect: (context: typeof providerContext) => T): Promise<T> => {
        owners.add(owner);
        return effect(providerContext);
      }
    );
    const adapter = new DeterministicFakeAdapter({
      'simulation.run': { events: [{ event: 'completed', output: {} }] }
    });
    await Promise.all(
      ['request-1', 'request-2'].map((requestId) => {
        const stream = streamValidatedEvents(
          adapter,
          { requestId, capability: 'simulation.run', input: {} },
          { runtime: trackingRuntime }
        );
        return expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
          value: { event: 'completed' }
        });
      })
    );
    expect(owners.size).toBe(1);

    const forgedRuntime = {};
    const forged = streamValidatedEvents(
      adapter,
      { requestId: 'request-3', capability: 'simulation.run', input: {} },
      { runtime: forgedRuntime as never }
    );
    await expect(forged[Symbol.asyncIterator]().next()).rejects.toThrow(/runtime.*run function/i);
  });

  it('preserves only factory-issued runtime outcome classifications', async () => {
    const adapter = new DeterministicFakeAdapter({
      'simulation.run': { events: [{ event: 'completed', output: {} }] }
    });
    const expected = {
      CALLER_ABORTED: 'CANCELLED',
      DEADLINE_EXCEEDED: 'BUDGET_EXCEEDED',
      OWNER_CAPACITY_REACHED: 'BUDGET_EXCEEDED',
      OWNER_QUARANTINED: 'BUDGET_EXCEEDED',
      PROCESS_CAPACITY_REACHED: 'BUDGET_EXCEEDED',
      EFFECT_FAILED: 'ADAPTER_FAILURE'
    } as const;
    await Promise.all(
      Object.entries(expected).map(([outcome, code]) => {
        const stream = streamValidatedEvents(
          adapter,
          { requestId: `request-${outcome}`, capability: 'simulation.run', input: {} },
          {
            runtime: directRuntime(async () =>
              Promise.reject(createAgentProviderRuntimeError(outcome))
            )
          }
        );
        return expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code });
      })
    );
    const forged = streamValidatedEvents(
      adapter,
      { requestId: 'request-forged', capability: 'simulation.run', input: {} },
      {
        runtime: directRuntime(async () =>
          Promise.reject({ code: 'DEADLINE_EXCEEDED', secret: 'nope' })
        )
      }
    );
    await expect(forged[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'ADAPTER_FAILURE'
    });
  });

  it('captures lifecycle methods as data functions and redacts lifecycle failures', () => {
    const adapter = new DeterministicFakeAdapter({
      'simulation.run': { events: [{ event: 'completed', output: {} }] }
    });
    let getterCalls = 0;
    const accessorRuntime = {
      ...providerRuntime,
      get replaceGeneration() {
        getterCalls += 1;
        return () => undefined;
      }
    };
    expect(() => replaceAdapterGeneration(adapter, accessorRuntime as never)).toThrow(
      /data property/
    );
    expect(getterCalls).toBe(0);

    const factoryFailure = {
      ...providerRuntime,
      replaceGeneration: () => {
        throw createAgentProviderRuntimeError('OWNER_QUARANTINED');
      }
    };
    expect(() => replaceAdapterGeneration(adapter, factoryFailure)).toThrow(
      expect.objectContaining({ code: 'BUDGET_EXCEEDED' })
    );
    const secretFailure = {
      ...providerRuntime,
      recover: () => {
        throw new Error('private lifecycle detail');
      }
    };
    expect(() => recoverAdapterGeneration(adapter, secretFailure)).toThrow(
      expect.objectContaining({ code: 'ADAPTER_FAILURE' })
    );
  });

  it('enforces request IDs and terminal lifecycle transitions in sessions', () => {
    const session = new AgentProtocolSession(['simulation.run']);
    session.acceptHello({ ...hello, capabilities: ['simulation.run'] });
    session.beginRequest('request-1', 'simulation.run');
    session.acceptIncoming({
      protocolVersion: '1.0',
      kind: 'event',
      messageId: 'event-1',
      sentAt: '2026-07-23T20:30:00Z',
      requestId: 'request-1',
      event: 'completed'
    });
    expect(() =>
      session.acceptIncoming({
        protocolVersion: '1.0',
        kind: 'event',
        messageId: 'event-2',
        sentAt: '2026-07-23T20:30:00Z',
        requestId: 'request-1',
        event: 'progress'
      })
    ).toThrow(/terminal requestId/);

    session.beginRequest('request-2', 'simulation.run');
    session.cancelRequest('request-2');
    expect(() =>
      session.acceptIncoming({
        protocolVersion: '1.0',
        kind: 'event',
        messageId: 'event-3',
        sentAt: '2026-07-23T20:30:00Z',
        requestId: 'request-2',
        event: 'completed'
      })
    ).toThrow(/Cancelled request completed/);
    expect(() =>
      session.acceptIncoming({
        protocolVersion: '1.0',
        kind: 'event',
        messageId: 'event-3',
        sentAt: '2026-07-23T20:30:00Z',
        requestId: 'request-2',
        event: 'cancelled'
      })
    ).not.toThrow();
  });

  it('accepts arbitrary interleaved v1 IDs and commits message state only after validation', () => {
    const session = new AgentProtocolSession(['simulation.run']);
    session.acceptIncoming({
      ...hello,
      messageId: 'hello-any-id',
      capabilities: ['simulation.run']
    });
    session.beginRequest('4f16f2ac-4a0c-4e95-8600-68a4bd5c0ace', 'simulation.run');
    session.beginRequest('custom-request:two', 'simulation.run');
    expect(() =>
      session.acceptIncoming({
        protocolVersion: '1.0',
        kind: 'event',
        messageId: 'message-z',
        sentAt: '2026-07-23T20:30:00Z',
        requestId: 'unknown',
        event: 'progress'
      })
    ).toThrow(/Unknown or terminal/);
    expect(() =>
      session.acceptIncoming({
        protocolVersion: '1.0',
        kind: 'event',
        messageId: 'message-z',
        sentAt: '2026-07-23T20:30:00Z',
        requestId: 'custom-request:two',
        event: 'progress'
      })
    ).not.toThrow();
    expect(() =>
      session.acceptIncoming({
        protocolVersion: '1.0',
        kind: 'error',
        messageId: 'global-error',
        sentAt: '2026-07-23T20:30:00Z',
        code: 'ADAPTER_UNAVAILABLE',
        message: 'redacted'
      })
    ).not.toThrow();
    expect(() =>
      session.acceptIncoming({
        protocolVersion: '1.0',
        kind: 'event',
        messageId: 'message-a',
        sentAt: '2026-07-23T20:30:00Z',
        requestId: '4f16f2ac-4a0c-4e95-8600-68a4bd5c0ace',
        event: 'completed'
      })
    ).not.toThrow();
    session.close();
    expect(session.supports('simulation.run')).toBe(false);
    expect(() => session.beginRequest('after-close', 'simulation.run')).toThrow(/closed/);
    expect(() => session.acceptIncoming({ ...hello, messageId: 'after-close' })).toThrow(/closed/);
  });

  it('reclaims completed session requests while bounding replay and message IDs', () => {
    const session = new AgentProtocolSession(['simulation.run']);
    session.acceptHello({ ...hello, capabilities: ['simulation.run'] });
    for (let index = 0; index < 1_025; index += 1) {
      const requestId = `request-${index}`;
      session.beginRequest(requestId, 'simulation.run');
      session.acceptIncoming({
        protocolVersion: '1.0',
        kind: 'event',
        messageId: `event-${index}`,
        sentAt: '2026-07-23T20:30:00Z',
        requestId,
        event: 'completed'
      });
    }
    expect(() => session.beginRequest('request-1025', 'simulation.run')).not.toThrow();
    expect(() => session.beginRequest('request-0', 'simulation.run')).not.toThrow();
    expect(() =>
      session.acceptIncoming({
        protocolVersion: '1.0',
        kind: 'event',
        messageId: 'event-0',
        sentAt: '2026-07-23T20:30:00Z',
        requestId: 'request-1025',
        event: 'completed'
      })
    ).not.toThrow();
  });

  it('does not burn a request ID when capacity rejects its transition', () => {
    const session = new AgentProtocolSession(['simulation.run']);
    session.acceptHello({ ...hello, capabilities: ['simulation.run'] });
    for (let index = 0; index < 1_024; index += 1)
      session.beginRequest(`active-${index}`, 'simulation.run');
    expect(() => session.beginRequest('later-valid', 'simulation.run')).toThrow(/Too many/);
    session.acceptIncoming({
      protocolVersion: '1.0',
      kind: 'event',
      messageId: 'complete-one',
      sentAt: '2026-07-23T20:30:00Z',
      requestId: 'active-0',
      event: 'completed'
    });
    expect(() => session.beginRequest('later-valid', 'simulation.run')).not.toThrow();
  });

  it('rejects a deterministic corpus of malformed JSON without escaping its budget', () => {
    const corpus = ['{', '[', '"\\u0000"', '{"a":1,}', '[1,]', '1e9999', '{"constructor":0}'];
    for (const line of corpus) expect(() => parseJsonlEnvelope(line)).toThrow(AgentProtocolError);
  });
});
