import { expect, test } from 'vitest';

import { createHostedReviewHttpProvider } from './hosted-review-http-provider';

const binding = {
  tenantId: 'tenant-review',
  projectId: 'project-review',
  artifactId: 'artifact-review',
  revisionId: 'revision-review',
  baselineId: 'baseline-review',
  version: 1
} as const;

const create = {
  type: 'create' as const,
  binding,
  operationId: 'review-operation-1',
  threadId: 'review-thread-1',
  expectedVersion: 0,
  body: 'Keep the current review state.',
  anchor: {
    selector: '[data-review-order="1048"]',
    component: 'OrderStatus',
    point: { x: 0.5, y: 0.5 },
    region: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 }
  }
};

function deepLink() {
  const url = new URL('https://review.example.test/orders');
  url.hash = new URLSearchParams({
    'selene-review': encodeURIComponent(
      JSON.stringify({
        selector: create.anchor.selector,
        component: create.anchor.component,
        pointX: create.anchor.point.x,
        pointY: create.anchor.point.y
      })
    )
  }).toString();
  return url.toString();
}

function thread(body = create.body) {
  return {
    id: create.threadId,
    projectId: binding.projectId,
    version: 1,
    deepLink: deepLink(),
    lifecycle: 'open',
    createdBy: 'reviewer-1',
    createdAt: '2026-07-26T12:00:00.000Z',
    messages: [
      {
        id: `${create.operationId}:message`,
        body,
        createdBy: 'reviewer-1',
        createdAt: '2026-07-26T12:00:00.000Z'
      }
    ],
    anchor: {
      evidence: {
        artifactId: binding.artifactId,
        revisionId: binding.revisionId,
        screenId: 'orders'
      },
      target: { kind: 'region', region: create.anchor.region }
    }
  };
}

function provider(responses: readonly Response[]) {
  let call = 0;
  return createHostedReviewHttpProvider({
    serviceUrl: 'https://service.example.test',
    reviewUrl: 'https://review.example.test/orders',
    revisionFingerprint: 'a'.repeat(64),
    screenId: 'orders',
    fetch: async () => responses[call++]!
  });
}

function responseWithJson(value: unknown, status = 200): Response {
  const response = new Response('{}', { status });
  Object.defineProperty(response, 'json', { value: async () => value });
  return response;
}

test('fails closed for malformed same-project remote records rather than filtering them out', async () => {
  let reads = 0;
  const malformed = Object.create(null);
  Object.defineProperty(malformed, 'id', {
    enumerable: true,
    get() {
      reads += 1;
      return create.threadId;
    }
  });
  await expect(
    provider([responseWithJson({ threads: [malformed] })]).list(binding)
  ).rejects.toThrow('review-list:invalid');
  expect(reads).toBe(0);
});

test('never converts a server conflict into a create replay success', async () => {
  await expect(
    provider([
      new Response('{}', { status: 409 }),
      new Response(JSON.stringify({ threads: [thread()] }))
    ]).mutate(create)
  ).resolves.toMatchObject({ ok: false, code: 'conflict', currentVersion: 1 });
});

test('accepts a create only when the authoritative thread proves the persisted payload', async () => {
  await expect(
    provider([
      new Response('{}', { status: 201 }),
      new Response(JSON.stringify({ threads: [thread('changed payload')] }))
    ]).mutate(create)
  ).resolves.toMatchObject({ ok: false, code: 'conflict', currentVersion: 1 });
});
