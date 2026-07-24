import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCollaborationApplication } from './app.js';
import { readServiceEnvironment } from './env.js';
import { BunPostgresCollaborationRepository } from './postgres-repository.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('PostgreSQL integration requires DATABASE_URL');

const ids = {
  organizationA: '10000000-0000-4000-8000-000000000001',
  organizationB: '10000000-0000-4000-8000-000000000002',
  userA: '20000000-0000-4000-8000-000000000001',
  userB: '20000000-0000-4000-8000-000000000002',
  projectA: '30000000-0000-4000-8000-000000000001',
  projectB: '30000000-0000-4000-8000-000000000002',
  revisionA1: '40000000-0000-4000-8000-000000000001',
  revisionB1: '40000000-0000-4000-8000-000000000002',
  baseline: '50000000-0000-4000-8000-000000000001',
  thread: '60000000-0000-4000-8000-000000000001',
  reviewThread: '60000000-0000-4000-8000-000000000002',
  aiRequest: '60000000-0000-4000-8000-000000000003',
  annotation: '60000000-0000-4000-8000-000000000004',
  comment: '70000000-0000-4000-8000-000000000001',
  change: '80000000-0000-4000-8000-000000000001'
} as const;

const firstFingerprint = 'a'.repeat(64);
const secondFingerprint = 'b'.repeat(64);

const environment = readServiceEnvironment({
  ...process.env,
  COLLABORATION_STORE: 'postgres',
  DATABASE_URL: databaseUrl,
  CORS_ORIGINS: 'https://review.example.test',
  COLLABORATION_SHARE_SECRET: process.env.COLLABORATION_SHARE_SECRET ?? 'a'.repeat(32),
  COLLABORATION_PROXY_SECRET: process.env.COLLABORATION_PROXY_SECRET ?? 'p'.repeat(32)
});
const headers = {
  'content-type': 'application/json',
  'x-selene-user-id': ids.userA,
  'x-selene-proxy-secret': environment.proxySecret
};

const sql = new Bun.SQL(databaseUrl);
const repository = new BunPostgresCollaborationRepository(sql);
const application = createCollaborationApplication(environment, repository, repository, repository);

async function clearProject(projectId: string): Promise<void> {
  await sql`DELETE FROM collaboration_events WHERE project_id = ${projectId}`;
  await sql`DELETE FROM developer_annotations WHERE project_id = ${projectId}`;
  await sql`DELETE FROM ai_change_requests WHERE project_id = ${projectId}`;
  await sql`DELETE FROM review_threads WHERE project_id = ${projectId}`;
  await sql`DELETE FROM design_baseline_changes WHERE project_id = ${projectId}`;
  await sql`DELETE FROM design_review_states WHERE project_id = ${projectId}`;
  await sql`DELETE FROM design_baselines WHERE project_id = ${projectId}`;
  await sql`DELETE FROM comment_reactions WHERE comment_id IN (SELECT c.id FROM comments c JOIN threads t ON t.id = c.thread_id WHERE t.project_id = ${projectId})`;
  await sql`DELETE FROM comment_mentions WHERE comment_id IN (SELECT c.id FROM comments c JOIN threads t ON t.id = c.thread_id WHERE t.project_id = ${projectId})`;
  await sql`DELETE FROM comments WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ${projectId})`;
  await sql`DELETE FROM threads WHERE project_id = ${projectId}`;
  await sql`DELETE FROM approvals WHERE revision_id IN (SELECT id FROM revisions WHERE project_id = ${projectId})`;
  await sql`DELETE FROM revisions WHERE project_id = ${projectId}`;
  await sql`DELETE FROM share_links WHERE project_id = ${projectId}`;
  await sql`DELETE FROM idempotency_keys WHERE scope LIKE ${`%${projectId}%`}`;
  await sql`DELETE FROM projects WHERE id = ${projectId}`;
}

async function clearFixture(): Promise<void> {
  await clearProject(ids.projectA);
  await clearProject(ids.projectB);
  await sql`DELETE FROM memberships WHERE organization_id IN (${ids.organizationA}, ${ids.organizationB})`;
  await sql`DELETE FROM users WHERE organization_id IN (${ids.organizationA}, ${ids.organizationB})`;
  await sql`DELETE FROM organizations WHERE id IN (${ids.organizationA}, ${ids.organizationB})`;
}

