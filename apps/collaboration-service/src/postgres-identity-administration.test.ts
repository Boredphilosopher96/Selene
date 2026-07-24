import { describe, expect, it } from 'vitest';

import { BunPostgresCollaborationRepository } from './postgres-repository';

describe('PostgreSQL identity administration adapter', () => {
  it('uses a transaction-scoped repository and checks expiry-bound break-glass access', async () => {
    const calls: string[] = [];
    const sql = (async (parts: TemplateStringsArray) => {
      const statement = parts.join('?');
      calls.push(statement);
      if (statement.includes('SELECT allow_invited_guests')) return [];
      if (statement.includes('break_glass_recoveries')) return [{ role: 'owner' }];
      return [];
    }) as unknown as Bun.SQL;
    sql.transaction = async (operation) => operation(sql);
    const repository = new BunPostgresCollaborationRepository(sql);

    await repository.transaction(async (unit) => {
      expect(unit).not.toBe(repository);
      await expect(unit.readGuestReviewPolicy('org-1')).resolves.toEqual({
        organizationId: 'org-1',
        allowInvitedGuests: false
      });
    });
    await expect(
      repository.authorize({
        userId: 'user-1',
        projectId: 'project-1',
        action: 'project:delete'
      })
    ).resolves.toBe(true);
    const authorization = calls.find((statement) => statement.includes('break_glass_recoveries'));
    expect(authorization).toContain('b.expires_at > now()');
    expect(authorization).toContain('b.revoked_at IS NULL');
  });

  it('fails closed when an unbound provider subject belongs to multiple organizations', async () => {
    const calls: string[] = [];
    const sql = (async (parts: TemplateStringsArray) => {
      const statement = parts.join('?');
      calls.push(statement);
      return [
        { id: 'user-a', organization_id: 'org-a', access_version: 1 },
        { id: 'user-b', organization_id: 'org-b', access_version: 1 }
      ];
    }) as unknown as Bun.SQL;
    const repository = new BunPostgresCollaborationRepository(sql);
    await expect(
      repository.resolveBffIdentity({
        id: 'session-1',
        subject: 'issuer|same-subject',
        expiresAt: Date.now() + 60_000,
        tokens: { subjectKey: 'issuer|same-subject', claims: { sub: 'same-subject' }, expiresAt: 1 }
      })
    ).resolves.toBeUndefined();
    expect(calls[0]).toContain('LIMIT 2');
  });

  it('rejects membership and recovery writes when the subject is not in the target organization', async () => {
    const sql = (async () => []) as unknown as Bun.SQL;
    const repository = new BunPostgresCollaborationRepository(sql);
    await expect(
      repository.upsertMembership({
        organizationId: 'org-a',
        subjectId: 'user-from-org-b',
        role: 'viewer'
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      repository.recordBreakGlassRecovery(
        {
          organizationId: 'org-a',
          subjectId: 'user-from-org-b',
          caseId: 'INC-123',
          reason: 'The actual organization owner is unavailable today.',
          expiresAt: '2030-01-01T00:00:00Z'
        },
        'admin-a'
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('reports a zero-row conditional invitation transition to its transaction caller', async () => {
    const sql = (async () => []) as unknown as Bun.SQL;
    const repository = new BunPostgresCollaborationRepository(sql);
    await expect(
      repository.acceptInvitation('invite-raced', 'user-1', '2026-07-24T12:00:00Z')
    ).resolves.toBe(false);
  });
});
