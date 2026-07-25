import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { enterpriseScenarioFixtures, parsePrototypeGraph } from '@selene/core';

import {
  DESIGNER_API_VERSION,
  type DesignerSnapshot
} from '../../../apps/desktop/src/shared/designer-api';
import {
  DesktopCockpit,
  type DesktopCockpitActions
} from '../../../apps/desktop/src/renderer/src/cockpit/desktop-cockpit';
import type { GuidedSetupActions } from '../../../apps/desktop/src/renderer/src/cockpit/guided-setup-panel';

const graph = parsePrototypeGraph({
  format: 'selene-prototype-graph/v1', id: 'cockpit-flow', name: 'Cockpit flow',
  project: { projectId: 'cockpit', owner: 'Selene' },
  revision: { id: 'cockpit-r1', createdAt: '2026-07-24T19:00:00.000Z', summary: 'Story fixture' },
  handoff: { status: 'draft', owner: 'Selene', summary: 'Story fixture' }, initialNodeId: 'dashboard',
  nodes: [
    { id: 'dashboard', kind: 'screen', label: 'Dashboard', route: '/', position: { x: 0, y: 0 }, ports: [{ id: 'open-orders', label: 'Open orders', trigger: 'click' }] },
    { id: 'orders', kind: 'screen', label: 'Orders', route: '/orders', position: { x: 330, y: 0 }, ports: [{ id: 'back', label: 'Back', trigger: 'click' }] }
  ],
  transitions: [{ id: 'dashboard-orders', kind: 'navigate', from: { nodeId: 'dashboard', portId: 'open-orders' }, to: { nodeId: 'orders' } }, { id: 'orders-back', kind: 'back', from: { nodeId: 'orders', portId: 'back' } }],
  scenarios: [{ id: 'review', name: 'Review order', startNodeId: 'dashboard', expectedPath: ['dashboard', 'orders'] }], fixtures: {}
});

const fixture: DesignerSnapshot = {
  apiVersion: DESIGNER_API_VERSION,
  agents: [{ id: 'fixture-agent', label: 'Fixture agent', capabilities: ['source-edit'] }], selectedAgentId: 'fixture-agent',
  source: { format: 'selene-react-workspace/v1', projectId: 'cockpit', entrypoint: 'src/App.tsx', files: [{ path: 'src/App.tsx', language: 'tsx', content: 'export default function App(){return null;}' }], dependencies: ['react'], nodes: [], revision: { id: 'cockpit-r1', createdAt: '2026-07-24T19:00:00.000Z', summary: 'Story fixture' } },
  nodes: [], selectedNodeId: undefined,
  reviewThreads: [{ id: 'thread-total', status: 'open', body: 'Verify total remains visible.', replies: [], author: 'Reviewer', createdAt: '2026-07-24T19:00:00.000Z', anchor: { x: .72, y: .58, artifactId: 'cockpit-r1', screenId: 'orders', scenarioId: 'review', state: 'success', revisionId: 'cockpit-r1', viewport: { width: 1200, height: 800 } } }],
  artifactPins: [{ id: 'thread-total', label: 'Order total', createdAt: '2026-07-24T19:00:00.000Z', anchor: { x: .72, y: .58, artifactId: 'cockpit-r1', screenId: 'orders', scenarioId: 'review', state: 'success', revisionId: 'cockpit-r1', viewport: { width: 1200, height: 800 } } }],
  aiChangeRequests: [], developerAnnotations: [], scenarios: [enterpriseScenarioFixtures[0]!], selectedScenarioId: enterpriseScenarioFixtures[0]!.id,
  baseline: { projectId: 'cockpit', readiness: 'draft', currency: 'none', changesSinceBaseline: [], approvalsStale: false },
  prototype: { flow: { format: 'selene-prototype-flow/v1', nodes: [{ id: 'dashboard', kind: 'screen', title: 'Dashboard', states: ['default'] }], connections: [], }, currentScreenId: 'dashboard' },
  editablePrototype: { graph, mode: 'edit', revision: 1 }, prototypeGraphHydration: { state: 'persisted' }, componentCatalog: { entries: [{ component: 'Button', href: '#button' }] }, activity: ['Fixture ready.']
};

