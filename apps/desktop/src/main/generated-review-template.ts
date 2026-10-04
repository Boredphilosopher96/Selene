import { createHash } from 'node:crypto';

import { parseSnapshot } from '@selene/collaboration';
import {
  createDeveloperRecheckManifest,
  createGeneratedDesignHandoff,
  parsePrototypeGraph,
  serializeCanonicalData,
  validateReactBindingManifest,
  type DesignBaselineState
} from '@selene/core';

import type { ImmutablePublishBundle } from './designer-host-ports';
import type { GeneratedProjectFile } from './generated-project-template';
import type { GeneratedProjectToolchainManifest } from './generated-project-toolchain';
import { deriveLocalCatalogComponents } from './local-component-catalog';
import {
  containsPrivatePublicationMetadata,
  validatePublicPrototypeGraph
} from './generated-publication-privacy';

// Publication excludes private discussion provenance; declared project and graph ownership is retained.
function publicText(value: string): string {
  return containsPrivatePublicationMetadata(value) ? '[Private metadata omitted]' : value;
}

export function generatedPublicBaseline(bundle: ImmutablePublishBundle): DesignBaselineState {
  const state = parseSnapshot(bundle.collaborationSnapshot).designReviewState;
  if (state === undefined)
    return {
      projectId: bundle.projectId,
      readiness: 'draft',
      currency: 'none',
      approvalsStale: false,
      changesSinceBaseline: []
    };
  return {
    projectId: state.projectId,
    readiness: state.readiness,
    currency: state.currency,
    approvalsStale: state.approvalsStale,
    ...(state.baseline === undefined
      ? {}
      : { baseline: { ...state.baseline, createdBy: 'Published project' } }),
    changesSinceBaseline: state.changesSinceBaseline.map((change) => ({
      ...change,
      reason: publicText(change.reason),
      affected: { ...change.affected, routePaths: change.affected.routePaths.map(publicText) },
      evidence: change.evidence.map((evidence) => ({
        description: publicText(evidence.description),
        ...(evidence.checksum === undefined ? {} : { checksum: evidence.checksum })
      })),
      provenance:
        change.provenance.kind === 'actor'
          ? { kind: 'actor', actorId: 'Published project' }
          : {
              kind: 'agent',
              agentId: 'Published agent',
              promptDigest: change.provenance.promptDigest
            }
    }))
  };
}

