/**
 * Collaboration domain contracts.  This module is intentionally runtime-free:
 * applications choose storage, clocks, authentication, and transport adapters.
 */
export const collaborationFormat = 'selene-collaboration/v1' as const;

export type MembershipRole = 'owner' | 'admin' | 'editor' | 'commenter' | 'viewer' | 'guest';
export type SharePermission = 'viewer' | 'commenter';
export type ApprovalDecision = 'approved' | 'changes_requested';
export type CollaborationAction =
  | 'organization:create-project'
  | 'project:read'
  | 'project:design'
  | 'project:comment'
  | 'project:approve'
  | 'project:manage-sharing'
  | 'project:restore'
  | 'project:merge'
  | 'project:delete';

/** One authorization vocabulary for HTTP routes and revision-history policy. */
export const allowedRolesByAction: Readonly<
  Record<CollaborationAction, readonly MembershipRole[]>
> = {
  'organization:create-project': ['owner', 'admin', 'editor'],
  'project:read': ['owner', 'admin', 'editor', 'commenter', 'viewer', 'guest'],
  'project:design': ['owner', 'admin', 'editor'],
  'project:comment': ['owner', 'admin', 'editor', 'commenter'],
  'project:approve': ['owner', 'admin', 'editor'],
  'project:manage-sharing': ['owner', 'admin', 'editor'],
  'project:restore': ['owner', 'admin'],
  'project:merge': ['owner', 'admin'],
  'project:delete': ['owner', 'admin']
};

export function roleAllows(role: MembershipRole, action: CollaborationAction): boolean {
  return allowedRolesByAction[action].includes(role);
}

