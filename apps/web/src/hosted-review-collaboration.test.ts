import { expect, test } from 'vitest';

import {
  canonicalArtifactPinId,
  createHostedReviewCollaboration,
  reviewStorageKey,
  type ArtifactPin,
  type ReviewArtifactBinding,
  type ReviewStoragePort,
  type ReviewThread
} from './hosted-review-collaboration';
import {
  createBrowserLocalHostedReviewProvider,
  browserLocalHostedReviewBinding,
  browserLocalHostedReviewState
} from './hosted-review-provider';

const binding: ReviewArtifactBinding = {
  projectId: 'northstar',
  revisionId: 'orders-r18-7f3a',
  baselineId: 'orders-r17-b9c1',
  artifactId: 'orders-review-7f3a-b9c1'
};

class MemoryStorage implements ReviewStoragePort {
  readonly values = new Map<string, string>();
  rejectWrites = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.rejectWrites) throw new DOMException('Quota exceeded', 'QuotaExceededError');
    this.values.set(key, value);
  }
}

function thread(index: number, body: string): ReviewThread {
  const pinInput = {
    ...binding,
    orderId: '#1046',
    anchor: {
      selector: '[data-review-order="#1046"] [data-artifact-field="status"]',
      component: 'OrderStatus',
      point: { x: 0.5, y: 0.5 },
      region: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 }
    }
  };
  const pin: ArtifactPin = { id: canonicalArtifactPinId(pinInput), ...pinInput };
  return {
    id: `thread-contract-${index}`,
    pin,
    messages: [
      {
        id: `message-contract-${index}`,
        author: 'You',
        body,
        createdAt: '2026-07-25T22:18:00.000Z'
      }
    ],
    status: 'open'
  };
}

function providerRecordKey(hostedBinding: {
  readonly tenantId: string;
  readonly projectId: string;
  readonly artifactId: string;
  readonly revisionId: string;
  readonly baselineId: string;
  readonly version: number;
}): string {
  return `${reviewStorageKey(hostedBinding)}.provider-state.v3.${encodeURIComponent(
    JSON.stringify([
      hostedBinding.tenantId,
      hostedBinding.projectId,
      hostedBinding.artifactId,
      hostedBinding.revisionId,
      hostedBinding.baselineId,
      hostedBinding.version
    ])
  )}`;
}

test('uses one canonical pin ID contract for save and load', () => {
  const storage = new MemoryStorage();
  const collaboration = createHostedReviewCollaboration(storage);
  const valid = thread(1, 'Canonical pin proof.');

  expect(collaboration.save(binding, [valid])).toEqual({ ok: true });
  expect(collaboration.load(binding)).toEqual([valid]);

  const prior = storage.getItem(reviewStorageKey(binding));
  const forged: ReviewThread = { ...valid, pin: { ...valid.pin, id: 'pin-v1-0000000000000000' } };
  expect(collaboration.save(binding, [forged])).toEqual({ ok: false, code: 'invalid' });
  expect(storage.getItem(reviewStorageKey(binding))).toBe(prior);

  const staleInput = { ...valid.pin, revisionId: 'orders-r17-stale' };
  const stale: ReviewThread = {
    ...valid,
    pin: { ...staleInput, id: canonicalArtifactPinId(staleInput) }
  };
  expect(collaboration.save(binding, [stale])).toEqual({ ok: false, code: 'invalid' });
  expect(storage.getItem(reviewStorageKey(binding))).toBe(prior);
});

test('rejects over-4000 input, over-250 KiB serialization, and quota without overwriting storage', () => {
  const storage = new MemoryStorage();
  const collaboration = createHostedReviewCollaboration(storage);
  const valid = thread(1, 'Prior valid thread.');
  expect(collaboration.save(binding, [valid])).toEqual({ ok: true });
  const prior = storage.getItem(reviewStorageKey(binding));

  expect(collaboration.save(binding, [thread(2, 'x'.repeat(4001))])).toEqual({
    ok: false,
    code: 'invalid'
  });
  expect(storage.getItem(reviewStorageKey(binding))).toBe(prior);

  const oversized = Array.from({ length: 70 }, (_, index) => thread(index + 10, 'x'.repeat(4000)));
  expect(collaboration.save(binding, oversized)).toEqual({ ok: false, code: 'oversize' });
  expect(storage.getItem(reviewStorageKey(binding))).toBe(prior);

  storage.rejectWrites = true;
  expect(collaboration.save(binding, [thread(3, 'Quota preserves existing storage.')])).toEqual({
    ok: false,
    code: 'quota'
  });
  expect(storage.getItem(reviewStorageKey(binding))).toBe(prior);
});