export function generatedReviewFiles(
  bundle: ImmutablePublishBundle,
  toolchain: GeneratedProjectToolchainManifest
): readonly GeneratedProjectFile[] {
  const graph = validatePublicPrototypeGraph(parsePrototypeGraph(bundle.prototype.graph));
  const components = deriveLocalCatalogComponents(bundle.source);
  const baseline = generatedPublicBaseline(bundle);
  const compiled = bundle.compiledArtifact;
  if (compiled !== undefined) {
    validateReactBindingManifest(compiled.reactBinding, {
      graph,
      graphRevision: bundle.graphRevision,
      workspace: bundle.source,
      compilerEvidence: compiled.compilerEvidence
    });
    const paths = new Set(bundle.source.files.map((file) => file.path));
    if (
      compiled.compilerEvidence.reachableFiles.some((file) => !paths.has(file)) ||
      compiled.build.receipt?.reachableFiles.some((file) => !paths.has(file)) ||
      publicText(bundle.source.revision.summary) !== bundle.source.revision.summary
    )
      throw new Error('Public compiler evidence contains private metadata.');
  }
  const draft: DesignBaselineState = {
    projectId: bundle.projectId,
    readiness: 'draft',
    currency: 'none',
    approvalsStale: false,
    changesSinceBaseline: []
  };
  const handoff = createGeneratedDesignHandoff({
    workspace:
      compiled === undefined
        ? {
            ...bundle.source,
            revision: { ...bundle.source.revision, summary: 'Published React source' }
          }
        : bundle.source,
    ...(compiled === undefined ? {} : { reactBinding: compiled.reactBinding }),
    baseline: compiled === undefined ? draft : baseline,
    comments: [],
    developerDirections: [
      'Install the downloaded package.json and bun.lock with the exact Bun version. Recheck every listed baseline delta.'
    ],
    scenarios: bundle.scenarios,
    reproducibility: {
      ...bundle.packageProvenance,
      lockfile: { path: 'bun.lock', checksum: bundle.packageProvenance.lockfile.checksum }
    },
    project: {
      id: bundle.projectId,
      owner: graph.project.owner,
      status: compiled === undefined ? 'draft' : baseline.readiness,
      routes: graph.nodes.flatMap((node) => ('route' in node ? [node.route] : [])),
      storybook: components.map((component) => ({
        component: component.id,
        url: `./storybook/?path=/story/${encodeURIComponent(component.storyId)}`
      })),
      storyReferences: components.map((component) => ({
        format: 'selene-canonical-story-reference/v1',
        projectId: bundle.projectId,
        catalogRevision: `catalog-${bundle.bundleDigest.slice(0, 24)}`,
        buildId: `storybook-${bundle.bundleDigest.slice(0, 24)}`,
        componentId: component.id,
        storyId: component.storyId
      })),
      acceptanceCriteria: [
        'Reproduce declared scenarios and review the source, graph, catalog and baseline deltas.'
      ]
    },
    agentInstructions: [
      compiled === undefined
        ? 'Treat this as a draft export: compiler binding and independent acceptance are not included.'
        : 'Compiler binding is included for this exact source and graph. Independent acceptance and deployment remain separate checks.'
    ]
  });
  const seed = {
    format: 'selene-public-review-seed/v1',
    projectId: bundle.projectId,
    immutableId: bundle.immutableId,
    bundleDigest: bundle.bundleDigest,
    sourceRevisionId: bundle.sourceRevisionId,
    graphRevision: bundle.graphRevision,
    graphRevisionId: graph.revision.id,
    sourceSha256: createHash('sha256')
      .update(serializeCanonicalData(JSON.parse(handoff.source)))
      .digest('hex'),
    graphSha256:
      compiled === undefined
        ? null
        : createHash('sha256').update(serializeCanonicalData(graph)).digest('hex'),
    compilation:
      compiled === undefined
        ? null
        : { receipt: compiled.build.receipt, compilerEvidence: compiled.compilerEvidence },
    canonicalGraph: compiled === undefined ? null : graph,
    baseline,
    handoff: { ...handoff, baseline: createDeveloperRecheckManifest(baseline) },
    toolchain,
    inputPackageProvenance: {
      ...bundle.packageProvenance,
      lockfile: { checksum: bundle.packageProvenance.lockfile.checksum }
    },
    graph: {
      id: graph.id,
      name: publicText(graph.name),
      initialNodeId: graph.initialNodeId,
      nodes: graph.nodes.map((node) => ({
        id: node.id,
        label: publicText(node.label),
        kind: node.kind,
        ...('route' in node ? { route: node.route } : {}),
        ports: node.ports
      })),
      transitions: graph.transitions,
      scenarios: graph.scenarios.map((scenario) => ({
        id: scenario.id,
        name: publicText(scenario.name),
        startNodeId: scenario.startNodeId,
        ...('initialStateId' in scenario ? { initialStateId: scenario.initialStateId } : {}),
        expectedPath: scenario.expectedPath
      }))
    }
  };
  return [
    { path: 'selene/review-seed.json', content: `${JSON.stringify(seed, null, 2)}\n` },
    { path: 'scripts/selene-review-artifacts.mjs', content: reviewArtifactBuilder },
    { path: 'src/.selene-review/Review.tsx', content: reviewSource }
  ];
}

