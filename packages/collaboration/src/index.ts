/**
 * Collaboration domain contracts.  This module is intentionally runtime-free:
 * applications choose storage, clocks, authentication, and transport adapters.
 */
import type { IdentityRole } from './identity.js';
import {
  type CollaborationHostContext,
  callCollaborationHostPort,
  captureCollaborationIterable,
  collaborationBudgets,
  equalCollaborationValues,
  ownCollaborationValue
} from './boundary.js';
export type { CollaborationHostContext, CollaborationHostContextFactory } from './boundary.js';

export {
  callCollaborationHostPort,
  captureCollaborationIterable,
  collaborationBudgets,
  CollaborationBoundaryError,
  equalCollaborationValues,
  ownCollaborationValue
} from './boundary.js';
export {
  hostedReviewFormat,
  isDiscussionOnlyHostedReviewOperation,
  listHostedReviewThroughHost,
  mutateHostedReviewThroughHost,
  validateHostedReviewActor,
  validateHostedReviewAnchor,
  validateHostedReviewBinding,
  validateHostedReviewOperation,
  validateHostedReviewProviderState,
  validateHostedReviewThread,
  type HostedReviewActor,
  type HostedReviewAnchor,
  type HostedReviewBinding,
  type HostedReviewOperation,
  type HostedReviewOperationResult,
  type HostedReviewProviderPort,
  type HostedReviewProviderState,
  type HostedReviewReply,
  type HostedReviewThread
} from './hosted-review.js';

/** v2 adds independent spatial review, AI-change, and developer-annotation aggregates. */
export const collaborationFormat = 'selene-collaboration/v2' as const;
export const legacyCollaborationFormat = 'selene-collaboration/v1' as const;

export type MembershipRole = IdentityRole;
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
function frozenRoles(...roles: readonly MembershipRole[]): readonly MembershipRole[] {
  return Object.freeze(roles);
}

export const allowedRolesByAction: Readonly<
  Record<CollaborationAction, readonly MembershipRole[]>
> = Object.freeze({
  'organization:create-project': frozenRoles('owner', 'admin', 'editor'),
  'project:read': frozenRoles('owner', 'admin', 'editor', 'commenter', 'viewer', 'guest'),
  'project:design': frozenRoles('owner', 'admin', 'editor'),
  'project:comment': frozenRoles('owner', 'admin', 'editor', 'commenter'),
  'project:approve': frozenRoles('owner', 'admin', 'editor'),
  'project:manage-sharing': frozenRoles('owner', 'admin', 'editor'),
  'project:restore': frozenRoles('owner', 'admin'),
  'project:merge': frozenRoles('owner', 'admin'),
  'project:delete': frozenRoles('owner', 'admin')
});

export function roleAllows(role: MembershipRole, action: CollaborationAction): boolean {
  if (typeof role !== 'string' || typeof action !== 'string') return false;
  if (!Object.prototype.hasOwnProperty.call(allowedRolesByAction, action)) return false;
  return allowedRolesByAction[action]?.includes(role) === true;
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

export interface RevisionEvidence {
  readonly artifactId: string;
  readonly screenId: string;
  readonly revisionId: string;
  readonly revisionFingerprint: string;
  readonly viewport: { readonly width: number; readonly height: number; readonly zoom: number };
  readonly scenarioId?: string;
  readonly stateId?: string;
  readonly nodeId?: string;
  readonly sourceRef?: string;
}

export interface SpatialPoint {
  readonly x: number;
  readonly y: number;
}

export interface SpatialRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Coordinates are normalized to the reviewed deployed viewport (0..1), never React node IDs. */
export type SpatialTarget =
  | { readonly kind: 'point'; readonly point: SpatialPoint }
  | { readonly kind: 'region'; readonly region: SpatialRegion };

export interface SpatialAnchor {
  readonly evidence: RevisionEvidence;
  readonly target: SpatialTarget;
  readonly lifecycle: 'current' | 'mapped' | 'stale' | 'orphaned';
  readonly mappedFrom?: RevisionEvidence;
}

export interface ReviewThreadMessage {
  readonly id: string;
  readonly body: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly parentMessageId?: string;
  readonly mentionedUserIds: readonly string[];
  readonly reactions: readonly { readonly emoji: string; readonly userIds: readonly string[] }[];
  readonly readBy: readonly string[];
}

/** Figma-style discussion attached to a point or region in a deployed revision/state. */
export interface ReviewThread {
  readonly id: string;
  readonly projectId: string;
  readonly anchor: SpatialAnchor;
  readonly messages: readonly ReviewThreadMessage[];
  readonly deepLink: string;
  readonly lifecycle: 'open' | 'resolved';
  readonly createdBy: string;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
  /** Most recent reopening attribution remains durable after resolution metadata is cleared. */
  readonly reopenedAt?: string;
  readonly reopenedBy?: string;
  readonly movedAt?: string;
  readonly movedBy?: string;
}

export interface ReviewThreadFilter {
  readonly lifecycle?: ReviewThread['lifecycle'];
  readonly revisionId?: string;
  readonly deepLink?: string;
  readonly screenId?: string;
  readonly stateId?: string;
  readonly createdBy?: string;
  /** Include only threads with at least one message the user has not read. */
  readonly unreadFor?: string;
}

export type AIChangeRequestLifecycle =
  'queued' | 'running' | 'applied' | 'failed' | 'cancelled' | 'undone';

/** Immutable provider selection recorded when a request is created, not inferred later. */
export interface AIChangeProviderSnapshot {
  readonly providerId: string;
  readonly capability: string;
  readonly model?: string;
  readonly implementation?: string;
}

export interface AIChangeRequestResult {
  readonly revisionId: string;
  readonly revisionFingerprint: string;
  readonly diff: string;
  readonly completedAt: string;
}

/** Claude-Design-style targeted instruction. It is a design mutation request, not a review comment. */
export interface AIChangeRequest {
  readonly id: string;
  readonly projectId: string;
  readonly anchor: SpatialAnchor;
  readonly instruction: string;
  readonly provider: AIChangeProviderSnapshot;
  readonly baseRevision: { readonly id: string; readonly fingerprint: string };
  readonly lifecycle: AIChangeRequestLifecycle;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result?: AIChangeRequestResult;
  /** Immutable compensating result recorded when an applied request is undone. */
  readonly undoResult?: AIChangeRequestResult;
  readonly failureReason?: string;
}

/** Non-executable developer handoff guidance; it is intentionally neither review nor agent work. */
export interface DeveloperAnnotation {
  readonly id: string;
  readonly projectId: string;
  readonly anchor: SpatialAnchor;
  readonly category: 'development' | 'interaction' | 'accessibility' | 'content';
  readonly body: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** Stable, display-oriented grouping for review pins in a normalized viewport. */
export interface SpatialReviewCluster {
  readonly key: string;
  readonly threadIds: readonly string[];
  readonly centroid: SpatialPoint;
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
export const designReviewStateFormat = 'selene-design-review-state/v1' as const;

export interface DesignRevisionReference {
  readonly id: string;
  readonly fingerprint: string;
}

export interface DesignBaseline {
  readonly id: string;
  readonly projectId: string;
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
  readonly format: typeof designReviewStateFormat;
  readonly projectId: string;
  readonly readiness: DesignReadiness;
  readonly baseline?: DesignBaseline;
  readonly currency: DesignBaselineCurrency;
  readonly approvalsStale: boolean;
  readonly changesSinceBaseline: readonly SemanticDesignChange[];
}

interface DesignRevisionCommandContext {
  readonly projectId: string;
  readonly actorId: string;
  readonly occurredAt: string;
  readonly idempotencyKey?: string;
  readonly idempotencyScope?: string;
}

/**
 * The three atomic generated-design transactions. The discriminant makes
 * invalid combinations (for example, readiness plus a semantic change)
 * unrepresentable to repository callers.
 */
export type CommitDesignRevisionInput =
  | (DesignRevisionCommandContext & {
      readonly kind: 'append-revision';
      readonly revision: Revision;
      readonly expectedParentRevisionId?: string;
      readonly semanticChange?: SemanticDesignChangeInput;
    })
  | (DesignRevisionCommandContext & {
      readonly kind: 'mark-ready';
      readonly readiness: DesignReadinessInput;
    })
  | (DesignRevisionCommandContext & {
      readonly kind: 'append-revision-and-mark-ready';
      readonly revision: Revision;
      readonly expectedParentRevisionId?: string;
      readonly readiness: DesignReadinessInput;
    });

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
  sign(payload: string, context?: CollaborationHostContext): Promise<string>;
  verify(payload: string, signature: string, context?: CollaborationHostContext): Promise<boolean>;
  /** One-way digest for durable revocation without persisting the bearer token. */
  hash(token: string, context?: CollaborationHostContext): Promise<string>;
}

export interface ShareLinkGrant {
  readonly linkId: string;
  readonly projectId: string;
  readonly permission: SharePermission;
  readonly expiresAt: string;
}

const issuedShareTokenHostFailures = new WeakSet<object>();
class ShareTokenHostFailure extends Error {
  public constructor() {
    super('Share token host operation failed');
    issuedShareTokenHostFailures.add(this);
  }
}
/** Distinguishes a package-issued supervised signer outage from forged public errors. */
export function isShareTokenHostFailure(value: unknown): boolean {
  return typeof value === 'object' && value !== null && issuedShareTokenHostFailures.has(value);
}

export async function createSignedShareToken(
  grant: ShareLinkGrant,
  signer: ShareTokenSigner,
  context?: CollaborationHostContext
): Promise<string> {
  grant = owned(grant, 'Share link grant is invalid');
  timestamp(grant.expiresAt, 'Share link expiry');
  requireIdentifier(grant.linkId, 'Share link id');
  requireIdentifier(grant.projectId, 'Share link project id');
  if (grant.permission !== 'viewer' && grant.permission !== 'commenter')
    throw new CollaborationError('INVALID', 'Share link permission is invalid');
  const payload = JSON.stringify(grant);
  let signature: string;
  try {
    signature = await (context
      ? callCollaborationHostPort<string>(context, signer, 'sign', [payload])
      : signer.sign(payload));
  } catch {
    if (context !== undefined) throw new ShareTokenHostFailure();
    throw new CollaborationError('FORBIDDEN', 'Share link signer failed');
  }
  if (typeof signature !== 'string' || signature.length > collaborationBudgets.maxText) {
    if (context !== undefined) throw new ShareTokenHostFailure();
    throw new CollaborationError('FORBIDDEN', 'Share link signer failed');
  }
  // `~` is outside the base64url alphabet, so the two opaque parts remain
  // unambiguous when passed through headers and URLs.
  return `${encodeBase64Url(payload)}~${signature}`;
}

export async function verifySignedShareToken(
  token: string,
  signer: ShareTokenSigner,
  now = new Date().toISOString(),
  context?: CollaborationHostContext
): Promise<ShareLinkGrant> {
  if (typeof token !== 'string' || token.length > collaborationBudgets.maxText)
    throw new CollaborationError('FORBIDDEN', 'Malformed share link');
  const [encodedPayload, signature, extra] = token.split('~');
  if (!encodedPayload || !signature || extra)
    throw new CollaborationError('FORBIDDEN', 'Malformed share link');
  let payload: string;
  try {
    payload = decodeBase64Url(encodedPayload);
  } catch {
    throw new CollaborationError('FORBIDDEN', 'Malformed share link');
  }
  let verified: boolean;
  try {
    verified = await (context
      ? callCollaborationHostPort<boolean>(context, signer, 'verify', [payload, signature])
      : signer.verify(payload, signature));
  } catch {
    if (context !== undefined) throw new ShareTokenHostFailure();
    throw new CollaborationError('FORBIDDEN', 'Share link signer failed');
  }
  if (typeof verified !== 'boolean') {
    if (context !== undefined) throw new ShareTokenHostFailure();
    throw new CollaborationError('FORBIDDEN', 'Share link signer failed');
  }
  if (verified !== true) throw new CollaborationError('FORBIDDEN', 'Invalid share link signature');
  let grant: ShareLinkGrant;
  try {
    grant = owned(JSON.parse(payload), 'Malformed share link payload') as ShareLinkGrant;
    if (
      !grant.linkId ||
      !grant.projectId ||
      (grant.permission !== 'viewer' && grant.permission !== 'commenter')
    ) {
      throw new Error('invalid grant');
    }
  } catch {
    throw new CollaborationError('FORBIDDEN', 'Malformed share link payload');
  }
  try {
    timestamp(grant.expiresAt, 'Share link expiry');
    timestamp(now, 'Share link current time');
  } catch {
    throw new CollaborationError('FORBIDDEN', 'Malformed share link payload');
  }
  if (Date.parse(grant.expiresAt) <= Date.parse(now))
    throw new CollaborationError('EXPIRED', 'Share link has expired');
  return grant;
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
  readonly reviewThreads: readonly ReviewThread[];
  readonly aiChangeRequests: readonly AIChangeRequest[];
  readonly developerAnnotations: readonly DeveloperAnnotation[];
  /** Optional for backwards-compatible imports of v1 snapshots created before baseline persistence. */
  readonly designReviewState?: DesignReviewState;
}

export class CollaborationError extends Error {
  public constructor(
    readonly code: 'CONFLICT' | 'DUPLICATE' | 'INVALID' | 'NOT_FOUND' | 'FORBIDDEN' | 'EXPIRED',
    message: string
  ) {
    super(message);
    this.name = 'CollaborationError';
  }
}

function owned<T>(value: T, message = 'Untrusted collaboration value is invalid'): T {
  try {
    return ownCollaborationValue(value);
  } catch {
    throw new CollaborationError('INVALID', message);
  }
}

function requireText(value: string, field: string, max = 4000): void {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    new TextEncoder().encode(value).byteLength > max * 4
  ) {
    throw new CollaborationError('INVALID', `${field} must contain 1-${max} characters`);
  }
}

function requireIdentifier(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    value.length > collaborationBudgets.maxIdentifier ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ) {
    throw new CollaborationError('INVALID', `${field} is not a stable identifier`);
  }
}