beforeAll(async () => {
  await clearFixture();
  await sql`INSERT INTO organizations (id, slug, name) VALUES (${ids.organizationA}, 'postgres-a', 'Postgres A'), (${ids.organizationB}, 'postgres-b', 'Postgres B')`;
  await sql`INSERT INTO users (id, organization_id, email, display_name) VALUES (${ids.userA}, ${ids.organizationA}, 'owner-a@example.test', 'Owner A'), (${ids.userB}, ${ids.organizationB}, 'owner-b@example.test', 'Owner B')`;
  await sql`INSERT INTO memberships (organization_id, user_id, role) VALUES (${ids.organizationA}, ${ids.userA}, 'owner'), (${ids.organizationB}, ${ids.userB}, 'owner')`;
  await sql`INSERT INTO projects (id, organization_id, name) VALUES (${ids.projectA}, ${ids.organizationA}, 'Postgres project A'), (${ids.projectB}, ${ids.organizationB}, 'Postgres project B')`;
  await repository.appendRevision({
    id: ids.revisionB1,
    projectId: ids.projectB,
    sequence: 1,
    content: { project: 'B' },
    contentSha256: 'c'.repeat(64),
    scenarioIds: ['default'],
    createdBy: ids.userB,
    createdAt: '2026-07-23T20:00:00Z'
  });
});

afterAll(async () => {
  await clearFixture();
  await repository.close({ timeout: 0 });
});

