import { expect, test } from 'vitest';

import { ordersReviewHandoffManifest } from './orders-review-handoff';

test('binds the hosted developer handoff to a canonical catalog story identity', () => {
  expect(ordersReviewHandoffManifest.format).toBe('selene-developer-handoff/v3');
  expect(ordersReviewHandoffManifest.storybook.stories).toEqual([
    {
      format: 'selene-canonical-story-reference/v1',
      projectId: 'northstar',
      catalogRevision: 'orders-catalog-r18-7f3a',
      buildId: 'orders-storybook-r18-7f3a',
      componentId: 'OrdersReviewRow',
      storyId: 'northstar-orders-review-r18--ready'
    }
  ]);
  expect(JSON.stringify(ordersReviewHandoffManifest.storybook)).not.toContain('localhost');
  expect(JSON.stringify(ordersReviewHandoffManifest.storybook)).not.toContain('storybook-static');
  expect(ordersReviewHandoffManifest.inspection).toEqual({
    format: 'selene-published-inspection-manifest/v1',
    path: 'inspection/orders-review-r18.inspection.json',
    attestation: {
      format: 'selene-sha256-attestation/v1',
      algorithm: 'sha256',
      payloadDigest: '7c1b7888d1807b532a32e26949e73241944b5f32d6ae99c9f8435d2e08271051'
    }
  });
});
