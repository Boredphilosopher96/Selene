/**
 * Committed handoff source. The portal only downloads this exact string and its
 * content-addressed receipt; it never synthesizes implementation code in the browser.
 */
export const ordersReviewHandoffSource = `import type { ReactElement } from 'react';

export type OrderStatus = 'Needs review' | 'Packing' | 'Shipped';

export interface ReviewedOrder {
  readonly id: string;
  readonly customer: string;
  readonly total: string;
  readonly status: OrderStatus;
}

export function OrdersReviewRow({ order }: { readonly order: ReviewedOrder }): ReactElement {
  return (
    <tr data-review-order={order.id}>
      <td>{order.id}</td><td>{order.customer}</td><td>{order.status}</td><td>{order.total}</td>
    </tr>
  );
}
`;

const artifactDigest = '45fcab29dfc3243625ffc567bcc026187d39e59ae5830d93ecb640c8a7ef32bf';
const artifactRef = `sha256:${artifactDigest}`;

export const ordersReviewArtifact = Object.freeze({
  project: 'Northstar · Orders experience',
  projectId: 'northstar',
  revision: '18',
  revisionId: 'orders-r18-7f3a',
  baseline: '17',
  baselineId: 'orders-r17-b9c1',
  artifactId: 'orders-review-7f3a-b9c1',
  content: Object.freeze({
    ref: artifactRef,
    digest: Object.freeze({ algorithm: 'sha256', value: artifactDigest }),
    blob: Object.freeze({ name: 'orders-review-r18.tsx', mediaType: 'text/plain;charset=utf-8' })
  })
});

export const ordersReviewHandoffManifest = Object.freeze({
  format: 'selene-developer-handoff/v2',
  artifact: ordersReviewArtifact,
  archive: {
    format: 'selene-developer-handoff-archive/v2',
    path: 'handoffs/orders-review-r18.handoff.json',
    delivery: 'public generated asset with a canonical content digest in its manifest'
  },
  receipt: {
    format: 'selene-developer-handoff-receipt/v1',
    path: 'handoffs/orders-review-r18.receipt.json'
  },
  toolchain: {
    runtime: 'bun@1.3.14',
    react: '19.2.8',
    typescript: '7.0.2',
    vite: '8.1.5',
    storybook: '10.5.4'
  },
  designSystem: { package: 'bundled local CSS', reference: 'src/styles.css' },
  scenarios: ['ready-orders', 'address-confirmation', 'empty-orders', 'unavailable-orders'],
  components: ['OrdersReviewRow', 'OrderStatus'],
  storybook: {
    source: 'src/orders-review-r18.stories.tsx',
    stories: ['Northstar/Orders review r18/Ready']
  },
  directions: [
    'Preserve data-review-order identities.',
    'Keep order status text visible with color.'
  ],
  commands: {
    install: 'bun install --frozen-lockfile',
    typecheck: 'bun run typecheck',
    build: 'bun run build',
    start: 'bun run start -- --host 127.0.0.1 --port 4173 --strictPort'
  }
});
