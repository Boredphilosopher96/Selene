import { expect, test } from 'vitest';

import {
  createHostedElementInspection,
  hostedElementInspectionFormat
} from './hosted-review-inspection';

const input = {
  artifact: {
    projectId: 'northstar',
    artifactId: 'orders-review-7f3a-b9c1',
    revisionId: 'orders-r18-7f3a',
    baselineId: 'orders-r17-b9c1'
  },
  target: {
    field: 'status',
    component: 'OrderStatus',
    sourcePath: 'src/orders-review-r18.tsx',
    exportName: 'OrdersReviewRow',
    packageName: '@northstar/ui',
    packageVersion: '4.8.2',
    owner: 'Commerce Design Systems',
    authoredProps: ['tone="warning"', 'size="compact"'],
    token: { name: 'status.attention', value: '#9a5b08' }
  },
  observation: {
    semanticTag: 'span',
    role: 'status',
    accessibleName: 'Needs review',
    bounds: { x: 20.125, y: 40.5, width: 92.4, height: 24 },
    viewport: { width: 1440, height: 980 },
    styles: {
      display: 'inline-flex',
      color: 'rgb(154, 91, 8)',
      backgroundColor: 'rgb(255, 240, 219)',
      fontFamily: 'Inter',
      fontSize: '11.2px',
      fontWeight: '720',
      lineHeight: 'normal',
      padding: '4.8px 7.68px',
      border: '0px none rgb(154, 91, 8)',
      borderRadius: '9999px',
      textAlign: 'start'
    }
  },
  screen: 'Orders',
  state: 'ready',
  handoff: {
    changeSinceBaseline: 'changed',
    directions: ['Keep status text visible with color.'],
    story: {
      format: 'selene-canonical-story-reference/v1',
      projectId: 'northstar',
      catalogRevision: 'orders-catalog-r18-7f3a',
      buildId: 'orders-storybook-r18-7f3a',
      componentId: 'OrdersReviewRow',
      storyId: 'northstar-orders-review-r18--ready'
    }
  }
} as const;

test('creates a bounded read-only artifact inspection with exact revision provenance', () => {
  const inspection = createHostedElementInspection(input);

  expect(inspection).toMatchObject({
    format: hostedElementInspectionFormat,
    artifact: { revisionId: 'orders-r18-7f3a', baselineId: 'orders-r17-b9c1' },
    target: {
      component: 'OrderStatus',
      packageName: '@northstar/ui',
      authoredProps: ['tone="warning"', 'size="compact"']
    },
    scenario: { screen: 'Orders', state: 'ready', viewport: '1440 × 980 px' },
    accessibility: { semanticTag: 'span', role: 'status', accessibleName: 'Needs review' },
    geometry: { x: 20.13, y: 40.5, width: 92.4, height: 24 },
    handoff: {
      changeSinceBaseline: 'changed',
      directions: ['Keep status text visible with color.'],
      story: { storyId: 'northstar-orders-review-r18--ready' }
    }
  });
  expect(Object.isFrozen(inspection)).toBe(true);
  expect(Object.isFrozen(inspection.styles)).toBe(true);
});

test('drops hostile or unavailable observation values without retaining arbitrary DOM data', () => {
  const inspection = createHostedElementInspection({
    ...input,
    observation: {
      ...input.observation,
      role: '\n<script>alert(1)</script>',
      accessibleName: 'x'.repeat(300),
      bounds: { x: Number.NaN, y: -1, width: Number.POSITIVE_INFINITY, height: 30 },
      styles: { ...input.observation.styles, color: 'x'.repeat(300) }
    }
  });

  expect(inspection.accessibility.role).toBe('Implicit semantic role');
  expect(inspection.accessibility.accessibleName).toBe('No exposed accessible name');
  expect(inspection.styles.color).toBe('Unavailable');
  expect(inspection.geometry).toEqual({ x: 0, y: 0, width: 0, height: 30 });
  expect(JSON.stringify(inspection)).not.toContain('<script>');
});

test('rejects forged artifact or source identities', () => {
  expect(() =>
    createHostedElementInspection({
      ...input,
      artifact: { ...input.artifact, revisionId: '../../../private' }
    })
  ).toThrow('Hosted inspection revision is invalid');
});
