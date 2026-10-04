import { parsePrototypeGraph } from '@selene/core';

import type { ImmutablePublishBundle } from './designer-host-ports';
import type { GeneratedProjectFile } from './generated-project-template';
import { generatedPrototypeRuntimeSource } from './generated-prototype-runtime';
import { validatePublicPrototypeGraph } from './generated-publication-privacy';

export function generatedPrototypeFiles(
  bundle: ImmutablePublishBundle,
  entryComponent: string
): readonly GeneratedProjectFile[] {
  const graph = validatePublicPrototypeGraph(parsePrototypeGraph(bundle.prototype.graph));
  return [
    { path: 'src/.selene-prototype/runtime.ts', content: generatedPrototypeRuntimeSource },
    {
      path: 'src/.selene-prototype/vite-env.d.ts',
      content: '/// <reference types="vite/client" />\n'
    },
    {
      path: 'src/.selene-prototype/graph.ts',
      content: `import type { PrototypeGraph } from './runtime';\nexport const graph: PrototypeGraph = ${JSON.stringify(
        {
          initialNodeId: graph.initialNodeId,
          nodes: graph.nodes.map((node) => ({
            id: node.id,
            label: node.label,
            kind: node.kind,
            ...('route' in node ? { route: node.route } : {}),
            ports: node.ports
          })),
          transitions: graph.transitions,
          scenarios: graph.scenarios.map((scenario) => ({
            id: scenario.id,
            name: scenario.name,
            startNodeId: scenario.startNodeId,
            ...(scenario.initialStateId === undefined
              ? {}
              : { initialStateId: scenario.initialStateId })
          })),
          fixtures: graph.fixtures
        }
      )};\n`
    },
    {
      path: 'src/.selene-prototype/main.tsx',
      content: `import { createRoot } from 'react-dom/client';\nimport { Prototype } from './Prototype';\nimport { Review } from '../.selene-review/Review';\n${entryComponent}\n\nconst playback = new URL(window.location.href).searchParams.get('view') === 'prototype';\ncreateRoot(document.getElementById('root')!).render(playback ? <Prototype><App /></Prototype> : <Review />);\n`
    },
    { path: 'src/.selene-prototype/Prototype.tsx', content: prototypeSource }
  ];
}

