import { useEffect, useRef, useState } from 'react';

import {
  createProject,
  executeProjectCommand,
  exportProject,
  openProject,
  reopenProject,
  type LocalProjectPersistencePort,
  type ProjectCommand
} from '@selene/core/project';
import {
  createPrototypeRuntime,
  prototypeGraphFixture,
  schedulePrototypeTimeouts,
  type PrototypeGraph,
  type PrototypeRuntime
} from '@selene/core/prototype';
import type { DesignerWorkspace } from '@selene/project-schema';
import { DesignerWorkspace as DesignerWorkspaceView } from '@selene/ui/designer-workspace';
import { PrototypeFlowCanvas } from '@selene/ui/prototype-flow';
import { PrototypeRuntimePreview } from '@selene/ui/prototype-runtime';
import type { WorkspaceStatus } from '@selene/ui/workspace';

import { createPrototypeBrowserNavigation } from './prototype-browser-navigation';

const STORAGE_PREFIX = 'selene.designer-workspace.';
const editablePrototypeFixture: PrototypeGraph = {
  ...prototypeGraphFixture,
  transitions: prototypeGraphFixture.transitions.filter(
    (transition) => transition.id !== 'create-order'
  ),
  scenarios: prototypeGraphFixture.scenarios.map((scenario) =>
    scenario.id === 'orders-default' ? { ...scenario, expectedPath: ['orders'] } : scenario
  )
};