function requireCoordinate(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new CollaborationError('INVALID', `${field} must be a normalized coordinate`);
}

const maxSnapshotBytes = collaborationBudgets.maxBytes;
const maxSnapshotItems = collaborationBudgets.maxItems;
const maxReviewMessages = collaborationBudgets.maxEvidence;
const maxReviewMessageReferences = collaborationBudgets.maxReferences;
const maxReviewReactions = Math.min(100, collaborationBudgets.maxEvidence);

function requireListLimit(values: readonly unknown[], maximum: number, field: string): void {
  if (values.length > maximum)
    throw new CollaborationError('INVALID', `${field} exceeds the maximum of ${maximum} items`);
}

/** Materializes adapter iterables without allowing an infinite iterator to allocate unbounded memory. */
function boundedIterable<T>(values: Iterable<T>, maximum: number, field: string): readonly T[] {
  try {
    return captureCollaborationIterable(values, maximum, field);
  } catch {
    throw new CollaborationError('INVALID', `${field} is not a safe iterable`);
  }
}

/** Validates a portable deep link before a service binds absolute URLs to its own origin. */
export function validateReviewDeepLink(value: string): void {
  value = owned(value, 'Review thread deepLink is invalid');
  requireText(value, 'review thread deepLink', collaborationBudgets.maxUrl);
  if (value.startsWith('/') && !value.startsWith('//')) {
    if (
      value.includes('\\') ||
      [...value].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      })
    )
      throw new CollaborationError(
        'INVALID',
        'Review thread deepLink contains unsafe path characters'
      );
    return;
  }
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return;
  } catch {
    // Fall through to the public contract error below.
  }
  throw new CollaborationError(
    'INVALID',
    'Review thread deepLink must be an internal path or https URL'
  );
}

function requireTimestamp(value: string, field: string): void {
  timestamp(value, field);
}

function sameStructure(left: unknown, right: unknown): boolean {
  return equalCollaborationValues(left, right);
}

function validateRevisionEvidence(
  evidence: RevisionEvidence,
  field = 'Spatial anchor evidence'
): void {
  requireIdentifier(evidence.artifactId, `${field} artifactId`);
  requireIdentifier(evidence.screenId, `${field} screenId`);
  requireIdentifier(evidence.revisionId, `${field} revisionId`);
  requireText(evidence.revisionFingerprint, `${field} revisionFingerprint`, 128);
  if (evidence.scenarioId !== undefined)
    requireIdentifier(evidence.scenarioId, `${field} scenarioId`);
  if (evidence.stateId !== undefined) requireIdentifier(evidence.stateId, `${field} stateId`);
  if (evidence.nodeId !== undefined) requireIdentifier(evidence.nodeId, `${field} nodeId`);
  if (evidence.sourceRef !== undefined) requireText(evidence.sourceRef, `${field} sourceRef`, 512);
  const viewport = evidence.viewport;
  if (
    !Number.isFinite(viewport.width) ||
    viewport.width <= 0 ||
    !Number.isFinite(viewport.height) ||
    viewport.height <= 0 ||
    !Number.isFinite(viewport.zoom) ||
    viewport.zoom <= 0 ||
    viewport.zoom > 64
  )
    throw new CollaborationError('INVALID', `${field} viewport/zoom is invalid`);
}

/** Validates spatial evidence without consulting React source or DOM metadata. */
export function validateSpatialAnchor(anchor: SpatialAnchor, revision: Revision): void {
  anchor = owned(anchor, 'Spatial anchor is invalid');
  revision = owned(revision, 'Revision is invalid');
  if (
    anchor.evidence.revisionId !== revision.id ||
    anchor.evidence.revisionFingerprint !== revision.contentSha256
  )
    throw new CollaborationError('INVALID', 'Spatial anchor must carry exact revision evidence');
  validateRevisionEvidence(anchor.evidence);
  if (
    anchor.evidence.scenarioId !== undefined &&
    !revision.scenarioIds.includes(anchor.evidence.scenarioId)
  )
    throw new CollaborationError(
      'INVALID',
      'Spatial anchor scenario is not present in the revision'
    );
  if (!['current', 'mapped', 'stale', 'orphaned'].includes(anchor.lifecycle))
    throw new CollaborationError('INVALID', 'Spatial anchor lifecycle is invalid');
  if (anchor.lifecycle === 'mapped' && anchor.mappedFrom === undefined)
    throw new CollaborationError('INVALID', 'Mapped spatial anchor requires source evidence');
  if (anchor.lifecycle !== 'mapped' && anchor.mappedFrom !== undefined)
    throw new CollaborationError(
      'INVALID',
      'Only mapped spatial anchors may carry source evidence'
    );
  if (anchor.mappedFrom !== undefined)
    validateRevisionEvidence(anchor.mappedFrom, 'Mapped source evidence');
  if (anchor.target.kind === 'point') {
    requireCoordinate(anchor.target.point.x, 'point.x');
    requireCoordinate(anchor.target.point.y, 'point.y');
  } else if (anchor.target.kind === 'region') {
    const { x, y, width, height } = anchor.target.region;
    requireCoordinate(x, 'region.x');
    requireCoordinate(y, 'region.y');
    requireCoordinate(width, 'region.width');
    requireCoordinate(height, 'region.height');
    if (width <= 0 || height <= 0 || x + width > 1 || y + height > 1)
      throw new CollaborationError(
        'INVALID',
        'Spatial region must fit inside the reviewed viewport'
      );
  } else {
    throw new CollaborationError('INVALID', 'Spatial anchor requires a point or region');
  }
}

export function validateAIChangeRequest(request: AIChangeRequest, revision: Revision): void {
  request = owned(request, 'AI change request is invalid');
  revision = owned(revision, 'Revision is invalid');
  validateSpatialAnchor(request.anchor, revision);
  if (
    request.baseRevision.id !== revision.id ||
    request.baseRevision.fingerprint !== revision.contentSha256
  )
    throw new CollaborationError(
      'INVALID',
      'AI change request base revision must match its anchor evidence'
    );
  requireText(request.instruction, 'AI change instruction');
  requireIdentifier(request.provider.providerId, 'providerId');
  requireText(request.provider.capability, 'provider capability', 128);
  if (
    !['queued', 'running', 'applied', 'failed', 'cancelled', 'undone'].includes(request.lifecycle)
  )
    throw new CollaborationError('INVALID', 'AI change request lifecycle is invalid');
  if (
    (request.lifecycle === 'applied' || request.lifecycle === 'undone') &&
    request.result === undefined
  )
    throw new CollaborationError(
      'INVALID',
      'Applied or undone AI change request requires a result'
    );
  if (
    request.lifecycle !== 'applied' &&
    request.lifecycle !== 'undone' &&
    request.result !== undefined
  )
    throw new CollaborationError(
      'INVALID',
      'Only applied or undone AI change requests may have a result'
    );
  if (request.result) {
    requireText(request.result.revisionId, 'AI result revisionId');
    requireText(request.result.revisionFingerprint, 'AI result revisionFingerprint');
    requireText(request.result.diff, 'AI result diff', 1_000_000);
    timestamp(request.result.completedAt, 'AI result completedAt');
  }
  if (request.lifecycle === 'undone' && request.undoResult === undefined)
    throw new CollaborationError(
      'INVALID',
      'Undone AI change request requires a compensating result'
    );
  if (request.lifecycle !== 'undone' && request.undoResult !== undefined)
    throw new CollaborationError(
      'INVALID',
      'Only undone AI change requests may have a compensating result'
    );
  if (request.undoResult) {
    requireText(request.undoResult.revisionId, 'AI undo result revisionId');
    requireText(request.undoResult.revisionFingerprint, 'AI undo result revisionFingerprint');
    requireText(request.undoResult.diff, 'AI undo result diff', 1_000_000);
    timestamp(request.undoResult.completedAt, 'AI undo result completedAt');
  }
  if (request.lifecycle === 'failed' && request.failureReason === undefined)
    throw new CollaborationError('INVALID', 'Failed AI change request requires a diagnostic');
  if (request.lifecycle !== 'failed' && request.failureReason !== undefined)
    throw new CollaborationError(
      'INVALID',
      'Only failed AI change requests may carry a diagnostic'
    );
  if (request.failureReason !== undefined)
    requireText(request.failureReason, 'AI failure diagnostic');
}

/** Ensures result provenance points at immutable revisions already owned by the request project. */
export function validateAIChangeRequestResultReferences(
  request: AIChangeRequest,
  availableRevisions: Iterable<Revision>
): void {
  request = owned(request, 'AI change request is invalid');
  let revisions: Map<string, Revision>;
  try {
    const values = boundedIterable(
      availableRevisions,
      collaborationBudgets.maxReferences,
      'Available revisions'
    ).map((revision) => owned(revision, 'Revision is invalid'));
    revisions = new Map(values.map((revision) => [revision.id, revision]));
  } catch {
    throw new CollaborationError('INVALID', 'Available revisions are invalid');
  }
  const validateResult = (result: AIChangeRequestResult, field: string): void => {
    const revision = revisions.get(result.revisionId);
    if (!revision || revision.projectId !== request.projectId)
      throw new CollaborationError('NOT_FOUND', `${field} revision was not found in this project`);
    if (revision.contentSha256 !== result.revisionFingerprint)
      throw new CollaborationError(
        'INVALID',
        `${field} fingerprint must match the immutable revision`
      );
  };
  if (request.result !== undefined) validateResult(request.result, 'AI result');
  if (request.undoResult !== undefined) validateResult(request.undoResult, 'AI undo result');
}

const allowedAITransitions: Readonly<
  Record<AIChangeRequestLifecycle, readonly AIChangeRequestLifecycle[]>
> = {
  queued: ['running', 'cancelled'],
  running: ['applied', 'failed', 'cancelled'],
  applied: ['undone'],
  failed: ['queued'],
  cancelled: ['queued'],
  undone: []
};

export function validateAIChangeRequestTransition(
  previous: AIChangeRequest,
  next: AIChangeRequest
): void {
  previous = owned(previous, 'AI change request is invalid');
  next = owned(next, 'AI change request is invalid');
  if (
    previous.id !== next.id ||
    previous.projectId !== next.projectId ||
    previous.createdBy !== next.createdBy ||
    previous.createdAt !== next.createdAt
  )
    throw new CollaborationError(
      'INVALID',
      'AI change request identity and audit ownership are immutable'
    );
  requireTimestamp(next.createdAt, 'AI change request createdAt');
  requireTimestamp(next.updatedAt, 'AI change request updatedAt');
  if (
    Date.parse(next.updatedAt) < Date.parse(next.createdAt) ||
    Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)
  )
    throw new CollaborationError('INVALID', 'AI change request updatedAt must not move backwards');
  if (
    previous.lifecycle !== next.lifecycle &&
    !allowedAITransitions[previous.lifecycle].includes(next.lifecycle)
  )
    throw new CollaborationError(
      'CONFLICT',
      `Invalid AI change request transition: ${previous.lifecycle} to ${next.lifecycle}`
    );
  if (
    previous.instruction !== next.instruction ||
    !sameStructure(previous.provider, next.provider) ||
    !sameStructure(previous.baseRevision, next.baseRevision) ||
    !sameStructure(previous.anchor, next.anchor)
  )
    throw new CollaborationError('INVALID', 'AI change request intent and targeting are immutable');
  if (
    previous.lifecycle === 'applied' &&
    next.lifecycle === 'undone' &&
    !sameStructure(previous.result, next.result)
  )
    throw new CollaborationError('INVALID', 'Undo must preserve the immutable applied result');
  if (
    previous.lifecycle === next.lifecycle &&
    (!sameStructure(previous.result, next.result) ||
      !sameStructure(previous.undoResult, next.undoResult) ||
      previous.failureReason !== next.failureReason)
  )
    throw new CollaborationError('INVALID', 'AI change request outcome is immutable');
}

