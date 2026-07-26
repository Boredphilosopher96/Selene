import { expect, test } from 'vitest';

import {
  isDiscussionOnlyHostedReviewOperation,
  mutateHostedReviewThroughHost,
  validateHostedReviewBinding,
  validateHostedReviewThread,
  type HostedReviewBinding,
  type HostedReviewThread
} from './hosted-review';
import type { CollaborationHostContext } from './boundary';

const binding: HostedReviewBinding = {
  tenantId: 'tenant-northstar',
  projectId: 'northstar',
  artifactId: 'orders-review-r18',
  revisionId: 'orders-r18',
  baselineId: 'orders-r17',
  version: 4
};

const thread: HostedReviewThread = {
  id: 'thread-orders-1',
  binding,
  anchor: {
    selector: '[data-review-order="#1048"] [data-artifact-field="status"]',
    component: 'OrderStatus',
    point: { x: 0.5, y: 0.4 },
    region: { x: 0.4, y: 0.3, width: 0.1, height: 0.1 }
  },
  replies: [
    {
      id: 'reply-orders-1',
      body: 'Keep this status visible in the handoff.',
      actor: { id: 'reviewer-1', displayName: 'Reviewer One' },
      createdAt: '2026-07-26T12:00:00.000Z',
      version: 1
    }
  ],
  lifecycle: 'open',
  actor: { id: 'reviewer-1', displayName: 'Reviewer One' },
  createdAt: '2026-07-26T12:00:00.000Z',
  version: 1
};

const hostContext: CollaborationHostContext = {
  signal: new AbortController().signal,
  run: async (operation) => operation(hostContext),
  runPort: async (_port, _method, operation) => operation(hostContext),
  dispose: () => undefined
};

test('requires exact tenant, project, artifact, revision, baseline, and version ownership', () => {
  expect(() => validateHostedReviewBinding(binding)).not.toThrow();
  expect(() => validateHostedReviewThread(thread, binding)).not.toThrow();
  expect(() =>
    validateHostedReviewThread(thread, { ...binding, revisionId: 'orders-r19' })
  ).toThrow('Hosted review contract is invalid');
  expect(() =>
    validateHostedReviewThread(thread, { ...binding, tenantId: 'tenant-other' })
  ).toThrow('Hosted review contract is invalid');
});

test('keeps create, reply, resolve, and reopen as discussion-only operations', () => {
  const shared = {
    binding,
    actor: { id: 'reviewer-1', displayName: 'Reviewer One' },
    threadId: thread.id,
    expectedVersion: thread.version
  } as const;
  expect(
    isDiscussionOnlyHostedReviewOperation({
      ...shared,
      type: 'create',
      anchor: thread.anchor,
      body: 'Pin the status label.'
    })
  ).toBe(true);
  expect(
    isDiscussionOnlyHostedReviewOperation({ ...shared, type: 'reply', body: 'Acknowledged.' })
  ).toBe(true);
  expect(isDiscussionOnlyHostedReviewOperation({ ...shared, type: 'resolve' })).toBe(true);
  expect(isDiscussionOnlyHostedReviewOperation({ ...shared, type: 'reopen' })).toBe(true);
});

test('rejects accessor-backed and cross-binding provider payloads before they can reach UI state', () => {
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessor, 'tenantId', { enumerable: true, get: () => binding.tenantId });
  for (const [key, value] of Object.entries(binding)) {
    if (key === 'tenantId') continue;
    Object.defineProperty(accessor, key, { enumerable: true, value });
  }
  expect(() => validateHostedReviewBinding(accessor as HostedReviewBinding)).toThrow(
    'Hosted review contract is invalid'
  );
  expect(() =>
    validateHostedReviewThread(
      { ...thread, binding: { ...binding, projectId: 'other-project' } },
      binding
    )
  ).toThrow('Hosted review contract is invalid');
});

test('accepts host-supervised discussion results only when their binding remains exact', async () => {
  const provider = {
    async state() {
      return {
        provider: 'browser-local' as const,
        identity: 'local-only' as const,
        sync: 'offline' as const
      };
    },
    async list() {
      return [thread];
    },
    async mutate() {
      return { ok: true as const, thread };
    }
  };
  await expect(
    mutateHostedReviewThroughHost(hostContext, provider, {
      type: 'resolve',
      binding,
      actor: thread.actor,
      threadId: thread.id,
      expectedVersion: thread.version
    })
  ).resolves.toEqual({ ok: true, thread });
});
