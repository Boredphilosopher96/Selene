/** Node-only hosted OIDC transport. Keep this entrypoint out of browser bundles. */
import { Resolver } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import {
  HostedIdentityError,
  assertPublicOidcAddress,
  type OidcAddressPinnedTransport
} from './index.js';

const MAX_OIDC_REQUEST_BYTES = 65_536;
const MAX_OIDC_RESPONSE_BYTES = 1_048_576;
const OIDC_TRANSPORT_TIMEOUT_MS = 10_000;
const MAX_DNS_ANSWERS = 32;
const MAX_OIDC_BODY_CHUNKS = 1_024;

/** Resolves once, then pins the TLS socket to a verified public DNS answer. */
export function createAddressPinnedOidcTransport(): OidcAddressPinnedTransport {
  return Object.freeze({
    async resolve(hostname: string, signal?: AbortSignal): Promise<readonly string[]> {
      try {
        throwIfAborted(signal);
        const resolver = new Resolver();
        const cancel = () => resolver.cancel();
        signal?.addEventListener('abort', cancel, { once: true });
        let results: readonly PromiseSettledResult<string[]>[];
        try {
          results = await Promise.allSettled([
            resolver.resolve4(hostname),
            resolver.resolve6(hostname)
          ]);
        } finally {
          signal?.removeEventListener('abort', cancel);
        }
        throwIfAborted(signal);
        const records = results.flatMap((result) =>
          result.status === 'fulfilled' ? result.value : []
        );
        if (records.length < 1 || records.length > MAX_DNS_ANSWERS) throw new Error();
        const addresses: string[] = [];
        for (const address of records) {
          assertPublicOidcAddress(address);
          if (!addresses.includes(address)) addresses.push(address);
        }
        return Object.freeze(addresses);
      } catch {
        throw new HostedIdentityError('INVALID_RUNTIME', 'OIDC provider DNS lookup failed');
      }
    },

    async fetch(
      request: Request,
      addresses: readonly string[],
      signal?: AbortSignal
    ): Promise<Response> {
      try {
        throwIfAborted(signal);
        const target = new URL(request.url);
        const address = addresses[0];
        if (!address) throw new Error();
        const declaredLength = request.headers.get('content-length');
        if (
          declaredLength &&
          (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_OIDC_REQUEST_BYTES)
        )
          throw new Error();
        const body = await boundedRequestBody(request, signal);
        return await pinnedHttpsRequest(target, address, request, body, signal);
      } catch {
        throw new HostedIdentityError('INVALID_RUNTIME', 'OIDC provider transport failed');
      }
    }
  });
}

function pinnedHttpsRequest(
  target: URL,
  address: string,
  request: Request,
  body: Buffer | undefined,
  signal?: AbortSignal
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let outgoing: ReturnType<typeof httpsRequest> | undefined;
    let incoming: import('node:http').IncomingMessage | undefined;
    let onOutgoingError: ((error: Error) => void) | undefined;
    let onIncomingError: ((error: Error) => void) | undefined;
    let onIncomingAborted: (() => void) | undefined;
    let onData: ((chunk: Buffer) => void) | undefined;
    let onEnd: (() => void) | undefined;
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      if (deadline !== undefined) clearTimeout(deadline);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      if (outgoing && onOutgoingError) outgoing.removeListener('error', onOutgoingError);
      if (incoming && onIncomingError) incoming.removeListener('error', onIncomingError);
      if (incoming && onIncomingAborted) incoming.removeListener('aborted', onIncomingAborted);
      if (incoming && onData) incoming.removeListener('data', onData);
      if (incoming && onEnd) incoming.removeListener('end', onEnd);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      incoming?.destroy();
      outgoing?.destroy();
      reject(error);
    };
    const succeed = (response: Response) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };
    try {
      outgoing = httpsRequest(
        {
          protocol: 'https:',
          hostname: target.hostname,
          port: 443,
          path: `${target.pathname}${target.search}`,
          method: request.method,
          headers: requestHeaders(request.headers),
          servername: target.hostname,
          rejectUnauthorized: true,
          maxHeaderSize: 16_384,
          lookup(_hostname, _options, callback) {
            callback(null, address, isIP(address));
          }
        },
        (response) => {
          incoming = response;
          onIncomingError = (error) => fail(error);
          onIncomingAborted = () => fail(new Error('OIDC provider response aborted'));
          response.on('error', onIncomingError);
          response.once('aborted', onIncomingAborted);
          const responseLength = response.headers['content-length'];
          if (
            typeof responseLength === 'string' &&
            (!/^\d+$/.test(responseLength) || Number(responseLength) > MAX_OIDC_RESPONSE_BYTES)
          ) {
            fail(new Error('OIDC provider response is too large'));
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          let chunkCount = 0;
          onData = (chunk: Buffer) => {
            chunkCount += 1;
            received += chunk.byteLength;
            if (chunkCount > MAX_OIDC_BODY_CHUNKS || received > MAX_OIDC_RESPONSE_BYTES) {
              fail(new Error('OIDC provider response is too large'));
              return;
            }
            chunks.push(Buffer.from(chunk));
          };
          onEnd = () => {
            try {
              succeed(
                new Response(Buffer.concat(chunks), {
                  status: response.statusCode ?? 502,
                  statusText: response.statusMessage ?? '',
                  headers: responseHeaders(response.rawHeaders)
                })
              );
            } catch (error) {
              fail(
                error instanceof Error ? error : new Error('OIDC provider response is malformed')
              );
            }
          };
          response.on('data', onData);
          response.once('end', onEnd);
        }
      );
      onOutgoingError = (error) => fail(error);
      outgoing.on('error', onOutgoingError);
      onAbort = () => fail(new Error('OIDC provider transport aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      deadline = setTimeout(
        () => fail(new Error('OIDC provider transport timed out')),
        OIDC_TRANSPORT_TIMEOUT_MS
      );
      if (body) outgoing.write(body);
      outgoing.end();
    } catch (error) {
      fail(error instanceof Error ? error : new Error('OIDC provider transport failed'));
    }
  });
}

function requestHeaders(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  let size = 0;
  headers.forEach((value, name) => {
    size += name.length + value.length + 4;
    if (size > 16_384) throw new Error('OIDC request headers are too large');
    output[name] = value;
  });
  return output;
}

async function boundedRequestBody(
  request: Request,
  signal?: AbortSignal
): Promise<Buffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD' || !request.body) return undefined;
  const reader = request.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    const read = async (chunkCount: number, received: number): Promise<Buffer> => {
      throwIfAborted(signal);
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks);
      if (chunkCount >= MAX_OIDC_BODY_CHUNKS) {
        void reader.cancel().catch(() => undefined);
        throw new Error('OIDC provider request has too many chunks');
      }
      received += next.value.byteLength;
      if (received > MAX_OIDC_REQUEST_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new Error('OIDC provider request is too large');
      }
      chunks.push(next.value);
      return read(chunkCount + 1, received);
    };
    return read(0, 0);
  } finally {
    signal?.removeEventListener('abort', cancel);
    try {
      reader.releaseLock();
    } catch {}
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('OIDC provider transport aborted');
}

function responseHeaders(raw: readonly string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index + 1 < raw.length; index += 2)
    headers.append(raw[index]!, raw[index + 1]!);
  return headers;
}
