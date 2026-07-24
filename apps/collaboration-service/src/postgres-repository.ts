import {
  collaborationFormat,
  type Approval,
  type AuditEvent,
  type CollaborationEvent,
  type CollaborationRepository,
  CollaborationError,
  type CollaborationSnapshot,
  type Comment,
  type MembershipRole,
  type Project,
  type Reaction,
  type Revision,
  type SignedShareLink,
  type Thread
} from '@selene/collaboration';
import {
  type AuthorizationRequest,
  type CollaborationAuthorizer,
  roleAllows
} from '@selene/collaboration/service';

type Row = Record<string, unknown>;

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new CollaborationError('NOT_FOUND', message);
  return value;
}

function asJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function project(row: Row): Project {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    name: String(row.name)
  };
}
function revision(row: Row): Revision {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    sequence: Number(row.sequence),
    ...(row.parent_revision_id ? { parentRevisionId: String(row.parent_revision_id) } : {}),
    content: asJson(row.content),
    contentSha256: String(row.content_sha256),
    scenarioIds: asJson(row.scenario_ids) as string[],
    createdBy: String(row.created_by),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}
function thread(row: Row): Thread {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    revisionId: String(row.revision_id),
    reactNodeId: String(row.react_node_id),
    scenarioId: String(row.scenario_id),
    createdBy: String(row.created_by),
    createdAt: new Date(String(row.created_at)).toISOString(),
    ...(row.resolved_at ? { resolvedAt: new Date(String(row.resolved_at)).toISOString() } : {}),
    ...(row.resolved_by ? { resolvedBy: String(row.resolved_by) } : {})
  };
}
function comment(row: Row): Comment {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    ...(row.parent_comment_id ? { parentCommentId: String(row.parent_comment_id) } : {}),
    body: String(row.body),
    createdBy: String(row.created_by),
    createdAt: new Date(String(row.created_at)).toISOString(),
    mentionedUserIds: (asJson(row.mentioned_user_ids) ?? []) as string[]
  };
}
function collaborationEvent(row: Row): CollaborationEvent {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    cursor: Number(row.cursor),
    type: String(row.type),
    ...(row.actor_id ? { actorId: String(row.actor_id) } : {}),
    resourceType: String(row.resource_type),
    resourceId: String(row.resource_id),
    payload: asJson(row.payload) as Record<string, unknown>,
    occurredAt: new Date(String(row.occurred_at)).toISOString()
  };
}
function shareLink(row: Row): SignedShareLink {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    tokenHash: String(row.token_hash),
    permission: String(row.permission) as SignedShareLink['permission'],
    expiresAt: new Date(String(row.expires_at)).toISOString(),
    createdBy: String(row.created_by),
    createdAt: new Date(String(row.created_at)).toISOString(),
    ...(row.revoked_at ? { revokedAt: new Date(String(row.revoked_at)).toISOString() } : {})
  };
}