test('labels the static artifact adapter as local-only and offline without faking hosted sync', () => {
  expect(browserLocalHostedReviewState).toEqual({
    provider: 'browser-local',
    identity: 'local-only',
    sync: 'offline'
  });
  expect(
    browserLocalHostedReviewBinding({
      tenantId: 'northstar-review',
      projectId: binding.projectId,
      artifactId: binding.artifactId,
      revisionId: binding.revisionId,
      baselineId: binding.baselineId,
      version: 1
    })
  ).toEqual({
    tenantId: 'northstar-review',
    projectId: binding.projectId,
    artifactId: binding.artifactId,
    revisionId: binding.revisionId,
    baselineId: binding.baselineId,
    version: 1
  });
});

test('routes browser-local discussion through CAS and idempotency without a renderer actor', async () => {
  const storage = new MemoryStorage();
  const provider = createBrowserLocalHostedReviewProvider(storage);
  const hostedBinding = browserLocalHostedReviewBinding({
    tenantId: 'northstar-review',
    projectId: binding.projectId,
    artifactId: binding.artifactId,
    revisionId: binding.revisionId,
    baselineId: binding.baselineId,
    version: 1
  });
  const operation = {
    type: 'create' as const,
    binding: hostedBinding,
    operationId: 'operation-local-create',
    threadId: 'thread-local-create',
    expectedVersion: 0,
    anchor: thread(9, 'anchor').pin.anchor,
    body: 'Persist through the local provider.'
  };
  const created = await provider.mutate(operation);
  expect(created.ok).toBe(true);
  await expect(provider.mutate(operation)).resolves.toEqual(created);
  const restarted = createBrowserLocalHostedReviewProvider(storage);
  await expect(restarted.mutate(operation)).resolves.toEqual(created);
  await expect(provider.list(hostedBinding)).resolves.toHaveLength(1);
  await expect(
    provider.mutate({
      type: 'resolve',
      binding: hostedBinding,
      operationId: 'operation-local-stale',
      threadId: operation.threadId,
      expectedVersion: 99
    })
  ).resolves.toMatchObject({ ok: false, code: 'conflict', currentVersion: 1 });
});

test('commits discussion and receipts together across recreation for reply, resolve, and reopen', async () => {
  const storage = new MemoryStorage();
  const atomicBinding = browserLocalHostedReviewBinding({
    tenantId: 'northstar-review',
    projectId: 'northstar',
    artifactId: 'orders-review-7f3a-b9c1',
    revisionId: 'orders-r18-7f3a',
    baselineId: 'orders-r17-b9c1',
    version: 1
  });
  const create = {
    type: 'create' as const,
    binding: atomicBinding,
    operationId: 'operation-atomic-create',
    threadId: 'thread-atomic-create',
    expectedVersion: 0,
    anchor: thread(10, 'atomic anchor').pin.anchor,
    body: 'Create exactly once.'
  };
  const created = await createBrowserLocalHostedReviewProvider(storage).mutate(create);
  expect(created).toMatchObject({ ok: true, thread: { version: 1 } });

  const reply = {
    type: 'reply' as const,
    binding: atomicBinding,
    operationId: 'operation-atomic-reply',
    threadId: create.threadId,
    expectedVersion: 1,
    body: 'Reply exactly once.'
  };
  const replied = await createBrowserLocalHostedReviewProvider(storage).mutate(reply);
  expect(replied).toMatchObject({ ok: true, thread: { version: 2 } });
  await expect(createBrowserLocalHostedReviewProvider(storage).mutate(reply)).resolves.toEqual(
    replied
  );

  const resolve = {
    type: 'resolve' as const,
    binding: atomicBinding,
    operationId: 'operation-atomic-resolve',
    threadId: create.threadId,
    expectedVersion: 2
  };
  const resolved = await createBrowserLocalHostedReviewProvider(storage).mutate(resolve);
  expect(resolved).toMatchObject({ ok: true, thread: { lifecycle: 'resolved', version: 3 } });
  await expect(createBrowserLocalHostedReviewProvider(storage).mutate(resolve)).resolves.toEqual(
    resolved
  );
  await expect(
    createBrowserLocalHostedReviewProvider(storage).mutate(reply)
  ).resolves.toMatchObject({
    ok: true,
    thread: { lifecycle: 'resolved', version: 3 }
  });

  const reopen = {
    type: 'reopen' as const,
    binding: atomicBinding,
    operationId: 'operation-atomic-reopen',
    threadId: create.threadId,
    expectedVersion: 3
  };
  const reopened = await createBrowserLocalHostedReviewProvider(storage).mutate(reopen);
  expect(reopened).toMatchObject({ ok: true, thread: { lifecycle: 'open', version: 4 } });
  await expect(createBrowserLocalHostedReviewProvider(storage).mutate(reopen)).resolves.toEqual(
    reopened
  );
  await expect(
    createBrowserLocalHostedReviewProvider(storage).mutate(resolve)
  ).resolves.toMatchObject({
    ok: false,
    code: 'conflict',
    currentVersion: 4,
    thread: { lifecycle: 'open' }
  });
});

