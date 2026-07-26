import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { enterpriseScenarioFixtures, parsePrototypeGraph } from '@selene/core';

import {
  DESIGNER_API_VERSION,
  defaultWorkspaceCockpitPreferences,
  type DesignerSnapshot,
  type GeneratedCodePublishReceipt,
  type GitHubPublishSetup
} from '../../../apps/desktop/src/shared/designer-api';
import {
  DesktopCockpit,
  type DesktopCockpitActions,
  type InspectorTab
} from '../../../apps/desktop/src/renderer/src/cockpit/desktop-cockpit';
import type { GuidedSetupActions } from '../../../apps/desktop/src/renderer/src/cockpit/guided-setup-panel';
import { WorkspaceToolbar } from '../../../apps/desktop/src/renderer/src/cockpit/workspace-toolbar';
import type { WorkspaceControlActions } from '../../../apps/desktop/src/renderer/src/cockpit/workspace-controls';

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
        content: 'export default function App(){return null;}'
      }
    ],
    dependencies: ['react'],
    nodes: [],
    revision: { id: 'cockpit-r1', createdAt: '2026-07-24T19:00:00.000Z', summary: 'Story fixture' }
  },
  nodes: [],
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
        artifactId: 'cockpit-r1',
        screenId: 'orders',
        scenarioId: 'review',
        state: 'success',
        revisionId: 'cockpit-r1',
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
        artifactId: 'cockpit-r1',
        screenId: 'orders',
        scenarioId: 'review',
        state: 'success',
        revisionId: 'cockpit-r1',
        viewport: { width: 1200, height: 800 }
      }
    }
  ],
  aiChangeRequests: [],
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
  componentCatalog: { entries: [{ component: 'Button', href: '#button' }] },
  activity: ['Fixture ready.']
};

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
  readonly contrast?: 'more';
  readonly motion?: 'reduce';
  readonly theme?: 'dark';
}) {
  const [snapshot, setSnapshot] = useState(() => ({
    ...fixture,
    reviewThreads: emptyReviews ? [] : fixture.reviewThreads,
    artifactPins: emptyReviews ? [] : fixture.artifactPins,
    prototypeGraphHydration: recovery
      ? {
          state: 'recovery-required' as const,
          message: 'Fixture recovery requires explicit action.'
        }
      : fixture.prototypeGraphHydration,
    editablePrototype: {
      ...fixture.editablePrototype,
      mode: runMode ? ('run' as const) : ('edit' as const)
    }
  }));
  const [preferences, setPreferences] = useState(() => ({
    ...defaultWorkspaceCockpitPreferences,
    leftRailCollapsed: leftCollapsed,
    rightRailCollapsed: rightCollapsed,
    inspectorTab:
      inspectorTab ??
      (runMode || recovery
        ? ('flow' as const)
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
  const frame = useRef<HTMLIFrameElement>(null);
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
    selectAgent: async (id) => update((current) => ({ ...current, selectedAgentId: id })),
    requestAIChange: next,
    undoLastAIChange: next,
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
      update((current) => ({
        ...current,
        editablePrototype: { ...current.editablePrototype, mode }
      })),
    resetPrototypeRun: next
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
    : {
        url: 'data:text/html,%3Cmain%3E%3Ch1%3EOrder%20%2342%3C%2Fh1%3E%3Cp%3ECompiled%20preview%20fixture%3C%2Fp%3E%3C%2Fmain%3E',
        revisionId: 'cockpit-r1'
      };
  return (
    <div
      className={'sl-theme desktop-cockpit-story' + (compact ? ' is-compact' : '')}
      data-theme={theme}
      data-contrast={contrast}
      data-motion={motion}
    >
      <main className="designer-workspace" aria-label="Fixture desktop designer">
        <header className="workspace-topbar">
          <div>
            <span className="brand-mark">S</span>
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
          {...(build ? { build } : {})}
          frame={frame}
          onFrameLoad={() => undefined}
          onSnapshot={setSnapshot}
          onRender={async () => setNotice('Fixture preview rendered.')}
          actions={actions}
          guidedActions={guidedActions}
          preferences={preferences}
          onPreferencesChange={setPreferences}
          {...(selectedThread ? { initialSelectedThreadId: 'thread-total' } : {})}
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
export const Interactive: Story = {};
export const LoadingPreview: Story = { args: { loadingPreview: true } };
export const EmptyStakeholderReview: Story = {
  args: { emptyReviews: true, inspectorTab: 'reviews' }
};
export const ReviewWorkspace: Story = { args: { selectedThread: true, inspectorTab: 'reviews' } };
export const RailsCollapsed: Story = { args: { leftCollapsed: true, rightCollapsed: true } };
export const CompactMacWindow: Story = { args: { compact: true, leftCollapsed: true } };
export const SelectedThread: Story = { args: { selectedThread: true } };
export const RecoveryRequired: Story = { args: { recovery: true } };
export const RunMode: Story = { args: { runMode: true } };
export const SetupOffline: Story = { args: { inspectorTab: 'setup', setup: 'offline' } };
export const PublishRecoveryRequired: Story = { args: { setup: 'recovery-required' } };
export const PublishConflict: Story = { args: { hostedReview: 'conflict' } };
export const Dark: Story = { args: { theme: 'dark' } };
export const HighContrast: Story = { args: { contrast: 'more' } };
export const ReducedMotion: Story = { args: { motion: 'reduce' } };
