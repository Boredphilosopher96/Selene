import type { CollaborationHostContext, Revision } from './index.js';
import { callCollaborationHostPort, CollaborationError, ownCollaborationValue } from './index.js';

/** Minimal driver port; inject pg, postgres.js, Neon, or a transaction wrapper. */
export interface PostgresExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
    context?: CollaborationHostContext
  ): Promise<{ readonly rows: readonly T[] }>;
  transaction?<T>(operation: (executor: PostgresExecutor) => Promise<T>): Promise<T>;
}

type CapturedTransaction = Readonly<{
  readonly port: object;
  invoke<T>(operation: (executor: PostgresExecutor) => Promise<T>): Promise<T>;
}>;

const maxTransactionPrototypeDepth = 8;
const capturedTransactions = new WeakMap<object, CapturedTransaction | undefined>();

/**
 * Transaction is optional, so it cannot use an ordinary existence/property
 * check. Capture one bounded data descriptor and retain that exact callable;
 * this prevents a getter or post-validation mutation from escaping either
 * the direct or supervised path.
 */
function captureTransaction(database: PostgresExecutor): CapturedTransaction | undefined {
  if (database === null || (typeof database !== 'object' && typeof database !== 'function'))
    throw new CollaborationError('CONFLICT', 'PostgreSQL transaction is invalid');
  const source = database as unknown as object;
  if (capturedTransactions.has(source)) return capturedTransactions.get(source);
  const seen = new WeakSet<object>();
  let candidate: object | null = source;
  try {
    for (let depth = 0; candidate !== null && depth <= maxTransactionPrototypeDepth; depth += 1) {
      if (seen.has(candidate))
        throw new CollaborationError('CONFLICT', 'PostgreSQL transaction is invalid');
      seen.add(candidate);
      const descriptor = Object.getOwnPropertyDescriptor(candidate, 'transaction');
      if (descriptor !== undefined) {
        if (!('value' in descriptor) || typeof descriptor.value !== 'function')
          throw new CollaborationError('CONFLICT', 'PostgreSQL transaction is invalid');
        const method = descriptor.value as (
          operation: (executor: PostgresExecutor) => Promise<unknown>
        ) => Promise<unknown>;
        const port = Object.freeze(
          Object.defineProperty(Object.create(null), 'transaction', {
            value: (...args: readonly unknown[]) => Reflect.apply(method, source, args),
            enumerable: true,
            configurable: false,
            writable: false
          })
        );
        const captured: CapturedTransaction = Object.freeze({
          port,
          invoke<T>(operation: (executor: PostgresExecutor) => Promise<T>): Promise<T> {
            return Promise.resolve(Reflect.apply(method, source, [operation])) as Promise<T>;
          }
        });
        capturedTransactions.set(source, captured);
        return captured;
      }
      candidate = Object.getPrototypeOf(candidate);
    }
    if (candidate !== null)
      throw new CollaborationError('CONFLICT', 'PostgreSQL transaction is invalid');
    capturedTransactions.set(source, undefined);
    return undefined;
  } catch {
    throw new CollaborationError('CONFLICT', 'PostgreSQL transaction is invalid');
  }
}

async function query<T extends Record<string, unknown>>(
  executor: PostgresExecutor,
  sql: string,
  values: readonly unknown[],
  context: CollaborationHostContext | undefined
): Promise<{ readonly rows: readonly T[] }> {
  return context
    ? callCollaborationHostPort<{ readonly rows: readonly T[] }>(context, executor, 'query', [
        sql,
        values
      ])
    : executor.query<T>(sql, values);
}

async function transaction<T>(
  database: PostgresExecutor,
  operation: (executor: PostgresExecutor) => Promise<T>,
  context: CollaborationHostContext | undefined
): Promise<T> {
  const captured = captureTransaction(database);
  if (!captured) return operation(database);
  return context
    ? callCollaborationHostPort<T>(context, captured.port, 'transaction', [operation])
    : captured.invoke(operation);
}

/**
 * Appends a revision with an optimistic concurrency guard. The unique project/
 * sequence index is a second line of defense against concurrent writers.
 */
export async function appendPostgresRevision(
  database: PostgresExecutor,
  revision: Revision,
  expectedParentRevisionId: string | undefined,
  context?: CollaborationHostContext
): Promise<void> {
  try {
    revision = ownCollaborationValue(revision);
    expectedParentRevisionId =
      expectedParentRevisionId === undefined
        ? undefined
        : ownCollaborationValue(expectedParentRevisionId);
  } catch {
    throw new CollaborationError('INVALID', 'PostgreSQL revision input is invalid');
  }
  const work = async (executor: PostgresExecutor) => {
    const current = await query<{ id: string; sequence: number }>(
      executor,
      'SELECT id, sequence FROM revisions WHERE project_id = $1 ORDER BY sequence DESC LIMIT 1 FOR UPDATE',
      [revision.projectId],
      context
    );
    const latest = current.rows[0];
    if (
      latest?.id !== expectedParentRevisionId ||
      revision.sequence !== (latest?.sequence ?? 0) + 1
    ) {
      throw new CollaborationError('CONFLICT', 'Revision parent is no longer current');
    }
    await query(
      executor,
      `INSERT INTO revisions (id, project_id, sequence, parent_revision_id, content, content_sha256,
        scenario_ids, created_by, created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9)`,
      [
        revision.id,
        revision.projectId,
        revision.sequence,
        revision.parentRevisionId ?? null,
        JSON.stringify(revision.content),
        revision.contentSha256,
        JSON.stringify(revision.scenarioIds),
        revision.createdBy,
        revision.createdAt
      ],
      context
    );
  };
  try {
    await transaction(database, work, context);
  } catch {
    throw new CollaborationError(
      'CONFLICT',
      'Revision could not be appended; retry with the latest parent'
    );
  }
}

/** Store a completed response once; PostgreSQL's primary key gives retry safety. */
export async function putPostgresIdempotency<T>(
  database: PostgresExecutor,
  scope: string,
  key: string,
  response: T,
  context?: CollaborationHostContext
): Promise<T> {
  try {
    scope = ownCollaborationValue(scope);
    key = ownCollaborationValue(key);
    response = ownCollaborationValue(response);
    if (!scope.trim() || !key.trim())
      throw new CollaborationError('INVALID', 'Idempotency scope and key are required');
    const work = async (executor: PostgresExecutor): Promise<T> => {
      const inserted = await query<{ response: T }>(
        executor,
        `INSERT INTO idempotency_keys (scope, key, response) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (scope, key) DO NOTHING
       RETURNING response`,
        [scope, key, JSON.stringify(response)],
        context
      );
      const stored =
        inserted.rows[0] ??
        (
          await query<{ response: T }>(
            executor,
            'SELECT response FROM idempotency_keys WHERE scope = $1 AND key = $2',
            [scope, key],
            context
          )
        ).rows[0];
      if (!stored) throw new CollaborationError('CONFLICT', 'Could not store idempotent response');
      return ownCollaborationValue(stored.response) as T;
    };
    return await transaction(database, work, context);
  } catch {
    throw new CollaborationError('CONFLICT', 'Could not store idempotent response');
  }
}
