import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collaborationBudgets,
  createInMemoryCollaborationRepository,
  type CollaborationHostContext
} from './index';
import { createCollaborationService } from './service';

function fixture(maxRequestsPerMinute?: number) {
  const createContext = vi.fn(({ signal }: { signal?: AbortSignal; timeoutMs: number }) => {
    const context: CollaborationHostContext = {
      signal: signal ?? new AbortController().signal,
      run: async (operation) => operation(context),
      runPort: async (_port, _method, operation) => operation(context),
      dispose: () => undefined
    };
    return context;
  });
  const service = createCollaborationService({
    repository: createInMemoryCollaborationRepository(),
    authorizer: { authorize: async () => true },
    ids: { next: (kind) => `${kind}:limit` },
    hostContextFactory: { create: createContext },
    ...(maxRequestsPerMinute === undefined ? {} : { maxRequestsPerMinute })
  });
  const request = (headers: HeadersInit = {}, method = 'GET') =>
    new Request('https://service.test/healthz', { headers, method });
  return { service, createContext, request };
}

afterEach(() => vi.restoreAllMocks());

describe('shared collaboration request rate gate', () => {
  it('shares configured counters with the ordinary handler and exempts preflight', async () => {
    const { service, createContext, request } = fixture(2);
    const headers = { 'x-selene-user-id': 'owner:alpha' };
    expect(service.rateLimit(request(headers))).toBeUndefined();
    expect(service.rateLimit(request(headers, 'OPTIONS'))).toBeUndefined();
    expect((await service(request(headers, 'OPTIONS'))).status).toBe(204);
    expect((await service(request(headers))).status).toBe(200);
    expect(service.rateLimit(request(headers))?.status).toBe(429);
    expect((await service(request(headers))).status).toBe(429);
    expect(createContext).toHaveBeenCalledTimes(1);
  });

  it('retains the 120-request default without resetting the host-route counter', async () => {
    const { service, request } = fixture();
    for (let index = 0; index < 119; index += 1)
      expect(service.rateLimit(request())).toBeUndefined();
    expect((await service(request())).status).toBe(200);
    expect(service.rateLimit(request())?.status).toBe(429);
    expect((await service(request())).status).toBe(429);
  });

  it('preserves authenticated, share-token and anonymous identity keys across both paths', async () => {
    const { service, request } = fixture(1);
    expect(service.rateLimit(request({ 'x-selene-share-token': 'guest:first' }))).toBeUndefined();
    expect((await service(request({ 'x-selene-share-token': 'guest:first' }))).status).toBe(429);
    expect((await service(request({ 'x-selene-share-token': 'guest:second' }))).status).toBe(200);
    expect(service.rateLimit(request({ 'x-selene-share-token': 'guest:second' }))?.status).toBe(
      429
    );
    expect(service.rateLimit(request())).toBeUndefined();
    expect((await service(request())).status).toBe(429);
    expect(
      service.rateLimit(
        request({ 'x-selene-user-id': 'owner:alpha', 'x-selene-share-token': 'guest:first' })
      )
    ).toBeUndefined();
    expect(
      (
        await service(
          request({ 'x-selene-user-id': 'owner:alpha', 'x-selene-share-token': 'guest:second' })
        )
      ).status
    ).toBe(429);
  });

  it('retains the oversized share-token rejection before allocating a user counter', async () => {
    const { service, createContext, request } = fixture(1);
    expect(
      service.rateLimit(
        request({
          'x-selene-user-id': 'owner:alpha',
          'x-selene-share-token': 'x'.repeat(collaborationBudgets.maxText + 1)
        })
      )?.status
    ).toBe(429);
    expect((await service(request({ 'x-selene-user-id': 'owner:alpha' }))).status).toBe(200);
    expect(createContext).toHaveBeenCalledTimes(1);
  });

  it('bounds identity counters to 10000 and recovers capacity when their minute expires', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const { service, createContext, request } = fixture(1);
    for (let index = 0; index < 10_000; index += 1)
      expect(service.rateLimit(request({ 'x-selene-user-id': `owner:${index}` }))).toBeUndefined();
    const overflow = request({ 'x-selene-user-id': 'owner:overflow' });
    expect(service.rateLimit(overflow)?.status).toBe(429);
    expect((await service(overflow)).status).toBe(429);
    expect(createContext).not.toHaveBeenCalled();
    now.mockReturnValue(1_800_000_059_999);
    expect(service.rateLimit(overflow)?.status).toBe(429);
    now.mockReturnValue(1_800_000_060_000);
    expect((await service(overflow)).status).toBe(200);
    expect(service.rateLimit(overflow)?.status).toBe(429);
    expect(createContext).toHaveBeenCalledTimes(1);
  });
});