export function validateReviewThread(thread: ReviewThread): void {
  thread = owned(thread, 'Review thread is invalid');
  requireIdentifier(thread.id, 'review thread id');
  requireIdentifier(thread.projectId, 'review thread projectId');
  validateReviewDeepLink(thread.deepLink);
  requireIdentifier(thread.createdBy, 'review thread createdBy');
  requireTimestamp(thread.createdAt, 'review thread createdAt');
  if (thread.lifecycle !== 'open' && thread.lifecycle !== 'resolved')
    throw new CollaborationError('INVALID', 'Review thread lifecycle is invalid');
  if (
    thread.lifecycle === 'resolved' &&
    (thread.resolvedAt === undefined || thread.resolvedBy === undefined)
  )
    throw new CollaborationError(
      'INVALID',
      'Resolved review thread requires resolver and timestamp'
    );
  if (
    thread.lifecycle === 'open' &&
    (thread.resolvedAt !== undefined || thread.resolvedBy !== undefined)
  )
    throw new CollaborationError('INVALID', 'Open review thread cannot have resolution metadata');
  if (thread.resolvedAt !== undefined)
    requireTimestamp(thread.resolvedAt, 'review thread resolvedAt');
  if (thread.resolvedBy !== undefined)
    requireIdentifier(thread.resolvedBy, 'review thread resolvedBy');
  if ((thread.reopenedAt === undefined) !== (thread.reopenedBy === undefined))
    throw new CollaborationError('INVALID', 'Review thread reopening metadata must be complete');
  if (thread.reopenedAt !== undefined)
    requireTimestamp(thread.reopenedAt, 'review thread reopenedAt');
  if (thread.reopenedBy !== undefined)
    requireIdentifier(thread.reopenedBy, 'review thread reopenedBy');
  if (
    thread.reopenedAt !== undefined &&
    Date.parse(thread.reopenedAt) <= Date.parse(thread.createdAt)
  )
    throw new CollaborationError(
      'INVALID',
      'Review thread reopening must be later than its creation'
    );
  if (
    thread.reopenedAt !== undefined &&
    thread.resolvedAt !== undefined &&
    Date.parse(thread.resolvedAt) <= Date.parse(thread.reopenedAt)
  )
    throw new CollaborationError(
      'INVALID',
      'Review thread resolution must be later than its latest reopening'
    );
  if ((thread.movedAt === undefined) !== (thread.movedBy === undefined))
    throw new CollaborationError('INVALID', 'Review thread movement metadata must be complete');
  if (thread.movedAt !== undefined) requireTimestamp(thread.movedAt, 'review thread movedAt');
  if (thread.movedBy !== undefined) requireIdentifier(thread.movedBy, 'review thread movedBy');
  if (thread.messages.length === 0)
    throw new CollaborationError('INVALID', 'Review thread requires a message');
  requireListLimit(thread.messages, maxReviewMessages, 'Review thread messages');
  const messages = new Map<string, ReviewThreadMessage>();
  for (const message of thread.messages) {
    requireIdentifier(message.id, 'review message id');
    if (messages.has(message.id))
      throw new CollaborationError('DUPLICATE', 'Review message already exists');
    requireText(message.body, 'review message body');
    requireIdentifier(message.createdBy, 'review message createdBy');
    requireTimestamp(message.createdAt, 'review message createdAt');
    requireListLimit(
      message.mentionedUserIds,
      maxReviewMessageReferences,
      'Review message mentions'
    );
    requireListLimit(message.readBy, maxReviewMessageReferences, 'Review message reads');
    requireListLimit(message.reactions, maxReviewReactions, 'Review message reactions');
    if (!unique(message.mentionedUserIds) || !unique(message.readBy))
      throw new CollaborationError(
        'INVALID',
        'Review message identity lists must not contain duplicates'
      );
    for (const userId of [...message.mentionedUserIds, ...message.readBy])
      requireIdentifier(userId, 'review message user id');
    for (const reaction of message.reactions) {
      requireText(reaction.emoji, 'review reaction emoji', 64);
      requireListLimit(reaction.userIds, maxReviewMessageReferences, 'Review reaction users');
      if (!unique(reaction.userIds))
        throw new CollaborationError(
          'INVALID',
          'Review reaction users must not contain duplicates'
        );
      for (const userId of reaction.userIds) requireIdentifier(userId, 'review reaction user id');
    }
    if (message.parentMessageId !== undefined) {
      if (message.parentMessageId === message.id || !messages.has(message.parentMessageId))
        throw new CollaborationError(
          'INVALID',
          'Review message parent must be an earlier message in the same thread'
        );
    }
    messages.set(message.id, message);
  }
}

/** Validates the complete portable developer-annotation contract before storage or export. */
export function validateDeveloperAnnotation(
  annotation: DeveloperAnnotation,
  revision: Revision
): void {
  annotation = owned(annotation, 'Developer annotation is invalid');
  revision = owned(revision, 'Revision is invalid');
  requireIdentifier(annotation.id, 'developer annotation id');
  requireIdentifier(annotation.projectId, 'developer annotation projectId');
  requireIdentifier(annotation.createdBy, 'developer annotation creator');
  requireTimestamp(annotation.createdAt, 'developer annotation createdAt');
  requireText(annotation.body, 'developer annotation body');
  if (!['development', 'interaction', 'accessibility', 'content'].includes(annotation.category))
    throw new CollaborationError('INVALID', 'Developer annotation category is invalid');
  if (revision.projectId !== annotation.projectId)
    throw new CollaborationError(
      'INVALID',
      'Developer annotation revision must belong to the project'
    );
  validateSpatialAnchor(annotation.anchor, revision);
}

/**
 * Groups review pins by a fixed normalized grid. Sorting both buckets and
 * thread IDs makes the result portable and deterministic across adapters.
 */
