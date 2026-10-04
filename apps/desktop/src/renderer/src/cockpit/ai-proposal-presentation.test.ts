import { expect, it, vi } from 'vitest';

import { applyAiProposalDecision, presentAiCancellationFailure } from './ai-proposal-presentation';

it.each(['accept', 'reject'] as const)(
  'retains a committed %s decision when preview rendering fails',
  async (operation) => {
    const next = { source: { revision: { id: 'saved-r2' } }, pendingAIProposal: undefined };
    let adopted: typeof next | undefined;
    const events: string[] = [];
    const decide = vi.fn(async () => {
      events.push('commit');
      return next;
    });
    const result = await applyAiProposalDecision({
      operation,
      decide,
      isCurrent: () => true,
      onSnapshot(snapshot) {
        adopted = snapshot;
        events.push('adopt');
      },
      async onRender(snapshot) {
        expect(adopted).toBe(snapshot);
        events.push('render');
        throw new Error('private host path must not escape');
      }
    });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['commit', 'adopt', 'render']);
    expect(adopted).toBe(next);
    expect(result).toContain(
      operation === 'accept'
        ? 'Accepted saved-r2. The AI change is saved'
        : 'Rejected the proposal. The current design is saved'
    );
    expect(result).toContain('compiled preview could not refresh');
    expect(result).not.toContain('private host path');
    expect(result).not.toContain('could not complete the AI change');
  }
);

it.each(['accept', 'reject'] as const)(
  'reports %s success only after the committed snapshot is rendered',
  async (operation) => {
    const next = { source: { revision: { id: 'saved-r2' } } };
    const render = vi.fn(async () => undefined);
    const result = await applyAiProposalDecision({
      operation,
      decide: async () => next,
      isCurrent: () => true,
      onSnapshot: () => undefined,
      onRender: render
    });
    expect(render).toHaveBeenCalledWith(next);
    expect(result).toBe(
      operation === 'accept'
        ? 'Accepted saved-r2 and refreshed the canonical preview.'
        : 'Rejected the proposal and restored the current design.'
    );
  }
);

it('propagates a host refusal without adopting or rendering an uncommitted decision', async () => {
  const adopt = vi.fn();
  const render = vi.fn();
  await expect(
    applyAiProposalDecision({
      operation: 'accept',
      decide: async () => {
        throw new Error('host refused');
      },
      isCurrent: () => true,
      onSnapshot: adopt,
      onRender: render
    })
  ).rejects.toThrow('host refused');
  expect(adopt).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
});

it('does not adopt a decision for a departed project', async () => {
  const adopt = vi.fn();
  const render = vi.fn();
  const result = await applyAiProposalDecision({
    operation: 'accept',
    decide: async () => ({ source: { revision: { id: 'saved-r2' } } }),
    isCurrent: () => false,
    onSnapshot: adopt,
    onRender: render
  });
  expect(result).toBeUndefined();
  expect(adopt).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
});

it.each([false, true])(
  'discards presentation feedback after a project switch, render failure=%s',
  async (fail) => {
    let current = true;
    const result = await applyAiProposalDecision({
      operation: 'accept',
      decide: async () => ({ source: { revision: { id: 'saved-r2' } } }),
      isCurrent: () => current,
      onSnapshot: () => undefined,
      onRender: async () => {
        current = false;
        if (fail) throw new Error('old preview failed');
      }
    });
    expect(result).toBeUndefined();
  }
);

it.each([
  'The AI proposal is being saved. Reject it after saving finishes.',
  'Private provider /home/user/project endpoint failed to cancel'
])(
  'does not label the whole request failed or cancelled after a cancellation refusal',
  (message) => {
    const notice = presentAiCancellationFailure(new Error(message));
    expect(notice).toBe(
      'Cancellation could not be confirmed. Let the request finish, then review or reject any saved proposal.'
    );
    expect(notice).not.toContain('AI change');
    expect(notice).not.toContain('was cancelled');
    expect(notice).not.toContain(message);
  }
);
