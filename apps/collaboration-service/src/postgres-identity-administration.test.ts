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
});
