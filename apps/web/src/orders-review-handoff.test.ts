import { expect, test } from 'vitest';

import { ordersReviewHandoffManifest } from './orders-review-handoff';

test('binds the hosted developer handoff to a canonical catalog story identity', () => {
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
});
