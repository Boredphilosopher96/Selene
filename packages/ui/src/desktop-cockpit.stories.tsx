import { useCallback, useEffect, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  createPrototypeRuntime,
  enterpriseScenarioFixtures,
  parsePrototypeGraph
} from '@selene/core';

import {
  DESIGNER_API_VERSION,
  defaultWorkspaceCockpitPreferences,
  type DesignerSnapshot,
  type DesignerProgress,
  type GeneratedCodePublishReceipt,
  type GitHubPublishSetup,
  type WorkspaceCockpitPreferences
} from '../../../apps/desktop/src/shared/designer-api';
import {
  DesktopCockpit,
  type DesktopCockpitActions,
  type InspectorTab
} from '../../../apps/desktop/src/renderer/src/cockpit/desktop-cockpit';
import type { GuidedSetupActions } from '../../../apps/desktop/src/renderer/src/cockpit/guided-setup-panel';
import { WorkspaceToolbar } from '../../../apps/desktop/src/renderer/src/cockpit/workspace-toolbar';
import type { WorkspaceControlActions } from '../../../apps/desktop/src/renderer/src/cockpit/workspace-controls';
import type { PreviewMappedElementTelemetrySelection } from '../../../apps/desktop/src/shared/preview-channel';
import { relativeLuminance } from './preview-artifact-readiness';

const ordersArtifactSource = `import { useMemo, useState } from 'react';

export default function OrdersApp() {
  const [query, setQuery] = useState('');
  const orders = useMemo(() => [
    { id: 'SO-1048', customer: 'Northwind Atelier', total: '$2,480.00', status: 'Paid' },
    { id: 'SO-1047', customer: 'Aster & Co.', total: '$840.00', status: 'Packing' },
    { id: 'SO-1046', customer: 'Common Thread', total: '$1,260.00', status: 'Review' }
  ].filter((order) => order.customer.toLowerCase().includes(query.toLowerCase())), [query]);
  return <OrdersTable orders={orders} query={query} onQueryChange={setQuery} />;
}

function OrdersTable({ orders, query, onQueryChange }: {
  orders: readonly { id: string; customer: string; total: string; status: string }[];
  query: string;
  onQueryChange: (query: string) => void;
}) {
  return <main aria-label="Orders"><h1>Orders</h1><input value={query} onChange={(event) => onQueryChange(event.target.value)} aria-label="Search orders" />{orders.map((order) => <article key={order.id}><strong>{order.id}</strong><span>{order.customer}</span><span>{order.total}</span><span>{order.status}</span></article>)}</main>;
}`;

type ArtifactReadinessSubreason =
  | 'ready'
  | 'artifact-missing'
  | 'owner-window-unavailable'
  | 'computed-style-unavailable'
  | 'bounds'
  | 'visibility'
  | 'opacity'
  | 'luminance'
  | 'heading-text'
  | 'heading-rect'
  | 'row-count'
  | 'row-rects'
  | 'required-copy'
  | 'primary-action';

function directManipulationSelection(revisionId: string): PreviewMappedElementTelemetrySelection {
  return {
    provenance: 'authenticated-preview-node',
    nodeId: 'order-total',
    revisionId,
    values: {
      hierarchy: [
        { nodeId: 'orders-root', semanticTag: 'main' },
        { nodeId: 'order-total', semanticTag: 'span' }
      ],
      left: 648,
      top: 258,
      width: 184,
      height: 44,
      display: 'flex',
      position: 'relative',
      boxSizing: 'border-box',
      margin: '0px',
      padding: '10px 14px',
      gap: '8px',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gridTemplateColumns: 'none',
      gridTemplateRows: 'none',
      overflow: 'visible',
      fontFamily: 'Inter, sans-serif',
      fontSize: '16px',
      fontWeight: '600',
      lineHeight: '24px',
      letterSpacing: '0px',
      textAlign: 'right',
      textDecoration: 'none',
      color: 'rgb(24, 32, 51)',
      backgroundColor: 'rgb(255, 255, 255)',
      border: '1px solid rgb(221, 226, 236)',
      borderRadius: '10px',
      boxShadow: 'none',
      opacity: '1',
      semanticTag: 'span',
      explicitAriaRole: '',
      ariaLabel: '',
      accessibleDescription: '',
      ariaDisabled: '',
      ariaExpanded: '',
      ariaPressed: '',
      ariaChecked: '',
      ariaSelected: '',
      ariaHidden: '',
      tabIndex: -1
    }
  };
}

type ArtifactReadiness =
  | { readonly ready: true; readonly reason: 'ready' }
  | { readonly ready: false; readonly reason: Exclude<ArtifactReadinessSubreason, 'ready'> };

function hasPaintedOrdersArtifact(artifact: HTMLElement | null): ArtifactReadiness {
  if (artifact === null) return { ready: false, reason: 'artifact-missing' };
  // This fixture lives in the same-origin preview iframe. CSSOM must come from
  // the artifact's realm; the outer Storybook window cannot reliably inspect it.
  const ownerView = artifact.ownerDocument.defaultView;
  if (ownerView === null) return { ready: false, reason: 'owner-window-unavailable' };
  let style: CSSStyleDeclaration;
  try {
    style = ownerView.getComputedStyle(artifact);
  } catch {
    return { ready: false, reason: 'computed-style-unavailable' };
  }
  const bounds = artifact.getBoundingClientRect();
  if (bounds.width < 320 || bounds.height < 320) return { ready: false, reason: 'bounds' };
  if (style.visibility !== 'visible') return { ready: false, reason: 'visibility' };
  if (Number.parseFloat(style.opacity) < 0.98) return { ready: false, reason: 'opacity' };
  const lightness = relativeLuminance(style.backgroundColor);
  if (lightness === undefined || lightness < 0.5) return { ready: false, reason: 'luminance' };
  const heading = artifact.querySelector('h1');
  if (heading === null || heading.textContent?.trim() !== 'Orders')
    return { ready: false, reason: 'heading-text' };
  if (heading.getClientRects().length === 0) return { ready: false, reason: 'heading-rect' };
  const rows = artifact.querySelectorAll('.row');
  if (rows.length !== 3) return { ready: false, reason: 'row-count' };
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows.item(index);
    if (row === null || row.getClientRects().length === 0)
      return { ready: false, reason: 'row-rects' };
  }
  if (
    artifact.textContent?.includes('Northwind Atelier') !== true ||
    artifact.textContent?.includes('SO-1048') !== true
  )
    return { ready: false, reason: 'required-copy' };
  if (artifact.querySelector<HTMLButtonElement>('button.new')?.textContent?.trim() !== 'New order')
    return { ready: false, reason: 'primary-action' };
  return { ready: true, reason: 'ready' };
}

