export interface DiagnosticsOperationLane {
  run<Result>(request: {
    readonly operation: () => Promise<Result>;
    readonly onSuccess: (result: Result) => void;
    readonly onFailure: (error: unknown) => void;
    readonly onSettled: () => void;
  }): boolean;
  invalidate(): void;
  dispose(): void;
}

export interface LatestDiagnosticsOperationQueue<Value> {
  submit(value: Value): void;
  dispose(): void;
}

export interface DiagnosticsInitialRefreshKey {
  readonly generation: number;
  readonly projectId: string;
}

export interface DiagnosticsActivationTracker {
  activate(projectId: string): DiagnosticsInitialRefreshKey;
}

export interface DiagnosticsInitialRefreshStore<Result> {
  acquire(key: DiagnosticsInitialRefreshKey, operation: () => Promise<Result>): Promise<Result>;
}

type DiagnosticsInitialRefreshRecord<Result> = {
  readonly key: DiagnosticsInitialRefreshKey;
  readonly request: Promise<Result>;
};

function sameDiagnosticsInitialRefreshKey(
  left: DiagnosticsInitialRefreshKey,
  right: DiagnosticsInitialRefreshKey
): boolean {
  return left.projectId === right.projectId && left.generation === right.generation;
}

/**
 * Gives every project activation an opaque local generation. This matters for
 * A → B → A switches: the returning A must read afresh rather than inherit a
 * promise started during its earlier activation. Re-renders and StrictMode
 * effect replay retain the same generation.
 */
export function createDiagnosticsActivationTracker(): DiagnosticsActivationTracker {
  let current: DiagnosticsInitialRefreshKey | undefined;
  let generation = 0;
  return {
    activate(projectId): DiagnosticsInitialRefreshKey {
      if (current?.projectId === projectId) return current;
      generation += 1;
      current = Object.freeze({ generation, projectId });
      return current;
    }
  };
}

/**
 * Shares one pending activation read across StrictMode effect replay and host
 * adapter wrapper churn. A record releases itself on either settlement only
 * when it is still current, so a late predecessor can never erase a newer
 * activation, including an A → B → A return.
 */
export function createDiagnosticsInitialRefreshStore<
  Result
>(): DiagnosticsInitialRefreshStore<Result> {
  let current: DiagnosticsInitialRefreshRecord<Result> | undefined;
  return {
    acquire(key, operation): Promise<Result> {
      if (current && sameDiagnosticsInitialRefreshKey(current.key, key)) return current.request;
      const record: DiagnosticsInitialRefreshRecord<Result> = {
        key,
        request: Promise.resolve().then(operation)
      };
      current = record;
      const release = () => {
        if (current === record) current = undefined;
      };
      void record.request.then(release, release);
      return record.request;
    }
  };
}

/**
 * Serializes the small host-owned diagnostics surface. Invalidating releases a
 * stale request immediately, while its eventual completion remains ineligible
 * to mutate the current toolbar.
 */
export function createDiagnosticsOperationLane(
  onBusyChange: (busy: boolean) => void
): DiagnosticsOperationLane {
  let generation = 0;
  let inFlight = false;
  let disposed = false;
  const isCurrent = (candidate: number) => !disposed && candidate === generation;
  const invalidate = () => {
    generation += 1;
    inFlight = false;
    if (!disposed) onBusyChange(false);
  };
  return {
    run<Result>({
      operation,
      onSuccess,
      onFailure,
      onSettled
    }: {
      readonly operation: () => Promise<Result>;
      readonly onSuccess: (result: Result) => void;
      readonly onFailure: (error: unknown) => void;
      readonly onSettled: () => void;
    }): boolean {
      if (disposed || inFlight) return false;
      inFlight = true;
      const current = generation + 1;
      generation = current;
      onBusyChange(true);
      void Promise.resolve()
        .then(operation)
        .then(
          (result) => {
            if (isCurrent(current)) onSuccess(result);
          },
          (error: unknown) => {
            if (isCurrent(current)) onFailure(error);
          }
        )
        .finally(() => {
          if (!isCurrent(current)) return;
          inFlight = false;
          onBusyChange(false);
          onSettled();
        });
      return true;
    },
    invalidate,
    dispose(): void {
      disposed = true;
      generation += 1;
      inFlight = false;
    }
  };
}

/**
 * Keeps a responsive control optimistic while committing only its most recent
 * intent after the current host operation settles. A completion reports whether
 * a newer intent was already queued, so callers never paint stale host results
 * over the user's latest choice.
 */
export function createLatestDiagnosticsOperationQueue<Value, Result>(
  lane: DiagnosticsOperationLane,
  handlers: {
    readonly operation: (value: Value) => Promise<Result>;
    readonly onSuccess: (value: Value, result: Result, isLatest: boolean) => void;
    readonly onFailure: (value: Value, error: unknown, isLatest: boolean) => void;
    readonly onIdle: () => void;
  }
): LatestDiagnosticsOperationQueue<Value> {
  let active = false;
  let disposed = false;
  let pending: Value | undefined;

  const runNext = (): void => {
    if (disposed || active || pending === undefined) return;
    const value = pending;
    pending = undefined;
    active = true;
    const accepted = lane.run({
      operation: () => handlers.operation(value),
      onSuccess: (result) => {
        if (!disposed) handlers.onSuccess(value, result, pending === undefined);
      },
      onFailure: (error) => {
        if (!disposed) handlers.onFailure(value, error, pending === undefined);
      },
      onSettled: () => {
        if (disposed) return;
        active = false;
        if (pending === undefined) handlers.onIdle();
        else runNext();
      }
    });
    if (accepted) return;
    active = false;
    if (!disposed) {
      handlers.onFailure(value, new Error('Diagnostics operation is unavailable.'), true);
      handlers.onIdle();
    }
  };

  return {
    submit(value): void {
      if (disposed) return;
      pending = value;
      runNext();
    },
    dispose(): void {
      disposed = true;
      pending = undefined;
    }
  };
}