const reviewArtifactBuilder = String.raw`import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const seed = JSON.parse(await readFile('selene/review-seed.json', 'utf8'));
if (Bun.version !== seed.toolchain.bunVersion) throw new Error('Generated build requires Bun ' + seed.toolchain.bunVersion + '; current runtime is ' + Bun.version);
const packageText = await readFile('package.json', 'utf8');
const lockText = await readFile('bun.lock', 'utf8');
const packageJson = JSON.parse(packageText);
const sha = text => createHash('sha256').update(text).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
let commit = process.env.GITHUB_SHA;
if (!/^[a-f0-9]{40}$/.test(commit ?? '')) {
  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    commit = gitRoot === process.cwd() ? execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() : undefined;
  }
  catch { commit = undefined; }
}
if (!/^[a-f0-9]{40}$/.test(commit ?? '')) commit = null;
const reproducibility = {
  packageManager: packageJson.packageManager,
  lockfile: { path: 'bun.lock', checksum: sha(lockText) },
  packages: Object.entries(packageJson.devDependencies).map(([name, version]) => ({ name, version })),
  dependencies: Object.entries(packageJson.dependencies).map(([name, version]) => ({ name, version }))
};
const handoff = { ...seed.handoff, reproducibility };
await rm('public/review', { recursive: true, force: true });
await mkdir('public/review/artifacts', { recursive: true });
const artifacts = [];
async function artifact(kind, extension, content, mediaType) {
  const digest = sha(content);
  const file = 'artifacts/' + kind + '-' + digest + '.' + extension;
  await writeFile('public/review/' + file, content);
  artifacts.push({ kind, href: 'review/' + file, sha256: digest, bytes: Buffer.byteLength(content), mediaType });
}
await artifact('handoff', 'json', json(handoff), 'application/json');
await artifact('package', 'json', packageText, 'application/json');
await artifact('lockfile', 'lock', lockText, 'text/plain');
await artifact('prototype', 'json', json(seed.canonicalGraph === null ? seed.graph : { format: 'selene-publication-prototype/v1', projectId: seed.projectId, graphRevision: seed.graphRevision, graph: seed.canonicalGraph }), 'application/json');
await artifact('catalog', 'json', await readFile('selene/component-catalog.json', 'utf8'), 'application/json');
await artifact('provenance', 'json', json({ format: 'selene-generated-package-provenance/v1', bundleDigest: seed.bundleDigest, sourceRevisionId: seed.sourceRevisionId, graphRevision: seed.graphRevision, commit, toolchain: seed.toolchain, reproducibility, sourceInputs: seed.inputPackageProvenance }), 'application/json');
const manifest = { ...seed, handoff: undefined, inputPackageProvenance: undefined, canonicalGraph: undefined,
  format: 'selene-public-review-manifest/v1',
  build: { format: 'selene-static-build-receipt/v1', commit, bundleDigest: seed.bundleDigest, sourceRevisionId: seed.sourceRevisionId, graphRevision: seed.graphRevision, lockfileSha256: sha(lockText), bunVersion: Bun.version },
  handoffStatus: seed.compilation === null ? 'draft' : 'compiler-bound', bindingIncluded: seed.compilation !== null, independentAcceptance: false,
  publicProjection: 'Private conversation bodies, discussion author identities and host provenance locations are excluded. Declared project and graph ownership is retained.', artifacts };
const manifestText = json(manifest);
await writeFile('public/review/manifest.json', manifestText);
await writeFile('public/review/receipt.json', json({ format: 'selene-public-review-receipt/v1', manifestSha256: sha(manifestText), bundleDigest: seed.bundleDigest }));
`;