const browserPersistence: LocalProjectPersistencePort = {
  async load(projectId) {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${projectId}`) ?? undefined;
  },
  async save(projectId, serializedProject) {
    window.localStorage.setItem(`${STORAGE_PREFIX}${projectId}`, serializedProject);
  }
};

function sampleProject(): DesignerWorkspace {
  return {
    format: 'selene-designer-workspace/v1',
    projectId: 'northstar',
    name: 'Northstar workspace',
    status: 'in-review',
    selectedScreenId: 'dashboard',
    selectedState: 'default',
    screens: [
      {
        id: 'dashboard',
        name: 'Dashboard',
        route: '/',
        states: ['default', 'busy'],
        nodeIds: ['dashboard.hero', 'dashboard.revenue', 'dashboard.orders', 'dashboard.activity']
      },
      {
        id: 'orders',
        name: 'Orders',
        route: '/orders',
        states: ['default', 'empty'],
        nodeIds: ['orders.header', 'orders.title', 'orders.table']
      },
      {
        id: 'settings',
        name: 'Settings',
        route: '/settings',
        states: ['default'],
        nodeIds: ['settings.sidebar', 'settings.preferences']
      }
    ],
    comments: [
      {
        id: 'comment-welcome',
        nodeId: 'dashboard.hero',
        body: 'Keep this greeting warm, but make the decision count easy to scan.',
        author: 'Mina',
        createdAt: '2026-07-23T20:30:00Z'
      }
    ],
    developerDirections: ['Preserve data-selene-node-id values when extracting components.'].map(
      (body, index) => ({ id: `direction-${index + 1}`, body, createdAt: '2026-07-23T20:30:00Z' })
    ),
    changelog: [
      {
        id: 'initial',
        at: '2026-07-23T20:00:00Z',
        summary: 'Created the Northstar React review project.'
      },
      { id: 'review', at: '2026-07-23T20:30:00Z', summary: 'Added the dashboard review state.' }
    ],
    updatedAt: '2026-07-23T20:30:00Z'
  };
}

function commandId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}

function isHostedReviewLocation(): boolean {
  const base = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  return base.includes('/demo/') || window.location.pathname.startsWith(`${base}review/`);
}

type ReviewMode = 'comment' | 'inspect';
type ReviewSection = 'prototype' | 'flows' | 'components' | 'changes' | 'discussions' | 'handoff';
type PrototypeState = 'ready' | 'loading' | 'empty' | 'error';

interface Order {
  readonly id: string;
  readonly customer: string;
  readonly total: string;
  readonly status: 'Needs review' | 'Packing' | 'Shipped';
  readonly date: string;
  readonly note: string;
}

interface ReviewComment {
  readonly id: string;
  readonly orderId: string;
  readonly parentId?: string;
  readonly revisionId: string;
  readonly baselineId: string;
  readonly artifactId: string;
  readonly author: string;
  readonly body: string;
  readonly timestamp: string;
}

const reviewArtifact = Object.freeze({
  project: 'Northstar · Orders experience',
  revision: '18',
  revisionId: 'orders-r18-7f3a',
  baseline: '17',
  baselineId: 'orders-r17-b9c1',
  artifactId: 'orders-review-7f3a-b9c1',
  generatedAt: '2026-07-25T22:18:00.000Z'
});

function reviewRoute(section: ReviewSection): string {
  const base = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL.slice(0, -1)
    : import.meta.env.BASE_URL;
  return `${base}/review/${section}`.replace(/^$/, '/');
}

function sectionFromLocation(): ReviewSection {
  const restored = new URLSearchParams(window.location.search).get('review');
  if (restored !== null) {
    const restoredSection = restored.replace(/^review\//, '').replace(/\/$/, '');
    if (isReviewSection(restoredSection)) return restoredSection;
  }
  const base = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  const relative = window.location.pathname.startsWith(base)
    ? window.location.pathname.slice(base.length)
    : '';
  const section = relative.replace(/^review\//, '').replace(/\/$/, '');
  return isReviewSection(section) ? section : 'prototype';
}

function createDeveloperHandoff(): void {
  const contents = `import type { ReactElement } from 'react';

export type OrderStatus = 'Needs review' | 'Packing' | 'Shipped';

/** Demo-only browser-generated sample, not a verified implementation receipt. */
export const ordersReviewIllustration = {
  artifactId: '${reviewArtifact.artifactId}',
  project: '${reviewArtifact.project}',
  revision: { number: '${reviewArtifact.revision}', id: '${reviewArtifact.revisionId}' },
  baseline: { number: '${reviewArtifact.baseline}', id: '${reviewArtifact.baselineId}' },
  stateFlow: ['orders-list', 'order-detail', 'address-confirmation'] as const,
  provenance: { capturedAt: '${reviewArtifact.generatedAt}', mode: 'static-review-data' }
} as const;

export interface ReviewedOrder {
  readonly id: string;
  readonly customer: string;
  readonly total: string;
  readonly status: OrderStatus;
}

export function OrderRow({ order }: { readonly order: ReviewedOrder }): ReactElement {
  return <tr data-review-order={order.id}><td>{order.id}</td><td>{order.customer}</td><td>{order.status}</td><td>{order.total}</td></tr>;
}
`;
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'orders-review-r18.tsx';
  link.click();
  URL.revokeObjectURL(url);
}

const orders: readonly Order[] = [
  {
    id: '#1048',
    customer: 'Olivia Parker',
    total: '$240.00',
    status: 'Needs review',
    date: 'Today, 10:42',
    note: 'Address confirmation requested before fulfillment.'
  },
  {
    id: '#1047',
    customer: 'Amir Cooper',
    total: '$96.00',
    status: 'Packing',
    date: 'Today, 09:18',
    note: 'Gift wrap and delivery note confirmed.'
  },
  {
    id: '#1046',
    customer: 'Maya Chen',
    total: '$418.00',
    status: 'Shipped',
    date: 'Yesterday, 16:05',
    note: 'Tracking link appears in the order confirmation.'
  }
];

const navigation: readonly { id: ReviewSection; label: string; description: string }[] = [
  { id: 'prototype', label: 'Prototype', description: 'Review the runnable Orders experience.' },
  { id: 'flows', label: 'Flows & screens', description: 'Three screens and two decision paths.' },
  { id: 'components', label: 'Components', description: '12 reviewed components, 4 with notes.' },
  { id: 'changes', label: 'Changes', description: 'Revision 18 is ready for stakeholder review.' },
  { id: 'discussions', label: 'Discussions', description: 'Two open decisions need an answer.' },
  { id: 'handoff', label: 'Handoff', description: 'A concise implementation brief is prepared.' }
];

function isReviewSection(value: string): value is ReviewSection {
  return navigation.some((item) => item.id === value);
}

const staticReviewComments: readonly ReviewComment[] = Object.freeze([
  {
    id: 'comment-1',
    orderId: '#1048',
    revisionId: reviewArtifact.revisionId,
    baselineId: reviewArtifact.baselineId,
    artifactId: reviewArtifact.artifactId,
    author: 'Mina',
    timestamp: '12 min ago',
    body: 'Fixture review data: make address confirmation visible before fulfillment starts.'
  },
  {
    id: 'comment-2',
    orderId: '#1048',
    parentId: 'comment-1',
    revisionId: reviewArtifact.revisionId,
    baselineId: reviewArtifact.baselineId,
    artifactId: reviewArtifact.artifactId,
    author: 'Amir',
    timestamp: '8 min ago',
    body: 'Fixture reply: the status treatment is clear at a glance.'
  }
]);

function DetailPanel({
  order,
  mode,
  comments,
  onClose
}: {
  readonly order: Order;
  readonly mode: ReviewMode;
  readonly comments: readonly ReviewComment[];
  readonly onClose?: () => void;
}) {
  return (
    <section className="review-detail-panel" aria-label="Review details">
      <div className="detail-panel__heading">
        <div>
          <p className="eyebrow">Selected order</p>
          <h2>{order.id}</h2>
        </div>
        {onClose ? (
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close review details"
          >
            ×
          </button>
        ) : null}
      </div>
      <dl className="review-detail-list">
        <div>
          <dt>Customer</dt>
          <dd>{order.customer}</dd>
        </div>
        <div>
          <dt>Order total</dt>
          <dd>{order.total}</dd>
        </div>
        <div>
          <dt>Current state</dt>
          <dd>
            <span
              className={`order-status order-status--${order.status.replaceAll(' ', '-').toLowerCase()}`}
            >
              {order.status}
            </span>
          </dd>
        </div>
      </dl>
      <section className="review-note" aria-label="Review note">
        <p className="eyebrow">Review note</p>
        <p>{order.note}</p>
        <small>Attached to Orders table · revision 18</small>
      </section>
      <section className="review-comment-list" aria-label="Discussion on selected order">
        <p className="eyebrow">Static review data</p>
        <p className="review-data-notice">
          Fixture thread · {reviewArtifact.revisionId} against {reviewArtifact.baselineId} ·{' '}
          {reviewArtifact.artifactId}
        </p>
        {comments
          .filter((item) => item.parentId === undefined)
          .map((item) => (
            <article key={item.id}>
              <p>
                <strong>{item.author}</strong> <span>{item.timestamp}</span>
              </p>
              <p>{item.body}</p>
              {comments
                .filter((replyItem) => replyItem.parentId === item.id)
                .map((replyItem) => (
                  <div className="review-reply" key={replyItem.id}>
                    <p>
                      <strong>{replyItem.author}</strong> <span>{replyItem.timestamp}</span>
                    </p>
                    <p>{replyItem.body}</p>
                  </div>
                ))}
            </article>
          ))}
      </section>
      <section className="comment-composer" aria-label="Review comment">
        <p className="eyebrow">{mode === 'comment' ? 'Comment mode' : 'Inspect mode'}</p>
        {mode === 'comment' ? (
          <p className="static-mode-copy">
            Posting is unavailable in this static review portal. The thread above is fixture data,
            not a stored collaboration record.
          </p>
        ) : (
          <div className="inspect-copy">
            <p>Inspection is read-only. Static comment posting is unavailable.</p>
            <p>
              <strong>Provenance</strong>
              <br />
              {reviewArtifact.revisionId} compared with {reviewArtifact.baselineId}
            </p>
            <p>
              <strong>Review states</strong>
              <br />
              Orders list / Empty / Unavailable
            </p>
          </div>
        )}
      </section>
    </section>
  );
}

function ReviewSection({ section }: { readonly section: Exclude<ReviewSection, 'prototype'> }) {
  const content: Record<
    Exclude<ReviewSection, 'prototype'>,
    { readonly title: string; readonly items: readonly string[] }
  > = {
    flows: {
      title: 'Flows & screens',
      items: [
        'Orders list → order detail',
        'Needs review → confirmation',
        'Empty orders → saved filter state'
      ]
    },
    components: {
      title: 'Components',
      items: [
        'Order status badge · reviewed contrast',
        'Order table · fixture thread',
        'Fulfillment timeline · review draft'
      ]
    },
    changes: {
      title: 'Changes in revision 18',
      items: [
        'Clarified order status hierarchy',
        'Tightened the mobile table layout',
        'Added address-confirmation language'
      ]
    },
    discussions: {
      title: 'Discussions',
      items: [
        'Should address confirmation block fulfillment?',
        'Is the packed state clear enough for support?',
        'Resolved: keep order totals right-aligned'
      ]
    },
    handoff: {
      title: 'Handoff draft',
      items: [
        'Prototype state flow included in the handoff',
        'Components mapped for implementation review',
        'Two stakeholder decisions remain open'
      ]
    }
  };
  const view = content[section];
  if (section === 'handoff') {
    return (
      <section className="review-summary review-handoff" aria-label="Handoff draft">
        <p className="eyebrow">Developer handoff</p>
        <h1>Illustrative Orders React sample</h1>
        <p>
          This demo-only browser-generated TypeScript sample illustrates the reviewed order states.
          It is not an implementation receipt, a verified manifest, or an approval record.
        </p>
        <dl className="provenance-list">
          <div>
            <dt>Project</dt>
            <dd>{reviewArtifact.project}</dd>
          </div>
          <div>
            <dt>Revision</dt>
            <dd>
              {reviewArtifact.revision} · {reviewArtifact.revisionId}
            </dd>
          </div>
          <div>
            <dt>Baseline delta</dt>
            <dd>
              {reviewArtifact.baseline} · {reviewArtifact.baselineId}
            </dd>
          </div>
          <div>
            <dt>Fixture identity</dt>
            <dd>{reviewArtifact.artifactId}</dd>
          </div>
        </dl>
        <ul>
          {view.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <button className="primary-button" type="button" onClick={createDeveloperHandoff}>
          Download illustrative React + TypeScript sample
        </button>
      </section>
    );
  }
  return (
    <section className="review-summary" aria-label={view.title}>
      <p className="eyebrow">Hosted review</p>
      <h1>{view.title}</h1>
      <p>Everything here is a review artifact for the selected project revision.</p>
      <ul>
        {view.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function NoSelectionPanel() {
  return (
    <section className="review-detail-panel review-detail-panel--empty" aria-label="Review details">
      <p className="eyebrow">No order selected</p>
      <h2>Choose an order to review</h2>
      <p>
        Select an order from the prototype table to inspect its detail, discussion, or comment
        state.
      </p>
    </section>
  );
}

export function HostedReviewPortal() {
  const [section, setSection] = useState<ReviewSection>(sectionFromLocation);
  const [mode, setMode] = useState<ReviewMode>('comment');
  const [prototypeState, setPrototypeState] = useState<PrototypeState>('ready');
  const [selectedOrderId, setSelectedOrderId] = useState('#1048');
  const [filter, setFilter] = useState<'all' | 'attention' | 'fulfillment'>('all');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notice, setNotice] = useState('Viewing static review data for revision 18.');
  const detailTrigger = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const selectedOrder = orders.find((order) => order.id === selectedOrderId);
  const selectedComments =
    selectedOrder === undefined
      ? []
      : staticReviewComments.filter(
          (item) =>
            item.orderId === selectedOrder.id &&
            item.revisionId === reviewArtifact.revisionId &&
            item.baselineId === reviewArtifact.baselineId &&
            item.artifactId === reviewArtifact.artifactId
        );
  const visibleOrders = orders.filter((order) =>
    filter === 'all'
      ? true
      : filter === 'attention'
        ? order.status === 'Needs review'
        : order.status !== 'Needs review'
  );
  const reviewReadiness: Record<PrototypeState, string> = {
    ready: 'Ready scenario selected',
    loading: 'Loading scenario selected',
    empty: 'Empty scenario selected',
    error: 'Unavailable scenario selected'
  };

  useEffect(() => {
    if (!drawerOpen) return;
    const drawer = drawerRef.current;
    if (!drawer) return;
    const focusable = () => [
      ...drawer.querySelectorAll<HTMLElement>(
        'button:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )
    ];
    const restore = () => {
      setDrawerOpen(false);
      requestAnimationFrame(() => detailTrigger.current?.focus());
    };
    const keepFocusInDrawer = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !drawer.contains(target)) {
        const [first] = focusable();
        first?.focus();
      }
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        restore();
        return;
      }
      if (event.key !== 'Tab') return;
      const targets = focusable();
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const [firstFocusable] = focusable();
    firstFocusable?.focus();
    document.addEventListener('focusin', keepFocusInDrawer);
    document.addEventListener('keydown', closeOnKey);
    return () => {
      document.removeEventListener('focusin', keepFocusInDrawer);
      document.removeEventListener('keydown', closeOnKey);
    };
  }, [drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    const compactLayout = window.matchMedia('(max-width: 62rem)');
    const closeWhenDesktop = () => {
      if (!compactLayout.matches) closeDrawer();
    };
    compactLayout.addEventListener('change', closeWhenDesktop);
    return () => compactLayout.removeEventListener('change', closeWhenDesktop);
  }, [drawerOpen]);

  useEffect(() => {
    const restoreRoute = () => setSection(sectionFromLocation());
    const restoredRoute = new URLSearchParams(window.location.search).get('review');
    if (restoredRoute !== null) {
      const restoredSection = sectionFromLocation();
      window.history.replaceState(
        { reviewSection: restoredSection, restoredBy: 'github-pages-404' },
        '',
        reviewRoute(restoredSection)
      );
    }
    window.addEventListener('popstate', restoreRoute);
    return () => window.removeEventListener('popstate', restoreRoute);
  }, []);

  function navigate(sectionId: ReviewSection, message: string) {
    window.history.pushState({ reviewSection: sectionId }, '', reviewRoute(sectionId));
    setSection(sectionId);
    setNotice(message);
  }

  function showPrototypeState(nextState: PrototypeState) {
    setPrototypeState(nextState);
    setDrawerOpen(false);
    if (nextState === 'ready') {
      setSelectedOrderId('#1048');
      setNotice('Ready scenario selected. #1048 is selected from static fixture data.');
      return;
    }
    setSelectedOrderId('');
    const messages: Record<Exclude<PrototypeState, 'ready'>, string> = {
      loading: 'Loading scenario selected for static fixture review.',
      empty: 'Empty scenario selected for static fixture review.',
      error: 'Unavailable scenario selected for static fixture review.'
    };
    setNotice(messages[nextState]);
  }

  function closeDrawer() {
    setDrawerOpen(false);
    requestAnimationFrame(() => detailTrigger.current?.focus());
  }

  return (
    <main className="review-portal" aria-label="Northstar hosted review portal">
      <header className="review-header">
        <a
          className="review-brand"
          href={reviewRoute('prototype')}
          aria-label="Northstar review home"
          onClick={(event) => {
            event.preventDefault();
            navigate('prototype', 'Returned to the runnable Orders prototype.');
          }}
        >
          <span className="review-brand__mark" aria-hidden="true">
            N
          </span>
          <span>Northstar</span>
        </a>
        <div className="review-identity">
          <span>Orders experience</span>
          <span aria-hidden="true">/</span>
          <span>Revision 18</span>
        </div>
        <div
          className="review-readiness"
          aria-label="Review readiness"
          data-review-state={prototypeState}
        >
          <span className="readiness-dot" aria-hidden="true" />
          {reviewReadiness[prototypeState]}
        </div>
      </header>

      <nav className="review-nav" aria-label="Review sections">
        {navigation.map((item) => (
          <button
            type="button"
            key={item.id}
            className={section === item.id ? 'is-active' : ''}
            aria-current={section === item.id ? 'page' : undefined}
            onClick={() => navigate(item.id, item.description)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="review-toolbar">
        <div className="mode-switch" aria-label="Review interaction mode">
          <button
            type="button"
            className={mode === 'comment' ? 'is-active' : ''}
            aria-pressed={mode === 'comment'}
            onClick={() => setMode('comment')}
          >
            Comment
          </button>
          <button
            type="button"
            className={mode === 'inspect' ? 'is-active' : ''}
            aria-pressed={mode === 'inspect'}
            onClick={() => setMode('inspect')}
          >
            Inspect
          </button>
        </div>
        <p role="status">{notice}</p>
        <span className="mode-help">
          {mode === 'comment'
            ? 'Static review data is visible; posting is unavailable.'
            : 'Inspecting the revision without making changes.'}
        </span>
        <button
          ref={detailTrigger}
          className="details-trigger"
          type="button"
          disabled={selectedOrder === undefined}
          onClick={() => {
            if (selectedOrder === undefined) {
              setNotice('Select an order before opening review details.');
              return;
            }
            setDrawerOpen(true);
          }}
        >
          Review details
        </button>
      </div>

      <div className="review-layout">
        <section className="review-stage" id="prototype" aria-label="Hosted review content">
          {section === 'prototype' ? (
            <section className="orders-prototype" aria-label="Runnable Orders prototype">
              <div className="prototype-heading">
                <div>
                  <p className="eyebrow">Runnable prototype</p>
                  <h1>Orders</h1>
                  <p>Review the states your customers and operations team will actually use.</p>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    navigate('flows', 'Opened the documented Orders flow.');
                  }}
                >
                  View flow
                </button>
              </div>
              <div className="prototype-state-switch" aria-label="Prototype data state">
                <span>Scenario data</span>
                <button
                  type="button"
                  className={prototypeState === 'ready' ? 'is-active' : ''}
                  aria-pressed={prototypeState === 'ready'}
                  onClick={() => showPrototypeState('ready')}
                >
                  Ready scenario
                </button>
                <button
                  type="button"
                  className={prototypeState === 'loading' ? 'is-active' : ''}
                  aria-pressed={prototypeState === 'loading'}
                  onClick={() => showPrototypeState('loading')}
                >
                  Loading scenario
                </button>
                <button
                  type="button"
                  className={prototypeState === 'empty' ? 'is-active' : ''}
                  aria-pressed={prototypeState === 'empty'}
                  onClick={() => showPrototypeState('empty')}
                >
                  Empty scenario
                </button>
                <button
                  type="button"
                  className={prototypeState === 'error' ? 'is-active' : ''}
                  aria-pressed={prototypeState === 'error'}
                  onClick={() => showPrototypeState('error')}
                >
                  Unavailable scenario
                </button>
              </div>
              {prototypeState === 'ready' ? (
                <div className="orders-metrics" aria-label="Orders summary">
                  <div>
                    <span>Open orders</span>
                    <strong>24</strong>
                    <small>+8% this week</small>
                  </div>
                  <div>
                    <span>Needs review</span>
                    <strong>3</strong>
                    <small>1 needs a decision</small>
                  </div>
                  <div>
                    <span>Fulfillment time</span>
                    <strong>1.4d</strong>
                    <small>On target</small>
                  </div>
                </div>
              ) : (
                <section className="review-state-summary" aria-live="polite">
                  <p className="eyebrow">Review data status</p>
                  <p>{reviewReadiness[prototypeState]}.</p>
                </section>
              )}
              {prototypeState === 'ready' ? (
                <div className="orders-table-card">
                  <div className="orders-table-card__head">
                    <div>
                      <h2>Recent orders</h2>
                      <p>
                        Seeded review data · {staticReviewComments.length} fixture entries on this
                        revision
                      </p>
                    </div>
                    <div className="filter-group" aria-label="Order filters">
                      <button
                        type="button"
                        className={filter === 'all' ? 'is-active' : ''}
                        onClick={() => setFilter('all')}
                      >
                        All
                      </button>
                      <button
                        type="button"
                        className={filter === 'attention' ? 'is-active' : ''}
                        onClick={() => setFilter('attention')}
                      >
                        Needs review
                      </button>
                      <button
                        type="button"
                        className={filter === 'fulfillment' ? 'is-active' : ''}
                        onClick={() => setFilter('fulfillment')}
                      >
                        Fulfillment
                      </button>
                    </div>
                  </div>
                  <table className="orders-table" aria-label="Orders under review">
                    <thead>
                      <tr>
                        <th>Order</th>
                        <th>Customer</th>
                        <th>Status</th>
                        <th>Total</th>
                        <th>Placed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleOrders.map((order) => (
                        <tr
                          className={selectedOrder?.id === order.id ? 'is-selected' : ''}
                          key={order.id}
                        >
                          <td>
                            <button
                              type="button"
                              className="order-select"
                              aria-label={`Open ${order.id} review details`}
                              onClick={() => {
                                setSelectedOrderId(order.id);
                                setNotice(
                                  `${order.id} is selected for ${mode === 'comment' ? 'static review' : 'inspection'}.`
                                );
                              }}
                            >
                              {order.id}
                            </button>
                          </td>
                          <td>{order.customer}</td>
                          <td>
                            <span
                              className={`order-status order-status--${order.status.replaceAll(' ', '-').toLowerCase()}`}
                            >
                              {order.status}
                            </span>
                          </td>
                          <td>
                            <strong>{order.total}</strong>
                          </td>
                          <td>{order.date}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <section
                  className={`prototype-state prototype-state--${prototypeState}`}
                  aria-live="polite"
                >
                  {prototypeState === 'loading' ? (
                    <>
                      <p className="eyebrow">Scenario data</p>
                      <h2>Loading scenario</h2>
                      <p>The selected order is cleared for this static fixture scenario.</p>
                      <div className="loading-lines" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </div>
                    </>
                  ) : null}
                  {prototypeState === 'empty' ? (
                    <>
                      <p className="eyebrow">Scenario data</p>
                      <h2>Empty scenario</h2>
                      <p>
                        This static fixture intentionally has no orders to inspect or comment on.
                      </p>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => showPrototypeState('ready')}
                      >
                        Show ready scenario
                      </button>
                    </>
                  ) : null}
                  {prototypeState === 'error' ? (
                    <>
                      <p className="eyebrow">Scenario data</p>
                      <h2>Unavailable scenario</h2>
                      <p>This static fixture demonstrates an unavailable order view.</p>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => showPrototypeState('ready')}
                      >
                        Show ready scenario
                      </button>
                    </>
                  ) : null}
                </section>
              )}
            </section>
          ) : (
            <ReviewSection section={section} />
          )}
        </section>
        <aside className="review-aside">
          {selectedOrder === undefined ? (
            <NoSelectionPanel />
          ) : (
            <DetailPanel order={selectedOrder} mode={mode} comments={selectedComments} />
          )}
        </aside>
      </div>

      {drawerOpen && selectedOrder !== undefined ? (
        <div className="review-drawer-layer" role="presentation">
          <button
            className="review-drawer-scrim"
            type="button"
            aria-label="Close review details"
            onClick={closeDrawer}
          />
          <div
            ref={drawerRef}
            className="review-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Review details"
            tabIndex={-1}
          >
            <DetailPanel
              order={selectedOrder}
              mode={mode}
              comments={selectedComments}
              onClose={closeDrawer}
            />
          </div>
        </div>
      ) : null}
    </main>
  );
}

function DesignerWorkspaceApp() {
  const [workspace, setWorkspace] = useState<DesignerWorkspace>(sampleProject);
  const [notice, setNotice] = useState('Local-only workspace. Nothing is sent to a server.');

  useEffect(() => {
    void reopenProject(browserPersistence, 'northstar').then((saved) => {
      if (saved) {
        setWorkspace(saved);
        setNotice('Reopened the local Northstar workspace.');
      }
    });
  }, []);

  function persist(next: DesignerWorkspace, message: string) {
    setWorkspace(next);
    setNotice(message);
    void createProject(browserPersistence, next);
  }

  function dispatch(command: ProjectCommand, message: string) {
    persist(executeProjectCommand(workspace, command), message);
  }

  function exportCurrentProject() {
    const data = exportProject(workspace);
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${workspace.projectId}.selene.json`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice('Exported a portable project file.');
  }

  return (
    <>
      <DesignerWorkspaceView
        workspace={workspace}
        notice={notice}
        onCreate={() => persist(sampleProject(), 'Created a fresh local Northstar project.')}
        onOpenFile={(file) => {
          void file
            .text()
            .then(openProject)
            .then((opened) => persist(opened, `Opened ${opened.name}.`))
            .catch((error: unknown) =>
              setNotice(error instanceof Error ? error.message : 'Could not open that project.')
            );
        }}
        onExport={exportCurrentProject}
        onReopen={() => {
          void reopenProject(browserPersistence, workspace.projectId).then((saved) => {
            if (saved) persist(saved, `Reopened ${saved.name}.`);
            else setNotice('No saved project was found yet.');
          });
        }}
        onScreenChange={(screenId) =>
          dispatch({ type: 'select-screen', screenId }, 'Navigated the live preview.')
        }
        onStateChange={(state) =>
          dispatch({ type: 'select-state', state }, `Switched preview to ${state}.`)
        }
        onNodeSelect={(nodeId) => dispatch({ type: 'select-node', nodeId }, `Selected ${nodeId}.`)}
        onAddComment={(body) =>
          dispatch(
            {
              type: 'add-comment',
              id: commandId('comment'),
              nodeId: workspace.selectedNodeId ?? 'dashboard.hero',
              body,
              author: 'You',
              createdAt: new Date().toISOString()
            },
            'Added a node-level comment.'
          )
        }
        onResolveComment={(commentId) =>
          dispatch(
            { type: 'resolve-comment', commentId, resolvedAt: new Date().toISOString() },
            'Resolved the comment.'
          )
        }
        onAddDirection={(body) =>
          dispatch(
            {
              type: 'add-direction',
              id: commandId('direction'),
              body,
              createdAt: new Date().toISOString()
            },
            'Added a developer handoff direction.'
          )
        }
        onStatusChange={(status: WorkspaceStatus) =>
          dispatch({ type: 'set-status', status }, `Set project status to ${status}.`)
        }
      />
      <PrototypeStudio />
    </>
  );
}

