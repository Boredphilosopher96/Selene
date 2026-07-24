import {
  type HostedOidcBff,
  type HostedBffSession,
  assertSameOriginPost,
  parseBffCookie,
  serializeBffCookie,
  validateReturnTo
} from '@selene/identity-runtime';
import type { HostCallContext } from '@selene/host-runtime';

import type { IdentityProvider } from './auth.js';
import {
  cancellationFromAbortSignal,
  createOidcEffectRunner,
  type OidcEffectRunner
} from './oidc-effects.js';

type BffRouteFailureCode = 'invalid_request' | 'csrf';
const routeFailures = new WeakMap<object, BffRouteFailureCode>();
class BffRouteFailure extends Error {
  constructor(code: BffRouteFailureCode) {
    super(code);
    routeFailures.set(this, code);
  }
}

export interface ExternalSubjectResolver {
  resolveExternalSubject(
    session: HostedBffSession,
    signal?: AbortSignal
  ): Promise<
    | { readonly userId: string; readonly organizationId: string; readonly accessVersion: number }
    | undefined
  >;
}

/** Authenticates only an opaque server-side BFF session, never a browser identity header. */
export function createBffIdentityProvider(
  bff: HostedOidcBff,
  resolver: ExternalSubjectResolver,
  effects: OidcEffectRunner = createOidcEffectRunner()
): IdentityProvider {
  const resolveExternalSubject = captureResolver(resolver);
  const resolverOwner = {
    async resolve(context: HostCallContext, session: HostedBffSession) {
      const cancellation = adapterSignal(context);
      try {
        return await Reflect.apply(resolveExternalSubject.method, resolveExternalSubject.target, [
          session,
          cancellation.signal
        ]);
      } finally {
        cancellation.release();
      }
    }
  };
  const owner = {
    async authenticate(context: HostCallContext, request: Request): Promise<string | undefined> {
      let sessionId: string | undefined;
      try {
        sessionId = parseBffCookie(request.headers.get('cookie'), '__Host-selene_session');
      } catch {
        return undefined;
      }
      if (!sessionId) return undefined;
      const inherited = effects.fromHostContext(context);
      const session = await bff.authenticate(inherited, sessionId);
      if (!session) return undefined;
      let identity: ReturnType<typeof normalizeResolvedIdentity> | undefined;
      try {
        identity = normalizeResolvedIdentity(
          await effects.run(resolverOwner, 'resolve', [session], inherited)
        );
      } catch {
        await bff.revokeSession(inherited, sessionId).catch(() => undefined);
        return undefined;
      }
      if (!identity) {
        await bff.revokeSession(inherited, sessionId);
        return undefined;
      }
      if (session.organizationId === undefined && session.accessVersion === undefined) {
        const bound = await bff.bindSessionAccess(inherited, sessionId, identity);
        if (bound) return identity.userId;
        const current = await bff.authenticate(inherited, sessionId);
        if (current && matchesAccess(current, identity)) return identity.userId;
        await bff.revokeSession(inherited, sessionId);
        return undefined;
      }
      if (!matchesAccess(session, identity)) {
        await bff.revokeSession(inherited, sessionId);
        return undefined;
      }
      return identity.userId;
    }
  };
  return {
    authenticate(request) {
      return effects.run<string | undefined>(
        owner,
        'authenticate',
        [request],
        undefined,
        cancellationFromAbortSignal(request.signal)
      );
    }
  };
}

function matchesAccess(
  session: HostedBffSession,
  identity: { readonly organizationId: string; readonly accessVersion: number }
): boolean {
  return (
    session.organizationId === identity.organizationId &&
    session.accessVersion === identity.accessVersion
  );
}

function captureResolver(value: ExternalSubjectResolver): {
  readonly target: object;
  readonly method: ExternalSubjectResolver['resolveExternalSubject'];
} {
  try {
    let cursor: object | null = value as object;
    let descriptor: PropertyDescriptor | undefined;
    const seen = new Set<object>();
    let reads = 0;
    for (let depth = 0; cursor && !descriptor && depth < 4; depth += 1) {
      if (seen.has(cursor)) throw new Error();
      seen.add(cursor);
      if (++reads > 4) throw new Error();
      descriptor = Object.getOwnPropertyDescriptor(cursor, 'resolveExternalSubject');
      cursor = Object.getPrototypeOf(cursor);
    }
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function')
      throw new Error();
    return Object.freeze({
      target: value as object,
      method: descriptor.value as ExternalSubjectResolver['resolveExternalSubject']
    });
  } catch {
    throw new Error('External subject resolver is invalid');
  }
}

