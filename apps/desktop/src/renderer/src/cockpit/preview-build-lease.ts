import type {
  PreviewBuildLease,
  PreviewBuildResult,
  PreviewBuildTicket
} from '../../../shared/designer-api';

import { PreviewRefreshError } from './preview-refresh';

export interface PreviewBuildLeasePort {
  reserveBuild(ticket: PreviewBuildTicket): Promise<PreviewBuildLease>;
  build(ticket: PreviewBuildTicket, leaseId: string): Promise<PreviewBuildResult>;
  cancelBuild(leaseId: string): void;
}

/** Reserve first, then send the build. Abort always revokes this exact host lease. */
export async function compileReservedPreview(input: {
  readonly ticket: PreviewBuildTicket;
  readonly port: PreviewBuildLeasePort;
  readonly signal?: AbortSignal;
  readonly validate: (build: unknown, ticket: PreviewBuildTicket) => boolean;
}): Promise<PreviewBuildResult> {
  const throwIfCancelled = () => {
    if (input.signal?.aborted)
      throw new PreviewRefreshError(
        'refresh-aborted',
        input.ticket.sourceRevisionId,
        'The refresh was cancelled during compilation'
      );
  };
  throwIfCancelled();
  let leaseId: string | undefined;
  const cancelBuild = () => {
    if (leaseId !== undefined) input.port.cancelBuild(leaseId);
  };
  input.signal?.addEventListener('abort', cancelBuild, { once: true });
  try {
    const lease = await input.port.reserveBuild(input.ticket);
    if (
      lease === null ||
      typeof lease !== 'object' ||
      typeof lease.leaseId !== 'string' ||
      lease.leaseId.length === 0 ||
      lease.leaseId.length > 128
    )
      throw new Error('Preview host returned an invalid build reservation');
    leaseId = lease.leaseId;
    // Cancellation may have occurred while reserve IPC was unresolved. Revoke
    // its late reservation in finally, without ever sending the delayed build.
    throwIfCancelled();
    const result = await input.port.build(input.ticket, leaseId);
    throwIfCancelled();
    if (!input.validate(result, input.ticket))
      throw new Error('Preview host returned an invalid preview build');
    return result;
  } finally {
    input.signal?.removeEventListener('abort', cancelBuild);
    cancelBuild();
  }
}