export interface Organization {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/** `externalSubject` is reserved for an OIDC/SAML provider subject. */
export interface User {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly displayName: string;
  readonly externalSubject?: string;
}

export interface Membership {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: MembershipRole;
}

export interface Project {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
}

export interface Revision {
  readonly id: string;
  readonly projectId: string;
  readonly sequence: number;
  readonly parentRevisionId?: string;
  /** Immutable, portable workspace JSON; an adapter may store it as JSONB. */
  readonly content: unknown;
  readonly contentSha256: string;
  /** Scenario IDs are intentionally separate from stable React node IDs. */
  readonly scenarioIds: readonly string[];
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface ThreadAnchor {
  readonly revisionId: string;
  readonly reactNodeId: string;
  readonly scenarioId: string;
}

export interface Thread extends ThreadAnchor {
  readonly id: string;
  readonly projectId: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
}

export interface Comment {
  readonly id: string;
  readonly threadId: string;
  readonly parentCommentId?: string;
  readonly body: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly mentionedUserIds: readonly string[];
}

export interface Reaction {
  readonly commentId: string;
  readonly userId: string;
  readonly emoji: string;
  readonly createdAt: string;
}

export interface Approval {
  readonly id: string;
  readonly revisionId: string;
  readonly userId: string;
  readonly decision: ApprovalDecision;
  readonly note?: string;
  readonly createdAt: string;
}

export interface AuditEvent {
  readonly id: string;
  readonly organizationId: string;
  readonly actorId?: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

export interface SignedShareLink {
  readonly id: string;
  readonly projectId: string;
  /** Store only this hash in production; never persist `token`. */
  readonly tokenHash: string;
  readonly permission: SharePermission;
  readonly expiresAt: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export type DesignBaselineIntent = 'review' | 'handoff';
export type SemanticDesignChangeKind =
  'source' | 'design-system' | 'token' | 'template' | 'dependency' | 'visual';

/** Mirrors the generated-design handoff model without coupling this package to core. */
export interface DesignChangeScope {
  readonly projectId: string;
  readonly screenIds: readonly string[];
  readonly routePaths: readonly string[];
  readonly scenarioIds: readonly string[];
  readonly componentIds: readonly string[];
  readonly stableNodeIds: readonly string[];
}

export interface VisualEvidence {
  readonly description: string;
  readonly href?: string;
  readonly checksum?: string;
}

export type DesignChangeProvenance =
  | { readonly kind: 'actor'; readonly actorId: string }
  | { readonly kind: 'agent'; readonly agentId: string; readonly promptDigest: string };

/** Required design-mutation evidence, recorded with the new revision after a baseline. */
export interface SemanticDesignChangeInput {
  readonly id: string;
  readonly kind: SemanticDesignChangeKind;
  readonly affected: DesignChangeScope;
  readonly evidence: readonly VisualEvidence[];
  readonly provenance: DesignChangeProvenance;
  readonly reason: string;
}

export interface DesignReadinessInput {
  readonly id: string;
  readonly revisionId: string;
  readonly intent: DesignBaselineIntent;
  readonly revisionFingerprint: string;
}

export type DesignReadiness = 'draft' | 'ready-for-review' | 'ready-for-handoff';
export type DesignBaselineCurrency = 'current' | 'stale' | 'none';

export interface DesignRevisionReference {
  readonly id: string;
  readonly fingerprint: string;
}

export interface DesignBaseline {
  readonly id: string;
  readonly revision: DesignRevisionReference;
  readonly intent: DesignBaselineIntent;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface SemanticDesignChange extends SemanticDesignChangeInput {
  readonly beforeRevision: DesignRevisionReference;
  readonly currentRevision: DesignRevisionReference;
  readonly occurredAt: string;
}

/** Durable generated-design review projection; collaboration activity never mutates it. */
export interface DesignReviewState {
  readonly projectId: string;
  readonly readiness: DesignReadiness;
  readonly baseline?: DesignBaseline;
  readonly currency: DesignBaselineCurrency;
  readonly approvalsStale: boolean;
  readonly changesSinceBaseline: readonly SemanticDesignChange[];
}

/** One repository command for immutable revisions and baseline transitions. */
export interface CommitDesignRevisionInput {
  readonly projectId: string;
  readonly actorId: string;
  readonly occurredAt: string;
  readonly revision?: Revision;
  readonly expectedParentRevisionId?: string;
  readonly readiness?: DesignReadinessInput;
  readonly semanticChange?: SemanticDesignChangeInput;
  readonly idempotencyKey?: string;
  readonly idempotencyScope?: string;
}

export type CommitDesignRevisionResult = (
  | { readonly kind: 'revision'; readonly revision: Revision; readonly changeRecorded: boolean }
  | { readonly kind: 'readiness'; readonly readiness: DesignReadinessInput }
  | {
      readonly kind: 'revision-and-readiness';
      readonly revision: Revision;
      readonly readiness: DesignReadinessInput;
    }
) & { readonly replayed: boolean };

/**
 * An append-only change record. Its cursor is an opaque, monotonically
 * increasing repository value used for reconnect and catch-up.
 */
export interface CollaborationEvent {
  readonly id: string;
  readonly projectId: string;
  readonly cursor: number;
  readonly type: string;
  readonly actorId?: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

/** Cryptography is injected so the domain stays portable to browser, Electron, and server hosts. */
export interface ShareTokenSigner {
  sign(payload: string): Promise<string>;
  verify(payload: string, signature: string): Promise<boolean>;
  /** One-way digest for durable revocation without persisting the bearer token. */
  hash(token: string): Promise<string>;
}

export interface ShareLinkGrant {
  readonly linkId: string;
  readonly projectId: string;
  readonly permission: SharePermission;
  readonly expiresAt: string;
}

export async function createSignedShareToken(
  grant: ShareLinkGrant,
  signer: ShareTokenSigner
): Promise<string> {
  if (Number.isNaN(Date.parse(grant.expiresAt))) {
    throw new CollaborationError('INVALID', 'Share link expiry must be an ISO timestamp');
  }
  const payload = JSON.stringify(grant);
  const signature = await signer.sign(payload);
  // `~` is outside the base64url alphabet, so the two opaque parts remain
  // unambiguous when passed through headers and URLs.
  return `${encodeBase64Url(payload)}~${signature}`;
}

export async function verifySignedShareToken(
  token: string,
  signer: ShareTokenSigner,
  now = new Date().toISOString()
): Promise<ShareLinkGrant> {
  const [encodedPayload, signature, extra] = token.split('~');
  if (!encodedPayload || !signature || extra)
    throw new CollaborationError('FORBIDDEN', 'Malformed share link');
  const payload = decodeBase64Url(encodedPayload);
  if (!(await signer.verify(payload, signature)))
    throw new CollaborationError('FORBIDDEN', 'Invalid share link signature');
  try {
    const grant = JSON.parse(payload) as ShareLinkGrant;
    if (
      !grant.linkId ||
      !grant.projectId ||
      (grant.permission !== 'viewer' && grant.permission !== 'commenter')
    ) {
      throw new Error('invalid grant');
    }
    if (Date.parse(grant.expiresAt) <= Date.parse(now)) {
      throw new CollaborationError('EXPIRED', 'Share link has expired');
    }
    return grant;
  } catch (error) {
    if (error instanceof CollaborationError) throw error;
    throw new CollaborationError('FORBIDDEN', 'Malformed share link payload');
  }
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): string {
  const padded =
    value.replaceAll('-', '+').replaceAll('_', '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

export interface CollaborationSnapshot {
  readonly format: typeof collaborationFormat;
  readonly project: Project;
  readonly revisions: readonly Revision[];
  readonly threads: readonly Thread[];
  readonly comments: readonly Comment[];
  readonly reactions: readonly Reaction[];
  readonly approvals: readonly Approval[];
  /** Optional for backwards-compatible imports of v1 snapshots created before baseline persistence. */
  readonly designReviewState?: DesignReviewState;
}

export class CollaborationError extends Error {
  public constructor(
    readonly code: 'CONFLICT' | 'DUPLICATE' | 'INVALID' | 'NOT_FOUND' | 'FORBIDDEN' | 'EXPIRED',
    message: string
  ) {
    super(message);
  }
}

function requireText(value: string, field: string, max = 4000): void {
  if (!value.trim() || value.length > max) {
    throw new CollaborationError('INVALID', `${field} must contain 1-${max} characters`);
  }
}

function requireIdentifier(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new CollaborationError('INVALID', `${field} is not a stable identifier`);
  }
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/** Validates anchor and content invariants before persistence or synchronization. */
export function validateThreadAnchor(anchor: ThreadAnchor, revision: Revision): void {
  if (anchor.revisionId !== revision.id) {
    throw new CollaborationError('INVALID', 'Thread anchor revision does not match the revision');
  }
  requireIdentifier(anchor.reactNodeId, 'reactNodeId');
  requireIdentifier(anchor.scenarioId, 'scenarioId');
  if (!revision.scenarioIds.includes(anchor.scenarioId)) {
    throw new CollaborationError('INVALID', 'Thread scenario is not present in the revision');
  }
}

export function validateCommentInput(input: Pick<Comment, 'body' | 'mentionedUserIds'>): void {
  requireText(input.body, 'body');
  if (!unique(input.mentionedUserIds)) {
    throw new CollaborationError('INVALID', 'mentionedUserIds must be unique');
  }
}

export interface CollaborationRepository {
  getProject(projectId: string): Promise<Project | undefined>;
  getRevision(revisionId: string): Promise<Revision | undefined>;
  getLatestRevision(projectId: string): Promise<Revision | undefined>;
  createProject(project: Project): Promise<void>;
  /** Atomically append only if `expectedParentRevisionId` is still current. */
  appendRevision(revision: Revision, expectedParentRevisionId?: string): Promise<void>;
  getDesignReviewState(projectId: string): Promise<DesignReviewState | undefined>;
  /**
   * Atomically appends a generated-design revision, records a baseline, or
   * records the semantic delta after an existing baseline. Comments and other
   * collaboration activity must not use this command.
   */
  commitDesignRevision(input: CommitDesignRevisionInput): Promise<CommitDesignRevisionResult>;
  createThread(thread: Thread): Promise<void>;
  getThread(threadId: string): Promise<Thread | undefined>;
  updateThreadResolution(
    threadId: string,
    resolvedBy: string,
    resolvedAt?: string
  ): Promise<Thread>;
  createComment(comment: Comment): Promise<void>;
  getComment(commentId: string): Promise<Comment | undefined>;
  addReaction(reaction: Reaction): Promise<void>;
  putApproval(approval: Approval): Promise<void>;
  appendAudit(event: AuditEvent): Promise<void>;
  appendEvent(event: Omit<CollaborationEvent, 'cursor'>): Promise<CollaborationEvent>;
  listEvents(
    projectId: string,
    afterCursor: number,
    limit: number
  ): Promise<readonly CollaborationEvent[]>;
  createShareLink(link: SignedShareLink): Promise<void>;
  getShareLink(linkId: string): Promise<SignedShareLink | undefined>;
  revokeShareLink(linkId: string, revokedAt: string): Promise<void>;
  exportProject(projectId: string): Promise<CollaborationSnapshot | undefined>;
  replaceProject(snapshot: CollaborationSnapshot): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
  getIdempotency<T>(scope: string, key: string): Promise<T | undefined>;
  putIdempotency<T>(scope: string, key: string, response: T): Promise<void>;
}

/** A small helper so service handlers and sync clients can safely retry writes. */
export async function idempotent<T>(
  repository: CollaborationRepository,
  scope: string,
  key: string | undefined,
  operation: () => Promise<T>
): Promise<T> {
  if (key === undefined) return operation();
  requireText(key, 'idempotency key', 256);
  const existing = await repository.getIdempotency<T>(scope, key);
  if (existing !== undefined) return existing;
  const response = await operation();
  await repository.putIdempotency(scope, key, response);
  return response;
}

export interface InMemoryCollaborationRepository extends CollaborationRepository {
  readonly kind: 'in-memory';
}

function draftDesignReviewState(projectId: string): DesignReviewState {
  return {
    projectId,
    readiness: 'draft',
    currency: 'none',
    approvalsStale: false,
    changesSinceBaseline: []
  };
}

/** Local/offline adapter. It is suitable for Electron and tests, not multi-process sharing. */
export function createInMemoryCollaborationRepository(): InMemoryCollaborationRepository {
  const projects = new Map<string, Project>();
  const revisions = new Map<string, Revision>();
  const threads = new Map<string, Thread>();
  const comments = new Map<string, Comment>();
  const reactions = new Map<string, Reaction>();
  const approvals = new Map<string, Approval>();
  const audits: AuditEvent[] = [];
  const shareLinks = new Map<string, SignedShareLink>();
  const events: CollaborationEvent[] = [];
  const reviewStates = new Map<string, DesignReviewState>();
  const semanticChanges = new Map<string, SemanticDesignChange>();
  let eventCursor = 0;
  const idempotency = new Map<string, unknown>();
  const key = (scope: string, value: string) => `${scope}\u0000${value}`;

  return {
    kind: 'in-memory',
    async getProject(id) {
      return projects.get(id);
    },
    async getRevision(id) {
      return revisions.get(id);
    },
    async getLatestRevision(projectId) {
      return [...revisions.values()]
        .filter((revision) => revision.projectId === projectId)
        .sort((left, right) => right.sequence - left.sequence)[0];
    },
    async getDesignReviewState(projectId) {
      if (!projects.has(projectId)) return undefined;
      return reviewStates.get(projectId) ?? draftDesignReviewState(projectId);
    },
    async createProject(project) {
      if (projects.has(project.id))
        throw new CollaborationError('DUPLICATE', 'Project already exists');
      projects.set(project.id, project);
    },
    async appendRevision(revision, expectedParentRevisionId) {
      if (!projects.has(revision.projectId))
        throw new CollaborationError('NOT_FOUND', 'Project not found');
      if (revisions.has(revision.id))
        throw new CollaborationError('DUPLICATE', 'Revision already exists');
      const current = await this.getLatestRevision(revision.projectId);
      if (current?.id !== expectedParentRevisionId) {
        throw new CollaborationError('CONFLICT', 'Revision parent is no longer current');
      }
      if (revision.sequence !== (current?.sequence ?? 0) + 1) {
        throw new CollaborationError(
          'CONFLICT',
          'Revision sequence is not the next immutable revision'
        );
      }
      revisions.set(revision.id, revision);
    },
    async commitDesignRevision(input) {
      if (input.idempotencyKey !== undefined) {
        requireText(input.idempotencyKey, 'idempotency key', 256);
        const scope = input.idempotencyScope ?? `design:${input.actorId}:${input.projectId}`;
        const existing = idempotency.get(key(scope, input.idempotencyKey));
        if (existing !== undefined)
          return { ...(existing as CommitDesignRevisionResult), replayed: true };
      }
      if (!projects.has(input.projectId))
        throw new CollaborationError('NOT_FOUND', 'Project not found');
      if (!input.revision && !input.readiness)
        throw new CollaborationError('INVALID', 'A revision or readiness transition is required');
      if (input.revision && input.revision.projectId !== input.projectId)
        throw new CollaborationError('INVALID', 'Revision must belong to the project');
      if (input.readiness) {
        const readinessRevision =
          input.readiness.revisionId === input.revision?.id
            ? input.revision
            : revisions.get(input.readiness.revisionId);
        if (!readinessRevision || readinessRevision.projectId !== input.projectId)
          throw new CollaborationError('INVALID', 'Baseline revision must belong to the project');
        if (readinessRevision.contentSha256 !== input.readiness.revisionFingerprint)
          throw new CollaborationError(
            'INVALID',
            'Baseline fingerprint must match the immutable revision'
          );
      }
      const before = await this.getLatestRevision(input.projectId);
      const state = reviewStates.get(input.projectId) ?? draftDesignReviewState(input.projectId);
      const hadBaseline = state.baseline !== undefined && input.readiness === undefined;
      if (input.readiness && input.semanticChange)
        throw new CollaborationError(
          'INVALID',
          'A readiness transition cannot include a semantic design change'
        );
      if (!hadBaseline && input.revision && input.semanticChange)
        throw new CollaborationError(
          'INVALID',
          'Semantic design changes require an active baseline'
        );
      if (hadBaseline && input.revision && !input.semanticChange) {
        throw new CollaborationError(
          'INVALID',
          'Design-affecting revisions after a baseline require semantic change metadata'
        );
      }
      if (input.semanticChange) {
        const change = input.semanticChange;
        if (change.affected.projectId !== input.projectId)
          throw new CollaborationError('INVALID', 'Semantic change must belong to the project');
        requireText(change.id, 'semantic change id');
        requireText(change.reason, 'semantic change reason');
        if (change.evidence.length === 0)
          throw new CollaborationError('INVALID', 'Semantic design changes require evidence');
        for (const evidence of change.evidence)
          requireText(evidence.description, 'evidence description');
        if (change.provenance.kind === 'actor') requireText(change.provenance.actorId, 'actor id');
        else {
          requireText(change.provenance.agentId, 'agent id');
          requireText(change.provenance.promptDigest, 'prompt digest');
        }
        if (semanticChanges.has(change.id))
          throw new CollaborationError('DUPLICATE', 'Semantic design change already exists');
      }
      if (input.revision) {
        if (revisions.has(input.revision.id))
          throw new CollaborationError('DUPLICATE', 'Revision already exists');
        if (before?.id !== input.expectedParentRevisionId)
          throw new CollaborationError('CONFLICT', 'Revision parent is no longer current');
        if (input.revision.sequence !== (before?.sequence ?? 0) + 1)
          throw new CollaborationError(
            'CONFLICT',
            'Revision sequence is not the next immutable revision'
          );
        revisions.set(input.revision.id, input.revision);
      }
      if (input.readiness) {
        if (
          [...reviewStates.values()].some(
            (candidate) => candidate.baseline?.id === input.readiness!.id
          )
        )
          throw new CollaborationError('DUPLICATE', 'Design baseline already exists');
        const readinessRevision = input.revision ?? revisions.get(input.readiness.revisionId);
        if (!readinessRevision || readinessRevision.projectId !== input.projectId)
          throw new CollaborationError('INVALID', 'Baseline revision must belong to the project');
        reviewStates.set(input.projectId, {
          projectId: input.projectId,
          readiness: input.readiness.intent === 'review' ? 'ready-for-review' : 'ready-for-handoff',
          baseline: {
            id: input.readiness.id,
            revision: { id: readinessRevision.id, fingerprint: readinessRevision.contentSha256 },
            intent: input.readiness.intent,
            createdBy: input.actorId,
            createdAt: input.occurredAt
          },
          currency: 'current',
          approvalsStale: false,
          changesSinceBaseline: []
        });
      }
      if (hadBaseline && input.revision) {
        const change: SemanticDesignChange = {
          ...input.semanticChange!,
          beforeRevision: { id: before!.id, fingerprint: before!.contentSha256 },
          currentRevision: { id: input.revision.id, fingerprint: input.revision.contentSha256 },
          occurredAt: input.occurredAt
        };
        semanticChanges.set(change.id, change);
        reviewStates.set(input.projectId, {
          ...state,
          currency: 'stale',
          approvalsStale: true,
          changesSinceBaseline: [...state.changesSinceBaseline, change]
        });
      }
      const result: CommitDesignRevisionResult = input.revision
        ? input.readiness
          ? {
              kind: 'revision-and-readiness',
              revision: input.revision,
              readiness: input.readiness,
              replayed: false
            }
          : {
              kind: 'revision',
              revision: input.revision,
              changeRecorded: hadBaseline,
              replayed: false
            }
        : { kind: 'readiness', readiness: input.readiness!, replayed: false };
      if (input.idempotencyKey !== undefined) {
        const scope = input.idempotencyScope ?? `design:${input.actorId}:${input.projectId}`;
        idempotency.set(key(scope, input.idempotencyKey), result);
      }
      return result;
    },
    async createThread(thread) {
      if (threads.has(thread.id))
        throw new CollaborationError('DUPLICATE', 'Thread already exists');
      const revision = revisions.get(thread.revisionId);
      if (!revision || revision.projectId !== thread.projectId) {
        throw new CollaborationError('NOT_FOUND', 'Thread revision was not found in this project');
      }
      validateThreadAnchor(thread, revision);
      threads.set(thread.id, thread);
    },
    async getThread(id) {
      return threads.get(id);
    },
    async updateThreadResolution(id, resolvedBy, resolvedAt) {
      const thread = threads.get(id);
      if (!thread) throw new CollaborationError('NOT_FOUND', 'Thread not found');
      const updated = { ...thread, resolvedBy, resolvedAt: resolvedAt ?? new Date().toISOString() };
      threads.set(id, updated);
      return updated;
    },
    async createComment(comment) {
      if (comments.has(comment.id))
        throw new CollaborationError('DUPLICATE', 'Comment already exists');
      if (!threads.has(comment.threadId))
        throw new CollaborationError('NOT_FOUND', 'Thread not found');
      if (comment.parentCommentId && !comments.has(comment.parentCommentId)) {
        throw new CollaborationError('NOT_FOUND', 'Parent comment not found');
      }
      validateCommentInput(comment);
      comments.set(comment.id, comment);
    },
    async getComment(id) {
      return comments.get(id);
    },
    async addReaction(reaction) {
      if (!comments.has(reaction.commentId))
        throw new CollaborationError('NOT_FOUND', 'Comment not found');
      requireText(reaction.emoji, 'emoji', 64);
      reactions.set(key(reaction.commentId, `${reaction.userId}:${reaction.emoji}`), reaction);
    },
    async putApproval(approval) {
      if (!revisions.has(approval.revisionId))
        throw new CollaborationError('NOT_FOUND', 'Revision not found');
      approvals.set(key(approval.revisionId, approval.userId), approval);
    },
    async appendAudit(event) {
      audits.push(event);
    },
    async appendEvent(event) {
      const stored = { ...event, cursor: ++eventCursor };
      events.push(stored);
      return stored;
    },
    async listEvents(projectId, afterCursor, limit) {
      return events
        .filter((event) => event.projectId === projectId && event.cursor > afterCursor)
        .slice(0, limit);
    },
    async createShareLink(link) {
      if (shareLinks.has(link.id))
        throw new CollaborationError('DUPLICATE', 'Share link already exists');
      shareLinks.set(link.id, link);
    },
    async getShareLink(linkId) {
      return shareLinks.get(linkId);
    },
    async revokeShareLink(linkId, revokedAt) {
      const link = shareLinks.get(linkId);
      if (!link) throw new CollaborationError('NOT_FOUND', 'Share link not found');
      shareLinks.set(linkId, { ...link, revokedAt });
    },
    async exportProject(projectId) {
      const project = projects.get(projectId);
      if (!project) return undefined;
      const revisionIds = new Set(
        [...revisions.values()]
          .filter((revision) => revision.projectId === projectId)
          .map((revision) => revision.id)
      );
      const projectThreads = [...threads.values()].filter(
        (thread) => thread.projectId === projectId
      );
      const threadIds = new Set(projectThreads.map((thread) => thread.id));
      const projectComments = [...comments.values()].filter((comment) =>
        threadIds.has(comment.threadId)
      );
      const commentIds = new Set(projectComments.map((comment) => comment.id));
      const designReviewState = reviewStates.get(projectId);
      return {
        format: collaborationFormat,
        project,
        revisions: [...revisions.values()].filter((item) => item.projectId === projectId),
        threads: projectThreads,
        comments: projectComments,
        reactions: [...reactions.values()].filter((item) => commentIds.has(item.commentId)),
        approvals: [...approvals.values()].filter((item) => revisionIds.has(item.revisionId)),
        ...(designReviewState ? { designReviewState } : {})
      };
    },
    async replaceProject(snapshot) {
      if (snapshot.format !== collaborationFormat)
        throw new CollaborationError('INVALID', 'Unsupported snapshot');
      projects.set(snapshot.project.id, snapshot.project);
      for (const value of snapshot.revisions) revisions.set(value.id, value);
      for (const value of snapshot.threads) threads.set(value.id, value);
      for (const value of snapshot.comments) comments.set(value.id, value);
      for (const value of snapshot.reactions)
        reactions.set(key(value.commentId, `${value.userId}:${value.emoji}`), value);
      for (const value of snapshot.approvals)
        approvals.set(key(value.revisionId, value.userId), value);
      if (snapshot.designReviewState) {
        if (snapshot.designReviewState.projectId !== snapshot.project.id)
          throw new CollaborationError(
            'INVALID',
            'Design review state must belong to the snapshot project'
          );
        reviewStates.set(snapshot.project.id, snapshot.designReviewState);
        for (const change of snapshot.designReviewState.changesSinceBaseline)
          semanticChanges.set(change.id, change);
      }
    },
    async deleteProject(projectId) {
      const snapshot = await this.exportProject(projectId);
      if (!snapshot) return;
      projects.delete(projectId);
      reviewStates.delete(projectId);
      for (const revision of snapshot.revisions) revisions.delete(revision.id);
      for (const thread of snapshot.threads) threads.delete(thread.id);
      for (const comment of snapshot.comments) comments.delete(comment.id);
    },
    async getIdempotency<T>(scope: string, value: string) {
      return idempotency.get(key(scope, value)) as T | undefined;
    },
    async putIdempotency<T>(scope: string, value: string, response: T) {
      idempotency.set(key(scope, value), response);
    }
  };
}

export function serializeSnapshot(snapshot: CollaborationSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function parseSnapshot(serialized: string): CollaborationSnapshot {
  try {
    const value = JSON.parse(serialized) as CollaborationSnapshot;
    if (value.format !== collaborationFormat || !value.project || !Array.isArray(value.revisions)) {
      throw new Error('unsupported format');
    }
    return value;
  } catch {
    throw new CollaborationError('INVALID', 'Collaboration import is not a valid snapshot');
  }
}

export * from './history.js';