/** Web hosts the reusable designer runtime while graph validation remains in core. */
function PrototypeStudio() {
  const [graph, setGraph] = useState<PrototypeGraph>(editablePrototypeFixture);
  const runtime = useRef<PrototypeRuntime>(
    createPrototypeRuntime(editablePrototypeFixture, 'orders-default')
  );
  const browserNavigation = useRef(createPrototypeBrowserNavigation(editablePrototypeFixture));
  const [snapshot, setSnapshot] = useState(() => runtime.current.snapshot());
  const [notice, setNotice] = useState(
    'Wire the Create order action to run this compiled React prototype.'
  );

  function resetRuntime(nextGraph: PrototypeGraph) {
    const scenarioId = runtime.current.snapshot().scenarioId;
    runtime.current = createPrototypeRuntime(
      nextGraph,
      scenarioId !== undefined && nextGraph.scenarios.some((item) => item.id === scenarioId)
        ? scenarioId
        : undefined
    );
    setSnapshot(runtime.current.snapshot());
  }

  useEffect(() => {
    const browserNav = createPrototypeBrowserNavigation(graph);
    browserNavigation.current = browserNav;
    browserNav.replace(runtime.current.snapshot());
    return browserNav.onPopState((saved) => {
      try {
        setSnapshot(runtime.current.restore(saved));
        setNotice('Restored prototype navigation from browser history.');
      } catch {
        setNotice('Ignored an invalid browser prototype history entry.');
      }
    });
  }, [graph]);

  function updateGraph(nextGraph: PrototypeGraph) {
    setGraph(nextGraph);
    resetRuntime(nextGraph);
    setNotice('Updated the portable flow graph and restarted its local runtime.');
  }

  function run(action: { type: 'trigger'; nodeId: string; portId: string } | { type: 'back' }) {
    try {
      const transition =
        action.type === 'trigger'
          ? graph.transitions.find(
              (item) => item.from.nodeId === action.nodeId && item.from.portId === action.portId
            )
          : undefined;
      if (action.type === 'back' || transition?.kind === 'back') {
        const previous = runtime.current.snapshot();
        const next = runtime.current.dispatch(action);
        if (next.history.length < previous.history.length) window.history.back();
        else {
          setSnapshot(next);
          browserNavigation.current.replace(next);
          setNotice('Prototype history is already at its local boundary.');
        }
        return;
      }
      const previous = runtime.current.snapshot();
      const next = runtime.current.dispatch(action);
      setSnapshot(next);
      if (next.activeNodeId !== previous.activeNodeId) browserNavigation.current.push(next);
      else browserNavigation.current.replace(next);
      setNotice('Prototype action completed locally.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Prototype action failed.');
    }
  }

  function startScenario(scenarioId: string) {
    try {
      runtime.current = createPrototypeRuntime(graph, scenarioId);
      const next = runtime.current.snapshot();
      setSnapshot(next);
      browserNavigation.current.replace(next);
      setNotice(`Started scenario ${scenarioId}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not start scenario.');
    }
  }

  useEffect(
    () =>
      schedulePrototypeTimeouts(
        runtime.current,
        {
          setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
          clearTimeout: (handle) => window.clearTimeout(handle as number)
        },
        (next) => {
          if (next.activeNodeId !== snapshot.activeNodeId) browserNavigation.current.push(next);
          else browserNavigation.current.replace(next);
          setSnapshot(next);
          setNotice('Prototype timeout completed locally.');
        },
        (failure) => {
          setNotice(
            `Prototype timeout failed for ${failure.nodeId}.${failure.portId}: ${
              failure.error instanceof Error ? failure.error.message : 'unexpected host error'
            }`
          );
        }
      ),
    [graph, snapshot]
  );

  return (
    <section className="prototype-studio" aria-label="Prototype editor and runtime">
      <div className="prototype-studio__intro">
        <p className="prototype-kicker">Local prototype workspace</p>
        <h2>Flow canvas and runtime</h2>
        <p role="status" aria-label="Prototype status">
          {notice}
        </p>
      </div>
      <div className="prototype-studio__grid">
        <PrototypeFlowCanvas
          graph={graph}
          onGraphChange={updateGraph}
          activeNodeIds={[
            snapshot.activeNodeId,
            snapshot.activeStateId,
            snapshot.activeOverlayId
          ].filter((nodeId): nodeId is string => nodeId !== undefined)}
          activeTransitionIds={snapshot.activePathTransitionIds}
        />
        <PrototypeRuntimePreview
          graph={graph}
          snapshot={snapshot}
          onTrigger={(nodeId, portId) => run({ type: 'trigger', nodeId, portId })}
          onBack={() => run({ type: 'back' })}
          onScenarioStart={startScenario}
        />
      </div>
    </section>
  );
}

/** The local designer remains the normal web root; hosted review is an explicit route or build. */
export function App() {
  return isHostedReviewLocation() ? <HostedReviewPortal /> : <DesignerWorkspaceApp />;
}
