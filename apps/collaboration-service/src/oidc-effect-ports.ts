import type { HostCallContext } from '@selene/host-runtime';
import type {
  HostedBffStore,
  HostedBffSession,
  HostedBffSessionAccess,
  HostedIdentityCallContext,
  HostedOidcBffEffects,
  OidcAuthorizationTransaction,
  OidcRuntime
} from '@selene/identity-runtime';

import type { OidcEffectRunner, OidcInheritedContext } from './oidc-effects.js';

/** Stable owner wrappers: every concrete external port is admitted separately. */
export function createSupervisedOidcBffEffects(
  runtime: OidcRuntime,
  store: HostedBffStore,
  effects: OidcEffectRunner
): HostedOidcBffEffects {
  const runtimeOwner = createRuntimeOwner(runtime);
  const storeOwner = createStoreOwner(store);
  return Object.freeze({
    forContext(context: HostedIdentityCallContext) {
      return Object.freeze({
        runtime: superviseOidcRuntime(effects, context, runtimeOwner),
        store: superviseOidcStore(effects, context, storeOwner)
      });
    }
  });
}

function createRuntimeOwner(runtime: OidcRuntime): object {
  const methods = capturePortMethods(runtime, ['begin', 'exchange', 'revoke', 'endSession']);
  return Object.freeze({
    begin(context: HostCallContext, input: Parameters<OidcRuntime['begin']>[0]) {
      return invokeCaptured(methods, 'begin', [{ ...input, context }]);
    },
    exchange(context: HostCallContext, input: Parameters<OidcRuntime['exchange']>[0]) {
      return invokeCaptured(methods, 'exchange', [{ ...input, context }]);
    },
    revoke(context: HostCallContext, token: string, hint: 'access_token' | 'refresh_token') {
      return invokeCaptured(methods, 'revoke', [token, hint, context]);
    },
    endSession(context: HostCallContext, input: Parameters<OidcRuntime['endSession']>[0]) {
      return invokeCaptured(methods, 'endSession', [{ ...input, context }]);
    }
  });
}

function superviseOidcRuntime(
  effects: OidcEffectRunner,
  inherited: OidcInheritedContext,
  owner: object
): OidcRuntime {
  const supervised: OidcRuntime = {
    begin: (input: Parameters<OidcRuntime['begin']>[0]) =>
      effects.run<Awaited<ReturnType<OidcRuntime['begin']>>>(owner, 'begin', [input], inherited),
    exchange: (input: Parameters<OidcRuntime['exchange']>[0]) =>
      effects.run<Awaited<ReturnType<OidcRuntime['exchange']>>>(
        owner,
        'exchange',
        [input],
        inherited
      ),
    revoke: (
      token: string,
      hint: 'access_token' | 'refresh_token',
      _context?: HostedIdentityCallContext
    ) => effects.run<void>(owner, 'revoke', [token, hint], inherited),
    endSession: (input: Parameters<OidcRuntime['endSession']>[0]) =>
      effects.run<Awaited<ReturnType<OidcRuntime['endSession']>>>(
        owner,
        'endSession',
        [input],
        inherited
      )
  };
  return Object.freeze(supervised);
}

function createStoreOwner(store: HostedBffStore): object {
  const methods = capturePortMethods(store, [
    'createTransaction',
    'consumeTransaction',
    'createSession',
    'readSession',
    'consumeSession',
    'bindSessionAccess',
    'revokeSession'
  ]);
  return Object.freeze({
    createTransaction(context: HostCallContext, value: OidcAuthorizationTransaction) {
      return withContextSignal(context, (signal) =>
        invokeCaptured(methods, 'createTransaction', [value, signal])
      );
    },
    consumeTransaction(context: HostCallContext, id: string) {
      return withContextSignal(context, (signal) =>
        invokeCaptured(methods, 'consumeTransaction', [id, signal])
      );
    },
    createSession(context: HostCallContext, value: HostedBffSession) {
      return withContextSignal(context, (signal) =>
        invokeCaptured(methods, 'createSession', [value, signal])
      );
    },
    readSession(context: HostCallContext, id: string) {
      return withContextSignal(context, (signal) =>
        invokeCaptured(methods, 'readSession', [id, signal])
      );
    },
    consumeSession(context: HostCallContext, id: string) {
      return withContextSignal(context, (signal) =>
        invokeCaptured(methods, 'consumeSession', [id, signal])
      );
    },
    bindSessionAccess(context: HostCallContext, id: string, access: HostedBffSessionAccess) {
      return withContextSignal(context, (signal) =>
        invokeCaptured(methods, 'bindSessionAccess', [id, access, signal])
      );
    },
    revokeSession(context: HostCallContext, id: string) {
      return withContextSignal(context, (signal) =>
        invokeCaptured(methods, 'revokeSession', [id, signal])
      );
    }
  });
}

