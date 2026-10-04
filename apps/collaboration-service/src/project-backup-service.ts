import { CollaborationError, type CollaborationHostContextFactory } from '@selene/collaboration';
import type { CollaborationAuthorizer } from '@selene/collaboration/service';
import type { IdentityProvider } from './auth.js';
import {
  PROJECT_BACKUP_LIMITS,
  type ProjectBackup,
  type ProjectRestoreReceipt
} from './project-backup-contract.js';

export interface ProjectBackupStore {
  backup(
    projectId: string,
    restoreOwnerId: string,
    retentionDays: number,
    context?: import('@selene/collaboration').CollaborationHostContext
  ): Promise<ProjectBackup>;
  restore(
    backup: unknown,
    expectedRevisionId: string,
    actorId: string,
    context?: import('@selene/collaboration').CollaborationHostContext
  ): Promise<ProjectRestoreReceipt>;
}
export interface ProjectBackupHttpOptions {
  readonly store: ProjectBackupStore;
  readonly authorizer: CollaborationAuthorizer;
  readonly identityProvider: IdentityProvider;
  readonly hostContextFactory: CollaborationHostContextFactory;
  readonly allowedOrigins: readonly string[];
}
async function knownOutcome<T>(
  operation: () => Promise<T>
): Promise<
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ConstructorParameters<typeof CollaborationError>[0] }
> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof CollaborationError) return { ok: false, code: error.code };
    throw error;
  }
}
function result<T>(
  outcome:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly code: ConstructorParameters<typeof CollaborationError>[0] }
): T {
  if (!outcome.ok) throw new CollaborationError(outcome.code, 'Project recovery failed');
  return outcome.value;
}
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json') || request.body === null)
    throw new CollaborationError('INVALID', 'Backup request must contain JSON');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Every streamed chunk is bounded before the next read.
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > PROJECT_BACKUP_LIMITS.bytes + 4096)
        throw new CollaborationError('INVALID', 'Backup request exceeds the supported size');
      chunks.push(chunk.value);
    }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    } catch {
      throw new CollaborationError('INVALID', 'Backup request is invalid');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Compose alongside ordinary collaboration routes; authenticate through the same trusted provider. */
export function createProjectBackupHttpHandler(options: ProjectBackupHttpOptions) {
  return {
    async fetch(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      const match = /^\/v1\/projects\/([^/]+)\/(backup|restore)$/.exec(url.pathname);
      if (match === null) return undefined;
      let projectId: string;
      try {
        projectId = decodeURIComponent(match[1] ?? '');
      } catch {
        return Response.json({ error: 'invalid' }, { status: 400 });
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectId))
        return Response.json({ error: 'invalid' }, { status: 400 });
      const origin = request.headers.get('origin');
      const headers = new Headers({
        'cache-control': 'no-store',
        'content-type': 'application/json'
      });
      if (origin !== null && origin !== url.origin && !options.allowedOrigins.includes(origin))
        return Response.json({ error: 'forbidden' }, { status: 403, headers });
      if (origin !== null) {
        headers.set('access-control-allow-origin', origin);
        headers.set('access-control-allow-credentials', 'true');
        headers.set('vary', 'Origin');
      }
      if (request.method === 'OPTIONS') {
        headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
        headers.set('access-control-allow-headers', 'content-type');
        return new Response(null, { status: 204, headers });
      }
      const context = options.hostContextFactory.create({
        signal: request.signal,
        timeoutMs: 15_000
      });
      try {
        const actorId = await options.identityProvider.authenticate(request);
        if (
          actorId === undefined ||
          !(await context.runPort(options.authorizer, 'authorize', () =>
            options.authorizer.authorize(
              { userId: actorId, action: 'project:restore', projectId },
              context
            )
          ))
        )
          throw new CollaborationError(
            'FORBIDDEN',
            'Project recovery requires owner or admin access'
          );
        if (request.method === 'GET' && match[2] === 'backup') {
          const retentionDays = Number(url.searchParams.get('retentionDays') ?? 30);
          const backup = result(
            await context.runPort(options.store, 'backup', () =>
              knownOutcome(() => options.store.backup(projectId, actorId, retentionDays, context))
            )
          );
          return Response.json(backup, { headers });
        }
        if (request.method === 'POST' && match[2] === 'restore') {
          const value = await body(request);
          if (value === null || typeof value !== 'object' || Array.isArray(value))
            throw new CollaborationError('INVALID', 'Restore request is invalid');
          const input = value as Record<string, unknown>;
          if (
            Object.keys(input).length !== 2 ||
            !Object.hasOwn(input, 'backup') ||
            typeof input.expectedRevisionId !== 'string'
          )
            throw new CollaborationError(
              'INVALID',
              'Restore requires a backup and current revision'
            );
          const backup = input.backup;
          if (
            backup === null ||
            typeof backup !== 'object' ||
            Array.isArray(backup) ||
            (backup as { document?: { projectId?: unknown } }).document?.projectId !== projectId
          )
            throw new CollaborationError('INVALID', 'Restore project identity is invalid');
          const expectedRevisionId = input.expectedRevisionId;
          const receipt = result(
            await context.runPort(options.store, 'restore', () =>
              knownOutcome(() =>
                options.store.restore(backup, expectedRevisionId, actorId, context)
              )
            )
          );
          return Response.json(receipt, { headers });
        }
        return Response.json({ error: 'method_not_allowed' }, { status: 405, headers });
      } catch (error) {
        const code = error instanceof CollaborationError ? error.code : undefined;
        return Response.json(
          {
            error:
              code === 'FORBIDDEN'
                ? 'forbidden'
                : code === 'CONFLICT'
                  ? 'conflict'
                  : code === 'NOT_FOUND'
                    ? 'not_found'
                    : code === 'INVALID' || code === 'EXPIRED' || error instanceof SyntaxError
                      ? 'invalid_backup'
                      : 'recovery_unavailable'
          },
          {
            status:
              code === 'FORBIDDEN'
                ? 403
                : code === 'CONFLICT'
                  ? 409
                  : code === 'NOT_FOUND'
                    ? 404
                    : code === 'INVALID' || code === 'EXPIRED' || error instanceof SyntaxError
                      ? 400
                      : 503,
            headers
          }
        );
      } finally {
        context.dispose();
      }
    }
  };
}
