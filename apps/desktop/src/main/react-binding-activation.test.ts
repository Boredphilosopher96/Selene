import { describe, expect, it } from 'vitest';

import { activateReactBindingAfterPreviewPublication } from './react-binding-activation';

const flushTasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('deferred React binding activation', () => {
  it('keeps a published preview independent from a later activation rejection', async () => {
    const order: string[] = [];
    const published = () => order.push('published');

    published();
    activateReactBindingAfterPreviewPublication(
      async () => {
        order.push('activate');
        throw new Error('stale receipt');
      },
      async () => {
        order.push('recorded');
      }
    );

    expect(order).toEqual(['published']);
    await flushTasks();
    expect(order).toEqual(['published', 'activate', 'recorded']);
  });

  it('contains a diagnostics persistence failure without an unhandled rejection', async () => {
    const records: string[] = [];
    activateReactBindingAfterPreviewPublication(
      async () => {
        throw new Error('stale receipt');
      },
      async () => {
        records.push('attempted');
        throw new Error('diagnostics unavailable');
      }
    );

    await flushTasks();
    expect(records).toEqual(['attempted']);
  });
});
