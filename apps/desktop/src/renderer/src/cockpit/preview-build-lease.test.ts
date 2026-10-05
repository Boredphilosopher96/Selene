import { describe, expect, it, vi } from 'vitest';

import type {
  PreviewBuildLease,
  PreviewBuildResult,
  PreviewBuildTicket
} from '../../../shared/designer-api';
import { compileReservedPreview, type PreviewBuildLeasePort } from './preview-build-lease';

const ticket: PreviewBuildTicket = {
  format: 'selene-preview-build-ticket/v1',
  projectId: 'orders',
  sourceRevisionId: 'orders-r2',
  graphRevision: 4,
  bindingId: 'a'.repeat(64)
};
const build: PreviewBuildResult = {
  ...ticket,
  url: 'selene-preview://local/fresh/index.html',
  revisionId: ticket.sourceRevisionId,
  policy: {
    origin: 'selene-preview://local',
    nonce: 'fresh',
    maxMessageBytes: 1000,
    csp: 'sandbox'
  }
};

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const port: PreviewBuildLeasePort = {
    reserveBuild: vi.fn(async () => ({ leaseId: 'reserved' })),
    build: vi.fn(async () => build),
    cancelBuild: vi.fn()
  };
  return { port, validate: vi.fn(() => true), controller: new AbortController() };
}

describe('renderer preview build lease lifecycle', () => {
  it('reserves before build and cleans its lease and abort listener after success', async () => {
    const { port, validate, controller } = fixture();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(
      compileReservedPreview({ ticket, port, validate, signal: controller.signal })
    ).resolves.toBe(build);
    expect(port.reserveBuild).toHaveBeenCalledWith(ticket);
    expect(port.build).toHaveBeenCalledWith(ticket, 'reserved');
    expect(port.cancelBuild).toHaveBeenCalledWith('reserved');
    expect(remove).toHaveBeenCalledOnce();
  });

  it('revokes a reservation that resolves after abort without sending a build IPC', async () => {
    const { port, validate, controller } = fixture();
    const reservation = deferred<PreviewBuildLease>();
    port.reserveBuild = vi.fn(() => reservation.promise);
    const pending = compileReservedPreview({ ticket, port, validate, signal: controller.signal });
    const failed = expect(pending).rejects.toMatchObject({ code: 'refresh-aborted' });
    controller.abort();
    reservation.resolve({ leaseId: 'late-reservation' });
    await failed;
    expect(port.build).not.toHaveBeenCalled();
    expect(port.cancelBuild).toHaveBeenCalledWith('late-reservation');
    expect(validate).not.toHaveBeenCalled();
  });

  it('revokes a held build immediately on abort and rejects its late result before validation', async () => {
    const { port, validate, controller } = fixture();
    const held = deferred<PreviewBuildResult>();
    port.build = vi.fn(() => held.promise);
    const pending = compileReservedPreview({ ticket, port, validate, signal: controller.signal });
    const failed = expect(pending).rejects.toMatchObject({ code: 'refresh-aborted' });
    await Promise.resolve();
    expect(port.build).toHaveBeenCalledOnce();
    controller.abort();
    expect(port.cancelBuild).toHaveBeenCalledWith('reserved');
    held.resolve(build);
    await failed;
    expect(validate).not.toHaveBeenCalled();
  });

  it.each(['reject', 'invalid'] as const)('cleans a lease after a %s build', async (result) => {
    const { port, validate, controller } = fixture();
    if (result === 'reject')
      port.build = vi.fn(async () => {
        throw new Error('host refused');
      });
    else validate.mockReturnValue(false);
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(
      compileReservedPreview({ ticket, port, validate, signal: controller.signal })
    ).rejects.toThrow();
    expect(port.cancelBuild).toHaveBeenCalledWith('reserved');
    expect(remove).toHaveBeenCalledOnce();
  });

  it('does not request a reservation after an earlier cancellation', async () => {
    const { port, validate, controller } = fixture();
    controller.abort();
    await expect(
      compileReservedPreview({ ticket, port, validate, signal: controller.signal })
    ).rejects.toMatchObject({ code: 'refresh-aborted' });
    expect(port.reserveBuild).not.toHaveBeenCalled();
    expect(port.build).not.toHaveBeenCalled();
  });
});
