import {
  collaborationFormat,
  type Approval,
  type CollaborationRepository,
  type Comment,
  CollaborationError,
  type DesignReadinessInput,
  idempotent,
  parseSnapshot,
  type Project,
  type Reaction,
  type Revision,
  type SemanticDesignChangeInput,
  serializeSnapshot,
  createSignedShareToken,
  type CollaborationAction,
  verifySignedShareToken,
  type SharePermission,
  type ShareTokenSigner,
  type Thread
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
  /** Optional signer enables time-limited guest share URLs without a database dependency. */
  readonly shareSigner?: ShareTokenSigner;
}

interface Metrics {
  requests: number;
  rejected: number;
  errors: number;
}

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

async function body(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CollaborationError('INVALID', 'Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new CollaborationError('INVALID', `${field} is required`);
  return value;
}

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
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
  if (!Array.isArray(value))
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
        const snapshot = parseSnapshot(await request.text());
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
        const snapshot = parseSnapshot(await request.text());
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
