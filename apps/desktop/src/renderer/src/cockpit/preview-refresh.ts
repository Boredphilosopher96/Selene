/** Provider-neutral shape required to bind one accepted source revision to its preview. */
export interface RevisionSnapshot {
  readonly source: { readonly revision: { readonly id: string } };
}

export interface ProjectRevisionSnapshot extends RevisionSnapshot {
  readonly source: {
    readonly projectId: string;
    readonly revision: { readonly id: string };
  };
}

/** Check intent inside the host queue: Escape can run while a refresh is waiting. */
export async function retargetPreviewSelection<
  Snapshot extends RevisionSnapshot & { readonly selectedNodeId?: string }
>(input: {
  readonly snapshot: Snapshot;
  readonly revisionId: string;
  readonly isCurrent: () => boolean;
  readonly enqueue: (operation: () => Promise<Snapshot>) => Promise<Snapshot>;
  readonly readSnapshot: () => Promise<Snapshot>;
  readonly selectNode: (nodeId: string) => Promise<Snapshot>;
}): Promise<Snapshot> {
  const selectedNodeId = input.snapshot.selectedNodeId;
  if (selectedNodeId === undefined) return input.snapshot;
  const next = await input.enqueue(() =>
    input.isCurrent() ? input.selectNode(selectedNodeId) : input.readSnapshot()
  );
  if (next.source.revision.id !== input.revisionId)
    throw new Error(`Host selection belongs to ${next.source.revision.id}`);
  return next;
}

export interface RevisionPreviewBuild {
  readonly revisionId: string;
}

export interface PreviewPresentationIdentity {
  readonly revisionId: string;
  readonly nonce: string;
  readonly url: string;
}

/** Stable in-memory key for state captured for one exact preview document. */
export function previewPresentationIdentityKey(identity: PreviewPresentationIdentity): string {
  return JSON.stringify([identity.revisionId, identity.nonce, identity.url]);
}

export interface PreviewPresentationReceipt {
  readonly identity: PreviewPresentationIdentity;
  /** A trusted wrapper observed committed content at a browser paint boundary. */
  readonly visible: true;
}

export type PreviewRefreshFailureCode =
  | 'compile-failed'
  | 'compile-timeout'
  | 'revision-mismatch'
  | 'iframe-load-failed'
  | 'iframe-runtime-failed'
  | 'presentation-timeout'
  | 'refresh-aborted'
  | 'selection-retarget-failed';

export class PreviewRefreshError extends Error {
  public constructor(
    public readonly code: PreviewRefreshFailureCode,
    public readonly revisionId: string,
    reason: string
  ) {
    super(
      `Preview for ${revisionId} was not refreshed (${code}): ${reason}. ` +
        'The source revision is saved; use Render current revision to retry.'
    );
    this.name = 'PreviewRefreshError';
  }
}

interface PendingPresentation {
  readonly identity: PreviewPresentationIdentity;
  ready: boolean;
  readonly resolve: (receipt: PreviewPresentationReceipt) => void;
  readonly reject: (error: PreviewRefreshError) => void;
  readonly cleanup: () => void;
}

