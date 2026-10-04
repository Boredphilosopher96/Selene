import { presentDesignerError } from '../presentation-error';

/** A durable host decision and its preview presentation are separate outcomes. */
export async function applyAiProposalDecision<
  Snapshot extends {
    readonly source: { readonly revision: { readonly id: string } };
  }
>(input: {
  readonly operation: 'accept' | 'reject';
  readonly decide: () => Promise<Snapshot>;
  readonly isCurrent: () => boolean;
  readonly onSnapshot: (snapshot: Snapshot) => void;
  readonly onRender: (snapshot: Snapshot) => Promise<void>;
}): Promise<string | undefined> {
  // Host refusal must retain the caller's ordinary decision-error path.
  const next = await input.decide();
  if (!input.isCurrent()) return undefined;
  input.onSnapshot(next);
  try {
    await input.onRender(next);
    if (!input.isCurrent()) return undefined;
    return input.operation === 'accept'
      ? `Accepted ${next.source.revision.id} and refreshed the canonical preview.`
      : 'Rejected the proposal and restored the current design.';
  } catch (error) {
    if (!input.isCurrent()) return undefined;
    const committed =
      input.operation === 'accept'
        ? `Accepted ${next.source.revision.id}. The AI change is saved`
        : 'Rejected the proposal. The current design is saved';
    return `${committed}, but the compiled preview could not refresh. ${presentDesignerError(error, 'preview')}`;
  }
}

/** A refused cancellation is not evidence that the AI request itself failed. */
export function presentAiCancellationFailure(_error: unknown): string {
  return 'Cancellation could not be confirmed. Let the request finish, then review or reject any saved proposal.';
}