function normalizeResolvedIdentity(
  value: Awaited<ReturnType<ExternalSubjectResolver['resolveExternalSubject']>>
):
  | { readonly userId: string; readonly organizationId: string; readonly accessVersion: number }
  | undefined {
  if (value === undefined) return undefined;
  try {
    if (!value || typeof value !== 'object') throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const required = new Set(['userId', 'organizationId', 'accessVersion']);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== required.size ||
      keys.some((key) => typeof key !== 'string' || !required.has(key))
    )
      throw new Error();
    if (
      Object.values(descriptors).some(
        (descriptor) => !('value' in descriptor) || descriptor.enumerable !== true
      )
    )
      throw new Error();
    const userId =
      descriptors.userId && 'value' in descriptors.userId ? descriptors.userId.value : undefined;
    const organizationId =
      descriptors.organizationId && 'value' in descriptors.organizationId
        ? descriptors.organizationId.value
        : undefined;
    const accessVersion =
      descriptors.accessVersion && 'value' in descriptors.accessVersion
        ? descriptors.accessVersion.value
        : undefined;
    if (
      typeof userId !== 'string' ||
      typeof organizationId !== 'string' ||
      typeof accessVersion !== 'number' ||
      !Number.isSafeInteger(accessVersion) ||
      accessVersion < 1 ||
      userId.length < 1 ||
      userId.length > 512 ||
      organizationId.length < 1 ||
      organizationId.length > 512
    ) {
      throw new Error();
    }
    return Object.freeze({ userId, organizationId, accessVersion });
  } catch {
    throw new Error('External subject resolver result is invalid');
  }
}

export interface OidcBffHttpHandler {
  fetch(request: Request): Promise<Response | undefined>;
}

/** Hosted BFF routes; this handler must run before application routes. */
export function createOidcBffHttpHandler(
  bff: HostedOidcBff,
  applicationOrigin: string,
  effects: OidcEffectRunner = createOidcEffectRunner()
): OidcBffHttpHandler {
  const origin = configuredOrigin(applicationOrigin);
  const owner = {
    async fetch(context: HostCallContext, request: Request): Promise<Response | undefined> {
      return fetchBffRoute(
        bff,
        applicationOrigin,
        origin,
        effects.fromHostContext(context),
        request
      );
    }
  };
  return {
    fetch(request) {
      return effects.run<Response | undefined>(
        owner,
        'fetch',
        [request],
        undefined,
        cancellationFromAbortSignal(request.signal)
      );
    }
  };
}

async function fetchBffRoute(
  bff: HostedOidcBff,
  applicationOrigin: string,
  origin: string,
  context: Parameters<HostedOidcBff['begin']>[0],
  request: Request
): Promise<Response | undefined> {
  let loginRoute = false;
  let callbackRoute = false;
  let logoutRoute = false;
  try {
    const url = new URL(request.url);
    if (url.origin !== origin) {
      throw new BffRouteFailure('invalid_request');
    }
    loginRoute = url.pathname === '/auth/login';
    callbackRoute = url.pathname === '/auth/callback';
    logoutRoute = url.pathname === '/auth/logout';
    if (loginRoute || callbackRoute || logoutRoute) await assertEmptyBffBody(request, context);
    if (loginRoute && request.method === 'GET') {
      let returnTo: string | undefined;
      try {
        returnTo = validateReturnTo(url.searchParams.get('returnTo') ?? undefined);
      } catch {
        throw new BffRouteFailure('invalid_request');
      }
      const started = await bff.begin(context, returnTo);
      return redirect(started.authorizationUrl.href, {
        'set-cookie': serializeBffCookie(
          '__Host-selene_oidc_tx',
          started.transactionId,
          bff.transactionCookieMaxAgeSeconds()
        )
      });
    }
    if (callbackRoute && request.method === 'GET') {
      const transactionId = parseBffCookie(request.headers.get('cookie'), '__Host-selene_oidc_tx');
      if (!transactionId) throw new BffRouteFailure('invalid_request');
      const result = await bff.complete(context, url, transactionId);
      const response = redirect(result.returnTo, {});
      response.headers.append(
        'set-cookie',
        serializeBffCookie(
          '__Host-selene_session',
          result.session.id,
          bff.cookieMaxAgeSeconds(result.session)
        )
      );
      response.headers.append('set-cookie', clearCookie('__Host-selene_oidc_tx'));
      return response;
    }
    if (logoutRoute && request.method === 'POST') {
      try {
        assertSameOriginPost(request, applicationOrigin);
      } catch {
        throw new BffRouteFailure('csrf');
      }
      const sessionId = parseBffCookie(request.headers.get('cookie'), '__Host-selene_session');
      const endSessionUrl = sessionId ? await bff.logout(context, sessionId) : undefined;
      return Response.json(
        endSessionUrl ? { endSessionUrl: endSessionUrl.href } : { status: 'logged_out' },
        {
          status: 200,
          headers: {
            'set-cookie': clearCookie('__Host-selene_session'),
            ...securityHeaders()
          }
        }
      );
    }
    if (loginRoute || callbackRoute || logoutRoute) {
      throw new BffRouteFailure('invalid_request');
    }
  } catch (error) {
    // Never return provider error details, codes, tokens, or assertion data to a browser.
    return Response.json(
      { error: browserErrorCode(error) },
      {
        status: statusFor(error),
        headers: {
          ...securityHeaders(),
          ...(loginRoute || callbackRoute
            ? { 'set-cookie': clearCookie('__Host-selene_oidc_tx') }
            : logoutRoute
              ? { 'set-cookie': clearCookie('__Host-selene_session') }
              : {})
        }
      }
    );
  }
  return undefined;
}