const reviewSource = String.raw`import { useEffect, useState } from 'react';
type ReviewManifest = {
  projectId: string; immutableId: string; bundleDigest: string; sourceRevisionId: string; graphRevision: number; graphRevisionId: string;
  build: { commit: string | null; lockfileSha256: string; bunVersion: string };
  baseline: { readiness: string; currency: string; approvalsStale: boolean; baseline?: { id: string; revision: { id: string } }; changesSinceBaseline: { id: string; kind: string; reason: string; beforeRevision: { id: string }; currentRevision: { id: string }; affected: { screenIds: string[]; routePaths: string[]; scenarioIds: string[]; componentIds: string[]; stableNodeIds: string[] }; evidence: { description: string }[] }[] };
  graph: { initialNodeId: string; nodes: { id: string; label: string; kind: string; route?: string; ports: { id: string; label: string; trigger: string }[] }[]; transitions: { id: string; kind: string; from: { nodeId: string; portId: string }; to?: { nodeId: string } }[]; scenarios: { id: string; name: string; startNodeId: string; initialStateId?: string; expectedPath: string[] }[] };
  artifacts: { kind: string; href: string; sha256: string; bytes: number }[];
  bindingIncluded: boolean; handoffStatus: 'draft' | 'compiler-bound';
};
const base = import.meta.env.BASE_URL;
const prototypeUrl = (scenario?: string) => base + '?view=prototype' + (scenario ? '&scenario=' + encodeURIComponent(scenario) : '');
export function Review() {
  const [manifest, setManifest] = useState<ReviewManifest>();
  const [error, setError] = useState('');
  useEffect(() => { const controller = new AbortController(); fetch(base + 'review/manifest.json', { signal: controller.signal }).then(response => { if (!response.ok) throw new Error('Build the project to generate its review artifacts.'); return response.json(); }).then(setManifest).catch(failure => { if (!controller.signal.aborted) setError(failure.message); }); return () => controller.abort(); }, []);
  if (error) return <main><h1>Review artifacts unavailable</h1><p role="alert">{error}</p><a href={prototypeUrl()}>Open prototype</a></main>;
  if (!manifest) return <p role="status">Loading publication...</p>;
  const baseline = manifest.baseline;
  return <main className="selene-review">
    <style>{'.selene-review{max-width:1100px;margin:0 auto;padding:32px 24px;font:16px/1.55 system-ui;color:#182329}.selene-review h1{font-size:36px;margin:10px 0}.selene-review h2{font-size:24px;margin-top:32px}.selene-review nav{display:flex;gap:16px;flex-wrap:wrap;margin:20px 0}.selene-review a{color:#075f78}.selene-review code{overflow-wrap:anywhere;font-size:13px}.selene-review dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 24px}.selene-review dd{margin:0;overflow-wrap:anywhere}.selene-review table{width:100%;border-collapse:collapse}.selene-review th,.selene-review td{text-align:left;padding:10px;border-bottom:1px solid #dce4e6;vertical-align:top;overflow-wrap:anywhere}.selene-review .scroll{overflow-x:auto}.selene-review article{border:1px solid #dce4e6;padding:16px;margin:12px 0;border-radius:12px}.selene-review .notice{background:#eef6f6;padding:16px;border-radius:12px}@media(max-width:600px){.selene-review{padding:20px 14px}.selene-review dl{grid-template-columns:1fr;gap:4px}.selene-review dd{margin-bottom:10px}}'}</style>
    <p>Selene project review</p><h1>{manifest.projectId}</h1>
    <p className="notice">Static review with simulated prototype data. Download status: {manifest.handoffStatus}. {manifest.bindingIncluded ? 'Compiler binding is included for this exact source and graph.' : 'Compiler binding is not included.'} Independent acceptance is not included.</p>
    <nav aria-label="Project review"><a href={prototypeUrl()}>Explore prototype</a><a href={base + 'storybook/'}>Component catalog / Storybook</a><a href={base + 'review/manifest.json'}>Publication manifest</a><a href={base + 'review/receipt.json'}>Manifest checksum receipt</a></nav>
    <h2>Exact revision</h2><dl><dt>Source revision</dt><dd><code>{manifest.sourceRevisionId}</code></dd><dt>Prototype revision</dt><dd>{manifest.graphRevision} / <code>{manifest.graphRevisionId}</code></dd><dt>Build commit</dt><dd><code>{manifest.build.commit ?? 'Unavailable for this local build'}</code></dd><dt>Bundle identity</dt><dd><code>{manifest.immutableId}</code></dd><dt>Bundle SHA-256</dt><dd><code>{manifest.bundleDigest}</code></dd><dt>Bun</dt><dd>{manifest.build.bunVersion}</dd><dt>Generated lock SHA-256</dt><dd><code>{manifest.build.lockfileSha256}</code></dd></dl>
    <h2>Changes since baseline</h2><p>Readiness: {baseline.readiness} / Currency: {baseline.currency} / Approvals: {baseline.approvalsStale ? 'stale; reapproval required' : baseline.currency === 'none' ? 'no baseline recorded' : 'no stale approvals recorded'}</p>
    {baseline.baseline ? <p>Baseline <code>{baseline.baseline.id}</code> pins <code>{baseline.baseline.revision.id}</code>.</p> : <p>No baseline is recorded in this bundle.</p>}
    {baseline.changesSinceBaseline.length === 0 ? <p>No recorded baseline deltas.</p> : baseline.changesSinceBaseline.map(change => <article key={change.id}><h3>{change.kind}: {change.reason}</h3><p><code>{change.beforeRevision.id}</code> to <code>{change.currentRevision.id}</code></p><p>Change <code>{change.id}</code></p><p>Affected: {[...change.affected.screenIds, ...change.affected.routePaths, ...change.affected.scenarioIds, ...change.affected.componentIds, ...change.affected.stableNodeIds].join(', ')}</p>{change.evidence.map((item,index) => <p key={index}>{item.description}</p>)}</article>)}
    <h2>Scenarios</h2>{manifest.graph.scenarios.map(scenario => <article key={scenario.id}><h3><a href={prototypeUrl(scenario.id)}>{scenario.name}</a></h3><p>Start: {scenario.startNodeId}{scenario.initialStateId ? ' / State: ' + scenario.initialStateId : ''}</p><p>Expected path: {scenario.expectedPath.join(' to ')}</p></article>)}
    <h2>Prototype graph</h2><p>Default start: <code>{manifest.graph.initialNodeId}</code></p><div className="scroll"><table><thead><tr><th>Surface</th><th>Kind / route</th><th>Actions</th></tr></thead><tbody>{manifest.graph.nodes.map(node => <tr key={node.id}><td>{node.label}<br/><code>{node.id}</code></td><td>{node.kind}{node.route ? ' / ' + node.route : ''}</td><td>{node.ports.map(port => <div key={port.id}>{port.label} / {port.trigger}</div>)}</td></tr>)}</tbody></table></div>
    <div className="scroll"><table><thead><tr><th>Transition</th><th>From</th><th>Behavior / target</th></tr></thead><tbody>{manifest.graph.transitions.map(transition => <tr key={transition.id}><td><code>{transition.id}</code></td><td>{transition.from.nodeId} / {transition.from.portId}</td><td>{transition.kind}{transition.to ? ' to ' + transition.to.nodeId : ''}</td></tr>)}</tbody></table></div>
    <h2>Immutable downloads</h2><p>Each file URL includes its SHA-256. The handoff contains canonical React source and stable nodes; package and lock downloads reproduce the generated dependencies. Source input provenance is separate from the generated lock.</p>{manifest.artifacts.map(artifact => <article key={artifact.kind}><a download href={base + artifact.href}>Download {artifact.kind}</a><p>{artifact.bytes} bytes / SHA-256 <code>{artifact.sha256}</code></p></article>)}
    <p>Private conversation bodies, discussion author identities and host provenance locations are excluded. Declared project and graph ownership is retained. This portal is a read-only export.</p>
  </main>;
}
`;
