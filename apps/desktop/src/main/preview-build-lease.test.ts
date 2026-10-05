import { describe, expect, it } from 'vitest';

import type { PreviewBuildTicket } from '../shared/designer-api';
import {
  PREVIEW_BUILD_LEASE_TIMEOUT_MS,
  PreviewBuildLeaseAuthority,
  type PreviewBuildLeaseClock
} from './preview-build-lease';

class LeaseClock implements PreviewBuildLeaseClock {
  public time = 0;
  public readonly tasks = new Map<number, () => void>();
  private next = 0;

  public now(): number {
    return this.time;
  }

  public schedule(task: () => void, delayMs: number): number {
    expect(delayMs).toBe(PREVIEW_BUILD_LEASE_TIMEOUT_MS);
    const id = ++this.next;
    this.tasks.set(id, task);
    return id;
  }

  public cancel(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  public expire(): void {
    this.time += PREVIEW_BUILD_LEASE_TIMEOUT_MS;
    for (const task of [...this.tasks.values()]) task();
  }
}

const ticket: PreviewBuildTicket = {
  format: 'selene-preview-build-ticket/v1',
  projectId: 'orders',
  sourceRevisionId: 'orders-r2',
  graphRevision: 4,
  bindingId: 'a'.repeat(64)
};

function fixture() {
  const clock = new LeaseClock();
  let sequence = 0;
  return {
    clock,
    authority: new PreviewBuildLeaseAuthority(clock, () => `opaque-lease-${++sequence}`)
  };
}

describe('host preview build leases', () => {
  it.each(['cancel', 'expire'] as const)(
    'rejects an IPC held before the handler when its reservation has been %s',
    (reason) => {
      const { authority, clock } = fixture();
      const reservation = authority.reserve(7, ticket);
      if (reason === 'cancel') expect(authority.cancel(7, reservation.leaseId)).toBe(true);
      else clock.expire();
      expect(() => authority.claim(7, reservation.leaseId, ticket)).toThrow(/stale|cancelled/);
      expect(clock.tasks.size).toBe(0);
    }
  );

  it('checks monotonic expiry even before a delayed timer callback can run', () => {
    const { authority, clock } = fixture();
    const reservation = authority.reserve(7, ticket);
    clock.time += PREVIEW_BUILD_LEASE_TIMEOUT_MS;
    expect(() => authority.claim(7, reservation.leaseId, ticket)).toThrow(/timed out/);
    expect(clock.tasks.size).toBe(0);
  });

  it('is exact-ticket, caller-bound, and one-shot', () => {
    const { authority } = fixture();
    const reservation = authority.reserve(7, ticket);
    expect(() => authority.claim(8, reservation.leaseId, ticket)).toThrow(/stale/);
    expect(() =>
      authority.claim(7, reservation.leaseId, { ...ticket, bindingId: 'b'.repeat(64) })
    ).toThrow(/match/);
    expect(authority.cancel(8, reservation.leaseId)).toBe(false);
    expect(() => authority.claim(7, {}, ticket)).toThrow(/stale/);
    const claimed = authority.claim(7, reservation.leaseId, ticket);
    claimed.assertActive();
    expect(claimed.signal.aborted).toBe(false);
    expect(() => authority.claim(7, reservation.leaseId, ticket)).toThrow(/stale/);
  });

  it.each(['cancel', 'expire', 'close'] as const)(
    'aborts a running compiler and rejects publication after %s',
    (reason) => {
      const { authority, clock } = fixture();
      const reservation = authority.reserve(7, ticket);
      const claimed = authority.claim(7, reservation.leaseId, ticket);
      if (reason === 'cancel') authority.cancel(7, reservation.leaseId);
      else if (reason === 'expire') clock.expire();
      else authority.close(7);
      expect(claimed.signal.aborted).toBe(true);
      expect(() => claimed.assertActive()).toThrow(/timed out|cancelled/);
      expect(clock.tasks.size).toBe(0);
    }
  );

  it('replaces one renderer lease and ignores late cleanup or cancellation from the old build', () => {
    const { authority, clock } = fixture();
    const first = authority.reserve(7, ticket);
    const oldBuild = authority.claim(7, first.leaseId, ticket);
    const next = authority.reserve(7, ticket);
    expect(oldBuild.signal.aborted).toBe(true);
    oldBuild.release();
    expect(authority.cancel(7, first.leaseId)).toBe(false);
    const current = authority.claim(7, next.leaseId, ticket);
    current.assertActive();
    expect(current.signal.aborted).toBe(false);
    current.release();
    expect(clock.tasks.size).toBe(0);
    expect(() => current.assertActive()).toThrow(/cancelled/);
  });

  it('cannot retain or publish after a running lease expires without its timer firing', () => {
    const { authority, clock } = fixture();
    const reservation = authority.reserve(7, ticket);
    const claimed = authority.claim(7, reservation.leaseId, ticket);
    clock.time += PREVIEW_BUILD_LEASE_TIMEOUT_MS;
    expect(() => claimed.assertActive()).toThrow(/timed out/);
    expect(claimed.signal.aborted).toBe(true);
    expect(clock.tasks.size).toBe(0);
  });
});
