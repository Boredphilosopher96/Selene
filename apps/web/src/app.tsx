import { type PointerEvent, useEffect, useRef, useState } from 'react';

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
import {
  browserHostedReviewCollaboration,
  canonicalArtifactPinId,
  type ArtifactAnchor,
  type ArtifactPin,
  type ArtifactPoint,
  type ArtifactRegion,
  type ReviewThread
} from './hosted-review-collaboration';
import {
  ordersReviewArtifact as reviewArtifact,
  ordersReviewHandoffManifest,
  ordersReviewHandoffSource
} from './orders-review-handoff';

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

const artifactFields = ['order', 'customer', 'status', 'total', 'placed'] as const;
type ArtifactField = (typeof artifactFields)[number];
type ArtifactHit = {
  readonly orderId: string;
  readonly field: ArtifactField;
  readonly component: string;
};

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

function downloadDeveloperHandoff(): void {
  for (const [name, contents, type] of [
    ['orders-review-r18.tsx', ordersReviewHandoffSource, 'text/plain'],
    [
      'orders-review-r18.manifest.json',
      JSON.stringify(ordersReviewHandoffManifest, null, 2),
      'application/json'
    ]
  ] as const) {
    const url = URL.createObjectURL(new Blob([contents], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }
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
  {
    id: 'components',
    label: 'Components',
    description: 'Reviewed component and artifact-pin inventory.'
  },
  { id: 'changes', label: 'Changes', description: 'Revision 18 is ready for stakeholder review.' },
  { id: 'discussions', label: 'Discussions', description: 'Two open decisions need an answer.' },
  { id: 'handoff', label: 'Handoff', description: 'Exact revision handoff artifact and manifest.' }
];

function isReviewSection(value: string): value is ReviewSection {
  return navigation.some((item) => item.id === value);
}

function reviewId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function coordinate(value: number): string {
  return value.toFixed(4);
}

function anchorKey(anchor: ArtifactAnchor): string {
  const { point, region } = anchor;
  return [
    anchor.selector,
    anchor.component,
    coordinate(point.x),
    coordinate(point.y),
    coordinate(region.x),
    coordinate(region.y),
    coordinate(region.width),
    coordinate(region.height)
  ].join('|');
}

function anchorsMatch(
  left: ArtifactAnchor | undefined,
  right: ArtifactAnchor | undefined
): boolean {
  return left !== undefined && right !== undefined && anchorKey(left) === anchorKey(right);
}

function pinForOrder(order: Order, anchor: ArtifactAnchor): ArtifactPin {
  const input = {
    projectId: reviewArtifact.projectId,
    revisionId: reviewArtifact.revisionId,
    baselineId: reviewArtifact.baselineId,
    artifactId: reviewArtifact.artifactId,
    orderId: order.id,
    anchor
  };
  return { id: canonicalArtifactPinId(input), ...input };
}

function formatAnchor(anchor: ArtifactAnchor): string {
  const { point, region } = anchor;
  return `${anchor.component} · ${anchor.selector} · point ${Math.round(point.x * 100)}%, ${Math.round(
    point.y * 100
  )}% · region ${Math.round(region.width * 100)}% × ${Math.round(region.height * 100)}%`;
}

function isArtifactField(value: string | undefined): value is ArtifactField {
  return value !== undefined && artifactFields.some((field) => field === value);
}

function threadContext(thread: ReviewThread): string {
  const latestMessage = thread.messages[thread.messages.length - 1];
  const body = latestMessage?.body ?? 'No message';
  return body.length > 120 ? `${body.slice(0, 117)}…` : body;
}

function DetailPanel({
  order,
  mode,
  threads,
  anchor,
  onCreateThread,
  onReply,
  onResolve,
  onReopen,
  onClose
}: {
  readonly order: Order;
  readonly mode: ReviewMode;
  readonly threads: readonly ReviewThread[];
  readonly anchor: ArtifactAnchor | undefined;
  readonly onCreateThread: (body: string) => boolean;
  readonly onReply: (threadId: string, body: string) => boolean;
  readonly onResolve: (threadId: string) => void;
  readonly onReopen: (threadId: string) => void;
  readonly onClose?: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const pin = anchor === undefined ? undefined : pinForOrder(order, anchor);
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
        {pin === undefined ? (
          <small>Select a point or region on the artifact before creating a pinned thread.</small>
        ) : (
          <small>
            Artifact pin · {formatAnchor(pin.anchor)} · revision {reviewArtifact.revision}
          </small>
        )}
      </section>
      <section className="review-comment-list" aria-label="Discussion on selected order">
        <p className="eyebrow">Revision-bound discussion</p>
        {pin !== undefined ? (
          <p className="review-data-notice">Artifact pin · {formatAnchor(pin.anchor)}</p>
        ) : null}
        {pin === undefined ? (
          <p className="review-data-notice">
            Choose a real artifact point or drag a region to bind this discussion.
          </p>
        ) : (
          <p className="review-data-notice">
            Local durable review store · {pin.id} · baseline {reviewArtifact.baselineId}
          </p>
        )}
        {pin !== undefined && threads.length === 0 ? (
          <p className="review-data-notice">No threads for this pinned region.</p>
        ) : null}
        {threads.map((thread) => (
          <article key={thread.id} data-thread-status={thread.status}>
            <p>
              <strong>{thread.status === 'resolved' ? 'Resolved thread' : 'Open thread'}</strong>{' '}
              <span>{formatAnchor(thread.pin.anchor)}</span>
            </p>
            {thread.messages.map((message) => (
              <div className="review-reply" key={message.id}>
                <p>
                  <strong>{message.author}</strong>{' '}
                  <span>{new Date(message.createdAt).toLocaleString()}</span>
                </p>
                <p>{message.body}</p>
              </div>
            ))}
            {mode === 'comment' ? (
              <form
                className="thread-actions"
                onSubmit={(event) => {
                  event.preventDefault();
                  const body = replyDrafts[thread.id]?.trim();
                  if (!body) return;
                  if (onReply(thread.id, body)) {
                    setReplyDrafts((current) => ({ ...current, [thread.id]: '' }));
                  }
                }}
              >
                <textarea
                  aria-label={`Reply to ${thread.id}`}
                  value={replyDrafts[thread.id] ?? ''}
                  onChange={(event) =>
                    setReplyDrafts((current) => ({
                      ...current,
                      [thread.id]: event.currentTarget.value
                    }))
                  }
                  placeholder="Reply with an implementation decision"
                  maxLength={4000}
                />
                <button type="submit">Reply</button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    thread.status === 'open' ? onResolve(thread.id) : onReopen(thread.id)
                  }
                >
                  {thread.status === 'open' ? 'Resolve' : 'Reopen'}
                </button>
              </form>
            ) : null}
          </article>
        ))}
      </section>
      <section className="comment-composer" aria-label="Review comment">
        <p className="eyebrow">{mode === 'comment' ? 'Comment mode' : 'Inspect mode'}</p>
        {mode === 'comment' && pin !== undefined ? (
          <form
            className="thread-actions"
            onSubmit={(event) => {
              event.preventDefault();
              const body = draft.trim();
              if (!body) return;
              if (onCreateThread(body)) setDraft('');
            }}
          >
            <textarea
              aria-label="Start revision-bound thread"
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              placeholder="Describe the decision or baseline change for this region"
              maxLength={4000}
            />
            <button type="submit" className="primary-button">
              Start pinned thread
            </button>
            <p className="static-mode-copy">
              Saved in this browser's durable local review store; no remote collaboration provider
              is configured.
            </p>
          </form>
        ) : mode === 'comment' ? (
          <p className="static-mode-copy">
            Select an artifact point or region before writing a local pinned thread. This browser
            uses a durable local review store; no remote collaboration provider is configured.
          </p>
        ) : (
          <div className="inspect-copy">
            <p>
              Inspection is read-only. Switch to Comment mode to write to the local review store.
            </p>
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

function baselineAnchor(
  orderId: string,
  field: string,
  point: ArtifactPoint,
  region: ArtifactRegion
): ArtifactAnchor {
  return {
    selector: `[data-review-order="${orderId}"] [data-artifact-field="${field}"]`,
    component: 'OrdersReviewRow',
    point,
    region
  };
}

const baselineChanges = [
  {
    orderId: '#1048',
    anchor: baselineAnchor(
      '#1048',
      'status',
      { x: 0.55, y: 0.48 },
      { x: 0.46, y: 0.42, width: 0.2, height: 0.14 }
    ),
    title: 'Status hierarchy',
    body: 'Needs review now names the fulfillment decision before packing begins.'
  },
  {
    orderId: '#1048',
    anchor: baselineAnchor(
      '#1048',
      'customer',
      { x: 0.31, y: 0.48 },
      { x: 0.2, y: 0.42, width: 0.24, height: 0.14 }
    ),
    title: 'Address confirmation',
    body: 'The baseline did not expose address confirmation before fulfillment.'
  },
  {
    orderId: '#1047',
    anchor: baselineAnchor(
      '#1047',
      'row',
      { x: 0.5, y: 0.61 },
      { x: 0.03, y: 0.55, width: 0.94, height: 0.14 }
    ),
    title: 'Mobile table layout',
    body: 'The revised row keeps customer, status, and total readable in a compact layout.'
  }
] as const;

function ReviewSection({
  section,
  onPinBaselineChange
}: {
  readonly section: Exclude<ReviewSection, 'prototype'>;
  readonly onPinBaselineChange: (orderId: string, anchor: ArtifactAnchor, title: string) => void;
}) {
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
        'Order table · artifact pins',
        'Fulfillment timeline · revision-bound review'
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
      title: 'Developer handoff',
      items: [
        'Prototype state flow included in the handoff',
        'Components mapped for implementation review',
        'Revision, baseline, and Storybook provenance included'
      ]
    }
  };
  const view = content[section];
  if (section === 'handoff') {
    return (
      <section className="review-summary review-handoff" aria-label="Developer handoff">
        <p className="eyebrow">Developer handoff</p>
        <h1>Immutable Orders React + TypeScript handoff</h1>
        <p>
          Download the committed artifact and its manifest together. The content-addressed receipt
          binds the exact review revision, baseline, component catalog, and verification commands.
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
            <dt>Artifact ID</dt>
            <dd>{reviewArtifact.artifactId}</dd>
          </div>
          <div>
            <dt>Content ref</dt>
            <dd>{reviewArtifact.content.ref}</dd>
          </div>
          <div>
            <dt>Artifact digest</dt>
            <dd>
              {reviewArtifact.content.digest.algorithm} · {reviewArtifact.content.digest.value}
            </dd>
          </div>
          <div>
            <dt>Artifact blob</dt>
            <dd>
              {reviewArtifact.content.blob.name} · {reviewArtifact.content.blob.mediaType}
            </dd>
          </div>
          <div>
            <dt>Build Git provenance</dt>
            <dd>Not injected in this static artifact.</dd>
          </div>
          <div>
            <dt>Toolchain</dt>
            <dd>
              {ordersReviewHandoffManifest.toolchain.runtime} · React{' '}
              {ordersReviewHandoffManifest.toolchain.react} · TypeScript{' '}
              {ordersReviewHandoffManifest.toolchain.typescript}
            </dd>
          </div>
          <div>
            <dt>Design system</dt>
            <dd>
              {ordersReviewHandoffManifest.designSystem.package} ·{' '}
              {ordersReviewHandoffManifest.designSystem.reference}
            </dd>
          </div>
          <div>
            <dt>Scenarios</dt>
            <dd>{ordersReviewHandoffManifest.scenarios.join(', ')}</dd>
          </div>
          <div>
            <dt>Components</dt>
            <dd>{ordersReviewHandoffManifest.components.join(', ')}</dd>
          </div>
          <div>
            <dt>Storybook provenance</dt>
            <dd>
              {ordersReviewHandoffManifest.storybook.source} ·{' '}
              {ordersReviewHandoffManifest.storybook.stories.join(', ')}
            </dd>
          </div>
          <div>
            <dt>Implementation directions</dt>
            <dd>{ordersReviewHandoffManifest.directions.join(' ')}</dd>
          </div>
          <div>
            <dt>Install · build · verify</dt>
            <dd>
              {ordersReviewHandoffManifest.commands.install} ·{' '}
              {ordersReviewHandoffManifest.commands.build} ·{' '}
              {ordersReviewHandoffManifest.commands.verify}
            </dd>
          </div>
        </dl>
        <ul>
          {view.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <button className="primary-button" type="button" onClick={downloadDeveloperHandoff}>
          Download exact React artifact + manifest
        </button>
      </section>
    );
  }
  if (section === 'changes') {
    return (
      <section className="review-summary" aria-label="Changes in revision 18">
        <p className="eyebrow">Revision-bound baseline delta</p>
        <h1>Changes in revision {reviewArtifact.revision}</h1>
        <p>
          Each change targets a concrete artifact region and opens a thread bound to this revision
          and baseline.
        </p>
        <div className="baseline-change-list">
          {baselineChanges.map((change) => (
            <article key={change.title}>
              <h2>{change.title}</h2>
              <p>{change.body}</p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => onPinBaselineChange(change.orderId, change.anchor, change.title)}
              >
                Open pinned discussion
              </button>
            </article>
          ))}
        </div>
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

function SavedThreadsRail({
  threads,
  onOpenThread
}: {
  readonly threads: readonly ReviewThread[];
  readonly onOpenThread: (thread: ReviewThread) => void;
}) {
  return (
    <section className="saved-threads-rail" aria-label="Saved local review threads">
      <div>
        <p className="eyebrow">Local review pins</p>
        <h2>Saved threads</h2>
      </div>
      {threads.length === 0 ? (
        <p>No local revision-bound threads are saved for this artifact.</p>
      ) : (
        <ul>
          {threads.map((thread) => (
            <li id={`saved-thread-${thread.id}`} key={thread.id} data-saved-thread-ref={thread.id}>
              <button
                id={`open-saved-thread-${thread.id}`}
                type="button"
                aria-describedby={`saved-thread-context-${thread.id}`}
                aria-label={`Open saved thread ${thread.id}; ${thread.status}; ${threadContext(thread)}`}
                onClick={() => onOpenThread(thread)}
              >
                Open {thread.pin.orderId} · {thread.pin.anchor.component} pin
              </button>
              <p id={`saved-thread-context-${thread.id}`}>
                Thread ref {thread.id} · {thread.status} · {threadContext(thread)}
              </p>
              <small>
                {thread.status === 'resolved' ? 'Resolved' : 'Open'} ·{' '}
                {formatAnchor(thread.pin.anchor)}
              </small>
            </li>
          ))}
        </ul>
      )}
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
  const [activeAnchor, setActiveAnchor] = useState<ArtifactAnchor>();
  const [selectionMode, setSelectionMode] = useState<'point' | 'region'>();
  const [selectionPreview, setSelectionPreview] = useState<ArtifactRegion>();
  const [threads, setThreads] = useState<readonly ReviewThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string>();
  const [notice, setNotice] = useState('Viewing revision-bound review data for revision 18.');
  const [storageError, setStorageError] = useState<string>();
  const detailTrigger = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const artifactSurfaceRef = useRef<HTMLDivElement>(null);
  const selectionStartRef = useRef<ArtifactPoint | undefined>(undefined);
  const selectionHitRef = useRef<ArtifactHit | undefined>(undefined);
  const selectedOrder = orders.find((order) => order.id === selectedOrderId);
  const selectedThreads =
    selectedOrder === undefined
      ? []
      : threads.filter(
          (thread) =>
            thread.pin.orderId === selectedOrder.id &&
            anchorsMatch(thread.pin.anchor, activeAnchor) &&
            (activeThreadId === undefined || thread.id === activeThreadId)
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
    setThreads(browserHostedReviewCollaboration.load(reviewArtifact));
  }, []);

  function updateThreads(next: readonly ReviewThread[], message: string): boolean {
    const result = browserHostedReviewCollaboration.save(reviewArtifact, next);
    if (!result.ok) {
      const errors = {
        invalid:
          'Local review storage rejected this change because a field exceeds 4,000 characters. Existing saved threads and drafts were kept.',
        oversize:
          'Local review storage rejected this change because serialized review data exceeds 250 KiB. Existing saved threads and drafts were kept.',
        quota:
          'Local review storage quota prevented this change. Existing saved threads and drafts were kept.'
      } as const;
      setStorageError(errors[result.code]);
      setNotice(errors[result.code]);
      return false;
    }
    setStorageError(undefined);
    setThreads(next);
    setNotice(message);
    return true;
  }

  function createThread(body: string): boolean {
    if (selectedOrder === undefined || activeAnchor === undefined) return false;
    const now = new Date().toISOString();
    const thread: ReviewThread = {
      id: reviewId('thread'),
      pin: pinForOrder(selectedOrder, activeAnchor),
      status: 'open',
      messages: [{ id: reviewId('message'), author: 'You', body, createdAt: now }]
    };
    const saved = updateThreads(
      [...threads, thread],
      `Created a revision-bound thread for ${formatAnchor(thread.pin.anchor)}.`
    );
    if (saved) setActiveThreadId(thread.id);
    return saved;
  }

  function replyToThread(threadId: string, body: string): boolean {
    const now = new Date().toISOString();
    return updateThreads(
      threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              messages: [
                ...thread.messages,
                { id: reviewId('reply'), author: 'You', body, createdAt: now }
              ]
            }
          : thread
      ),
      'Saved reply in the local revision-bound review store.'
    );
  }

  function setThreadStatus(threadId: string, status: ReviewThread['status']) {
    const now = new Date().toISOString();
    updateThreads(
      threads.map((thread) => {
        if (thread.id !== threadId) return thread;
        if (status === 'resolved') return { ...thread, status, resolvedAt: now };
        const { resolvedAt: _resolvedAt, ...reopened } = thread;
        return { ...reopened, status };
      }),
      status === 'resolved'
        ? 'Resolved the revision-bound thread.'
        : 'Reopened the revision-bound thread.'
    );
  }

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
      setNotice('Ready scenario selected. #1048 is selected for revision-bound review.');
      return;
    }
    setSelectedOrderId('');
    const messages: Record<Exclude<PrototypeState, 'ready'>, string> = {
      loading: 'Loading scenario selected for review.',
      empty: 'Empty scenario selected for review.',
      error: 'Unavailable scenario selected for review.'
    };
    setNotice(messages[nextState]);
  }

  function closeDrawer() {
    setDrawerOpen(false);
    requestAnimationFrame(() => detailTrigger.current?.focus());
  }

  function pointerCoordinate(event: PointerEvent<HTMLDivElement>): ArtifactPoint | undefined {
    const surface = artifactSurfaceRef.current;
    if (surface === null) return undefined;
    const bounds = surface.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return undefined;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height))
    };
  }

  function regionBetween(start: ArtifactPoint, end: ArtifactPoint): ArtifactRegion {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    return { x, y, width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
  }

  function resolvedArtifactHit(clientX: number, clientY: number): ArtifactHit | undefined {
    const surface = artifactSurfaceRef.current;
    if (surface === null) return undefined;
    // The capture overlay is intentionally painted above the artifact. Skip it,
    // then preserve browser paint order for the first real field beneath it.
    return document
      .elementsFromPoint(clientX, clientY)
      .map((element): ArtifactHit | undefined => {
        if (!(element instanceof HTMLElement) || element.closest('.artifact-selection-overlay'))
          return undefined;
        const fieldElement = element.closest<HTMLElement>('[data-artifact-field]');
        if (fieldElement === null || !surface.contains(fieldElement)) return undefined;
        const field = fieldElement.dataset.artifactField;
        const row = fieldElement.closest<HTMLElement>('[data-review-order]');
        const orderId = row?.dataset.reviewOrder;
        if (
          !isArtifactField(field) ||
          row === null ||
          !surface.contains(row) ||
          orderId === undefined ||
          !orders.some((order) => order.id === orderId)
        ) {
          return undefined;
        }
        return {
          orderId,
          field,
          component: field === 'status' ? 'OrderStatus' : 'OrdersReviewRow'
        };
      })
      .find((hit): hit is ArtifactHit => hit !== undefined);
  }

  function clearArtifactSelection() {
    selectionStartRef.current = undefined;
    selectionHitRef.current = undefined;
    setSelectionPreview(undefined);
    setSelectionMode(undefined);
  }

  function selectArtifactAnchor(event: PointerEvent<HTMLDivElement>) {
    const start = selectionStartRef.current;
    const hit = selectionHitRef.current;
    const end = pointerCoordinate(event);
    clearArtifactSelection();
    if (start === undefined || end === undefined || hit === undefined) {
      setNotice(
        'No reviewable artifact row or field was found at that point; the current anchor is unchanged.'
      );
      return;
    }
    const region =
      selectionMode === 'point'
        ? { x: end.x, y: end.y, width: 0, height: 0 }
        : regionBetween(start, end);
    const anchor: ArtifactAnchor = {
      selector: `[data-review-order="${hit.orderId}"] [data-artifact-field="${hit.field}"]`,
      component: hit.component,
      point: end,
      region
    };
    setSelectedOrderId(hit.orderId);
    setActiveAnchor(anchor);
    setActiveThreadId(undefined);
    setNotice(`Selected ${selectionMode} anchor: ${formatAnchor(anchor)}.`);
  }

  function openBaselineChange(orderId: string, anchor: ArtifactAnchor, title: string) {
    setSelectedOrderId(orderId);
    setActiveAnchor(anchor);
    setActiveThreadId(undefined);
    setSection('prototype');
    window.history.pushState({ reviewSection: 'prototype' }, '', reviewRoute('prototype'));
    setNotice(`${title} is selected as a pinned baseline change: ${formatAnchor(anchor)}.`);
  }

  function openSavedThread(thread: ReviewThread) {
    const order = orders.find((candidate) => candidate.id === thread.pin.orderId);
    if (order === undefined) {
      setNotice('The saved thread references an unavailable order and cannot be opened.');
      return;
    }
    setPrototypeState('ready');
    setSelectedOrderId(order.id);
    setActiveAnchor(thread.pin.anchor);
    setActiveThreadId(thread.id);
    if (section !== 'prototype') {
      window.history.pushState({ reviewSection: 'prototype' }, '', reviewRoute('prototype'));
      setSection('prototype');
    }
    setNotice(`Opened saved local thread for ${formatAnchor(thread.pin.anchor)}.`);
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
        <div className="artifact-selection-controls" aria-label="Artifact pin selection">
          <span>Pin selection</span>
          <button
            type="button"
            className={selectionMode === 'point' ? 'is-active' : ''}
            aria-pressed={selectionMode === 'point'}
            onClick={() =>
              setSelectionMode((current) => (current === 'point' ? undefined : 'point'))
            }
          >
            Point
          </button>
          <button
            type="button"
            className={selectionMode === 'region' ? 'is-active' : ''}
            aria-pressed={selectionMode === 'region'}
            onClick={() =>
              setSelectionMode((current) => (current === 'region' ? undefined : 'region'))
            }
          >
            Region
          </button>
        </div>
        <p role="status">{notice}</p>
        <span className="mode-help">
          {mode === 'comment'
            ? 'Select a point or region, then save a local revision-bound thread.'
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

      {storageError === undefined ? null : (
        <p className="review-storage-error" role="alert">
          {storageError}
        </p>
      )}

      <SavedThreadsRail threads={threads} onOpenThread={openSavedThread} />

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
                        Revision-bound review data · {threads.length} local thread
                        {threads.length === 1 ? '' : 's'} on this artifact
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
                  <div
                    ref={artifactSurfaceRef}
                    className="artifact-surface"
                    data-artifact-surface="orders-table"
                  >
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
                            data-review-order={order.id}
                            key={order.id}
                          >
                            <td data-artifact-field="order">
                              <button
                                type="button"
                                className="order-select"
                                aria-label={`Open ${order.id} review details`}
                                onClick={() => {
                                  setSelectedOrderId(order.id);
                                  setActiveAnchor(undefined);
                                  setNotice(
                                    `${order.id} is selected for ${mode === 'comment' ? 'revision-bound review' : 'inspection'}.`
                                  );
                                }}
                              >
                                {order.id}
                              </button>
                            </td>
                            <td data-artifact-field="customer">{order.customer}</td>
                            <td data-artifact-field="status">
                              <span
                                className={`order-status order-status--${order.status.replaceAll(' ', '-').toLowerCase()}`}
                              >
                                {order.status}
                              </span>
                            </td>
                            <td data-artifact-field="total">
                              <strong>{order.total}</strong>
                            </td>
                            <td data-artifact-field="placed">{order.date}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {selectionMode !== undefined ? (
                      <div
                        className={`artifact-selection-overlay artifact-selection-overlay--${selectionMode}`}
                        aria-label={`Select ${selectionMode} on the Orders artifact`}
                        onPointerDown={(event) => {
                          selectionStartRef.current = undefined;
                          selectionHitRef.current = undefined;
                          const point = pointerCoordinate(event);
                          const hit = resolvedArtifactHit(event.clientX, event.clientY);
                          if (point === undefined || hit === undefined) return;
                          event.currentTarget.setPointerCapture(event.pointerId);
                          selectionStartRef.current = point;
                          selectionHitRef.current = hit;
                          setSelectionPreview({ x: point.x, y: point.y, width: 0, height: 0 });
                        }}
                        onPointerMove={(event) => {
                          const start = selectionStartRef.current;
                          const point = pointerCoordinate(event);
                          if (start === undefined || point === undefined) return;
                          setSelectionPreview(
                            selectionMode === 'point'
                              ? { x: point.x, y: point.y, width: 0, height: 0 }
                              : regionBetween(start, point)
                          );
                        }}
                        onPointerUp={selectArtifactAnchor}
                        onPointerCancel={clearArtifactSelection}
                      />
                    ) : null}
                    {activeAnchor !== undefined ? (
                      <span
                        className="artifact-anchor-highlight"
                        aria-hidden="true"
                        style={{
                          left: `${activeAnchor.region.x * 100}%`,
                          top: `${activeAnchor.region.y * 100}%`,
                          width: `${Math.max(activeAnchor.region.width, 0.015) * 100}%`,
                          height: `${Math.max(activeAnchor.region.height, 0.04) * 100}%`
                        }}
                      />
                    ) : null}
                    {selectionPreview !== undefined ? (
                      <span
                        className="artifact-anchor-preview"
                        aria-hidden="true"
                        style={{
                          left: `${selectionPreview.x * 100}%`,
                          top: `${selectionPreview.y * 100}%`,
                          width: `${Math.max(selectionPreview.width, 0.015) * 100}%`,
                          height: `${Math.max(selectionPreview.height, 0.04) * 100}%`
                        }}
                      />
                    ) : null}
                  </div>
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
                      <p>The selected order is cleared for this scenario.</p>
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
                      <p>This scenario intentionally has no orders to inspect or comment on.</p>
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
                      <p>This scenario demonstrates an unavailable order view.</p>
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
            <ReviewSection section={section} onPinBaselineChange={openBaselineChange} />
          )}
        </section>
        <aside className="review-aside">
          {selectedOrder === undefined ? (
            <NoSelectionPanel />
          ) : (
            <DetailPanel
              order={selectedOrder}
              mode={mode}
              threads={selectedThreads}
              anchor={activeAnchor}
              onCreateThread={createThread}
              onReply={replyToThread}
              onResolve={(threadId) => setThreadStatus(threadId, 'resolved')}
              onReopen={(threadId) => setThreadStatus(threadId, 'open')}
            />
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
              threads={selectedThreads}
              anchor={activeAnchor}
              onCreateThread={createThread}
              onReply={replyToThread}
              onResolve={(threadId) => setThreadStatus(threadId, 'resolved')}
              onReopen={(threadId) => setThreadStatus(threadId, 'open')}
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
