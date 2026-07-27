/**
 * Binding promotion is a host-only best-effort follow-up to preview delivery.
 * A rejected or stale promotion must never turn a successfully compiled preview
 * into a renderer-visible IPC failure.
 */
export function activateReactBindingAfterPreviewPublication(
  activate: () => Promise<unknown>,
  recordFailure: () => Promise<unknown>
): void {
  void Promise.resolve()
    .then(activate)
    .catch(() =>
      Promise.resolve()
        .then(recordFailure)
        .catch(() => undefined)
    );
}
