import {
  collaborationFormat,
  designReviewStateFormat,
  type Approval,
  type AIChangeRequest,
  type AuditEvent,
  type CollaborationEvent,
  type CommitDesignRevisionInput,
  type CommitDesignRevisionResult,
  type CollaborationRepository,
  CollaborationError,
  type CollaborationSnapshot,
  type Comment,
  type DesignReviewState,
  type MembershipRole,
  type Project,
  type Reaction,
  type Revision,
  type ReviewThread,
  type ReviewThreadFilter,
  type ReviewThreadMessage,
  type ReviewThreadMutation,
  type ReviewThreadMutationResult,
  type SemanticDesignChange,
  type SignedShareLink,
  type Thread,
  type DeveloperAnnotation,
  type SpatialAnchor,
  validateAIChangeRequest,
  validateAIChangeRequestResultReferences,
  validateAIChangeRequestTransition,
  validateDesignReviewState,
  validateCollaborationSnapshot,
  validateDeveloperAnnotation,
  validateReviewThread,
  canonicalReviewThreadMutationFingerprint,
  normalizeReviewThreadMutation,
  validateSpatialAnchor
} from '@selene/collaboration';
import {
  type AuthorizationRequest,
  type CollaborationAuthorizer,
  roleAllows
} from '@selene/collaboration/service';
import type {
  BreakGlassRecoveryRequest,
  GuestReviewPolicy,
  IdentityAdministrationRepository,
  IdentityAuditEvent,
  IdentityMembership,
  OrganizationInvitation
} from '@selene/collaboration/identity';
import type { HostedBffSession } from '@selene/identity-runtime';

type Row = Record<string, unknown>;

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new CollaborationError('NOT_FOUND', message);
  return value;
}