function redirect(location: string, headers: Record<string, string>): Response {
  return new Response(null, {
    status: 303,
    headers: { location, ...securityHeaders(), ...headers }
  });
}

function securityHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-store, max-age=0',
    pragma: 'no-cache',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff'
  };
}

async function assertEmptyBffBody(
  request: Request,
  context: Parameters<HostedOidcBff['begin']>[0]
): Promise<void> {
  const length = request.headers.get('content-length');
  if (
    request.headers.has('transfer-encoding') ||
    (length !== null && (!/^0+$/.test(length) || length.length > 8))
  ) {
    throw new BffRouteFailure('invalid_request');
  }
  if (!request.body) return;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let rejectWait: ((reason: Error) => void) | undefined;
  let cancelled = false;
  let drain: Promise<void> | undefined;
  let cancellation: Promise<void> | undefined;
  try {
    reader = request.body.getReader();
    const cancel = () => {
      cancelled = true;
      rejectWait?.(new Error('OIDC BFF request body cancelled'));
      cancellation ??= reader?.cancel().catch(() => undefined) ?? Promise.resolve();
    };
    unsubscribe = context.cancellation.subscribe(cancel);
    if (context.cancellation.isCancellationRequested() || context.remainingDurationMs < 1)
      throw new Error();
    deadline = setTimeout(cancel, context.remainingDurationMs);
    const read = reader.read();
    drain = read.then(
      () => undefined,
      () => undefined
    );
    const first = await Promise.race([
      read,
      new Promise<never>((_resolve, reject) => {
        rejectWait = reject;
      })
    ]);
    if (!first || cancelled || !first.done) throw new Error();
  } catch {
    throw new BffRouteFailure('invalid_request');
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    try {
      unsubscribe?.();
    } catch {}
    cancellation ??= reader?.cancel().catch(() => undefined) ?? Promise.resolve();
    // Cleanup is intentionally detached: a hostile stream may never settle. Both losers are
    // observed, and the lock is released only after their real eventual settlement.
    void Promise.allSettled([cancellation, drain ?? Promise.resolve()]).then(() => {
      try {
        reader?.releaseLock();
      } catch {}
    });
  }
}

function clearCookie(name: '__Host-selene_session' | '__Host-selene_oidc_tx'): string {
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
}

function browserErrorCode(error: unknown): string {
  return routeFailures.get(error as object) === 'csrf' ? 'csrf' : 'authentication_failed';
}

function statusFor(error: unknown): number {
  const code = routeFailures.get(error as object);
  if (code === 'csrf') return 403;
  if (code === 'invalid_request') return 400;
  return 503;
}

function adapterSignal(context: HostCallContext): {
  readonly signal: AbortSignal;
  release(): void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let unsubscribe: (() => void) | undefined;
  let released = false;
  try {
    if (context.cancellation.isCancellationRequested()) abort();
    unsubscribe = context.cancellation.subscribe(abort);
    return Object.freeze({
      signal: controller.signal,
      release() {
        if (released) return;
        released = true;
        try {
          unsubscribe?.();
        } catch {}
      }
    });
  } catch (error) {
    try {
      unsubscribe?.();
    } catch {}
    throw error;
  }
}

function configuredOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new Error('BFF application origin is invalid');
  }
}
