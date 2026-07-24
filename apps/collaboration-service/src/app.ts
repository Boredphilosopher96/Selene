import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  createInMemoryCollaborationRepository,
  type CollaborationRepository,
  type ShareTokenSigner
} from '@selene/collaboration';
import { createCollaborationService } from '@selene/collaboration/service';

import type { IdentityProvider } from './auth.js';
import { createHeaderIdentityProvider } from './auth.js';
import type { ServiceEnvironment } from './env.js';

export interface Readiness {
  ready(): Promise<void>;
}

export interface CollaborationApplication {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly ready: () => Promise<void>;
}

function signer(secret: string): ShareTokenSigner {
  const signature = (payload: string) =>
    createHmac('sha256', secret).update(payload).digest('base64url');
  return {
    async sign(payload) {
      return signature(payload);
    },
    async verify(payload, value) {
      const expected = Buffer.from(signature(payload));
      const actual = Buffer.from(value);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
    async hash(token) {
      return createHmac('sha256', secret).update(token).digest('hex');
    }
  };
}

function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set('x-request-id', requestId);
  return new Response(response.body, { status: response.status, headers });
}

export function createCollaborationApplication(
  environment: ServiceEnvironment,
  repository: CollaborationRepository,
  readiness: Readiness = { async ready() {} },
  identityProvider: IdentityProvider = createHeaderIdentityProvider(environment.proxySecret)
): CollaborationApplication {
  const handler = createCollaborationService({
    repository,
    ids: { next: () => randomUUID() },
    allowedOrigins: environment.corsOrigins,
    maxRequestsPerMinute: environment.rateLimitPerMinute,
    shareSigner: signer(environment.shareSecret)
  });
  return {
    ready: () => readiness.ready(),
    async fetch(request) {
      const requestId = request.headers.get('x-request-id') ?? randomUUID();
      if (
        request.headers.get('content-length') &&
        Number(request.headers.get('content-length')) > environment.bodyLimitBytes
      ) {
        return withRequestId(
          new Response(JSON.stringify({ error: 'payload_too_large', requestId }), {
            status: 413,
            headers: { 'content-type': 'application/json' }
          }),
          requestId
        );
      }
      if (new URL(request.url).pathname === '/readyz') {
        try {
          await readiness.ready();
          return withRequestId(Response.json({ status: 'ready' }), requestId);
        } catch {
          return withRequestId(Response.json({ status: 'not_ready' }, { status: 503 }), requestId);
        }
      }
      const identity = await identityProvider.authenticate(request);
      const headers = new Headers(request.headers);
      headers.delete('x-selene-user-id');
      headers.delete('x-selene-proxy-secret');
      if (identity) headers.set('x-selene-user-id', identity);
      const enriched = new Request(request, { headers });
      const started = performance.now();
      const response = await handler(enriched);
      console.info(
        JSON.stringify({
          level: 'info',
          event: 'request',
          requestId,
          method: request.method,
          path: new URL(request.url).pathname,
          status: response.status,
          durationMs: Math.round(performance.now() - started)
        })
      );
      return withRequestId(response, requestId);
    }
  };
}

export function createMemoryApplication(environment: ServiceEnvironment): CollaborationApplication {
  return createCollaborationApplication(environment, createInMemoryCollaborationRepository());
}