/** Bounded above the visual harness's iframe settle time, while still failing closed. */
const fixtureReadinessTimeoutMs = 4_000;

type FixturePreviewPaint = 'loading' | 'ready' | 'unavailable';
type FixtureReadinessReason =
  | 'build-loading'
  | 'waiting-for-artifact'
  | 'ready'
  | 'frame-unavailable'
  | 'frame-replaced'
  | 'origin-mismatch'
  | 'origin-inaccessible'
  | 'artifact-timeout'
  | 'frame-error';

const graph = parsePrototypeGraph({
  format: 'selene-prototype-graph/v1',
  id: 'cockpit-flow',
  name: 'Cockpit flow',
  project: { projectId: 'cockpit', owner: 'Selene' },
  revision: { id: 'cockpit-r1', createdAt: '2026-07-24T19:00:00.000Z', summary: 'Story fixture' },
  handoff: { status: 'draft', owner: 'Selene', summary: 'Story fixture' },
  initialNodeId: 'dashboard',
  nodes: [
    {
      id: 'dashboard',
      kind: 'screen',
      label: 'Dashboard',
      route: '/',
      position: { x: 0, y: 0 },
      ports: [{ id: 'open-orders', label: 'Open orders', trigger: 'click' }]
    },
    {
      id: 'orders',
      kind: 'screen',
      label: 'Orders',
      route: '/orders',
      position: { x: 330, y: 0 },
      ports: [{ id: 'back', label: 'Back', trigger: 'click' }]
    }
  ],
  transitions: [
    {
      id: 'dashboard-orders',
      kind: 'navigate',
      from: { nodeId: 'dashboard', portId: 'open-orders' },
      to: { nodeId: 'orders' }
    },
    { id: 'orders-back', kind: 'back', from: { nodeId: 'orders', portId: 'back' } }
  ],
  scenarios: [
    {
      id: 'review',
      name: 'Review order',
      startNodeId: 'dashboard',
      expectedPath: ['dashboard', 'orders']
    }
  ],
  fixtures: {}
});

const largeNavigatorGraph = parsePrototypeGraph({
  ...graph,
  id: 'cockpit-flow-large',
  name: 'Cockpit flow inventory',
  nodes: [
    ...graph.nodes,
    {
      id: 'settings',
      kind: 'page',
      label: 'Settings',
      route: '/settings',
      position: { x: 660, y: 0 },
      ports: []
    },
    {
      id: 'orders-empty',
      kind: 'state',
      label: 'No open orders',
      parentId: 'orders',
      position: { x: 340, y: 260 },
      ports: []
    },
    {
      id: 'support-overlay',
      kind: 'overlay',
      label: 'Support panel',
      dismissible: true,
      position: { x: 660, y: 260 },
      ports: []
    }
  ],
  scenarios: [
    ...graph.scenarios,
    {
      id: 'orders-empty',
      name: 'No open orders',
      startNodeId: 'orders',
      initialStateId: 'orders-empty',
      expectedPath: ['orders']
    },
    {
      id: 'settings-default',
      name: 'Settings default',
      startNodeId: 'settings',
      expectedPath: ['settings']
    }
  ]
});

const fixture: DesignerSnapshot = {
  apiVersion: DESIGNER_API_VERSION,
  agents: [{ id: 'fixture-agent', label: 'Fixture agent', capabilities: ['source-edit'] }],
  selectedAgentId: 'fixture-agent',
  source: {
    format: 'selene-react-workspace/v1',
    projectId: 'cockpit',
    entrypoint: 'src/App.tsx',
    files: [
      {
        path: 'src/App.tsx',
        language: 'tsx',
        content: ordersArtifactSource
      }
    ],
    dependencies: ['react'],
    nodes: [
      {
        nodeId: 'order-total',
        path: 'src/orders/OrderTotal.tsx',
        exportName: 'OrderTotal'
      }
    ],
    revision: { id: 'cockpit-r1', createdAt: '2026-07-24T19:00:00.000Z', summary: 'Story fixture' }
  },
  nodes: [
    {
      nodeId: 'order-total',
      path: 'src/orders/OrderTotal.tsx',
      exportName: 'OrderTotal'
    }
  ],
  reviewThreads: [
    {
      id: 'thread-total',
      status: 'open',
      body: 'Verify total remains visible.',
      replies: [],
      author: 'Reviewer',
      createdAt: '2026-07-24T19:00:00.000Z',
      anchor: {
        x: 0.72,
        y: 0.58,
        width: 0.2,
        height: 0.12,
        artifactId: 'cockpit',
        screenId: 'dashboard',
        scenarioId: 'review',
        state: 'success',
        revisionId: 'cockpit-r1',
        nodeRef: 'order-total',
        viewport: { width: 1200, height: 800 }
      }
    }
  ],
  artifactPins: [
    {
      id: 'thread-total',
      label: 'Order total',
      createdAt: '2026-07-24T19:00:00.000Z',
      anchor: {
        x: 0.72,
        y: 0.58,
        width: 0.2,
        height: 0.12,
        artifactId: 'cockpit',
        screenId: 'dashboard',
        scenarioId: 'review',
        state: 'success',
        revisionId: 'cockpit-r1',
        nodeRef: 'order-total',
        viewport: { width: 1200, height: 800 }
      }
    }
  ],
  aiChangeRequests: [],
  designActivity: [],
  developerAnnotations: [],
  scenarios: [enterpriseScenarioFixtures[0]!],
  selectedScenarioId: enterpriseScenarioFixtures[0]!.id,
  baseline: {
    projectId: 'cockpit',
    readiness: 'draft',
    currency: 'none',
    changesSinceBaseline: [],
    approvalsStale: false
  },
  prototype: {
    flow: {
      format: 'selene-prototype-flow/v1',
      nodes: [{ id: 'dashboard', kind: 'screen', title: 'Dashboard', states: ['default'] }],
      connections: []
    },
    currentScreenId: 'dashboard'
  },
  editablePrototype: { graph, mode: 'edit', revision: 1 },
  prototypeGraphHydration: { state: 'persisted' },
  componentCatalog: {
    entries: [
      { component: 'OrderTotal', href: '#order-total' },
      { component: 'Button', href: '#button' }
    ]
  },
  activity: ['Fixture ready.']
};

