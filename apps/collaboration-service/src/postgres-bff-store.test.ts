import { describe, expect, it } from 'vitest';

import { BunPostgresBffStore } from './postgres-bff-store';

describe('PostgreSQL BFF store', () => {
  it('hashes opaque IDs and consumes a transaction exactly once with DELETE RETURNING', async () => {
    const calls: { readonly statement: string; readonly values: readonly unknown[] }[] = [];
    let available = true;
    const sql = (async (parts: TemplateStringsArray, ...values: readonly unknown[]) => {
      const statement = parts.join('?');
      calls.push({ statement, values });
      if (statement.includes('DELETE FROM oidc_bff_transactions')) {
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
      return [];
    }) as unknown as Bun.SQL;
    const store = new BunPostgresBffStore(sql);
    const rawId = 'transaction-12345678901234567890';
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
      calls.find((call) => call.statement.includes('DELETE FROM oidc_bff_transactions'))?.statement
    ).toContain('RETURNING');
  });
});
