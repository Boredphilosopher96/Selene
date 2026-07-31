import type { Meta, StoryObj } from '@storybook/react-vite';

import type {
  DesignerSnapshot,
  GeneratedCodePublishReceipt
} from '../../../apps/desktop/src/shared/designer-api';
import { ReviewHandoffPanel } from '../../../apps/desktop/src/renderer/src/cockpit/review-handoff-panel';

const draftBaseline: DesignerSnapshot['baseline'] = {
  projectId: 'orders',
  readiness: 'draft',
  currency: 'none',
  changesSinceBaseline: [],
  approvalsStale: false
};
const changedBaseline: DesignerSnapshot['baseline'] = {
  projectId: 'orders',
  readiness: 'ready-for-review',
  currency: 'stale',
  baseline: {
    id: 'baseline-review-orders-r1',
    projectId: 'orders',
    revision: { id: 'orders-r1', fingerprint: 'sha256:orders-r1' },
    intent: 'review',
    createdAt: '2026-07-25T19:00:00.000Z',
    createdBy: 'designer-1'
  },
  changesSinceBaseline: [
    {
      id: 'change-orders-empty',
      kind: 'token',
      beforeRevision: { id: 'orders-r1', fingerprint: 'sha256:orders-r1' },
      currentRevision: { id: 'orders-r2', fingerprint: 'sha256:orders-r2' },
      affected: {
        projectId: 'orders',
        screenIds: ['orders'],
        routePaths: ['/orders'],
        scenarioIds: ['empty'],
        componentIds: ['OrdersList'],
        stableNodeIds: ['orders.empty-state']
      },
      evidence: [{ description: 'Updated empty state', href: 'evidence/orders-empty.png' }],
      provenance: { kind: 'agent', agentId: 'local-agent', promptDigest: 'sha256:prompt' },
      occurredAt: '2026-07-25T19:05:00.000Z',
      reason: 'Aligned empty-state spacing with the approved token scale.'
    }
  ],
  approvalsStale: true
};
const handoffBaseline: DesignerSnapshot['baseline'] = {
  projectId: 'orders',
  readiness: 'ready-for-handoff',
  currency: 'current',
  baseline: {
    id: 'baseline-handoff-orders-r2',
    projectId: 'orders',
    revision: { id: 'orders-r2', fingerprint: 'sha256:orders-r2' },
    intent: 'handoff',
    createdAt: '2026-07-25T19:10:00.000Z',
    createdBy: 'designer-1'
  },
  changesSinceBaseline: [],
  approvalsStale: false
};
const productMap: NonNullable<DesignerSnapshot['productMap']> = {
  format: 'selene-desktop-product-map/v1',
  currentProjectId: 'commerce-shell',
  scope: { kind: 'federation', shellProjectId: 'commerce-shell' },
  projects: [
    {
      projectId: 'commerce-shell',
      name: 'Commerce shell',
      role: 'shell',
      shellProjectId: 'commerce-shell',
      lifecycle: 'active',
      readiness: 'ready-for-handoff',
      currency: 'current',
      changesSinceBaseline: 0
    },
    {
      projectId: 'orders',
      name: 'Orders',
      role: 'child',
      shellProjectId: 'commerce-shell',
      lifecycle: 'active',
      readiness: 'ready-for-handoff',
      currency: 'current',
      changesSinceBaseline: 0
    },
    {
      projectId: 'customer-service',
      name: 'Customer service',
      role: 'child',
      shellProjectId: 'commerce-shell',
      lifecycle: 'active',
      readiness: 'ready-for-review',
      currency: 'stale',
      changesSinceBaseline: 2
    }
  ]
};
const receipt: Extract<GeneratedCodePublishReceipt, { readonly mode: 'github-remote' }> = {
  mode: 'github-remote',
  status: 'remote-published',
  repository: 'selene-design/orders',
  bundleDigest: '1'.repeat(64),
  filePlanDigest: '2'.repeat(64),
  lockDigest: '3'.repeat(64),
  artifactDigest: '4'.repeat(64),
  treeSha: 'a'.repeat(40),
  commitSha: 'b'.repeat(40),
  ref: 'refs/heads/selene/orders-r2',
  pullRequestUrl: 'https://github.com/selene-design/orders/pull/42',
  immutableId: `bundle-sha256-${'1'.repeat(64)}`,
  hostedReview: {
    staticReview: { status: 'ready', url: 'https://selene-design.github.io/orders/' },
    collaboration: {
      status: 'ready',
      url: 'https://reviews.example.test/orders/r2',
      manifestDigest: '5'.repeat(64)
    }
  }
};

const meta = {
  title: 'Desktop/Review and handoff',
  component: ReviewHandoffPanel,
  decorators: [
    (Story) => (
      <div className="sl-theme" style={{ maxWidth: '30rem', padding: '1rem' }}>
        <Story />
      </div>
    )
  ],
  args: {
    baseline: draftBaseline,
    productMapBusy: false,
    productHandoffBusy: false,
    onConfigureProductShell: () => undefined,
    onExportProductHandoff: () => undefined,
    status: 'Choose a host-backed next step.',
    reviewDisabled: false,
    handoffDisabled: false,
    exportDisabled: true,
    receiptDisabled: false,
    onReadyForReview: () => undefined,
    onReadyForHandoff: () => undefined,
    onExportHandoff: () => undefined,
    onOpenReceipt: () => undefined,
    publishStatus: 'No publish operation started for this project.',
    publishBusy: false
  }
} satisfies Meta<typeof ReviewHandoffPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Draft: Story = {};
export const ChangedAfterReview: Story = {
  args: {
    baseline: changedBaseline,
    status: 'Review the exact design changes before creating the next baseline.'
  }
};
export const ReadyForDeveloperHandoff: Story = {
  args: {
    baseline: handoffBaseline,
    productMap,
    exportDisabled: false,
    receipt,
    publishStatus: 'Remote artifact and hosted review are ready.'
  }
};
export const Publishing: Story = {
  args: {
    active: 'handoff',
    reviewDisabled: true,
    handoffDisabled: true,
    exportDisabled: true,
    receiptDisabled: true,
    publishBusy: true,
    publishStatus: 'Publishing the immutable generated project…',
    status: 'Waiting for the trusted host operation.'
  }
};