function FixtureCockpit({ recovery = false, runMode = false, leftCollapsed = false, rightCollapsed = false, selectedThread = false, contrast, motion, theme }: { readonly recovery?: boolean; readonly runMode?: boolean; readonly leftCollapsed?: boolean; readonly rightCollapsed?: boolean; readonly selectedThread?: boolean; readonly contrast?: 'more'; readonly motion?: 'reduce'; readonly theme?: 'dark' }) {
  const [snapshot, setSnapshot] = useState(() => ({ ...fixture, prototypeGraphHydration: recovery ? { state: 'recovery-required' as const, message: 'Fixture recovery requires explicit action.' } : fixture.prototypeGraphHydration, editablePrototype: { ...fixture.editablePrototype, mode: runMode ? 'run' as const : 'edit' as const } }));
  const frame = useRef<HTMLIFrameElement>(null);
  const update = async (change: (current: DesignerSnapshot) => DesignerSnapshot) => { let next!: DesignerSnapshot; setSnapshot((current) => { next = change(current); return next; }); return next; };
  const next = async () => snapshot;
  const actions: DesktopCockpitActions = { selectAgent: async (id) => update((current) => ({ ...current, selectedAgentId: id })), requestAIChange: next, addArtifactPin: async (input) => update((current) => ({ ...current, artifactPins: [...current.artifactPins, { ...current.artifactPins[0]!, id: `pin-${current.artifactPins.length + 1}`, label: input.label, anchor: { ...current.artifactPins[0]!.anchor, ...input.anchor } }] })), addReviewThread: async (input) => update((current) => ({ ...current, reviewThreads: [...current.reviewThreads, { ...current.reviewThreads[0]!, id: `thread-${current.reviewThreads.length + 1}`, body: input.body, replies: [], status: 'open' }] })), resolveReviewThread: async (input) => update((current) => ({ ...current, reviewThreads: current.reviewThreads.map((thread) => thread.id === input.id ? { ...thread, status: input.resolved ? 'resolved' : 'open' } : thread) })), replyToReviewThread: async (input) => update((current) => ({ ...current, reviewThreads: current.reviewThreads.map((thread) => thread.id === input.id ? { ...thread, replies: [...thread.replies, { id: `${thread.id}-reply-${thread.replies.length + 1}`, body: input.body, author: 'Fixture reviewer', createdAt: '2026-07-24T19:00:00.000Z' }] } : thread) })), addDeveloperAnnotation: next, savePrototypeGraph: async (nextGraph) => update((current) => ({ ...current, editablePrototype: { ...current.editablePrototype, graph: nextGraph, revision: current.editablePrototype.revision + 1 } })), retryPrototypeGraphHydration: next, recoverPrototypeGraphFromFixture: next, setPrototypeMode: async (mode) => update((current) => ({ ...current, editablePrototype: { ...current.editablePrototype, mode } })), resetPrototypeRun: next };
  const guidedActions: GuidedSetupActions = { selectAgent: next, configureTrustedAgent: async () => snapshot.agents, snapshot: next, inspectDesignSystem: async () => ({ status: 'staged', packageName: '@selene/design-tokens', version: '1.0.0', exports: ['.', './tokens'], peerCompatibility: 'compatible', provenance: { provider: 'storybook-fixture', location: 'local://fixture' }, artifactDigest: 'fixture-digest', fixture: 'demo-only fixture' }), ingestDesignLanguage: async () => ({ status: 'staged', provenance: { provider: 'storybook-fixture', location: 'local://fixture' }, artifactDigest: 'fixture-digest', sectionCount: 2 }), createProject: async () => ({ receipt: { projectId: 'cockpit', name: 'Cockpit', origin: 'template', revisionId: 'cockpit-r1' }, snapshot }), importProject: async () => ({ receipt: { projectId: 'cockpit', name: 'Cockpit', origin: 'imported', revisionId: 'cockpit-r1' }, snapshot }) };
  return <div className="sl-theme" data-theme={theme} data-contrast={contrast} data-motion={motion}><DesktopCockpit snapshot={snapshot} build={{ url: 'data:text/html,%3Cmain%3E%3Ch1%3EOrder%20%2342%3C/h1%3E%3Cp%3ECompiled%20preview%20fixture%3C/p%3E%3C/main%3E', revisionId: 'cockpit-r1' }} frame={frame} onFrameLoad={() => undefined} onSnapshot={setSnapshot} onRender={async () => undefined} onProjectOpened={async (opened) => setSnapshot(opened.snapshot)} actions={actions} guidedActions={guidedActions} initialLeftCollapsed={leftCollapsed} initialRightCollapsed={rightCollapsed} initialInspectorTab={runMode || recovery ? 'flow' : selectedThread ? 'reviews' : 'inspect'} initialSelectedThreadId={selectedThread ? 'thread-total' : undefined} /></div>;
}

const meta = { title: 'Desktop/Cockpit', component: FixtureCockpit, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof FixtureCockpit>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Normal: Story = {};
export const Interactive: Story = {};
export const RailsCollapsed: Story = { args: { leftCollapsed: true, rightCollapsed: true } };
export const SelectedThread: Story = { args: { selectedThread: true } };
export const RecoveryRequired: Story = { args: { recovery: true } };
export const RunMode: Story = { args: { runMode: true } };
export const Dark: Story = { args: { theme: 'dark' } };
export const HighContrast: Story = { args: { contrast: 'more' } };
export const ReducedMotion: Story = { args: { motion: 'reduce' } };
