import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState
} from 'react';

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
  canonicalArtifactPinId,
  type ArtifactAnchor,
  type ArtifactPin,
  type ArtifactPoint,
  type ArtifactRegion,
  type ReviewThread
} from './hosted-review-collaboration';
import {
  createHostedElementInspection,
  type HostedElementObservation,
  type HostedElementInspection
} from './hosted-review-inspection';
import {
  browserLocalHostedReviewContext,
  browserLocalHostedReviewBinding,
  browserLocalHostedReviewProvider,
  browserLocalReviewThread
} from './hosted-review-provider';
import {
  listHostedReviewThroughHost,
  mutateHostedReviewThroughHost,
  type HostedReviewOperation
} from '@selene/collaboration/hosted-review';
import {
  ordersReviewArtifact as reviewArtifact,
  ordersReviewHandoffManifest
} from './orders-review-handoff';
import {
  ordersReviewInspectionEnvelope,
  type PublishedInspectionManifest,
  verifyPublishedInspectionManifest
} from './published-inspection-manifest';

const STORAGE_PREFIX = 'selene.designer-workspace.';
const hostedReviewBinding = browserLocalHostedReviewBinding({
  tenantId: reviewArtifact.tenantId,
  projectId: reviewArtifact.projectId,
  artifactId: reviewArtifact.artifactId,
  revisionId: reviewArtifact.revisionId,
  baselineId: reviewArtifact.baselineId,
  version: reviewArtifact.reviewContractVersion
});
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
type ResolvedArtifactHit = ArtifactHit & { readonly element: HTMLElement };

function reviewRoute(section: ReviewSection): string {
  const base = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL.slice(0, -1)
    : import.meta.env.BASE_URL;
  return `${base}/review/${section}`.replace(/^$/, '/');
}