/** Reads an allowlisted driver code without invoking an error getter or proxy-controlled property access. */
function driverCode(error: unknown): '23505' | '23503' | '23514' | '22P02' | undefined {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function'))
    return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (!descriptor || !('value' in descriptor)) return undefined;
    switch (descriptor.value) {
      case '23505':
      case '23503':
      case '23514':
      case '22P02':
        return descriptor.value;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function asJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function reviewOperationReceipt(value: unknown): {
  readonly kind: 'create' | 'reply' | 'resolve' | 'reopen';
  readonly fingerprint: string;
  readonly messageId?: string;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new CollaborationError('INVALID', 'Stored review receipt is invalid');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !('value' in descriptor)))
    throw new CollaborationError('INVALID', 'Stored review receipt is invalid');
  const keys = Object.keys(descriptors).sort((left, right) => left.localeCompare(right, 'en'));
  if (!keys.every((key) => ['fingerprint', 'kind', 'messageId'].includes(key)))
    throw new CollaborationError('INVALID', 'Stored review receipt is invalid');
  const kind = descriptors.kind?.value;
  const fingerprint = descriptors.fingerprint?.value;
  const messageId = descriptors.messageId?.value;
  if (
    (kind !== 'create' && kind !== 'reply' && kind !== 'resolve' && kind !== 'reopen') ||
    typeof fingerprint !== 'string' ||
    fingerprint.length === 0 ||
    fingerprint.length > 1_048_576 ||
    (messageId !== undefined && (typeof messageId !== 'string' || messageId.length > 128)) ||
    (kind === 'reply') !== (messageId !== undefined)
  )
    throw new CollaborationError('INVALID', 'Stored review receipt is invalid');
  return { kind, fingerprint, ...(messageId === undefined ? {} : { messageId }) };
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
function reviewThread(row: Row): ReviewThread {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    ...(row.hosted_binding
      ? { hostedBinding: asJson(row.hosted_binding) as ReviewThread['hostedBinding'] }
      : {}),
    version: Number(row.version),
    anchor: asJson(row.anchor) as ReviewThread['anchor'],
    messages: asJson(row.messages) as ReviewThread['messages'],
    deepLink: String(row.deep_link),
    lifecycle: String(row.lifecycle) as ReviewThread['lifecycle'],
    createdBy: String(row.created_by),
    createdAt: new Date(String(row.created_at)).toISOString(),
    ...(row.resolved_at ? { resolvedAt: new Date(String(row.resolved_at)).toISOString() } : {}),
    ...(row.resolved_by ? { resolvedBy: String(row.resolved_by) } : {}),
    ...(row.reopened_at ? { reopenedAt: new Date(String(row.reopened_at)).toISOString() } : {}),
    ...(row.reopened_by ? { reopenedBy: String(row.reopened_by) } : {}),
    ...(row.moved_at ? { movedAt: new Date(String(row.moved_at)).toISOString() } : {}),
    ...(row.moved_by ? { movedBy: String(row.moved_by) } : {})
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
function semanticDesignChange(row: Row): SemanticDesignChange {
  return {
    id: String(row.id),
    kind: String(row.kind) as SemanticDesignChange['kind'],
    beforeRevision: {
      id: String(row.before_revision_id),
      fingerprint: String(row.before_revision_fingerprint)
    },
    currentRevision: {
      id: String(row.current_revision_id),
      fingerprint: String(row.current_revision_fingerprint)
    },
    affected: asJson(row.affected) as SemanticDesignChange['affected'],
    evidence: asJson(row.evidence) as SemanticDesignChange['evidence'],
    provenance: asJson(row.provenance) as SemanticDesignChange['provenance'],
    reason: String(row.reason),
    occurredAt: new Date(String(row.occurred_at)).toISOString()
  };
}

function organizationInvitation(row: Row): OrganizationInvitation {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    email: String(row.email),
    role: String(row.role) as OrganizationInvitation['role'],
    tokenHash: String(row.token_hash),
    status: String(row.status) as OrganizationInvitation['status'],
    expiresAt: new Date(String(row.expires_at)).toISOString(),
    createdBy: String(row.created_by),
    createdAt: new Date(String(row.created_at)).toISOString(),
    ...(row.accepted_by ? { acceptedBy: String(row.accepted_by) } : {}),
    ...(row.accepted_at ? { acceptedAt: new Date(String(row.accepted_at)).toISOString() } : {}),
    ...(row.revoked_at ? { revokedAt: new Date(String(row.revoked_at)).toISOString() } : {})
  };
}

/** Concrete Bun.SQL repository; all values use tagged-template parameters. */
export class BunPostgresCollaborationRepository
  implements CollaborationRepository, CollaborationAuthorizer, IdentityAdministrationRepository
{
  public constructor(private readonly sql: Bun.SQL) {}

  async ready(): Promise<void> {
    await this.sql`SELECT 1`;
  }
  /** A controlled test shutdown may opt out of waiting for pooled idle connections. */
  async close(options?: { readonly timeout?: number }): Promise<void> {
    await this.sql.close(options);
  }
  async transaction<T>(
    operation: (unit: IdentityAdministrationRepository) => Promise<T>
  ): Promise<T> {
    return this.sql.transaction(async (sql) =>
      operation(new BunPostgresCollaborationRepository(sql))
    );
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
              JOIN users u
                ON u.id = m.user_id
               AND u.organization_id = m.organization_id
               AND u.deleted_at IS NULL
              WHERE p.id = ${request.projectId} AND p.deleted_at IS NULL
              UNION ALL
              SELECT 'owner' AS role
              FROM projects p
              JOIN break_glass_recoveries b
                ON b.organization_id = p.organization_id
               AND b.subject_id = ${request.userId}
               AND b.revoked_at IS NULL
               AND b.expires_at > now()
              JOIN users u
                ON u.id = b.subject_id
               AND u.organization_id = b.organization_id
               AND u.deleted_at IS NULL
              WHERE p.id = ${request.projectId} AND p.deleted_at IS NULL
              LIMIT 1`
        : await this.sql<Row[]>`
            SELECT m.role
            FROM organizations o
            JOIN memberships m
              ON m.organization_id = o.id
             AND m.user_id = ${request.userId}
             AND m.revoked_at IS NULL
            JOIN users u
              ON u.id = m.user_id
             AND u.organization_id = m.organization_id
             AND u.deleted_at IS NULL
            WHERE o.id = ${request.organizationId} AND o.deleted_at IS NULL
            UNION ALL
            SELECT 'owner' AS role
            FROM organizations o
            JOIN break_glass_recoveries b
              ON b.organization_id = o.id
             AND b.subject_id = ${request.userId}
             AND b.revoked_at IS NULL
             AND b.expires_at > now()
            JOIN users u
              ON u.id = b.subject_id
             AND u.organization_id = b.organization_id
             AND u.deleted_at IS NULL
            WHERE o.id = ${request.organizationId} AND o.deleted_at IS NULL
            LIMIT 1`;
    const role = rows[0]?.role;
    return typeof role === 'string' && roleAllows(role as MembershipRole, request.action);
  }
  /** Resolves only an active, provisioned OIDC/SAML subject; login never creates an implicit member. */
  async resolveExternalSubject(subject: string): Promise<string | undefined> {
    const rows = await this.sql<Row[]>`
      SELECT id FROM users WHERE external_subject = ${subject} AND deleted_at IS NULL LIMIT 2`;
    return rows.length === 1 && rows[0] ? String(rows[0].id) : undefined;
  }
  /** Every BFF request rechecks the active organization membership and its access version. */
  async resolveBffIdentity(
    session: HostedBffSession
  ): Promise<
    | { readonly userId: string; readonly organizationId: string; readonly accessVersion: number }
    | undefined
  > {
    if ((session.organizationId === undefined) !== (session.accessVersion === undefined)) {
      return undefined;
    }
    const rows =
      session.organizationId === undefined
        ? await this.sql<Row[]>`
            SELECT u.id, u.organization_id, m.access_version
            FROM users u
            JOIN memberships m
              ON m.organization_id = u.organization_id
             AND m.user_id = u.id
             AND m.revoked_at IS NULL
            JOIN organizations o ON o.id = u.organization_id AND o.deleted_at IS NULL
            WHERE u.external_subject = ${session.subject} AND u.deleted_at IS NULL
            LIMIT 2`
        : await this.sql<Row[]>`
            SELECT u.id, u.organization_id, m.access_version
            FROM users u
            JOIN memberships m
              ON m.organization_id = u.organization_id
             AND m.user_id = u.id
             AND m.revoked_at IS NULL
            JOIN organizations o ON o.id = u.organization_id AND o.deleted_at IS NULL
            WHERE u.external_subject = ${session.subject}
              AND u.deleted_at IS NULL
              AND u.organization_id = ${session.organizationId}
              AND m.access_version = ${session.accessVersion}
            LIMIT 2`;
    if (rows.length !== 1) return undefined;
    const row = rows[0];
    return row
      ? {
          userId: String(row.id),
          organizationId: String(row.organization_id),
          accessVersion: Number(row.access_version)
        }
      : undefined;
  }
  async findInvitationByTokenHash(tokenHash: string): Promise<OrganizationInvitation | undefined> {
    const rows = await this.sql<Row[]>`
      SELECT * FROM organization_invitations
      WHERE token_hash = ${tokenHash} AND status = 'pending'
      FOR UPDATE`;
    return rows[0] ? organizationInvitation(rows[0]) : undefined;
  }
  async readGuestReviewPolicy(organizationId: string): Promise<GuestReviewPolicy> {
    const rows = await this.sql<Row[]>`
      SELECT allow_invited_guests FROM organization_guest_review_policies
      WHERE organization_id = ${organizationId}`;
    return {
      organizationId,
      allowInvitedGuests: rows[0]?.allow_invited_guests === true
    };
  }
  async acceptInvitation(
    invitationId: string,
    acceptedBy: string,
    acceptedAt: string
  ): Promise<boolean> {
    const rows = await this.sql<Row[]>`
      UPDATE organization_invitations
      SET status = 'accepted', accepted_by = ${acceptedBy}, accepted_at = ${acceptedAt}
      FROM users u
      WHERE organization_invitations.id = ${invitationId}
        AND u.id = ${acceptedBy}
        AND u.organization_id = organization_invitations.organization_id
        AND organization_invitations.status = 'pending'
        AND organization_invitations.expires_at > ${acceptedAt}
      RETURNING organization_invitations.id`;
    return rows.length === 1;
  }
  async upsertMembership(membership: IdentityMembership): Promise<void> {
    const rows = await this.sql<Row[]>`
      INSERT INTO memberships (organization_id, user_id, role, access_version)
      SELECT ${membership.organizationId}, u.id, ${membership.role}, 1
      FROM users u
      WHERE u.id = ${membership.subjectId} AND u.organization_id = ${membership.organizationId}
      ON CONFLICT (organization_id, user_id) DO UPDATE
      SET role = EXCLUDED.role, revoked_at = NULL, access_version = memberships.access_version + 1
      RETURNING user_id`;
    if (rows.length !== 1) {
      throw new CollaborationError(
        'FORBIDDEN',
        'Membership subject does not belong to organization'
      );
    }
  }
  async recordBreakGlassRecovery(
    request: BreakGlassRecoveryRequest,
    actorId: string
  ): Promise<void> {
    const rows = await this.sql<Row[]>`
      INSERT INTO break_glass_recoveries
        (id, organization_id, subject_id, case_id, reason, expires_at, created_by)
      SELECT
        ${crypto.randomUUID()}, ${request.organizationId}, u.id, ${request.caseId},
        ${request.reason}, ${request.expiresAt}, ${actorId}
      FROM users u
      JOIN users actor ON actor.id = ${actorId} AND actor.organization_id = ${request.organizationId}
      WHERE u.id = ${request.subjectId} AND u.organization_id = ${request.organizationId}
      RETURNING id`;
    if (rows.length !== 1) {
      throw new CollaborationError('FORBIDDEN', 'Recovery subject does not belong to organization');
    }
  }
  async revokeMemberships(
    organizationId: string,
    subjectId: string,
    revokedAt: string
  ): Promise<void> {
    await this.sql`
      UPDATE memberships
      SET revoked_at = ${revokedAt}, access_version = access_version + 1
      WHERE organization_id = ${organizationId} AND user_id = ${subjectId} AND revoked_at IS NULL`;
  }
  async revokeSessions(
    organizationId: string,
    subjectId: string,
    revokedAt: string
  ): Promise<void> {
    await this.sql`
      UPDATE oidc_bff_sessions s
      SET revoked_at = ${revokedAt}
      FROM users u
      WHERE s.subject = u.external_subject
        AND s.organization_id = ${organizationId}
        AND u.id = ${subjectId}
        AND s.revoked_at IS NULL`;
  }
  async recordAudit(event: IdentityAuditEvent): Promise<void> {
    const organizationId =
      typeof event.attributes.organizationId === 'string'
        ? event.attributes.organizationId
        : undefined;
    if (organizationId === undefined) {
      throw new CollaborationError('INVALID', 'Identity audit events require an organization ID');
    }
    await this.sql`
      INSERT INTO audit_events
        (id, organization_id, actor_id, action, resource_type, resource_id, metadata, occurred_at)
      VALUES (
        ${crypto.randomUUID()}, ${organizationId}, ${event.subjectId ?? null}, ${event.action}, 'identity',
        ${crypto.randomUUID()}, ${JSON.stringify(event.attributes)}::jsonb, ${event.occurredAt}
      )`;
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
  async getDesignReviewState(projectId: string): Promise<DesignReviewState | undefined> {
    const rows = await this.sql<Row[]>`
      SELECT s.readiness, s.currency, s.approvals_stale,
        b.id AS baseline_id, b.revision_id AS baseline_revision_id,
        b.revision_fingerprint AS baseline_revision_fingerprint, b.intent AS baseline_intent,
        b.created_by AS baseline_created_by, b.created_at AS baseline_created_at
      FROM projects p
      LEFT JOIN design_review_states s ON s.project_id = p.id
      LEFT JOIN design_baselines b ON b.id = s.baseline_id
      WHERE p.id = ${projectId} AND p.deleted_at IS NULL`;
    const state = rows[0];
    if (!state) return undefined;
    if (!state.baseline_id)
      return {
        format: designReviewStateFormat,
        projectId,
        readiness: 'draft',
        currency: 'none',
        approvalsStale: false,
        changesSinceBaseline: []
      };
    const changes = await this.sql<Row[]>`
      SELECT c.*, before_revision.content_sha256 AS before_revision_fingerprint,
        current_revision.content_sha256 AS current_revision_fingerprint
      FROM design_baseline_changes c
      JOIN revisions before_revision ON before_revision.id = c.before_revision_id
      JOIN revisions current_revision ON current_revision.id = c.current_revision_id
      WHERE c.project_id = ${projectId} AND c.baseline_id = ${state.baseline_id}
      ORDER BY c.occurred_at ASC, c.id ASC`;
    const reviewState: DesignReviewState = {
      format: designReviewStateFormat,
      projectId,
      readiness: String(state.readiness) as DesignReviewState['readiness'],
      baseline: {
        id: String(state.baseline_id),
        projectId,
        revision: {
          id: String(state.baseline_revision_id),
          fingerprint: String(state.baseline_revision_fingerprint)
        },
        intent: String(state.baseline_intent) as 'review' | 'handoff',
        createdBy: String(state.baseline_created_by),
        createdAt: new Date(String(state.baseline_created_at)).toISOString()
      },
      currency: String(state.currency) as DesignReviewState['currency'],
      approvalsStale: Boolean(state.approvals_stale),
      changesSinceBaseline: changes.map(semanticDesignChange)
    };
    validateDesignReviewState(reviewState);
    return reviewState;
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
  /**
   * The only live-Postgres path for generated-design revisions and readiness.
   * It holds the project row lock so baseline lookup, revision insertion,
   * semantic changelog persistence, and idempotency are one transaction.
   */
  async commitDesignRevision(
    input: CommitDesignRevisionInput
  ): Promise<CommitDesignRevisionResult> {
    try {
      return await this.sql.transaction(async (sql) => {
        const scope = input.idempotencyScope ?? `design:${input.actorId}:${input.projectId}`;
        if (input.idempotencyKey !== undefined) {
          await sql`SELECT pg_advisory_xact_lock(hashtext(${scope}), hashtext(${input.idempotencyKey}))`;
          const prior = await sql<Row[]>`
            SELECT response FROM idempotency_keys
            WHERE scope = ${scope} AND key = ${input.idempotencyKey}`;
          if (prior[0])
            return { ...(asJson(prior[0].response) as CommitDesignRevisionResult), replayed: true };
        }
        const projectRows = await sql<Row[]>`
          SELECT id FROM projects WHERE id = ${input.projectId} AND deleted_at IS NULL FOR UPDATE`;
        if (!projectRows[0]) throw new CollaborationError('NOT_FOUND', 'Project not found');
        const nextRevision = input.kind === 'mark-ready' ? undefined : input.revision;
        const readiness = input.kind === 'append-revision' ? undefined : input.readiness;
        const semanticChange = input.kind === 'append-revision' ? input.semanticChange : undefined;
        const expectedParentRevisionId =
          input.kind === 'mark-ready' ? undefined : input.expectedParentRevisionId;
        if (nextRevision && nextRevision.projectId !== input.projectId)
          throw new CollaborationError('INVALID', 'Revision must belong to the project');
        const stateRows = await sql<Row[]>`
          SELECT baseline_id FROM design_review_states WHERE project_id = ${input.projectId} FOR UPDATE`;
        const hadBaseline = stateRows[0]?.baseline_id != null && readiness === undefined;
        if (!hadBaseline && nextRevision && semanticChange)
          throw new CollaborationError(
            'INVALID',
            'Semantic design changes require an active baseline'
          );
        if (hadBaseline && nextRevision && !semanticChange) {
          throw new CollaborationError(
            'INVALID',
            'Design-affecting revisions after a baseline require semantic change metadata'
          );
        }
        if (semanticChange) {
          const change = semanticChange;
          if (change.affected.projectId !== input.projectId)
            throw new CollaborationError('INVALID', 'Semantic change must belong to the project');
          if (!change.id || !change.reason.trim() || change.evidence.length === 0)
            throw new CollaborationError(
              'INVALID',
              'Semantic design change metadata is incomplete'
            );
          if (change.evidence.some((item) => !item.description.trim()))
            throw new CollaborationError(
              'INVALID',
              'Semantic design evidence requires descriptions'
            );
          if (
            (change.provenance.kind === 'actor' && !change.provenance.actorId.trim()) ||
            (change.provenance.kind === 'agent' &&
              (!change.provenance.agentId.trim() || !change.provenance.promptDigest.trim()))
          )
            throw new CollaborationError('INVALID', 'Semantic design provenance is incomplete');
        }
        let previous: Row | undefined;
        if (nextRevision) {
          const current = await sql<Row[]>`
            SELECT id, sequence FROM revisions WHERE project_id = ${input.projectId}
            ORDER BY sequence DESC LIMIT 1 FOR UPDATE`;
          previous = current[0];
          if ((previous ? String(previous.id) : undefined) !== expectedParentRevisionId)
            throw new CollaborationError('CONFLICT', 'Revision parent is no longer current');
          if (nextRevision.sequence !== (previous ? Number(previous.sequence) : 0) + 1)
            throw new CollaborationError(
              'CONFLICT',
              'Revision sequence is not the next immutable revision'
            );
          await sql`
            INSERT INTO revisions
              (id, project_id, sequence, parent_revision_id, content, content_sha256, scenario_ids, created_by, created_at)
            VALUES
              (${nextRevision.id}, ${nextRevision.projectId}, ${nextRevision.sequence},
               ${nextRevision.parentRevisionId ?? null}, ${JSON.stringify(nextRevision.content)}::jsonb,
               ${nextRevision.contentSha256}, ${JSON.stringify(nextRevision.scenarioIds)}::jsonb,
               ${nextRevision.createdBy}, ${nextRevision.createdAt})`;
        }
        if (readiness) {
          const readinessRevisionId = readiness.revisionId;
          const revisionRows =
            nextRevision?.id === readinessRevisionId
              ? [{ id: nextRevision.id, content_sha256: nextRevision.contentSha256 }]
              : await sql<
                  Row[]
                >`SELECT id, content_sha256 FROM revisions WHERE id = ${readinessRevisionId} AND project_id = ${input.projectId} FOR KEY SHARE`;
          if (!revisionRows[0])
            throw new CollaborationError('INVALID', 'Baseline revision must belong to the project');
          if (String(revisionRows[0].content_sha256) !== readiness.revisionFingerprint)
            throw new CollaborationError(
              'INVALID',
              'Baseline fingerprint must match the immutable revision'
            );
          await sql`
            SELECT mark_generated_design_ready(
              ${readiness.id}, ${input.projectId}, ${readinessRevisionId}, ${readiness.intent},
              ${readiness.revisionFingerprint}, ${input.actorId}, ${input.occurredAt})`;
        } else if (hadBaseline && nextRevision && semanticChange && previous) {
          const change = semanticChange;
          await sql`
            SELECT record_generated_design_change(
              ${change.id}, ${input.projectId}, ${change.kind}, ${previous.id}, ${nextRevision.id},
              ${JSON.stringify(change.affected)}::jsonb, ${JSON.stringify(change.evidence)}::jsonb,
              ${JSON.stringify(change.provenance)}::jsonb, ${change.reason}, ${input.occurredAt})`;
        }
        let result: CommitDesignRevisionResult;
        if (nextRevision) {
          result = readiness
            ? {
                kind: 'revision-and-readiness',
                revision: nextRevision,
                readiness,
                replayed: false
              }
            : {
                kind: 'revision',
                revision: nextRevision,
                changeRecorded: hadBaseline,
                replayed: false
              };
        } else {
          if (!readiness)
            throw new CollaborationError('INVALID', 'Readiness transition is required');
          result = { kind: 'readiness', readiness, replayed: false };
        }
        if (input.idempotencyKey !== undefined) {
          await sql`
            INSERT INTO idempotency_keys (scope, key, response)
            VALUES (${scope}, ${input.idempotencyKey}, ${JSON.stringify(result)}::jsonb)`;
        }
        return result;
      });
    } catch (error) {
      const code = driverCode(error);
      if (code === '23505')
        throw new CollaborationError('DUPLICATE', 'A durable record already exists');
      if (code === '23503')
        throw new CollaborationError('NOT_FOUND', 'Referenced collaboration record not found');
      if (code === '23514' || code === '22P02')
        throw new CollaborationError('INVALID', 'Invalid generated-design data');
      throw error;
    }
  }
  async createThread(value: Thread) {
    await this
      .sql`INSERT INTO threads (id, project_id, revision_id, react_node_id, scenario_id, created_by, created_at) VALUES (${value.id}, ${value.projectId}, ${value.revisionId}, ${value.reactNodeId}, ${value.scenarioId}, ${value.createdBy}, ${value.createdAt})`;
  }
  async createReviewThread(value: ReviewThread) {
    const targetRevision = required(
      await this.getRevision(value.anchor.evidence.revisionId),
      'Review thread revision not found'
    );
    if (targetRevision.projectId !== value.projectId)
      throw new CollaborationError(
        'NOT_FOUND',
        'Review thread revision was not found in this project'
      );
    validateSpatialAnchor(value.anchor, targetRevision);
    validateReviewThread(value);
    await this.sql`
      INSERT INTO review_threads
        (id, project_id, hosted_binding, version, revision_id, anchor, messages, deep_link, lifecycle, created_by, created_at,
         resolved_at, resolved_by, reopened_at, reopened_by, moved_at, moved_by)
      VALUES
        (${value.id}, ${value.projectId}, ${value.hostedBinding === undefined ? null : JSON.stringify(value.hostedBinding)}::jsonb,
         ${value.version}, ${value.anchor.evidence.revisionId},
         ${JSON.stringify(value.anchor)}::jsonb, ${JSON.stringify(value.messages)}::jsonb,
         ${value.deepLink}, ${value.lifecycle}, ${value.createdBy}, ${value.createdAt},
         ${value.resolvedAt ?? null}, ${value.resolvedBy ?? null}, ${value.reopenedAt ?? null},
         ${value.reopenedBy ?? null}, ${value.movedAt ?? null}, ${value.movedBy ?? null})`;
  }
  /**
   * The review row and its operation receipt share one transaction and row
   * lock. A replay is checked against the current lifecycle so an old resolve
   * cannot report success after a later reopen.
   */
  async mutateReviewThread(input: ReviewThreadMutation): Promise<ReviewThreadMutationResult> {
    input = normalizeReviewThreadMutation(input);
    const threadId = input.kind === 'create' ? input.thread.id : input.threadId;
    const projectId = input.kind === 'create' ? input.thread.projectId : undefined;
    const fingerprint = canonicalReviewThreadMutationFingerprint(input);
    try {
      return await this.sql.transaction(async (sql) => {
        let current: ReviewThread | undefined;
        let scope: string;
        if (input.kind === 'create') {
          const projects = await sql<Row[]>`
            SELECT organization_id FROM projects WHERE id = ${projectId} AND deleted_at IS NULL FOR KEY SHARE`;
          if (!projects[0]) throw new CollaborationError('NOT_FOUND', 'Review project not found');
          scope = `review:${String(projects[0].organization_id)}:${projectId}:${threadId}`;
        } else {
          const rows = await sql<
            Row[]
          >`SELECT * FROM review_threads WHERE id = ${threadId} FOR UPDATE`;
          if (!rows[0]) return { kind: 'conflict', currentVersion: 0 };
          current = reviewThread(rows[0]);
          const projects = await sql<Row[]>`
            SELECT organization_id FROM projects WHERE id = ${current.projectId} AND deleted_at IS NULL FOR KEY SHARE`;
          if (!projects[0]) throw new CollaborationError('NOT_FOUND', 'Review project not found');
          scope = `review:${String(projects[0].organization_id)}:${current.projectId}:${threadId}`;
        }
        // Create races lock the stable tenant/project/thread scope, never the
        // operation ID, so two distinct creates cannot both observe absence.
        await sql`SELECT pg_advisory_xact_lock(hashtext(${scope}))`;
        const receipt = await sql<Row[]>`
          SELECT response FROM idempotency_keys WHERE scope = ${scope} AND key = ${input.operationId}`;
        if (receipt[0]) {
          const prior = reviewOperationReceipt(asJson(receipt[0].response));
          const replayRow = current
            ? undefined
            : (await sql<Row[]>`SELECT * FROM review_threads WHERE id = ${threadId} FOR UPDATE`)[0];
          const replayThread = current ?? (replayRow ? reviewThread(replayRow) : undefined);
          if (!replayThread) return { kind: 'conflict', currentVersion: 0 };
          if (prior.fingerprint !== fingerprint)
            return { kind: 'conflict', currentVersion: replayThread.version, thread: replayThread };
          const replayed =
            (prior.kind !== 'resolve' || replayThread.lifecycle === 'resolved') &&
            (prior.kind !== 'reopen' || replayThread.lifecycle === 'open') &&
            (prior.kind !== 'reply' ||
              (typeof prior.messageId === 'string' &&
                replayThread.messages.some((message) => message.id === prior.messageId)));
          return replayed
            ? { kind: 'replayed', thread: replayThread, fingerprint: prior.fingerprint }
            : { kind: 'conflict', currentVersion: replayThread.version, thread: replayThread };
        }
        if (input.kind === 'create') {
          if (input.expectedVersion !== 0) return { kind: 'conflict', currentVersion: 0 };
          const createdThread = { ...input.thread, version: 1 };
          const rows = await sql<
            Row[]
          >`SELECT * FROM review_threads WHERE id = ${threadId} FOR UPDATE`;
          if (rows[0]) {
            const existing = reviewThread(rows[0]);
            return existing.projectId === createdThread.projectId
              ? { kind: 'conflict', currentVersion: existing.version, thread: existing }
              : { kind: 'conflict', currentVersion: 0 };
          }
          const revisions = await sql<Row[]>`
            SELECT * FROM revisions
            WHERE id = ${createdThread.anchor.evidence.revisionId}
              AND project_id = ${createdThread.projectId}
            FOR KEY SHARE`;
          if (!revisions[0])
            throw new CollaborationError('NOT_FOUND', 'Review thread revision not found');
          validateSpatialAnchor(createdThread.anchor, revision(revisions[0]));
          validateReviewThread(createdThread);
          const inserted = await sql<Row[]>`
            INSERT INTO review_threads
              (id, project_id, hosted_binding, version, revision_id, anchor, messages, deep_link, lifecycle, created_by, created_at,
               resolved_at, resolved_by, reopened_at, reopened_by, moved_at, moved_by)
            VALUES
              (${createdThread.id}, ${createdThread.projectId},
               ${createdThread.hostedBinding === undefined ? null : JSON.stringify(createdThread.hostedBinding)}::jsonb,
               ${createdThread.version}, ${createdThread.anchor.evidence.revisionId},
               ${JSON.stringify(createdThread.anchor)}::jsonb, ${JSON.stringify(createdThread.messages)}::jsonb,
               ${createdThread.deepLink}, ${createdThread.lifecycle}, ${createdThread.createdBy}, ${createdThread.createdAt},
               ${createdThread.resolvedAt ?? null}, ${createdThread.resolvedBy ?? null}, ${createdThread.reopenedAt ?? null},
               ${createdThread.reopenedBy ?? null}, ${createdThread.movedAt ?? null}, ${createdThread.movedBy ?? null})
            ON CONFLICT (id) DO NOTHING
            RETURNING *`;
          if (!inserted[0]) {
            const latest = await sql<Row[]>`SELECT * FROM review_threads WHERE id = ${threadId}`;
            const authoritative = latest[0] ? reviewThread(latest[0]) : undefined;
            return authoritative?.projectId === createdThread.projectId
              ? {
                  kind: 'conflict',
                  currentVersion: authoritative.version,
                  thread: authoritative
                }
              : { kind: 'conflict', currentVersion: 0 };
          }
          await sql`
            INSERT INTO idempotency_keys (scope, key, response)
            VALUES (${scope}, ${input.operationId}, ${JSON.stringify({ kind: input.kind, fingerprint })}::jsonb)`;
          await sql`
            DELETE FROM idempotency_keys WHERE ctid IN (
              SELECT ctid FROM idempotency_keys WHERE scope = ${scope}
              ORDER BY created_at DESC, key DESC OFFSET 100
            )`;
          return { kind: 'applied', thread: reviewThread(inserted[0]), fingerprint };
        }
        if (!current) return { kind: 'conflict', currentVersion: 0 };
        if (current.version !== input.expectedVersion)
          return { kind: 'conflict', currentVersion: current.version, thread: current };
        let nextThread: ReviewThread;
        if (input.kind === 'reply') {
          nextThread = {
            ...current,
            version: current.version + 1,
            messages: [...current.messages, input.message]
          };
        } else if (input.kind === 'resolve') {
          if (current.lifecycle !== 'open')
            return { kind: 'conflict', currentVersion: current.version, thread: current };
          nextThread = {
            ...current,
            version: current.version + 1,
            lifecycle: 'resolved',
            resolvedBy: input.actorId,
            resolvedAt: input.occurredAt
          };
        } else {
          if (current.lifecycle !== 'resolved')
            return { kind: 'conflict', currentVersion: current.version, thread: current };
          const { resolvedAt: _resolvedAt, resolvedBy: _resolvedBy, ...open } = current;
          nextThread = {
            ...open,
            version: current.version + 1,
            lifecycle: 'open',
            reopenedBy: input.actorId,
            reopenedAt: input.occurredAt
          };
        }
        validateReviewThread(nextThread);
        const rows = await sql<Row[]>`
          UPDATE review_threads
          SET version = ${nextThread.version}, messages = ${JSON.stringify(nextThread.messages)}::jsonb,
            lifecycle = ${nextThread.lifecycle}, resolved_by = ${nextThread.resolvedBy ?? null},
            resolved_at = ${nextThread.resolvedAt ?? null}, reopened_by = ${nextThread.reopenedBy ?? null},
            reopened_at = ${nextThread.reopenedAt ?? null}
          WHERE id = ${nextThread.id} AND version = ${current.version}
          RETURNING *`;
        if (!rows[0]) {
          const latest = await sql<Row[]>`SELECT * FROM review_threads WHERE id = ${threadId}`;
          return latest[0]
            ? {
                kind: 'conflict',
                currentVersion: reviewThread(latest[0]).version,
                thread: reviewThread(latest[0])
              }
            : { kind: 'conflict', currentVersion: 0 };
        }
        const stored = reviewThread(rows[0]);
        await sql`
          INSERT INTO idempotency_keys (scope, key, response)
          VALUES (
            ${scope}, ${input.operationId},
            ${JSON.stringify({ kind: input.kind, fingerprint, ...(input.kind === 'reply' ? { messageId: input.message.id } : {}) })}::jsonb
          )`;
        await sql`
          DELETE FROM idempotency_keys WHERE ctid IN (
            SELECT ctid FROM idempotency_keys WHERE scope = ${scope}
            ORDER BY created_at DESC, key DESC OFFSET 100
          )`;
        return { kind: 'applied', thread: stored, fingerprint };
      });
    } catch (error) {
      const code = driverCode(error);
      if (code === '23505')
        throw new CollaborationError('CONFLICT', 'Review operation changed concurrently');
      throw error;
    }
  }
  async getReviewThread(id: string) {
    const rows = await this.sql<Row[]>`SELECT * FROM review_threads WHERE id = ${id}`;
    return rows[0] ? reviewThread(rows[0]) : undefined;
  }
  async listReviewThreads(projectId: string, filter?: ReviewThreadFilter) {
    const unreadFor = filter?.unreadFor;
    const threads = (
      await this.sql<Row[]>`
        SELECT * FROM review_threads WHERE project_id = ${projectId} ORDER BY created_at`
    ).map(reviewThread);
    return threads.filter(
      (review) =>
        (filter?.lifecycle === undefined || review.lifecycle === filter.lifecycle) &&
        (filter?.revisionId === undefined ||
          review.anchor.evidence.revisionId === filter.revisionId) &&
        (filter?.deepLink === undefined || review.deepLink === filter.deepLink) &&
        (filter?.screenId === undefined || review.anchor.evidence.screenId === filter.screenId) &&
        (filter?.stateId === undefined || review.anchor.evidence.stateId === filter.stateId) &&
        (filter?.createdBy === undefined || review.createdBy === filter.createdBy) &&
        (unreadFor === undefined ||
          review.messages.some((message) => !message.readBy.includes(unreadFor)))
    );
  }
  private async replaceReviewThreadMessages(
    current: ReviewThread,
    updated: ReviewThread
  ): Promise<ReviewThread> {
    const rows = await this.sql<Row[]>`
      UPDATE review_threads SET version = ${current.version + 1}, messages = ${JSON.stringify(updated.messages)}::jsonb
      WHERE id = ${current.id} AND version = ${current.version}
      RETURNING *`;
    if (rows[0]) return reviewThread(rows[0]);
    if (!(await this.getReviewThread(current.id)))
      throw new CollaborationError('NOT_FOUND', 'Review thread not found');
    throw new CollaborationError('CONFLICT', 'Review thread messages changed concurrently');
  }
  async appendReviewThreadMessage(id: string, message: ReviewThreadMessage) {
    const currentReview = required(await this.getReviewThread(id), 'Review thread not found');
    const updated = {
      ...currentReview,
      version: currentReview.version + 1,
      messages: [...currentReview.messages, message]
    };
    validateReviewThread(updated);
    return this.replaceReviewThreadMessages(currentReview, updated);
  }
  async reactToReviewThreadMessage(id: string, messageId: string, emoji: string, userId: string) {
    const currentReview = required(await this.getReviewThread(id), 'Review thread not found');
    let found = false;
    const updated = {
      ...currentReview,
      version: currentReview.version + 1,
      messages: currentReview.messages.map((message) => {
        if (message.id !== messageId) return message;
        found = true;
        const reaction = message.reactions.find((item) => item.emoji === emoji);
        return {
          ...message,
          reactions: reaction
            ? message.reactions.map((item) =>
                item.emoji === emoji
                  ? { ...item, userIds: [...new Set([...item.userIds, userId])] }
                  : item
              )
            : [...message.reactions, { emoji, userIds: [userId] }]
        };
      })
    };
    if (!found) throw new CollaborationError('NOT_FOUND', 'Review message not found');
    validateReviewThread(updated);
    return this.replaceReviewThreadMessages(currentReview, updated);
  }
  async setReviewThreadMessageRead(id: string, messageId: string, userId: string, read: boolean) {
    const currentReview = required(await this.getReviewThread(id), 'Review thread not found');
    let found = false;
    const updated = {
      ...currentReview,
      version: currentReview.version + 1,
      messages: currentReview.messages.map((message) => {
        if (message.id !== messageId) return message;
        found = true;
        return {
          ...message,
          readBy: read
            ? [...new Set([...message.readBy, userId])]
            : message.readBy.filter((item) => item !== userId)
        };
      })
    };
    if (!found) throw new CollaborationError('NOT_FOUND', 'Review message not found');
    validateReviewThread(updated);
    return this.replaceReviewThreadMessages(currentReview, updated);
  }
  async resolveReviewThread(id: string, resolvedBy: string, resolvedAt = new Date().toISOString()) {
    const existing = required(await this.getReviewThread(id), 'Review thread not found');
    if (existing.lifecycle === 'resolved')
      throw new CollaborationError('CONFLICT', 'Review thread is already resolved');
    const updated = {
      ...existing,
      version: existing.version + 1,
      lifecycle: 'resolved' as const,
      resolvedBy,
      resolvedAt
    };
    validateReviewThread(updated);
    const rows = await this.sql<Row[]>`
      UPDATE review_threads
      SET version = ${existing.version + 1}, lifecycle = 'resolved', resolved_by = ${resolvedBy}, resolved_at = ${resolvedAt}
      WHERE id = ${id} AND project_id = ${existing.projectId} AND lifecycle = 'open' AND version = ${existing.version}
      RETURNING *`;
    if (!rows[0]) {
      if (!(await this.getReviewThread(id)))
        throw new CollaborationError('NOT_FOUND', 'Review thread not found');
      throw new CollaborationError('CONFLICT', 'Review thread changed concurrently');
    }
    return reviewThread(rows[0]);
  }
  async reopenReviewThread(id: string, reopenedBy: string, reopenedAt = new Date().toISOString()) {
    const existing = required(await this.getReviewThread(id), 'Review thread not found');
    if (existing.lifecycle !== 'resolved')
      throw new CollaborationError('CONFLICT', 'Review thread is already open');
    if (existing.resolvedAt === undefined)
      throw new CollaborationError('INVALID', 'Resolved review thread is missing its timestamp');
    if (Date.parse(reopenedAt) <= Date.parse(existing.resolvedAt))
      throw new CollaborationError(
        'INVALID',
        'Review thread reopening must be later than its resolution'
      );
    const { resolvedAt: _resolvedAt, resolvedBy: _resolvedBy, ...open } = existing;
    const updated = {
      ...open,
      version: existing.version + 1,
      lifecycle: 'open' as const,
      reopenedBy,
      reopenedAt
    };
    validateReviewThread(updated);
    const rows = await this.sql<Row[]>`
      UPDATE review_threads SET version = ${existing.version + 1}, lifecycle = 'open', resolved_by = NULL, resolved_at = NULL,
        reopened_by = ${reopenedBy}, reopened_at = ${reopenedAt}
      WHERE id = ${id} AND project_id = ${existing.projectId} AND lifecycle = 'resolved' AND version = ${existing.version}
      RETURNING *`;
    if (!rows[0]) {
      if (!(await this.getReviewThread(id)))
        throw new CollaborationError('NOT_FOUND', 'Review thread not found');
      throw new CollaborationError('CONFLICT', 'Review thread changed concurrently');
    }
    return reviewThread(rows[0]);
  }
  async moveReviewThread(
    id: string,
    anchor: SpatialAnchor,
    movedBy: string,
    movedAt = new Date().toISOString()
  ) {
    const existing = required(await this.getReviewThread(id), 'Review thread not found');
    const targetRevision = required(
      await this.getRevision(anchor.evidence.revisionId),
      'Review thread revision not found'
    );
    if (targetRevision.projectId !== existing.projectId)
      throw new CollaborationError(
        'NOT_FOUND',
        'Review thread revision was not found in this project'
      );
    validateSpatialAnchor(anchor, targetRevision);
    // Concurrent moves use the server-owned version: one wins and stale movers conflict.
    const rows = await this.sql<Row[]>`
      UPDATE review_threads SET version = ${existing.version + 1}, revision_id = ${anchor.evidence.revisionId},
        anchor = ${JSON.stringify(anchor)}::jsonb, moved_by = ${movedBy}, moved_at = ${movedAt}
      WHERE id = ${id} AND version = ${existing.version}
      RETURNING *`;
    if (rows[0]) return reviewThread(rows[0]);
    if (!(await this.getReviewThread(id)))
      throw new CollaborationError('NOT_FOUND', 'Review thread not found');
    throw new CollaborationError('CONFLICT', 'Review thread anchor changed concurrently');
  }
  private async validateAIChangeRequestResultReferences(value: AIChangeRequest): Promise<void> {
    const revisionIds = [value.result?.revisionId, value.undoResult?.revisionId].filter(
      (id): id is string => id !== undefined
    );
    if (revisionIds.length === 0) return;
    const revisions = await Promise.all(revisionIds.map((id) => this.getRevision(id)));
    validateAIChangeRequestResultReferences(
      value,
      revisions.filter((candidate): candidate is Revision => candidate !== undefined)
    );
  }
  async createAIChangeRequest(value: AIChangeRequest) {
    const targetRevision = required(
      await this.getRevision(value.baseRevision.id),
      'AI change request revision not found'
    );
    if (targetRevision.projectId !== value.projectId)
      throw new CollaborationError(
        'NOT_FOUND',
        'AI change request revision was not found in this project'
      );
    validateAIChangeRequest(value, targetRevision);
    await this.validateAIChangeRequestResultReferences(value);
    await this.sql`
      INSERT INTO ai_change_requests
        (id, project_id, base_revision_id, request, lifecycle, created_by, created_at, updated_at)
      VALUES
        (${value.id}, ${value.projectId}, ${value.baseRevision.id}, ${JSON.stringify(value)}::jsonb,
         ${value.lifecycle}, ${value.createdBy}, ${value.createdAt}, ${value.updatedAt})`;
  }
  async getAIChangeRequest(id: string) {
    const rows = await this.sql<Row[]>`SELECT request FROM ai_change_requests WHERE id = ${id}`;
    return rows[0] ? (asJson(rows[0].request) as AIChangeRequest) : undefined;
  }
  async listAIChangeRequests(projectId: string) {
    return (
      await this.sql<Row[]>`
        SELECT request FROM ai_change_requests WHERE project_id = ${projectId} ORDER BY created_at`
    ).map((row) => asJson(row.request) as AIChangeRequest);
  }
  async updateAIChangeRequest(value: AIChangeRequest) {
    const previous = required(
      await this.getAIChangeRequest(value.id),
      'AI change request not found'
    );
    const targetRevision = required(
      await this.getRevision(value.baseRevision.id),
      'AI change request revision not found'
    );
    if (targetRevision.projectId !== value.projectId)
      throw new CollaborationError(
        'NOT_FOUND',
        'AI change request revision was not found in this project'
      );
    validateAIChangeRequest(value, targetRevision);
    await this.validateAIChangeRequestResultReferences(value);
    validateAIChangeRequestTransition(previous, value);
    const rows = await this.sql<Row[]>`
      UPDATE ai_change_requests SET request = ${JSON.stringify(value)}::jsonb,
        lifecycle = ${value.lifecycle}, updated_at = ${value.updatedAt}
      WHERE id = ${value.id} AND updated_at = ${previous.updatedAt}
        AND lifecycle = ${previous.lifecycle}
        AND request = ${JSON.stringify(previous)}::jsonb
      RETURNING request`;
    if (rows[0]) return asJson(rows[0].request) as AIChangeRequest;
    if (!(await this.getAIChangeRequest(value.id)))
      throw new CollaborationError('NOT_FOUND', 'AI change request not found');
    throw new CollaborationError('CONFLICT', 'AI change request changed concurrently');
  }
  async createDeveloperAnnotation(value: DeveloperAnnotation) {
    const targetRevision = required(
      await this.getRevision(value.anchor.evidence.revisionId),
      'Developer annotation revision not found'
    );
    if (targetRevision.projectId !== value.projectId)
      throw new CollaborationError(
        'NOT_FOUND',
        'Developer annotation revision was not found in this project'
      );
    validateDeveloperAnnotation(value, targetRevision);
    await this.sql`
      INSERT INTO developer_annotations (id, project_id, revision_id, annotation, created_by, created_at)
      VALUES (${value.id}, ${value.projectId}, ${value.anchor.evidence.revisionId},
        ${JSON.stringify(value)}::jsonb, ${value.createdBy}, ${value.createdAt})`;
  }
  async listDeveloperAnnotations(projectId: string) {
    return (
      await this.sql<Row[]>`
        SELECT annotation FROM developer_annotations WHERE project_id = ${projectId} ORDER BY created_at`
    ).map((row) => asJson(row.annotation) as DeveloperAnnotation);
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
      await Promise.all(
        value.mentionedUserIds.map(
          (userId) =>
            sql`INSERT INTO comment_mentions (comment_id, user_id) VALUES (${value.id}, ${userId})`
        )
      );
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
    const reviewThreads = (
      await this.sql<
        Row[]
      >`SELECT * FROM review_threads WHERE project_id = ${projectId} ORDER BY created_at`
    ).map(reviewThread);
    const aiChangeRequests = (
      await this.sql<
        Row[]
      >`SELECT request FROM ai_change_requests WHERE project_id = ${projectId} ORDER BY updated_at`
    ).map((row) => asJson(row.request) as AIChangeRequest);
    const developerAnnotations = (
      await this.sql<
        Row[]
      >`SELECT annotation FROM developer_annotations WHERE project_id = ${projectId} ORDER BY created_at`
    ).map((row) => asJson(row.annotation) as DeveloperAnnotation);
    const designReviewState = await this.getDesignReviewState(projectId);
    return {
      format: collaborationFormat,
      project: current,
      revisions,
      threads,
      comments,
      reactions,
      approvals,
      reviewThreads,
      aiChangeRequests,
      developerAnnotations,
      ...(designReviewState ? { designReviewState } : {})
    };
  }
  async replaceProject(
    snapshot: CollaborationSnapshot,
    options?: { readonly expectedLatestRevisionId?: string }
  ) {
    validateCollaborationSnapshot(snapshot);
    await this.sql.transaction(async (sql) => {
      // Lock the materialized projection before deleting it. Every following
      // statement is in this transaction, so an ID/capacity failure rolls the
      // complete replacement back rather than leaving an additive half-import.
      await sql`SELECT id FROM projects WHERE id = ${snapshot.project.id} FOR UPDATE`;
      if (options?.expectedLatestRevisionId !== undefined) {
        const latest = await sql<Row[]>`
          SELECT id FROM revisions WHERE project_id = ${snapshot.project.id}
          ORDER BY sequence DESC LIMIT 1 FOR UPDATE`;
        if (String(latest[0]?.id ?? '') !== options.expectedLatestRevisionId)
          throw new CollaborationError('CONFLICT', 'Project revision is no longer current');
      }
      await sql`INSERT INTO projects (id, organization_id, name) VALUES (${snapshot.project.id}, ${snapshot.project.organizationId}, ${snapshot.project.name}) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, deleted_at = NULL`;
      await sql`DELETE FROM developer_annotations WHERE project_id = ${snapshot.project.id}`;
      await sql`DELETE FROM ai_change_requests WHERE project_id = ${snapshot.project.id}`;
      await sql`DELETE FROM review_threads WHERE project_id = ${snapshot.project.id}`;
      await sql`DELETE FROM design_baseline_changes WHERE project_id = ${snapshot.project.id}`;
      await sql`DELETE FROM design_review_states WHERE project_id = ${snapshot.project.id}`;
      await sql`DELETE FROM design_baselines WHERE project_id = ${snapshot.project.id}`;
      await sql`DELETE FROM approvals WHERE revision_id IN (SELECT id FROM revisions WHERE project_id = ${snapshot.project.id})`;
      await sql`DELETE FROM comment_reactions WHERE comment_id IN (SELECT c.id FROM comments c JOIN threads t ON t.id = c.thread_id WHERE t.project_id = ${snapshot.project.id})`;
      await sql`DELETE FROM comment_mentions WHERE comment_id IN (SELECT c.id FROM comments c JOIN threads t ON t.id = c.thread_id WHERE t.project_id = ${snapshot.project.id})`;
      await sql`DELETE FROM comments WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ${snapshot.project.id})`;
      await sql`DELETE FROM threads WHERE project_id = ${snapshot.project.id}`;
      await sql`DELETE FROM revisions WHERE project_id = ${snapshot.project.id}`;
      for (const value of snapshot.revisions) {
        // Revisions may reference earlier parent revisions in this ordered snapshot.
        // eslint-disable-next-line no-await-in-loop
        await sql`INSERT INTO revisions (id, project_id, sequence, parent_revision_id, content, content_sha256, scenario_ids, created_by, created_at) VALUES (${value.id}, ${value.projectId}, ${value.sequence}, ${value.parentRevisionId ?? null}, ${JSON.stringify(value.content)}::jsonb, ${value.contentSha256}, ${JSON.stringify(value.scenarioIds)}::jsonb, ${value.createdBy}, ${value.createdAt})`;
      }
      for (const value of snapshot.threads) {
        // Threads depend on the revisions inserted by the prior phase.
        // eslint-disable-next-line no-await-in-loop
        await sql`INSERT INTO threads (id, project_id, revision_id, react_node_id, scenario_id, created_by, created_at, resolved_at, resolved_by) VALUES (${value.id}, ${value.projectId}, ${value.revisionId}, ${value.reactNodeId}, ${value.scenarioId}, ${value.createdBy}, ${value.createdAt}, ${value.resolvedAt ?? null}, ${value.resolvedBy ?? null})`;
      }
      for (const value of snapshot.comments) {
        // Comments can reference earlier parent comments and are therefore ordered.
        // eslint-disable-next-line no-await-in-loop
        await sql`INSERT INTO comments (id, thread_id, parent_comment_id, body, created_by, created_at) VALUES (${value.id}, ${value.threadId}, ${value.parentCommentId ?? null}, ${value.body}, ${value.createdBy}, ${value.createdAt})`;
        for (const userId of value.mentionedUserIds) {
          // Mentions depend on their comment and preserve deterministic import order.
          // eslint-disable-next-line no-await-in-loop
          await sql`INSERT INTO comment_mentions (comment_id, user_id) VALUES (${value.id}, ${userId})`;
        }
      }
      for (const value of snapshot.reactions) {
        // Reactions depend on comments inserted by the prior phase.
        // eslint-disable-next-line no-await-in-loop
        await sql`INSERT INTO comment_reactions (comment_id, user_id, emoji, created_at) VALUES (${value.commentId}, ${value.userId}, ${value.emoji}, ${value.createdAt})`;
      }
      for (const value of snapshot.approvals) {
        // Approvals depend on revisions inserted by the first phase.
        // eslint-disable-next-line no-await-in-loop
        await sql`INSERT INTO approvals (id, revision_id, user_id, decision, note, created_at) VALUES (${value.id}, ${value.revisionId}, ${value.userId}, ${value.decision}, ${value.note ?? null}, ${value.createdAt})`;
      }
      for (const value of snapshot.reviewThreads) {
        // Review threads depend on revisions inserted in the first phase.
        // eslint-disable-next-line no-await-in-loop
        await sql`
          INSERT INTO review_threads
            (id, project_id, hosted_binding, version, revision_id, anchor, messages, deep_link, lifecycle, created_by, created_at,
             resolved_at, resolved_by, reopened_at, reopened_by, moved_at, moved_by)
          VALUES
            (${value.id}, ${value.projectId}, ${value.hostedBinding === undefined ? null : JSON.stringify(value.hostedBinding)}::jsonb,
             ${value.version}, ${value.anchor.evidence.revisionId},
             ${JSON.stringify(value.anchor)}::jsonb, ${JSON.stringify(value.messages)}::jsonb,
             ${value.deepLink}, ${value.lifecycle}, ${value.createdBy}, ${value.createdAt},
             ${value.resolvedAt ?? null}, ${value.resolvedBy ?? null}, ${value.reopenedAt ?? null},
             ${value.reopenedBy ?? null}, ${value.movedAt ?? null}, ${value.movedBy ?? null})`;
      }
      for (const value of snapshot.aiChangeRequests) {
        // AI requests reference the immutable base revision.
        // eslint-disable-next-line no-await-in-loop
        await sql`
          INSERT INTO ai_change_requests
            (id, project_id, base_revision_id, request, lifecycle, created_by, created_at, updated_at)
          VALUES
            (${value.id}, ${value.projectId}, ${value.baseRevision.id}, ${JSON.stringify(value)}::jsonb,
             ${value.lifecycle}, ${value.createdBy}, ${value.createdAt}, ${value.updatedAt})`;
      }
      for (const value of snapshot.developerAnnotations) {
        // Annotations reference the immutable reviewed revision.
        // eslint-disable-next-line no-await-in-loop
        await sql`
          INSERT INTO developer_annotations (id, project_id, revision_id, annotation, created_by, created_at)
          VALUES (${value.id}, ${value.projectId}, ${value.anchor.evidence.revisionId},
            ${JSON.stringify(value)}::jsonb, ${value.createdBy}, ${value.createdAt})`;
      }
      if (snapshot.designReviewState) {
        const state = snapshot.designReviewState;
        if (state.projectId !== snapshot.project.id)
          throw new CollaborationError(
            'INVALID',
            'Design review state must belong to the snapshot project'
          );
        if (state.baseline) {
          await sql`
            INSERT INTO design_baselines
              (id, project_id, revision_id, intent, revision_fingerprint, created_by, created_at)
            VALUES
              (${state.baseline.id}, ${state.projectId}, ${state.baseline.revision.id},
               ${state.baseline.intent}, ${state.baseline.revision.fingerprint},
               ${state.baseline.createdBy}, ${state.baseline.createdAt})`;
        }
        await sql`
          INSERT INTO design_review_states
            (project_id, readiness, baseline_id, currency, approvals_stale, updated_at)
          VALUES
            (${state.projectId}, ${state.readiness}, ${state.baseline?.id ?? null},
             ${state.currency}, ${state.approvalsStale}, now())`;
        // Changelog entries are imported in their exported semantic order.
        for (const change of state.changesSinceBaseline) {
          // eslint-disable-next-line no-await-in-loop
          await sql`
            INSERT INTO design_baseline_changes
              (id, project_id, baseline_id, kind, before_revision_id, current_revision_id,
               affected, evidence, provenance, reason, occurred_at)
            VALUES
              (${change.id}, ${state.projectId}, ${state.baseline?.id ?? null}, ${change.kind},
               ${change.beforeRevision.id}, ${change.currentRevision.id},
               ${JSON.stringify(change.affected)}::jsonb, ${JSON.stringify(change.evidence)}::jsonb,
               ${JSON.stringify(change.provenance)}::jsonb, ${change.reason}, ${change.occurredAt})`;
        }
      }
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
  async putIdempotency<T>(scope: string, key: string, response: T): Promise<T> {
    // The insert and read are one durable unit. Concurrent callers wait on
    // the unique key then return the response that won the first write.
    return this.sql.transaction(async (sql) => {
      const inserted = await sql<Row[]>`
        INSERT INTO idempotency_keys (scope, key, response)
        VALUES (${scope}, ${key}, ${JSON.stringify(response)}::jsonb)
        ON CONFLICT (scope, key) DO NOTHING
        RETURNING response`;
      const stored =
        inserted[0] ??
        (
          await sql<Row[]>`
            SELECT response FROM idempotency_keys
            WHERE scope = ${scope} AND key = ${key}`
        )[0];
      if (!stored) throw new CollaborationError('CONFLICT', 'Could not store idempotent response');
      return asJson(stored.response) as T;
    });
  }
}