const conversationRequests: DesignerSnapshot['aiChangeRequests'] = [
  {
    id: 'request-applied',
    agentId: 'fixture-agent',
    instruction: 'Clarify the primary action and keep keyboard focus visible.',
    status: 'applied',
    createdAt: '2026-07-24T19:02:00.000Z',
    resultingRevisionId: 'cockpit-r1',
    target: {
      x: 0.5,
      y: 0.42,
      viewport: { width: 1200, height: 800 },
      artifactId: 'cockpit',
      screenId: 'dashboard',
      scenarioId: enterpriseScenarioFixtures[0]!.id,
      state: enterpriseScenarioFixtures[0]!.state,
      revisionId: 'cockpit-r1'
    }
  },
  {
    id: 'request-undone',
    agentId: 'fixture-agent',
    instruction: 'Increase the card contrast for a quick experiment.',
    status: 'undone',
    createdAt: '2026-07-24T19:01:00.000Z',
    resultingRevisionId: 'cockpit-undo-request-undone-3',
    target: {
      x: 0.2,
      y: 0.3,
      width: 0.3,
      height: 0.2,
      viewport: { width: 1200, height: 800 },
      artifactId: 'cockpit',
      screenId: 'dashboard',
      scenarioId: enterpriseScenarioFixtures[0]!.id,
      state: enterpriseScenarioFixtures[0]!.state,
      revisionId: 'cockpit-r0'
    }
  },
  {
    id: 'request-failed',
    agentId: 'fixture-agent',
    instruction: 'Make the order total easier to scan.',
    status: 'failed',
    createdAt: '2026-07-24T19:00:00.000Z',
    error: 'The configured local agent is offline. Retry when it reconnects.',
    target: {
      x: 0.72,
      y: 0.58,
      viewport: { width: 1200, height: 800 },
      artifactId: 'cockpit',
      screenId: 'orders',
      scenarioId: enterpriseScenarioFixtures[0]!.id,
      state: enterpriseScenarioFixtures[0]!.state,
      revisionId: 'cockpit-r1'
    }
  },
  {
    id: 'request-cancelled',
    agentId: 'fixture-agent',
    instruction: 'Try a denser review summary.',
    status: 'cancelled',
    createdAt: '2026-07-24T18:59:00.000Z',
    target: {
      x: 0.45,
      y: 0.7,
      viewport: { width: 1200, height: 800 },
      artifactId: 'cockpit',
      screenId: 'dashboard',
      scenarioId: enterpriseScenarioFixtures[0]!.id,
      state: enterpriseScenarioFixtures[0]!.state,
      revisionId: 'cockpit-r1'
    }
  }
];

const activeConversationRequests: DesignerSnapshot['aiChangeRequests'] = [
  ...conversationRequests,
  {
    id: 'request-running',
    agentId: 'fixture-agent',
    instruction: 'Reorder the responsive summary cards for compact review.',
    status: 'running',
    createdAt: '2026-07-24T19:03:00.000Z',
    target: {
      x: 0.35,
      y: 0.4,
      viewport: { width: 1200, height: 800 },
      artifactId: 'cockpit',
      screenId: 'dashboard',
      scenarioId: enterpriseScenarioFixtures[0]!.id,
      state: enterpriseScenarioFixtures[0]!.state,
      revisionId: 'cockpit-r1'
    }
  }
];

function agentDesignActivity(
  requests: DesignerSnapshot['aiChangeRequests']
): DesignerSnapshot['designActivity'] {
  return requests.map((request) => ({
    id: `agent:${request.id}`,
    origin: 'agent',
    kind: 'ai-change',
    label: request.instruction,
    actorLabel: 'Fixture agent',
    createdAt: request.createdAt,
    status: request.status,
    referenceId: request.id,
    ...(request.resultingRevisionId === undefined
      ? {}
      : { resultingRevisionId: request.resultingRevisionId })
  }));
}

