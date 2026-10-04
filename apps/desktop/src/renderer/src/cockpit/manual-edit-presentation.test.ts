import { expect, it } from 'vitest';

import { presentCommittedManualEdit } from './manual-edit-presentation';

it.each(['snapshot', 'render'] as const)(
  'reports committed removal and clears selection when %s fails',
  async (failure) => {
    const events: string[] = [];
    const result = await presentCommittedManualEdit({
      async snapshot() {
        events.push('snapshot');
        if (failure === 'snapshot') throw new Error('snapshot unavailable');
        return { revisionId: 'committed-removal' };
      },
      onSnapshot(snapshot) {
        expect(snapshot.revisionId).toBe('committed-removal');
        events.push('adopt');
      },
      clearSelection() {
        events.push('clear');
      },
      async render() {
        events.push('render');
        throw new Error('preview unavailable');
      },
      successMessage: 'Removed.',
      refreshFailureMessage: 'Removed. Preview refresh failed.'
    });
    expect(result).toEqual({ applied: true, message: 'Removed. Preview refresh failed.' });
    expect(events).toEqual(
      failure === 'snapshot' ? ['clear', 'snapshot'] : ['clear', 'snapshot', 'adopt', 'render']
    );
  }
);

it('presents the acknowledged revision and reports success after rendering', async () => {
  const revisions: string[] = [];
  const result = await presentCommittedManualEdit({
    snapshot: async () => 'committed-removal',
    onSnapshot: (snapshot) => revisions.push(snapshot),
    clearSelection() {},
    render: async (snapshot) => revisions.push(snapshot),
    successMessage: 'Removed.',
    refreshFailureMessage: 'Removed. Preview refresh failed.'
  });
  expect(result).toEqual({ applied: true, message: 'Removed.' });
  expect(revisions).toEqual(['committed-removal', 'committed-removal']);
});
