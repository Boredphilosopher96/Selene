import { describe, expect, it } from 'vitest';

import { CollaborationError, type CollaborationHostContext } from './index';
import { appendPostgresRevision, putPostgresIdempotency, type PostgresExecutor } from './postgres';

describe('PostgreSQL collaboration boundary', () => {
  it('returns the first durable idempotency response after a conflict', async () => {
    const calls: string[] = [];
    const database: PostgresExecutor = {
      async query(sql) {
        calls.push(sql);
        return calls.length === 1 ? { rows: [] } : { rows: [{ response: { result: 'first' } }] };
      }
    };
    await expect(
      putPostgresIdempotency(database, 'scope', 'key', { result: 'second' })
    ).resolves.toEqual({
      result: 'first'
    });
    expect(calls[0]).toContain('ON CONFLICT (scope, key) DO NOTHING');
    expect(calls[1]).toContain('SELECT response');
  });

  it('normalizes a hostile PostgreSQL adapter failure without exposing driver details', async () => {
    const database: PostgresExecutor = {
      async query() {
        throw new Error('driver secret');
      }
    };
    await expect(
      appendPostgresRevision(
        database,
        {
          id: 'revision-1',
          projectId: 'project-1',
          sequence: 1,
          content: {},
          contentSha256: 'a'.repeat(64),
          scenarioIds: [],
          createdBy: 'user-1',
          createdAt: '2026-07-23T20:00:00Z'
        },
        undefined
      )
    ).rejects.toEqual(expect.objectContaining<Partial<CollaborationError>>({ code: 'CONFLICT' }));
  });

  it('cancels a host-bound SQL call before an untrusted executor can run', async () => {
    let called = false;
    const controller = new AbortController();
    controller.abort();
    const context: CollaborationHostContext = {
      signal: controller.signal,
      run: async (operation) => {
        if (controller.signal.aborted) throw new Error('cancelled');
        return operation(context);
      },
      runPort: async (_port, _method, operation) => {
        if (controller.signal.aborted) throw new Error('cancelled');
        return operation(context);
      },
      dispose: () => undefined
    };
    await expect(
      putPostgresIdempotency(
        {
          async query() {
            called = true;
            return { rows: [] };
          }
        },
        'scope',
        'key',
        { result: 'value' },
        context
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(called).toBe(false);
    context.dispose();
  });

  it('captures optional transactions from one data descriptor without reading hostile accessors', async () => {
    let accessorRead = false;
    const accessor = Object.create(
      {
        async query() {
          return { rows: [] };
        }
      },
      {
        transaction: {
          get() {
            accessorRead = true;
            throw new Error('transaction getter secret');
          }
        }
      }
    ) as PostgresExecutor;
    await expect(
      putPostgresIdempotency(accessor, 'scope', 'key', { result: 'value' })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Could not store idempotent response'
    });
    expect(accessorRead).toBe(false);

    class ForgedTransactionError extends CollaborationError {}
    const proxy = new Proxy(
      {
        async query() {
          return { rows: [] };
        },
        async transaction<T>(operation: (executor: PostgresExecutor) => Promise<T>) {
          return operation(this);
        }
      },
      {
        getOwnPropertyDescriptor(_target, key) {
          if (key === 'transaction')
            throw new ForgedTransactionError('FORBIDDEN', 'caller-controlled transaction secret');
          return undefined;
        }
      }
    ) as PostgresExecutor;
    await expect(
      putPostgresIdempotency(proxy, 'scope', 'key', { result: 'value' })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Could not store idempotent response'
    });
  });

  it('retains the exact transaction callable and supervises it through the host context', async () => {
    let transactionCalls = 0;
    const database: PostgresExecutor = {
      async query(sql) {
        return sql.includes('RETURNING')
          ? { rows: [{ response: { result: 'stored' } }] }
          : { rows: [] };
      },
      async transaction<T>(operation: (executor: PostgresExecutor) => Promise<T>) {
        transactionCalls += 1;
        return operation(database);
      }
    };
    const first = await putPostgresIdempotency(database, 'scope-1', 'key-1', { result: 'value' });
    expect(first).toEqual({ result: 'stored' });
    database.transaction = async () => {
      throw new Error('swapped transaction was called');
    };
    const calls: string[] = [];
    const context: CollaborationHostContext = {
      signal: new AbortController().signal,
      run: async (operation) => operation(context),
      runPort: async (_port, method, operation) => {
        calls.push(method);
        return operation(context);
      },
      dispose: () => undefined
    };
    await expect(
      putPostgresIdempotency(database, 'scope-2', 'key-2', { result: 'value' }, context)
    ).resolves.toEqual({ result: 'stored' });
    expect(transactionCalls).toBe(2);
    expect(calls).toContain('transaction');
    expect(calls).toContain('query');
  });
});
