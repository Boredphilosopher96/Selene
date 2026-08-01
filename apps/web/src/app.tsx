import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';
import { createPortal } from 'react-dom';
import type { CollaborationHostContext } from '@selene/collaboration';

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
import { type ArtifactAnchor } from './hosted-review-collaboration';
import {
  createHostedElementInspection,
  type HostedElementObservation,
  type HostedElementInspection
} from './hosted-review-inspection';
import {
  browserLocalHostedReviewContext,
  browserLocalHostedReviewBinding,
  browserLocalHostedReviewState,
  createBrowserLocalHostedReviewProvider
} from './hosted-review-provider';
import { createHostedReviewHttpProvider } from './hosted-review-http-provider';
import {
  listHostedReviewThroughHost,
  mutateHostedReviewThroughHost,
  stateHostedReviewThroughHost,
  type HostedReviewBinding,
  type HostedReviewOperation,
  type HostedReviewProviderPort,
  type HostedReviewProviderState,
  type HostedReviewThread
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
const browserLocalHostedReviewProvider = createBrowserLocalHostedReviewProvider(
  {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value)
  },
  { legacyBinding: hostedReviewBinding }
);
const hostedReviewConfiguration = {
  serviceUrl: import.meta.env.VITE_HOSTED_REVIEW_SERVICE_URL,
  reviewUrl: import.meta.env.VITE_HOSTED_REVIEW_ARTIFACT_URL,
  revisionFingerprint: import.meta.env.VITE_HOSTED_REVIEW_REVISION_FINGERPRINT,
  screenId: import.meta.env.VITE_HOSTED_REVIEW_SCREEN_ID
};
const hostedReviewProvider =
  import.meta.env.VITE_HOSTED_REVIEW_PROVIDER === 'hosted' &&
  typeof hostedReviewConfiguration.serviceUrl === 'string' &&
  hostedReviewConfiguration.serviceUrl.length > 0 &&
  typeof hostedReviewConfiguration.reviewUrl === 'string' &&
  hostedReviewConfiguration.reviewUrl.length > 0 &&
  typeof hostedReviewConfiguration.revisionFingerprint === 'string' &&
  hostedReviewConfiguration.revisionFingerprint.length > 0 &&
  typeof hostedReviewConfiguration.screenId === 'string' &&
  hostedReviewConfiguration.screenId.length > 0
    ? createHostedReviewHttpProvider({
        serviceUrl: hostedReviewConfiguration.serviceUrl,
        reviewUrl: hostedReviewConfiguration.reviewUrl,
        revisionFingerprint: hostedReviewConfiguration.revisionFingerprint,
        screenId: hostedReviewConfiguration.screenId
      })
    : browserLocalHostedReviewProvider;
const hostedReviewFallback =
  import.meta.env.VITE_HOSTED_REVIEW_PROVIDER === 'hosted' &&
  hostedReviewProvider === browserLocalHostedReviewProvider;
const configuredReviewProviderState =
  hostedReviewProvider === browserLocalHostedReviewProvider
    ? browserLocalHostedReviewState
    : ({
        provider: 'hosted',
        identity: 'unavailable',
        sync: 'syncing',
        message: 'Verifying the authenticated collaboration session.'
      } as const);
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

type ReviewSection = 'prototype' | 'flows' | 'components' | 'changes' | 'discussions' | 'handoff';
type PrototypeState = 'ready' | 'loading' | 'empty' | 'error';
type ArtifactPopoverView = 'actions' | 'thread' | 'inspect';

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

function formatAnchor(anchor: ArtifactAnchor): string {
  return `${anchor.component} artifact pin`;
}

function semanticAnchorForElement(
  orderId: string,
  field: ArtifactField,
  element: HTMLElement,
  surface: HTMLElement
): ArtifactAnchor | undefined {
  const bounds = element.getBoundingClientRect();
  const surfaceBounds = surface.getBoundingClientRect();
  if (surfaceBounds.width <= 0 || surfaceBounds.height <= 0) return undefined;
  const region = {
    x: Math.min(1, Math.max(0, (bounds.left - surfaceBounds.left) / surfaceBounds.width)),
    y: Math.min(1, Math.max(0, (bounds.top - surfaceBounds.top) / surfaceBounds.height)),
    width: Math.min(1, Math.max(0, bounds.width / surfaceBounds.width)),
    height: Math.min(1, Math.max(0, bounds.height / surfaceBounds.height))
  };
  return {
    selector: `[data-review-order="${orderId}"] [data-artifact-field="${field}"]`,
    component: field === 'status' ? 'OrderStatus' : 'OrdersReviewRow',
    point: { x: region.x + region.width / 2, y: region.y + region.height / 2 },
    region
  };
}