const prototypeSource = String.raw`import { useEffect, useRef, useState, type ReactNode } from 'react';
import { graph } from './graph';
import { prototypeBack, startPrototype, triggerPrototype, type PrototypeSnapshot } from './runtime';

const baseUrl = new URL(import.meta.env.BASE_URL, window.location.href);
const scenarioFromUrl = () => new URL(window.location.href).searchParams.get('scenario') ?? undefined;
function initialSnapshot() {
  const scenario = scenarioFromUrl();
  let snapshot = startPrototype(graph, graph.scenarios.some(item => item.id === scenario) ? scenario : undefined);
  const path = new URLSearchParams(window.location.hash.slice(1)).getAll('step');
  if (path.length > 2000) return snapshot;
  try {
    for (const id of path) {
      const transition = graph.transitions.find(item => item.id === id);
      if (transition === undefined) return startPrototype(graph, snapshot.scenarioId);
      snapshot = triggerPrototype(graph, snapshot, transition.from.nodeId, transition.from.portId);
    }
    return snapshot;
  } catch { return startPrototype(graph, snapshot.scenarioId); }
}
export function Prototype({ children }: { readonly children: ReactNode }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [error, setError] = useState('');
  const current = useRef(snapshot);
  const pushHistory = useRef(false);
  const lastUrl = useRef(window.location.href);
  current.current = snapshot;
  const activeIds = [snapshot.activeNodeId, snapshot.activeStateId, snapshot.activeOverlayId];
  const surfaces = graph.nodes.filter(node => activeIds.includes(node.id));
  const commit = (next: PrototypeSnapshot, push = true) => { pushHistory.current = push; current.current = next; setError(''); setSnapshot(next); };
  const trigger = (nodeId: string, portId: string) => {
    try { commit(triggerPrototype(graph, current.current, nodeId, portId)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Prototype action failed'); }
  };
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('selene-runtime-state', { detail: structuredClone(snapshot) }));
    const url = new URL(baseUrl);
    url.searchParams.set('view', 'prototype');
    if (snapshot.scenarioId) url.searchParams.set('scenario', snapshot.scenarioId);
    const hash = new URLSearchParams({ screen: snapshot.activeNodeId });
    for (const id of snapshot.activePathTransitionIds) hash.append('step', id);
    url.hash = hash.toString();
    // Source listeners may use root-relative routes. Keep the published repository URL reloadable.
    if (pushHistory.current) {
      window.history.replaceState(null, '', lastUrl.current);
      window.history.pushState(null, '', url);
    }
    else window.history.replaceState(null, '', url);
    lastUrl.current = url.href;
    pushHistory.current = false;
  }, [snapshot]);
  useEffect(() => {
    const onPopState = () => commit(initialSnapshot(), false);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  useEffect(() => {
    const onAction = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const marker = event.target.closest('[data-selene-flow-node][data-selene-action-port]');
      if (marker === null) return;
      const nodeId = marker.getAttribute('data-selene-flow-node') ?? '';
      const portId = marker.getAttribute('data-selene-action-port') ?? '';
      const port = graph.nodes.find(node => node.id === nodeId)?.ports.find(item => item.id === portId);
      const expected = event.type === 'keydown' ? 'key' : event.type;
      if (port === undefined || port.trigger !== expected) return;
      if (event instanceof KeyboardEvent && (event.isComposing || !['Enter', ' '].includes(event.key))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      trigger(nodeId, portId);
    };
    const events = ['click', 'submit', 'change', 'keydown'];
    for (const event of events) document.addEventListener(event, onAction, true);
    return () => { for (const event of events) document.removeEventListener(event, onAction, true); };
  }, []);
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const node of surfaces) for (const port of node.ports) {
      if (port.trigger !== 'timeout' || port.timeoutMs === undefined) continue;
      if (!graph.transitions.some(item => item.from.nodeId === node.id && item.from.portId === port.id)) continue;
      timers.push(setTimeout(() => trigger(node.id, port.id), port.timeoutMs));
    }
    return () => { for (const timer of timers) clearTimeout(timer); };
  }, [snapshot]);
  const active = surfaces.find(node => node.id === snapshot.activeNodeId);
  return <>
    <header aria-label="Prototype playback" style={{ padding: 16, display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', fontFamily: 'system-ui' }}>
      <label>Scenario <select aria-label="Start scenario" value={snapshot.scenarioId ?? ''} onChange={event => commit(startPrototype(graph, event.currentTarget.value || undefined))}>
        <option value="">Default flow</option>{graph.scenarios.map(scenario => <option key={scenario.id} value={scenario.id}>{scenario.name}</option>)}
      </select></label>
      <button type="button" disabled={snapshot.history.length <= 1} onClick={() => commit(prototypeBack(current.current))}>Back</button>
      <button type="button" onClick={() => commit(startPrototype(graph, current.current.scenarioId))}>Restart scenario</button>
      <a href="./storybook/">Component catalog</a>
      <a href={baseUrl.href}>Review portal</a>
      <span role="status">{active?.label}{snapshot.activeStateId ? ' · ' + surfaces.find(node => node.id === snapshot.activeStateId)?.label : ''}{snapshot.activeOverlayId ? ' · ' + surfaces.find(node => node.id === snapshot.activeOverlayId)?.label : ''}</span>
    </header>
    {error ? <p role="alert">{error}</p> : null}
    <div data-prototype-node={snapshot.activeNodeId} data-prototype-state={snapshot.activeStateId} data-prototype-overlay={snapshot.activeOverlayId}>{children}</div>
    <nav aria-label="Prototype actions" style={{ padding: 16, display: 'flex', flexWrap: 'wrap', gap: 8, fontFamily: 'system-ui' }}>
      {surfaces.flatMap(node => node.ports.filter(port => port.trigger !== 'timeout').map(port => <button key={node.id + ':' + port.id} type="button" disabled={!graph.transitions.some(item => item.from.nodeId === node.id && item.from.portId === port.id)} onClick={() => trigger(node.id, port.id)}>{port.label}</button>))}
    </nav>
    <p style={{ padding: 16, fontFamily: 'system-ui', fontSize: 12 }}>Interactive prototype with simulated data.</p>
  </>;
}
`;

export function generatedPrototypePagesWorkflow(bunVersion: string): string {
  return `name: Deploy generated prototype
on:
  push:
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: selene-pages
  cancel-in-progress: true
jobs:
  build:
    if: \${{ github.event_name == 'workflow_dispatch' || github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6
        with:
          bun-version: ${bunVersion}
      - id: pages
        uses: actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d
      - run: bun install --frozen-lockfile
      - name: Build prototype and catalog
        env:
          SELENE_PAGES_BASE: \${{ steps.pages.outputs.base_path }}/
        run: |
          bun run build -- --base "$SELENE_PAGES_BASE"
          bun run build-storybook -- --output-dir dist/storybook
          touch dist/.nojekyll
      - uses: actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9
        with:
          path: dist
  deploy:
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128
`;
}
