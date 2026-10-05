import { randomUUID } from 'node:crypto';

import { serializeCanonicalData } from '@selene/core';

import {
  validatePreviewBuildTicket,
  type PreviewBuildLease,
  type PreviewBuildTicket
} from '../shared/designer-api';

export const PREVIEW_BUILD_LEASE_TIMEOUT_MS = 10_000;

export interface PreviewBuildLeaseClock {
  now(): number;
  schedule(task: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

interface Lease {
  readonly id: string;
  readonly callerId: number;
  readonly ticket: string;
  readonly expiresAt: number;
  readonly controller: AbortController;
  timer: unknown;
  consumed: boolean;
}

export interface ClaimedPreviewBuildLease {
  readonly signal: AbortSignal;
  assertActive(): void;
  release(): void;
}

/**
 * Reserve before the build IPC is sent. A delayed IPC cannot begin after Exit,
 * replacement, or expiry, even when it was held outside the build handler.
 * Each renderer owns at most one expiring, exact-ticket, one-shot capability.
 */
export class PreviewBuildLeaseAuthority {
  private readonly leases = new Map<number, Lease>();

  public constructor(
    private readonly clock: PreviewBuildLeaseClock = {
      now: () => performance.now(),
      schedule: (task, delayMs) => setTimeout(task, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
    private readonly issueId: () => string = randomUUID
  ) {}

  public reserve(callerId: number, value: unknown): PreviewBuildLease {
    const ticket = serializeCanonicalData(validatePreviewBuildTicket(value));
    this.close(callerId);
    const lease: Lease = {
      id: this.issueId(),
      callerId,
      ticket,
      expiresAt: this.clock.now() + PREVIEW_BUILD_LEASE_TIMEOUT_MS,
      controller: new AbortController(),
      timer: undefined,
      consumed: false
    };
    this.leases.set(callerId, lease);
    lease.timer = this.clock.schedule(() => this.revoke(lease), PREVIEW_BUILD_LEASE_TIMEOUT_MS);
    return Object.freeze({ leaseId: lease.id });
  }

  public claim(
    callerId: number,
    value: unknown,
    ticket: PreviewBuildTicket
  ): ClaimedPreviewBuildLease {
    const lease = this.leases.get(callerId);
    if (
      lease === undefined ||
      typeof value !== 'string' ||
      lease.id !== value ||
      lease.consumed ||
      lease.ticket !== serializeCanonicalData(validatePreviewBuildTicket(ticket))
    )
      throw new Error('Preview build lease is stale, cancelled, or does not match its ticket.');
    this.assertActive(lease);
    lease.consumed = true;
    return {
      signal: lease.controller.signal,
      assertActive: () => this.assertActive(lease),
      release: () => this.revoke(lease)
    };
  }

  public cancel(callerId: number, value: unknown): boolean {
    const lease = this.leases.get(callerId);
    if (lease === undefined || typeof value !== 'string' || lease.id !== value) return false;
    this.revoke(lease);
    return true;
  }

  public close(callerId: number): void {
    const lease = this.leases.get(callerId);
    if (lease !== undefined) this.revoke(lease);
  }

  private assertActive(lease: Lease): void {
    if (
      this.leases.get(lease.callerId) !== lease ||
      lease.controller.signal.aborted ||
      this.clock.now() >= lease.expiresAt
    ) {
      this.revoke(lease);
      throw new Error(
        'Preview compilation timed out or was cancelled; render the current revision to retry.'
      );
    }
  }

  private revoke(lease: Lease): void {
    if (this.leases.get(lease.callerId) === lease) this.leases.delete(lease.callerId);
    this.clock.cancel(lease.timer);
    lease.controller.abort();
  }
}
