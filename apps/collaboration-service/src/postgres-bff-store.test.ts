import { describe, expect, it } from 'vitest';

import { BunPostgresBffStore } from './postgres-bff-store';

describe('PostgreSQL BFF store', () => {
  it('hashes opaque IDs and atomically consumes transactions and revokes logout sessions', async () => {
    const calls: { readonly statement: string; readonly values: readonly unknown[] }[] = [];
    let available = true;
    let sessionAvailable = true;
    let bindings = 0;
    const sql = (async (parts: TemplateStringsArray, ...values: readonly unknown[]) => {
      const statement = parts.join('?');
      calls.push({ statement, values });
      if (
        statement.includes('DELETE FROM oidc_bff_transactions') &&
        statement.includes('RETURNING')
      ) {
        if (!available) return [];
        available = false;
        return [
          {
            nonce: 'nonce',
            code_verifier: 'verifier',
            redirect_uri: 'https://app.example.test/auth/callback',
            return_to: '/',
            expires_at: '2030-01-01T00:00:00.000Z'
          }
        ];
      }
      if (statement.includes('DELETE FROM oidc_bff_sessions') && statement.includes('RETURNING')) {
        if (!sessionAvailable) return [];
        sessionAvailable = false;
        return [
          {
            subject: 'issuer|subject',
            tokens: { subjectKey: 'issuer|subject', claims: { sub: 'subject' }, expiresAt: 1 },
            expires_at: '2030-01-01T00:00:00.000Z',
            organization_id: null,
            access_version: null
          }
        ];
      }
      if (statement.includes('SET revoked_at = now()')) {
        if (!sessionAvailable) return [];
        sessionAvailable = false;
        return [
          {
            subject: 'issuer|subject',
            tokens: { subjectKey: 'issuer|subject', claims: { sub: 'subject' }, expiresAt: 1 },
            expires_at: '2030-01-01T00:00:00.000Z',
            organization_id: null,
            access_version: null
          }
        ];
      }
      if (statement.includes('SELECT subject, tokens, expires_at')) {
        return [
          {
            subject: 'issuer|subject',
            tokens: { subjectKey: 'issuer|subject', claims: { sub: 'subject' }, expiresAt: 1 },
            expires_at: '2030-01-01T00:00:00.000Z',
            organization_id: '10000000-0000-4000-8000-000000000001',
            access_version: 4
          }
        ];
      }
      if (statement.includes('UPDATE oidc_bff_sessions')) {
        bindings += 1;
        return bindings === 1 ? [{ id_hash: 'hash' }] : [];
      }
      return [];
    }) as unknown as Bun.SQL;
    const store = new BunPostgresBffStore(sql);
    const rawId = 'transaction-12345678901234567890';
    await expect(
      store.readSession('session-12345678901234567890', AbortSignal.abort())
    ).rejects.toThrow('aborted');
    expect(calls).toHaveLength(0);
    await store.createTransaction({
      id: rawId,
      state: rawId,
      nonce: 'nonce',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example.test/auth/callback',
      returnTo: '/',
      expiresAt: Date.parse('2030-01-01T00:00:00.000Z')
    });
    const consumed = await Promise.all([
      store.consumeTransaction(rawId),
      store.consumeTransaction(rawId)
    ]);
    expect(consumed.filter(Boolean)).toHaveLength(1);
    expect(consumed[0] ?? consumed[1]).toMatchObject({ id: rawId, state: rawId });
    const inserted = calls.find((call) =>
      call.statement.includes('INSERT INTO oidc_bff_transactions')
    );
    expect(inserted?.values).not.toContain(rawId);
    expect(inserted?.values[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(
      calls.find(
        (call) =>
          call.statement.includes('DELETE FROM oidc_bff_transactions') &&
          call.statement.includes('RETURNING')
      )?.statement
    ).toContain('expires_at > now()');
    expect(calls.some((call) => call.statement.includes('WHERE expires_at <= now()'))).toBe(true);

    await store.createSession({
      id: 'session-12345678901234567890',
      subject: 'issuer|subject',
      tokens: { subjectKey: 'issuer|subject', claims: { sub: 'subject' }, expiresAt: 1 },
      expiresAt: Date.parse('2030-01-01T00:00:00.000Z')
    });
    await expect(
      store.bindSessionAccess('session-12345678901234567890', {
        organizationId: '10000000-0000-4000-8000-000000000001',
        accessVersion: 4
      })
    ).resolves.toBe(true);
    await expect(
      store.bindSessionAccess('session-12345678901234567890', {
        organizationId: '10000000-0000-4000-8000-000000000002',
        accessVersion: 5
      })
    ).resolves.toBe(false);
    await expect(store.readSession('session-12345678901234567890')).resolves.toMatchObject({
      organizationId: '10000000-0000-4000-8000-000000000001',
      accessVersion: 4
    });
    const consumedSessions = await Promise.all([
      store.consumeSession('session-12345678901234567890'),
      store.consumeSession('session-12345678901234567890')
    ]);
    expect(consumedSessions.filter(Boolean)).toHaveLength(1);
    expect(consumedSessions[0] ?? consumedSessions[1]).toMatchObject({
      id: 'session-12345678901234567890',
      subject: 'issuer|subject'
    });
    expect(
      calls.find((call) => call.statement.includes('SET revoked_at = now()'))?.statement
    ).toContain('RETURNING');
    expect(
      calls.find((call) => call.statement.includes('UPDATE oidc_bff_sessions'))?.statement
    ).toContain('revoked_at IS NULL');
    expect(
      calls.find((call) => call.statement.includes('UPDATE oidc_bff_sessions'))?.statement
    ).toContain('organization_id IS NULL');
    expect(
      calls.find((call) => call.statement.includes('UPDATE oidc_bff_sessions'))?.statement
    ).toContain('access_version IS NULL');
    expect(
      calls.find((call) => call.statement.includes('UPDATE oidc_bff_sessions'))?.statement
    ).toContain('expires_at > now()');
    expect(
      calls.find((call) => call.statement.includes('SELECT subject, tokens, expires_at'))?.statement
    ).toContain('expires_at > now()');
  });
});