describe('PostgreSQL collaboration persistence', () => {
  it('applies migrations 0001-0007 and persists baseline lifecycle across restart and restore', async () => {
    const migrations = await sql<{ name: string }[]>`
      SELECT name FROM schema_migrations
      WHERE name IN ('0001_collaboration', '0002_realtime_events', '0003_design_baselines', '0004_project_ownership_foreign_keys', '0005_review_aggregates', '0006_public_contract_hardening', '0007_ai_undo_result_compatibility')
      ORDER BY name`;
    expect(migrations.map((migration) => migration.name)).toEqual([
      '0001_collaboration',
      '0002_realtime_events',
      '0003_design_baselines',
      '0004_project_ownership_foreign_keys',
      '0005_review_aggregates',
      '0006_public_contract_hardening',
      '0007_ai_undo_result_compatibility'
    ]);

    const firstRevision = await application.fetch(
      new Request(`https://service.test/v1/projects/${ids.projectA}/revisions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: ids.revisionA1,
          content: { project: 'A', title: 'Before baseline' },
          contentSha256: firstFingerprint,
          scenarioIds: ['default']
        })
      })
    );
    expect(firstRevision.status).toBe(201);

    const reviewThread = await application.fetch(
      new Request(`https://service.test/v1/projects/${ids.projectA}/review-threads`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: ids.reviewThread,
          deepLink: 'https://review.example.test/projects/a',
          body: 'Keep this table aligned with the baseline.',
          mentionedUserIds: [],
          anchor: {
            evidence: {
              artifactId: 'artifact-a',
              screenId: 'orders',
              revisionId: ids.revisionA1,
              revisionFingerprint: firstFingerprint,
              viewport: { width: 1440, height: 900, zoom: 1 },
              scenarioId: 'default'
            },
            lifecycle: 'current',
            target: { kind: 'region', region: { x: 0.1, y: 0.1, width: 0.5, height: 0.3 } }
          }
        })
      })
    );
    expect(reviewThread.status).toBe(201);
    const resolvedReview = await application.fetch(
      new Request(`https://service.test/v1/review-threads/${ids.reviewThread}/resolve`, {
        method: 'POST',
        headers
      })
    );
    await expect(resolvedReview.json()).resolves.toMatchObject({ lifecycle: 'resolved' });
    const currentAnchor = {
      evidence: {
        artifactId: 'artifact-a',
        screenId: 'orders',
        revisionId: ids.revisionA1,
        revisionFingerprint: firstFingerprint,
        viewport: { width: 1440, height: 900, zoom: 1 },
        scenarioId: 'default'
      },
      lifecycle: 'current',
      target: { kind: 'point', point: { x: 0.5, y: 0.5 } }
    };
    const aiRequest = await application.fetch(
      new Request(`https://service.test/v1/projects/${ids.projectA}/ai-change-requests`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: ids.aiRequest,
          anchor: currentAnchor,
          instruction: 'Make the table heading clearer.',
          provider: { providerId: 'postgres-test-provider', capability: 'design-edit' }
        })
      })
    );
    expect(aiRequest.status).toBe(201);
    const started = await application.fetch(
      new Request(`https://service.test/v1/ai-change-requests/${ids.aiRequest}/transition`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'start' })
      })
    );
    expect(started.status).toBe(200);
    const failed = await application.fetch(
      new Request(`https://service.test/v1/ai-change-requests/${ids.aiRequest}/transition`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'fail', failureReason: 'controlled failure' })
      })
    );
    expect(failed.status).toBe(200);
    const foreignResult = await application.fetch(
      new Request(`https://service.test/v1/ai-change-requests/${ids.aiRequest}/transition`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'apply',
          result: {
            revisionId: ids.revisionB1,
            revisionFingerprint: 'c'.repeat(64),
            diff: 'cross-project patch',
            completedAt: '2026-07-23T20:00:00Z'
          }
        })
      })
    );
    expect(foreignResult.status).toBe(404);
    for (const body of [
      { action: 'retry' },
      { action: 'start' },
      {
        action: 'apply',
        result: {
          revisionId: ids.revisionA1,
          revisionFingerprint: firstFingerprint,
          diff: 'applied test patch',
          completedAt: '2026-07-23T20:00:00Z'
        }
      },
      {
        action: 'undo',
        undoResult: {
          revisionId: ids.revisionA1,
          revisionFingerprint: firstFingerprint,
          diff: 'compensating test patch',
          completedAt: '2026-07-23T20:01:00Z'
        }
      }
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const transition = await application.fetch(
        new Request(`https://service.test/v1/ai-change-requests/${ids.aiRequest}/transition`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
        })
      );
      expect(transition.status).toBe(200);
    }
    const listedAI = await application.fetch(
      new Request(`https://service.test/v1/projects/${ids.projectA}/ai-change-requests`, {
        headers
      })
    );
    await expect(listedAI.json()).resolves.toMatchObject({
      requests: [expect.objectContaining({ id: ids.aiRequest, lifecycle: 'undone' })]
    });
    const annotation = await application.fetch(
      new Request(`https://service.test/v1/projects/${ids.projectA}/developer-annotations`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: ids.annotation,
          anchor: currentAnchor,
          category: 'content',
          body: 'Keep the heading semantic.'
        })
      })
    );
    expect(annotation.status).toBe(201);

    const ready = await application.fetch(
      new Request(`https://service.test/v1/projects/${ids.projectA}/readiness`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: ids.baseline,
          intent: 'review',
          revisionId: ids.revisionA1,
          revisionFingerprint: firstFingerprint
        })
      })
    );
    expect(ready.status).toBe(201);

    const thread = await application.fetch(
      new Request(`https://service.test/v1/projects/${ids.projectA}/threads`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: ids.thread,
          revisionId: ids.revisionA1,
          reactNodeId: 'orders.table',
          scenarioId: 'default'
        })
      })
    );
    expect(thread.status).toBe(201);
    const comment = await application.fetch(
      new Request(`https://service.test/v1/threads/${ids.thread}/comments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: ids.comment,
          body: 'Comment activity is not design drift.',
          mentionedUserIds: []
        })
      })
    );
    expect(comment.status).toBe(201);
    expect(await repository.getDesignReviewState(ids.projectA)).toMatchObject({
      currency: 'current',
      approvalsStale: false,
      changesSinceBaseline: []
    });

    const designMutation = {
      content: { project: 'A', title: 'After baseline' },
      contentSha256: secondFingerprint,
      scenarioIds: ['default'],
      semanticChange: {
        id: ids.change,
        kind: 'visual',
        reason: 'Updated table heading',
        affected: {
          projectId: ids.projectA,
          screenIds: ['orders'],
          routePaths: ['/orders'],
          scenarioIds: ['default'],
          componentIds: ['orders-table'],
          stableNodeIds: ['orders.table']
        },
        evidence: [{ description: 'Before/after screenshot', checksum: 'sha256:example' }],
        provenance: { kind: 'actor', actorId: ids.userA }
      }
    };
    const revisionUrl = `https://service.test/v1/projects/${ids.projectA}/revisions`;
    const changed = await application.fetch(
      new Request(revisionUrl, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': 'after-baseline' },
        body: JSON.stringify(designMutation)
      })
    );
    expect(changed.status).toBe(201);
    const changedBody = (await changed.json()) as { id: string };
    const replay = await application.fetch(
      new Request(revisionUrl, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': 'after-baseline' },
        body: JSON.stringify(designMutation)
      })
    );
    expect(replay.status).toBe(201);
    await expect(replay.json()).resolves.toMatchObject({ id: changedBody.id });

    const stale = await repository.getDesignReviewState(ids.projectA);
    expect(stale).toMatchObject({
      readiness: 'ready-for-review',
      currency: 'stale',
      approvalsStale: true,
      baseline: {
        id: ids.baseline,
        revision: { id: ids.revisionA1, fingerprint: firstFingerprint }
      },
      changesSinceBaseline: [
        expect.objectContaining({
          id: ids.change,
          beforeRevision: { id: ids.revisionA1, fingerprint: firstFingerprint },
          currentRevision: { id: changedBody.id, fingerprint: secondFingerprint }
        })
      ]
    });
    const revisionEvents = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM collaboration_events
      WHERE project_id = ${ids.projectA} AND type = 'revision.created'`;
    expect(revisionEvents[0]?.count).toBe(2);

    const restarted = new BunPostgresCollaborationRepository(new Bun.SQL(databaseUrl));
    expect(await restarted.getDesignReviewState(ids.projectA)).toEqual(stale);
    await expect(restarted.getReviewThread(ids.reviewThread)).resolves.toMatchObject({
      lifecycle: 'resolved',
      anchor: { evidence: { artifactId: 'artifact-a' } }
    });
    await expect(restarted.getAIChangeRequest(ids.aiRequest)).resolves.toMatchObject({
      lifecycle: 'undone',
      result: { diff: 'applied test patch' },
      undoResult: { diff: 'compensating test patch' }
    });
    await expect(restarted.listDeveloperAnnotations(ids.projectA)).resolves.toEqual([
      expect.objectContaining({ id: ids.annotation })
    ]);
    await restarted.close({ timeout: 0 });

    const snapshot = await repository.exportProject(ids.projectA);
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) throw new Error('Expected project export before restore');
    await clearProject(ids.projectA);
    await repository.replaceProject(snapshot);
    expect(await repository.getDesignReviewState(ids.projectA)).toEqual(stale);
    await expect(repository.getReviewThread(ids.reviewThread)).resolves.toMatchObject({
      lifecycle: 'resolved',
      messages: [expect.objectContaining({ body: 'Keep this table aligned with the baseline.' })]
    });
    await expect(repository.getAIChangeRequest(ids.aiRequest)).resolves.toMatchObject({
      lifecycle: 'undone',
      result: { diff: 'applied test patch' },
      undoResult: { diff: 'compensating test patch' }
    });
    await expect(repository.listDeveloperAnnotations(ids.projectA)).resolves.toEqual([
      expect.objectContaining({ id: ids.annotation })
    ]);

    await expect(
      (async () => {
        await sql`
          INSERT INTO threads (id, project_id, revision_id, react_node_id, scenario_id, created_by, created_at)
          VALUES ('90000000-0000-4000-8000-000000000001', ${ids.projectA}, ${ids.revisionB1}, 'cross.project', 'default', ${ids.userA}, now())`;
      })()
    ).rejects.toThrow('threads_project_revision_project_fkey');
  });
});