export function clusterReviewThreads(
  threads: readonly ReviewThread[],
  cellSize = 0.1
): readonly SpatialReviewCluster[] {
  threads = owned(threads, 'Review threads are invalid');
  if (!Number.isFinite(cellSize) || cellSize <= 0 || cellSize > 1)
    throw new CollaborationError('INVALID', 'Spatial cluster cell size must be within (0, 1]');
  const buckets = new Map<string, { threadIds: string[]; points: SpatialPoint[] }>();
  for (const thread of threads) {
    const target = thread.anchor.target;
    const point =
      target.kind === 'point'
        ? target.point
        : {
            x: target.region.x + target.region.width / 2,
            y: target.region.y + target.region.height / 2
          };
    const x = Math.min(Math.floor(point.x / cellSize), Math.ceil(1 / cellSize) - 1);
    const y = Math.min(Math.floor(point.y / cellSize), Math.ceil(1 / cellSize) - 1);
    const key = `${x}:${y}`;
    const bucket = buckets.get(key) ?? { threadIds: [], points: [] };
    bucket.threadIds.push(thread.id);
    bucket.points.push(point);
    buckets.set(key, bucket);
  }
  return owned(
    [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, bucket]) => ({
        key,
        threadIds: [...bucket.threadIds].sort((left, right) => left.localeCompare(right, 'en')),
        centroid: {
          x: bucket.points.reduce((sum, point) => sum + point.x, 0) / bucket.points.length,
          y: bucket.points.reduce((sum, point) => sum + point.y, 0) / bucket.points.length
        }
      }))
  );
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function stableByCreation<T extends { readonly id: string; readonly createdAt: string }>(
  left: T,
  right: T
): number {
  return (
    left.createdAt.localeCompare(right.createdAt, 'en') || left.id.localeCompare(right.id, 'en')
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSemanticDesignChangeKind(value: unknown): value is SemanticDesignChangeKind {
  return (
    value === 'source' ||
    value === 'design-system' ||
    value === 'token' ||
    value === 'template' ||
    value === 'dependency' ||
    value === 'visual'
  );
}

function timestamp(value: string, field: string): void {
  if (typeof value !== 'string' || value.length > collaborationBudgets.maxTimestamp)
    throw new CollaborationError('INVALID', `${field} must be an ISO timestamp`);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) throw new CollaborationError('INVALID', `${field} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed))
    throw new CollaborationError('INVALID', `${field} must be an ISO timestamp`);
  const milliseconds = (match[2] ?? '').padEnd(3, '0');
  if (new Date(parsed).toISOString() !== `${match[1]}.${milliseconds}Z`)
    throw new CollaborationError('INVALID', `${field} must be an ISO timestamp`);
}

function validateSemanticDesignChange(change: SemanticDesignChange, projectId: string): void {
  requireText(change.id, 'designReviewState.change.id');
  requireText(change.reason, 'designReviewState.change.reason');
  timestamp(change.occurredAt, 'designReviewState.change.occurredAt');
  if (
    !['source', 'design-system', 'token', 'template', 'dependency', 'visual'].includes(change.kind)
  )
    throw new CollaborationError('INVALID', 'Design review change has an invalid kind');
  requireText(change.beforeRevision.id, 'designReviewState.change.beforeRevision.id');
  requireText(
    change.beforeRevision.fingerprint,
    'designReviewState.change.beforeRevision.fingerprint'
  );
  requireText(change.currentRevision.id, 'designReviewState.change.currentRevision.id');
  requireText(
    change.currentRevision.fingerprint,
    'designReviewState.change.currentRevision.fingerprint'
  );
  if (change.beforeRevision.id === change.currentRevision.id)
    throw new CollaborationError('INVALID', 'Design review change must advance the revision');
  if (change.affected.projectId !== projectId)
    throw new CollaborationError(
      'INVALID',
      'Design review change must belong to the review project'
    );
  for (const [field, values] of Object.entries({
    screenIds: change.affected.screenIds,
    routePaths: change.affected.routePaths,
    scenarioIds: change.affected.scenarioIds,
    componentIds: change.affected.componentIds,
    stableNodeIds: change.affected.stableNodeIds
  })) {
    if (
      !Array.isArray(values) ||
      !values.every((item) => typeof item === 'string') ||
      !unique(values)
    )
      throw new CollaborationError(
        'INVALID',
        `Design review change ${field} must be unique strings`
      );
  }
  if (change.evidence.length === 0)
    throw new CollaborationError('INVALID', 'Design review change requires evidence');
  for (const evidence of change.evidence) {
    requireText(evidence.description, 'designReviewState.change.evidence.description');
    if (evidence.href !== undefined)
      requireText(evidence.href, 'designReviewState.change.evidence.href');
    if (evidence.checksum !== undefined)
      requireText(evidence.checksum, 'designReviewState.change.evidence.checksum');
  }
  if (change.provenance.kind === 'actor') requireText(change.provenance.actorId, 'actor id');
  else if (change.provenance.kind === 'agent') {
    requireText(change.provenance.agentId, 'agent id');
    requireText(change.provenance.promptDigest, 'prompt digest');
  } else {
    throw new CollaborationError('INVALID', 'Design review change has invalid provenance');
  }
}

/** Validates the portable baseline projection before import or adapter exposure. */
export function validateDesignReviewState(state: DesignReviewState): void {
  state = owned(state, 'Design review state is invalid');
  if (state.format !== designReviewStateFormat)
    throw new CollaborationError('INVALID', 'Unsupported design review state format');
  requireText(state.projectId, 'designReviewState.projectId');
  if (!['draft', 'ready-for-review', 'ready-for-handoff'].includes(state.readiness))
    throw new CollaborationError('INVALID', 'Design review state has an invalid readiness');
  if (!['current', 'stale', 'none'].includes(state.currency))
    throw new CollaborationError('INVALID', 'Design review state has an invalid currency');
  if (!Array.isArray(state.changesSinceBaseline))
    throw new CollaborationError('INVALID', 'Design review changes must be an array');
  if (state.baseline === undefined) {
    if (
      state.readiness !== 'draft' ||
      state.currency !== 'none' ||
      state.approvalsStale ||
      state.changesSinceBaseline.length !== 0
    ) {
      throw new CollaborationError(
        'INVALID',
        'Draft design review state cannot contain baseline data'
      );
    }
    return;
  }
  requireText(state.baseline.id, 'designReviewState.baseline.id');
  if (state.baseline.projectId !== state.projectId)
    throw new CollaborationError('INVALID', 'Design baseline must belong to the review project');
  requireText(state.baseline.revision.id, 'designReviewState.baseline.revision.id');
  requireText(
    state.baseline.revision.fingerprint,
    'designReviewState.baseline.revision.fingerprint'
  );
  requireText(state.baseline.createdBy, 'designReviewState.baseline.createdBy');
  if (state.baseline.intent !== 'review' && state.baseline.intent !== 'handoff')
    throw new CollaborationError('INVALID', 'Design baseline has an invalid intent');
  timestamp(state.baseline.createdAt, 'designReviewState.baseline.createdAt');
  if (
    (state.baseline.intent === 'review' && state.readiness !== 'ready-for-review') ||
    (state.baseline.intent === 'handoff' && state.readiness !== 'ready-for-handoff')
  )
    throw new CollaborationError('INVALID', 'Design readiness must match baseline intent');
  if (state.currency === 'current') {
    if (state.approvalsStale || state.changesSinceBaseline.length !== 0)
      throw new CollaborationError(
        'INVALID',
        'Current design baseline cannot contain stale changes'
      );
  } else if (state.currency === 'stale') {
    if (!state.approvalsStale || state.changesSinceBaseline.length === 0)
      throw new CollaborationError(
        'INVALID',
        'Stale design baseline requires exact changes and stale approvals'
      );
  } else {
    throw new CollaborationError('INVALID', 'A baseline cannot have none currency');
  }
  for (const change of state.changesSinceBaseline)
    validateSemanticDesignChange(change, state.projectId);
}

function readText(value: unknown, field: string): string {
  if (typeof value !== 'string')
    throw new CollaborationError('INVALID', `${field} must be a string`);
  requireText(value, field);
  return value;
}

function readStringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string') || !unique(value))
    throw new CollaborationError('INVALID', `${field} must be unique strings`);
  return value;
}

function readRevisionReference(value: unknown, field: string): DesignRevisionReference {
  if (!record(value)) throw new CollaborationError('INVALID', `${field} must be an object`);
  return {
    id: readText(value.id, `${field}.id`),
    fingerprint: readText(value.fingerprint, `${field}.fingerprint`)
  };
}

/** Parses the versioned portable review projection without trusting wire data. */
export function parseDesignReviewState(value: unknown): DesignReviewState {
  value = owned(value, 'Design review state is invalid');
  if (!record(value) || value.format !== designReviewStateFormat)
    throw new CollaborationError('INVALID', 'Unsupported design review state format');
  const projectId = readText(value.projectId, 'designReviewState.projectId');
  const readiness = value.readiness;
  const currency = value.currency;
  if (
    readiness !== 'draft' &&
    readiness !== 'ready-for-review' &&
    readiness !== 'ready-for-handoff'
  )
    throw new CollaborationError('INVALID', 'Design review state has an invalid readiness');
  if (currency !== 'current' && currency !== 'stale' && currency !== 'none')
    throw new CollaborationError('INVALID', 'Design review state has an invalid currency');
  if (typeof value.approvalsStale !== 'boolean')
    throw new CollaborationError('INVALID', 'designReviewState.approvalsStale must be boolean');
  if (!Array.isArray(value.changesSinceBaseline))
    throw new CollaborationError(
      'INVALID',
      'designReviewState.changesSinceBaseline must be an array'
    );
  const baselineValue = value.baseline;
  const baseline =
    baselineValue === undefined
      ? undefined
      : (() => {
          if (!record(baselineValue))
            throw new CollaborationError('INVALID', 'designReviewState.baseline must be an object');
          const intent = baselineValue.intent;
          if (intent !== 'review' && intent !== 'handoff')
            throw new CollaborationError('INVALID', 'Design baseline has an invalid intent');
          const createdAt = readText(
            baselineValue.createdAt,
            'designReviewState.baseline.createdAt'
          );
          timestamp(createdAt, 'designReviewState.baseline.createdAt');
          return {
            id: readText(baselineValue.id, 'designReviewState.baseline.id'),
            projectId: readText(baselineValue.projectId, 'designReviewState.baseline.projectId'),
            revision: readRevisionReference(
              baselineValue.revision,
              'designReviewState.baseline.revision'
            ),
            intent,
            createdBy: readText(baselineValue.createdBy, 'designReviewState.baseline.createdBy'),
            createdAt
          } satisfies DesignBaseline;
        })();
  const changes = value.changesSinceBaseline.map((item, index): SemanticDesignChange => {
    if (!record(item))
      throw new CollaborationError(
        'INVALID',
        `designReviewState.changesSinceBaseline[${index}] must be an object`
      );
    const affected = item.affected;
    const provenance = item.provenance;
    if (!record(affected) || !record(provenance))
      throw new CollaborationError(
        'INVALID',
        'Design review change scope and provenance must be objects'
      );
    const kind = item.kind;
    if (!isSemanticDesignChangeKind(kind))
      throw new CollaborationError('INVALID', 'Design review change has an invalid kind');
    const evidenceValue = item.evidence;
    if (!Array.isArray(evidenceValue))
      throw new CollaborationError('INVALID', 'Design review change evidence must be an array');
    const provenanceKind = provenance.kind;
    const parsedProvenance: DesignChangeProvenance =
      provenanceKind === 'actor'
        ? {
            kind: 'actor',
            actorId: readText(provenance.actorId, 'designReviewState.change.actorId')
          }
        : provenanceKind === 'agent'
          ? {
              kind: 'agent',
              agentId: readText(provenance.agentId, 'designReviewState.change.agentId'),
              promptDigest: readText(
                provenance.promptDigest,
                'designReviewState.change.promptDigest'
              )
            }
          : (() => {
              throw new CollaborationError(
                'INVALID',
                'Design review change has invalid provenance'
              );
            })();
    const occurredAt = readText(item.occurredAt, 'designReviewState.change.occurredAt');
    timestamp(occurredAt, 'designReviewState.change.occurredAt');
    return {
      id: readText(item.id, 'designReviewState.change.id'),
      kind,
      beforeRevision: readRevisionReference(
        item.beforeRevision,
        'designReviewState.change.beforeRevision'
      ),
      currentRevision: readRevisionReference(
        item.currentRevision,
        'designReviewState.change.currentRevision'
      ),
      affected: {
        projectId: readText(affected.projectId, 'designReviewState.change.affected.projectId'),
        screenIds: readStringList(
          affected.screenIds,
          'designReviewState.change.affected.screenIds'
        ),
        routePaths: readStringList(
          affected.routePaths,
          'designReviewState.change.affected.routePaths'
        ),
        scenarioIds: readStringList(
          affected.scenarioIds,
          'designReviewState.change.affected.scenarioIds'
        ),
        componentIds: readStringList(
          affected.componentIds,
          'designReviewState.change.affected.componentIds'
        ),
        stableNodeIds: readStringList(
          affected.stableNodeIds,
          'designReviewState.change.affected.stableNodeIds'
        )
      },
      evidence: evidenceValue.map((evidence, evidenceIndex) => {
        if (!record(evidence))
          throw new CollaborationError(
            'INVALID',
            `designReviewState.change.evidence[${evidenceIndex}] must be an object`
          );
        return {
          description: readText(
            evidence.description,
            'designReviewState.change.evidence.description'
          ),
          ...(evidence.href === undefined
            ? {}
            : { href: readText(evidence.href, 'designReviewState.change.evidence.href') }),
          ...(evidence.checksum === undefined
            ? {}
            : {
                checksum: readText(evidence.checksum, 'designReviewState.change.evidence.checksum')
              })
        };
      }),
      provenance: parsedProvenance,
      reason: readText(item.reason, 'designReviewState.change.reason'),
      occurredAt
    };
  });
  const state: DesignReviewState = {
    format: designReviewStateFormat,
    projectId,
    readiness,
    ...(baseline === undefined ? {} : { baseline }),
    currency,
    approvalsStale: value.approvalsStale,
    changesSinceBaseline: changes
  };
  validateDesignReviewState(state);
  return owned(state, 'Design review state is invalid');
}

/** Validates anchor and content invariants before persistence or synchronization. */
export function validateThreadAnchor(anchor: ThreadAnchor, revision: Revision): void {
  anchor = owned(anchor, 'Thread anchor is invalid');
  revision = owned(revision, 'Revision is invalid');
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
  input = owned(input, 'Comment is invalid');
  requireText(input.body, 'body');
  if (!unique(input.mentionedUserIds)) {
    throw new CollaborationError('INVALID', 'mentionedUserIds must be unique');
  }
}

export interface CollaborationRepository {
  getProject(projectId: string, context?: CollaborationHostContext): Promise<Project | undefined>;
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
  createReviewThread(thread: ReviewThread): Promise<void>;
  getReviewThread(threadId: string): Promise<ReviewThread | undefined>;
  listReviewThreads(
    projectId: string,
    filter?: ReviewThreadFilter
  ): Promise<readonly ReviewThread[]>;
  appendReviewThreadMessage(threadId: string, message: ReviewThreadMessage): Promise<ReviewThread>;
  reactToReviewThreadMessage(
    threadId: string,
    messageId: string,
    emoji: string,
    userId: string
  ): Promise<ReviewThread>;
  setReviewThreadMessageRead(
    threadId: string,
    messageId: string,
    userId: string,
    read: boolean
  ): Promise<ReviewThread>;
  resolveReviewThread(
    threadId: string,
    resolvedBy: string,
    resolvedAt?: string
  ): Promise<ReviewThread>;
  reopenReviewThread(
    threadId: string,
    reopenedBy: string,
    reopenedAt?: string
  ): Promise<ReviewThread>;
  moveReviewThread(
    threadId: string,
    anchor: SpatialAnchor,
    movedBy: string,
    movedAt?: string
  ): Promise<ReviewThread>;
  createAIChangeRequest(request: AIChangeRequest): Promise<void>;
  getAIChangeRequest(requestId: string): Promise<AIChangeRequest | undefined>;
  listAIChangeRequests(projectId: string): Promise<readonly AIChangeRequest[]>;
  updateAIChangeRequest(request: AIChangeRequest): Promise<AIChangeRequest>;
  createDeveloperAnnotation(annotation: DeveloperAnnotation): Promise<void>;
  listDeveloperAnnotations(projectId: string): Promise<readonly DeveloperAnnotation[]>;
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
    limit: number,
    context?: CollaborationHostContext
  ): Promise<readonly CollaborationEvent[]>;
  createShareLink(link: SignedShareLink): Promise<void>;
  getShareLink(
    linkId: string,
    context?: CollaborationHostContext
  ): Promise<SignedShareLink | undefined>;
  revokeShareLink(linkId: string, revokedAt: string): Promise<void>;
  exportProject(projectId: string): Promise<CollaborationSnapshot | undefined>;
  /** Compare-and-swap import guard; omitted only for an unconditional restore. */
  replaceProject(
    snapshot: CollaborationSnapshot,
    options?: {
      readonly expectedLatestRevisionId?: string;
      readonly context?: CollaborationHostContext;
    }
  ): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
  getIdempotency<T>(
    scope: string,
    key: string,
    context?: CollaborationHostContext
  ): Promise<T | undefined>;
  /** Atomically retains the first completed response for this scope/key. */
  putIdempotency<T>(
    scope: string,
    key: string,
    response: T,
    context?: CollaborationHostContext
  ): Promise<T>;
}

/** A small helper so service handlers and sync clients can safely retry writes. */
const inFlightIdempotency = new WeakMap<object, Map<string, Promise<unknown>>>();

export async function idempotent<T>(
  repository: CollaborationRepository,
  scope: string,
  key: string | undefined,
  operation: (context?: CollaborationHostContext) => Promise<T>,
  context?: CollaborationHostContext
): Promise<T> {
  if (key === undefined) return operation(context);
  scope = owned(scope, 'Idempotency scope is invalid');
  requireText(key, 'idempotency key', 256);
  const lockKey = `${scope}\u0000${key}`;
  const locks = inFlightIdempotency.get(repository) ?? new Map<string, Promise<unknown>>();
  inFlightIdempotency.set(repository, locks);
  const active = locks.get(lockKey);
  if (active) return active as Promise<T>;
  const run = (async () => {
    const existing = await (context
      ? callCollaborationHostPort<T | undefined>(context, repository, 'getIdempotency', [
          scope,
          key
        ])
      : repository.getIdempotency<T>(scope, key));
    if (existing !== undefined) return owned(existing, 'Idempotent response is invalid') as T;
    const response = await operation(context);
    const stored = owned(response, 'Idempotent response is invalid') as T;
    return owned(
      await (context
        ? callCollaborationHostPort<T>(context, repository, 'putIdempotency', [scope, key, stored])
        : repository.putIdempotency(scope, key, stored)),
      'Idempotent response is invalid'
    ) as T;
  })();
  locks.set(lockKey, run);
  try {
    return await run;
  } finally {
    if (locks.get(lockKey) === run) locks.delete(lockKey);
  }
}

export interface InMemoryCollaborationRepository extends CollaborationRepository {
  readonly kind: 'in-memory';
}

function draftDesignReviewState(projectId: string): DesignReviewState {
  return {
    format: designReviewStateFormat,
    projectId,
    readiness: 'draft',
    currency: 'none',
    approvalsStale: false,
    changesSinceBaseline: []
  };
}

/** Local/offline adapter. It is suitable for Electron and tests, not multi-process sharing. */
export function createInMemoryCollaborationRepository(): InMemoryCollaborationRepository {
  let projects = new Map<string, Project>();
  let revisions = new Map<string, Revision>();
  let threads = new Map<string, Thread>();
  let reviewThreads = new Map<string, ReviewThread>();
  let aiChangeRequests = new Map<string, AIChangeRequest>();
  let developerAnnotations = new Map<string, DeveloperAnnotation>();
  let comments = new Map<string, Comment>();
  let reactions = new Map<string, Reaction>();
  let approvals = new Map<string, Approval>();
  const audits: AuditEvent[] = [];
  let shareLinks = new Map<string, SignedShareLink>();
  const events: CollaborationEvent[] = [];
  let reviewStates = new Map<string, DesignReviewState>();
  let semanticChanges = new Map<string, SemanticDesignChange>();
  let eventCursor = 0;
  const idempotency = new Map<string, unknown>();
  const key = (scope: string, value: string) => `${scope}\u0000${value}`;
  const clone = <T>(value: T): T => owned(value, 'Repository value is invalid');
  const requireCapacity = <T>(map: ReadonlyMap<string, T>, id: string, field: string): void => {
    if (!map.has(id) && map.size >= collaborationBudgets.maxItems)
      throw new CollaborationError('CONFLICT', `${field} storage is at capacity`);
  };
  const clearProject = (projectId: string): void => {
    const previousState = reviewStates.get(projectId);
    const revisionIds = new Set(
      boundedIterable(revisions.values(), collaborationBudgets.maxItems, 'Stored revisions')
        .filter((revision) => revision.projectId === projectId)
        .map((revision) => revision.id)
    );
    const threadIds = new Set(
      boundedIterable(threads.values(), collaborationBudgets.maxItems, 'Stored threads')
        .filter((thread) => thread.projectId === projectId)
        .map((thread) => thread.id)
    );
    const commentIds = new Set(
      boundedIterable(comments.values(), collaborationBudgets.maxItems, 'Stored comments')
        .filter((comment) => threadIds.has(comment.threadId))
        .map((comment) => comment.id)
    );
    projects.delete(projectId);
    reviewStates.delete(projectId);
    for (const change of previousState?.changesSinceBaseline ?? [])
      semanticChanges.delete(change.id);
    for (const id of revisionIds) revisions.delete(id);
    for (const id of threadIds) threads.delete(id);
    for (const id of commentIds) comments.delete(id);
    for (const [reactionId, reaction] of reactions)
      if (commentIds.has(reaction.commentId)) reactions.delete(reactionId);
    for (const [approvalId, approval] of approvals)
      if (revisionIds.has(approval.revisionId)) approvals.delete(approvalId);
    for (const [id, thread] of reviewThreads)
      if (thread.projectId === projectId) reviewThreads.delete(id);
    for (const [id, request] of aiChangeRequests)
      if (request.projectId === projectId) aiChangeRequests.delete(id);
    for (const [id, annotation] of developerAnnotations)
      if (annotation.projectId === projectId) developerAnnotations.delete(id);
    // Share grants are durable project credentials, intentionally outside the
    // portable snapshot. A same-project sync must not silently revoke them.
    // Events are append-only audit history. Never rewrite cursors while
    // replacing or deleting a materialized project projection.
  };

  return {
    kind: 'in-memory',
    async getProject(id) {
      const project = projects.get(id);
      return project === undefined ? undefined : clone(project);
    },
    async getRevision(id) {
      const revision = revisions.get(id);
      return revision === undefined ? undefined : clone(revision);
    },
    async getLatestRevision(projectId) {
      const revision = boundedIterable(
        revisions.values(),
        collaborationBudgets.maxItems,
        'Stored revisions'
      )
        .filter((candidate) => candidate.projectId === projectId)
        .sort(
          (left, right) => right.sequence - left.sequence || right.id.localeCompare(left.id, 'en')
        )[0];
      return revision === undefined ? undefined : clone(revision);
    },
    async getDesignReviewState(projectId) {
      if (!projects.has(projectId)) return undefined;
      return clone(reviewStates.get(projectId) ?? draftDesignReviewState(projectId));
    },
    async createProject(project) {
      project = clone(project);
      if (projects.has(project.id))
        throw new CollaborationError('DUPLICATE', 'Project already exists');
      requireCapacity(projects, project.id, 'Projects');
      projects.set(project.id, project);
    },
    async appendRevision(revision, expectedParentRevisionId) {
      revision = clone(revision);
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
      requireCapacity(revisions, revision.id, 'Revisions');
      revisions.set(revision.id, revision);
    },
    async commitDesignRevision(input) {
      input = clone(input);
      if (input.idempotencyKey !== undefined) {
        requireText(input.idempotencyKey, 'idempotency key', 256);
        const scope = input.idempotencyScope ?? `design:${input.actorId}:${input.projectId}`;
        const existing = idempotency.get(key(scope, input.idempotencyKey));
        if (existing !== undefined)
          return { ...(clone(existing) as CommitDesignRevisionResult), replayed: true };
      }
      if (!projects.has(input.projectId))
        throw new CollaborationError('NOT_FOUND', 'Project not found');
      const revision = input.kind === 'mark-ready' ? undefined : input.revision;
      const readiness = input.kind === 'append-revision' ? undefined : input.readiness;
      const semanticChange = input.kind === 'append-revision' ? input.semanticChange : undefined;
      const expectedParentRevisionId =
        input.kind === 'mark-ready' ? undefined : input.expectedParentRevisionId;
      if (revision && revision.projectId !== input.projectId)
        throw new CollaborationError('INVALID', 'Revision must belong to the project');
      if (readiness) {
        const readinessRevision =
          readiness.revisionId === revision?.id ? revision : revisions.get(readiness.revisionId);
        if (!readinessRevision || readinessRevision.projectId !== input.projectId)
          throw new CollaborationError('INVALID', 'Baseline revision must belong to the project');
        if (readinessRevision.contentSha256 !== readiness.revisionFingerprint)
          throw new CollaborationError(
            'INVALID',
            'Baseline fingerprint must match the immutable revision'
          );
      }
      const before = await this.getLatestRevision(input.projectId);
      const state = reviewStates.get(input.projectId) ?? draftDesignReviewState(input.projectId);
      const hadBaseline = state.baseline !== undefined && readiness === undefined;
      if (!hadBaseline && revision && semanticChange)
        throw new CollaborationError(
          'INVALID',
          'Semantic design changes require an active baseline'
        );
      if (hadBaseline && revision && !semanticChange) {
        throw new CollaborationError(
          'INVALID',
          'Design-affecting revisions after a baseline require semantic change metadata'
        );
      }
      if (semanticChange) {
        const change = semanticChange;
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
      if (revision) {
        if (revisions.has(revision.id))
          throw new CollaborationError('DUPLICATE', 'Revision already exists');
        if (before?.id !== expectedParentRevisionId)
          throw new CollaborationError('CONFLICT', 'Revision parent is no longer current');
        if (revision.sequence !== (before?.sequence ?? 0) + 1)
          throw new CollaborationError(
            'CONFLICT',
            'Revision sequence is not the next immutable revision'
          );
        requireCapacity(revisions, revision.id, 'Revisions');
        revisions.set(revision.id, revision);
      }
      if (readiness) {
        if (
          boundedIterable(
            reviewStates.values(),
            collaborationBudgets.maxItems,
            'Stored review states'
          ).some((candidate) => candidate.baseline?.id === readiness.id)
        )
          throw new CollaborationError('DUPLICATE', 'Design baseline already exists');
        const readinessRevision = revision ?? revisions.get(readiness.revisionId);
        if (!readinessRevision || readinessRevision.projectId !== input.projectId)
          throw new CollaborationError('INVALID', 'Baseline revision must belong to the project');
        reviewStates.set(input.projectId, {
          format: designReviewStateFormat,
          projectId: input.projectId,
          readiness: readiness.intent === 'review' ? 'ready-for-review' : 'ready-for-handoff',
          baseline: {
            id: readiness.id,
            projectId: input.projectId,
            revision: { id: readinessRevision.id, fingerprint: readinessRevision.contentSha256 },
            intent: readiness.intent,
            createdBy: input.actorId,
            createdAt: input.occurredAt
          },
          currency: 'current',
          approvalsStale: false,
          changesSinceBaseline: []
        });
      }
      if (hadBaseline && revision && semanticChange && before) {
        const change: SemanticDesignChange = {
          ...semanticChange,
          beforeRevision: { id: before.id, fingerprint: before.contentSha256 },
          currentRevision: { id: revision.id, fingerprint: revision.contentSha256 },
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
      let result: CommitDesignRevisionResult;
      if (revision) {
        result = readiness
          ? { kind: 'revision-and-readiness', revision, readiness, replayed: false }
          : { kind: 'revision', revision, changeRecorded: hadBaseline, replayed: false };
      } else {
        if (!readiness) throw new CollaborationError('INVALID', 'Readiness transition is required');
        result = { kind: 'readiness', readiness, replayed: false };
      }
      if (input.idempotencyKey !== undefined) {
        const scope = input.idempotencyScope ?? `design:${input.actorId}:${input.projectId}`;
        const id = key(scope, input.idempotencyKey);
        requireCapacity(idempotency, id, 'Idempotency');
        idempotency.set(id, clone(result));
      }
      return result;
    },
    async createReviewThread(thread) {
      thread = clone(thread);
      if (reviewThreads.has(thread.id))
        throw new CollaborationError('DUPLICATE', 'Review thread already exists');
      const revision = revisions.get(thread.anchor.evidence.revisionId);
      if (!revision || revision.projectId !== thread.projectId)
        throw new CollaborationError(
          'NOT_FOUND',
          'Review thread revision was not found in this project'
        );
      validateSpatialAnchor(thread.anchor, revision);
      validateReviewThread(thread);
      requireCapacity(reviewThreads, thread.id, 'Review threads');
      reviewThreads.set(thread.id, clone(thread));
    },
    async getReviewThread(id) {
      const thread = reviewThreads.get(id);
      return thread === undefined ? undefined : clone(thread);
    },
    async listReviewThreads(projectId, filter) {
      const unreadFor = filter?.unreadFor;
      return clone(
        boundedIterable(
          reviewThreads.values(),
          collaborationBudgets.maxItems,
          'Stored review threads'
        )
          .filter(
            (thread) =>
              thread.projectId === projectId &&
              (filter?.lifecycle === undefined || thread.lifecycle === filter.lifecycle) &&
              (filter?.revisionId === undefined ||
                thread.anchor.evidence.revisionId === filter.revisionId) &&
              (filter?.deepLink === undefined || thread.deepLink === filter.deepLink) &&
              (filter?.screenId === undefined ||
                thread.anchor.evidence.screenId === filter.screenId) &&
              (filter?.stateId === undefined ||
                thread.anchor.evidence.stateId === filter.stateId) &&
              (filter?.createdBy === undefined || thread.createdBy === filter.createdBy) &&
              (unreadFor === undefined ||
                thread.messages.some((message) => !message.readBy.includes(unreadFor)))
          )
          .map(clone)
          .sort(stableByCreation)
      );
    },
    async appendReviewThreadMessage(id, message) {
      message = clone(message);
      const thread = reviewThreads.get(id);
      if (!thread) throw new CollaborationError('NOT_FOUND', 'Review thread not found');
      const updated = { ...thread, messages: [...thread.messages, message] };
      validateReviewThread(updated);
      reviewThreads.set(id, clone(updated));
      return clone(updated);
    },
    async reactToReviewThreadMessage(id, messageId, emoji, userId) {
      const thread = reviewThreads.get(id);
      if (!thread) throw new CollaborationError('NOT_FOUND', 'Review thread not found');
      let found = false;
      const updated = {
        ...thread,
        messages: thread.messages.map((message) => {
          if (message.id !== messageId) return message;
          found = true;
          const reaction = message.reactions.find((item) => item.emoji === emoji);
          const nextReactions = reaction
            ? message.reactions.map((item) =>
                item.emoji === emoji
                  ? { ...item, userIds: [...new Set([...item.userIds, userId])] }
                  : item
              )
            : [...message.reactions, { emoji, userIds: [userId] }];
          return { ...message, reactions: nextReactions };
        })
      };
      if (!found) throw new CollaborationError('NOT_FOUND', 'Review message not found');
      validateReviewThread(updated);
      reviewThreads.set(id, clone(updated));
      return clone(updated);
    },
    async setReviewThreadMessageRead(id, messageId, userId, read) {
      const thread = reviewThreads.get(id);
      if (!thread) throw new CollaborationError('NOT_FOUND', 'Review thread not found');
      let found = false;
      const updated = {
        ...thread,
        messages: thread.messages.map((message) => {
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
      reviewThreads.set(id, clone(updated));
      return clone(updated);
    },
    async resolveReviewThread(id, resolvedBy, resolvedAt) {
      const thread = reviewThreads.get(id);
      if (!thread) throw new CollaborationError('NOT_FOUND', 'Review thread not found');
      if (thread.lifecycle === 'resolved')
        throw new CollaborationError('CONFLICT', 'Review thread is already resolved');
      const updated = {
        ...thread,
        lifecycle: 'resolved' as const,
        resolvedBy,
        resolvedAt: resolvedAt ?? new Date().toISOString()
      };
      validateReviewThread(updated);
      reviewThreads.set(id, clone(updated));
      return clone(updated);
    },
    async reopenReviewThread(id, reopenedBy, reopenedAt) {
      const thread = reviewThreads.get(id);
      if (!thread) throw new CollaborationError('NOT_FOUND', 'Review thread not found');
      if (thread.lifecycle !== 'resolved')
        throw new CollaborationError('CONFLICT', 'Review thread is already open');
      if (thread.resolvedAt === undefined)
        throw new CollaborationError('INVALID', 'Resolved review thread is missing its timestamp');
      const reopeningTimestamp = reopenedAt ?? new Date().toISOString();
      if (Date.parse(reopeningTimestamp) <= Date.parse(thread.resolvedAt))
        throw new CollaborationError(
          'INVALID',
          'Review thread reopening must be later than its resolution'
        );
      const { resolvedAt: _resolvedAt, resolvedBy: _resolvedBy, ...open } = thread;
      const updated = {
        ...open,
        lifecycle: 'open' as const,
        reopenedBy,
        reopenedAt: reopeningTimestamp
      };
      validateReviewThread(updated);
      reviewThreads.set(id, clone(updated));
      return clone(updated);
    },
    async moveReviewThread(id, anchor, movedBy, movedAt) {
      anchor = clone(anchor);
      const thread = reviewThreads.get(id);
      if (!thread) throw new CollaborationError('NOT_FOUND', 'Review thread not found');
      const revision = revisions.get(anchor.evidence.revisionId);
      if (!revision || revision.projectId !== thread.projectId)
        throw new CollaborationError(
          'NOT_FOUND',
          'Review thread revision was not found in this project'
        );
      validateSpatialAnchor(anchor, revision);
      const updated = { ...thread, anchor, movedBy, movedAt: movedAt ?? new Date().toISOString() };
      validateReviewThread(updated);
      reviewThreads.set(id, clone(updated));
      return clone(updated);
    },
    async createAIChangeRequest(request) {
      request = clone(request);
      if (aiChangeRequests.has(request.id))
        throw new CollaborationError('DUPLICATE', 'AI change request already exists');
      const revision = revisions.get(request.baseRevision.id);
      if (!revision || revision.projectId !== request.projectId)
        throw new CollaborationError(
          'NOT_FOUND',
          'AI change request revision was not found in this project'
        );
      validateAIChangeRequest(request, revision);
      validateAIChangeRequestResultReferences(request, revisions.values());
      requireCapacity(aiChangeRequests, request.id, 'AI change requests');
      aiChangeRequests.set(request.id, clone(request));
    },
    async getAIChangeRequest(id) {
      const request = aiChangeRequests.get(id);
      return request === undefined ? undefined : clone(request);
    },
    async listAIChangeRequests(projectId) {
      return clone(
        boundedIterable(
          aiChangeRequests.values(),
          collaborationBudgets.maxItems,
          'Stored AI change requests'
        )
          .filter((request) => request.projectId === projectId)
          .map(clone)
          .sort(
            (left, right) =>
              left.updatedAt.localeCompare(right.updatedAt, 'en') ||
              left.id.localeCompare(right.id, 'en')
          )
      );
    },
    async updateAIChangeRequest(request) {
      request = clone(request);
      const existing = aiChangeRequests.get(request.id);
      if (!existing) throw new CollaborationError('NOT_FOUND', 'AI change request not found');
      if (
        existing.projectId !== request.projectId ||
        existing.createdAt !== request.createdAt ||
        existing.createdBy !== request.createdBy
      )
        throw new CollaborationError('INVALID', 'AI change request identity is immutable');
      const revision = revisions.get(request.baseRevision.id);
      if (!revision || revision.projectId !== request.projectId)
        throw new CollaborationError(
          'NOT_FOUND',
          'AI change request revision was not found in this project'
        );
      validateAIChangeRequest(request, revision);
      validateAIChangeRequestResultReferences(request, revisions.values());
      validateAIChangeRequestTransition(existing, request);
      aiChangeRequests.set(request.id, clone(request));
      return clone(request);
    },
    async createDeveloperAnnotation(annotation) {
      annotation = clone(annotation);
      if (developerAnnotations.has(annotation.id))
        throw new CollaborationError('DUPLICATE', 'Developer annotation already exists');
      const revision = revisions.get(annotation.anchor.evidence.revisionId);
      if (!revision || revision.projectId !== annotation.projectId)
        throw new CollaborationError(
          'NOT_FOUND',
          'Developer annotation revision was not found in this project'
        );
      validateDeveloperAnnotation(annotation, revision);
      requireCapacity(developerAnnotations, annotation.id, 'Developer annotations');
      developerAnnotations.set(annotation.id, clone(annotation));
    },
    async listDeveloperAnnotations(projectId) {
      return clone(
        boundedIterable(
          developerAnnotations.values(),
          collaborationBudgets.maxItems,
          'Stored developer annotations'
        )
          .filter((annotation) => annotation.projectId === projectId)
          .map(clone)
          .sort(stableByCreation)
      );
    },
    async createThread(thread) {
      thread = clone(thread);
      if (threads.has(thread.id))
        throw new CollaborationError('DUPLICATE', 'Thread already exists');
      const revision = revisions.get(thread.revisionId);
      if (!revision || revision.projectId !== thread.projectId) {
        throw new CollaborationError('NOT_FOUND', 'Thread revision was not found in this project');
      }
      validateThreadAnchor(thread, revision);
      requireCapacity(threads, thread.id, 'Threads');
      threads.set(thread.id, clone(thread));
    },
    async getThread(id) {
      const thread = threads.get(id);
      return thread === undefined ? undefined : clone(thread);
    },
    async updateThreadResolution(id, resolvedBy, resolvedAt) {
      const thread = threads.get(id);
      if (!thread) throw new CollaborationError('NOT_FOUND', 'Thread not found');
      const updated = { ...thread, resolvedBy, resolvedAt: resolvedAt ?? new Date().toISOString() };
      threads.set(id, clone(updated));
      return clone(updated);
    },
    async createComment(comment) {
      comment = clone(comment);
      if (comments.has(comment.id))
        throw new CollaborationError('DUPLICATE', 'Comment already exists');
      if (!threads.has(comment.threadId))
        throw new CollaborationError('NOT_FOUND', 'Thread not found');
      if (comment.parentCommentId && !comments.has(comment.parentCommentId)) {
        throw new CollaborationError('NOT_FOUND', 'Parent comment not found');
      }
      if (
        comment.parentCommentId &&
        comments.get(comment.parentCommentId)?.threadId !== comment.threadId
      ) {
        throw new CollaborationError('INVALID', 'Parent comment must belong to the same thread');
      }
      validateCommentInput(comment);
      requireCapacity(comments, comment.id, 'Comments');
      comments.set(comment.id, clone(comment));
    },
    async getComment(id) {
      const comment = comments.get(id);
      return comment === undefined ? undefined : clone(comment);
    },
    async addReaction(reaction) {
      reaction = clone(reaction);
      if (!comments.has(reaction.commentId))
        throw new CollaborationError('NOT_FOUND', 'Comment not found');
      requireText(reaction.emoji, 'emoji', 64);
      const reactionId = key(reaction.commentId, `${reaction.userId}:${reaction.emoji}`);
      requireCapacity(reactions, reactionId, 'Reactions');
      reactions.set(reactionId, clone(reaction));
    },
    async putApproval(approval) {
      approval = clone(approval);
      if (!revisions.has(approval.revisionId))
        throw new CollaborationError('NOT_FOUND', 'Revision not found');
      const approvalId = key(approval.revisionId, approval.userId);
      requireCapacity(approvals, approvalId, 'Approvals');
      approvals.set(approvalId, clone(approval));
    },
    async appendAudit(event) {
      if (audits.length >= collaborationBudgets.maxItems)
        throw new CollaborationError('CONFLICT', 'Audit storage is at capacity');
      audits.push(clone(event));
    },
    async appendEvent(event) {
      event = clone(event);
      if (events.length >= collaborationBudgets.maxItems)
        throw new CollaborationError('CONFLICT', 'Event storage is at capacity');
      const stored = clone({ ...event, cursor: ++eventCursor });
      events.push(stored);
      return clone(stored);
    },
    async listEvents(projectId, afterCursor, limit) {
      return clone(
        events
          .filter((event) => event.projectId === projectId && event.cursor > afterCursor)
          .slice(0, limit)
          .map(clone)
          .sort(
            (left, right) => left.cursor - right.cursor || left.id.localeCompare(right.id, 'en')
          )
      );
    },
    async createShareLink(link) {
      link = clone(link);
      if (shareLinks.has(link.id))
        throw new CollaborationError('DUPLICATE', 'Share link already exists');
      requireCapacity(shareLinks, link.id, 'Share links');
      shareLinks.set(link.id, clone(link));
    },
    async getShareLink(linkId) {
      const link = shareLinks.get(linkId);
      return link === undefined ? undefined : clone(link);
    },
    async revokeShareLink(linkId, revokedAt) {
      const link = shareLinks.get(linkId);
      if (!link) throw new CollaborationError('NOT_FOUND', 'Share link not found');
      shareLinks.set(linkId, clone({ ...link, revokedAt }));
    },
    async exportProject(projectId) {
      const project = projects.get(projectId);
      if (!project) return undefined;
      const allRevisions = boundedIterable(
        revisions.values(),
        collaborationBudgets.maxItems,
        'Stored revisions'
      );
      const allThreads = boundedIterable(
        threads.values(),
        collaborationBudgets.maxItems,
        'Stored threads'
      );
      const allComments = boundedIterable(
        comments.values(),
        collaborationBudgets.maxItems,
        'Stored comments'
      );
      const revisionIds = new Set(
        allRevisions
          .filter((revision) => revision.projectId === projectId)
          .map((revision) => revision.id)
      );
      const projectThreads = allThreads.filter((thread) => thread.projectId === projectId);
      const threadIds = new Set(projectThreads.map((thread) => thread.id));
      const projectComments = allComments.filter((comment) => threadIds.has(comment.threadId));
      const commentIds = new Set(projectComments.map((comment) => comment.id));
      const designReviewState = reviewStates.get(projectId);
      return clone({
        format: collaborationFormat,
        project,
        revisions: allRevisions.filter((item) => item.projectId === projectId),
        threads: projectThreads,
        comments: projectComments,
        reactions: boundedIterable(
          reactions.values(),
          collaborationBudgets.maxItems,
          'Stored reactions'
        ).filter((item) => commentIds.has(item.commentId)),
        approvals: boundedIterable(
          approvals.values(),
          collaborationBudgets.maxItems,
          'Stored approvals'
        ).filter((item) => revisionIds.has(item.revisionId)),
        reviewThreads: boundedIterable(
          reviewThreads.values(),
          collaborationBudgets.maxItems,
          'Stored review threads'
        ).filter((item) => item.projectId === projectId),
        aiChangeRequests: boundedIterable(
          aiChangeRequests.values(),
          collaborationBudgets.maxItems,
          'Stored AI change requests'
        ).filter((item) => item.projectId === projectId),
        developerAnnotations: boundedIterable(
          developerAnnotations.values(),
          collaborationBudgets.maxItems,
          'Stored developer annotations'
        ).filter((item) => item.projectId === projectId),
        ...(designReviewState ? { designReviewState } : {})
      });
    },
    async replaceProject(snapshot, options) {
      snapshot = clone(snapshot);
      if (snapshot.format !== collaborationFormat)
        throw new CollaborationError('INVALID', 'Unsupported snapshot');
      validateCollaborationSnapshot(snapshot);
      if (snapshot.designReviewState) validateDesignReviewState(snapshot.designReviewState);
      const projectId = snapshot.project.id;
      const existingLatest = boundedIterable(
        revisions.values(),
        collaborationBudgets.maxItems,
        'Stored revisions'
      )
        .filter((revision) => revision.projectId === projectId)
        .sort(
          (left, right) => right.sequence - left.sequence || right.id.localeCompare(left.id, 'en')
        )[0];
      if (
        options?.expectedLatestRevisionId !== undefined &&
        existingLatest?.id !== options.expectedLatestRevisionId
      )
        throw new CollaborationError('CONFLICT', 'Project revision is no longer current');
      const storedRevisions = boundedIterable(
        revisions.values(),
        collaborationBudgets.maxItems,
        'Stored revisions'
      );
      const storedThreads = boundedIterable(
        threads.values(),
        collaborationBudgets.maxItems,
        'Stored threads'
      );
      const storedComments = boundedIterable(
        comments.values(),
        collaborationBudgets.maxItems,
        'Stored comments'
      );
      const revisionProject = new Map(storedRevisions.map((value) => [value.id, value.projectId]));
      const threadProject = new Map(storedThreads.map((value) => [value.id, value.projectId]));
      const commentProject = new Map(
        storedComments.map((value) => [value.id, threadProject.get(value.threadId)])
      );
      const rejectCollision = (
        values: readonly { readonly id: string }[],
        stored: ReadonlyMap<string, unknown>,
        owner: (id: string) => string | undefined,
        field: string
      ): void => {
        for (const value of values) {
          if (stored.has(value.id) && owner(value.id) !== projectId)
            throw new CollaborationError(
              'CONFLICT',
              `Snapshot ${field} identifier belongs to another project`
            );
        }
      };
      rejectCollision(snapshot.revisions, revisions, (id) => revisionProject.get(id), 'revision');
      rejectCollision(snapshot.threads, threads, (id) => threadProject.get(id), 'thread');
      rejectCollision(snapshot.comments, comments, (id) => commentProject.get(id), 'comment');
      rejectCollision(
        snapshot.reviewThreads,
        reviewThreads,
        (id) => reviewThreads.get(id)?.projectId,
        'review thread'
      );
      rejectCollision(
        snapshot.aiChangeRequests,
        aiChangeRequests,
        (id) => aiChangeRequests.get(id)?.projectId,
        'AI change request'
      );
      rejectCollision(
        snapshot.developerAnnotations,
        developerAnnotations,
        (id) => developerAnnotations.get(id)?.projectId,
        'developer annotation'
      );
      for (const value of snapshot.reactions) {
        const existing = reactions.get(key(value.commentId, `${value.userId}:${value.emoji}`));
        if (existing && commentProject.get(existing.commentId) !== projectId)
          throw new CollaborationError('CONFLICT', 'Snapshot reaction belongs to another project');
      }
      for (const value of snapshot.approvals) {
        const existing = approvals.get(key(value.revisionId, value.userId));
        if (existing && revisionProject.get(existing.revisionId) !== projectId)
          throw new CollaborationError('CONFLICT', 'Snapshot approval belongs to another project');
      }

      const keep = <T>(
        values: ReadonlyMap<string, T>,
        belongs: (value: T) => boolean
      ): Map<string, T> =>
        new Map(
          boundedIterable(values.entries(), collaborationBudgets.maxItems, 'Stored records').filter(
            ([, value]) => !belongs(value)
          )
        );
      const nextProjects = new Map(projects);
      nextProjects.set(projectId, clone(snapshot.project));
      const nextRevisions = keep(revisions, (value) => value.projectId === projectId);
      const nextThreads = keep(threads, (value) => value.projectId === projectId);
      const nextComments = keep(
        comments,
        (value) => threadProject.get(value.threadId) === projectId
      );
      const nextReactions = keep(
        reactions,
        (value) => commentProject.get(value.commentId) === projectId
      );
      const nextApprovals = keep(
        approvals,
        (value) => revisionProject.get(value.revisionId) === projectId
      );
      const nextReviewThreads = keep(reviewThreads, (value) => value.projectId === projectId);
      const nextRequests = keep(aiChangeRequests, (value) => value.projectId === projectId);
      const nextAnnotations = keep(developerAnnotations, (value) => value.projectId === projectId);
      const nextShares = new Map(shareLinks);
      const nextStates = new Map(reviewStates);
      const previousState = nextStates.get(projectId);
      nextStates.delete(projectId);
      const nextChanges = new Map(semanticChanges);
      for (const change of previousState?.changesSinceBaseline ?? []) nextChanges.delete(change.id);

      for (const value of snapshot.revisions) nextRevisions.set(value.id, clone(value));
      for (const value of snapshot.threads) nextThreads.set(value.id, clone(value));
      for (const value of snapshot.comments) nextComments.set(value.id, clone(value));
      for (const value of snapshot.reactions)
        nextReactions.set(key(value.commentId, `${value.userId}:${value.emoji}`), clone(value));
      for (const value of snapshot.approvals)
        nextApprovals.set(key(value.revisionId, value.userId), clone(value));
      for (const value of snapshot.reviewThreads) nextReviewThreads.set(value.id, clone(value));
      for (const value of snapshot.aiChangeRequests) nextRequests.set(value.id, clone(value));
      for (const value of snapshot.developerAnnotations)
        nextAnnotations.set(value.id, clone(value));
      if (snapshot.designReviewState) {
        if (snapshot.designReviewState.projectId !== projectId)
          throw new CollaborationError(
            'INVALID',
            'Design review state must belong to the snapshot project'
          );
        nextStates.set(projectId, clone(snapshot.designReviewState));
        for (const change of snapshot.designReviewState.changesSinceBaseline) {
          if (nextChanges.has(change.id))
            throw new CollaborationError(
              'CONFLICT',
              'Snapshot semantic change identifier belongs to another project'
            );
          nextChanges.set(change.id, clone(change));
        }
      }
      for (const [field, values] of Object.entries({
        projects: nextProjects,
        revisions: nextRevisions,
        threads: nextThreads,
        comments: nextComments,
        reactions: nextReactions,
        approvals: nextApprovals,
        reviewThreads: nextReviewThreads,
        aiChangeRequests: nextRequests,
        developerAnnotations: nextAnnotations,
        shareLinks: nextShares,
        reviewStates: nextStates,
        semanticChanges: nextChanges
      })) {
        if (values.size > collaborationBudgets.maxItems)
          throw new CollaborationError('CONFLICT', `${field} storage is at capacity`);
      }
      // No await or fallible work occurs after preflight: swapping the maps is
      // one synchronous, all-or-nothing projection update.
      projects = nextProjects;
      revisions = nextRevisions;
      threads = nextThreads;
      comments = nextComments;
      reactions = nextReactions;
      approvals = nextApprovals;
      reviewThreads = nextReviewThreads;
      aiChangeRequests = nextRequests;
      developerAnnotations = nextAnnotations;
      shareLinks = nextShares;
      reviewStates = nextStates;
      semanticChanges = nextChanges;
    },
    async deleteProject(projectId) {
      if (!projects.has(projectId)) return;
      clearProject(projectId);
    },
    async getIdempotency<T>(scope: string, value: string) {
      const stored = idempotency.get(key(scope, value));
      return stored === undefined ? undefined : (clone(stored) as T);
    },
    async putIdempotency<T>(scope: string, value: string, response: T) {
      const id = key(scope, value);
      const existing = idempotency.get(id);
      if (existing !== undefined) return clone(existing) as T;
      requireCapacity(idempotency, id, 'Idempotency');
      const stored = clone(response);
      idempotency.set(id, stored);
      return clone(stored) as T;
    }
  };
}

export function serializeSnapshot(snapshot: CollaborationSnapshot): string {
  snapshot = owned(snapshot, 'Collaboration snapshot is invalid');
  validateCollaborationSnapshot(snapshot);
  try {
    return `${JSON.stringify(snapshot, null, 2)}\n`;
  } catch {
    throw new CollaborationError('INVALID', 'Collaboration snapshot is not serializable');
  }
}

function snapshotRecord(value: unknown, field: string): Record<string, unknown> {
  if (!record(value)) throw new CollaborationError('INVALID', `${field} must be an object`);
  return value;
}

function snapshotText(value: unknown, field: string): string {
  return readText(value, field);
}

function snapshotOptionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : snapshotText(value, field);
}

function snapshotTimestamp(value: unknown, field: string): string {
  const parsed = snapshotText(value, field);
  timestamp(parsed, field);
  return parsed;
}

function parseSnapshotEvidence(value: unknown, field: string): RevisionEvidence {
  const source = snapshotRecord(value, field);
  const viewport = snapshotRecord(source.viewport, `${field}.viewport`);
  const parsed: RevisionEvidence = {
    artifactId: snapshotText(source.artifactId, `${field}.artifactId`),
    screenId: snapshotText(source.screenId, `${field}.screenId`),
    revisionId: snapshotText(source.revisionId, `${field}.revisionId`),
    revisionFingerprint: snapshotText(source.revisionFingerprint, `${field}.revisionFingerprint`),
    viewport: {
      width: Number(viewport.width),
      height: Number(viewport.height),
      zoom: Number(viewport.zoom)
    }
  };
  if (
    !Number.isFinite(parsed.viewport.width) ||
    !Number.isFinite(parsed.viewport.height) ||
    !Number.isFinite(parsed.viewport.zoom)
  )
    throw new CollaborationError('INVALID', `${field}.viewport must contain finite numbers`);
  const scenarioId = snapshotOptionalText(source.scenarioId, `${field}.scenarioId`);
  const stateId = snapshotOptionalText(source.stateId, `${field}.stateId`);
  const nodeId = snapshotOptionalText(source.nodeId, `${field}.nodeId`);
  const sourceRef = snapshotOptionalText(source.sourceRef, `${field}.sourceRef`);
  return {
    ...parsed,
    ...(scenarioId === undefined ? {} : { scenarioId }),
    ...(stateId === undefined ? {} : { stateId }),
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(sourceRef === undefined ? {} : { sourceRef })
  };
}

function parseSnapshotAnchor(value: unknown, field: string): SpatialAnchor {
  const source = snapshotRecord(value, field);
  const target = snapshotRecord(source.target, `${field}.target`);
  const lifecycle = source.lifecycle;
  if (
    lifecycle !== 'current' &&
    lifecycle !== 'mapped' &&
    lifecycle !== 'stale' &&
    lifecycle !== 'orphaned'
  )
    throw new CollaborationError('INVALID', `${field}.lifecycle is invalid`);
  const common = {
    evidence: parseSnapshotEvidence(source.evidence, `${field}.evidence`),
    lifecycle,
    ...(source.mappedFrom === undefined
      ? {}
      : { mappedFrom: parseSnapshotEvidence(source.mappedFrom, `${field}.mappedFrom`) })
  } as const;
  if (target.kind === 'point') {
    const point = snapshotRecord(target.point, `${field}.target.point`);
    return {
      ...common,
      target: { kind: 'point', point: { x: Number(point.x), y: Number(point.y) } }
    };
  }
  if (target.kind === 'region') {
    const region = snapshotRecord(target.region, `${field}.target.region`);
    return {
      ...common,
      target: {
        kind: 'region',
        region: {
          x: Number(region.x),
          y: Number(region.y),
          width: Number(region.width),
          height: Number(region.height)
        }
      }
    };
  }
  throw new CollaborationError('INVALID', `${field}.target.kind is invalid`);
}

function parseSnapshotMessage(value: unknown, field: string): ReviewThreadMessage {
  const source = snapshotRecord(value, field);
  if (!Array.isArray(source.reactions))
    throw new CollaborationError('INVALID', `${field}.reactions must be an array`);
  const parentMessageId = snapshotOptionalText(source.parentMessageId, `${field}.parentMessageId`);
  return {
    id: snapshotText(source.id, `${field}.id`),
    body: snapshotText(source.body, `${field}.body`),
    createdBy: snapshotText(source.createdBy, `${field}.createdBy`),
    createdAt: snapshotTimestamp(source.createdAt, `${field}.createdAt`),
    ...(parentMessageId === undefined ? {} : { parentMessageId }),
    mentionedUserIds: readStringList(source.mentionedUserIds, `${field}.mentionedUserIds`),
    reactions: source.reactions.map((reaction, index) => {
      const item = snapshotRecord(reaction, `${field}.reactions[${index}]`);
      return {
        emoji: snapshotText(item.emoji, `${field}.reactions[${index}].emoji`),
        userIds: readStringList(item.userIds, `${field}.reactions[${index}].userIds`)
      };
    }),
    readBy: readStringList(source.readBy, `${field}.readBy`)
  };
}

function parseSnapshotReviewThread(value: unknown, field: string): ReviewThread {
  const source = snapshotRecord(value, field);
  if (!Array.isArray(source.messages))
    throw new CollaborationError('INVALID', `${field}.messages must be an array`);
  const lifecycle = source.lifecycle;
  if (lifecycle !== 'open' && lifecycle !== 'resolved')
    throw new CollaborationError('INVALID', `${field}.lifecycle is invalid`);
  const resolvedAt =
    source.resolvedAt === undefined
      ? undefined
      : snapshotTimestamp(source.resolvedAt, `${field}.resolvedAt`);
  const resolvedBy = snapshotOptionalText(source.resolvedBy, `${field}.resolvedBy`);
  const reopenedAt =
    source.reopenedAt === undefined
      ? undefined
      : snapshotTimestamp(source.reopenedAt, `${field}.reopenedAt`);
  const reopenedBy = snapshotOptionalText(source.reopenedBy, `${field}.reopenedBy`);
  const movedAt =
    source.movedAt === undefined
      ? undefined
      : snapshotTimestamp(source.movedAt, `${field}.movedAt`);
  const movedBy = snapshotOptionalText(source.movedBy, `${field}.movedBy`);
  return {
    id: snapshotText(source.id, `${field}.id`),
    projectId: snapshotText(source.projectId, `${field}.projectId`),
    anchor: parseSnapshotAnchor(source.anchor, `${field}.anchor`),
    messages: source.messages.map((message, index) =>
      parseSnapshotMessage(message, `${field}.messages[${index}]`)
    ),
    deepLink: snapshotText(source.deepLink, `${field}.deepLink`),
    lifecycle,
    createdBy: snapshotText(source.createdBy, `${field}.createdBy`),
    createdAt: snapshotTimestamp(source.createdAt, `${field}.createdAt`),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    ...(resolvedBy === undefined ? {} : { resolvedBy }),
    ...(reopenedAt === undefined ? {} : { reopenedAt }),
    ...(reopenedBy === undefined ? {} : { reopenedBy }),
    ...(movedAt === undefined ? {} : { movedAt }),
    ...(movedBy === undefined ? {} : { movedBy })
  };
}

function parseSnapshotRevision(value: unknown, field: string): Revision {
  const source = snapshotRecord(value, field);
  const parentRevisionId = snapshotOptionalText(
    source.parentRevisionId,
    `${field}.parentRevisionId`
  );
  const sequence = source.sequence;
  if (typeof sequence !== 'number')
    throw new CollaborationError('INVALID', `${field}.sequence must be a number`);
  return {
    id: snapshotText(source.id, `${field}.id`),
    projectId: snapshotText(source.projectId, `${field}.projectId`),
    sequence,
    ...(parentRevisionId === undefined ? {} : { parentRevisionId }),
    content: source.content,
    contentSha256: snapshotText(source.contentSha256, `${field}.contentSha256`),
    scenarioIds: readStringList(source.scenarioIds, `${field}.scenarioIds`),
    createdBy: snapshotText(source.createdBy, `${field}.createdBy`),
    createdAt: snapshotTimestamp(source.createdAt, `${field}.createdAt`)
  };
}

function parseSnapshotThread(value: unknown, field: string): Thread {
  const source = snapshotRecord(value, field);
  const resolvedAt =
    source.resolvedAt === undefined
      ? undefined
      : snapshotTimestamp(source.resolvedAt, `${field}.resolvedAt`);
  const resolvedBy = snapshotOptionalText(source.resolvedBy, `${field}.resolvedBy`);
  return {
    id: snapshotText(source.id, `${field}.id`),
    projectId: snapshotText(source.projectId, `${field}.projectId`),
    revisionId: snapshotText(source.revisionId, `${field}.revisionId`),
    reactNodeId: snapshotText(source.reactNodeId, `${field}.reactNodeId`),
    scenarioId: snapshotText(source.scenarioId, `${field}.scenarioId`),
    createdBy: snapshotText(source.createdBy, `${field}.createdBy`),
    createdAt: snapshotTimestamp(source.createdAt, `${field}.createdAt`),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    ...(resolvedBy === undefined ? {} : { resolvedBy })
  };
}

function parseSnapshotComment(value: unknown, field: string): Comment {
  const source = snapshotRecord(value, field);
  const parentCommentId = snapshotOptionalText(source.parentCommentId, `${field}.parentCommentId`);
  return {
    id: snapshotText(source.id, `${field}.id`),
    threadId: snapshotText(source.threadId, `${field}.threadId`),
    ...(parentCommentId === undefined ? {} : { parentCommentId }),
    body: snapshotText(source.body, `${field}.body`),
    createdBy: snapshotText(source.createdBy, `${field}.createdBy`),
    createdAt: snapshotTimestamp(source.createdAt, `${field}.createdAt`),
    mentionedUserIds: readStringList(source.mentionedUserIds, `${field}.mentionedUserIds`)
  };
}

function parseSnapshotAIRequest(value: unknown, field: string): AIChangeRequest {
  const source = snapshotRecord(value, field);
  const provider = snapshotRecord(source.provider, `${field}.provider`);
  const baseRevision = snapshotRecord(source.baseRevision, `${field}.baseRevision`);
  const lifecycle = source.lifecycle;
  if (
    lifecycle !== 'queued' &&
    lifecycle !== 'running' &&
    lifecycle !== 'applied' &&
    lifecycle !== 'failed' &&
    lifecycle !== 'cancelled' &&
    lifecycle !== 'undone'
  )
    throw new CollaborationError('INVALID', `${field}.lifecycle is invalid`);
  const model = snapshotOptionalText(provider.model, `${field}.provider.model`);
  const implementation = snapshotOptionalText(
    provider.implementation,
    `${field}.provider.implementation`
  );
  const failureReason = snapshotOptionalText(source.failureReason, `${field}.failureReason`);
  const parseResult = (resultValue: unknown, resultField: string): AIChangeRequestResult => {
    const result = snapshotRecord(resultValue, resultField);
    return {
      revisionId: snapshotText(result.revisionId, `${resultField}.revisionId`),
      revisionFingerprint: snapshotText(
        result.revisionFingerprint,
        `${resultField}.revisionFingerprint`
      ),
      diff: snapshotText(result.diff, `${resultField}.diff`),
      completedAt: snapshotTimestamp(result.completedAt, `${resultField}.completedAt`)
    };
  };
  const result =
    source.result === undefined ? undefined : parseResult(source.result, `${field}.result`);
  const undoResult =
    source.undoResult === undefined
      ? lifecycle === 'undone' && result !== undefined
        ? result
        : undefined
      : parseResult(source.undoResult, `${field}.undoResult`);
  return {
    id: snapshotText(source.id, `${field}.id`),
    projectId: snapshotText(source.projectId, `${field}.projectId`),
    anchor: parseSnapshotAnchor(source.anchor, `${field}.anchor`),
    instruction: snapshotText(source.instruction, `${field}.instruction`),
    provider: {
      providerId: snapshotText(provider.providerId, `${field}.provider.providerId`),
      capability: snapshotText(provider.capability, `${field}.provider.capability`),
      ...(model === undefined ? {} : { model }),
      ...(implementation === undefined ? {} : { implementation })
    },
    baseRevision: {
      id: snapshotText(baseRevision.id, `${field}.baseRevision.id`),
      fingerprint: snapshotText(baseRevision.fingerprint, `${field}.baseRevision.fingerprint`)
    },
    lifecycle,
    createdBy: snapshotText(source.createdBy, `${field}.createdBy`),
    createdAt: snapshotTimestamp(source.createdAt, `${field}.createdAt`),
    updatedAt: snapshotTimestamp(source.updatedAt, `${field}.updatedAt`),
    ...(result === undefined ? {} : { result }),
    ...(undoResult === undefined ? {} : { undoResult }),
    ...(failureReason === undefined ? {} : { failureReason })
  };
}

function parseSnapshotAnnotation(value: unknown, field: string): DeveloperAnnotation {
  const source = snapshotRecord(value, field);
  const category = source.category;
  if (
    category !== 'development' &&
    category !== 'interaction' &&
    category !== 'accessibility' &&
    category !== 'content'
  )
    throw new CollaborationError('INVALID', `${field}.category is invalid`);
  return {
    id: snapshotText(source.id, `${field}.id`),
    projectId: snapshotText(source.projectId, `${field}.projectId`),
    anchor: parseSnapshotAnchor(source.anchor, `${field}.anchor`),
    category,
    body: snapshotText(source.body, `${field}.body`),
    createdBy: snapshotText(source.createdBy, `${field}.createdBy`),
    createdAt: snapshotTimestamp(source.createdAt, `${field}.createdAt`)
  };
}

/** Rejects malformed nested records and cross-project references before an import reaches storage. */
export function validateCollaborationSnapshot(snapshot: CollaborationSnapshot): void {
  snapshot = owned(snapshot, 'Collaboration snapshot is invalid');
  if (snapshot.format !== collaborationFormat)
    throw new CollaborationError('INVALID', 'Unsupported collaboration snapshot format');
  requireIdentifier(snapshot.project.id, 'snapshot project id');
  requireIdentifier(snapshot.project.organizationId, 'snapshot organization id');
  requireText(snapshot.project.name, 'snapshot project name');
  for (const [field, values] of Object.entries({
    revisions: snapshot.revisions,
    threads: snapshot.threads,
    comments: snapshot.comments,
    reactions: snapshot.reactions,
    approvals: snapshot.approvals,
    reviewThreads: snapshot.reviewThreads,
    aiChangeRequests: snapshot.aiChangeRequests,
    developerAnnotations: snapshot.developerAnnotations
  }))
    requireListLimit(values, maxSnapshotItems, `Snapshot ${field}`);
  const requireUniqueIds = <T extends { readonly id: string }>(
    values: readonly T[],
    field: string
  ): void => {
    const ids = new Set<string>();
    for (const value of values) {
      if (ids.has(value.id))
        throw new CollaborationError('DUPLICATE', `Snapshot ${field} identifiers must be unique`);
      ids.add(value.id);
    }
  };
  requireUniqueIds(snapshot.reviewThreads, 'review threads');
  requireUniqueIds(snapshot.aiChangeRequests, 'AI change requests');
  requireUniqueIds(snapshot.developerAnnotations, 'developer annotations');
  const reactionKeys = new Set<string>();
  for (const reaction of snapshot.reactions) {
    const reactionKey = `${reaction.commentId}\u0000${reaction.userId}\u0000${reaction.emoji}`;
    if (reactionKeys.has(reactionKey))
      throw new CollaborationError(
        'DUPLICATE',
        'Snapshot reactions must be unique per comment, user, and emoji'
      );
    reactionKeys.add(reactionKey);
  }
  const revisions = new Map<string, Revision>();
  for (const value of snapshot.revisions) {
    requireIdentifier(value.id, 'snapshot revision id');
    if (revisions.has(value.id) || value.projectId !== snapshot.project.id)
      throw new CollaborationError(
        'INVALID',
        'Snapshot revisions must be unique and belong to the project'
      );
    if (!Number.isSafeInteger(value.sequence) || value.sequence < 1)
      throw new CollaborationError('INVALID', 'Snapshot revision sequence is invalid');
    if (!Array.isArray(value.scenarioIds) || !unique(value.scenarioIds))
      throw new CollaborationError('INVALID', 'Snapshot revision scenarios must be unique strings');
    for (const scenarioId of value.scenarioIds)
      requireIdentifier(scenarioId, 'snapshot scenario id');
    requireText(value.contentSha256, 'snapshot revision fingerprint', 128);
    requireIdentifier(value.createdBy, 'snapshot revision creator');
    requireTimestamp(value.createdAt, 'snapshot revision createdAt');
    revisions.set(value.id, value);
  }
  for (const value of snapshot.revisions) {
    if (value.parentRevisionId !== undefined && !revisions.has(value.parentRevisionId))
      throw new CollaborationError('INVALID', 'Snapshot revision parent is missing');
  }
  const threads = new Map<string, Thread>();
  for (const value of snapshot.threads) {
    if (threads.has(value.id) || value.projectId !== snapshot.project.id)
      throw new CollaborationError(
        'INVALID',
        'Snapshot threads must be unique and belong to the project'
      );
    const revision = revisions.get(value.revisionId);
    if (!revision) throw new CollaborationError('INVALID', 'Snapshot thread revision is missing');
    validateThreadAnchor(value, revision);
    requireIdentifier(value.createdBy, 'snapshot thread creator');
    requireTimestamp(value.createdAt, 'snapshot thread createdAt');
    if ((value.resolvedAt === undefined) !== (value.resolvedBy === undefined))
      throw new CollaborationError('INVALID', 'Resolved thread metadata must be complete');
    if (value.resolvedAt !== undefined)
      requireTimestamp(value.resolvedAt, 'snapshot thread resolvedAt');
    if (value.resolvedBy !== undefined)
      requireIdentifier(value.resolvedBy, 'snapshot thread resolvedBy');
    threads.set(value.id, value);
  }
  const comments = new Map<string, Comment>();
  for (const value of snapshot.comments) {
    if (comments.has(value.id) || !threads.has(value.threadId))
      throw new CollaborationError('INVALID', 'Snapshot comment is duplicate or has no thread');
    validateCommentInput(value);
    requireIdentifier(value.createdBy, 'snapshot comment creator');
    requireTimestamp(value.createdAt, 'snapshot comment createdAt');
    if (value.parentCommentId !== undefined) {
      const parent = comments.get(value.parentCommentId);
      if (!parent || parent.threadId !== value.threadId)
        throw new CollaborationError(
          'INVALID',
          'Snapshot comment parent must be earlier and in the same thread'
        );
    }
    comments.set(value.id, value);
  }
  for (const value of snapshot.reactions) {
    if (!comments.has(value.commentId))
      throw new CollaborationError('INVALID', 'Snapshot reaction comment is missing');
    requireIdentifier(value.userId, 'snapshot reaction user');
    requireText(value.emoji, 'snapshot reaction emoji', 64);
    requireTimestamp(value.createdAt, 'snapshot reaction createdAt');
  }
  for (const value of snapshot.approvals) {
    if (!revisions.has(value.revisionId))
      throw new CollaborationError('INVALID', 'Snapshot approval revision is missing');
    requireIdentifier(value.id, 'snapshot approval id');
    requireIdentifier(value.userId, 'snapshot approval user');
    if (value.decision !== 'approved' && value.decision !== 'changes_requested')
      throw new CollaborationError('INVALID', 'Snapshot approval decision is invalid');
    if (value.note !== undefined) requireText(value.note, 'snapshot approval note');
    requireTimestamp(value.createdAt, 'snapshot approval createdAt');
  }
  for (const value of snapshot.reviewThreads) {
    if (value.projectId !== snapshot.project.id)
      throw new CollaborationError('INVALID', 'Review thread must belong to the snapshot project');
    const revision = revisions.get(value.anchor.evidence.revisionId);
    if (!revision)
      throw new CollaborationError('INVALID', 'Review thread anchor revision is missing');
    validateSpatialAnchor(value.anchor, revision);
    validateReviewThread(value);
  }
  for (const value of snapshot.aiChangeRequests) {
    if (value.projectId !== snapshot.project.id)
      throw new CollaborationError(
        'INVALID',
        'AI change request must belong to the snapshot project'
      );
    const revision = revisions.get(value.baseRevision.id);
    if (!revision)
      throw new CollaborationError('INVALID', 'AI change request base revision is missing');
    validateAIChangeRequest(value, revision);
    validateAIChangeRequestResultReferences(value, revisions.values());
  }
  for (const value of snapshot.developerAnnotations) {
    if (value.projectId !== snapshot.project.id)
      throw new CollaborationError(
        'INVALID',
        'Developer annotation must belong to the snapshot project'
      );
    const revision = revisions.get(value.anchor.evidence.revisionId);
    if (!revision)
      throw new CollaborationError('INVALID', 'Developer annotation anchor revision is missing');
    validateDeveloperAnnotation(value, revision);
  }
  if (snapshot.designReviewState !== undefined) {
    validateDesignReviewState(snapshot.designReviewState);
    if (snapshot.designReviewState.projectId !== snapshot.project.id)
      throw new CollaborationError(
        'INVALID',
        'Design review state must belong to the snapshot project'
      );
  }
}

export function parseSnapshot(serialized: string): CollaborationSnapshot {
  try {
    if (typeof serialized !== 'string')
      throw new CollaborationError('INVALID', 'Collaboration import must be JSON text');
    if (new TextEncoder().encode(serialized).byteLength > maxSnapshotBytes)
      throw new CollaborationError('INVALID', 'Collaboration import exceeds the maximum size');
    const value: unknown = owned(JSON.parse(serialized), 'Collaboration import is invalid');
    if (
      !record(value) ||
      (value.format !== collaborationFormat && value.format !== legacyCollaborationFormat) ||
      !record(value.project) ||
      !Array.isArray(value.revisions) ||
      !Array.isArray(value.threads) ||
      !Array.isArray(value.comments) ||
      !Array.isArray(value.reactions) ||
      !Array.isArray(value.approvals)
    ) {
      throw new CollaborationError('INVALID', 'Collaboration import has an unsupported format');
    }
    if (
      (value.format === collaborationFormat &&
        (!Array.isArray(value.reviewThreads) ||
          !Array.isArray(value.aiChangeRequests) ||
          !Array.isArray(value.developerAnnotations))) ||
      (value.reviewThreads !== undefined && !Array.isArray(value.reviewThreads)) ||
      (value.aiChangeRequests !== undefined && !Array.isArray(value.aiChangeRequests)) ||
      (value.developerAnnotations !== undefined && !Array.isArray(value.developerAnnotations))
    )
      throw new CollaborationError('INVALID', 'Collaboration import has invalid v2 aggregates');
    const projectValue = snapshotRecord(value.project, 'project');
    const snapshot: CollaborationSnapshot = {
      format: collaborationFormat,
      project: {
        id: snapshotText(projectValue.id, 'project.id'),
        organizationId: snapshotText(projectValue.organizationId, 'project.organizationId'),
        name: snapshotText(projectValue.name, 'project.name')
      },
      revisions: value.revisions.map((item, index) =>
        parseSnapshotRevision(item, `revisions[${index}]`)
      ),
      threads: value.threads.map((item, index) => parseSnapshotThread(item, `threads[${index}]`)),
      comments: value.comments.map((item, index) =>
        parseSnapshotComment(item, `comments[${index}]`)
      ),
      reactions: value.reactions.map((item, index) => {
        const reaction = snapshotRecord(item, `reactions[${index}]`);
        return {
          commentId: snapshotText(reaction.commentId, `reactions[${index}].commentId`),
          userId: snapshotText(reaction.userId, `reactions[${index}].userId`),
          emoji: snapshotText(reaction.emoji, `reactions[${index}].emoji`),
          createdAt: snapshotTimestamp(reaction.createdAt, `reactions[${index}].createdAt`)
        };
      }),
      approvals: value.approvals.map((item, index) => {
        const approval = snapshotRecord(item, `approvals[${index}]`);
        const decision = approval.decision;
        if (decision !== 'approved' && decision !== 'changes_requested')
          throw new CollaborationError('INVALID', `approvals[${index}].decision is invalid`);
        const note = snapshotOptionalText(approval.note, `approvals[${index}].note`);
        return {
          id: snapshotText(approval.id, `approvals[${index}].id`),
          revisionId: snapshotText(approval.revisionId, `approvals[${index}].revisionId`),
          userId: snapshotText(approval.userId, `approvals[${index}].userId`),
          decision,
          ...(note === undefined ? {} : { note }),
          createdAt: snapshotTimestamp(approval.createdAt, `approvals[${index}].createdAt`)
        };
      }),
      reviewThreads: (value.reviewThreads ?? []).map((item, index) =>
        parseSnapshotReviewThread(item, `reviewThreads[${index}]`)
      ),
      aiChangeRequests: (value.aiChangeRequests ?? []).map((item, index) =>
        parseSnapshotAIRequest(item, `aiChangeRequests[${index}]`)
      ),
      developerAnnotations: (value.developerAnnotations ?? []).map((item, index) =>
        parseSnapshotAnnotation(item, `developerAnnotations[${index}]`)
      )
    };
    const parsed =
      value.designReviewState === undefined
        ? snapshot
        : { ...snapshot, designReviewState: parseDesignReviewState(value.designReviewState) };
    validateCollaborationSnapshot(parsed);
    return owned(parsed, 'Collaboration snapshot is invalid');
  } catch {
    throw new CollaborationError('INVALID', 'Collaboration import is not a valid snapshot');
  }
}

export * from './history.js';
