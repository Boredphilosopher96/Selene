import { expect, test } from 'vitest';

import { ordersReviewArtifact } from './orders-review-handoff';
import {
  ordersReviewInspectionEnvelope,
  verifyPublishedInspectionManifest
} from './published-inspection-manifest';

const expected = {
  projectId: ordersReviewArtifact.projectId,
  artifactId: ordersReviewArtifact.artifactId,
  revisionId: ordersReviewArtifact.revisionId,
  baselineId: ordersReviewArtifact.baselineId,
  sourceDigest: ordersReviewArtifact.content.digest.value
} as const;

test('verifies and projects the exact public inspection manifest', async () => {
  const result = await verifyPublishedInspectionManifest(
    ordersReviewInspectionEnvelope,
    expected,
    'anonymous'
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.manifest.targetById.status).toMatchObject({
    target: {
      component: 'OrderStatus',
      packageName: '@northstar/ui',
      packageVersion: '4.8.2'
    },
    changeSinceBaseline: 'changed',
    story: {
      catalogRevision: 'orders-catalog-r18-7f3a',
      buildId: 'orders-storybook-r18-7f3a',
      storyId: 'northstar-orders-review-r18--ready'
    }
  });
  expect(Object.isFrozen(result.manifest)).toBe(true);
  expect(Object.isFrozen(result.manifest.targets)).toBe(true);
});

test('fails closed when published inspection content changes after attestation', async () => {
  const tampered = structuredClone(ordersReviewInspectionEnvelope) as {
    payload: { targets: Array<{ directions: string[] }> };
  };
  tampered.payload.targets[0]?.directions.push('Send a private URL.');

  await expect(
    verifyPublishedInspectionManifest(tampered, expected, 'developer')
  ).resolves.toMatchObject({
    ok: false,
    code: 'unverified'
  });
});

test('fails closed for stale artifacts and review roles without inspect capability', async () => {
  await expect(
    verifyPublishedInspectionManifest(
      ordersReviewInspectionEnvelope,
      { ...expected, revisionId: 'orders-r19-stale' },
      'developer'
    )
  ).resolves.toMatchObject({ ok: false, code: 'stale' });

  await expect(
    verifyPublishedInspectionManifest(ordersReviewInspectionEnvelope, expected, 'commenter')
  ).resolves.toMatchObject({ ok: false, code: 'unauthorized' });
});
