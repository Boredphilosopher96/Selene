export function withoutGuidedSelection<Snapshot extends { readonly selectedNodeId?: string }>(
  snapshot: Snapshot
): Omit<Snapshot, 'selectedNodeId'> {
  const { selectedNodeId: _selectedNodeId, ...cleared } = snapshot;
  return cleared;
}

export async function refreshGuidedInput<
  Result,
  Snapshot extends { readonly source: { readonly projectId: string }; readonly setup?: unknown }
>(input: {
  readonly previous: Snapshot;
  readonly operation: () => Promise<Result>;
  readonly clearSelection: () => void;
  readonly snapshot: () => Promise<Snapshot>;
  readonly onSnapshot: (snapshot: Snapshot) => void;
  readonly render: (snapshot: Snapshot) => Promise<unknown>;
  readonly onRefreshFailure: () => void;
  readonly complete: (committed: Result, acknowledged: Snapshot | undefined) => Result;
}): Promise<Result> {
  const committed = await input.operation();
  let acknowledged: Snapshot | undefined;
  const adopt = (next: Snapshot) => {
    if (next.source.projectId !== input.previous.source.projectId)
      throw new Error('Project changed after saving design inputs.');
    acknowledged = next;
    input.onSnapshot(next);
  };
  try {
    input.clearSelection();
    const next = await input.snapshot();
    adopt(next);
    if (JSON.stringify(input.previous.setup) !== JSON.stringify(next.setup)) {
      await input.render(next);
      adopt(await input.snapshot());
    }
  } catch {
    input.onRefreshFailure();
  }
  return input.complete(committed, acknowledged);
}
