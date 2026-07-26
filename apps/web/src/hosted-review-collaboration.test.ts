import { expect, test } from 'bun:test';

import {
  canonicalArtifactPinId,
  createHostedReviewCollaboration,
  reviewStorageKey,
  type ArtifactPin,
  type ReviewArtifactBinding,
  type ReviewStoragePort,
  type ReviewThread
} from './hosted-review-collaboration';

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