function handleArtifactPopoverKeyDown(event: ReactKeyboardEvent<HTMLElement>, onClose: () => void) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    onClose();
    return;
  }
  if (event.key !== 'Tab') return;
  const controls = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), textarea:not(:disabled)'
    )
  ];
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function ArtifactPopoverLayer({
  anchor,
  surface,
  children
}: {
  readonly anchor: ArtifactAnchor;
  readonly surface: HTMLElement;
  readonly children: ReactNode;
}) {
  const [position, setPosition] = useState<{ readonly left: number; readonly top: number }>();
  const popoverLayerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    let animationFrame: number | undefined;
    const scheduleConstraint = () => {
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = undefined;
        const layer = popoverLayerRef.current;
        if (layer === null) return;
        const popover = layer.firstElementChild;
        if (popover === null) return;
        const bounds = popover.getBoundingClientRect();
        const viewportInset = 8;
        const horizontalOffset =
          bounds.left < viewportInset
            ? viewportInset - bounds.left
            : Math.min(0, window.innerWidth - viewportInset - bounds.right);
        const verticalOffset =
          bounds.top < viewportInset
            ? viewportInset - bounds.top
            : Math.min(0, window.innerHeight - viewportInset - bounds.bottom);
        if (horizontalOffset === 0 && verticalOffset === 0) return;
        setPosition((current) =>
          current === undefined
            ? current
            : {
                left: current.left + horizontalOffset,
                top: current.top + verticalOffset
              }
        );
      });
    };
    const updatePosition = () => {
      const bounds = surface.getBoundingClientRect();
      setPosition({
        left: bounds.left + bounds.width * anchor.point.x,
        top: bounds.top + bounds.height * anchor.point.y
      });
      scheduleConstraint();
    };
    updatePosition();
    const mutationObserver = new MutationObserver(scheduleConstraint);
    const layer = popoverLayerRef.current;
    if (layer !== null) mutationObserver.observe(layer, { childList: true, subtree: true });
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
      mutationObserver.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchor.point.x, anchor.point.y, surface]);
  return createPortal(
    <div
      ref={popoverLayerRef}
      className="artifact-popover-layer"
      style={
        position === undefined
          ? { left: 0, top: 0, visibility: 'hidden' }
          : { left: `${position.left}px`, top: `${position.top}px` }
      }
    >
      {children}
    </div>,
    document.body
  );
}