test('keeps legacy storage read-only until its atomic provider migration succeeds', async () => {
  const storage = new MemoryStorage();
  const collaboration = createHostedReviewCollaboration(storage);
  const existing = thread(11, 'Existing legacy discussion.');
  expect(collaboration.save(binding, [existing])).toEqual({ ok: true });
  const legacyBefore = storage.getItem(reviewStorageKey(binding));
  const hostedBinding = browserLocalHostedReviewBinding({
    tenantId: 'northstar-review',
    projectId: binding.projectId,
    artifactId: binding.artifactId,
    revisionId: binding.revisionId,
    baselineId: binding.baselineId,
    version: 1
  });
  const reply = {
    type: 'reply' as const,
    binding: hostedBinding,
    operationId: 'operation-migration-reply',
    threadId: existing.id,
    expectedVersion: 1,
    body: 'Migrate with one write.'
  };
  storage.rejectWrites = true;
  await expect(
    createBrowserLocalHostedReviewProvider(storage, { legacyBinding: hostedBinding }).mutate(reply)
  ).resolves.toEqual({
    ok: false,
    code: 'error',
    message:
      'Browser-local review storage quota prevented this change. Existing discussions were kept.'
  });
  expect(storage.getItem(reviewStorageKey(binding))).toBe(legacyBefore);
  expect(storage.getItem(providerRecordKey(hostedBinding))).toBeNull();

  storage.rejectWrites = false;
  await expect(
    createBrowserLocalHostedReviewProvider(storage, { legacyBinding: hostedBinding }).mutate(reply)
  ).resolves.toMatchObject({
    ok: true,
    thread: { version: 2 }
  });
  expect(storage.getItem(reviewStorageKey(binding))).toBe(legacyBefore);
  expect(storage.getItem(providerRecordKey(hostedBinding))).not.toBeNull();
});

test('isolates provider records by tenant and contract version before any discussion read', async () => {
  const storage = new MemoryStorage();
  const tenantA = browserLocalHostedReviewBinding({
    tenantId: 'tenant-a',
    projectId: binding.projectId,
    artifactId: binding.artifactId,
    revisionId: binding.revisionId,
    baselineId: binding.baselineId,
    version: 1
  });
  const tenantB = browserLocalHostedReviewBinding({ ...tenantA, tenantId: 'tenant-b' });
  const newerContract = browserLocalHostedReviewBinding({ ...tenantA, version: 2 });
  const create = {
    type: 'create' as const,
    binding: tenantA,
    operationId: 'operation-tenant-a-create',
    threadId: 'thread-tenant-a-create',
    expectedVersion: 0,
    anchor: thread(12, 'tenant isolation').pin.anchor,
    body: 'Only tenant A may replay this operation.'
  };
  await expect(
    createBrowserLocalHostedReviewProvider(storage).mutate(create)
  ).resolves.toMatchObject({
    ok: true
  });
  expect(providerRecordKey(tenantA)).not.toBe(providerRecordKey(tenantB));
  expect(providerRecordKey(tenantA)).not.toBe(providerRecordKey(newerContract));
  await expect(createBrowserLocalHostedReviewProvider(storage).list(tenantB)).resolves.toEqual([]);
  await expect(
    createBrowserLocalHostedReviewProvider(storage).list(newerContract)
  ).resolves.toEqual([]);
  storage.values.set(
    providerRecordKey(tenantA),
    JSON.stringify({
      format: 'selene-browser-review-provider/v3',
      binding: tenantB,
      threads: [],
      receipts: {}
    })
  );
  await expect(createBrowserLocalHostedReviewProvider(storage).list(tenantA)).rejects.toThrow(
    'Local review record is unavailable'
  );
});

