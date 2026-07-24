import {
  HostedIdentityError,
  type HostedOidcBff,
  type HostedBffSession,
  assertSameOriginPost,
  parseBffCookie,
  serializeBffCookie
} from '@selene/identity-runtime';

import type { IdentityProvider } from './auth.js';

export interface ExternalSubjectResolver {
  resolveExternalSubject(
    session: HostedBffSession
  ): Promise<
    | { readonly userId: string; readonly organizationId: string; readonly accessVersion: number }
    | undefined
  >;
}

/** Authenticates only an opaque server-side BFF session, never a browser identity header. */
export function createBffIdentityProvider(
  bff: HostedOidcBff,
  resolver: ExternalSubjectResolver
): IdentityProvider {
  return {
    async authenticate(request) {
      const sessionId = parseBffCookie(request.headers.get('cookie'), '__Host-selene_session');
      if (!sessionId) return undefined;
      const session = await bff.authenticate(sessionId);
      if (!session) return undefined;
      const identity = await resolver.resolveExternalSubject(session);
      if (!identity) return undefined;
      if (
        session.organizationId !== identity.organizationId ||
        session.accessVersion !== identity.accessVersion
      ) {
        await bff.bindSessionAccess(sessionId, identity);
      }
      return identity.userId;
    }
  };
}

export interface OidcBffHttpHandler {
  fetch(request: Request): Promise<Response | undefined>;
}

/** Hosted BFF routes; this handler must run before application routes. */
export function createOidcBffHttpHandler(
  bff: HostedOidcBff,
  applicationOrigin: string
): OidcBffHttpHandler {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      try {
        if (url.pathname === '/auth/login' && request.method === 'GET') {
          const started = await bff.begin(url.searchParams.get('returnTo') ?? undefined);
          return redirect(started.authorizationUrl.href, {
            'set-cookie': serializeBffCookie('__Host-selene_oidc_tx', started.transactionId, 300)
          });
        }
        if (url.pathname === '/auth/callback' && request.method === 'GET') {
          const transactionId = parseBffCookie(
            request.headers.get('cookie'),
            '__Host-selene_oidc_tx'
          );
          if (!transactionId)
            throw new HostedIdentityError('INVALID_CALLBACK', 'OIDC transaction cookie is missing');
          const result = await bff.complete(url, transactionId);
          const response = redirect(result.returnTo, {});
          response.headers.append(
            'set-cookie',
            serializeBffCookie(
              '__Host-selene_session',
              result.session.id,
              Math.max(1, Math.floor((result.session.expiresAt - Date.now()) / 1_000))
            )
          );
          response.headers.append('set-cookie', clearCookie('__Host-selene_oidc_tx'));
          return response;
        }
        if (url.pathname === '/auth/logout' && request.method === 'POST') {
          assertSameOriginPost(request, applicationOrigin);
          const sessionId = parseBffCookie(request.headers.get('cookie'), '__Host-selene_session');
          const endSessionUrl = sessionId ? await bff.logout(sessionId) : undefined;
          return Response.json(
            endSessionUrl ? { endSessionUrl: endSessionUrl.href } : { status: 'logged_out' },
            { status: 200, headers: { 'set-cookie': clearCookie('__Host-selene_session') } }
          );
        }
      } catch (error) {
        // Never return provider error details, codes, tokens, or assertion data to a browser.
        return Response.json(
          {
            error:
              error instanceof HostedIdentityError
                ? error.code.toLowerCase()
                : 'authentication_failed'
          },
          { status: 400 }
        );
      }
      return undefined;
    }
  };
}

function redirect(location: string, headers: Record<string, string>): Response {
  return new Response(null, { status: 303, headers: { location, ...headers } });
}

function clearCookie(name: '__Host-selene_session' | '__Host-selene_oidc_tx'): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