interface PortalReviewMessage {
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

interface PortalReviewThread {
  readonly id: string;
  readonly version: number;
  readonly anchor: ArtifactAnchor;
  readonly messages: readonly PortalReviewMessage[];
  readonly status: 'open' | 'resolved';
}

function reviewThreadView(thread: HostedReviewThread): PortalReviewThread {
  return {
    id: thread.id,
    version: thread.version,
    anchor: thread.anchor,
    messages: thread.replies.map((reply) => ({
      id: reply.id,
      author: reply.actor.displayName,
      body: reply.body,
      createdAt: reply.createdAt
    })),
    status: thread.lifecycle
  };
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

function ArtifactThreadPopover({
  anchor,
  threads,
  activeThreadId,
  persistenceNotice,
  storageError,
  onCreateThread,
  onReply,
  onResolve,
  onReopen,
  onNavigate,
  onClose
}: {
  readonly anchor: ArtifactAnchor;
  readonly threads: readonly PortalReviewThread[];
  readonly activeThreadId: string | undefined;
  readonly persistenceNotice: string;
  readonly storageError: string | undefined;
  readonly onCreateThread: (body: string) => Promise<boolean>;
  readonly onReply: (threadId: string, body: string) => Promise<boolean>;
  readonly onResolve: (threadId: string) => Promise<void>;
  readonly onReopen: (threadId: string) => Promise<void>;
  readonly onNavigate: (thread: PortalReviewThread) => void;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const popoverRef = useRef<HTMLElement>(null);
  const matchingIndex = threads.findIndex((thread) => anchorsMatch(thread.anchor, anchor));
  const selectedIndex =
    activeThreadId === undefined
      ? matchingIndex
      : threads.findIndex((thread) => thread.id === activeThreadId);
  const activeIndex = selectedIndex < 0 ? -1 : selectedIndex;
  const activeThread = activeIndex < 0 ? undefined : threads[activeIndex];
  useEffect(() => {
    const popover = popoverRef.current;
    if (popover === null) return;
    const composer = popover.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)');
    const firstControl = popover.querySelector<HTMLElement>('button:not(:disabled)');
    (composer ?? firstControl)?.focus();
  }, []);
  const send = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };
  const navigate = (offset: number) => {
    if (threads.length === 0) return;
    const next = threads[(Math.max(activeIndex, 0) + offset + threads.length) % threads.length];
    if (next !== undefined) onNavigate(next);
  };
  return (
    <section
      ref={popoverRef}
      className="artifact-thread-popover"
      role="dialog"
      aria-label={`Discussion on ${formatAnchor(anchor)}`}
      data-horizontal={anchor.point.x > 0.65 ? 'end' : 'start'}
      data-vertical={anchor.point.y > 0.62 ? 'above' : 'below'}
      style={{ left: 0, top: 0 }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => handleArtifactPopoverKeyDown(event, onClose)}
    >
      <header>
        <div>
          <p className="eyebrow">Artifact pin</p>
          <strong>{formatAnchor(anchor)}</strong>
          {activeThread === undefined ? null : (
            <span className="artifact-thread-popover__count">
              Pin {activeIndex + 1} of {threads.length}
            </span>
          )}
        </div>
        <div className="artifact-thread-popover__header-actions">
          {activeThread === undefined ? null : (
            <>
              <button type="button" onClick={() => navigate(-1)} aria-label="Previous pin">
                ‹
              </button>
              <button type="button" onClick={() => navigate(1)} aria-label="Next pin">
                ›
              </button>
              <button
                type="button"
                aria-label={activeThread.status === 'open' ? 'Resolve thread' : 'Reopen thread'}
                onClick={() =>
                  void (activeThread.status === 'open'
                    ? onResolve(activeThread.id)
                    : onReopen(activeThread.id))
                }
              >
                {activeThread.status === 'open' ? 'Resolve' : 'Reopen'}
              </button>
            </>
          )}
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close pin discussion"
          >
            ×
          </button>
        </div>
      </header>
      {storageError === undefined ? null : <p role="alert">{storageError}</p>}
      {activeThread === undefined ? (
        <form
          className="artifact-thread-popover__composer"
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
            onKeyDown={send}
            placeholder="Add feedback for this element"
            maxLength={4000}
          />
          <button type="submit" className="primary-button">
            Add feedback
          </button>
        </form>
      ) : (
        <>
          <div className="artifact-thread-popover__messages">
            {activeThread.messages.map((message) => (
              <article key={message.id} className="artifact-thread-message">
                <span className="artifact-thread-message__avatar" aria-hidden="true">
                  {message.author.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <p>
                    <strong>{message.author}</strong>
                    <time dateTime={message.createdAt}>
                      {new Date(message.createdAt).toLocaleString()}
                    </time>
                  </p>
                  <p>{message.body}</p>
                </div>
              </article>
            ))}
          </div>
          <form
            className="artifact-thread-popover__composer"
            onSubmit={(event) => {
              event.preventDefault();
              const body = draft.trim();
              if (!body) return;
              void onReply(activeThread.id, body).then((saved) => {
                if (saved) setDraft('');
              });
            }}
          >
            <textarea
              aria-label={`Reply to ${activeThread.id}`}
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={send}
              placeholder="Reply"
              maxLength={4000}
              disabled={activeThread.status === 'resolved'}
            />
            <button type="submit" disabled={activeThread.status === 'resolved'}>
              Reply
            </button>
            {activeThread.status === 'resolved' ? (
              <span className="artifact-thread-popover__reply-status">
                Reopen this thread to reply.
              </span>
            ) : null}
          </form>
        </>
      )}
      <span className="sr-only" role="status">
        {persistenceNotice}
      </span>
    </section>
  );
}

function ArtifactContextPopover({
  anchor,
  inspection,
  view,
  onComment,
  onInspect,
  onClose
}: {
  readonly anchor: ArtifactAnchor;
  readonly inspection: HostedElementInspection | undefined;
  readonly view: Exclude<ArtifactPopoverView, 'thread'>;
  readonly onComment: () => void;
  readonly onInspect: () => void;
  readonly onClose: () => void;
}) {
  const popoverRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const popover = popoverRef.current;
    if (popover === null) return;
    popover.querySelector<HTMLElement>('[data-artifact-action="comment"]')?.focus();
  }, []);
  return (
    <section
      ref={popoverRef}
      className="artifact-thread-popover artifact-context-popover"
      role="dialog"
      aria-label={`Actions for ${formatAnchor(anchor)}`}
      data-horizontal={anchor.point.x > 0.65 ? 'end' : 'start'}
      data-vertical={anchor.point.y > 0.62 ? 'above' : 'below'}
      style={{ left: 0, top: 0 }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => handleArtifactPopoverKeyDown(event, onClose)}
    >
      <header>
        <div>
          <p className="eyebrow">Artifact element</p>
          <strong>{formatAnchor(anchor)}</strong>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close actions">
          ×
        </button>
      </header>
      <div className="artifact-context-popover__actions" aria-label="Artifact actions">
        <button
          type="button"
          className="primary-button"
          data-artifact-action="comment"
          onClick={onComment}
        >
          Comment
        </button>
        <button type="button" className="secondary-button" onClick={onInspect}>
          Inspect
        </button>
      </div>
      {view === 'inspect' ? (
        <section
          className="artifact-context-popover__inspection"
          aria-label="Read-only element inspection"
        >
          <HostedElementInspector inspection={inspection} />
        </section>
      ) : null}
    </section>
  );
}

