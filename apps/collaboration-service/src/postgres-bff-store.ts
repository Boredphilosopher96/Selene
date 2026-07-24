import { createHash } from 'node:crypto';

import type {
  HostedBffSession,
  HostedBffStore,
  OidcAuthorizationTransaction,
  OidcTokenSet
} from '@selene/identity-runtime';

type Row = Record<string, unknown>;

function hashOpaqueId(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function json(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function transaction(row: Row): OidcAuthorizationTransaction {
  return {
    // The raw transaction ID is intentionally not recoverable from PostgreSQL.
    id: '',
    state: '',
    nonce: String(row.nonce),
    codeVerifier: String(row.code_verifier),
    redirectUri: String(row.redirect_uri),
    returnTo: String(row.return_to),
    expiresAt: new Date(String(row.expires_at)).getTime()
  };
}

function session(row: Row): HostedBffSession {
  return {
    id: '',
    subject: String(row.subject),
    tokens: json(row.tokens) as OidcTokenSet,
    expiresAt: new Date(String(row.expires_at)).getTime()
  };
}

/**
 * Durable OIDC BFF storage. `consumeTransaction` is one DELETE ... RETURNING
 * predicate, making callback consumption atomic across restarts and instances.
 * Database/KMS encryption at rest is required for the short-lived verifier and
 * revocable server-side tokens; no application crypto is implemented here.
 */
export class BunPostgresBffStore implements HostedBffStore {
  public constructor(private readonly sql: Bun.SQL) {}

  async createTransaction(value: OidcAuthorizationTransaction): Promise<void> {
    await this.sql`
      INSERT INTO oidc_bff_transactions
        (id_hash, nonce, code_verifier, redirect_uri, return_to, expires_at)
      VALUES
        (${hashOpaqueId(value.id)}, ${value.nonce}, ${value.codeVerifier}, ${value.redirectUri},
         ${value.returnTo}, ${new Date(value.expiresAt).toISOString()})`;
  }

  async consumeTransaction(id: string): Promise<OidcAuthorizationTransaction | undefined> {
    const rows = await this.sql<Row[]>`
      DELETE FROM oidc_bff_transactions
      WHERE id_hash = ${hashOpaqueId(id)} AND expires_at > now()
      RETURNING nonce, code_verifier, redirect_uri, return_to, expires_at`;
    const row = rows[0];
    if (!row) return undefined;
    // BFF validation needs the raw state, which is the cookie-provided value.
    return { ...transaction(row), id, state: id };
  }

  async createSession(value: HostedBffSession): Promise<void> {
    await this.sql`
      INSERT INTO oidc_bff_sessions (id_hash, subject, tokens, expires_at)
      VALUES (${hashOpaqueId(value.id)}, ${value.subject}, ${JSON.stringify(value.tokens)}::jsonb,
              ${new Date(value.expiresAt).toISOString()})`;
  }

  async readSession(id: string): Promise<HostedBffSession | undefined> {
    const rows = await this.sql<Row[]>`
      SELECT subject, tokens, expires_at FROM oidc_bff_sessions
      WHERE id_hash = ${hashOpaqueId(id)} AND expires_at > now()`;
    const row = rows[0];
    return row ? { ...session(row), id } : undefined;
  }

  async revokeSession(id: string): Promise<void> {
    await this.sql`DELETE FROM oidc_bff_sessions WHERE id_hash = ${hashOpaqueId(id)}`;
  }
}