function FixtureCockpit({
  recovery = false,
  runMode = false,
  leftCollapsed = false,
  rightCollapsed = false,
  selectedThread = false,
  emptyReviews = false,
  loadingPreview = false,
  inspectorTab,
  setup = 'authenticated',
  hostedReview = 'unconfigured',
  compact = false,
  drawerOpen = false,
  artifactFailure,
  inspectSelection = 'none',
  navigator = 'standard',
  conversation = 'mixed',
  contrast,
  motion,
  theme
}: {
  readonly recovery?: boolean;
  readonly runMode?: boolean;
  readonly leftCollapsed?: boolean;
  readonly rightCollapsed?: boolean;
  readonly selectedThread?: boolean;
  readonly emptyReviews?: boolean;
  readonly loadingPreview?: boolean;
  readonly inspectorTab?: InspectorTab;
  readonly setup?: 'authenticated' | 'offline' | 'unavailable' | 'recovery-required';
  readonly hostedReview?: 'unconfigured' | 'offline' | 'conflict';
  readonly compact?: boolean;
  readonly drawerOpen?: boolean;
  readonly artifactFailure?: 'heading-text';
  readonly inspectSelection?: 'none' | 'node';
  readonly navigator?: 'standard' | 'large' | 'empty-groups' | 'missing';
  readonly conversation?: 'empty' | 'mixed' | 'active' | 'offline';
  readonly contrast?: 'more';
  readonly motion?: 'reduce';
  readonly theme?: 'dark';
}) {
  const navigatorGraph = navigator === 'large' ? largeNavigatorGraph : graph;
  const navigatorRuntime =
    navigator === 'large'
      ? createPrototypeRuntime(navigatorGraph, 'orders-empty').snapshot()
      : runMode
        ? createPrototypeRuntime(navigatorGraph).snapshot()
        : undefined;
  const initialConversationRequests =
    conversation === 'mixed'
      ? conversationRequests
      : conversation === 'active'
        ? activeConversationRequests
        : [];
  const [snapshot, setSnapshot] = useState(() => ({
    ...fixture,
    ...(inspectSelection === 'node' ? { selectedNodeId: 'order-total' } : {}),
    agents: conversation === 'offline' ? [] : fixture.agents,
    aiChangeRequests: initialConversationRequests,
    designActivity: agentDesignActivity(initialConversationRequests),
    reviewThreads: emptyReviews ? [] : fixture.reviewThreads,
    artifactPins: emptyReviews ? [] : fixture.artifactPins,
    prototypeGraphHydration: recovery
      ? {
          state: 'recovery-required' as const,
          message: 'Fixture recovery requires explicit action.'
        }
      : navigator === 'missing'
        ? { state: 'missing' as const }
        : fixture.prototypeGraphHydration,
    editablePrototype: {
      ...fixture.editablePrototype,
      graph: navigatorGraph,
      mode: runMode || navigator === 'large' ? ('run' as const) : ('edit' as const),
      ...(navigatorRuntime === undefined ? {} : { runtime: navigatorRuntime })
    }
  }));
  const [preferences, setPreferences] = useState<WorkspaceCockpitPreferences>(() => ({
    ...defaultWorkspaceCockpitPreferences,
    leftRailCollapsed: leftCollapsed,
    rightRailCollapsed: rightCollapsed,
    inspectorTab:
      inspectorTab ??
      (runMode || recovery || navigator !== 'standard'
        ? ('inspect' as const)
        : selectedThread || emptyReviews
          ? ('reviews' as const)
          : ('inspect' as const))
  }));
  const [notice, setNotice] = useState(
    loadingPreview
      ? 'Compiling the selected workspace in the secure preview…'
      : 'Validated local workspace ready.'
  );
  const [publishStatus, setPublishStatus] = useState(
    hostedReview === 'conflict'
      ? 'Remote artifact published; stakeholder synchronization reports an artifact conflict.'
      : hostedReview === 'offline'
        ? 'Remote artifact published; stakeholder synchronization is offline.'
        : setup === 'offline'
          ? 'GitHub setup is offline. Retry when the host is reachable.'
          : setup === 'unavailable'
            ? 'Trusted GitHub CLI is unavailable.'
            : setup === 'recovery-required'
              ? 'Host recovery is required before another GitHub operation.'
              : 'No publish operation started.'
  );
  const [diagnosticsConsent, setDiagnosticsConsent] = useState<'unknown' | 'granted' | 'denied'>(
    'unknown'
  );
  const [recoveryActive, setRecoveryActive] = useState(recovery);
  const [renderedRevisionId, setRenderedRevisionId] = useState(fixture.source.revision.id);
  const [conversationProgress, setConversationProgress] = useState<DesignerProgress>();
  const [previewPaint, setPreviewPaint] = useState<FixturePreviewPaint>('loading');
  const [previewPaintReason, setPreviewPaintReason] =
    useState<FixtureReadinessReason>('waiting-for-artifact');
  const [previewPaintSubreason, setPreviewPaintSubreason] = useState<
    ArtifactReadinessSubreason | 'not-checked'
  >('not-checked');
  const frame = useRef<HTMLIFrameElement>(null);
  const fixtureReadiness = useRef<{
    generation: number;
    timer: number | undefined;
    source: string | undefined;
    document: Document | undefined;
    active: boolean;
  }>({
    generation: 0,
    timer: undefined,
    source: undefined,
    document: undefined,
    active: false
  });
  const cancelFixtureReadiness = useCallback(() => {
    const current = fixtureReadiness.current;
    current.generation += 1;
    if (current.timer !== undefined) window.clearTimeout(current.timer);
    current.timer = undefined;
    current.source = undefined;
    current.document = undefined;
    current.active = false;
    return current.generation;
  }, []);
  const beginFixtureReadiness = useCallback(
    (generation: number, source: string, document: Document) => {
      const current = fixtureReadiness.current;
      if (current.generation !== generation) return false;
      current.source = source;
      current.document = document;
      current.active = true;
      setPreviewPaint('loading');
      setPreviewPaintReason('waiting-for-artifact');
      return true;
    },
    []
  );
  const finishFixtureReadiness = useCallback(
    (
      generation: number,
      paint: Exclude<FixturePreviewPaint, 'loading'>,
      reason: FixtureReadinessReason
    ) => {
      const current = fixtureReadiness.current;
      if (current.generation !== generation || !current.active) return false;
      if (current.timer !== undefined) window.clearTimeout(current.timer);
      current.timer = undefined;
      current.active = false;
      // Invalidate this completed generation before publishing its terminal state.
      current.generation += 1;
      setPreviewPaint(paint);
      setPreviewPaintReason(reason);
      return true;
    },
    []
  );
  useEffect(
    () => () => {
      cancelFixtureReadiness();
    },
    [cancelFixtureReadiness]
  );
  const onFixtureFrameLoad = (loadedFrame: HTMLIFrameElement) => {
    const generation = cancelFixtureReadiness();
    const document = loadedFrame.contentDocument;
    const source = loadedFrame.src;
    if (document === null) {
      const current = fixtureReadiness.current;
      if (current.generation !== generation) return;
      current.source = source;
      current.active = true;
      finishFixtureReadiness(generation, 'unavailable', 'frame-unavailable');
      return;
    }
    if (!beginFixtureReadiness(generation, source, document)) return;
    if (frame.current !== loadedFrame) {
      finishFixtureReadiness(generation, 'unavailable', 'frame-unavailable');
      return;
    }
    let expectedOrigin: string;
    try {
      expectedOrigin = new URL(source).origin;
    } catch {
      finishFixtureReadiness(generation, 'unavailable', 'origin-inaccessible');
      return;
    }
    const deadline = performance.now() + fixtureReadinessTimeoutMs;
    const poll = () => {
      const current = fixtureReadiness.current;
      if (current.generation !== generation || !current.active) return;
      const currentFrame = frame.current;
      const currentDocument = currentFrame?.contentDocument;
      if (
        currentFrame === null ||
        currentFrame !== loadedFrame ||
        currentFrame.src !== source ||
        currentDocument === null ||
        currentDocument === undefined
      ) {
        finishFixtureReadiness(generation, 'unavailable', 'frame-replaced');
        return;
      }
      try {
        if (currentDocument.location.origin !== expectedOrigin) {
          finishFixtureReadiness(generation, 'unavailable', 'origin-mismatch');
          return;
        }
      } catch {
        finishFixtureReadiness(generation, 'unavailable', 'origin-inaccessible');
        return;
      }
      // A same-origin navigation can replace the iframe Document after its load event.
      // Keep the frame/source/generation fence, then bind polling to that current document.
      current.document = currentDocument;
      const artifact = currentDocument.querySelector<HTMLElement>(
        'main[data-selene-preview-paint]'
      );
      const artifactReadiness = hasPaintedOrdersArtifact(
        artifact?.dataset.selenePreviewPaint === 'ready' ? artifact : null
      );
      setPreviewPaintSubreason((previous) =>
        previous === artifactReadiness.reason ? previous : artifactReadiness.reason
      );
      if (artifactReadiness.ready) {
        finishFixtureReadiness(generation, 'ready', 'ready');
        return;
      }
      if (performance.now() >= deadline) {
        finishFixtureReadiness(generation, 'unavailable', 'artifact-timeout');
        return;
      }
      fixtureReadiness.current.timer = window.setTimeout(poll, 16);
    };
    poll();
  };
  const onFixtureFrameError = (failedFrame: HTMLIFrameElement) => {
    const current = fixtureReadiness.current;
    if (
      !current.active ||
      frame.current !== failedFrame ||
      current.source !== failedFrame.src ||
      current.document !== failedFrame.contentDocument
    )
      return;
    finishFixtureReadiness(current.generation, 'unavailable', 'frame-error');
  };
  const update = async (change: (current: DesignerSnapshot) => DesignerSnapshot) => {
    let next!: DesignerSnapshot;
    setSnapshot((current) => {
      next = change(current);
      return next;
    });
    return next;
  };
  const next = async () => snapshot;
  const actions: DesktopCockpitActions = {
    snapshot: next,
    selectNode: async (nodeId) =>
      update((current) => {
        if (current.nodes.some((node) => node.nodeId === nodeId))
          return { ...current, selectedNodeId: nodeId };
        const { selectedNodeId: _selectedNodeId, ...withoutSelectedNode } = current;
        return withoutSelectedNode;
      }),
    selectAgent: async (id) => update((current) => ({ ...current, selectedAgentId: id })),
    requestAIChange: async (input) => {
      const updated = await update((current) => {
        const requestId = `fixture-request-${current.aiChangeRequests.length + 1}`;
        const revisionId = `cockpit-r${current.aiChangeRequests.length + 2}`;
        const scenario = current.scenarios.find((item) => item.id === current.selectedScenarioId);
        if (scenario === undefined) return current;
        return {
          ...current,
          source: {
            ...current.source,
            revision: {
              ...current.source.revision,
              id: revisionId,
              parentId: current.source.revision.id,
              createdAt: '2026-07-25T19:35:00.000Z',
              summary: `Fixture applied: ${input.instruction}`
            }
          },
          aiChangeRequests: [
            ...current.aiChangeRequests,
            {
              id: requestId,
              agentId: input.agentId,
              instruction: input.instruction,
              status: 'applied',
              createdAt: '2026-07-25T19:35:00.000Z',
              resultingRevisionId: revisionId,
              target: {
                ...input.target,
                artifactId: current.source.projectId,
                screenId: 'dashboard',
                scenarioId: scenario.id,
                state: scenario.state,
                revisionId: current.source.revision.id
              }
            }
          ]
        };
      });
      const request = updated.aiChangeRequests.at(-1);
      if (request)
        setConversationProgress({
          requestId: request.id,
          agentId: request.agentId,
          stage: 'completed',
          message: 'Fixture request applied.'
        });
      return updated;
    },
    acceptAIProposal: next,
    rejectAIProposal: next,
    cancelAIChange: async (requestId) => {
      const updated = await update((current) => ({
        ...current,
        aiChangeRequests: current.aiChangeRequests.map((request) =>
          request.id === requestId && (request.status === 'queued' || request.status === 'running')
            ? { ...request, status: 'cancelled' as const }
            : request
        )
      }));
      const request = updated.aiChangeRequests.find((item) => item.id === requestId);
      if (request)
        setConversationProgress({
          requestId,
          agentId: request.agentId,
          stage: 'cancelled',
          message: 'Fixture request cancelled.'
        });
    },
    undoLastAIChange: async ({ requestId }) =>
      update((current) => {
        const applied = current.aiChangeRequests.find(
          (request) => request.id === requestId && request.status === 'applied'
        );
        if (applied === undefined) return current;
        const revisionId = `cockpit-undo-${requestId}`;
        return {
          ...current,
          source: {
            ...current.source,
            revision: {
              ...current.source.revision,
              id: revisionId,
              parentId: current.source.revision.id,
              createdAt: '2026-07-25T19:36:00.000Z',
              summary: `Fixture undo: ${requestId}`
            }
          },
          aiChangeRequests: current.aiChangeRequests.map((request) =>
            request.id === requestId
              ? { ...request, status: 'undone' as const, resultingRevisionId: revisionId }
              : request
          )
        };
      }),
    undoLatestManualDesignEdit: next,
    addReviewThread: async (input) =>
      update((current) => {
        const anchor = {
          artifactId: current.source.projectId,
          screenId: 'dashboard',
          scenarioId: 'review',
          state: 'default',
          revisionId: current.source.revision.id,
          ...(current.artifactPins[0]?.anchor ?? {}),
          ...input.anchor
        };
        const thread = {
          id: `thread-${current.reviewThreads.length + 1}`,
          body: input.body,
          replies: [],
          status: 'open' as const,
          author: 'Fixture reviewer',
          createdAt: '2026-07-24T19:00:00.000Z',
          anchor
        };
        return {
          ...current,
          reviewThreads: [...current.reviewThreads, thread],
          artifactPins: [
            ...current.artifactPins,
            { id: thread.id, label: input.body, createdAt: thread.createdAt, anchor: thread.anchor }
          ]
        };
      }),
    resolveReviewThread: async (input) =>
      update((current) => ({
        ...current,
        reviewThreads: current.reviewThreads.map((thread) =>
          thread.id === input.id
            ? { ...thread, status: input.resolved ? 'resolved' : 'open' }
            : thread
        )
      })),
    replyToReviewThread: async (input) =>
      update((current) => ({
        ...current,
        reviewThreads: current.reviewThreads.map((thread) =>
          thread.id === input.id
            ? {
                ...thread,
                replies: [
                  ...thread.replies,
                  {
                    id: `${thread.id}-reply-${thread.replies.length + 1}`,
                    body: input.body,
                    author: 'Fixture reviewer',
                    createdAt: '2026-07-24T19:00:00.000Z'
                  }
                ]
              }
            : thread
        )
      })),
    addDeveloperAnnotation: next,
    savePrototypeGraph: async (nextGraph) =>
      update((current) => ({
        ...current,
        editablePrototype: {
          ...current.editablePrototype,
          graph: nextGraph,
          revision: current.editablePrototype.revision + 1
        }
      })),
    retryPrototypeGraphHydration: next,
    recoverPrototypeGraphFromFixture: next,
    setPrototypeMode: async (mode) =>
      update((current) => {
        if (mode === 'run')
          return {
            ...current,
            editablePrototype: {
              ...current.editablePrototype,
              mode,
              runtime: createPrototypeRuntime(current.editablePrototype.graph).snapshot()
            }
          };
        return {
          ...current,
          editablePrototype: {
            graph: current.editablePrototype.graph,
            mode,
            revision: current.editablePrototype.revision
          }
        };
      }),
    startPrototypeScenario: async (request) =>
      update((current) => {
        if (request.projectId !== current.source.projectId)
          throw new Error('Fixture scenario start belongs to a different project.');
        if (request.graphRevision !== current.editablePrototype.revision)
          throw new Error('Fixture scenario start is stale.');
        const runtime = createPrototypeRuntime(current.editablePrototype.graph, request.scenarioId);
        return {
          ...current,
          editablePrototype: {
            ...current.editablePrototype,
            mode: 'run',
            runtime: runtime.snapshot()
          }
        };
      }),
    resetPrototypeRun: async () =>
      update((current) => {
        const scenarioId = current.editablePrototype.runtime?.scenarioId;
        const runtime = createPrototypeRuntime(current.editablePrototype.graph, scenarioId);
        return {
          ...current,
          editablePrototype: {
            ...current.editablePrototype,
            mode: 'run',
            runtime: runtime.snapshot()
          }
        };
      })
  };
  const guidedActions: GuidedSetupActions = {
    selectAgent: next,
    configureTrustedAgent: async () => snapshot.agents,
    snapshot: next,
    inspectDesignSystem: async () => ({
      status: 'staged',
      packageName: '@selene/design-tokens',
      version: '1.0.0',
      exports: ['.', './tokens'],
      peerCompatibility: 'compatible',
      provenance: { provider: 'storybook-fixture', location: 'local://fixture' },
      artifactDigest: 'fixture-digest',
      fixture: 'demo-only fixture'
    }),
    setDesignSystemInputs: async () => next(),
    setDesignLanguageInputs: async () => next(),
    ingestDesignLanguage: async () => ({
      status: 'staged',
      provenance: { provider: 'storybook-fixture', location: 'local://fixture' },
      artifactDigest: 'fixture-digest',
      sectionCount: 2
    }),
    chooseDesignLanguageToImport: async () => undefined,
    refreshDesignLanguageSource: async () => ({ status: 'unavailable' }),
    chooseDesignLanguageSourceToRelink: async () => ({ status: 'cancelled' })
  };
  const githubSetup: GitHubPublishSetup =
    setup === 'offline'
      ? { status: 'offline', reason: 'OFFLINE' }
      : setup === 'unavailable'
        ? { status: 'unavailable', reason: 'TOOL_UNAVAILABLE' }
        : setup === 'recovery-required'
          ? { status: 'recovery-required', reason: 'PROCESS_ORPHANED' }
          : { status: 'available', authentication: 'authenticated', account: 'fixture-owner' };
  const workspaceActions: WorkspaceControlActions = {
    render: async () => setNotice('Rendered fixture revision cockpit-r1.'),
    markReadyForReview: async () => snapshot,
    markReadyForHandoff: async () => snapshot,
    exportHandoff: async () => '{"format":"fixture-handoff"}',
    diagnostics: {
      export: async () => ({ format: 'fixture-diagnostics/v1' }),
      delete: async () => undefined,
      consent: async () => ({ user: diagnosticsConsent }),
      setConsent: async (choice) => {
        setDiagnosticsConsent(choice);
        return { user: choice };
      },
      recovery: async () => ({ active: recoveryActive }),
      resetRecovery: async () => {
        setRecoveryActive(false);
        return { active: false };
      }
    }
  };
  const collaboration =
    hostedReview === 'offline'
      ? {
          status: 'offline' as const,
          reason: 'BACKEND_OFFLINE' as const,
          manifestDigest: '5'.repeat(64),
          retryable: true as const
        }
      : hostedReview === 'conflict'
        ? {
            status: 'conflict' as const,
            reason: 'ARTIFACT_CONFLICT' as const,
            manifestDigest: '5'.repeat(64),
            retryable: true as const
          }
        : {
            status: 'unconfigured' as const,
            reason: 'COLLABORATION_BACKEND_UNCONFIGURED' as const,
            manifestDigest: '5'.repeat(64)
          };
  const receipt:
    Extract<GeneratedCodePublishReceipt, { readonly mode: 'github-remote' }> | undefined =
    setup === 'authenticated'
      ? {
          mode: 'github-remote',
          status: 'remote-published',
          repository: 'fixture-owner/cockpit',
          bundleDigest: '1'.repeat(64),
          filePlanDigest: '2'.repeat(64),
          lockDigest: '3'.repeat(64),
          artifactDigest: '4'.repeat(64),
          treeSha: 'a'.repeat(40),
          commitSha: 'b'.repeat(40),
          ref: 'refs/heads/selene/publish/cockpit',
          pullRequestUrl: 'https://github.com/fixture-owner/cockpit/pull/42',
          immutableId: 'bundle-sha256-' + '1'.repeat(64),
          hostedReview: {
            staticReview: { status: 'not-generated', reason: 'STATIC_REVIEW_NOT_GENERATED' },
            collaboration
          }
        }
      : undefined;
  const build = loadingPreview
    ? undefined
    : (() => {
        // Resolve beside iframe.html so local and deployed Storybook bases remain same-origin.
        const url = new URL('fixtures/cockpit-orders-preview.html', window.location.href);
        if (artifactFailure !== undefined) url.searchParams.set('fixtureFailure', artifactFailure);
        return { url: url.toString(), revisionId: renderedRevisionId };
      })();
  return (
    <div className={'desktop-cockpit-story' + (compact ? ' is-compact' : '')}>
      <main
        className="designer-workspace sl-theme"
        aria-label="Fixture desktop designer"
        data-theme={theme}
        data-contrast={contrast}
        data-motion={motion}
        data-selene-preview-paint={loadingPreview ? 'loading' : previewPaint}
        data-selene-preview-paint-reason={loadingPreview ? 'build-loading' : previewPaintReason}
        data-selene-preview-paint-subreason={previewPaintSubreason}
        data-selene-preview-paint-budget-ms={fixtureReadinessTimeoutMs}
      >
        <header className="workspace-topbar">
          <div>
            <span className="brand-mark">S</span>
            <span className="workspace-product-title">Selene</span>
            <span className="project-kicker">Desktop production designer</span>
          </div>
          <div className="project-actions">
            <WorkspaceToolbar
              baseline={snapshot.baseline}
              actions={workspaceActions}
              onSnapshot={setSnapshot}
              onStatus={setNotice}
              onDeliveryBusyChange={() => undefined}
              workspaceBlocked={false}
              onExportHandoff={() => setNotice('Fixture handoff exported.')}
              onExportDiagnostics={() => setNotice('Fixture diagnostics exported.')}
              publishActive={false}
              publishStarting={false}
              publishStatus={publishStatus}
              onCancelPublish={async () =>
                setPublishStatus('Fixture publish cancellation requested.')
              }
              onGitHubSetup={async () => githubSetup}
              onPublish={async (request) =>
                setPublishStatus(
                  request.mode === 'github-remote'
                    ? 'Fixture remote publish request received.'
                    : 'Fixture local bundle validation request received.'
                )
              }
              {...(receipt ? { completedRemoteReceipt: receipt } : {})}
              onOpenCompletedReceipt={async () =>
                setNotice('Fixture receipt URL opened by the trusted host.')
              }
            />
          </div>
        </header>
        <div className="workspace-status-strip">
          <p className="workspace-notice" role="status">
            {notice}
          </p>
          <p className="workspace-notice" aria-live="polite">
            {publishStatus}
          </p>
        </div>
        <DesktopCockpit
          snapshot={snapshot}
          {...(conversationProgress === undefined ? {} : { progress: conversationProgress })}
          {...(build ? { build } : {})}
          {...(inspectSelection === 'node'
            ? { selectedPreviewTelemetry: directManipulationSelection(renderedRevisionId) }
            : {})}
          frame={frame}
          onFrameLoad={onFixtureFrameLoad}
          onFrameError={onFixtureFrameError}
          onSnapshot={setSnapshot}
          onRender={async (rendered) => {
            setRenderedRevisionId(rendered.source.revision.id);
            setNotice(`Fixture preview rendered ${rendered.source.revision.id}.`);
          }}
          onPreviewAIProposal={async (input) => {
            setRenderedRevisionId(input.candidateRevisionId);
            setNotice(`Fixture proposal previewed ${input.candidateRevisionId}.`);
          }}
          onPreviewSelectionClear={() => undefined}
          onCanvasNavigationChange={() => undefined}
          onPreviewTargetCancelChange={() => undefined}
          manualTextEditor={{
            requestManualTextEditCapability: async () => ({
              kind: 'unavailable',
              code: 'MANUAL_EDIT_UNAVAILABLE'
            }),
            applyManualTextEdit: async () => ({
              format: 'selene-design-edit-result/v1',
              kind: 'rejected',
              diagnostics: [{ code: 'MANUAL_EDIT_UNAVAILABLE' }]
            }),
            requestManualLayoutEditCapability: async (input) =>
              inspectSelection === 'node'
                ? {
                    kind: 'available',
                    capabilityId: 'fixture-layout-capability',
                    nodeId: input.nodeId,
                    revisionId: input.revisionId,
                    properties: [
                      'display',
                      'flexDirection',
                      'justifyContent',
                      'alignItems',
                      'gap',
                      'order',
                      'width',
                      'height',
                      'minWidth',
                      'minHeight',
                      'maxWidth',
                      'maxHeight'
                    ],
                    currentValues: {
                      display: 'flex',
                      flexDirection: 'row',
                      justifyContent: 'center',
                      alignItems: 'center',
                      gap: '12px',
                      width: '240px'
                    },
                    expiresAt: '2030-07-26T00:05:00.000Z'
                  }
                : {
                    kind: 'unavailable',
                    code: 'MANUAL_EDIT_UNAVAILABLE'
                  },
            applyManualLayoutEdit: async () => ({
              format: 'selene-design-edit-result/v1',
              kind: 'rejected',
              diagnostics: [{ code: 'MANUAL_EDIT_UNAVAILABLE' }]
            }),
            requestManualAppearanceEditCapability: async (input) =>
              inspectSelection === 'node'
                ? {
                    kind: 'available',
                    capabilityId: 'fixture-appearance-capability',
                    nodeId: input.nodeId,
                    revisionId: input.revisionId,
                    properties: [
                      'color',
                      'backgroundColor',
                      'fontFamily',
                      'fontSize',
                      'fontWeight',
                      'lineHeight',
                      'letterSpacing',
                      'textAlign',
                      'borderRadius',
                      'opacity',
                      'padding',
                      'margin'
                    ],
                    currentValues: {
                      color: '#182033',
                      backgroundColor: '#ffffff',
                      fontFamily: 'Inter, sans-serif',
                      fontSize: '16px',
                      fontWeight: 600,
                      lineHeight: '1.5',
                      letterSpacing: '0',
                      textAlign: 'start',
                      borderRadius: '12px',
                      opacity: 1,
                      padding: '12px 16px',
                      margin: '0'
                    },
                    expiresAt: '2030-07-26T00:05:00.000Z'
                  }
                : {
                    kind: 'unavailable',
                    code: 'MANUAL_EDIT_UNAVAILABLE'
                  },
            applyManualAppearanceEdit: async () => ({
              format: 'selene-design-edit-result/v1',
              kind: 'rejected',
              diagnostics: [{ code: 'MANUAL_EDIT_UNAVAILABLE' }]
            }),
            requestManualPositionEditCapability: async () => ({
              kind: 'unavailable',
              code: 'MANUAL_EDIT_UNAVAILABLE'
            }),
            applyManualPositionEdit: async () => ({
              format: 'selene-design-edit-result/v1',
              kind: 'rejected',
              diagnostics: [{ code: 'MANUAL_EDIT_UNAVAILABLE' }]
            }),
            snapshot: next
          }}
          actions={actions}
          guidedActions={guidedActions}
          preferences={preferences}
          onPreferencesChange={setPreferences}
          {...(selectedThread ? { initialSelectedThreadId: 'thread-total' } : {})}
          compactLayout={compact}
          {...(drawerOpen ? { initialInspectorDrawerOpen: true } : {})}
        />
      </main>
    </div>
  );
}

