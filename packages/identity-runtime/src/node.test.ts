import { describe, expect, it, vi } from 'vitest';

type Listener = (...arguments_: readonly unknown[]) => void;

const fixtures = vi.hoisted(() => {
  const state = {
    resolve4: () => Promise.resolve(['8.8.8.8']),
    resolve6: () => Promise.resolve([] as string[]),
    resolvers: [] as { cancelled: number }[],
    requestCalls: 0,
    requestThrows: false,
    current: undefined as
      | { readonly outgoing: FakeOutgoing; readonly respond: (incoming: FakeIncoming) => void }
      | undefined
  };
  class FakeEvents {
    private readonly listeners = new Map<string, Set<Listener>>();
    public on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? new Set<Listener>();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }
    public once(event: string, listener: Listener): this {
      const once: Listener = (...arguments_) => {
        this.removeListener(event, once);
        listener(...arguments_);
      };
      return this.on(event, once);
    }
    public removeListener(event: string, listener: Listener): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }
    public emit(event: string, ...arguments_: readonly unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...arguments_);
    }
  }
  class FakeOutgoing extends FakeEvents {
    public destroyed = 0;
    public writes = 0;
    public write(): void {
      this.writes += 1;
    }
    public end(): void {}
    public destroy(): void {
      this.destroyed += 1;
    }
  }
  class FakeIncoming extends FakeEvents {
    public readonly headers: Record<string, string | undefined> = {};
    public rawHeaders: string[] = [];
    public statusCode = 200;
    public statusMessage = 'OK';
    public destroyed = 0;
    public destroy(): void {
      this.destroyed += 1;
    }
  }
  class FakeResolver {
    public readonly state = { cancelled: 0 };
    public constructor() {
      state.resolvers.push(this.state);
    }
    public resolve4(): Promise<string[]> {
      return state.resolve4();
    }
    public resolve6(): Promise<string[]> {
      return state.resolve6();
    }
    public cancel(): void {
      this.state.cancelled += 1;
    }
  }
  return { state, FakeIncoming, FakeOutgoing, FakeResolver };
});

vi.mock('node:dns/promises', () => ({ Resolver: fixtures.FakeResolver }));
vi.mock('node:net', () => ({ isIP: () => 4 }));
vi.mock('node:https', () => ({
  request: (
    _options: unknown,
    callback: (incoming: InstanceType<typeof fixtures.FakeIncoming>) => void
  ) => {
    fixtures.state.requestCalls += 1;
    if (fixtures.state.requestThrows) throw new Error('synchronous request failure');
    const outgoing = new fixtures.FakeOutgoing();
    fixtures.state.current = { outgoing, respond: callback };
    return outgoing;
  }
}));

import { HostedIdentityError } from './index';
import { createAddressPinnedOidcTransport } from './node';

class TrackedAbortSignal {
  public aborted = false;
  private readonly listeners = new Set<() => void>();
  public addEventListener(_event: string, listener: () => void): void {
    this.listeners.add(listener);
  }
  public removeEventListener(_event: string, listener: () => void): void {
    this.listeners.delete(listener);
  }
  public abort(): void {
    this.aborted = true;
    for (const listener of [...this.listeners]) listener();
  }
  public count(): number {
    return this.listeners.size;
  }
}

function signal(): TrackedAbortSignal & AbortSignal {
  return new TrackedAbortSignal() as TrackedAbortSignal & AbortSignal;
}

function reset(): void {
  fixtures.state.resolve4 = () => Promise.resolve(['8.8.8.8']);
  fixtures.state.resolve6 = () => Promise.resolve([]);
  fixtures.state.resolvers.length = 0;
  fixtures.state.requestCalls = 0;
  fixtures.state.requestThrows = false;
  fixtures.state.current = undefined;
}

function request(body?: ReadableStream<Uint8Array>): Request {
  return new Request('https://idp.example.test/token', {
    method: body ? 'POST' : 'GET',
    ...(body ? { body, duplex: 'half' as never } : {})
  });
}

function current(): {
  readonly outgoing: InstanceType<typeof fixtures.FakeOutgoing>;
  readonly respond: (incoming: InstanceType<typeof fixtures.FakeIncoming>) => void;
} {
  if (!fixtures.state.current) throw new Error('HTTPS request was not started');
  return fixtures.state.current;
}

