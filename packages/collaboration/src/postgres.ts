import type { Revision } from './index.js';
import { CollaborationError } from './index.js';

/** Minimal driver port; inject pg, postgres.js, Neon, or a transaction wrapper. */
export interface PostgresExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<{ readonly rows: readonly T[] }>;
  transaction?<T>(operation: (executor: PostgresExecutor) => Promise<T>): Promise<T>;
}

/**
 * Appends a revision with an optimistic concurrency guard. The unique project/
 * sequence index is a second line of defense against concurrent writers.
 */
export async function appendPostgresRevision(
  database: PostgresExecutor,
  revision: Revision,
  expectedParentRevisionId: string | undefined
): Promise<void> {
  const work = async (executor: PostgresExecutor) => {
    const current = await executor.query<{ id: string; sequence: number }>(
      'SELECT id, sequence FROM revisions WHERE project_id = $1 ORDER BY sequence DESC LIMIT 1 FOR UPDATE',
      [revision.projectId]
    );
    const latest = current.rows[0];
    if (
      latest?.id !== expectedParentRevisionId ||
      revision.sequence !== (latest?.sequence ?? 0) + 1
    ) {
      throw new CollaborationError('CONFLICT', 'Revision parent is no longer current');
    }
    await executor.query(
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
      ]
    );
  };
  try {
    if (database.transaction) await database.transaction(work);
    else await work(database);
  } catch (error) {
    if (error instanceof CollaborationError) throw error;
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
  response: T
): Promise<T> {
  const result = await database.query<{ response: T }>(
    `INSERT INTO idempotency_keys (scope, key, response) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (scope, key) DO UPDATE SET scope = EXCLUDED.scope
     RETURNING response`,
    [scope, key, JSON.stringify(response)]
  );
  const stored = result.rows[0];
  if (!stored) throw new CollaborationError('CONFLICT', 'Could not store idempotent response');
  return stored.response;
}
