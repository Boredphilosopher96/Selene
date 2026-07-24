import { createHash } from 'node:crypto';

import type {
  HostedBffSession,
  HostedBffSessionAccess,
  HostedBffStore,
  OidcAuthorizationTransaction,
  OidcTokenSet
} from '@selene/identity-runtime';

type Row = Record<string, unknown>;

function hashOpaqueId(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function json(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length > 65_536) throw new Error('OIDC token JSON is too large');
  return JSON.parse(value);
}

function transaction(row: Row): OidcAuthorizationTransaction {
  return {
    // The raw transaction ID is intentionally not recoverable from PostgreSQL.
    id: '',
    state: '',
    nonce: row.nonce as string,
    codeVerifier: row.code_verifier as string,
    redirectUri: row.redirect_uri as string,
    returnTo: row.return_to as string,
    expiresAt: timestamp(row.expires_at)
  };
}

function session(row: Row): HostedBffSession {
  const organizationId = row.organization_id;
  const accessVersion = row.access_version;
  return {
    id: '',
    subject: row.subject as string,
    tokens: json(row.tokens) as OidcTokenSet,
    expiresAt: timestamp(row.expires_at),
    ...(organizationId === null || organizationId === undefined
      ? {}
      : { organizationId: organizationId as string }),
    ...(accessVersion === null || accessVersion === undefined
      ? {}
      : { accessVersion: accessVersion as number })
  };
}

function timestamp(value: unknown): number {
  const parsed =
    value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error('OIDC database timestamp is invalid');
  return parsed;
}

function snapshotRow(value: unknown): Row {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error('OIDC database row is invalid');
  if (Reflect.ownKeys(value).length > 16) throw new Error('OIDC database row is invalid');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !('value' in descriptor)))
    throw new Error('OIDC database row is invalid');
  return Object.freeze(
    Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
    )
  );
}

function oneRow(value: unknown): Row | undefined {
  if (!Array.isArray(value) || value.length > 1) throw new Error('OIDC database result is invalid');
  return value.length === 0 ? undefined : snapshotRow(value[0]);
}

function mutationCount(value: unknown): number {
  if (!Array.isArray(value) || value.length > 1) throw new Error('OIDC database result is invalid');
  if (value.length === 0) return 0;
  snapshotRow(value[0]);
  return 1;
}

/**
 * Durable OIDC BFF storage. `consumeTransaction` is one DELETE ... RETURNING
 * predicate, making callback consumption atomic across restarts and instances.
 * Database/KMS encryption at rest is required for the short-lived verifier and
 * revocable server-side tokens; no application crypto is implemented here.
 */
export class BunPostgresBffStore implements HostedBffStore {
  public constructor(private readonly sql: Bun.SQL) {}

  async createTransaction(
    value: OidcAuthorizationTransaction,
    signal?: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal);
    await this.cleanupExpired();
    throwIfAborted(signal);
    await this.sql`
      INSERT INTO oidc_bff_transactions
        (id_hash, nonce, code_verifier, redirect_uri, return_to, expires_at)
      VALUES
        (${hashOpaqueId(value.id)}, ${value.nonce}, ${value.codeVerifier}, ${value.redirectUri},
         ${value.returnTo}, ${new Date(value.expiresAt).toISOString()})`;
  }

  async consumeTransaction(
    id: string,
    signal?: AbortSignal
  ): Promise<OidcAuthorizationTransaction | undefined> {
    throwIfAborted(signal);
    await this.cleanupExpired();
    throwIfAborted(signal);
    const rows = await this.sql<Row[]>`
      DELETE FROM oidc_bff_transactions
      WHERE id_hash = ${hashOpaqueId(id)} AND expires_at > now()
      RETURNING nonce, code_verifier, redirect_uri, return_to, expires_at`;
    const result = oneRow(rows);
    if (!result) return undefined;
    // BFF validation needs the raw state, which is the cookie-provided value.
    return { ...transaction(result), id, state: id };
  }

  async createSession(value: HostedBffSession, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await this.cleanupExpired();
    throwIfAborted(signal);
    await this.sql`
      INSERT INTO oidc_bff_sessions
        (id_hash, subject, tokens, expires_at, organization_id, access_version)
      VALUES (${hashOpaqueId(value.id)}, ${value.subject}, ${JSON.stringify(value.tokens)}::jsonb,
              ${new Date(value.expiresAt).toISOString()}, ${value.organizationId ?? null},
              ${value.accessVersion ?? null})`;
  }

  async readSession(id: string, signal?: AbortSignal): Promise<HostedBffSession | undefined> {
    throwIfAborted(signal);
    await this.cleanupExpired();
    throwIfAborted(signal);
    const rows = await this.sql<Row[]>`
      SELECT subject, tokens, expires_at, organization_id, access_version FROM oidc_bff_sessions
      WHERE id_hash = ${hashOpaqueId(id)} AND revoked_at IS NULL AND expires_at > now()`;
    const result = oneRow(rows);
    return result ? { ...session(result), id } : undefined;
  }

  async consumeSession(id: string, signal?: AbortSignal): Promise<HostedBffSession | undefined> {
    throwIfAborted(signal);
    await this.cleanupExpired();
    throwIfAborted(signal);
    const rows = await this.sql<Row[]>`
      UPDATE oidc_bff_sessions
      SET revoked_at = now()
      WHERE id_hash = ${hashOpaqueId(id)} AND revoked_at IS NULL AND expires_at > now()
      RETURNING subject, tokens, expires_at, organization_id, access_version`;
    const result = oneRow(rows);
    return result ? { ...session(result), id } : undefined;
  }

  async bindSessionAccess(
    id: string,
    access: HostedBffSessionAccess,
    signal?: AbortSignal
  ): Promise<boolean> {
    throwIfAborted(signal);
    await this.cleanupExpired();
    throwIfAborted(signal);
    const rows = await this.sql<Row[]>`
      UPDATE oidc_bff_sessions
      SET organization_id = ${access.organizationId}, access_version = ${access.accessVersion}
      WHERE id_hash = ${hashOpaqueId(id)}
        AND organization_id IS NULL
        AND access_version IS NULL
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING id_hash`;
    return mutationCount(rows) === 1;
  }

  async revokeSession(id: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await this.cleanupExpired();
    throwIfAborted(signal);
    await this.sql`
      UPDATE oidc_bff_sessions SET revoked_at = now()
      WHERE id_hash = ${hashOpaqueId(id)} AND revoked_at IS NULL`;
  }

  private async cleanupExpired(): Promise<void> {
    await this.sql`
      DELETE FROM oidc_bff_transactions
      WHERE ctid IN (
        SELECT ctid FROM oidc_bff_transactions WHERE expires_at <= now() LIMIT 128
      )`;
    await this.sql`
      DELETE FROM oidc_bff_sessions
      WHERE ctid IN (
        SELECT ctid FROM oidc_bff_sessions WHERE expires_at <= now() LIMIT 128
      )`;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('OIDC PostgreSQL operation aborted');
}