function superviseOidcStore(
  effects: OidcEffectRunner,
  inherited: OidcInheritedContext,
  owner: object
): HostedBffStore {
  const supervised: HostedBffStore = {
    createTransaction: (value: OidcAuthorizationTransaction, _signal?: AbortSignal) =>
      effects.run<void>(owner, 'createTransaction', [value], inherited),
    consumeTransaction: (id: string, _signal?: AbortSignal) =>
      effects.run<OidcAuthorizationTransaction | undefined>(
        owner,
        'consumeTransaction',
        [id],
        inherited
      ),
    createSession: (value: HostedBffSession, _signal?: AbortSignal) =>
      effects.run<void>(owner, 'createSession', [value], inherited),
    readSession: (id: string, _signal?: AbortSignal) =>
      effects.run<HostedBffSession | undefined>(owner, 'readSession', [id], inherited),
    consumeSession: (id: string, _signal?: AbortSignal) =>
      effects.run<HostedBffSession | undefined>(owner, 'consumeSession', [id], inherited),
    bindSessionAccess: (id: string, access: HostedBffSessionAccess, _signal?: AbortSignal) =>
      effects.run<boolean>(owner, 'bindSessionAccess', [id, access], inherited),
    revokeSession: (id: string, _signal?: AbortSignal) =>
      effects.run<void>(owner, 'revokeSession', [id], inherited)
  };
  return Object.freeze(supervised);
}

function withContextSignal<T>(
  context: HostCallContext,
  action: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const bridge = signalFromContext(context);
  return Promise.resolve()
    .then(() => action(bridge.signal))
    .finally(bridge.release);
}

function signalFromContext(context: HostCallContext): {
  readonly signal: AbortSignal;
  release(): void;
} {
  const controller = new AbortController();
  let release: (() => void) | undefined;
  let released = false;
  try {
    if (context.cancellation.isCancellationRequested()) controller.abort();
    release = context.cancellation.subscribe(() => controller.abort());
    return Object.freeze({
      signal: controller.signal,
      release() {
        if (released) return;
        released = true;
        try {
          release?.();
        } catch {}
      }
    });
  } catch (error) {
    try {
      release?.();
    } catch {}
    throw error;
  }
}

function capturePortMethods(
  value: object,
  names: readonly string[]
): Readonly<{
  target: object;
  methods: Readonly<Record<string, (...arguments_: never[]) => unknown>>;
}> {
  const captured: Record<string, (...arguments_: never[]) => unknown> = {};
  const pending = new Set(names);
  let cursor: object | null = value;
  const seen = new Set<object>();
  let reads = 0;
  for (let depth = 0; cursor && pending.size > 0 && depth < 4; depth += 1) {
    if (seen.has(cursor)) throw new TypeError('OIDC adapter methods are invalid');
    seen.add(cursor);
    for (const name of [...pending]) {
      if (++reads > 128) throw new TypeError('OIDC adapter methods are invalid');
      const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
      if (!descriptor) continue;
      if (!('value' in descriptor) || typeof descriptor.value !== 'function')
        throw new TypeError(`OIDC ${name} adapter method is invalid`);
      captured[name] = descriptor.value;
      pending.delete(name);
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  if (pending.size) throw new TypeError('OIDC adapter methods are invalid');
  return Object.freeze({ target: value, methods: Object.freeze(captured) });
}

function invokeCaptured(
  captured: Readonly<{
    target: object;
    methods: Readonly<Record<string, (...arguments_: never[]) => unknown>>;
  }>,
  name: string,
  arguments_: readonly unknown[]
): never {
  return Reflect.apply(captured.methods[name]!, captured.target, arguments_ as never[]) as never;
}
