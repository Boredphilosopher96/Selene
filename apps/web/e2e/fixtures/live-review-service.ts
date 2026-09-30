import { createInMemoryCollaborationRepository } from '@selene/collaboration';
import { createCollaborationApplication } from '../../../collaboration-service/src/app';
import { readServiceEnvironment } from '../../../collaboration-service/src/env';
import { ordersReviewArtifact as artifact } from '../../src/orders-review-handoff';

const origin = process.argv[2];
if (!origin) throw new Error('The browser origin is required.');
const environment = readServiceEnvironment({
  COLLABORATION_STORE: 'memory',
  COLLABORATION_SHARE_SECRET: 'a'.repeat(32),
  COLLABORATION_PROXY_SECRET: 'p'.repeat(32),
  CORS_ORIGINS: `${origin},https://review.example.test`,
  HOSTED_REVIEW_PROJECT_ID: artifact.projectId,
  HOSTED_REVIEW_ARTIFACT_ID: artifact.artifactId,
  HOSTED_REVIEW_REVISION_ID: artifact.revisionId,
  HOSTED_REVIEW_BASELINE_ID: artifact.baselineId,
  HOSTED_REVIEW_CONTRACT_VERSION: String(artifact.reviewContractVersion)
});
const repository = createInMemoryCollaborationRepository();
// Test-only cookie identities. Real BFF sessions are exercised by the service integration suite.
const application = createCollaborationApplication(
  environment,
  repository,
  { authorize: async () => true },
  undefined,
  {
    async authenticate(request) {
      const cookie = request.headers.get('cookie') ?? '';
      if (cookie.includes('selene-test-reviewer=reviewer-a')) return 'reviewer-a';
      if (cookie.includes('selene-test-reviewer=reviewer-b')) return 'reviewer-b';
      return undefined;
    }
  }
);
for (const [path, body] of [
  [
    '/v1/projects',
    { id: artifact.projectId, organizationId: artifact.tenantId, name: 'Live browser review' }
  ],
  [
    `/v1/projects/${artifact.projectId}/revisions`,
    {
      id: artifact.revisionId,
      content: { review: 'browser' },
      contentSha256: artifact.content.digest.value,
      scenarioIds: ['orders']
    }
  ],
  [
    `/v1/projects/${artifact.projectId}/readiness`,
    {
      id: artifact.baselineId,
      revisionId: artifact.revisionId,
      intent: 'review',
      revisionFingerprint: artifact.content.digest.value
    }
  ]
] as const) {
  // oxlint-disable-next-line no-await-in-loop -- revision and baseline follow project creation.
  const response = await application.fetch(
    new Request(`http://fixture.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'selene-test-reviewer=reviewer-a' },
      body: JSON.stringify(body)
    })
  );
  if (!response.ok) throw new Error(`Fixture setup failed: ${response.status}`);
}
const streams = new Set<AbortController>();
const reconnectCursors: string[] = [];
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  // SSE connections stay open while Playwright drives the other session.
  idleTimeout: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/__test/disconnect' && request.method === 'POST') {
      for (const controller of streams) controller.abort();
      return Response.json({ disconnected: streams.size });
    }
    if (path === '/__test/cursors') return Response.json(reconnectCursors);
    if (path.endsWith('/events/stream')) {
      const controller = new AbortController();
      reconnectCursors.push(request.headers.get('last-event-id') ?? '');
      streams.add(controller);
      const cleanup = () => {
        streams.delete(controller);
        controller.abort();
      };
      request.signal.addEventListener('abort', cleanup, { once: true });
      controller.signal.addEventListener('abort', () => streams.delete(controller), { once: true });
      return application.fetch(new Request(request, { signal: controller.signal }));
    }
    const response = await application.fetch(request);
    if (!response.ok) console.info(JSON.stringify({ fixtureError: await response.clone().text() }));
    return response;
  }
});
console.info(`SELENE_TEST_SERVICE ${server.url.origin}`);