test('migrates near-limit legacy discussion with compact reply, resolve, and reopen receipts', async () => {
  const storage = new MemoryStorage();
  const collaboration = createHostedReviewCollaboration(storage);
  const nearLimit = Array.from({ length: 54 }, (_, index) => thread(index + 100, 'x'.repeat(4000)));
  expect(collaboration.save(binding, nearLimit)).toEqual({ ok: true });
  const hostedBinding = browserLocalHostedReviewBinding({
    tenantId: 'northstar-review',
    projectId: binding.projectId,
    artifactId: binding.artifactId,
    revisionId: binding.revisionId,
    baselineId: binding.baselineId,
    version: 1
  });
  const provider = createBrowserLocalHostedReviewProvider(storage, {
    legacyBinding: hostedBinding
  });
  const threadId = nearLimit[0]?.id ?? 'thread-contract-100';
  await expect(
    provider.mutate({
      type: 'reply',
      binding: hostedBinding,
      operationId: 'operation-near-limit-reply',
      threadId,
      expectedVersion: 1,
      body: 'Compact receipt only.'
    })
  ).resolves.toMatchObject({ ok: true, thread: { version: 2 } });
  await expect(
    createBrowserLocalHostedReviewProvider(storage).mutate({
      type: 'resolve',
      binding: hostedBinding,
      operationId: 'operation-near-limit-resolve',
      threadId,
      expectedVersion: 2
    })
  ).resolves.toMatchObject({ ok: true, thread: { lifecycle: 'resolved', version: 3 } });
  await expect(
    createBrowserLocalHostedReviewProvider(storage).mutate({
      type: 'reopen',
      binding: hostedBinding,
      operationId: 'operation-near-limit-reopen',
      threadId,
      expectedVersion: 3
    })
  ).resolves.toMatchObject({ ok: true, thread: { lifecycle: 'open', version: 4 } });
  const record = JSON.parse(storage.getItem(providerRecordKey(hostedBinding)) ?? '{}') as {
    readonly receipts: Record<string, Record<string, unknown>>;
  };
  expect(Object.values(record.receipts).every((receipt) => !('thread' in receipt))).toBe(true);
});

test('rejects malformed or overfull persisted receipts without reading legacy state', async () => {
  const storage = new MemoryStorage();
  const hostedBinding = browserLocalHostedReviewBinding({
    tenantId: 'northstar-review',
    projectId: binding.projectId,
    artifactId: binding.artifactId,
    revisionId: binding.revisionId,
    baselineId: binding.baselineId,
    version: 1
  });
  const key = providerRecordKey(hostedBinding);
  const malformed = [
    { kind: 'conflict', threadId: '' },
    { kind: 'conflict', unexpected: true },
    { kind: 'success', threadId: 'thread-valid', operation: 'reply' },
    { kind: 'success', threadId: 'thread-valid', operation: 'reply', unexpected: true },
    { kind: 'success', thread: {} }
  ];
  await malformed.reduce<Promise<void>>(async (previous, receipt) => {
    await previous;
    storage.values.set(
      key,
      JSON.stringify({
        format: 'selene-browser-review-provider/v3',
        binding: hostedBinding,
        threads: [],
        receipts: { hostile: receipt }
      })
    );
    await expect(
      createBrowserLocalHostedReviewProvider(storage).list(hostedBinding)
    ).rejects.toThrow('Local review record is unavailable');
  }, Promise.resolve());
  storage.values.set(
    key,
    JSON.stringify({
      format: 'selene-browser-review-provider/v3',
      binding: hostedBinding,
      threads: [],
      receipts: Object.fromEntries(
        Array.from({ length: 101 }, (_, index) => [`operation-${index}`, { kind: 'conflict' }])
      )
    })
  );
  await expect(createBrowserLocalHostedReviewProvider(storage).list(hostedBinding)).rejects.toThrow(
    'Local review record is unavailable'
  );
});

test('evicts the oldest atomic receipt before committing the one hundred first operation', async () => {
  const storage = new MemoryStorage();
  const hostedBinding = browserLocalHostedReviewBinding({
    tenantId: 'northstar-review',
    projectId: binding.projectId,
    artifactId: binding.artifactId,
    revisionId: binding.revisionId,
    baselineId: binding.baselineId,
    version: 1
  });
  const provider = createBrowserLocalHostedReviewProvider(storage);
  await Array.from({ length: 101 }, (_, index) => index).reduce<Promise<void>>(
    async (previous, index) => {
      await previous;
      await expect(
        provider.mutate({
          type: 'resolve',
          binding: hostedBinding,
          operationId: `operation-receipt-${index}`,
          threadId: 'thread-missing-receipt',
          expectedVersion: 0
        })
      ).resolves.toMatchObject({ ok: false, code: 'conflict' });
    },
    Promise.resolve()
  );
  const serialized = storage.getItem(providerRecordKey(hostedBinding));
  expect(serialized).not.toBeNull();
  const record = JSON.parse(serialized ?? '{}') as { receipts: Record<string, unknown> };
  expect(Object.keys(record.receipts)).toHaveLength(100);
  expect(Object.keys(record.receipts).some((key) => key.includes('operation-receipt-0'))).toBe(
    false
  );
  expect(Object.keys(record.receipts).some((key) => key.includes('operation-receipt-100'))).toBe(
    true
  );
});