async function assertResponseFailure(kind: 'oversized' | 'malformed' | 'aborted'): Promise<void> {
  const cancellation = signal();
  const pending = createAddressPinnedOidcTransport().fetch(request(), ['8.8.8.8'], cancellation);
  await Promise.resolve();
  const started = current();
  const incoming = new fixtures.FakeIncoming();
  if (kind === 'oversized') incoming.headers['content-length'] = '1048577';
  if (kind === 'malformed') incoming.rawHeaders = ['x-test', 'bad\nvalue'];
  const rejected = expect(pending).rejects.toMatchObject<Partial<HostedIdentityError>>({
    code: 'INVALID_RUNTIME'
  });
  started.respond(incoming);
  if (kind === 'malformed') incoming.emit('end');
  if (kind === 'aborted') incoming.emit('aborted');
  await rejected;
  expect(cancellation.count()).toBe(0);
  expect(incoming.destroyed).toBe(1);
  expect(started.outgoing.destroyed).toBe(1);
}

describe('Node OIDC pinned transport', () => {
  it('cancels and detaches failed DNS work', async () => {
    reset();
    let reject4!: (error: Error) => void;
    let reject6!: (error: Error) => void;
    fixtures.state.resolve4 = () => new Promise<string[]>((_, reject) => (reject4 = reject));
    fixtures.state.resolve6 = () => new Promise<string[]>((_, reject) => (reject6 = reject));
    const cancellation = signal();
    const pending = createAddressPinnedOidcTransport().resolve('idp.example.test', cancellation);
    expect(cancellation.count()).toBe(1);
    cancellation.abort();
    reject4(new Error('dns failure'));
    reject6(new Error('dns failure'));
    await expect(pending).rejects.toMatchObject<Partial<HostedIdentityError>>({
      code: 'INVALID_RUNTIME'
    });
    expect(fixtures.state.resolvers[0]?.cancelled).toBe(1);
    expect(cancellation.count()).toBe(0);
  });

  it('rejects synchronous request throws without retaining a cancellation listener', async () => {
    reset();
    fixtures.state.requestThrows = true;
    const cancellation = signal();
    await expect(
      createAddressPinnedOidcTransport().fetch(request(), ['8.8.8.8'], cancellation)
    ).rejects.toMatchObject<Partial<HostedIdentityError>>({ code: 'INVALID_RUNTIME' });
    expect(cancellation.count()).toBe(0);
  });

  it('bounds oversized and many-chunk request bodies before opening HTTPS', async () => {
    reset();
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 1_025; index += 1) controller.enqueue(new Uint8Array([1]));
        controller.close();
      }
    });
    await expect(
      createAddressPinnedOidcTransport().fetch(request(chunks), ['8.8.8.8'])
    ).rejects.toMatchObject<Partial<HostedIdentityError>>({
      code: 'INVALID_RUNTIME'
    });
    expect(fixtures.state.requestCalls).toBe(0);

    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_537));
        controller.close();
      }
    });
    await expect(
      createAddressPinnedOidcTransport().fetch(request(oversized), ['8.8.8.8'])
    ).rejects.toMatchObject<Partial<HostedIdentityError>>({
      code: 'INVALID_RUNTIME'
    });
    expect(fixtures.state.requestCalls).toBe(0);
  });

  it('cleans abort and deadline listeners exactly once after an unsettled HTTPS request', async () => {
    reset();
    vi.useFakeTimers();
    const cancellation = signal();
    const pending = createAddressPinnedOidcTransport().fetch(request(), ['8.8.8.8'], cancellation);
    await Promise.resolve();
    const started = current();
    expect(cancellation.count()).toBe(1);
    const rejected = expect(pending).rejects.toMatchObject<Partial<HostedIdentityError>>({
      code: 'INVALID_RUNTIME'
    });
    cancellation.abort();
    await rejected;
    expect(cancellation.count()).toBe(0);
    expect(started.outgoing.destroyed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('settles one timeout and removes its timer and listener', async () => {
    reset();
    vi.useFakeTimers();
    const cancellation = signal();
    const pending = createAddressPinnedOidcTransport().fetch(request(), ['8.8.8.8'], cancellation);
    await Promise.resolve();
    const started = current();
    expect(vi.getTimerCount()).toBe(1);
    const rejected = expect(pending).rejects.toMatchObject<Partial<HostedIdentityError>>({
      code: 'INVALID_RUNTIME'
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(started.outgoing.destroyed).toBe(1);
    expect(cancellation.count()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('rejects oversized, malformed, and aborted responses while cleaning each request', async () => {
    reset();
    await assertResponseFailure('oversized');
    await assertResponseFailure('malformed');
    await assertResponseFailure('aborted');
  });
});