function orderIdForAnchor(anchor: ArtifactAnchor): string | undefined {
  return orders.find((order) =>
    artifactFields.some(
      (field) =>
        anchor.selector === `[data-review-order="${order.id}"] [data-artifact-field="${field}"]`
    )
  )?.id;
}

const baselineChanges = [
  {
    orderId: '#1048',
    field: 'status' as const,
    title: 'Status hierarchy',
    body: 'Needs review now names the fulfillment decision before packing begins.'
  },
  {
    orderId: '#1048',
    field: 'customer' as const,
    title: 'Address confirmation',
    body: 'The baseline did not expose address confirmation before fulfillment.'
  },
  {
    orderId: '#1047',
    field: 'total' as const,
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
  readonly onPinBaselineChange: (orderId: string, field: ArtifactField, title: string) => void;
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
          Each change resolves a live semantic artifact element before opening a thread bound to
          this revision and baseline.
        </p>
        <div className="baseline-change-list">
          {baselineChanges.map((change) => (
            <article key={change.title}>
              <h2>{change.title}</h2>
              <p>{change.body}</p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => onPinBaselineChange(change.orderId, change.field, change.title)}
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

export interface HostedReviewPortalProps {
  /** Host composition may replace the offline provider without giving the renderer authority. */
  readonly provider?: HostedReviewProviderPort;
  readonly context?: CollaborationHostContext;
  readonly binding?: HostedReviewBinding;
}

export function HostedReviewPortal({
  provider = hostedReviewProvider,
  context = browserLocalHostedReviewContext,
  binding = hostedReviewBinding
}: HostedReviewPortalProps = {}) {
  const [section, setSection] = useState<ReviewSection>(sectionFromLocation);
  const [prototypeState, setPrototypeState] = useState<PrototypeState>('ready');
  const [selectedOrderId, setSelectedOrderId] = useState('#1048');
  const [filter, setFilter] = useState<'all' | 'attention' | 'fulfillment'>('all');
  const [activeAnchor, setActiveAnchor] = useState<ArtifactAnchor>();
  const [activeInspection, setActiveInspection] = useState<HostedElementInspection>();
  const [artifactPopoverView, setArtifactPopoverView] = useState<ArtifactPopoverView>('actions');
  const [publishedInspection, setPublishedInspection] = useState<PublishedInspectionManifest>();
  const [inspectionManifestMessage, setInspectionManifestMessage] = useState(
    'Verifying revision-bound inspection metadata.'
  );
  const [threads, setThreads] = useState<readonly PortalReviewThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string>();
  const [notice, setNotice] = useState(
    hostedReviewFallback
      ? 'Hosted review is not configured; using the explicit browser-local fallback.'
      : 'Viewing revision-bound review data for revision 18.'
  );
  const [storageError, setStorageError] = useState<string>();
  const [providerInfo, setProviderInfo] = useState<HostedReviewProviderState>(
    configuredReviewProviderState
  );
  const [providerState, setProviderState] = useState(configuredReviewProviderState.sync);
  const artifactSurfaceRef = useRef<HTMLDivElement>(null);
  const artifactPinTrigger = useRef<HTMLElement>(null);
  const artifactSurface = artifactSurfaceRef.current;
  const selectedOrder = orders.find((order) => order.id === selectedOrderId);
  const persistenceNotice =
    providerInfo.provider === 'browser-local'
      ? "Saved in this browser's durable local review store; no remote collaboration provider is configured."
      : 'Saved through the authenticated hosted review provider for this revision.';
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
    void stateHostedReviewThroughHost(context, provider, binding).then(
      (state) => {
        if (active) {
          setProviderInfo(state);
          setProviderState(state.sync);
        }
      },
      () => {
        if (active) setProviderState('error');
      }
    );
    void listHostedReviewThroughHost(context, provider, binding).then(
      (loaded) => {
        if (!active) return;
        setThreads(loaded.map(reviewThreadView));
      },
      () => {
        if (!active) return;
        setProviderState('error');
        setStorageError(
          'The review provider could not be read. Existing review data was not changed.'
        );
      }
    );
    return () => {
      active = false;
    };
  }, [binding, context, provider]);

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

  async function refreshProviderState(): Promise<void> {
    const state = await stateHostedReviewThroughHost(context, provider, binding);
    setProviderInfo(state);
    setProviderState(state.sync);
  }

  async function mutateThread(operation: HostedReviewOperation, message: string): Promise<boolean> {
    setProviderState('syncing');
    try {
      const result = await mutateHostedReviewThroughHost(context, provider, operation);
      if (!result.ok) {
        setProviderState(result.code === 'conflict' ? 'conflict' : 'error');
        if (result.code === 'conflict') {
          if (result.thread !== undefined) {
            const currentThread = result.thread;
            setThreads((current) => [
              ...current.filter((thread) => thread.id !== currentThread.id),
              reviewThreadView(currentThread)
            ]);
          } else {
            const reloaded = await listHostedReviewThroughHost(context, provider, binding);
            setThreads(reloaded.map(reviewThreadView));
          }
        }
        setStorageError(
          result.code === 'conflict'
            ? `This discussion changed first (version ${result.currentVersion}). Current discussion was reloaded; retry your action.`
            : result.code === 'forbidden'
              ? 'This review session is not permitted to change the discussion. Existing review data was kept.'
              : (result.message ??
                'The review provider could not save this discussion. Existing review data was kept.')
        );
        return false;
      }
      setThreads((current) => [
        ...current.filter((thread) => thread.id !== result.thread.id),
        reviewThreadView(result.thread)
      ]);
      setStorageError(undefined);
      try {
        await refreshProviderState();
      } catch {
        setProviderState('error');
        setStorageError(
          'The discussion was saved, but the review provider state could not be refreshed.'
        );
      }
      setNotice(message);
      return true;
    } catch {
      setProviderState('error');
      setStorageError('The review provider could not complete this discussion operation.');
      return false;
    }
  }

  function threadVersion(threadId: string): number {
    const thread = threads.find((candidate) => candidate.id === threadId);
    return thread?.version ?? 0;
  }

  async function createThread(body: string): Promise<boolean> {
    if (selectedOrder === undefined || activeAnchor === undefined) return false;
    const threadId = reviewId('thread');
    const saved = await mutateThread(
      {
        type: 'create',
        binding,
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
        binding,
        operationId: reviewId('operation'),
        threadId,
        body,
        expectedVersion: threadVersion(threadId)
      },
      'Saved reply through the active revision-bound review provider.'
    );
  }

  function setThreadStatus(threadId: string, status: 'open' | 'resolved'): Promise<void> {
    return mutateThread(
      {
        type: status === 'resolved' ? 'resolve' : 'reopen',
        binding,
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
    }
    setNotice(message);
  }

  function showPrototypeState(nextState: PrototypeState) {
    setPrototypeState(nextState);
    setActiveInspection(undefined);
    setActiveAnchor(undefined);
    setArtifactPopoverView('actions');
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

  function closeArtifactPopover() {
    setActiveAnchor(undefined);
    setActiveThreadId(undefined);
    setArtifactPopoverView('actions');
    setNotice('Artifact pin discussion closed.');
    requestAnimationFrame(() => artifactPinTrigger.current?.focus());
  }

  function selectSemanticArtifact(orderId: string, field: ArtifactField, element: HTMLElement) {
    const surface = artifactSurfaceRef.current;
    if (surface === null) return;
    const anchor = semanticAnchorForElement(orderId, field, element, surface);
    if (anchor === undefined) return;
    artifactPinTrigger.current = element;
    activateArtifactInspection({ orderId, field, component: anchor.component, element }, anchor);
    setArtifactPopoverView('actions');
    setNotice(`Selected ${anchor.component}. Choose Comment or Inspect for this artifact element.`);
  }

  function activateArtifactInspection(hit: ResolvedArtifactHit, anchor: ArtifactAnchor) {
    const surface = artifactSurfaceRef.current;
    const publishedTarget = publishedInspection?.targetById[hit.field];
    setSelectedOrderId(hit.orderId);
    setActiveAnchor(anchor);
    setActiveThreadId(undefined);
    if (publishedTarget === undefined) {
      setActiveInspection(undefined);
      return;
    }
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

  function inspectArtifactField(
    event: ReactKeyboardEvent<HTMLElement>,
    orderId: string,
    field: ArtifactField
  ) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectSemanticArtifact(orderId, field, event.currentTarget);
  }

  function openBaselineChange(orderId: string, field: ArtifactField, title: string) {
    setSection('prototype');
    window.history.pushState({ reviewSection: 'prototype' }, '', reviewRoute('prototype'));
    requestAnimationFrame(() => {
      const surface = artifactSurfaceRef.current;
      if (surface === null) {
        setNotice(`${title} could not resolve a live semantic artifact element.`);
        return;
      }
      const element = surface.querySelector<HTMLElement>(
        `[data-review-order="${orderId}"] [data-artifact-field="${field}"]`
      );
      if (element === null) {
        setNotice(`${title} could not resolve a live semantic artifact element.`);
        return;
      }
      const anchor = semanticAnchorForElement(orderId, field, element, surface);
      if (anchor === undefined) {
        setNotice(`${title} could not derive a revision-bound artifact anchor.`);
        return;
      }
      artifactPinTrigger.current = element;
      setSelectedOrderId(orderId);
      setActiveAnchor(anchor);
      setActiveInspection(undefined);
      setActiveThreadId(undefined);
      setArtifactPopoverView('thread');
      setNotice(`${title} is selected as a revision-bound artifact pin.`);
    });
  }

  function openSavedThread(thread: PortalReviewThread, trigger?: HTMLElement) {
    if (trigger !== undefined) artifactPinTrigger.current = trigger;
    setPrototypeState('ready');
    setSelectedOrderId(orderIdForAnchor(thread.anchor) ?? orders[0]?.id ?? '');
    setActiveAnchor(thread.anchor);
    setActiveInspection(undefined);
    setActiveThreadId(thread.id);
    setArtifactPopoverView('thread');
    if (section !== 'prototype') {
      window.history.pushState({ reviewSection: 'prototype' }, '', reviewRoute('prototype'));
      setSection('prototype');
    }
    setNotice(`Opened saved revision-bound thread for ${formatAnchor(thread.anchor)}.`);
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
          data-provider={providerInfo.provider}
          data-identity={providerInfo.identity}
          data-sync={providerState}
        >
          <strong>Review provider: {providerInfo.provider}</strong>
          <span>
            {providerInfo.identity} identity · {providerState} · artifact {binding.artifactId} ·
            baseline {binding.baselineId}
            {providerInfo.provider === 'hosted' && providerInfo.message !== undefined
              ? ` · ${providerInfo.message}`
              : ''}
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
        <div className="artifact-selection-controls" aria-label="Artifact element selection">
          <span>Semantic element</span>
          {activeAnchor !== undefined ? (
            <button
              type="button"
              onClick={() => {
                setActiveAnchor(undefined);
                setActiveInspection(undefined);
                setActiveThreadId(undefined);
                setArtifactPopoverView('actions');
                setNotice('Artifact selection cleared.');
              }}
            >
              Clear
            </button>
          ) : null}
        </div>
        <p role="status" aria-label="Artifact selection status">
          {notice}
        </p>
        <span className="artifact-selection-help" id="inspection-manifest-status">
          {inspectionManifestMessage} Select an artifact element, then choose Comment or Inspect
          beside that element.
        </span>
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
                        Revision-bound review data · {threads.length} thread
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
                              tabIndex={0}
                              onClick={(event) =>
                                selectSemanticArtifact(order.id, 'order', event.currentTarget)
                              }
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
                                  setArtifactPopoverView('actions');
                                  setNotice(`${order.id} is selected. Choose a semantic element.`);
                                }}
                              >
                                {order.id}
                              </button>
                            </td>
                            <td
                              data-artifact-field="customer"
                              tabIndex={0}
                              onClick={(event) =>
                                selectSemanticArtifact(order.id, 'customer', event.currentTarget)
                              }
                              onKeyDown={(event) =>
                                inspectArtifactField(event, order.id, 'customer')
                              }
                            >
                              {order.customer}
                            </td>
                            <td
                              data-artifact-field="status"
                              tabIndex={0}
                              onClick={(event) =>
                                selectSemanticArtifact(order.id, 'status', event.currentTarget)
                              }
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
                              tabIndex={0}
                              onClick={(event) =>
                                selectSemanticArtifact(order.id, 'total', event.currentTarget)
                              }
                              onKeyDown={(event) => inspectArtifactField(event, order.id, 'total')}
                            >
                              <strong data-artifact-inspect="">{order.total}</strong>
                            </td>
                            <td
                              data-artifact-field="placed"
                              tabIndex={0}
                              onClick={(event) =>
                                selectSemanticArtifact(order.id, 'placed', event.currentTarget)
                              }
                              onKeyDown={(event) => inspectArtifactField(event, order.id, 'placed')}
                            >
                              {order.date}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div
                      className="artifact-pin-layer"
                      aria-label="Revision-bound artifact pins"
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      {threads.map((thread, index) => (
                        <button
                          key={thread.id}
                          type="button"
                          className="artifact-pin-control"
                          aria-label={`Open artifact pin ${index + 1}: ${thread.anchor.component}`}
                          style={{
                            left: `${thread.anchor.point.x * 100}%`,
                            top: `${thread.anchor.point.y * 100}%`
                          }}
                          onClick={(event) => openSavedThread(thread, event.currentTarget)}
                        >
                          {index + 1}
                        </button>
                      ))}
                      {activeAnchor === undefined ? null : (
                        <span
                          className="artifact-selection-outline"
                          aria-hidden="true"
                          style={{
                            left: `${activeAnchor.region.x * 100}%`,
                            top: `${activeAnchor.region.y * 100}%`,
                            width: `${activeAnchor.region.width * 100}%`,
                            height: `${activeAnchor.region.height * 100}%`
                          }}
                        />
                      )}
                    </div>
                    {activeAnchor === undefined || artifactSurface === null ? null : (
                      <ArtifactPopoverLayer anchor={activeAnchor} surface={artifactSurface}>
                        {artifactPopoverView === 'thread' ? (
                          <ArtifactThreadPopover
                            anchor={activeAnchor}
                            threads={threads}
                            activeThreadId={activeThreadId}
                            persistenceNotice={persistenceNotice}
                            storageError={storageError}
                            onCreateThread={createThread}
                            onReply={replyToThread}
                            onResolve={(threadId) => setThreadStatus(threadId, 'resolved')}
                            onReopen={(threadId) => setThreadStatus(threadId, 'open')}
                            onNavigate={openSavedThread}
                            onClose={closeArtifactPopover}
                          />
                        ) : (
                          <ArtifactContextPopover
                            anchor={activeAnchor}
                            inspection={activeInspection}
                            view={artifactPopoverView}
                            onComment={() => {
                              setArtifactPopoverView('thread');
                              setNotice(`Commenting on ${formatAnchor(activeAnchor)}.`);
                            }}
                            onInspect={() => {
                              setArtifactPopoverView('inspect');
                              setNotice(`Inspecting ${formatAnchor(activeAnchor)}.`);
                            }}
                            onClose={closeArtifactPopover}
                          />
                        )}
                      </ArtifactPopoverLayer>
                    )}
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
      </div>
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
