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
      return {
        format: collaborationFormat,
        project,
        revisions: [...revisions.values()].filter((item) => item.projectId === projectId),
        threads: projectThreads,
        comments: projectComments,
        reactions: [...reactions.values()].filter((item) => commentIds.has(item.commentId)),
        approvals: [...approvals.values()].filter((item) => revisionIds.has(item.revisionId))
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
    },
    async deleteProject(projectId) {
      const snapshot = await this.exportProject(projectId);
      if (!snapshot) return;
      projects.delete(projectId);
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
