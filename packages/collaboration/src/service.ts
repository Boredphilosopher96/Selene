import {
  collaborationFormat,
  clusterReviewThreads,
  type Approval,
  type AIChangeRequest,
  type AIChangeRequestLifecycle,
  type CollaborationRepository,
  type Comment,
  CollaborationError,
  type DesignReadinessInput,
  idempotent,
  parseSnapshot,
  type Project,
  type Reaction,
  type Revision,
  type ReviewThread,
  type SemanticDesignChangeInput,
  serializeSnapshot,
  createSignedShareToken,
  type CollaborationAction,
  verifySignedShareToken,
  type SharePermission,
  type ShareTokenSigner,
  type Thread,
  type DeveloperAnnotation,
  type SpatialAnchor,
  validateReviewDeepLink
} from './index.js';

export interface ServiceClock {
  now(): string;
}

export interface ServiceIds {
  next(kind: string): string;
}

export interface AuthorizationRequest {
  readonly userId: string;
  readonly action: CollaborationAction;
  readonly organizationId?: string;
  readonly projectId?: string;
}

export interface CollaborationAuthorizer {
  authorize(request: AuthorizationRequest): Promise<boolean>;
}

export { roleAllows, type CollaborationAction } from './index.js';

export interface ServiceOptions {
  readonly repository: CollaborationRepository;
  readonly authorizer: CollaborationAuthorizer;
  readonly ids: ServiceIds;
  readonly clock?: ServiceClock;
  readonly allowedOrigins?: readonly string[];
  readonly maxRequestsPerMinute?: number;
  /** Limits JSON request bodies before parsing to bound memory use. */
  readonly maxRequestBodyBytes?: number;
  readonly maxSnapshotBytes?: number;
  /** Optional signer enables time-limited guest share URLs without a database dependency. */
  readonly shareSigner?: ShareTokenSigner;
}

interface Metrics {
  requests: number;
  rejected: number;
  errors: number;
}

const maxRequestListItems = 1_000;

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  });
}