const meta = {
  title: 'Desktop/Cockpit',
  component: FixtureCockpit,
  parameters: { layout: 'fullscreen' }
} satisfies Meta<typeof FixtureCockpit>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Normal: Story = {};
export const FittedArtifact: Story = {};
export const Interactive: Story = {};
export const ConversationWorkspace: Story = { args: { conversation: 'mixed' } };
export const ConversationActive: Story = { args: { conversation: 'active' } };
export const ConversationEmpty: Story = { args: { conversation: 'empty' } };
export const ConversationOffline: Story = { args: { conversation: 'offline' } };
export const InspectNoSelection: Story = { args: { inspectorTab: 'inspect' } };
export const InspectSelectedNode: Story = {
  args: { inspectorTab: 'inspect', inspectSelection: 'node' }
};
export const InspectSelectedPin: Story = {
  args: { inspectorTab: 'inspect', selectedThread: true }
};
export const LoadingPreview: Story = { args: { loadingPreview: true } };
export const InvalidArtifactHeading: Story = { args: { artifactFailure: 'heading-text' } };
export const EmptyStakeholderReview: Story = {
  args: { emptyReviews: true, inspectorTab: 'reviews' }
};
export const ReviewWorkspace: Story = { args: { selectedThread: true, inspectorTab: 'reviews' } };
export const RailsCollapsed: Story = { args: { leftCollapsed: true, rightCollapsed: true } };
export const CompactMacWindow: Story = { args: { compact: true, leftCollapsed: true } };
export const LargeMacWindow: Story = { args: { navigator: 'large', inspectorTab: 'inspect' } };
export const CompactInspectorDrawerClosed: Story = {
  args: { compact: true, leftCollapsed: true }
};
export const CompactInspectorDrawerOpen: Story = {
  args: { compact: true, drawerOpen: true, leftCollapsed: true }
};
export const SelectedThread: Story = { args: { selectedThread: true } };
export const RecoveryRequired: Story = { args: { recovery: true } };
export const RunMode: Story = { args: { runMode: true } };
export const ScenarioNavigatorLarge: Story = {
  args: { inspectorTab: 'inspect', navigator: 'large' }
};
export const ScenarioNavigatorEmptyGroups: Story = {
  args: { inspectorTab: 'inspect', navigator: 'empty-groups' }
};
export const ScenarioNavigatorMissing: Story = {
  args: { inspectorTab: 'inspect', navigator: 'missing' }
};
export const ScenarioNavigatorRecovery: Story = {
  args: { inspectorTab: 'inspect', recovery: true }
};
export const SetupOffline: Story = { args: { inspectorTab: 'setup', setup: 'offline' } };
export const PublishRecoveryRequired: Story = { args: { setup: 'recovery-required' } };
export const PublishConflict: Story = { args: { hostedReview: 'conflict' } };
export const Dark: Story = { args: { theme: 'dark' } };
export const HighContrast: Story = { args: { contrast: 'more' } };
export const ReducedMotion: Story = { args: { motion: 'reduce' } };