/** Concrete Bun.SQL repository; all values use tagged-template parameters. */
export class BunPostgresCollaborationRepository
  implements CollaborationRepository, CollaborationAuthorizer
{
  public constructor(private readonly sql: Bun.SQL) {}

  async ready(): Promise<void> {
    await this.sql`SELECT 1`;
  }
  async close(): Promise<void> {
    await this.sql.close();
  }
  async authorize(request: AuthorizationRequest): Promise<boolean> {
    const rows =
      request.organizationId === undefined
        ? request.projectId === undefined
          ? []
          : await this.sql<Row[]>`
              SELECT m.role
              FROM projects p
              JOIN organizations o ON o.id = p.organization_id AND o.deleted_at IS NULL
              JOIN memberships m
                ON m.organization_id = p.organization_id
               AND m.user_id = ${request.userId}
               AND m.revoked_at IS NULL
              JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
              WHERE p.id = ${request.projectId} AND p.deleted_at IS NULL
              LIMIT 1`
        : await this.sql<Row[]>`
            SELECT m.role
            FROM organizations o
            JOIN memberships m
              ON m.organization_id = o.id
             AND m.user_id = ${request.userId}
             AND m.revoked_at IS NULL
            JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
            WHERE o.id = ${request.organizationId} AND o.deleted_at IS NULL
            LIMIT 1`;
    const role = rows[0]?.role;
    return typeof role === 'string' && roleAllows(role as MembershipRole, request.action);
  }
  async getProject(id: string) {
    const rows = await this.sql<
      Row[]
    >`SELECT id, organization_id, name FROM projects WHERE id = ${id} AND deleted_at IS NULL`;
    return rows[0] ? project(rows[0]) : undefined;
  }
  async getRevision(id: string) {
    const rows = await this.sql<Row[]>`SELECT * FROM revisions WHERE id = ${id}`;
    return rows[0] ? revision(rows[0]) : undefined;
  }
  async getLatestRevision(projectId: string) {
    const rows = await this.sql<
      Row[]
    >`SELECT * FROM revisions WHERE project_id = ${projectId} ORDER BY sequence DESC LIMIT 1`;
    return rows[0] ? revision(rows[0]) : undefined;
  }
  async createProject(value: Project) {
    await this
      .sql`INSERT INTO projects (id, organization_id, name) VALUES (${value.id}, ${value.organizationId}, ${value.name})`;
  }
  async appendRevision(value: Revision, expectedParentRevisionId?: string) {
    await this.sql.transaction(async (sql) => {
      const rows = await sql<
        Row[]
      >`SELECT id, sequence FROM revisions WHERE project_id = ${value.projectId} ORDER BY sequence DESC LIMIT 1 FOR UPDATE`;
      const latest = rows[0];
      if (
        (latest ? String(latest.id) : undefined) !== expectedParentRevisionId ||
        value.sequence !== (latest ? Number(latest.sequence) : 0) + 1
      )
        throw new CollaborationError('CONFLICT', 'Revision parent is no longer current');
      await sql`INSERT INTO revisions (id, project_id, sequence, parent_revision_id, content, content_sha256, scenario_ids, created_by, created_at) VALUES (${value.id}, ${value.projectId}, ${value.sequence}, ${value.parentRevisionId ?? null}, ${JSON.stringify(value.content)}::jsonb, ${value.contentSha256}, ${JSON.stringify(value.scenarioIds)}::jsonb, ${value.createdBy}, ${value.createdAt})`;
    });
  }
  async createThread(value: Thread) {
    await this
      .sql`INSERT INTO threads (id, project_id, revision_id, react_node_id, scenario_id, created_by, created_at) VALUES (${value.id}, ${value.projectId}, ${value.revisionId}, ${value.reactNodeId}, ${value.scenarioId}, ${value.createdBy}, ${value.createdAt})`;
  }
  async getThread(id: string) {
    const rows = await this.sql<Row[]>`SELECT * FROM threads WHERE id = ${id}`;
    return rows[0] ? thread(rows[0]) : undefined;
  }
  async updateThreadResolution(
    id: string,
    resolvedBy: string,
    resolvedAt = new Date().toISOString()
  ) {
    const rows = await this.sql<
      Row[]
    >`UPDATE threads SET resolved_by = ${resolvedBy}, resolved_at = ${resolvedAt} WHERE id = ${id} RETURNING *`;
    return thread(required(rows[0], 'Thread not found'));
  }
  async createComment(value: Comment) {
    await this.sql.transaction(async (sql) => {
      await sql`INSERT INTO comments (id, thread_id, parent_comment_id, body, created_by, created_at) VALUES (${value.id}, ${value.threadId}, ${value.parentCommentId ?? null}, ${value.body}, ${value.createdBy}, ${value.createdAt})`;
      for (const userId of value.mentionedUserIds)
        await sql`INSERT INTO comment_mentions (comment_id, user_id) VALUES (${value.id}, ${userId})`;
    });
  }
  async getComment(id: string) {
    const rows = await this.sql<
      Row[]
    >`SELECT c.*, COALESCE(json_agg(m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '[]') AS mentioned_user_ids FROM comments c LEFT JOIN comment_mentions m ON m.comment_id = c.id WHERE c.id = ${id} GROUP BY c.id`;
    return rows[0] ? comment(rows[0]) : undefined;
  }
  async addReaction(value: Reaction) {
    await this
      .sql`INSERT INTO comment_reactions (comment_id, user_id, emoji, created_at) VALUES (${value.commentId}, ${value.userId}, ${value.emoji}, ${value.createdAt}) ON CONFLICT (comment_id, user_id, emoji) DO NOTHING`;
  }
  async putApproval(value: Approval) {
    await this
      .sql`INSERT INTO approvals (id, revision_id, user_id, decision, note, created_at) VALUES (${value.id}, ${value.revisionId}, ${value.userId}, ${value.decision}, ${value.note ?? null}, ${value.createdAt}) ON CONFLICT (revision_id, user_id) DO UPDATE SET id = EXCLUDED.id, decision = EXCLUDED.decision, note = EXCLUDED.note, created_at = EXCLUDED.created_at`;
  }
  async appendAudit(value: AuditEvent) {
    await this
      .sql`INSERT INTO audit_events (id, organization_id, actor_id, action, resource_type, resource_id, metadata, occurred_at) VALUES (${value.id}, ${value.organizationId}, ${value.actorId ?? null}, ${value.action}, ${value.resourceType}, ${value.resourceId}, ${JSON.stringify(value.metadata)}::jsonb, ${value.occurredAt})`;
  }
  async appendEvent(value: Omit<CollaborationEvent, 'cursor'>) {
    const rows = await this.sql<Row[]>`
      INSERT INTO collaboration_events
        (id, project_id, type, actor_id, resource_type, resource_id, payload, occurred_at)
      VALUES
        (${value.id}, ${value.projectId}, ${value.type}, ${value.actorId ?? null},
         ${value.resourceType}, ${value.resourceId}, ${JSON.stringify(value.payload)}::jsonb,
         ${value.occurredAt})
      RETURNING *`;
    return collaborationEvent(required(rows[0], 'Could not append collaboration event'));
  }
  async listEvents(projectId: string, afterCursor: number, limit: number) {
    const rows = await this.sql<Row[]>`
      SELECT * FROM collaboration_events
      WHERE project_id = ${projectId} AND cursor > ${afterCursor}
      ORDER BY cursor ASC LIMIT ${limit}`;
    return rows.map(collaborationEvent);
  }
  async createShareLink(value: SignedShareLink) {
    await this.sql`
      INSERT INTO share_links
        (id, project_id, token_hash, permission, expires_at, created_by, created_at, revoked_at)
      VALUES
        (${value.id}, ${value.projectId}, ${value.tokenHash}, ${value.permission}, ${value.expiresAt},
         ${value.createdBy}, ${value.createdAt}, ${value.revokedAt ?? null})`;
  }
  async getShareLink(linkId: string) {
    const rows = await this.sql<Row[]>`SELECT * FROM share_links WHERE id = ${linkId}`;
    return rows[0] ? shareLink(rows[0]) : undefined;
  }
  async revokeShareLink(linkId: string, revokedAt: string) {
    const rows = await this.sql<Row[]>`
      UPDATE share_links SET revoked_at = ${revokedAt}
      WHERE id = ${linkId} AND revoked_at IS NULL RETURNING *`;
    if (!rows[0])
      throw new CollaborationError('NOT_FOUND', 'Share link not found or already revoked');
  }
  async exportProject(projectId: string): Promise<CollaborationSnapshot | undefined> {
    const current = await this.getProject(projectId);
    if (!current) return undefined;
    const revisions = (
      await this.sql<
        Row[]
      >`SELECT * FROM revisions WHERE project_id = ${projectId} ORDER BY sequence`
    ).map(revision);
    const threads = (
      await this.sql<
        Row[]
      >`SELECT * FROM threads WHERE project_id = ${projectId} ORDER BY created_at`
    ).map(thread);
    const comments = (
      await this.sql<
        Row[]
      >`SELECT c.*, COALESCE(json_agg(m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '[]') AS mentioned_user_ids FROM comments c JOIN threads t ON t.id = c.thread_id LEFT JOIN comment_mentions m ON m.comment_id = c.id WHERE t.project_id = ${projectId} GROUP BY c.id ORDER BY c.created_at`
    ).map(comment);
    const reactions = (
      await this.sql<
        Row[]
      >`SELECT r.* FROM comment_reactions r JOIN comments c ON c.id = r.comment_id JOIN threads t ON t.id = c.thread_id WHERE t.project_id = ${projectId}`
    ).map((row) => ({
      commentId: String(row.comment_id),
      userId: String(row.user_id),
      emoji: String(row.emoji),
      createdAt: new Date(String(row.created_at)).toISOString()
    }));
    const approvals = (
      await this.sql<
        Row[]
      >`SELECT a.* FROM approvals a JOIN revisions r ON r.id = a.revision_id WHERE r.project_id = ${projectId}`
    ).map((row) => ({
      id: String(row.id),
      revisionId: String(row.revision_id),
      userId: String(row.user_id),
      decision: String(row.decision) as Approval['decision'],
      ...(row.note ? { note: String(row.note) } : {}),
      createdAt: new Date(String(row.created_at)).toISOString()
    }));
    return {
      format: collaborationFormat,
      project: current,
      revisions,
      threads,
      comments,
      reactions,
      approvals
    };
  }
  async replaceProject(snapshot: CollaborationSnapshot) {
    await this.sql.transaction(async (sql) => {
      await sql`INSERT INTO projects (id, organization_id, name) VALUES (${snapshot.project.id}, ${snapshot.project.organizationId}, ${snapshot.project.name}) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, deleted_at = NULL`;
      for (const value of snapshot.revisions)
        await sql`INSERT INTO revisions (id, project_id, sequence, parent_revision_id, content, content_sha256, scenario_ids, created_by, created_at) VALUES (${value.id}, ${value.projectId}, ${value.sequence}, ${value.parentRevisionId ?? null}, ${JSON.stringify(value.content)}::jsonb, ${value.contentSha256}, ${JSON.stringify(value.scenarioIds)}::jsonb, ${value.createdBy}, ${value.createdAt}) ON CONFLICT (id) DO NOTHING`;
      for (const value of snapshot.threads)
        await sql`INSERT INTO threads (id, project_id, revision_id, react_node_id, scenario_id, created_by, created_at, resolved_at, resolved_by) VALUES (${value.id}, ${value.projectId}, ${value.revisionId}, ${value.reactNodeId}, ${value.scenarioId}, ${value.createdBy}, ${value.createdAt}, ${value.resolvedAt ?? null}, ${value.resolvedBy ?? null}) ON CONFLICT (id) DO NOTHING`;
      for (const value of snapshot.comments) {
        await sql`INSERT INTO comments (id, thread_id, parent_comment_id, body, created_by, created_at) VALUES (${value.id}, ${value.threadId}, ${value.parentCommentId ?? null}, ${value.body}, ${value.createdBy}, ${value.createdAt}) ON CONFLICT (id) DO NOTHING`;
        for (const userId of value.mentionedUserIds)
          await sql`INSERT INTO comment_mentions (comment_id, user_id) VALUES (${value.id}, ${userId}) ON CONFLICT DO NOTHING`;
      }
      for (const value of snapshot.reactions)
        await sql`INSERT INTO comment_reactions (comment_id, user_id, emoji, created_at) VALUES (${value.commentId}, ${value.userId}, ${value.emoji}, ${value.createdAt}) ON CONFLICT DO NOTHING`;
      for (const value of snapshot.approvals)
        await sql`INSERT INTO approvals (id, revision_id, user_id, decision, note, created_at) VALUES (${value.id}, ${value.revisionId}, ${value.userId}, ${value.decision}, ${value.note ?? null}, ${value.createdAt}) ON CONFLICT (revision_id, user_id) DO NOTHING`;
    });
  }
  async deleteProject(projectId: string) {
    await this.sql`UPDATE projects SET deleted_at = now() WHERE id = ${projectId}`;
  }
  async getIdempotency<T>(scope: string, key: string) {
    const rows = await this.sql<
      Row[]
    >`SELECT response FROM idempotency_keys WHERE scope = ${scope} AND key = ${key}`;
    return rows[0] ? (asJson(rows[0].response) as T) : undefined;
  }
  async putIdempotency<T>(scope: string, key: string, response: T) {
    await this
      .sql`INSERT INTO idempotency_keys (scope, key, response) VALUES (${scope}, ${key}, ${JSON.stringify(response)}::jsonb) ON CONFLICT (scope, key) DO NOTHING`;
  }
}