export interface PreviewPresentationClock {
  schedule(task: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export const DEFAULT_PREVIEW_PRESENTATION_TIMEOUT_MS = 15_000;
export const DEFAULT_PREVIEW_COMPILE_TIMEOUT_MS = 15_000;

const previewCompileClock: PreviewPresentationClock = {
  schedule: (task, delayMs) => globalThis.setTimeout(task, delayMs),
  cancel: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/**
 * Owns exactly one pending presentation. Replacement, abort, close, and timeout
 * all clean their timer/listener before settling the promise.
 */
export class PreviewPresentationCoordinator<Build extends RevisionPreviewBuild> {
  private pending: PendingPresentation | undefined;

  public constructor(
    private readonly publish: (build: Build) => void,
    private readonly identify: (build: Build) => PreviewPresentationIdentity,
    private readonly clock: PreviewPresentationClock,
    private readonly timeoutMs = DEFAULT_PREVIEW_PRESENTATION_TIMEOUT_MS
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      throw new Error('Preview presentation timeout must be between 1 and 60000 milliseconds');
  }

  public present(build: Build, signal?: AbortSignal): Promise<PreviewPresentationReceipt> {
    const identified = this.identify(build);
    const identity = Object.freeze({
      revisionId: identified.revisionId,
      nonce: identified.nonce,
      url: identified.url
    });
    this.rejectPending(
      'refresh-aborted',
      'A newer preview refresh replaced the pending presentation'
    );
    if (signal?.aborted)
      return Promise.reject(
        new PreviewRefreshError('refresh-aborted', identity.revisionId, 'The refresh was cancelled')
      );

    return new Promise<PreviewPresentationReceipt>((resolve, reject) => {
      let timer: unknown = undefined;
      const onAbort = () =>
        this.rejectRevision(
          identity,
          'refresh-aborted',
          'The refresh was cancelled before the frame became visible'
        );
      const cleanup = () => {
        this.clock.cancel(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      this.pending = {
        identity,
        ready: false,
        resolve,
        reject,
        cleanup
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = this.clock.schedule(
        () =>
          this.rejectRevision(
            identity,
            'presentation-timeout',
            'The sandbox did not return a trusted paint receipt in time'
          ),
        this.timeoutMs
      );
      try {
        this.publish(build);
      } catch (error) {
        this.rejectRevision(
          identity,
          'iframe-load-failed',
          `The preview frame could not be published: ${detail(error)}`
        );
      }
    });
  }

  public ready(identity: PreviewPresentationIdentity): boolean {
    const pending = this.pending;
    if (!pending || !samePreviewPresentationIdentity(pending.identity, identity)) return false;
    pending.ready = true;
    return true;
  }

  /** Ignores stale or spoofed receipts and settles only the exact pending revision. */
  public rendered(identity: PreviewPresentationIdentity): boolean {
    const pending = this.pending;
    if (!pending || !pending.ready || !samePreviewPresentationIdentity(pending.identity, identity))
      return false;
    this.pending = undefined;
    pending.cleanup();
    pending.resolve({ identity: pending.identity, visible: true });
    return true;
  }

  public failed(
    identity: PreviewPresentationIdentity,
    code: Extract<PreviewRefreshFailureCode, 'iframe-load-failed' | 'iframe-runtime-failed'>,
    reason: string
  ): boolean {
    return this.rejectRevision(identity, code, reason);
  }

  public close(): void {
    this.rejectPending('refresh-aborted', 'The preview frame was closed');
  }

  private rejectRevision(
    identity: PreviewPresentationIdentity,
    code: PreviewRefreshFailureCode,
    reason: string
  ): boolean {
    if (!samePreviewPresentationIdentity(this.pending?.identity, identity)) return false;
    this.rejectPending(code, reason);
    return true;
  }

  private rejectPending(code: PreviewRefreshFailureCode, reason: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    pending.cleanup();
    pending.reject(new PreviewRefreshError(code, pending.identity.revisionId, reason));
  }
}

export interface PreviewRefreshResult<
  Snapshot extends RevisionSnapshot,
  Build extends RevisionPreviewBuild
> {
  readonly snapshot: Snapshot;
  readonly build: Build;
  readonly receipt: PreviewPresentationReceipt;
}

export type PreviewRefreshSelectionPolicy<Snapshot extends RevisionSnapshot> =
  | {
      readonly intent: 'authoring';
      readonly retarget: (snapshot: Snapshot, revisionId: string) => Promise<Snapshot>;
    }
  | {
      readonly intent: 'presentation';
    };

function detail(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'The preview host did not provide a usable error.';
}

export function samePreviewPresentationIdentity(
  left: PreviewPresentationIdentity | undefined,
  right: PreviewPresentationIdentity
): boolean {
  return (
    left?.revisionId === right.revisionId && left.nonce === right.nonce && left.url === right.url
  );
}

export function isActivePreviewFrameEvent(input: {
  readonly activeIdentity: PreviewPresentationIdentity | undefined;
  readonly eventIdentity: PreviewPresentationIdentity;
  readonly channelIsActive: boolean;
}): boolean {
  return (
    input.channelIsActive &&
    samePreviewPresentationIdentity(input.activeIdentity, input.eventIdentity)
  );
}

/**
 * Rendering is a receipt for source already installed by the caller, not a new
 * product mutation. A host-confirmed selection or collaboration update may
 * arrive while compilation and presentation settle, so a late same-revision
 * receipt must not replace that newer renderer state.
 */
export function retainCurrentSnapshotAfterPreviewRefresh<Snapshot extends ProjectRevisionSnapshot>(
  current: Snapshot | undefined,
  refreshed: Snapshot
): Snapshot {
  return current?.source.projectId === refreshed.source.projectId &&
    current.source.revision.id === refreshed.source.revision.id
    ? current
    : refreshed;
}

function throwIfAborted(signal: AbortSignal | undefined, revisionId: string): void {
  if (signal?.aborted)
    throw new PreviewRefreshError('refresh-aborted', revisionId, 'The refresh was cancelled');
}

/**
 * A compiler adapter may ignore cancellation or never settle (including an IPC
 * request stalled before reaching the host). Own the wait as well as the signal:
 * cancellation and deadline free the caller immediately, and both handlers stay
 * attached to abandoned work so a late rejection is consumed without publishing
 * a late result. The host adapter must revoke any build publication capability
 * when this signal aborts; renderer cancellation alone cannot stop host work.
 */
export function compilePreviewWithinDeadline<
  Snapshot extends RevisionSnapshot,
  Build extends RevisionPreviewBuild
>(input: {
  readonly snapshot: Snapshot;
  readonly compile: (snapshot: Snapshot, signal?: AbortSignal) => Promise<Build>;
  readonly signal?: AbortSignal;
  readonly compileClock?: PreviewPresentationClock;
  readonly compileTimeoutMs?: number;
}): Promise<Build> {
  const revisionId = input.snapshot.source.revision.id;
  const timeoutMs = input.compileTimeoutMs ?? DEFAULT_PREVIEW_COMPILE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > DEFAULT_PREVIEW_COMPILE_TIMEOUT_MS
  )
    throw new Error('Preview compile timeout must be between 1 and 15000 milliseconds');
  const clock = input.compileClock ?? previewCompileClock;
  const controller = new AbortController();

  return new Promise<Build>((resolve, reject) => {
    let settled = false;
    let timer: unknown;
    const cleanup = () => {
      clock.cancel(timer);
      input.signal?.removeEventListener('abort', onAbort);
    };
    const abandon = (error: PreviewRefreshError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      controller.abort();
    };
    const onAbort = () =>
      abandon(new PreviewRefreshError('refresh-aborted', revisionId, 'The refresh was cancelled'));
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) {
      onAbort();
      return;
    }
    timer = clock.schedule(
      () =>
        abandon(
          new PreviewRefreshError(
            'compile-timeout',
            revisionId,
            'The preview compiler did not finish in time'
          )
        ),
      timeoutMs
    );
    if (settled) {
      clock.cancel(timer);
      return;
    }
    try {
      const pending = input.compile(input.snapshot, controller.signal);
      void pending.then(
        (build) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(build);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        }
      );
    } catch (error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
  });
}

/**
 * Produces a receipt only after compile, presentation, and selection adapters
 * agree on the exact saved revision. No Electron, DOM, compiler, or agent leaks
 * into this coordination boundary.
 */
export async function refreshPreviewRevision<
  Snapshot extends RevisionSnapshot,
  Build extends RevisionPreviewBuild
>(input: {
  readonly snapshot: Snapshot;
  readonly compile: (snapshot: Snapshot, signal?: AbortSignal) => Promise<Build>;
  readonly present: (build: Build, signal?: AbortSignal) => Promise<PreviewPresentationReceipt>;
  /**
   * Authoring refreshes may revalidate their selected React node. Presentation
   * explicitly has no such capability because hidden Inspect state must never
   * block an otherwise valid prototype from opening. The discriminant prevents
   * a future authoring caller from weakening validation by omission.
   */
  readonly selection: PreviewRefreshSelectionPolicy<Snapshot>;
  readonly signal?: AbortSignal;
  /** Compile is bounded independently of the unchanged trusted paint deadline. */
  readonly compileTimeoutMs?: number;
  readonly compileClock?: PreviewPresentationClock;
}): Promise<PreviewRefreshResult<Snapshot, Build>> {
  const revisionId = input.snapshot.source.revision.id;
  throwIfAborted(input.signal, revisionId);
  let build: Build;
  try {
    build = await compilePreviewWithinDeadline(input);
  } catch (error) {
    if (error instanceof PreviewRefreshError) throw error;
    throwIfAborted(input.signal, revisionId);
    throw new PreviewRefreshError('compile-failed', revisionId, detail(error));
  }
  throwIfAborted(input.signal, revisionId);
  if (build.revisionId !== revisionId)
    throw new PreviewRefreshError(
      'revision-mismatch',
      revisionId,
      `Compiler returned ${build.revisionId} instead of the accepted revision`
    );

  let receipt: PreviewPresentationReceipt;
  try {
    receipt = await input.present(build, input.signal);
  } catch (error) {
    if (error instanceof PreviewRefreshError) throw error;
    throwIfAborted(input.signal, revisionId);
    throw new PreviewRefreshError('iframe-load-failed', revisionId, detail(error));
  }
  throwIfAborted(input.signal, revisionId);
  if (receipt.identity.revisionId !== revisionId || !receipt.visible)
    throw new PreviewRefreshError(
      'revision-mismatch',
      revisionId,
      `Frame receipt was for ${receipt.identity.revisionId} rather than the accepted revision`
    );
  if (input.selection.intent === 'presentation')
    return { snapshot: input.snapshot, build, receipt };

  try {
    const snapshot = await input.selection.retarget(input.snapshot, revisionId);
    throwIfAborted(input.signal, revisionId);
    if (snapshot.source.revision.id !== revisionId)
      throw new Error(`Selection retarget returned ${snapshot.source.revision.id}`);
    return { snapshot, build, receipt };
  } catch (error) {
    if (error instanceof PreviewRefreshError) throw error;
    throwIfAborted(input.signal, revisionId);
    throw new PreviewRefreshError('selection-retarget-failed', revisionId, detail(error));
  }
}
