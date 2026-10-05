export const PREVIEW_COMPILER_TIMEOUT_MS = 10_000;

/** Bound the caller's wait for lazy Vite loading and compilation; observe abandoned work. */
export function runPreviewCompileWithDeadline<Artifact>(
  operation: (signal: AbortSignal) => Promise<Artifact>,
  signal?: AbortSignal
): Promise<Artifact> {
  const controller = new AbortController();
  return new Promise<Artifact>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', onAbort);
    };
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      settle();
    };
    const cancel = () => controller.abort();
    const onAbort = () =>
      finish(() =>
        reject(
          new DOMException(
            timedOut ? 'Preview compiler timed out.' : 'Preview compiler was cancelled.',
            'AbortError'
          )
        )
      );
    controller.signal.addEventListener('abort', onAbort, { once: true });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, PREVIEW_COMPILER_TIMEOUT_MS);
    try {
      // The original operation remains observed after abandonment. It may
      // finish internally, but cannot settle this adapter or attest output.
      void operation(controller.signal).then(
        (artifact) => finish(() => resolve(artifact)),
        (error: unknown) => finish(() => reject(error))
      );
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