function text(value: string, status = 200): Response {
  return new Response(value, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

function idFrom(pathname: string, pattern: RegExp): string | undefined {
  return pattern.exec(pathname)?.[1];
}

function actor(request: Request): string {
  const value = request.headers.get('x-selene-user-id');
  if (!value) throw new CollaborationError('FORBIDDEN', 'x-selene-user-id is required');
  return value;
}

async function readSerialized(
  request: Request,
  maximumBytes: number,
  label: string
): Promise<string> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > maximumBytes)
    throw new CollaborationError('INVALID', `${label} exceeds the maximum size`);
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      // A stream must be consumed serially so the byte limit can fail before buffering more input.
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes)
        throw new CollaborationError('INVALID', `${label} exceeds the maximum size`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readBody(request: Request, maximumBytes: number): Promise<Record<string, unknown>> {
  const serialized = await readSerialized(request, maximumBytes, 'Request body');
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new CollaborationError('INVALID', 'Request body must be valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CollaborationError('INVALID', 'Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

async function readSnapshot(request: Request, maximumBytes: number) {
  const serialized = await readSerialized(request, maximumBytes, 'Collaboration import');
  return parseSnapshot(serialized);
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new CollaborationError('INVALID', `${field} is required`);
  return value;
}

function strings(value: unknown, field: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > maxRequestListItems ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw new CollaborationError('INVALID', `${field} must be an array of strings`);
  }
  return value;
}

function uniqueStrings(value: unknown, field: string): readonly string[] {
  const items = strings(value, field);
  if (new Set(items).size !== items.length)
    throw new CollaborationError('INVALID', `${field} must not contain duplicates`);
  return items;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new CollaborationError('INVALID', `${field} must be an object`);
  return value as Record<string, unknown>;
}

function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new CollaborationError('INVALID', `${field} must be a number`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : string(value, field);
}

function revisionEvidence(value: unknown, field: string) {
  const evidence = object(value, field);
  const viewport = object(evidence.viewport, `${field}.viewport`);
  const scenarioId = optionalString(evidence.scenarioId, `${field}.scenarioId`);
  const stateId = optionalString(evidence.stateId, `${field}.stateId`);
  const nodeId = optionalString(evidence.nodeId, `${field}.nodeId`);
  const sourceRef = optionalString(evidence.sourceRef, `${field}.sourceRef`);
  return {
    artifactId: string(evidence.artifactId, `${field}.artifactId`),
    screenId: string(evidence.screenId, `${field}.screenId`),
    revisionId: string(evidence.revisionId, `${field}.revisionId`),
    revisionFingerprint: string(evidence.revisionFingerprint, `${field}.revisionFingerprint`),
    viewport: {
      width: number(viewport.width, `${field}.viewport.width`),
      height: number(viewport.height, `${field}.viewport.height`),
      zoom: number(viewport.zoom, `${field}.viewport.zoom`)
    },
    ...(scenarioId === undefined ? {} : { scenarioId }),
    ...(stateId === undefined ? {} : { stateId }),
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(sourceRef === undefined ? {} : { sourceRef })
  };
}

function spatialAnchor(value: unknown): SpatialAnchor {
  const anchor = object(value, 'anchor');
  const target = object(anchor.target, 'anchor.target');
  const lifecycle = anchor.lifecycle;
  if (
    lifecycle !== 'current' &&
    lifecycle !== 'mapped' &&
    lifecycle !== 'stale' &&
    lifecycle !== 'orphaned'
  )
    throw new CollaborationError('INVALID', 'anchor.lifecycle is invalid');
  const mappedFrom = anchor.mappedFrom;
  if (lifecycle === 'mapped' && mappedFrom === undefined)
    throw new CollaborationError('INVALID', 'Mapped anchor requires mappedFrom evidence');
  if (lifecycle !== 'mapped' && mappedFrom !== undefined)
    throw new CollaborationError('INVALID', 'Only mapped anchors may contain mappedFrom evidence');
  const common = {
    evidence: revisionEvidence(anchor.evidence, 'anchor.evidence'),
    lifecycle: lifecycle as SpatialAnchor['lifecycle'],
    ...(mappedFrom === undefined
      ? {}
      : { mappedFrom: revisionEvidence(mappedFrom, 'anchor.mappedFrom') })
  };
  if (target.kind === 'point') {
    const point = object(target.point, 'anchor.target.point');
    return {
      ...common,
      target: {
        kind: 'point',
        point: {
          x: number(point.x, 'anchor.target.point.x'),
          y: number(point.y, 'anchor.target.point.y')
        }
      }
    };
  }
  if (target.kind === 'region') {
    const region = object(target.region, 'anchor.target.region');
    return {
      ...common,
      target: {
        kind: 'region',
        region: {
          x: number(region.x, 'anchor.target.region.x'),
          y: number(region.y, 'anchor.target.region.y'),
          width: number(region.width, 'anchor.target.region.width'),
          height: number(region.height, 'anchor.target.region.height')
        }
      }
    };
  }
  throw new CollaborationError('INVALID', 'anchor.target.kind must be point or region');
}

function reviewDeepLink(value: unknown, allowedOrigins: readonly string[] | undefined): string {
  const deepLink = string(value, 'deepLink');
  validateReviewDeepLink(deepLink);
  if (deepLink.startsWith('/') && !deepLink.startsWith('//')) return deepLink;
  let url: URL;
  try {
    url = new URL(deepLink);
  } catch {
    throw new CollaborationError('INVALID', 'deepLink must be a safe relative route or https URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    allowedOrigins?.includes(url.origin) !== true
  )
    throw new CollaborationError(
      'INVALID',
      'deepLink https URL must use a configured same-product origin'
    );
  return deepLink;
}

function providerSnapshot(value: unknown): AIChangeRequest['provider'] {
  const provider = object(value, 'provider');
  const model = optionalString(provider.model, 'provider.model');
  const implementation = optionalString(provider.implementation, 'provider.implementation');
  return {
    providerId: string(provider.providerId, 'provider.providerId'),
    capability: string(provider.capability, 'provider.capability'),
    ...(model === undefined ? {} : { model }),
    ...(implementation === undefined ? {} : { implementation })
  };
}

function changeResult(value: unknown): NonNullable<AIChangeRequest['result']> {
  const result = object(value, 'result');
  return {
    revisionId: string(result.revisionId, 'result.revisionId'),
    revisionFingerprint: string(result.revisionFingerprint, 'result.revisionFingerprint'),
    diff: string(result.diff, 'result.diff'),
    completedAt: string(result.completedAt, 'result.completedAt')
  };
}

function designChangeScope(value: Record<string, unknown>): SemanticDesignChangeInput['affected'] {
  return {
    projectId: string(value.projectId, 'semanticChange.affected.projectId'),
    screenIds: uniqueStrings(value.screenIds, 'semanticChange.affected.screenIds'),
    routePaths: uniqueStrings(value.routePaths, 'semanticChange.affected.routePaths'),
    scenarioIds: uniqueStrings(value.scenarioIds, 'semanticChange.affected.scenarioIds'),
    componentIds: uniqueStrings(value.componentIds, 'semanticChange.affected.componentIds'),
    stableNodeIds: uniqueStrings(value.stableNodeIds, 'semanticChange.affected.stableNodeIds')
  };
}

function visualEvidence(value: unknown): SemanticDesignChangeInput['evidence'] {
  if (!Array.isArray(value) || value.length > maxRequestListItems)
    throw new CollaborationError('INVALID', 'semanticChange.evidence must be an array');
  return value.map((item, index) => {
    const detail = object(item, `semanticChange.evidence[${index}]`);
    return {
      description: string(detail.description, `semanticChange.evidence[${index}].description`),
      ...(typeof detail.href === 'string' ? { href: detail.href } : {}),
      ...(typeof detail.checksum === 'string' ? { checksum: detail.checksum } : {})
    };
  });
}

function semanticChange(value: unknown): SemanticDesignChangeInput | undefined {
  if (value === undefined) return undefined;
  const input = object(value, 'semanticChange');
  const affected = object(input.affected, 'semanticChange.affected');
  const provenance = object(input.provenance, 'semanticChange.provenance');
  const kind = input.kind;
  if (
    kind !== 'source' &&
    kind !== 'design-system' &&
    kind !== 'token' &&
    kind !== 'template' &&
    kind !== 'dependency' &&
    kind !== 'visual'
  )
    throw new CollaborationError('INVALID', 'semanticChange.kind is invalid');
  const common: Omit<SemanticDesignChangeInput, 'provenance'> = {
    id: string(input.id, 'semanticChange.id'),
    kind: kind as SemanticDesignChangeInput['kind'],
    affected: designChangeScope(affected),
    evidence: visualEvidence(input.evidence),
    reason: string(input.reason, 'semanticChange.reason')
  };
  const provenanceKind = provenance.kind;
  if (provenanceKind === 'actor') {
    return {
      ...common,
      provenance: {
        kind: 'actor',
        actorId: string(provenance.actorId, 'semanticChange.provenance.actorId')
      }
    };
  }
  if (provenanceKind === 'agent') {
    return {
      ...common,
      provenance: {
        kind: 'agent',
        agentId: string(provenance.agentId, 'semanticChange.provenance.agentId'),
        promptDigest: string(provenance.promptDigest, 'semanticChange.provenance.promptDigest')
      }
    };
  }
  throw new CollaborationError('INVALID', 'semanticChange.provenance.kind is invalid');
}

/**
 * Fetch-compatible, dependency-free HTTP adapter. Authentication supplies a
 * trusted actor identity; every authenticated route still passes through the
 * injected tenant-aware authorizer.
 */
export function createCollaborationService(
  options: ServiceOptions
): (request: Request) => Promise<Response> {
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const maximum = options.maxRequestsPerMinute ?? 120;
  const maximumBodyBytes = options.maxRequestBodyBytes ?? 1_048_576;
  const maximumSnapshotBytes = options.maxSnapshotBytes ?? 10 * 1_024 * 1_024;
  if (!Number.isSafeInteger(maximumBodyBytes) || maximumBodyBytes < 1)
    throw new Error('maxRequestBodyBytes must be a positive integer');
  if (!Number.isSafeInteger(maximumSnapshotBytes) || maximumSnapshotBytes < 1)
    throw new Error('maxSnapshotBytes must be a positive integer');
  const body = (request: Request) => readBody(request, maximumBodyBytes);
  const counters = new Map<string, { start: number; count: number }>();
  const subscribers = new Map<
    string,
    Set<(event: import('./index.js').CollaborationEvent) => void>
  >();
  const metrics: Metrics = { requests: 0, rejected: 0, errors: 0 };

  async function emit(
    projectId: string,
    type: string,
    actorId: string | undefined,
    resourceType: string,
    resourceId: string,
    payload: Readonly<Record<string, unknown>> = {}
  ) {
    const event = await options.repository.appendEvent({
      id: options.ids.next('event'),
      projectId,
      type,
      ...(actorId ? { actorId } : {}),
      resourceType,
      resourceId,
      payload,
      occurredAt: clock.now()
    });
    for (const subscriber of subscribers.get(projectId) ?? []) subscriber(event);
    return event;
  }

  function cors(request: Request, response: Response): Response {
    const origin = request.headers.get('origin');
    if (!origin || options.allowedOrigins?.includes(origin) !== true) return response;
    const headers = new Headers(response.headers);
    headers.set('access-control-allow-origin', origin);
    headers.set('vary', 'Origin');
    headers.set(
      'access-control-allow-headers',
      'content-type, idempotency-key, last-event-id, x-selene-share-token, x-selene-user-id'
    );
    headers.set('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    return new Response(response.body, { status: response.status, headers });
  }

  function allowed(request: Request): boolean {
    const shareToken = request.headers.get('x-selene-share-token');
    let tokenHash = 2166136261;
    if (shareToken)
      for (let index = 0; index < shareToken.length; index += 1) {
        tokenHash ^= shareToken.charCodeAt(index);
        tokenHash = Math.imul(tokenHash, 16777619);
      }
    const client =
      request.headers.get('x-selene-user-id') ??
      (shareToken ? `share:${(tokenHash >>> 0).toString(16)}` : 'anonymous');
    const now = Date.now();
    const rate = counters.get(client);
    if (!rate || now - rate.start >= 60_000) {
      if (!rate && counters.size >= 10_000) {
        for (const [key, value] of counters) if (now - value.start >= 60_000) counters.delete(key);
        if (counters.size >= 10_000) return false;
      }
      counters.set(client, { start: now, count: 1 });
      return true;
    }
    rate.count += 1;
    return rate.count <= maximum;
  }

  function cursor(value: string | null): number {
    if (value === null || value === '') return 0;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0)
      throw new CollaborationError('INVALID', 'after must be a non-negative cursor');
    return parsed;
  }

  function limit(value: string | null): number {
    if (value === null || value === '') return 100;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500)
      throw new CollaborationError('INVALID', 'limit must be between 1 and 500');
    return parsed;
  }

  async function requireProjectAccess(
    request: Request,
    projectId: string,
    permission: SharePermission
  ): Promise<string | undefined> {
    const userId = request.headers.get('x-selene-user-id');
    if (userId) {
      if (
        !(await options.authorizer.authorize({
          userId,
          action: `project:${permission === 'viewer' ? 'read' : 'comment'}`,
          projectId
        }))
      ) {
        throw new CollaborationError('FORBIDDEN', 'Project access is not permitted');
      }
      return userId;
    }
    const token = request.headers.get('x-selene-share-token');
    if (!token || !options.shareSigner)
      throw new CollaborationError('FORBIDDEN', 'Authentication or a share token is required');
    const grant = await verifySignedShareToken(token, options.shareSigner, clock.now());
    const link = await options.repository.getShareLink(grant.linkId);
    if (
      grant.projectId !== projectId ||
      !link ||
      link.projectId !== projectId ||
      link.tokenHash !== (await options.shareSigner.hash(token)) ||
      link.revokedAt ||
      Date.parse(link.expiresAt) <= Date.parse(clock.now()) ||
      (permission === 'commenter' && link.permission !== 'commenter')
    ) {
      throw new CollaborationError('FORBIDDEN', 'Share link is not valid for this operation');
    }
    return undefined;
  }

  async function requireUserAuthorization(
    request: Request,
    action: CollaborationAction,
    target: { readonly organizationId?: string; readonly projectId?: string }
  ): Promise<string> {
    const userId = actor(request);
    if (!(await options.authorizer.authorize({ userId, action, ...target }))) {
      throw new CollaborationError('FORBIDDEN', 'Project access is not permitted');
    }
    return userId;
  }

  return async (request) => {
    metrics.requests += 1;
    if (request.method === 'OPTIONS') return cors(request, new Response(null, { status: 204 }));
    if (!allowed(request)) {
      metrics.rejected += 1;
      return cors(request, json({ error: 'rate_limited' }, 429, { 'retry-after': '60' }));
    }
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return cors(request, json({ status: 'ok', collaborationFormat }));
      }
      if (request.method === 'GET' && url.pathname === '/metrics') {
        return cors(
          request,
          text(
            `selene_collaboration_requests_total ${metrics.requests}\nselene_collaboration_rejected_total ${metrics.rejected}\nselene_collaboration_errors_total ${metrics.errors}\n`
          )
        );
      }
      if (request.method === 'POST' && url.pathname === '/v1/projects') {
        const input = await body(request);
        const organizationId = string(input.organizationId, 'organizationId');
        const userId = await requireUserAuthorization(request, 'organization:create-project', {
          organizationId
        });
        const project: Project = {
          id: string(input.id ?? options.ids.next('project'), 'id'),
          organizationId,
          name: string(input.name, 'name')
        };
        const saved = await idempotent(
          options.repository,
          `project:${userId}:${project.id}`,
          request.headers.get('idempotency-key') ?? undefined,
          async () => {
            await options.repository.createProject(project);
            await options.repository.appendAudit({
              id: options.ids.next('audit'),
              organizationId: project.organizationId,
              actorId: userId,
              action: 'project.created',
              resourceType: 'project',
              resourceId: project.id,
              metadata: {},
              occurredAt: clock.now()
            });
            await emit(project.id, 'project.created', userId, 'project', project.id, {
              organizationId: project.organizationId,
              name: project.name
            });
            return project;
          }
        );
        return cors(request, json(saved, 201));
      }
      const revisionProjectId = idFrom(url.pathname, /^\/v1\/projects\/([^/]+)\/revisions$/);
      if (request.method === 'POST' && revisionProjectId) {
        const input = await body(request);
        const userId = await requireUserAuthorization(request, 'project:design', {
          projectId: revisionProjectId
        });
        const latest = await options.repository.getLatestRevision(revisionProjectId);
        const revision: Revision = {
          id: string(input.id ?? options.ids.next('revision'), 'id'),
          projectId: revisionProjectId,
          sequence:
            typeof input.sequence === 'number' ? input.sequence : (latest?.sequence ?? 0) + 1,
          ...(typeof input.parentRevisionId === 'string'
            ? { parentRevisionId: input.parentRevisionId }
            : latest
              ? { parentRevisionId: latest.id }
              : {}),
          content: input.content,
          contentSha256: string(input.contentSha256, 'contentSha256'),
          scenarioIds: strings(input.scenarioIds ?? [], 'scenarioIds'),
          createdBy: userId,
          createdAt: clock.now()
        };
        const change = semanticChange(input.semanticChange);
        const saved = await options.repository.commitDesignRevision({
          kind: 'append-revision',
          projectId: revisionProjectId,
          actorId: userId,
          occurredAt: clock.now(),
          revision,
          ...(latest ? { expectedParentRevisionId: latest.id } : {}),
          ...(change ? { semanticChange: change } : {}),
          ...(request.headers.get('idempotency-key')
            ? {
                idempotencyKey: request.headers.get('idempotency-key')!,
                idempotencyScope: `revision:${userId}:${revisionProjectId}`
              }
            : {})
        });
        if (saved.kind !== 'revision')
          throw new CollaborationError(
            'CONFLICT',
            'Revision transaction returned an invalid result'
          );
        if (!saved.replayed)
          await emit(revisionProjectId, 'revision.created', userId, 'revision', revision.id, {
            sequence: revision.sequence,
            parentRevisionId: revision.parentRevisionId,
            semanticChangeRecorded: saved.changeRecorded
          });
        return cors(request, json(saved.revision, 201));
      }
      const readinessProjectId = idFrom(url.pathname, /^\/v1\/projects\/([^/]+)\/readiness$/);
      if (request.method === 'GET' && readinessProjectId) {
        await requireUserAuthorization(request, 'project:read', { projectId: readinessProjectId });
        const state = await options.repository.getDesignReviewState(readinessProjectId);
        if (!state) throw new CollaborationError('NOT_FOUND', 'Project not found');
        return cors(request, json(state));
      }
      if (request.method === 'POST' && readinessProjectId) {
        const input = await body(request);
        const userId = await requireUserAuthorization(request, 'project:design', {
          projectId: readinessProjectId
        });
        const intent = input.intent;
        if (intent !== 'review' && intent !== 'handoff')
          throw new CollaborationError('INVALID', 'intent must be review or handoff');
        const readiness: DesignReadinessInput = {
          id: string(input.id ?? options.ids.next('baseline'), 'id'),
          revisionId: string(input.revisionId, 'revisionId'),
          intent,
          revisionFingerprint: string(input.revisionFingerprint, 'revisionFingerprint')
        };
        const saved = await options.repository.commitDesignRevision({
          kind: 'mark-ready',
          projectId: readinessProjectId,
          actorId: userId,
          occurredAt: clock.now(),
          readiness,
          ...(request.headers.get('idempotency-key')
            ? {
                idempotencyKey: request.headers.get('idempotency-key')!,
                idempotencyScope: `readiness:${userId}:${readinessProjectId}`
              }
            : {})
        });
        if (saved.kind !== 'readiness')
          throw new CollaborationError(
            'CONFLICT',
            'Readiness transaction returned an invalid result'
          );
        if (!saved.replayed)
          await emit(readinessProjectId, 'design.ready', userId, 'design_baseline', readiness.id, {
            intent: readiness.intent,
            revisionId: readiness.revisionId
          });
        return cors(request, json(saved.readiness, 201));
      }
      const shareProjectId = idFrom(url.pathname, /^\/v1\/projects\/([^/]+)\/share-links$/);
      if (request.method === 'POST' && shareProjectId) {
        if (!options.shareSigner)
          throw new CollaborationError('NOT_FOUND', 'Guest sharing is not configured');
        const input = await body(request);
        const userId = await requireUserAuthorization(request, 'project:manage-sharing', {
          projectId: shareProjectId
        });
        if (!(await options.repository.getProject(shareProjectId)))
          throw new CollaborationError('NOT_FOUND', 'Project not found');
        const permission: SharePermission =
          input.permission === 'commenter'
            ? 'commenter'
            : input.permission === 'viewer'
              ? 'viewer'
              : (() => {
                  throw new CollaborationError('INVALID', 'permission must be viewer or commenter');
                })();
        const expiresAt = string(input.expiresAt, 'expiresAt');
        const linkId = options.ids.next('share');
        const token = await createSignedShareToken(
          { linkId, projectId: shareProjectId, permission, expiresAt },
          options.shareSigner
        );
        await options.repository.createShareLink({
          id: linkId,
          projectId: shareProjectId,
          tokenHash: await options.shareSigner.hash(token),
          permission,
          expiresAt,
          createdBy: userId,
          createdAt: clock.now()
        });
        await emit(shareProjectId, 'share_link.created', userId, 'share_link', linkId, {
          permission
        });
        return cors(request, json({ id: linkId, token, permission, expiresAt }, 201));
      }
      const threadProjectId = idFrom(url.pathname, /^\/v1\/projects\/([^/]+)\/threads$/);
      const reviewThreadProjectId = idFrom(
        url.pathname,
        /^\/v1\/projects\/([^/]+)\/review-threads$/
      );
      if (request.method === 'GET' && reviewThreadProjectId) {
        const viewerId = await requireProjectAccess(request, reviewThreadProjectId, 'viewer');
        const lifecycle = url.searchParams.get('lifecycle');
        if (lifecycle !== null && lifecycle !== 'open' && lifecycle !== 'resolved')
          throw new CollaborationError('INVALID', 'lifecycle must be open or resolved');
        const threads = await options.repository.listReviewThreads(reviewThreadProjectId, {
          ...(lifecycle === null ? {} : { lifecycle }),
          ...(url.searchParams.get('revisionId') === null
            ? {}
            : { revisionId: url.searchParams.get('revisionId')! }),
          ...(url.searchParams.get('deepLink') === null
            ? {}
            : { deepLink: url.searchParams.get('deepLink')! }),
          ...(url.searchParams.get('screenId') === null
            ? {}
            : { screenId: url.searchParams.get('screenId')! }),
          ...(url.searchParams.get('stateId') === null
            ? {}
            : { stateId: url.searchParams.get('stateId')! }),
          ...(url.searchParams.get('author') === null
            ? {}
            : { createdBy: url.searchParams.get('author')! }),
          ...(url.searchParams.get('unread') === 'true' && viewerId !== undefined
            ? { unreadFor: viewerId }
            : {})
        });
        const clusterCellSize = url.searchParams.get('clusterCellSize');
        if (clusterCellSize !== null) {
          const cellSize = Number(clusterCellSize);
          return cors(
            request,
            json({ threads, clusters: clusterReviewThreads(threads, cellSize) })
          );
        }
        return cors(request, json({ threads }));
      }
      if (request.method === 'POST' && reviewThreadProjectId) {
        const input = await body(request);
        const userId = await requireProjectAccess(request, reviewThreadProjectId, 'commenter');
        const actorId = userId ?? 'guest';
        const createdAt = clock.now();
        const reviewThread: ReviewThread = {
          id: string(input.id ?? options.ids.next('review-thread'), 'id'),
          projectId: reviewThreadProjectId,
          anchor: spatialAnchor(input.anchor),
          deepLink: reviewDeepLink(input.deepLink, options.allowedOrigins),
          lifecycle: 'open',
          createdBy: actorId,
          createdAt,
          messages: [
            {
              id: string(input.messageId ?? options.ids.next('review-message'), 'messageId'),
              body: string(input.body, 'body'),
              createdBy: actorId,
              createdAt,
              mentionedUserIds: uniqueStrings(input.mentionedUserIds ?? [], 'mentionedUserIds'),
              reactions: [],
              readBy: [actorId]
            }
          ]
        };
        await options.repository.createReviewThread(reviewThread);
        await emit(
          reviewThreadProjectId,
          'review_thread.created',
          userId,
          'review_thread',
          reviewThread.id,
          {
            revisionId: reviewThread.anchor.evidence.revisionId
          }
        );
        return cors(request, json(reviewThread, 201));
      }
      const reviewThreadMessage = idFrom(url.pathname, /^\/v1\/review-threads\/([^/]+)\/messages$/);
      if (request.method === 'POST' && reviewThreadMessage) {
        const input = await body(request);
        const existing = await options.repository.getReviewThread(reviewThreadMessage);
        if (!existing) throw new CollaborationError('NOT_FOUND', 'Review thread not found');
        const userId = await requireProjectAccess(request, existing.projectId, 'commenter');
        const actorId = userId ?? 'guest';
        const message = {
          id: string(input.id ?? options.ids.next('review-message'), 'id'),
          ...(typeof input.parentMessageId === 'string'
            ? { parentMessageId: string(input.parentMessageId, 'parentMessageId') }
            : {}),
          body: string(input.body, 'body'),
          createdBy: actorId,
          createdAt: clock.now(),
          mentionedUserIds: uniqueStrings(input.mentionedUserIds ?? [], 'mentionedUserIds'),
          reactions: [],
          readBy: [actorId]
        };
        const updated = await options.repository.appendReviewThreadMessage(existing.id, message);
        await emit(
          existing.projectId,
          'review_message.created',
          userId,
          'review_thread',
          existing.id,
          {
            messageId: message.id
          }
        );
        return cors(request, json(updated));
      }
      const reviewMessageReaction = idFrom(
        url.pathname,
        /^\/v1\/review-threads\/([^/]+)\/messages\/([^/]+)\/reactions$/
      );
      const reactionMatch = /^\/v1\/review-threads\/([^/]+)\/messages\/([^/]+)\/reactions$/.exec(
        url.pathname
      );
      if (request.method === 'POST' && reviewMessageReaction && reactionMatch) {
        const input = await body(request);
        const existing = await options.repository.getReviewThread(reactionMatch[1]!);
        if (!existing) throw new CollaborationError('NOT_FOUND', 'Review thread not found');
        const userId = await requireProjectAccess(request, existing.projectId, 'commenter');
        const updated = await options.repository.reactToReviewThreadMessage(
          existing.id,
          reactionMatch[2]!,
          string(input.emoji, 'emoji'),
          userId ?? 'guest'
        );
        await emit(
          existing.projectId,
          'review_message.reacted',
          userId,
          'review_thread',
          existing.id,
          {}
        );
        return cors(request, json(updated));
      }
      const reviewMessageReadMatch =
        /^\/v1\/review-threads\/([^/]+)\/messages\/([^/]+)\/read$/.exec(url.pathname);
      if (request.method === 'POST' && reviewMessageReadMatch) {
        const input = await body(request);
        const existing = await options.repository.getReviewThread(reviewMessageReadMatch[1]!);
        if (!existing) throw new CollaborationError('NOT_FOUND', 'Review thread not found');
        const userId = await requireProjectAccess(request, existing.projectId, 'viewer');
        const updated = await options.repository.setReviewThreadMessageRead(
          existing.id,
          reviewMessageReadMatch[2]!,
          userId ?? 'guest',
          input.read !== false
        );
        return cors(request, json(updated));
      }
      const resolveReviewThreadId = idFrom(
        url.pathname,
        /^\/v1\/review-threads\/([^/]+)\/resolve$/
      );
      if (request.method === 'POST' && resolveReviewThreadId) {
        const existing = await options.repository.getReviewThread(resolveReviewThreadId);
        if (!existing) throw new CollaborationError('NOT_FOUND', 'Review thread not found');
        const userId = await requireProjectAccess(request, existing.projectId, 'commenter');
        const resolved = await options.repository.resolveReviewThread(
          resolveReviewThreadId,
          userId ?? 'guest',
          clock.now()
        );
        await emit(
          existing.projectId,
          'review_thread.resolved',
          userId,
          'review_thread',
          resolved.id,
          {}
        );
        return cors(request, json(resolved));
      }
      const reopenReviewThreadId = idFrom(url.pathname, /^\/v1\/review-threads\/([^/]+)\/reopen$/);
      if (request.method === 'POST' && reopenReviewThreadId) {
        const existing = await options.repository.getReviewThread(reopenReviewThreadId);
        if (!existing) throw new CollaborationError('NOT_FOUND', 'Review thread not found');
        const userId = await requireProjectAccess(request, existing.projectId, 'commenter');
        const reopened = await options.repository.reopenReviewThread(reopenReviewThreadId);
        await emit(
          existing.projectId,
          'review_thread.reopened',
          userId,
          'review_thread',
          reopened.id,
          {}
        );
        return cors(request, json(reopened));
      }
      const moveReviewThreadId = idFrom(url.pathname, /^\/v1\/review-threads\/([^/]+)\/move$/);
      if (request.method === 'POST' && moveReviewThreadId) {
        const input = await body(request);
        const existing = await options.repository.getReviewThread(moveReviewThreadId);
        if (!existing) throw new CollaborationError('NOT_FOUND', 'Review thread not found');
        const userId = await requireUserAuthorization(request, 'project:comment', {
          projectId: existing.projectId
        });
        const moved = await options.repository.moveReviewThread(
          moveReviewThreadId,
          spatialAnchor(input.anchor),
          userId,
          clock.now()
        );
        await emit(
          existing.projectId,
          'review_thread.moved',
          userId,
          'review_thread',
          moved.id,
          {}
        );
        return cors(request, json(moved));
      }
      const aiRequestProjectId = idFrom(
        url.pathname,
        /^\/v1\/projects\/([^/]+)\/ai-change-requests$/
      );
      if (request.method === 'POST' && aiRequestProjectId) {
        const input = await body(request);
        const userId = await requireUserAuthorization(request, 'project:design', {
          projectId: aiRequestProjectId
        });
        const anchor = spatialAnchor(input.anchor);
        const createdAt = clock.now();
        const changeRequest: AIChangeRequest = {
          id: string(input.id ?? options.ids.next('ai-change'), 'id'),
          projectId: aiRequestProjectId,
          anchor,
          instruction: string(input.instruction, 'instruction'),
          provider: providerSnapshot(input.provider),
          baseRevision: {
            id: anchor.evidence.revisionId,
            fingerprint: anchor.evidence.revisionFingerprint
          },
          lifecycle: 'queued',
          createdBy: userId,
          createdAt,
          updatedAt: createdAt
        };
        await options.repository.createAIChangeRequest(changeRequest);
        await emit(
          aiRequestProjectId,
          'ai_change_request.created',
          userId,
          'ai_change_request',
          changeRequest.id,
          {
            providerId: changeRequest.provider.providerId,
            revisionId: changeRequest.baseRevision.id
          }
        );
        return cors(request, json(changeRequest, 201));
      }
      if (request.method === 'GET' && aiRequestProjectId) {
        await requireUserAuthorization(request, 'project:read', { projectId: aiRequestProjectId });
        return cors(
          request,
          json({ requests: await options.repository.listAIChangeRequests(aiRequestProjectId) })
        );
      }
      const aiRequestId = idFrom(url.pathname, /^\/v1\/ai-change-requests\/([^/]+)$/);
      if (request.method === 'GET' && aiRequestId) {
        const existing = await options.repository.getAIChangeRequest(aiRequestId);
        if (!existing) throw new CollaborationError('NOT_FOUND', 'AI change request not found');
        await requireUserAuthorization(request, 'project:read', { projectId: existing.projectId });
        return cors(request, json(existing));
      }
      const aiTransitionId = idFrom(
        url.pathname,
        /^\/v1\/ai-change-requests\/([^/]+)\/transition$/
      );
      if (request.method === 'POST' && aiTransitionId) {
        const input = await body(request);
        const existing = await options.repository.getAIChangeRequest(aiTransitionId);
        if (!existing) throw new CollaborationError('NOT_FOUND', 'AI change request not found');
        const userId = await requireUserAuthorization(request, 'project:design', {
          projectId: existing.projectId
        });
        const action = input.action;
        const lifecycle: AIChangeRequestLifecycle =
          action === 'start'
            ? 'running'
            : action === 'apply'
              ? 'applied'
              : action === 'fail'
                ? 'failed'
                : action === 'cancel' || action === 'reject'
                  ? 'cancelled'
                  : action === 'retry'
                    ? 'queued'
                    : action === 'undo'
                      ? 'undone'
                      : (() => {
                          throw new CollaborationError(
                            'INVALID',
                            'action must be start, apply, fail, cancel, reject, retry, or undo'
                          );
                        })();
        const next: AIChangeRequest = {
          id: existing.id,
          projectId: existing.projectId,
          anchor: existing.anchor,
          instruction: existing.instruction,
          provider: existing.provider,
          baseRevision: existing.baseRevision,
          createdBy: existing.createdBy,
          createdAt: existing.createdAt,
          lifecycle,
          updatedAt: clock.now(),
          ...(lifecycle === 'applied'
            ? { result: changeResult(input.result) }
            : lifecycle === 'undone'
              ? (() => {
                  if (existing.result === undefined)
                    throw new CollaborationError(
                      'CONFLICT',
                      'Only an applied request can be undone'
                    );
                  return { result: existing.result, undoResult: changeResult(input.undoResult) };
                })()
              : {}),
          ...(lifecycle === 'failed'
            ? { failureReason: string(input.failureReason, 'failureReason') }
            : {})
        };
        const updated = await options.repository.updateAIChangeRequest(next);
        await emit(
          existing.projectId,
          'ai_change_request.transitioned',
          userId,
          'ai_change_request',
          updated.id,
          {
            action,
            lifecycle: updated.lifecycle
          }
        );
        return cors(request, json(updated));
      }
      const annotationProjectId = idFrom(
        url.pathname,
        /^\/v1\/projects\/([^/]+)\/developer-annotations$/
      );
      if (request.method === 'GET' && annotationProjectId) {
        await requireUserAuthorization(request, 'project:read', { projectId: annotationProjectId });
        return cors(
          request,
          json({
            annotations: await options.repository.listDeveloperAnnotations(annotationProjectId)
          })
        );
      }
      if (request.method === 'POST' && annotationProjectId) {
        const input = await body(request);
        const userId = await requireUserAuthorization(request, 'project:design', {
          projectId: annotationProjectId
        });
        const annotation: DeveloperAnnotation = {
          id: string(input.id ?? options.ids.next('developer-annotation'), 'id'),
          projectId: annotationProjectId,
          anchor: spatialAnchor(input.anchor),
          category:
            input.category === 'development' ||
            input.category === 'interaction' ||
            input.category === 'accessibility' ||
            input.category === 'content'
              ? input.category
              : (() => {
                  throw new CollaborationError(
                    'INVALID',
                    'category must be development, interaction, accessibility, or content'
                  );
                })(),
          body: string(input.body, 'body'),
          createdBy: userId,
          createdAt: clock.now()
        };
        await options.repository.createDeveloperAnnotation(annotation);
        await emit(
          annotationProjectId,
          'developer_annotation.created',
          userId,
          'developer_annotation',
          annotation.id,
          {}
        );
        return cors(request, json(annotation, 201));
      }
      if (request.method === 'POST' && threadProjectId) {
        const input = await body(request);
        const userId = await requireUserAuthorization(request, 'project:comment', {
          projectId: threadProjectId
        });
        const thread: Thread = {
          id: string(input.id ?? options.ids.next('thread'), 'id'),
          projectId: threadProjectId,
          revisionId: string(input.revisionId, 'revisionId'),
          reactNodeId: string(input.reactNodeId, 'reactNodeId'),
          scenarioId: string(input.scenarioId, 'scenarioId'),
          createdBy: userId,
          createdAt: clock.now()
        };
        await options.repository.createThread(thread);
        await emit(threadProjectId, 'thread.created', userId, 'thread', thread.id, {
          revisionId: thread.revisionId,
          reactNodeId: thread.reactNodeId,
          scenarioId: thread.scenarioId
        });
        return cors(request, json(thread, 201));
      }
      const commentThreadId = idFrom(url.pathname, /^\/v1\/threads\/([^/]+)\/comments$/);
      if (request.method === 'POST' && commentThreadId) {
        const input = await body(request);
        const parentThread = await options.repository.getThread(commentThreadId);
        if (!parentThread) throw new CollaborationError('NOT_FOUND', 'Thread not found');
        const userId = await requireProjectAccess(request, parentThread.projectId, 'commenter');
        const comment: Comment = {
          id: string(input.id ?? options.ids.next('comment'), 'id'),
          threadId: commentThreadId,
          ...(typeof input.parentCommentId === 'string'
            ? { parentCommentId: input.parentCommentId }
            : {}),
          body: string(input.body, 'body'),
          createdBy: userId ?? 'guest',
          createdAt: clock.now(),
          mentionedUserIds: strings(input.mentionedUserIds ?? [], 'mentionedUserIds')
        };
        await options.repository.createComment(comment);
        await emit(parentThread.projectId, 'comment.created', userId, 'comment', comment.id, {
          threadId: commentThreadId
        });
        return cors(request, json(comment, 201));
      }
      const resolveThreadId = idFrom(url.pathname, /^\/v1\/threads\/([^/]+)\/resolve$/);
      if (request.method === 'POST' && resolveThreadId) {
        const existing = await options.repository.getThread(resolveThreadId);
        if (!existing) throw new CollaborationError('NOT_FOUND', 'Thread not found');
        const userId = await requireProjectAccess(request, existing.projectId, 'commenter');
        const resolved = await options.repository.updateThreadResolution(
          resolveThreadId,
          userId ?? 'guest',
          clock.now()
        );
        await emit(existing.projectId, 'thread.resolved', userId, 'thread', resolved.id, {});
        return cors(request, json(resolved));
      }
      const reactionCommentId = idFrom(url.pathname, /^\/v1\/comments\/([^/]+)\/reactions$/);
      if (request.method === 'POST' && reactionCommentId) {
        const input = await body(request);
        const comment = await options.repository.getComment(reactionCommentId);
        const thread = comment ? await options.repository.getThread(comment.threadId) : undefined;
        if (!thread) throw new CollaborationError('NOT_FOUND', 'Comment not found');
        const userId = await requireUserAuthorization(request, 'project:comment', {
          projectId: thread.projectId
        });
        const reaction: Reaction = {
          commentId: reactionCommentId,
          userId,
          emoji: string(input.emoji, 'emoji'),
          createdAt: clock.now()
        };
        await options.repository.addReaction(reaction);
        await emit(
          thread.projectId,
          'reaction.added',
          reaction.userId,
          'comment',
          reactionCommentId,
          {
            emoji: reaction.emoji
          }
        );
        return cors(request, json(reaction, 201));
      }
      const approvalRevisionId = idFrom(url.pathname, /^\/v1\/revisions\/([^/]+)\/approvals$/);
      if (request.method === 'POST' && approvalRevisionId) {
        const input = await body(request);
        const revision = await options.repository.getRevision(approvalRevisionId);
        if (!revision) throw new CollaborationError('NOT_FOUND', 'Revision not found');
        const userId = await requireUserAuthorization(request, 'project:approve', {
          projectId: revision.projectId
        });
        const approval: Approval = {
          id: options.ids.next('approval'),
          revisionId: approvalRevisionId,
          userId,
          decision:
            input.decision === 'approved'
              ? 'approved'
              : input.decision === 'changes_requested'
                ? 'changes_requested'
                : (() => {
                    throw new CollaborationError(
                      'INVALID',
                      'decision must be approved or changes_requested'
                    );
                  })(),
          ...(typeof input.note === 'string' ? { note: input.note } : {}),
          createdAt: clock.now()
        };
        await options.repository.putApproval(approval);
        await emit(
          revision.projectId,
          'approval.updated',
          approval.userId,
          'revision',
          revision.id,
          {
            decision: approval.decision
          }
        );
        return cors(request, json(approval, 201));
      }
      const eventsProjectId = idFrom(url.pathname, /^\/v1\/projects\/([^/]+)\/events$/);
      if (request.method === 'GET' && eventsProjectId) {
        await requireProjectAccess(request, eventsProjectId, 'viewer');
        const after = cursor(url.searchParams.get('after') ?? request.headers.get('last-event-id'));
        const events = await options.repository.listEvents(
          eventsProjectId,
          after,
          limit(url.searchParams.get('limit'))
        );
        return cors(
          request,
          json({
            events,
            nextCursor: events.at(-1)?.cursor ?? after,
            hasMore: events.length === limit(url.searchParams.get('limit'))
          })
        );
      }
      const eventStreamProjectId = idFrom(
        url.pathname,
        /^\/v1\/projects\/([^/]+)\/events\/stream$/
      );
      if (request.method === 'GET' && eventStreamProjectId) {
        await requireProjectAccess(request, eventStreamProjectId, 'viewer');
        const after = cursor(url.searchParams.get('after') ?? request.headers.get('last-event-id'));
        const initial = await options.repository.listEvents(eventStreamProjectId, after, 500);
        const encoder = new TextEncoder();
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        let lastCursor = after;
        const write = (event: import('./index.js').CollaborationEvent) => {
          if (!controller || event.cursor <= lastCursor) return;
          lastCursor = event.cursor;
          controller.enqueue(
            encoder.encode(`id: ${event.cursor}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`)
          );
        };
        const stream = new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
            for (const event of initial) write(event);
            const projectSubscribers = subscribers.get(eventStreamProjectId) ?? new Set();
            projectSubscribers.add(write);
            subscribers.set(eventStreamProjectId, projectSubscribers);
          },
          cancel() {
            const projectSubscribers = subscribers.get(eventStreamProjectId);
            projectSubscribers?.delete(write);
            if (projectSubscribers?.size === 0) subscribers.delete(eventStreamProjectId);
          }
        });
        return cors(
          request,
          new Response(stream, {
            headers: {
              'cache-control': 'no-cache',
              connection: 'keep-alive',
              'content-type': 'text/event-stream; charset=utf-8',
              'x-accel-buffering': 'no'
            }
          })
        );
      }
      const exportProjectId = idFrom(url.pathname, /^\/v1\/projects\/([^/]+)\/export$/);
      if (request.method === 'GET' && exportProjectId) {
        await requireProjectAccess(request, exportProjectId, 'viewer');
        const snapshot = await options.repository.exportProject(exportProjectId);
        if (!snapshot) throw new CollaborationError('NOT_FOUND', 'Project not found');
        return cors(
          request,
          new Response(serializeSnapshot(snapshot), {
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'content-disposition': `attachment; filename="${exportProjectId}.selene-collaboration.json"`
            }
          })
        );
      }
      if (request.method === 'POST' && url.pathname === '/v1/import') {
        const snapshot = await readSnapshot(request, maximumSnapshotBytes);
        const existing = await options.repository.getProject(snapshot.project.id);
        const userId = await requireUserAuthorization(
          request,
          existing ? 'project:design' : 'organization:create-project',
          existing
            ? { projectId: snapshot.project.id }
            : { organizationId: snapshot.project.organizationId }
        );
        await options.repository.replaceProject(snapshot);
        await emit(
          snapshot.project.id,
          'project.imported',
          userId,
          'project',
          snapshot.project.id,
          {}
        );
        return cors(request, json({ projectId: snapshot.project.id, imported: true }, 201));
      }
      if (request.method === 'POST' && url.pathname === '/v1/sync') {
        const snapshot = await readSnapshot(request, maximumSnapshotBytes);
        const existing = await options.repository.exportProject(snapshot.project.id);
        const userId = await requireUserAuthorization(
          request,
          existing ? 'project:design' : 'organization:create-project',
          existing
            ? { projectId: snapshot.project.id }
            : { organizationId: snapshot.project.organizationId }
        );
        await options.repository.replaceProject(snapshot);
        await emit(
          snapshot.project.id,
          'project.synchronized',
          userId,
          'project',
          snapshot.project.id,
          {
            replaced: existing !== undefined,
            revisions: snapshot.revisions.length
          }
        );
        return cors(
          request,
          json({
            projectId: snapshot.project.id,
            synchronized: true,
            replaced: existing !== undefined,
            revisions: snapshot.revisions.length
          })
        );
      }
      const shareLinkId = idFrom(url.pathname, /^\/v1\/share-links\/([^/]+)$/);
      if (request.method === 'DELETE' && shareLinkId) {
        const link = await options.repository.getShareLink(shareLinkId);
        if (!link) throw new CollaborationError('NOT_FOUND', 'Share link not found');
        const userId = await requireUserAuthorization(request, 'project:manage-sharing', {
          projectId: link.projectId
        });
        await options.repository.revokeShareLink(shareLinkId, clock.now());
        await emit(link.projectId, 'share_link.revoked', userId, 'share_link', shareLinkId, {});
        return cors(request, new Response(null, { status: 204 }));
      }
      const projectId = idFrom(url.pathname, /^\/v1\/projects\/([^/]+)$/);
      if (request.method === 'DELETE' && projectId) {
        const project = await options.repository.getProject(projectId);
        if (!project) throw new CollaborationError('NOT_FOUND', 'Project not found');
        const userId = await requireUserAuthorization(request, 'project:delete', { projectId });
        await emit(projectId, 'project.deleted', userId, 'project', projectId, {});
        await options.repository.deleteProject(projectId);
        return cors(request, new Response(null, { status: 204 }));
      }
      return cors(request, json({ error: 'not_found' }, 404));
    } catch (error) {
      metrics.errors += 1;
      if (error instanceof CollaborationError) {
        const status =
          error.code === 'NOT_FOUND'
            ? 404
            : error.code === 'CONFLICT'
              ? 409
              : error.code === 'FORBIDDEN'
                ? 403
                : 400;
        return cors(
          request,
          json({ error: error.code.toLowerCase(), message: error.message }, status)
        );
      }
      return cors(request, json({ error: 'internal_error' }, 500));
    }
  };
}