function inspectionHandoffRoute(inspection: HostedElementInspection): string {
  const parameters = new URLSearchParams({
    project: inspection.artifact.projectId,
    artifact: inspection.artifact.artifactId,
    revision: inspection.artifact.revisionId,
    baseline: inspection.artifact.baselineId,
    screen: inspection.scenario.screen,
    scenario: inspection.scenario.state,
    element: inspection.target.field,
    story: inspection.handoff.story.storyId
  });
  return `${reviewRoute('handoff')}?${parameters.toString()}`;
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

function developerHandoffArchiveUrl(): string {
  const base = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  return `${base}${ordersReviewHandoffManifest.archive.path}`;
}

function developerHandoffReceiptUrl(): string {
  const base = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  return `${base}${ordersReviewHandoffManifest.receipt.path}`;
}

type DeveloperHandoffReceipt = {
  readonly format: string;
  readonly archive: { readonly digest: { readonly algorithm: string; readonly value: string } };
  readonly artifact: {
    readonly id: string;
    readonly sourceRevisionId: string;
    readonly baselineRevisionId: string;
    readonly sourceRef: DeveloperHandoffBuildProvenance;
  };
  readonly build: DeveloperHandoffBuildProvenance;
  readonly toolchain: {
    readonly runtime: string;
    readonly typescript: string;
    readonly vite: string;
  };
};

type DeveloperHandoffBuildProvenance = {
  readonly provider: string;
  readonly repository: string;
  readonly ref: string;
  readonly sha: string;
};

function isDeveloperHandoffBuildProvenance(
  value: unknown
): value is DeveloperHandoffBuildProvenance {
  if (value === null || typeof value !== 'object') return false;
  const provenance = value as Partial<DeveloperHandoffBuildProvenance>;
  return (
    provenance.provider === 'github' &&
    typeof provenance.repository === 'string' &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(provenance.repository) &&
    typeof provenance.ref === 'string' &&
    /^refs\/(?:heads|pull|tags)\/[A-Za-z0-9_./-]+$/.test(provenance.ref) &&
    typeof provenance.sha === 'string' &&
    /^[a-f0-9]{40}$/.test(provenance.sha)
  );
}

function sameHandoffBuild(
  left: DeveloperHandoffBuildProvenance,
  right: DeveloperHandoffBuildProvenance
): boolean {
  return (
    left.provider === right.provider &&
    left.repository === right.repository &&
    left.ref === right.ref &&
    left.sha === right.sha
  );
}

function isDeveloperHandoffReceipt(value: unknown): value is DeveloperHandoffReceipt {
  if (value === null || typeof value !== 'object') return false;
  const receipt = value as Partial<DeveloperHandoffReceipt>;
  const artifact = receipt.artifact;
  const archive = receipt.archive;
  const toolchain = receipt.toolchain;
  const build = receipt.build;
  if (
    artifact === undefined ||
    archive === undefined ||
    toolchain === undefined ||
    build === undefined
  )
    return false;
  return (
    receipt.format === ordersReviewHandoffManifest.receipt.format &&
    artifact.id === reviewArtifact.artifactId &&
    artifact.sourceRevisionId === reviewArtifact.revisionId &&
    artifact.baselineRevisionId === reviewArtifact.baselineId &&
    isDeveloperHandoffBuildProvenance(artifact.sourceRef) &&
    isDeveloperHandoffBuildProvenance(build) &&
    sameHandoffBuild(artifact.sourceRef, build) &&
    archive.digest.algorithm === 'sha256' &&
    /^[a-f0-9]{64}$/.test(archive.digest.value) &&
    toolchain.runtime === ordersReviewHandoffManifest.toolchain.runtime &&
    toolchain.typescript === ordersReviewHandoffManifest.toolchain.typescript &&
    toolchain.vite === ordersReviewHandoffManifest.toolchain.vite
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function archiveMatchesReceipt(value: unknown, receipt: DeveloperHandoffReceipt): boolean {
  if (value === null || typeof value !== 'object') return false;
  const archive = value as {
    readonly manifest?: {
      readonly artifact?: DeveloperHandoffReceipt['artifact'];
      readonly build?: DeveloperHandoffBuildProvenance;
      readonly toolchain?: DeveloperHandoffReceipt['toolchain'];
    };
  };
  const manifest = archive.manifest;
  const artifact = manifest?.artifact;
  const build = manifest?.build;
  const toolchain = manifest?.toolchain;
  if (artifact === undefined || build === undefined || toolchain === undefined) return false;
  return (
    artifact.id === receipt.artifact.id &&
    artifact.sourceRevisionId === receipt.artifact.sourceRevisionId &&
    artifact.baselineRevisionId === receipt.artifact.baselineRevisionId &&
    isDeveloperHandoffBuildProvenance(artifact.sourceRef) &&
    sameHandoffBuild(artifact.sourceRef, receipt.build) &&
    sameHandoffBuild(build, receipt.build) &&
    toolchain.runtime === receipt.toolchain.runtime &&
    toolchain.typescript === receipt.toolchain.typescript &&
    toolchain.vite === receipt.toolchain.vite
  );
}

function HandoffReceiptDetails() {
  const [receipt, setReceipt] = useState<DeveloperHandoffReceipt>();
  const [receiptError, setReceiptError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch(developerHandoffReceiptUrl(), { signal: controller.signal }),
      fetch(developerHandoffArchiveUrl(), { signal: controller.signal })
    ])
      .then(async ([receiptResponse, archiveResponse]) => {
        if (!receiptResponse.ok || !archiveResponse.ok)
          throw new Error('Handoff receipt request failed');
        const parsed: unknown = await receiptResponse.json();
        const archivePayload = await archiveResponse.text();
        if (
          !isDeveloperHandoffReceipt(parsed) ||
          !archiveMatchesReceipt(JSON.parse(archivePayload), parsed)
        )
          throw new Error('Receipt identity did not match r18');
        if ((await sha256Hex(archivePayload)) !== parsed.archive.digest.value)
          throw new Error('Archive digest did not match immutable receipt');
        setReceipt(parsed);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setReceiptError(true);
      });
    return () => controller.abort();
  }, []);

  if (receiptError) {
    return (
      <div>
        <dt>Immutable receipt</dt>
        <dd role="alert">Receipt unavailable or identity mismatch.</dd>
      </div>
    );
  }
  if (receipt === undefined) {
    return (
      <div>
        <dt>Immutable receipt</dt>
        <dd aria-live="polite">Loading archive digest and source ref…</dd>
      </div>
    );
  }
  return (
    <>
      <div>
        <dt>Archive digest</dt>
        <dd>{`${receipt.archive.digest.algorithm}:${receipt.archive.digest.value}`}</dd>
      </div>
      <div>
        <dt>Source ref</dt>
        <dd>{`${receipt.build.repository} · ${receipt.build.ref} · ${receipt.build.sha}`}</dd>
      </div>
    </>
  );
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

function observeHostedElement(
  element: HTMLElement,
  surface: HTMLElement
): HostedElementObservation {
  const bounds = element.getBoundingClientRect();
  const surfaceBounds = surface.getBoundingClientRect();
  const styles = window.getComputedStyle(element);
  const explicitName = element.getAttribute('aria-label') ?? undefined;
  const textName = element.textContent?.replaceAll(/\s+/g, ' ').trim();
  const role = element.getAttribute('role') ?? undefined;
  const accessibleName = explicitName ?? textName;
  return {
    semanticTag: element.tagName.toLowerCase(),
    ...(role === undefined ? {} : { role }),
    ...(accessibleName ? { accessibleName } : {}),
    bounds: {
      x: bounds.left - surfaceBounds.left,
      y: bounds.top - surfaceBounds.top,
      width: bounds.width,
      height: bounds.height
    },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    styles: {
      display: styles.display,
      color: styles.color,
      backgroundColor: styles.backgroundColor,
      fontFamily: styles.fontFamily,
      fontSize: styles.fontSize,
      fontWeight: styles.fontWeight,
      lineHeight: styles.lineHeight,
      padding: styles.padding,
      border: styles.border,
      borderRadius: styles.borderRadius,
      textAlign: styles.textAlign
    }
  };
}

function threadContext(thread: ReviewThread): string {
  const latestMessage = thread.messages[thread.messages.length - 1];
  const body = latestMessage?.body ?? 'No message';
  return body.length > 120 ? `${body.slice(0, 117)}…` : body;
}

function InspectorValue({
  label,
  value,
  provenance = 'computed'
}: {
  readonly label: string;
  readonly value: string;
  readonly provenance?: 'authored' | 'computed' | 'inherited';
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span>{value}</span>
        <small data-value-provenance={provenance}>{provenance}</small>
      </dd>
    </div>
  );
}

function HostedElementInspector({
  inspection
}: {
  readonly inspection: HostedElementInspection | undefined;
}) {
  if (inspection === undefined) {
    return (
      <section className="hosted-element-inspector hosted-element-inspector--empty">
        <div className="hosted-element-inspector__empty-icon" aria-hidden="true">
          ⌁
        </div>
        <h3>Select an element to inspect</h3>
        <p>
          Click Select, then choose any field in the artifact. Inspection is read-only and bound to
          this exact published revision.
        </p>
      </section>
    );
  }

  const { target, styles, geometry, accessibility, scenario, artifact, handoff } = inspection;
  return (
    <section className="hosted-element-inspector" aria-label="Selected element developer details">
      <header className="hosted-element-inspector__identity">
        <span aria-hidden="true">⌁</span>
        <div>
          <p className="eyebrow">Selected component</p>
          <h3>{target.component}</h3>
          <small>
            {target.packageName}@{target.packageVersion}
          </small>
        </div>
        <b>Read only</b>
      </header>

      <section className="hosted-element-inspector__group" aria-labelledby="inspect-layout-title">
        <div className="hosted-element-inspector__group-heading">
          <h4 id="inspect-layout-title">Layout</h4>
          <span>{`${geometry.width} × ${geometry.height}`}</span>
        </div>
        <dl className="hosted-element-inspector__values">
          <InspectorValue label="Position" value={`${geometry.x}, ${geometry.y}`} />
          <InspectorValue label="Display" value={styles.display} />
          <InspectorValue label="Padding" value={styles.padding} />
          <InspectorValue label="Alignment" value={styles.textAlign} />
        </dl>
      </section>

      <section
        className="hosted-element-inspector__group"
        aria-labelledby="inspect-appearance-title"
      >
        <div className="hosted-element-inspector__group-heading">
          <h4 id="inspect-appearance-title">Appearance</h4>
          {target.token ? <span>{target.token.name}</span> : null}
        </div>
        <dl className="hosted-element-inspector__values">
          <InspectorValue label="Text" value={styles.color} />
          <InspectorValue label="Fill" value={styles.backgroundColor} />
          <InspectorValue label="Border" value={styles.border} />
          <InspectorValue label="Radius" value={styles.borderRadius} />
        </dl>
        {target.token ? (
          <div className="hosted-element-inspector__token">
            <span
              aria-hidden="true"
              style={{ '--inspection-token-color': target.token.value } as CSSProperties}
            />
            <div>
              <strong>{target.token.name}</strong>
              <small>{target.token.value} · design token</small>
            </div>
          </div>
        ) : null}
      </section>

      <section className="hosted-element-inspector__group" aria-labelledby="inspect-type-title">
        <div className="hosted-element-inspector__group-heading">
          <h4 id="inspect-type-title">Typography</h4>
          <span>{styles.fontSize}</span>
        </div>
        <dl className="hosted-element-inspector__values">
          <InspectorValue label="Family" value={styles.fontFamily} provenance="inherited" />
          <InspectorValue label="Weight" value={styles.fontWeight} />
          <InspectorValue label="Line height" value={styles.lineHeight} />
        </dl>
      </section>

      <section className="hosted-element-inspector__group" aria-labelledby="inspect-react-title">
        <div className="hosted-element-inspector__group-heading">
          <h4 id="inspect-react-title">React & source</h4>
          <span>{target.owner}</span>
        </div>
        <dl className="hosted-element-inspector__values">
          <InspectorValue label="Export" value={target.exportName} provenance="authored" />
          <InspectorValue label="Source" value={target.sourcePath} provenance="authored" />
          {target.authoredProps.map((prop) => (
            <InspectorValue key={prop} label="Prop" value={prop} provenance="authored" />
          ))}
        </dl>
      </section>

      <section
        className="hosted-element-inspector__group"
        aria-labelledby="inspect-accessibility-title"
      >
        <div className="hosted-element-inspector__group-heading">
          <h4 id="inspect-accessibility-title">Accessibility</h4>
          <span>{accessibility.semanticTag}</span>
        </div>
        <dl className="hosted-element-inspector__values">
          <InspectorValue label="Role" value={accessibility.role} />
          <InspectorValue label="Name" value={accessibility.accessibleName} />
        </dl>
      </section>

      <section className="hosted-element-inspector__group" aria-labelledby="inspect-handoff-title">
        <div className="hosted-element-inspector__group-heading">
          <h4 id="inspect-handoff-title">Developer handoff</h4>
          <span>{handoff.changeSinceBaseline} since baseline</span>
        </div>
        <dl className="hosted-element-inspector__values">
          <InspectorValue label="Story" value={handoff.story.storyId} provenance="authored" />
          <InspectorValue
            label="Catalog"
            value={handoff.story.catalogRevision}
            provenance="authored"
          />
          {handoff.directions.map((direction) => (
            <InspectorValue
              key={direction}
              label="Direction"
              value={direction}
              provenance="authored"
            />
          ))}
        </dl>
        <a
          className="hosted-element-inspector__handoff-link"
          href={inspectionHandoffRoute(inspection)}
        >
          Open exact element handoff
        </a>
      </section>

      <footer className="hosted-element-inspector__provenance">
        <strong>
          {scenario.screen} · {scenario.state}
        </strong>
        <span>{scenario.viewport}</span>
        <small>
          {artifact.revisionId} · baseline {artifact.baselineId}
        </small>
      </footer>
    </section>
  );
}

function DetailPanel({
  order,
  mode,
  threads,
  anchor,
  inspection,
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
  readonly inspection: HostedElementInspection | undefined;
  readonly onCreateThread: (body: string) => Promise<boolean>;
  readonly onReply: (threadId: string, body: string) => Promise<boolean>;
  readonly onResolve: (threadId: string) => Promise<void>;
  readonly onReopen: (threadId: string) => Promise<void>;
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
      {mode === 'comment' ? (
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
      ) : null}
      {mode === 'inspect' ? <HostedElementInspector inspection={inspection} /> : null}
      {mode === 'comment' ? (
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
              <form
                className="thread-actions"
                onSubmit={(event) => {
                  event.preventDefault();
                  const body = replyDrafts[thread.id]?.trim();
                  if (!body) return;
                  void onReply(thread.id, body).then((saved) => {
                    if (saved) setReplyDrafts((current) => ({ ...current, [thread.id]: '' }));
                  });
                }}
              >
                <textarea
                  aria-label={`Reply to ${thread.id}`}
                  value={replyDrafts[thread.id] ?? ''}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setReplyDrafts((current) => ({
                      ...current,
                      [thread.id]: value
                    }));
                  }}
                  placeholder="Reply with an implementation decision"
                  maxLength={4000}
                />
                <button type="submit">Reply</button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    void (thread.status === 'open' ? onResolve(thread.id) : onReopen(thread.id))
                  }
                >
                  {thread.status === 'open' ? 'Resolve' : 'Reopen'}
                </button>
              </form>
            </article>
          ))}
        </section>
      ) : null}
      {mode === 'comment' ? (
        <section className="comment-composer" aria-label="Review comment">
          <p className="eyebrow">Comment mode</p>
          {pin !== undefined ? (
            <form
              className="thread-actions"
              onSubmit={(event) => {
                event.preventDefault();
                const body = draft.trim();
                if (!body) return;
                void onCreateThread(body).then((saved) => {
                  if (saved) setDraft('');
                });
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
          ) : (
            <p className="static-mode-copy">
              Select an artifact point or region before writing a local pinned thread. This browser
              uses a durable local review store; no remote collaboration provider is configured.
            </p>
          )}
        </section>
      ) : null}
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
  onPinBaselineChange,
  publishedInspection,
  inspectionManifestMessage
}: {
  readonly section: Exclude<ReviewSection, 'prototype'>;
  readonly onPinBaselineChange: (orderId: string, anchor: ArtifactAnchor, title: string) => void;
  readonly publishedInspection: PublishedInspectionManifest | undefined;
  readonly inspectionManifestMessage: string;
}) {
  const handoffParameters = new URLSearchParams(window.location.search);
  const requestedElement = handoffParameters.get('element');
  const requestedTarget =
    requestedElement === null ? undefined : publishedInspection?.targetById[requestedElement];
  const selectedHandoffTarget =
    publishedInspection !== undefined &&
    requestedTarget !== undefined &&
    handoffParameters.get('project') === publishedInspection.artifact.projectId &&
    handoffParameters.get('artifact') === publishedInspection.artifact.artifactId &&
    handoffParameters.get('revision') === publishedInspection.artifact.revisionId &&
    handoffParameters.get('baseline') === publishedInspection.artifact.baselineId &&
    handoffParameters.get('screen') === requestedTarget.screen &&
    requestedTarget.scenarios.includes(handoffParameters.get('scenario') ?? '') &&
    handoffParameters.get('story') === requestedTarget.story.storyId
      ? requestedTarget
      : undefined;
  const staleElementHandoff =
    requestedElement !== null &&
    publishedInspection !== undefined &&
    selectedHandoffTarget === undefined;
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
          Download one self-contained archive with the committed React source, runnable Vite app,
          frozen Bun lockfile, packaged Storybook source, styles, asset, and content-addressed
          receipt.
        </p>
        {staleElementHandoff ? (
          <p className="review-storage-error" role="alert">
            This element handoff link does not match the verified artifact revision. Return to the
            prototype and select the element again.
          </p>
        ) : null}
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
            <dt>Archive</dt>
            <dd>
              {ordersReviewHandoffManifest.archive.format} ·{' '}
              {ordersReviewHandoffManifest.archive.delivery}
            </dd>
          </div>
          <div>
            <dt>Build Git provenance</dt>
            <dd>Verified from the generated immutable receipt.</dd>
          </div>
          <HandoffReceiptDetails />
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
              {ordersReviewHandoffManifest.storybook.stories
                .map(
                  (story) =>
                    `${story.projectId}/${story.componentId}/${story.storyId} · ${story.catalogRevision} · ${story.buildId}`
                )
                .join(', ')}
            </dd>
          </div>
          <div>
            <dt>Inspection attestation</dt>
            <dd>
              {ordersReviewHandoffManifest.inspection.format} ·{' '}
              {ordersReviewHandoffManifest.inspection.attestation.algorithm}:
              {ordersReviewHandoffManifest.inspection.attestation.payloadDigest}
            </dd>
          </div>
          <div>
            <dt>Implementation directions</dt>
            <dd>{ordersReviewHandoffManifest.directions.join(' ')}</dd>
          </div>
          {selectedHandoffTarget === undefined ? null : (
            <>
              <div>
                <dt>Selected element</dt>
                <dd>
                  {selectedHandoffTarget.target.component} · {selectedHandoffTarget.id} ·{' '}
                  {selectedHandoffTarget.target.owner}
                </dd>
              </div>
              <div>
                <dt>Selected source</dt>
                <dd>
                  {selectedHandoffTarget.target.sourcePath} ·{' '}
                  {selectedHandoffTarget.target.exportName}
                </dd>
              </div>
              <div>
                <dt>Selected props and token</dt>
                <dd>
                  {selectedHandoffTarget.target.authoredProps.join(', ')}
                  {selectedHandoffTarget.target.token === undefined
                    ? ''
                    : ` · ${selectedHandoffTarget.target.token.name} ${selectedHandoffTarget.target.token.value}`}
                </dd>
              </div>
              <div>
                <dt>Selected Storybook case</dt>
                <dd>
                  {selectedHandoffTarget.story.storyId} ·{' '}
                  {selectedHandoffTarget.story.catalogRevision} ·{' '}
                  {selectedHandoffTarget.story.buildId}
                </dd>
              </div>
              <div>
                <dt>Selected directions</dt>
                <dd>{selectedHandoffTarget.directions.join(' ')}</dd>
              </div>
            </>
          )}
          <div>
            <dt>Install · typecheck · build · start</dt>
            <dd>
              {ordersReviewHandoffManifest.commands.install} ·{' '}
              {ordersReviewHandoffManifest.commands.typecheck} ·{' '}
              {ordersReviewHandoffManifest.commands.build} ·{' '}
              {ordersReviewHandoffManifest.commands.start}
            </dd>
          </div>
        </dl>
        <ul>
          {view.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        {publishedInspection === undefined ? (
          <p className="review-storage-error" role="alert">
            {inspectionManifestMessage} Handoff downloads remain locked until verification succeeds.
          </p>
        ) : (
          <>
            <a className="primary-button" href={developerHandoffArchiveUrl()} download>
              Download self-contained r18 archive
            </a>
            <a className="secondary-button" href={developerHandoffReceiptUrl()} download>
              Download immutable r18 receipt
            </a>
          </>
        )}
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
  const [activeInspection, setActiveInspection] = useState<HostedElementInspection>();
  const [publishedInspection, setPublishedInspection] = useState<PublishedInspectionManifest>();
  const [inspectionManifestMessage, setInspectionManifestMessage] = useState(
    'Verifying revision-bound inspection metadata.'
  );
  const [selectionMode, setSelectionMode] = useState<'point' | 'region'>();
  const [selectionPreview, setSelectionPreview] = useState<ArtifactRegion>();
  const [threads, setThreads] = useState<readonly ReviewThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string>();
  const [notice, setNotice] = useState('Viewing revision-bound review data for revision 18.');
  const [storageError, setStorageError] = useState<string>();
  const [providerState, setProviderState] = useState('offline');
  const detailTrigger = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const artifactSurfaceRef = useRef<HTMLDivElement>(null);
  const selectionStartRef = useRef<ArtifactPoint | undefined>(undefined);
  const selectionHitRef = useRef<ResolvedArtifactHit | undefined>(undefined);
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
    let active = true;
    void browserLocalHostedReviewProvider.state(hostedReviewBinding).then(
      (state) => {
        if (active) setProviderState(state.sync);
      },
      () => {
        if (active) setProviderState('error');
      }
    );
    void listHostedReviewThroughHost(
      browserLocalHostedReviewContext,
      browserLocalHostedReviewProvider,
      hostedReviewBinding
    ).then(
      (loaded) => {
        if (!active) return;
        setThreads(loaded.map(browserLocalReviewThread));
        setProviderState('offline');
      },
      () => {
        if (!active) return;
        setProviderState('error');
        setStorageError(
          'Local review storage could not be read. Existing review data was not changed.'
        );
      }
    );
    return () => {
      active = false;
    };
  }, [hostedReviewBinding]);

  useEffect(() => {
    let active = true;
    void verifyPublishedInspectionManifest(
      ordersReviewInspectionEnvelope,
      {
        projectId: reviewArtifact.projectId,
        artifactId: reviewArtifact.artifactId,
        revisionId: reviewArtifact.revisionId,
        baselineId: reviewArtifact.baselineId,
        sourceDigest: reviewArtifact.content.digest.value
      },
      'anonymous'
    ).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setPublishedInspection(undefined);
        setActiveInspection(undefined);
        setInspectionManifestMessage(result.message);
        return;
      }
      setPublishedInspection(result.manifest);
      setInspectionManifestMessage(
        `Verified ${result.manifest.targets.length} inspectable elements for ${result.manifest.artifact.revisionId}.`
      );
    });
    return () => {
      active = false;
    };
  }, []);

  async function mutateThread(operation: HostedReviewOperation, message: string): Promise<boolean> {
    setProviderState('syncing');
    try {
      const result = await mutateHostedReviewThroughHost(
        browserLocalHostedReviewContext,
        browserLocalHostedReviewProvider,
        operation
      );
      if (!result.ok) {
        setProviderState(result.code === 'conflict' ? 'conflict' : result.code);
        setStorageError(
          result.code === 'conflict'
            ? `This discussion changed first (version ${result.currentVersion}). Reload before retrying.`
            : 'Local review storage could not save this discussion. Existing review data was kept.'
        );
        return false;
      }
      setThreads((current) => [
        ...current.filter((thread) => thread.id !== result.thread.id),
        browserLocalReviewThread(result.thread)
      ]);
      setStorageError(undefined);
      setProviderState('offline');
      setNotice(message);
      return true;
    } catch {
      setProviderState('error');
      setStorageError('Local review storage could not complete this discussion operation.');
      return false;
    }
  }

  function threadVersion(threadId: string): number {
    const thread = threads.find((candidate) => candidate.id === threadId);
    return thread === undefined
      ? 0
      : thread.messages.length + (thread.status === 'resolved' ? 1 : 0);
  }

  async function createThread(body: string): Promise<boolean> {
    if (selectedOrder === undefined || activeAnchor === undefined) return false;
    const threadId = reviewId('thread');
    const saved = await mutateThread(
      {
        type: 'create',
        binding: hostedReviewBinding,
        operationId: reviewId('operation'),
        threadId,
        anchor: activeAnchor,
        body,
        expectedVersion: 0
      },
      `Created a revision-bound thread for ${formatAnchor(activeAnchor)}.`
    );
    if (saved) setActiveThreadId(threadId);
    return saved;
  }

  function replyToThread(threadId: string, body: string): Promise<boolean> {
    return mutateThread(
      {
        type: 'reply',
        binding: hostedReviewBinding,
        operationId: reviewId('operation'),
        threadId,
        body,
        expectedVersion: threadVersion(threadId)
      },
      'Saved reply in the local revision-bound review store.'
    );
  }

  function setThreadStatus(threadId: string, status: ReviewThread['status']): Promise<void> {
    return mutateThread(
      {
        type: status === 'resolved' ? 'resolve' : 'reopen',
        binding: hostedReviewBinding,
        operationId: reviewId('operation'),
        threadId,
        expectedVersion: threadVersion(threadId)
      },
      status === 'resolved'
        ? 'Resolved the revision-bound thread.'
        : 'Reopened the revision-bound thread.'
    ).then(() => undefined);
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
    if (sectionId !== 'prototype') {
      setActiveInspection(undefined);
      setSelectionMode(undefined);
      resetArtifactGesture();
    }
    setNotice(message);
  }

  function showPrototypeState(nextState: PrototypeState) {
    setPrototypeState(nextState);
    setDrawerOpen(false);
    setActiveInspection(undefined);
    setActiveAnchor(undefined);
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

  function resolvedArtifactHit(clientX: number, clientY: number): ResolvedArtifactHit | undefined {
    const surface = artifactSurfaceRef.current;
    if (surface === null) return undefined;
    const overlay = surface.querySelector<HTMLElement>('.artifact-selection-overlay');
    const priorPointerEvents = overlay?.style.pointerEvents;
    // Only expose the field beneath the active capture overlay while resolving
    // its origin; restoration completes before the caller sets pointer capture.
    if (overlay !== null) overlay.style.pointerEvents = 'none';
    try {
      for (const element of document.elementsFromPoint(clientX, clientY)) {
        if (!(element instanceof HTMLElement)) continue;
        const fieldElement = element.closest<HTMLElement>('[data-artifact-field]');
        if (fieldElement === null || !surface.contains(fieldElement)) continue;
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
          continue;
        }
        return {
          orderId,
          field,
          component: field === 'status' ? 'OrderStatus' : 'OrdersReviewRow',
          element: element.closest<HTMLElement>('[data-artifact-inspect]') ?? fieldElement
        };
      }
      return undefined;
    } finally {
      if (overlay !== null) overlay.style.pointerEvents = priorPointerEvents ?? '';
    }
  }

  function resetArtifactGesture() {
    selectionStartRef.current = undefined;
    selectionHitRef.current = undefined;
    setSelectionPreview(undefined);
  }

  function activateArtifactInspection(hit: ResolvedArtifactHit, anchor: ArtifactAnchor) {
    const surface = artifactSurfaceRef.current;
    const publishedTarget = publishedInspection?.targetById[hit.field];
    if (publishedTarget === undefined) {
      setActiveInspection(undefined);
      setNotice(inspectionManifestMessage);
      return;
    }
    setSelectedOrderId(hit.orderId);
    setActiveAnchor(anchor);
    setActiveThreadId(undefined);
    if (surface !== null) {
      setActiveInspection(
        createHostedElementInspection({
          artifact: {
            projectId: reviewArtifact.projectId,
            artifactId: reviewArtifact.artifactId,
            revisionId: reviewArtifact.revisionId,
            baselineId: reviewArtifact.baselineId
          },
          target: publishedTarget.target,
          observation: observeHostedElement(hit.element, surface),
          screen: publishedTarget.screen,
          state: prototypeState,
          handoff: {
            changeSinceBaseline: publishedTarget.changeSinceBaseline,
            directions: publishedTarget.directions,
            story: publishedTarget.story
          }
        })
      );
    }
  }

  function selectArtifactAnchor(event: PointerEvent<HTMLDivElement>) {
    const start = selectionStartRef.current;
    const hit = selectionHitRef.current;
    const end = pointerCoordinate(event);
    const tool = selectionMode;
    resetArtifactGesture();
    if (mode === 'comment') setSelectionMode(undefined);
    else setSelectionMode('point');
    if (start === undefined || end === undefined || hit === undefined) {
      setNotice(
        'No reviewable artifact row or field was found at that point; the current anchor is unchanged.'
      );
      return;
    }
    const region =
      tool === 'point' ? { x: end.x, y: end.y, width: 0, height: 0 } : regionBetween(start, end);
    const anchor: ArtifactAnchor = {
      selector: `[data-review-order="${hit.orderId}"] [data-artifact-field="${hit.field}"]`,
      component: hit.component,
      point: end,
      region
    };
    activateArtifactInspection(hit, anchor);
    setNotice(
      mode === 'inspect'
        ? `Inspecting ${hit.component} at ${formatAnchor(anchor)}.`
        : `Selected ${tool} anchor: ${formatAnchor(anchor)}.`
    );
  }

  function inspectArtifactField(
    event: ReactKeyboardEvent<HTMLElement>,
    orderId: string,
    field: ArtifactField
  ) {
    if (mode !== 'inspect' || (event.key !== 'Enter' && event.key !== ' ')) return;
    const surface = artifactSurfaceRef.current;
    if (surface === null) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const surfaceBounds = surface.getBoundingClientRect();
    if (surfaceBounds.width === 0 || surfaceBounds.height === 0) return;
    const region = {
      x: Math.min(1, Math.max(0, (bounds.left - surfaceBounds.left) / surfaceBounds.width)),
      y: Math.min(1, Math.max(0, (bounds.top - surfaceBounds.top) / surfaceBounds.height)),
      width: Math.min(1, Math.max(0, bounds.width / surfaceBounds.width)),
      height: Math.min(1, Math.max(0, bounds.height / surfaceBounds.height))
    };
    const anchor: ArtifactAnchor = {
      selector: `[data-review-order="${orderId}"] [data-artifact-field="${field}"]`,
      component: field === 'status' ? 'OrderStatus' : 'OrdersReviewRow',
      point: { x: region.x + region.width / 2, y: region.y + region.height / 2 },
      region
    };
    activateArtifactInspection(
      {
        orderId,
        field,
        component: anchor.component,
        element: event.currentTarget
      },
      anchor
    );
    setNotice(`Inspecting ${anchor.component} from the keyboard at ${formatAnchor(anchor)}.`);
  }

  function openBaselineChange(orderId: string, anchor: ArtifactAnchor, title: string) {
    setSelectedOrderId(orderId);
    setActiveAnchor(anchor);
    setActiveInspection(undefined);
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
    setActiveInspection(undefined);
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
        <div
          className="review-collaboration-status"
          aria-label="Hosted review provider status"
          data-provider="browser-local"
          data-identity="local-only"
          data-sync={providerState}
        >
          <strong>Review storage: browser-local</strong>
          <span>
            Local-only identity · {providerState} · artifact {hostedReviewBinding.artifactId} ·
            baseline {hostedReviewBinding.baselineId}
          </span>
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
            onClick={() => {
              setMode('comment');
              setSelectionMode(undefined);
              resetArtifactGesture();
              setNotice('Commenting is active. Choose a point or region to start a discussion.');
            }}
          >
            Comment
          </button>
          <button
            type="button"
            className={mode === 'inspect' ? 'is-active' : ''}
            aria-pressed={mode === 'inspect'}
            aria-describedby="inspection-manifest-status"
            disabled={publishedInspection === undefined}
            onClick={() => {
              setMode('inspect');
              setSelectionMode('point');
              resetArtifactGesture();
              setNotice('Read-only Inspect is active. Select any artifact element.');
            }}
          >
            Inspect
          </button>
        </div>
        <div
          className="artifact-selection-controls"
          aria-label={mode === 'inspect' ? 'Artifact element inspection' : 'Artifact pin selection'}
        >
          <span>{mode === 'inspect' ? 'Element' : 'Pin selection'}</span>
          <button
            type="button"
            className={selectionMode === 'point' ? 'is-active' : ''}
            aria-pressed={selectionMode === 'point'}
            disabled={mode === 'inspect' && publishedInspection === undefined}
            onClick={() =>
              setSelectionMode((current) => (current === 'point' ? undefined : 'point'))
            }
          >
            {mode === 'inspect' ? 'Select' : 'Point'}
          </button>
          {mode === 'comment' ? (
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
          ) : null}
          {activeAnchor !== undefined ? (
            <button
              type="button"
              onClick={() => {
                setActiveAnchor(undefined);
                setActiveInspection(undefined);
                setActiveThreadId(undefined);
                setNotice('Artifact selection cleared.');
              }}
            >
              Clear
            </button>
          ) : null}
        </div>
        <p role="status">{notice}</p>
        <span className="mode-help" id="inspection-manifest-status">
          {mode === 'comment'
            ? `${inspectionManifestMessage} Select a point or region, then save a local revision-bound thread.`
            : `${inspectionManifestMessage} Select any element to inspect its React, style, token, accessibility, and revision context.`}
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
                            <td
                              data-artifact-field="order"
                              tabIndex={mode === 'inspect' ? 0 : undefined}
                              onKeyDown={(event) => inspectArtifactField(event, order.id, 'order')}
                            >
                              <button
                                type="button"
                                className="order-select"
                                data-artifact-inspect=""
                                aria-label={`Open ${order.id} review details`}
                                onClick={() => {
                                  setSelectedOrderId(order.id);
                                  setActiveAnchor(undefined);
                                  setActiveInspection(undefined);
                                  setNotice(
                                    `${order.id} is selected for ${mode === 'comment' ? 'revision-bound review' : 'inspection'}.`
                                  );
                                }}
                              >
                                {order.id}
                              </button>
                            </td>
                            <td
                              data-artifact-field="customer"
                              tabIndex={mode === 'inspect' ? 0 : undefined}
                              onKeyDown={(event) =>
                                inspectArtifactField(event, order.id, 'customer')
                              }
                            >
                              {order.customer}
                            </td>
                            <td
                              data-artifact-field="status"
                              tabIndex={mode === 'inspect' ? 0 : undefined}
                              onKeyDown={(event) => inspectArtifactField(event, order.id, 'status')}
                            >
                              <span
                                className={`order-status order-status--${order.status.replaceAll(' ', '-').toLowerCase()}`}
                                data-artifact-inspect=""
                              >
                                {order.status}
                              </span>
                            </td>
                            <td
                              data-artifact-field="total"
                              tabIndex={mode === 'inspect' ? 0 : undefined}
                              onKeyDown={(event) => inspectArtifactField(event, order.id, 'total')}
                            >
                              <strong data-artifact-inspect="">{order.total}</strong>
                            </td>
                            <td
                              data-artifact-field="placed"
                              tabIndex={mode === 'inspect' ? 0 : undefined}
                              onKeyDown={(event) => inspectArtifactField(event, order.id, 'placed')}
                            >
                              {order.date}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {selectionMode !== undefined ? (
                      <div
                        className={`artifact-selection-overlay artifact-selection-overlay--${selectionMode}`}
                        aria-label={
                          mode === 'inspect'
                            ? 'Select an element on the Orders artifact'
                            : `Select ${selectionMode} on the Orders artifact`
                        }
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
                        onPointerCancel={resetArtifactGesture}
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
            <ReviewSection
              section={section}
              onPinBaselineChange={openBaselineChange}
              publishedInspection={publishedInspection}
              inspectionManifestMessage={inspectionManifestMessage}
            />
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
              inspection={activeInspection}
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
              inspection={activeInspection}
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
