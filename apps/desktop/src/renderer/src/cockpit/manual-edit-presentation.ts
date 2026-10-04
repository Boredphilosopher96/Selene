/** The source transaction has already committed before this function is called. */
export async function presentCommittedManualEdit<Snapshot>(input: {
  readonly snapshot: () => Promise<Snapshot>;
  readonly onSnapshot: (snapshot: Snapshot) => void;
  readonly clearSelection: () => void;
  readonly render: (snapshot: Snapshot) => Promise<unknown>;
  readonly successMessage: string;
  readonly refreshFailureMessage: string;
}): Promise<Readonly<{ applied: true; message: string }>> {
  try {
    // A removed target must lose authority even if snapshot or presentation fails.
    input.clearSelection();
    const snapshot = await input.snapshot();
    input.onSnapshot(snapshot);
    await input.render(snapshot);
    return { applied: true, message: input.successMessage };
  } catch {
    return { applied: true, message: input.refreshFailureMessage };
  }
}
