import { describe, expect, it } from 'vitest';

import { refreshGuidedInput, withoutGuidedSelection } from './guided-input-refresh';

interface Snapshot {
  readonly source: { readonly projectId: string };
  readonly setup?: { readonly designSystems: readonly string[] };
  readonly selectedNodeId?: string;
  readonly authority: string;
}

const previous: Snapshot = {
  source: { projectId: 'project-a' },
  selectedNodeId: 'selected-before-inputs',
  authority: 'old-binding'
};
const committed: Snapshot = {
  ...previous,
  setup: { designSystems: ['new-input'] },
  authority: 'binding-revoked'
};

function journey(failure?: 'commit' | 'snapshot' | 'render' | 'final-snapshot') {
  const events: string[] = [];
  const adopted: Snapshot[] = [];
  let host = committed;
  let reads = 0;
  const operation = async () => {
    events.push('commit');
    if (failure === 'commit') throw new Error('persistence rejected');
    return committed;
  };
  return {
    events,
    adopted,
    input: {
      previous,
      operation,
      clearSelection() {
        events.push('clear');
        host = withoutGuidedSelection(host);
      },
      async snapshot() {
        events.push('read');
        reads += 1;
        if (failure === 'snapshot' || (failure === 'final-snapshot' && reads === 2))
          throw new Error('snapshot unavailable');
        return host;
      },
      onSnapshot(snapshot: Snapshot) {
        events.push('adopt');
        adopted.push(snapshot);
      },
      async render(snapshot: Snapshot) {
        events.push('render');
        expect(snapshot.selectedNodeId).toBeUndefined();
        if (failure === 'render') throw new Error('presentation unavailable');
        host = { ...host, authority: 'fresh-compiled-binding' };
      },
      onRefreshFailure() {
        events.push('saved-refresh-failed');
      },
      complete(result: Snapshot, acknowledged: Snapshot | undefined): Snapshot {
        return acknowledged ?? withoutGuidedSelection(result);
      }
    }
  };
}

describe('guided input commit and refresh', () => {
  it('propagates a rejected save without clearing selection or reading the host', async () => {
    const test = journey('commit');
    await expect(refreshGuidedInput(test.input)).rejects.toThrow('persistence rejected');
    expect(test.events).toEqual(['commit']);
    expect(test.adopted).toEqual([]);
  });

  it.each(['snapshot', 'render', 'final-snapshot'] as const)(
    'keeps the confirmed setter result and cleared selection when %s fails',
    async (failure) => {
      const test = journey(failure);
      const result = await refreshGuidedInput(test.input);
      expect(result).toEqual({
        source: { projectId: 'project-a' },
        setup: { designSystems: ['new-input'] },
        authority: 'binding-revoked'
      });
      expect(test.events.slice(0, 3)).toEqual(['commit', 'clear', 'read']);
      expect(test.events.at(-1)).toBe('saved-refresh-failed');
      expect(test.adopted.every((snapshot) => snapshot.selectedNodeId === undefined)).toBe(true);
    }
  );

  it('returns the final host authority, so setter callers cannot restore the old selection', async () => {
    const test = journey();
    const result = await refreshGuidedInput(test.input);
    expect(result).toEqual({
      source: { projectId: 'project-a' },
      setup: { designSystems: ['new-input'] },
      authority: 'fresh-compiled-binding'
    });
    expect(test.events).toEqual(['commit', 'clear', 'read', 'adopt', 'render', 'read', 'adopt']);
    expect(test.adopted.at(-1)).toEqual(result);
    expect(committed.selectedNodeId).toBe('selected-before-inputs');
  });

  it('preserves a receipt result after a post-commit read fails', async () => {
    const test = journey('snapshot');
    const receipt = { artifactDigest: 'saved-input-digest' };
    const result = await refreshGuidedInput({
      ...test.input,
      operation: async () => receipt,
      complete: (saved) => saved
    });
    expect(result).toEqual({ artifactDigest: 'saved-input-digest' });
    expect(test.events).toEqual(['clear', 'read', 'saved-refresh-failed']);
  });

  it('adopts current host state without recompiling when the setup is unchanged', async () => {
    const test = journey();
    const result = await refreshGuidedInput({ ...test.input, previous: committed });
    expect(result).toEqual({
      source: { projectId: 'project-a' },
      setup: { designSystems: ['new-input'] },
      authority: 'binding-revoked'
    });
    expect(test.events).toEqual(['commit', 'clear', 'read', 'adopt']);
  });

  it('does not adopt another project after the original save commits', async () => {
    const test = journey();
    const result = await refreshGuidedInput({
      ...test.input,
      snapshot: async () => ({ ...committed, source: { projectId: 'project-b' } })
    });
    expect(result).toEqual(withoutGuidedSelection(committed));
    expect(test.adopted).toEqual([]);
    expect(test.events).toEqual(['commit', 'clear', 'saved-refresh-failed']);
  });
});
