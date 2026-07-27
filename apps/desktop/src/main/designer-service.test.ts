import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  createCompilerRenderedInstanceDigest,
  enterpriseScenarioFixtures,
  migrateDesignRevisionV1,
  serializeCanonicalData,
  type ReactBuildArtifact,
  type ReactBindingManifest
} from '@selene/core';
import type { DesignInputPort } from '@selene/design-inputs';
import { parseSnapshot } from '@selene/collaboration';

import {
  ConfiguredProcessDesignerAdapter,
  loadTrustedAgentConfiguration,
  MAX_TRUSTED_AGENT_CONFIG_BYTES,
  parseAgentSourcePatch,
  parseTrustedAgentConfiguration,
  TRUSTED_AGENT_CONFIG_VERSION
} from './agent-config';
import { createEmbeddedBuildMetadataPort } from './build-metadata';
import {
  DesktopDesignerApplicationService,
  DeterministicDesignerFixtureAdapter,
  InMemoryDesignLanguageGuidancePort,
  type DesignLanguageGuidancePort,
  type DesignerProjectStatePort,
  type DesignerAgentAdapter
} from './designer-service';
import { digestReactBuildOutput } from './react-build-output-digest';
import type { CrashDiagnosticSink } from './crash-diagnostics';
import { desktopDesignInputRuntime } from './design-input-runtime';
import { createLocalCatalogFixturePort, DesktopDesignSystemIntake } from './designer-setup-host';
import type { PersistedPrototypeGraph, PrototypeGraphPersistencePort } from './designer-host-ports';
import {
  DurableDesignLanguageGuidancePort,
  LocalProjectLifecycleService,
  createInMemoryProjectLifecycleStorage,
  type LocalDesignerState,
  type ProjectLifecycleStoragePort
} from './project-lifecycle';

const configuredFixture = fileURLToPath(
  new URL('../../e2e/designer-agent.fixture.mjs', import.meta.url)
);
const target = {
  x: 0.25,
  y: 0.5,
  width: 0.2,
  height: 0.1,
  viewport: { width: 1100, height: 700 }
};

async function within<T>(promise: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('operation did not settle before its deadline')),
      milliseconds
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function configuredAdapter(
  mode: 'cancel' | 'failure' | 'context'
): ConfiguredProcessDesignerAdapter {
  const configuration = parseTrustedAgentConfiguration({
    version: 'selene-desktop-agents/v1',
    agents: [
      {
        id: `configured-${mode}`,
        label: `Configured ${mode}`,
        command: process.execPath,
        args: [configuredFixture, mode],
        workspaceRoot: process.cwd(),
        readOnly: true,
        capabilityGrants: ['react.revise'],
        designOperation: 'react.revise',
        requestTimeoutMs: 10_000
      }
    ]
  });
  const agent = configuration.agents[0];
  if (agent === undefined) throw new Error('configured fixture was not created');
  return new ConfiguredProcessDesignerAdapter(agent);
}

const fixtureDiagnostics: CrashDiagnosticSink = Object.freeze({
  async capture() {}
});

function fixtureGraphPersistence(): PrototypeGraphPersistencePort {
  const saved = new Map<string, PersistedPrototypeGraph>();
  return {
    async read(projectId) {
      const graph = saved.get(projectId);
      return graph === undefined ? undefined : structuredClone(graph);
    },
    async compareAndSwap(projectId, expectedRevision, graph) {
      const current = saved.get(projectId);
      if ((current?.revision ?? 0) !== expectedRevision)
        throw new Error('Fixture graph revision changed unexpectedly.');
      const next = { revision: expectedRevision + 1, graph: structuredClone(graph) };
      saved.set(projectId, next);
      return structuredClone(next);
    },
    async recoverFromFixture(projectId, graph) {
      const next = { revision: 1, graph: structuredClone(graph) };
      saved.set(projectId, next);
      return {
        saved: structuredClone(next),
        receipt: {
          recoveryId: 'graph-recovery-00000000-0000-4000-8000-000000000000',
          originalBytes: 0,
          capturedBytes: 0,
          capturedSha256: '0'.repeat(64)
        }
      };
    }
  };
}

function recordingGraphPersistence(): {
  readonly port: PrototypeGraphPersistencePort;
  readonly saves: () => readonly {
    readonly projectId: string;
    readonly graph: PersistedPrototypeGraph['graph'];
  }[];
} {
  const saves: { projectId: string; graph: PersistedPrototypeGraph['graph'] }[] = [];
  const port = fixtureGraphPersistence();
  return {
    port: {
      ...port,
      async compareAndSwap(projectId, expectedRevision, graph) {
        saves.push({ projectId, graph: structuredClone(graph) });
        return port.compareAndSwap(projectId, expectedRevision, graph);
      }
    },
    saves: () => structuredClone(saves)
  };
}

function fixtureDesignSystemIntake(
  port: DesignInputPort = createLocalCatalogFixturePort(),
  supports: (input: { readonly name: string; readonly version: string }) => boolean = (input) =>
    input.name === '@selene/design-tokens' && input.version === '1.0.0'
): DesktopDesignSystemIntake {
  return new DesktopDesignSystemIntake(port, desktopDesignInputRuntime, {
    requiredPeerDependencies: { react: '^19.0.0' },
    provider: {
      label: 'designer-service local catalog fixture',
      fixture: 'demo-only-local-catalog',
      supports
    }
  });
}

function catalogFixturePort(options: { readonly rotateDigest?: boolean } = {}): DesignInputPort {
  let resolution = 0;
  return {
    async resolvePackage(_context, input) {
      if (!['@selene/design-tokens', '@selene/commerce-tokens'].includes(input.name))
        throw new Error('Fixture catalog has no matching package.');
      const suffix = options.rotateDigest ? `-${++resolution}` : '';
      const markdown = '# Design\n\n## Principles\n\nUse semantic tokens.';
      return {
        packageJson: {
          name: input.name,
          version: input.version,
          peerDependencies: { react: '^19.0.0' },
          exports: { '.': './dist/index.js', './tokens': './dist/tokens.json' },
          selene: {
            designSystem: {
              schemaVersion: '1',
              tokenFiles: ['./dist/tokens.json'],
              components: [{ name: 'Button', exportName: 'Button', entrypoint: '.' }],
              designLanguagePath: './DESIGN.md'
            }
          }
        },
        files: [
          { path: './dist/index.js', content: `export const Button = '${input.name}${suffix}';` },
          { path: './dist/tokens.json', content: '{"color":"blue"}' },
          { path: './DESIGN.md', content: markdown }
        ],
        provenance: {
          provider: 'designer-service-fixture',
          location: `npm:${input.name}@${input.version}`
        }
      };
    },
    async readDesignLanguage() {
      return {
        markdown: '# Design\n\n## Principles\n\nUse semantic tokens.',
        provenance: { provider: 'designer-service-fixture', location: 'local://fixture/DESIGN.md' }
      };
    },
    async sha256(_context, value) {
      return createHash('sha256').update(value).digest('hex');
    }
  };
}

function fixtureProjectState(initial?: LocalDesignerState) {
  let stored = initial === undefined ? undefined : structuredClone(initial);
  const guidance = new InMemoryDesignLanguageGuidancePort();
  let guidanceDigests: readonly string[] = [];
  const port: DesignerProjectStatePort = {
    async designerState() {
      return stored === undefined ? undefined : structuredClone(stored);
    },
    async saveDesignerState(_projectId, state) {
      stored = structuredClone(state);
    },
    async saveDesignerStateWithGuidance(projectId, state, entries) {
      const nextDigests = entries.map((entry) => entry.digest);
      if (entries.length > 0)
        await guidance.storeBatch(
          projectId,
          entries.map((entry) => ({
            artifactDigest: entry.digest,
            markdown: entry.markdown,
            ...(entry.sourceLocator === undefined ? {} : { sourceLocator: entry.sourceLocator })
          }))
        );
      const removed = guidanceDigests.filter((digest) => !nextDigests.includes(digest));
      if (removed.length > 0) await guidance.removeBatch(projectId, removed);
      guidanceDigests = Object.freeze([...nextDigests]);
      stored = structuredClone(state);
    },
    async commitDesignerRevision(_projectId, _workspace, state) {
      stored = structuredClone(state);
    }
  };
  return {
    port,
    guidance,
    read: () => (stored === undefined ? undefined : structuredClone(stored))
  };
}

function countingStorage() {
  const storage = createInMemoryProjectLifecycleStorage();
  let commits = 0;
  let failure: Error | undefined;
  const wrapped: ProjectLifecycleStoragePort = {
    ...storage,
    async commit(id, value) {
      if (failure !== undefined) {
        const error = failure;
        failure = undefined;
        throw error;
      }
      await storage.commit(id, value);
      commits += 1;
    }
  };
  return {
    storage: wrapped,
    commits: () => commits,
    failNextCommit: (error = new Error('fixture lifecycle commit failed')) => {
      failure = error;
    }
  };
}

function fixtureService(
  options: {
    readonly diagnostics?: CrashDiagnosticSink;
    readonly projectState?: DesignerProjectStatePort;
    readonly intake?: DesktopDesignSystemIntake;
    readonly guidance?: DesignLanguageGuidancePort;
    readonly graphPersistence?: PrototypeGraphPersistencePort;
    readonly authorId?: string;
  } = {}
): DesktopDesignerApplicationService {
  return new DesktopDesignerApplicationService(
    createEmbeddedBuildMetadataPort(),
    options.diagnostics ?? fixtureDiagnostics,
    options.graphPersistence ?? fixtureGraphPersistence(),
    options.intake ?? fixtureDesignSystemIntake(),
    options.authorId ?? 'local-designer-11111111-1111-4111-8111-111111111111',
    undefined,
    undefined,
    options.projectState,
    undefined,
    undefined,
    options.guidance ?? new InMemoryDesignLanguageGuidancePort()
  );
}

function freshWorkspace() {
  const service = fixtureService();
  service.registerAgent(new DeterministicDesignerFixtureAdapter());
  return service.snapshot().source;
}

function hostBindingState(service: DesktopDesignerApplicationService): {
  reactBinding?: ReactBindingManifest;
  pendingReactBinding?: ReactBindingManifest;
  pendingProjectStateMigration?: boolean;
} {
  return service as unknown as {
    reactBinding?: ReactBindingManifest;
    pendingReactBinding?: ReactBindingManifest;
    pendingProjectStateMigration?: boolean;
  };
}

function inertBindingFor(
  snapshot: ReturnType<DesktopDesignerApplicationService['snapshot']>
): ReactBindingManifest {
  return {
    format: 'selene-react-binding-manifest/v1',
    schemaVersion: '2.0',
    projectId: snapshot.source.projectId,
    sourceRevisionId: snapshot.source.revision.id,
    graphId: snapshot.editablePrototype.graph.id,
    graphRevision: snapshot.editablePrototype.revision,
    nodeBindings: [],
    actionBindings: []
  };
}

function buildArtifact(
  snapshot: ReturnType<DesktopDesignerApplicationService['snapshot']>
): ReactBuildArtifact {
  const code = 'export default function Preview(){return null;}';
  const css = '';
  const sourceMap = '';
  return {
    revisionId: snapshot.source.revision.id,
    code,
    css,
    sourceMap,
    diagnostics: [],
    receipt: {
      format: 'selene-react-build-receipt/v1',
      compilerIdentity: 'selene-vite-react-compiler/v1',
      projectId: snapshot.source.projectId,
      sourceRevisionId: snapshot.source.revision.id,
      sourceSha256: createHash('sha256')
        .update(serializeCanonicalData(snapshot.source))
        .digest('hex'),
      outputSha256: digestReactBuildOutput({ code, css, sourceMap }),
      reachableFiles: [snapshot.source.entrypoint]
    }
  };
}

function matchedBindingWorkspace(
  snapshot: ReturnType<DesktopDesignerApplicationService['snapshot']>
) {
  const graph = snapshot.editablePrototype.graph;
  const workspace = {
    ...snapshot.source,
    files: [
      {
        path: 'src/App.tsx',
        language: 'tsx' as const,
        content: `export default function App(){return <main>${graph.nodes.map((node) => `<section data-selene-node-id="source:${node.id}">${node.ports.map((port) => `<button data-selene-node-id="source:${node.id}" data-selene-flow-node="${node.id}" data-selene-action-port="${port.id}">${port.label}</button>`).join('')}</section>`).join('')}</main>;}`
      }
    ],
    nodes: graph.nodes.map((node) => ({
      nodeId: `source:${node.id}`,
      path: 'src/App.tsx',
      exportName: 'default'
    }))
  };
  return {
    workspace,
    binding: {
      format: 'selene-react-binding-manifest/v1',
      schemaVersion: '2.0',
      projectId: workspace.projectId,
      sourceRevisionId: workspace.revision.id,
      graphId: graph.id,
      graphRevision: snapshot.editablePrototype.revision,
      nodeBindings: graph.nodes.map((node) => ({
        graphNodeId: node.id,
        sourceNodeId: `source:${node.id}`
      })),
      actionBindings: graph.nodes.flatMap((node) =>
        node.ports.map((port) => ({
          graphNodeId: node.id,
          portId: port.id,
          sourceNodeId: `source:${node.id}`
        }))
      )
    } satisfies ReactBindingManifest
  };
}

describe('desktop designer application service', () => {
  it('reports unavailable instead of silently activating a receipt without an inert binding', async () => {
    const service = fixtureService();
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    await expect(
      service.activateReactBindingReceipt(buildArtifact(service.snapshot()))
    ).resolves.toEqual({
      status: 'unavailable'
    });
    expect(service.snapshot().activity).toContain(
      'No persisted React binding is available for this compiled workspace.'
    );
  });
  it('keeps a matched persisted binding inert until a fresh host preview receipt arrives', async () => {
    const state = fixtureProjectState();
    const seed = fixtureService({ projectState: state.port });
    seed.registerAgent(new DeterministicDesignerFixtureAdapter());
    const { workspace, binding } = matchedBindingWorkspace(seed.snapshot());
    await seed.openProjectWorkspace(workspace);
    await seed.markReadyForReview();
    const stored = state.read();
    if (stored === undefined) throw new Error('Fixture designer state was not saved.');
    await state.port.saveDesignerState(workspace.projectId, { ...stored, reactBinding: binding });
    const reader = fixtureService({ projectState: state.port });
    reader.registerAgent(new DeterministicDesignerFixtureAdapter());
    await reader.openProjectWorkspace(workspace);
    expect(hostBindingState(reader).reactBinding).toBeUndefined();
    expect(hostBindingState(reader).pendingReactBinding).toEqual(binding);
  });
  it('activates and persists a matching host receipt after reopen', async () => {
    const state = fixtureProjectState();
    const seed = fixtureService({ projectState: state.port });
    seed.registerAgent(new DeterministicDesignerFixtureAdapter());
    const { workspace, binding } = matchedBindingWorkspace(seed.snapshot());
    await seed.openProjectWorkspace(workspace);
    await seed.markReadyForReview();
    const stored = state.read();
    if (stored === undefined) throw new Error('Fixture designer state was not saved.');
    await state.port.saveDesignerState(workspace.projectId, { ...stored, reactBinding: binding });
    const reader = fixtureService({ projectState: state.port });
    reader.registerAgent(new DeterministicDesignerFixtureAdapter());
    await reader.openProjectWorkspace(workspace);

    await expect(
      reader.activateReactBindingReceipt(buildArtifact(reader.snapshot()))
    ).resolves.toEqual({
      status: 'activated'
    });
    expect(hostBindingState(reader).reactBinding).toEqual(binding);
    expect(hostBindingState(reader).pendingReactBinding).toBeUndefined();
    expect(state.read()?.reactBinding).toEqual(binding);
  });
  it('rejects hostile receipt identities without mutating an inert binding', async () => {
    const state = fixtureProjectState();
    const seed = fixtureService({ projectState: state.port });
    seed.registerAgent(new DeterministicDesignerFixtureAdapter());
    const { workspace, binding } = matchedBindingWorkspace(seed.snapshot());
    await seed.openProjectWorkspace(workspace);
    await seed.markReadyForReview();
    const stored = state.read();
    if (stored === undefined) throw new Error('Fixture designer state was not saved.');
    await state.port.saveDesignerState(workspace.projectId, { ...stored, reactBinding: binding });
    const reader = fixtureService({ projectState: state.port });
    reader.registerAgent(new DeterministicDesignerFixtureAdapter());
    await reader.openProjectWorkspace(workspace);
    const artifact = buildArtifact(reader.snapshot());
    await expect(
      reader.activateReactBindingReceipt({
        ...artifact,
        receipt: { ...artifact.receipt!, projectId: 'other-project' }
      })
    ).rejects.toThrow('React build receipt does not match the current workspace.');
    expect(hostBindingState(reader).reactBinding).toBeUndefined();
    expect(hostBindingState(reader).pendingReactBinding).toEqual(binding);
  });
  it('rejects tampered emitted preview output without activating an inert binding', async () => {
    const state = fixtureProjectState();
    const seed = fixtureService({ projectState: state.port });
    seed.registerAgent(new DeterministicDesignerFixtureAdapter());
    const { workspace, binding } = matchedBindingWorkspace(seed.snapshot());
    await seed.openProjectWorkspace(workspace);
    await seed.markReadyForReview();
    const stored = state.read();
    if (stored === undefined) throw new Error('Fixture designer state was not saved.');
    await state.port.saveDesignerState(workspace.projectId, { ...stored, reactBinding: binding });
    const reader = fixtureService({ projectState: state.port });
    reader.registerAgent(new DeterministicDesignerFixtureAdapter());
    await reader.openProjectWorkspace(workspace);
    const artifact = buildArtifact(reader.snapshot());

    await expect(
      reader.activateReactBindingReceipt({ ...artifact, code: `${artifact.code}// tampered` })
    ).rejects.toThrow('React build receipt does not match emitted preview output.');
    await expect(
      reader.activateReactBindingReceipt({ ...artifact, css: '/* tampered */' })
    ).rejects.toThrow('React build receipt does not match emitted preview output.');
    await expect(
      reader.activateReactBindingReceipt({
        ...artifact,
        receipt: { ...artifact.receipt!, outputSha256: 'b'.repeat(64) }
      })
    ).rejects.toThrow('React build receipt does not match emitted preview output.');
    await expect(
      reader.activateReactBindingReceipt({
        ...artifact,
        diagnostics: [
          { code: 'MISSING_SOURCE', message: 'preview compile failed', path: 'src/App.tsx' }
        ]
      })
    ).rejects.toThrow('A successful host preview artifact is required.');
    const { receipt: ignoredReceipt, ...receiptlessArtifact } = artifact;
    void ignoredReceipt;
    await expect(reader.activateReactBindingReceipt(receiptlessArtifact)).rejects.toThrow(
      'A successful host preview artifact is required.'
    );

    expect(hostBindingState(reader).reactBinding).toBeUndefined();
    expect(hostBindingState(reader).pendingReactBinding).toEqual(binding);
  });
  it('does not activate a completed artifact after a newer graph revision supersedes it', async () => {
    const state = fixtureProjectState();
    const seed = fixtureService({ projectState: state.port });
    seed.registerAgent(new DeterministicDesignerFixtureAdapter());
    const { workspace, binding } = matchedBindingWorkspace(seed.snapshot());
    await seed.openProjectWorkspace(workspace);
    await seed.markReadyForReview();
    const stored = state.read();
    if (stored === undefined) throw new Error('Fixture designer state was not saved.');
    await state.port.saveDesignerState(workspace.projectId, { ...stored, reactBinding: binding });
    const reader = fixtureService({ projectState: state.port });
    reader.registerAgent(new DeterministicDesignerFixtureAdapter());
    await reader.openProjectWorkspace(workspace);
    const completedArtifact = buildArtifact(reader.snapshot());

    await reader.savePrototypeGraph(reader.snapshot().editablePrototype.graph);

    await expect(reader.activateReactBindingReceipt(completedArtifact)).resolves.toEqual({
      status: 'unavailable'
    });
    expect(hostBindingState(reader).reactBinding).toBeUndefined();
    expect(hostBindingState(reader).pendingReactBinding).toBeUndefined();
  });
  it('does not activate a completed artifact after a newer source revision supersedes it', async () => {
    const state = fixtureProjectState();
    const seed = fixtureService({ projectState: state.port });
    seed.registerAgent(new DeterministicDesignerFixtureAdapter());
    const workspace = seed.snapshot().source;
    const binding = inertBindingFor(seed.snapshot());
    await seed.markReadyForReview();
    const stored = state.read();
    if (stored === undefined) throw new Error('Fixture designer state was not saved.');
    await state.port.saveDesignerState(workspace.projectId, { ...stored, reactBinding: binding });
    const reader = fixtureService({ projectState: state.port });
    reader.registerAgent(new DeterministicDesignerFixtureAdapter());
    await reader.openProjectWorkspace(workspace);
    const completedArtifact = buildArtifact(reader.snapshot());
    reader.registerAgent({
      descriptor: {
        id: 'stable-source-revision-fixture',
        label: 'Stable source revision fixture',
        capabilities: ['react.revise']
      },
      async propose(input) {
        const source = input.workspace.files.find((file) => file.path === 'src/App.tsx');
        if (source === undefined) throw new Error('Matched fixture source is unavailable.');
        return {
          operations: [
            { type: 'write', path: source.path, content: `${source.content}\n// newer revision` }
          ],
          summary: 'Preserved stable source nodes while changing the revision.'
        };
      }
    });

    await reader.requestAIChange({
      agentId: 'stable-source-revision-fixture',
      instruction: 'Revise the primary action.',
      target
    });

    await expect(reader.activateReactBindingReceipt(completedArtifact)).resolves.toEqual({
      status: 'unavailable'
    });
    expect(hostBindingState(reader).reactBinding).toBeUndefined();
    expect(hostBindingState(reader).pendingReactBinding).toBeUndefined();
  });
  it('keeps persisted binding data inert until post-hydration host validation and discards stale data', async () => {
    const state = fixtureProjectState();
    const writer = fixtureService({ projectState: state.port });
    writer.registerAgent(new DeterministicDesignerFixtureAdapter());
    await writer.markReadyForReview();
    const stored = state.read();
    if (stored === undefined) throw new Error('Fixture designer state was not saved.');
    const reader = fixtureService({ projectState: state.port });
    reader.registerAgent(new DeterministicDesignerFixtureAdapter());
    const binding = inertBindingFor(reader.snapshot());
    await state.port.saveDesignerState('desktop-designer', { ...stored, reactBinding: binding });

    await reader.openProjectWorkspace(freshWorkspace());

    expect(hostBindingState(reader).reactBinding).toBeUndefined();
    expect(hostBindingState(reader).pendingReactBinding).toEqual(binding);
    expect(reader.snapshot().activity).toContain(
      'Saved React binding requires a fresh host build receipt.'
    );
  });

  it('invalidates host binding state when a graph revision is saved', async () => {
    const service = fixtureService();
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const state = hostBindingState(service);
    state.reactBinding = inertBindingFor(service.snapshot());
    state.pendingReactBinding = inertBindingFor(service.snapshot());

    await service.savePrototypeGraph(service.snapshot().editablePrototype.graph);

    expect(state.reactBinding).toBeUndefined();
    expect(state.pendingReactBinding).toBeUndefined();
  });

  it('invalidates host binding state through the public AI source-mutation path', async () => {
    const service = fixtureService();
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const state = hostBindingState(service);
    state.reactBinding = inertBindingFor(service.snapshot());
    state.pendingReactBinding = inertBindingFor(service.snapshot());

    await service.requestAIChange({
      agentId: 'fixture-designer',
      instruction: 'Revise the primary action.',
      target
    });

    expect(state.reactBinding).toBeUndefined();
    expect(state.pendingReactBinding).toBeUndefined();
  });
  it('returns the core capability diagnostic for a valid manual edit proposal', async () => {
    const digest = 'a'.repeat(64);
    const revision = migrateDesignRevisionV1({
      format: 'selene-design-revision/v1',
      tenantId: 'tenant-a',
      projectId: 'desktop-designer',
      revisionId: 'revision-1',
      sequence: 1,
      createdAt: '2026-07-25T22:01:00.000Z',
      tuple: {
        sourceDigest: digest,
        graphDigest: digest,
        bindingDigest: digest,
        commandLogDigest: digest,
        designSystemLockDigest: digest,
        deployment: {
          format: 'selene-deployment-identity/v1',
          state: 'unpublished',
          draftId: 'draft-1',
          manifestDigest: digest
        },
        preview: {
          format: 'selene-compiled-preview-identity/v1',
          buildId: 'preview-1',
          previewDigest: digest
        },
        compiler: {
          format: 'selene-compiler-identity/v1',
          compilerId: 'compiler-1',
          compilerDigest: 'c'.repeat(64)
        }
      },
      privacy: {
        format: 'selene-design-privacy/v1',
        classification: 'restricted',
        contentDigest: digest,
        lifecycle: 'active',
        fields: [],
        retention: { deleteAfter: '2026-07-26T22:01:00.000Z' },
        deletion: { action: 'tombstone', tombstoneDigest: digest },
        exportPolicyDigest: digest,
        auditCorrelationId: 'audit-1',
        exclusions: ['raw-prompt']
      }
    }).migratedRevision;
    const source = {
      format: 'selene-compiler-source-identity/v1',
      moduleId: 'orders-page',
      exportName: 'OrdersPage',
      astNodeId: 'orders.root',
      sourceDigest: digest,
      bindingDigest: digest
    } as const;
    const instance = {
      format: 'selene-compiler-rendered-instance-identity/v1',
      instanceId: 'orders-root',
      ancestry: ['orders.root'],
      repeat: { kind: 'singleton' as const }
    };
    const editTarget = {
      format: 'selene-design-edit-target/v1',
      operation: {
        format: 'selene-design-revision-operation-target/v2',
        tenantId: revision.tenantId,
        projectId: revision.projectId,
        revisionId: revision.revisionId,
        tupleBinding: revision.tupleBinding,
        revisionCommitment: revision.revisionCommitment,
        node: {
          format: 'selene-compiler-node-identity/v2',
          projectId: revision.projectId,
          nodeId: 'orders.root',
          compilerDigest: 'c'.repeat(64),
          source,
          instance: {
            ...instance,
            instanceDigest: createCompilerRenderedInstanceDigest(revision, source, instance)
          }
        }
      },
      sourceAnchorId: 'orders.root'
    };
    const proposal = {
      format: 'selene-design-edit-proposal/v1',
      schemaVersion: 1,
      proposalId: 'proposal-1',
      commandId: 'command-1',
      actorId: 'actor-1',
      origin: 'manual-canvas',
      operation: {
        format: 'selene-design-revision-operation-reference/v2',
        kind: 'edit',
        tenantId: revision.tenantId,
        projectId: revision.projectId,
        actorId: 'actor-1',
        commandId: 'command-1',
        revisionId: revision.revisionId,
        tupleBinding: revision.tupleBinding,
        revisionCommitment: revision.revisionCommitment
      },
      base: revision,
      commands: [{ kind: 'set-prop', target: editTarget, prop: 'title', value: 'Orders' }],
      preconditions: [
        { kind: 'source-revision', sourceDigest: digest },
        { kind: 'binding-revision', bindingDigest: digest },
        { kind: 'design-system-lock', designSystemLockDigest: digest }
      ],
      requestedAt: '2026-07-26T00:00:00.000Z'
    };
    await expect(
      fixtureService().requestManualDesignEdit({
        format: 'selene-desktop-manual-design-edit-request/v1',
        projectId: 'desktop-designer',
        proposal
      })
    ).resolves.toEqual({
      format: 'selene-design-edit-result/v1',
      kind: 'rejected',
      diagnostics: [{ code: 'HOST_BINDING_UNAVAILABLE' }]
    });
  });
  it('fails closed for hostile manual edit request wrappers', async () => {
    const service = fixtureService();
    const request = (value: unknown) => service.requestManualDesignEdit(value);
    await expect(
      request({ format: 'wrong', projectId: 'desktop-designer', proposal: {} })
    ).resolves.toMatchObject({ diagnostics: [{ code: 'INVALID_REQUEST' }] });
    await expect(
      request({
        format: 'selene-desktop-manual-design-edit-request/v1',
        projectId: 'other',
        proposal: {}
      })
    ).resolves.toMatchObject({ diagnostics: [{ code: 'PROJECT_MISMATCH' }] });
    await expect(
      request({
        format: 'selene-desktop-manual-design-edit-request/v1',
        projectId: 'desktop-designer',
        proposal: {}
      })
    ).resolves.toMatchObject({ diagnostics: [{ code: 'INVALID_PROPOSAL' }] });
    await expect(
      request({ format: 'selene-desktop-manual-design-edit-request/v1' })
    ).resolves.toMatchObject({ diagnostics: [{ code: 'INVALID_REQUEST' }] });
    await expect(
      request({
        format: 'selene-desktop-manual-design-edit-request/v1',
        projectId: 'desktop-designer',
        proposal: {},
        extra: true
      })
    ).resolves.toMatchObject({ diagnostics: [{ code: 'INVALID_REQUEST' }] });
    await expect(
      request(
        Object.assign(
          {
            format: 'selene-desktop-manual-design-edit-request/v1',
            projectId: 'desktop-designer',
            proposal: {}
          },
          { [Symbol('extra')]: true }
        )
      )
    ).resolves.toMatchObject({ diagnostics: [{ code: 'INVALID_REQUEST' }] });
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'format', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'selene-desktop-manual-design-edit-request/v1';
      }
    });
    await expect(request(accessor)).resolves.toMatchObject({
      diagnostics: [{ code: 'INVALID_REQUEST' }]
    });
    expect(getterCalls).toBe(0);
    await expect(
      request(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('must not execute');
            }
          }
        )
      )
    ).resolves.toMatchObject({ diagnostics: [{ code: 'INVALID_REQUEST' }] });
  });
  it('uses the host identity for every review mutation and ignores spoofed renderer authors', async () => {
    const authorId = 'local-designer-11111111-1111-4111-8111-111111111111';
    const state = fixtureProjectState();
    const service = fixtureService({ authorId, projectState: state.port });
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const created = await service.addReviewThread({
      body: 'Check the owner affordance.',
      anchor: target,
      createdBy: 'renderer-spoof'
    });
    const thread = created.reviewThreads.at(-1);
    if (thread === undefined) throw new Error('Review thread was not recorded.');
    expect(thread.author).toBe(authorId);

    await service.replyToReviewThread({
      id: thread.id,
      body: 'The host, not this renderer, attributes this reply.',
      createdBy: 'renderer-spoof'
    });
    await service.resolveReviewThread({
      id: thread.id,
      resolved: true,
      resolvedBy: 'renderer-spoof'
    });
    await service.resolveReviewThread({
      id: thread.id,
      resolved: false,
      resolvedBy: 'renderer-spoof'
    });
    const reopenedState = state.read();
    if (reopenedState === undefined) throw new Error('Review thread was not persisted.');
    const reopened = parseSnapshot(reopenedState.collaborationSnapshot).reviewThreads.find(
      (item) => item.id === thread.id
    );
    expect(reopened).toMatchObject({
      createdBy: authorId,
      lifecycle: 'open',
      reopenedBy: authorId
    });
    await service.resolveReviewThread({
      id: thread.id,
      resolved: true,
      resolvedBy: 'renderer-spoof'
    });
    const persisted = state.read();
    if (persisted === undefined) throw new Error('Re-resolved review thread was not persisted.');
    const canonical = parseSnapshot(persisted.collaborationSnapshot).reviewThreads.find(
      (item) => item.id === thread.id
    );
    expect(canonical).toMatchObject({
      createdBy: authorId,
      lifecycle: 'resolved',
      reopenedBy: authorId,
      resolvedBy: authorId
    });
    expect(canonical?.messages.map((message) => message.createdBy)).toEqual([authorId, authorId]);
  });

  it('keeps host-composed collaboration authors isolated between local profiles', async () => {
    const first = fixtureService({
      authorId: 'local-designer-11111111-1111-4111-8111-111111111111'
    });
    const second = fixtureService({
      authorId: 'local-designer-22222222-2222-4222-8222-222222222222'
    });
    first.registerAgent(new DeterministicDesignerFixtureAdapter());
    second.registerAgent(new DeterministicDesignerFixtureAdapter());
    const [firstSnapshot, secondSnapshot] = await Promise.all([
      first.addReviewThread({ body: 'First profile review.', anchor: target }),
      second.addReviewThread({ body: 'Second profile review.', anchor: target })
    ]);
    expect(firstSnapshot.reviewThreads.at(-1)?.author).not.toBe(
      secondSnapshot.reviewThreads.at(-1)?.author
    );
  });

  it('migrates only legacy desktop attribution when an existing project is hydrated', async () => {
    const previousAuthorId = 'local-designer-11111111-1111-4111-8111-111111111111';
    const currentAuthorId = 'local-designer-22222222-2222-4222-8222-222222222222';
    const persisted = fixtureProjectState();
    const writer = fixtureService({
      authorId: previousAuthorId,
      projectState: persisted.port
    });
    writer.registerAgent(new DeterministicDesignerFixtureAdapter());
    await writer.markReadyForReview();
    const reviewed = await writer.addReviewThread({ body: 'Legacy local review.', anchor: target });
    const review = reviewed.reviewThreads.at(-1);
    if (review === undefined) throw new Error('Legacy review thread was not created.');
    await writer.replyToReviewThread({ id: review.id, body: 'Legacy local reply.' });
    await writer.addDeveloperAnnotation({
      category: 'accessibility',
      body: 'Preserve the legitimate hosted author.'
    });
    await writer.requestAIChange({
      agentId: 'fixture-designer',
      instruction: 'Create a legacy-attributed revision.',
      target
    });
    const source = writer.snapshot().source;
    const stored = persisted.read();
    if (stored === undefined) throw new Error('Legacy collaboration fixture was not persisted.');
    const legacyValue = JSON.parse(
      stored.collaborationSnapshot.replaceAll(previousAuthorId, 'desktop-reviewer')
    ) as {
      developerAnnotations: { createdBy: string }[];
      designReviewState?: { baseline?: { createdBy: string } };
    };
    const legitimateAuthor = 'hosted-enterprise-designer';
    if (legacyValue.developerAnnotations[0] === undefined)
      throw new Error('Legacy developer annotation was not created.');
    legacyValue.developerAnnotations[0].createdBy = legitimateAuthor;
    const legacyState = fixtureProjectState({
      ...stored,
      baseline:
        stored.baseline.baseline === undefined
          ? stored.baseline
          : {
              ...stored.baseline,
              baseline: { ...stored.baseline.baseline, createdBy: 'desktop-reviewer' }
            },
      collaborationSnapshot: `${JSON.stringify(legacyValue, null, 2)}\n`
    });
    const reader = fixtureService({
      authorId: currentAuthorId,
      projectState: legacyState.port
    });
    reader.registerAgent(new DeterministicDesignerFixtureAdapter());

    await reader.openProjectWorkspace(source);

    const migratedState = legacyState.read();
    if (migratedState === undefined) throw new Error('Migrated collaboration state was not saved.');
    expect(migratedState.collaborationSnapshot).not.toContain('desktop-reviewer');
    const migrated = parseSnapshot(migratedState.collaborationSnapshot);
    expect(migrated.revisions.map((revision) => revision.createdBy)).toContain(currentAuthorId);
    expect(migrated.reviewThreads[0]).toMatchObject({
      createdBy: currentAuthorId,
      messages: [{ createdBy: currentAuthorId }, { createdBy: currentAuthorId }]
    });
    expect(migrated.designReviewState?.baseline?.createdBy).toBe(currentAuthorId);
    expect(migrated.developerAnnotations[0]?.createdBy).toBe(legitimateAuthor);
    expect(migrated.aiChangeRequests[0]).toMatchObject({
      createdBy: currentAuthorId,
      provider: { providerId: 'fixture-designer' }
    });
  });

  it('starts only the exact current graph scenario, preserves it through reset, and rejects stale ownership', async () => {
    const service = fixtureService();
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const before = service.snapshot();
    const request = {
      projectId: before.source.projectId,
      graphRevision: before.editablePrototype.revision,
      scenarioId: 'desktop-review'
    };

    await expect(
      service.startPrototypeScenario({ ...request, scenarioId: 'missing' })
    ).rejects.toThrow(/Unknown prototype scenario/);
    expect(service.snapshot().editablePrototype).toEqual(before.editablePrototype);

    const started = await service.startPrototypeScenario(request);
    expect(started.editablePrototype).toMatchObject({
      mode: 'run',
      runtime: { scenarioId: 'desktop-review', activeNodeId: 'dashboard', activeStateId: 'loading' }
    });
    expect(service.resetPrototypeRun().editablePrototype.runtime).toMatchObject({
      scenarioId: 'desktop-review',
      activeNodeId: 'dashboard',
      activeStateId: 'loading'
    });
    await expect(
      service.startPrototypeScenario({ ...request, projectId: 'different-project' })
    ).rejects.toThrow(/no longer active/);
    await expect(
      service.startPrototypeScenario({ ...request, graphRevision: request.graphRevision + 1 })
    ).rejects.toThrow(/stale/);
  });

  it('serializes scenario start after a graph save so a queued stale revision cannot start', async () => {
    const service = fixtureService();
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const before = service.snapshot();
    const request = {
      projectId: before.source.projectId,
      graphRevision: before.editablePrototype.revision,
      scenarioId: 'desktop-review'
    };
    const saved = service.savePrototypeGraph(before.editablePrototype.graph);
    const staleStart = service.startPrototypeScenario(request);

    await saved;
    await expect(staleStart).rejects.toThrow(/stale/);
    expect(service.snapshot().editablePrototype).toMatchObject({ mode: 'edit' });
    expect(service.snapshot().editablePrototype.runtime).toBeUndefined();
  });

  it('rejects a queued graph save from the previous project before it reaches persistence', async () => {
    const persistence = recordingGraphPersistence();
    const service = fixtureService({ graphPersistence: persistence.port });
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const projectA = service.snapshot();
    const projectB = freshWorkspace();
    const projectBId = 'queued-save-project-b';

    const opened = service.openProjectWorkspace({ ...projectB, projectId: projectBId });
    const staleSave = service.savePrototypeGraph(projectA.editablePrototype.graph);

    const beforeStaleSave = await opened;
    await expect(staleSave).rejects.toThrow(/no longer active/);
    expect(persistence.saves()).toEqual([]);
    expect(service.snapshot()).toEqual(beforeStaleSave);
  });

  it('binds a missing graph fixture to a new project before its first save', async () => {
    const persistence = recordingGraphPersistence();
    const service = fixtureService({ graphPersistence: persistence.port });
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const projectId = 'first-save-project';

    const opened = await service.openProjectWorkspace({ ...freshWorkspace(), projectId });
    expect(opened.editablePrototype.graph).toMatchObject({
      project: { projectId },
      revision: opened.source.revision
    });

    const saved = await service.savePrototypeGraph(opened.editablePrototype.graph);
    expect(saved.editablePrototype).toMatchObject({
      revision: 1,
      graph: { project: { projectId } }
    });
    expect(persistence.saves()).toEqual([{ projectId, graph: opened.editablePrototype.graph }]);
  });

  it('rejects scenario starts at the host boundary while graph hydration needs recovery', async () => {
    const persistence = fixtureGraphPersistence();
    const service = fixtureService({
      graphPersistence: {
        ...persistence,
        read: async () => Promise.reject(new Error('disk unavailable'))
      }
    });
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    await service.openProjectWorkspace(freshWorkspace());
    const snapshot = service.snapshot();

    expect(snapshot.prototypeGraphHydration).toMatchObject({ state: 'recovery-required' });
    await expect(
      service.startPrototypeScenario({
        projectId: snapshot.source.projectId,
        graphRevision: snapshot.editablePrototype.revision,
        scenarioId: 'desktop-review'
      })
    ).rejects.toThrow(/Recover the saved graph/);
    expect(service.snapshot().editablePrototype).toMatchObject({ mode: 'edit' });
  });

  it('passes generation context through the configured adapter boundary', async () => {
    const adapter = configuredAdapter('context');
    const markdown = `# Guidance\n\n${'Use semantic tokens.\n'.repeat(4_096)}`;
    const scenario = enterpriseScenarioFixtures.find(
      (candidate) => candidate.id === 'owner-loading-desktop'
    );
    if (scenario === undefined) throw new Error('configured fixture scenario was not created');
    await expect(
      adapter.propose({
        instruction: 'Use the staged guidance.',
        target: {
          ...target,
          artifactId: 'desktop-designer',
          screenId: 'desktop-designer',
          scenarioId: 'owner-loading-desktop',
          state: 'loading',
          revisionId: 'desktop-designer-r1'
        },
        workspace: freshWorkspace(),
        scenario,
        signal: new AbortController().signal,
        progress: () => undefined,
        generationContext: {
          packages: [],
          guidance: [
            {
              artifactDigest: createHash('sha256').update(markdown).digest('hex'),
              markdown
            }
          ]
        }
      })
    ).resolves.toMatchObject({ summary: 'Configured JSONL agent updated the prototype.' });
  });

  it('projects only staged setup receipt metadata into the current snapshot', async () => {
    const service = fixtureService();
    service.registerAgent(new DeterministicDesignerFixtureAdapter());

    await service.inspectDesignSystem({ name: '@selene/design-tokens', version: '1.0.0' });
    await service.ingestDesignLanguage({
      markdown: '# Design\n\n## Principles\n\nUse semantic tokens.'
    });

    expect(service.snapshot().setup).toMatchObject({
      designSystem: {
        status: 'staged',
        packageName: '@selene/design-tokens',
        version: '1.0.0'
      },
      designLanguage: { status: 'staged', sectionCount: 2 }
    });
  });

  it('keeps an exact staged package receipt idempotent', async () => {
    const service = fixtureService();
    service.registerAgent(new DeterministicDesignerFixtureAdapter());

    await service.inspectDesignSystem({ name: '@selene/design-tokens', version: '1.0.0' });
    await service.inspectDesignSystem({ name: '@selene/design-tokens', version: '1.0.0' });

    expect(service.snapshot().setup?.designSystems).toHaveLength(1);
  });

  it('keeps raw Markdown out of snapshots while retaining staged receipt metadata', async () => {
    const service = fixtureService();
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const markdown = '# Private guidance\n\nNever expose this source text.';
    await service.ingestDesignLanguage({ markdown });
    const snapshot = JSON.stringify(service.snapshot());
    expect(snapshot).not.toContain('Private guidance');
    expect(snapshot).not.toContain('Never expose this source text');
    expect(service.snapshot().setup?.designLanguages?.[0]?.receipt.artifactDigest).toHaveLength(64);
  });

  it('atomically retains then removes complete guidance with project state', async () => {
    const persisted = fixtureProjectState();
    const service = fixtureService({ projectState: persisted.port, guidance: persisted.guidance });
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const first = await service.ingestDesignLanguage({ markdown: '# First\n\nOne.' });
    const second = await service.ingestDesignLanguage({ markdown: '# Second\n\nTwo.' });
    expect(
      await persisted.guidance.resolve(service.snapshot().source.projectId, first.artifactDigest)
    ).toBe('# First\n\nOne.');
    await service.setDesignLanguageInputs({
      inputs: [{ id: second.artifactDigest, enabled: true }]
    });
    expect(
      await persisted.guidance.resolve(service.snapshot().source.projectId, first.artifactDigest)
    ).toBeUndefined();
    expect(
      await persisted.guidance.resolve(service.snapshot().source.projectId, second.artifactDigest)
    ).toBe('# Second\n\nTwo.');
  });

  it('commits lifecycle state and guidance together', async () => {
    const counted = countingStorage();
    const lifecycle = new LocalProjectLifecycleService(counted.storage);
    const service = fixtureService({
      projectState: lifecycle,
      guidance: new DurableDesignLanguageGuidancePort(lifecycle)
    });
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const source = service.snapshot().source;
    await lifecycle.create({
      id: source.projectId,
      name: 'Atomic',
      origin: 'created',
      workspace: source
    });
    const baseline = counted.commits();
    const receipt = await service.ingestDesignLanguage({ markdown: '# Atomic\n\nGuidance.' });
    expect(counted.commits()).toBe(baseline + 1);
    const restarted = new LocalProjectLifecycleService(counted.storage);
    expect(
      await restarted.resolveDesignLanguageGuidance(source.projectId, receipt.artifactDigest)
    ).toBe('# Atomic\n\nGuidance.');
    expect(
      (await restarted.designerState(source.projectId))?.setup?.designLanguage?.artifactDigest
    ).toBe(receipt.artifactDigest);
    const before = await counted.storage.read(source.projectId);
    const corrupted = structuredClone(before) as Record<string, unknown>;
    delete corrupted.designLanguageGuidance;
    const isolated = createInMemoryProjectLifecycleStorage();
    await isolated.commit(source.projectId, corrupted as never);
    await expect(
      new LocalProjectLifecycleService(isolated).open(source.projectId)
    ).rejects.toMatchObject({ code: 'PROJECT_QUARANTINED' });
    expect(isolated.quarantined).toHaveLength(1);
    await expect(
      restarted.saveDesignerStateWithGuidance(
        source.projectId,
        (await restarted.designerState(source.projectId))!,
        []
      )
    ).rejects.toBeInstanceOf(Error);
    expect(await counted.storage.read(source.projectId)).toEqual(before);
    const beforeSnapshot = service.snapshot();
    counted.failNextCommit();
    await expect(
      service.ingestDesignLanguage({ markdown: '# Fails\n\nNo commit.' })
    ).rejects.toThrow('fixture lifecycle commit failed');
    expect(service.snapshot()).toEqual(beforeSnapshot);
    expect(await counted.storage.read(source.projectId)).toEqual(before);
    expect(counted.commits()).toBe(baseline + 1);
    await service.setDesignLanguageInputs({ inputs: [] });
    expect(counted.commits()).toBe(baseline + 2);
    expect(
      await restarted.resolveDesignLanguageGuidance(source.projectId, receipt.artifactDigest)
    ).toBeUndefined();
  });

  it('imports a host-selected Unicode Markdown file without exposing its path or source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-markdown-import-'));
    const path = join(directory, '設計原則.md');
    const markdown = '# Private import\n\nKeep this source in the main process.';
    const persisted = fixtureProjectState();
    const service = fixtureService({ projectState: persisted.port });
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    try {
      await writeFile(path, markdown, 'utf8');
      const projectId = service.snapshot().source.projectId;
      const receipt = await service.importDesignLanguageFile(path, projectId);
      const snapshot = service.snapshot();

      expect(receipt).toMatchObject({ status: 'staged', displayLabel: '設計原則.md' });
      expect(snapshot.setup?.designLanguages?.[0]?.receipt).toMatchObject({
        artifactDigest: receipt.artifactDigest,
        displayLabel: '設計原則.md'
      });
      expect(persisted.read()?.setup?.designLanguages?.[0]?.receipt.displayLabel).toBe(
        '設計原則.md'
      );
      expect(JSON.stringify(snapshot)).not.toContain(path);
      expect(JSON.stringify(snapshot)).not.toContain('Private import');
      expect(JSON.stringify(snapshot)).not.toContain('Keep this source');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('atomically imports chooser-ordered Markdown and retains the first receipt for duplicates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-markdown-batch-'));
    const firstPath = join(directory, 'foundation.md');
    const duplicatePath = join(directory, 'renamed-copy.mdx');
    const secondPath = join(directory, 'commerce.md');
    const firstMarkdown = '# Foundation\n\nUse semantic color tokens.';
    const secondMarkdown = '# Commerce\n\nKeep checkout actions explicit.';
    const guidance = new InMemoryDesignLanguageGuidancePort();
    const service = fixtureService({ guidance });
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const projectId = service.snapshot().source.projectId;
    try {
      await writeFile(firstPath, firstMarkdown, 'utf8');
      await writeFile(duplicatePath, firstMarkdown, 'utf8');
      await writeFile(secondPath, secondMarkdown, 'utf8');
      const [first] = await service.importDesignLanguageFiles([firstPath], projectId);
      const receipts = await service.importDesignLanguageFiles(
        [duplicatePath, secondPath],
        projectId
      );

      expect(receipts).toHaveLength(2);
      expect(receipts[0]).toEqual(first);
      expect(receipts[1]).toMatchObject({ displayLabel: 'commerce.md' });
      expect(
        service.snapshot().setup?.designLanguages?.map((entry) => entry.receipt.displayLabel)
      ).toEqual(['foundation.md', 'commerce.md']);
      expect(await guidance.sourceLocator(projectId, first!.artifactDigest)).toBe(
        await realpath(firstPath)
      );
      expect(await guidance.sourceLocator(projectId, receipts[1]!.artifactDigest)).toBe(
        await realpath(secondPath)
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refreshes changed Markdown without deadlocking and preserves its input slot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-markdown-refresh-'));
    const path = join(directory, 'foundation.md');
    const original = '# Foundation\n\nUse semantic color tokens.';
    const changed = '# Foundation\n\nUse accessible semantic color tokens.';
    const guidance = new InMemoryDesignLanguageGuidancePort();
    const service = fixtureService({ guidance });
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const projectId = service.snapshot().source.projectId;
    try {
      await writeFile(path, original, 'utf8');
      const [first] = await service.importDesignLanguageFiles([path], projectId);
      if (first === undefined) throw new Error('Fixture import did not return a receipt.');
      await service.setDesignLanguageInputs({
        inputs: [{ id: first.artifactDigest, enabled: false }]
      });
      await writeFile(path, changed, 'utf8');
      const refreshed = await within(
        service.refreshDesignLanguageSource(first.artifactDigest, projectId)
      );

      expect(refreshed.status).toBe('replaced');
      if (refreshed.status !== 'replaced') throw new Error('Guidance was not replaced.');
      expect(refreshed.receipt.displayLabel).toBe('foundation.md');
      expect(service.snapshot().setup?.designLanguages).toMatchObject([
        {
          id: refreshed.receipt.artifactDigest,
          enabled: false,
          receipt: { displayLabel: 'foundation.md' }
        }
      ]);
      await expect(guidance.resolve(projectId, first.artifactDigest)).resolves.toBeUndefined();
      await expect(guidance.resolve(projectId, refreshed.receipt.artifactDigest)).resolves.toBe(
        changed
      );
      await expect(
        guidance.sourceLocator(projectId, refreshed.receipt.artifactDigest)
      ).resolves.toBe(await realpath(path));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns unchanged for an intact source but reattaches same-content guidance on relink', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-markdown-relink-'));
    const originalPath = join(directory, 'foundation.md');
    const relinkedPath = join(directory, 'replacement-name.md');
    const markdown = '# Foundation\n\nUse semantic color tokens.';
    const guidance = new InMemoryDesignLanguageGuidancePort();
    const service = fixtureService({ guidance });
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const projectId = service.snapshot().source.projectId;
    try {
      await writeFile(originalPath, markdown, 'utf8');
      await writeFile(relinkedPath, markdown, 'utf8');
      const [first] = await service.importDesignLanguageFiles([originalPath], projectId);
      if (first === undefined) throw new Error('Fixture import did not return a receipt.');

      await expect(
        service.refreshDesignLanguageSource(first.artifactDigest, projectId)
      ).resolves.toEqual({
        status: 'unchanged',
        receipt: first
      });
      await expect(
        service.relinkDesignLanguageSource(first.artifactDigest, projectId)
      ).resolves.toEqual({
        status: 'cancelled'
      });
      const relinked = await service.relinkDesignLanguageSource(
        first.artifactDigest,
        projectId,
        relinkedPath
      );

      expect(relinked).toEqual({ status: 'relinked', receipt: first });
      await expect(guidance.resolve(projectId, first.artifactDigest)).resolves.toBe(markdown);
      await expect(guidance.sourceLocator(projectId, first.artifactDigest)).resolves.toBe(
        await realpath(relinkedPath)
      );
      expect(service.snapshot().setup?.designLanguages?.[0]?.receipt.displayLabel).toBe(
        'foundation.md'
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains guidance when its source is missing or refresh would duplicate another slot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-markdown-refresh-unavailable-'));
    const firstPath = join(directory, 'first.md');
    const secondPath = join(directory, 'second.md');
    const firstMarkdown = '# First\n\nOne.';
    const secondMarkdown = '# Second\n\nTwo.';
    const service = fixtureService();
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const projectId = service.snapshot().source.projectId;
    try {
      await writeFile(firstPath, firstMarkdown, 'utf8');
      await writeFile(secondPath, secondMarkdown, 'utf8');
      const receipts = await service.importDesignLanguageFiles([firstPath, secondPath], projectId);
      const [first, second] = receipts;
      if (first === undefined || second === undefined)
        throw new Error('Fixture import did not return receipts.');
      const beforeMissing = service.snapshot();
      await rm(firstPath);
      await expect(
        service.refreshDesignLanguageSource(first.artifactDigest, projectId)
      ).resolves.toEqual({
        status: 'unavailable'
      });
      expect(service.snapshot()).toEqual(beforeMissing);

      await writeFile(firstPath, secondMarkdown, 'utf8');
      const beforeDuplicate = service.snapshot();
      await expect(
        service.refreshDesignLanguageSource(first.artifactDigest, projectId)
      ).rejects.toThrow('duplicates an existing source');
      expect(service.snapshot()).toEqual(beforeDuplicate);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rolls back a changed refresh when durable guidance persistence fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-markdown-refresh-rollback-'));
    const path = join(directory, 'foundation.md');
    const original = '# Foundation\n\nOriginal.';
    const changed = '# Foundation\n\nChanged.';
    const persisted = fixtureProjectState();
    let failRefresh = false;
    const projectState: DesignerProjectStatePort = {
      ...persisted.port,
      async saveDesignerStateWithGuidance(projectId, state, entries) {
        if (failRefresh) throw new Error('fixture refresh persistence failed');
        await persisted.port.saveDesignerStateWithGuidance(projectId, state, entries);
      }
    };
    const service = fixtureService({ guidance: persisted.guidance, projectState });
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const projectId = service.snapshot().source.projectId;
    try {
      await writeFile(path, original, 'utf8');
      const [first] = await service.importDesignLanguageFiles([path], projectId);
      if (first === undefined) throw new Error('Fixture import did not return a receipt.');
      const before = service.snapshot();
      failRefresh = true;
      await writeFile(path, changed, 'utf8');
      await expect(
        service.refreshDesignLanguageSource(first.artifactDigest, projectId)
      ).rejects.toThrow('fixture refresh persistence failed');
      expect(service.snapshot()).toEqual(before);
      await expect(persisted.guidance.resolve(projectId, first.artifactDigest)).resolves.toBe(
        original
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rolls back an entire native Markdown batch when project persistence fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-markdown-batch-rollback-'));
    const firstPath = join(directory, 'first.md');
    const secondPath = join(directory, 'second.md');
    const firstMarkdown = '# First\n\nOne.';
    const secondMarkdown = '# Second\n\nTwo.';
    const firstDigest = createHash('sha256').update(firstMarkdown).digest('hex');
    const secondDigest = createHash('sha256').update(secondMarkdown).digest('hex');
    const guidance = new InMemoryDesignLanguageGuidancePort();
    const service = fixtureService({
      guidance,
      projectState: {
        async designerState() {
          return undefined;
        },
        async saveDesignerState() {
          throw new Error('fixture persistence failed');
        },
        async saveDesignerStateWithGuidance() {
          throw new Error('fixture persistence failed');
        },
        async commitDesignerRevision() {
          throw new Error('fixture persistence failed');
        }
      }
    });
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const projectId = service.snapshot().source.projectId;
    try {
      await writeFile(firstPath, firstMarkdown, 'utf8');
      await writeFile(secondPath, secondMarkdown, 'utf8');
      await expect(
        service.importDesignLanguageFiles([firstPath, secondPath], projectId)
      ).rejects.toThrow('fixture persistence failed');

      expect(service.snapshot().setup?.designLanguages).toBeUndefined();
      await expect(guidance.resolve(projectId, firstDigest)).resolves.toBeUndefined();
      await expect(guidance.resolve(projectId, secondDigest)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a native Markdown import for a stale project before reading or staging it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-markdown-project-fence-'));
    const path = join(directory, 'stale.md');
    const service = fixtureService();
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    try {
      await writeFile(path, '# Stale\n\nMust not be staged.', 'utf8');
      await expect(service.importDesignLanguageFile(path, 'different-project')).rejects.toThrow(
        'Project changed before the Markdown import began.'
      );
      expect(service.snapshot().setup?.designLanguages).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects oversized and invalid UTF-8 native Markdown files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-markdown-bounds-'));
    const oversized = join(directory, 'oversized.md');
    const invalid = join(directory, 'invalid.mdx');
    const service = fixtureService();
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const projectId = service.snapshot().source.projectId;
    try {
      await writeFile(oversized, Buffer.alloc(256 * 1024 + 1, 0x61));
      await writeFile(invalid, Buffer.from([0xc3, 0x28]));
      await expect(service.importDesignLanguageFile(oversized, projectId)).rejects.toThrow();
      await expect(service.importDesignLanguageFile(invalid, projectId)).rejects.toThrow();
      expect(service.snapshot().setup?.designLanguages).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('passes enabled guidance to generation in staged order and excludes disabled guidance', async () => {
    const received: string[][] = [];
    const service = fixtureService();
    const delegate = new DeterministicDesignerFixtureAdapter();
    service.registerAgent({
      descriptor: {
        id: 'capturing-guidance',
        label: 'Capturing guidance',
        capabilities: ['react.revise']
      },
      async propose(input) {
        received.push(input.generationContext?.guidance.map((entry) => entry.markdown) ?? []);
        return delegate.propose(input);
      }
    });
    const first = await service.ingestDesignLanguage({ markdown: '# First\n\nOne.' });
    const second = await service.ingestDesignLanguage({ markdown: '# Second\n\nTwo.' });
    const third = await service.ingestDesignLanguage({ markdown: '# Third\n\nThree.' });
    await service.setDesignLanguageInputs({
      inputs: [
        { id: second.artifactDigest, enabled: true },
        { id: first.artifactDigest, enabled: true },
        { id: third.artifactDigest, enabled: false }
      ]
    });
    await service.requestAIChange({
      agentId: 'capturing-guidance',
      instruction: 'Apply guidance.',
      target
    });
    expect(received).toEqual([['# Second\n\nTwo.', '# First\n\nOne.']]);
  });

  it('keeps project-scoped guidance isolated across project switches', async () => {
    const received: string[][] = [];
    const service = fixtureService();
    const delegate = new DeterministicDesignerFixtureAdapter();
    service.registerAgent({
      descriptor: { id: 'isolated-guidance', label: 'Isolation', capabilities: ['react.revise'] },
      async propose(input) {
        received.push(input.generationContext?.guidance.map((entry) => entry.markdown) ?? []);
        return delegate.propose(input);
      }
    });
    await service.ingestDesignLanguage({ markdown: '# Isolated\n\nProject one only.' });
    const next = freshWorkspace();
    await service.openProjectWorkspace({ ...next, projectId: 'isolated-project' });
    expect(service.snapshot().setup?.designLanguages).toBeUndefined();
    await service.requestAIChange({
      agentId: 'isolated-guidance',
      instruction: 'No carried guidance.',
      target
    });
    expect(received).toEqual([[]]);
  });

  it('rejects a same-name package when the host returns a different receipt digest', async () => {
    const service = fixtureService({
      intake: fixtureDesignSystemIntake(catalogFixturePort({ rotateDigest: true }), () => true)
    });
    service.registerAgent(new DeterministicDesignerFixtureAdapter());

    await service.inspectDesignSystem({ name: '@selene/design-tokens', version: '1.0.0' });
    await expect(
      service.inspectDesignSystem({ name: '@selene/design-tokens', version: '1.0.0' })
    ).rejects.toThrow('already staged with a different receipt');
    expect(service.snapshot().setup?.designSystems).toHaveLength(1);
  });

  it('persists ordered enabled inputs and permits removal without minting receipts', async () => {
    const persisted = fixtureProjectState();
    const service = fixtureService({
      projectState: persisted.port,
      intake: fixtureDesignSystemIntake(catalogFixturePort(), () => true)
    });
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const first = await service.inspectDesignSystem({
      name: '@selene/design-tokens',
      version: '1.0.0'
    });
    const second = await service.inspectDesignSystem({
      name: '@selene/commerce-tokens',
      version: '1.0.0'
    });

    const reordered = await service.setDesignSystemInputs({
      inputs: [
        { id: second.artifactDigest, enabled: false },
        { id: first.artifactDigest, enabled: true }
      ]
    });
    expect(reordered.setup?.designSystems).toMatchObject([
      { id: second.artifactDigest, enabled: false },
      { id: first.artifactDigest, enabled: true }
    ]);

    const removed = await service.setDesignSystemInputs({
      inputs: [{ id: first.artifactDigest, enabled: false }]
    });
    expect(removed.setup?.designSystems).toMatchObject([
      { id: first.artifactDigest, enabled: false }
    ]);
    expect(persisted.read()?.setup?.designSystems).toMatchObject([
      { id: first.artifactDigest, enabled: false }
    ]);
  });

  it('hydrates legacy setup receipts into ordered inputs', async () => {
    const persisted = fixtureProjectState();
    const source = freshWorkspace();
    const writer = fixtureService({ projectState: persisted.port });
    writer.registerAgent(new DeterministicDesignerFixtureAdapter());
    const receipt = await writer.inspectDesignSystem({
      name: '@selene/design-tokens',
      version: '1.0.0'
    });
    const stored = persisted.read();
    if (stored?.setup?.designSystem === undefined) throw new Error('Fixture state was not saved.');
    const legacy: LocalDesignerState = {
      ...stored,
      setup: { designSystem: stored.setup.designSystem }
    };
    const legacyState = fixtureProjectState(legacy);
    const reader = fixtureService({ projectState: legacyState.port });
    reader.registerAgent(new DeterministicDesignerFixtureAdapter());

    await reader.openProjectWorkspace(source);
    expect(reader.snapshot().setup?.designSystems).toMatchObject([
      { id: receipt.artifactDigest, enabled: true }
    ]);
  });

  it('generates only enabled package inputs in the configured order', async () => {
    const service = fixtureService({
      intake: fixtureDesignSystemIntake(catalogFixturePort(), () => true)
    });
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const first = await service.inspectDesignSystem({
      name: '@selene/design-tokens',
      version: '1.0.0'
    });
    const second = await service.inspectDesignSystem({
      name: '@selene/commerce-tokens',
      version: '1.0.0'
    });
    await service.setDesignSystemInputs({
      inputs: [
        { id: second.artifactDigest, enabled: true },
        { id: first.artifactDigest, enabled: false }
      ]
    });
    const capture = service as unknown as {
      captureImmutablePublishPlan(): Promise<{
        readonly plan: {
          readonly files: readonly { readonly path: string; readonly content: string }[];
        };
      }>;
    };
    const { plan } = await capture.captureImmutablePublishPlan();
    const inputs = plan.files.find((file) => file.path === 'selene/design-inputs.json');
    if (inputs === undefined) throw new Error('Generated design-input receipt was not found.');
    expect(
      JSON.parse(inputs.content).designSystems.map(
        (input: { packageName: string }) => input.packageName
      )
    ).toEqual(['@selene/commerce-tokens']);
  });

  it('takes a spatial AI request through adapter, source validation, revision, and handoff', async () => {
    const authorId = 'local-designer-11111111-1111-4111-8111-111111111111';
    const persisted = fixtureProjectState();
    const service = fixtureService({ authorId, projectState: persisted.port });
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const next = await service.requestAIChange({
      agentId: 'fixture-designer',
      instruction: 'Make the target action descriptive.',
      target
    });
    expect(next.aiChangeRequests).toMatchObject([
      { status: 'applied', target: { x: 0.25, scenarioId: 'owner-loading-desktop' } }
    ]);
    expect(next.source.revision.parentId).toBe('desktop-designer-r1');
    const app = next.source.files.find((file) => file.path === 'src/App.tsx')?.content;
    expect(app).toMatch(/window\.addEventListener\('selene-runtime-state',\s*onRuntime\);/);
    expect(app).toMatch(/window\.removeEventListener\('selene-runtime-state',\s*onRuntime\);/);
    expect(app).toContain('setScreenId(activeNodeId);');
    expect(app).toContain('window.history.replaceState');
    const stored = persisted.read();
    if (stored === undefined) throw new Error('Applied collaboration revision was not persisted.');
    const collaboration = parseSnapshot(stored.collaborationSnapshot);
    expect(collaboration.revisions.at(-1)?.createdBy).toBe(authorId);
    expect(collaboration.aiChangeRequests.at(-1)).toMatchObject({
      createdBy: authorId,
      provider: { providerId: 'fixture-designer' }
    });
    expect(await service.exportHandoff()).toContain('[accessibility]');
  });

  it('compensates only the current AI result while preserving collaboration history', async () => {
    const service = fixtureService();
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const before = service.snapshot();
    await service.markReadyForHandoff();
    const applied = await service.requestAIChange({
      agentId: 'fixture-designer',
      instruction: 'Apply then compensate this source revision.',
      target
    });
    const request = applied.aiChangeRequests.at(-1);
    if (request === undefined) throw new Error('Applied request was not recorded.');
    const collaboration = service as unknown as {
      readonly collaboration: {
        readonly aiChangeRequests: readonly {
          readonly id: string;
          readonly result?: unknown;
          readonly undoResult?: { readonly revisionId: string };
        }[];
      };
    };
    const originalResult = collaboration.collaboration.aiChangeRequests.find(
      (item) => item.id === request.id
    )?.result;
    expect(originalResult).toBeDefined();
    const reviewed = await service.addReviewThread({
      body: 'Keep this review thread.',
      anchor: target
    });
    const thread = reviewed.reviewThreads.at(-1);
    if (thread === undefined) throw new Error('Review thread was not recorded.');
    await service.replyToReviewThread({ id: thread.id, body: 'Keep this reply, too.' });
    await service.addDeveloperAnnotation({
      category: 'accessibility',
      body: 'Keep this direction.'
    });

    const undone = await service.undoLastAppliedAIChange({
      projectId: before.source.projectId,
      requestId: request.id
    });
    expect(undone.source.files).toEqual(before.source.files);
    expect(undone.source.revision.parentId).toBe(applied.source.revision.id);
    expect(undone.aiChangeRequests).toMatchObject([{ id: request.id, status: 'undone' }]);
    expect(undone.reviewThreads).toHaveLength(1);
    expect(undone.reviewThreads[0]?.replies).toHaveLength(1);
    expect(undone.developerAnnotations.some((item) => item.body === 'Keep this direction.')).toBe(
      true
    );
    expect(undone.baseline.changesSinceBaseline).toHaveLength(2);
    const canonical = collaboration.collaboration.aiChangeRequests.find(
      (item) => item.id === request.id
    );
    expect(canonical?.result).toEqual(originalResult);
    expect(canonical?.undoResult?.revisionId).toBe(undone.source.revision.id);
  });

  it('rejects wrong-project and non-latest undo requests without changing source', async () => {
    const service = fixtureService();
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const first = await service.requestAIChange({
      agentId: 'fixture-designer',
      instruction: 'First applied request.',
      target
    });
    const firstRequest = first.aiChangeRequests.at(-1);
    if (firstRequest === undefined) throw new Error('First request was not recorded.');
    const second = await service.requestAIChange({
      agentId: 'fixture-designer',
      instruction: 'Second applied request.',
      target
    });
    const before = service.snapshot();
    await expect(
      service.undoLastAppliedAIChange({ projectId: 'another-project', requestId: firstRequest.id })
    ).rejects.toThrow('different project');
    await expect(
      service.undoLastAppliedAIChange({
        projectId: second.source.projectId,
        requestId: firstRequest.id
      })
    ).rejects.toThrow('latest applied');
    expect(service.snapshot()).toEqual(before);
  });

  it('rolls an undo back completely when the compensating revision cannot persist', async () => {
    const persisted = fixtureProjectState();
    let failCommit = false;
    const service = fixtureService({
      projectState: {
        ...persisted.port,
        async commitDesignerRevision(projectId, workspace, state) {
          if (failCommit) throw new Error('undo persistence failed');
          return persisted.port.commitDesignerRevision(projectId, workspace, state);
        }
      }
    });
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const applied = await service.requestAIChange({
      agentId: 'fixture-designer',
      instruction: 'Rollback the undo on persistence failure.',
      target
    });
    const request = applied.aiChangeRequests.at(-1);
    if (request === undefined) throw new Error('Applied request was not recorded.');
    const before = service.snapshot();
    failCommit = true;
    await expect(
      service.undoLastAppliedAIChange({ projectId: before.source.projectId, requestId: request.id })
    ).rejects.toThrow('undo persistence failed');
    expect(service.snapshot()).toEqual(before);
  });

  it('creates separate review and handoff baselines, while review discussion stays non-dirty', async () => {
    const service = fixtureService();
    service.registerAgent(new DeterministicDesignerFixtureAdapter());

    const reviewed = await service.markReadyForReview();
    expect(reviewed.baseline).toMatchObject({
      readiness: 'ready-for-review',
      baseline: { id: 'baseline-review-desktop-designer-r1', intent: 'review' },
      currency: 'current',
      approvalsStale: false
    });

    const afterComment = await service.addReviewThread({
      body: 'Discussion only: confirm the accessible name.',
      anchor: target
    });
    expect(afterComment.baseline).toMatchObject({
      readiness: 'ready-for-review',
      currency: 'current',
      approvalsStale: false,
      changesSinceBaseline: []
    });

    const handedOff = await service.markReadyForHandoff();
    expect(handedOff.baseline).toMatchObject({
      readiness: 'ready-for-handoff',
      baseline: { id: 'baseline-handoff-desktop-designer-r1', intent: 'handoff' },
      currency: 'current',
      approvalsStale: false
    });
  });

  it('makes a post-handoff semantic mutation visible as a stale handoff baseline', async () => {
    const service = fixtureService();
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    await service.markReadyForHandoff();

    const changed = await service.requestAIChange({
      agentId: 'fixture-designer',
      instruction: 'Update the primary action after handoff.',
      target
    });
    expect(changed.baseline).toMatchObject({
      readiness: 'ready-for-handoff',
      baseline: { intent: 'handoff' },
      currency: 'stale',
      approvalsStale: true
    });
    expect(changed.baseline.changesSinceBaseline).toHaveLength(1);
  });

  it('keeps adversarial instructions and scenario content in inert JSON with identical TSX bytes', async () => {
    const instructions = [
      '</script><img src=x onerror=alert(1)> ${globalThis.process.exit()}',
      'quotes: "double", \'single\', and a backslash: \\',
      "import payload from 'untrusted-package';",
      'first line\nsecond line',
      'line separator \u2028 paragraph separator \u2029 terminal',
      '</script><script>alert("closing-script")</script>'
    ];
    const revisions = await Promise.all(
      instructions.map(async (instruction) => {
        const service = fixtureService();
        service.registerAgent(new DeterministicDesignerFixtureAdapter());
        service.selectScenario('commenter-error-tablet');
        const next = await service.requestAIChange({
          agentId: 'fixture-designer',
          instruction,
          target
        });
        return { instruction, next };
      })
    );
    const [baseline] = revisions;
    const baselineComponent = baseline?.next.source.files.find(
      (file) => file.path === 'src/App.tsx'
    )?.content;
    if (baselineComponent === undefined)
      throw new Error('fixture adapter did not produce the expected baseline component');
    const expectedTsxBytes = new TextEncoder().encode(baselineComponent);

    for (const { instruction, next } of revisions) {
      const component = next.source.files.find((file) => file.path === 'src/App.tsx')?.content;
      const data = next.source.files.find((file) => file.path === 'src/preview-data.json');
      if (component === undefined || data === undefined)
        throw new Error('fixture adapter did not produce the expected data boundary');

      const tsxBytes = new TextEncoder().encode(component);
      expect(tsxBytes).toEqual(expectedTsxBytes);
      expect(component).toContain("import data from './preview-data.json'");
      expect(component).not.toContain(instruction);
      expect(component).not.toContain('Support queue unavailable');
      expect(data.language).toBe('json');

      const artifact = JSON.parse(data.content) as {
        readonly format: string;
        readonly screens: readonly {
          readonly title: string;
          readonly summary: string;
          readonly action: string;
        }[];
      };
      expect(artifact.format).toBe('selene-desktop-preview-data/v1');
      expect(artifact.screens[0]).toEqual({
        id: 'dashboard',
        route: '/',
        title: 'Support queue unavailable',
        summary: 'error: Your saved filters are preserved.',
        action: instruction,
        actionPort: 'open-orders',
        nextScreenId: 'orders'
      });
    }
  });

  it('records unavailable custom adapter failures without mutating the source revision', async () => {
    const failing: DesignerAgentAdapter = {
      descriptor: { id: 'offline-agent', label: 'Offline', capabilities: ['react.revise'] },
      async propose() {
        throw new Error('adapter unavailable');
      }
    };
    const service = fixtureService();
    service.registerAgent(failing);
    await expect(
      service.requestAIChange({ agentId: 'offline-agent', instruction: 'Change this.', target })
    ).rejects.toThrow('adapter unavailable');
    expect(service.snapshot().aiChangeRequests).toMatchObject([
      { status: 'failed', error: 'adapter unavailable' }
    ]);
    expect(service.snapshot().source.revision.id).toBe('desktop-designer-r1');
  });

  it('records a data-poor service diagnostic without exposing the failed prompt or design data', async () => {
    const captured: unknown[] = [];
    const diagnostics: CrashDiagnosticSink = {
      async capture(source, category, hostile) {
        captured.push({
          source,
          category,
          hostile: hostile === undefined ? undefined : 'received'
        });
      }
    };
    const failing: DesignerAgentAdapter = {
      descriptor: { id: 'diagnostic-agent', label: 'Diagnostic', capabilities: ['react.revise'] },
      async propose() {
        throw new Error('prompt=private source comment token');
      }
    };
    const service = fixtureService({ diagnostics });
    service.registerAgent(failing);
    await expect(
      service.requestAIChange({
        agentId: 'diagnostic-agent',
        instruction: 'private design prompt',
        target
      })
    ).rejects.toThrow('prompt=private');
    expect(captured).toEqual([
      { source: 'service', category: 'operation-failure', hostile: 'received' }
    ]);
  });

  it('records configured JSONL process failures and cancellation without source mutation', async () => {
    const failed = fixtureService();
    failed.registerAgent(configuredAdapter('failure'));
    await expect(
      failed.requestAIChange({
        agentId: 'configured-failure',
        instruction: 'Fail predictably.',
        target
      })
    ).rejects.toThrow('Configured fixture failed');
    expect(failed.snapshot().aiChangeRequests).toMatchObject([{ status: 'failed' }]);
    expect(failed.snapshot().source.revision.id).toBe('desktop-designer-r1');

    const cancelled = fixtureService();
    cancelled.registerAgent(configuredAdapter('cancel'));
    cancelled.subscribe((event) => {
      if (event.stage === 'started') setTimeout(() => cancelled.cancel(event.requestId), 10);
    });
    await expect(
      cancelled.requestAIChange({
        agentId: 'configured-cancel',
        instruction: 'Cancel predictably.',
        target
      })
    ).rejects.toThrow(/cancel/i);
    expect(cancelled.snapshot().aiChangeRequests).toMatchObject([{ status: 'cancelled' }]);
    expect(cancelled.snapshot().source.revision.id).toBe('desktop-designer-r1');
  });

  it('rejects malformed complete patches before any service mutation', () => {
    const workspace = freshWorkspace();
    expect(
      parseAgentSourcePatch(
        {
          summary: 'clear generated styles safely',
          operations: [{ type: 'write', path: 'src/preview.css', content: '' }]
        },
        workspace
      )
    ).toMatchObject({ operations: [{ type: 'write', path: 'src/preview.css', content: '' }] });
    expect(() =>
      parseAgentSourcePatch(
        { summary: 'delete unknown', operations: [{ type: 'delete', path: 'src/missing.ts' }] },
        workspace
      )
    ).toThrow(/unknown path/);
    expect(() =>
      parseAgentSourcePatch(
        {
          summary: 'duplicate writes',
          operations: [
            {
              type: 'write',
              path: 'src/App.tsx',
              content: 'export default function App(){return null}'
            },
            {
              type: 'write',
              path: 'src/App.tsx',
              content: 'export default function App(){return null}'
            }
          ]
        },
        workspace
      )
    ).toThrow(/duplicate path/);
    const appSource = workspace.files.find((file) => file.path === 'src/App.tsx')?.content;
    if (appSource === undefined) throw new Error('fixture app source is unavailable');
    expect(() =>
      parseAgentSourcePatch(
        {
          summary: 'invalid dependency',
          operations: [{ type: 'write', path: 'src/App.tsx', content: appSource }],
          dependencies: ['untrusted-package']
        },
        workspace
      )
    ).toThrow(/allowlisted/);
    expect(() =>
      parseAgentSourcePatch(
        {
          summary: 'invalid mapping',
          operations: [{ type: 'write', path: 'src/App.tsx', content: appSource }],
          nodeIdMapping: { 'designer.root': 'missing.node' }
        },
        workspace
      )
    ).toThrow(/target does not exist/);
  });

  it('returns deep-cloned snapshot data across the application boundary', () => {
    const service = fixtureService();
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const snapshot = service.snapshot();
    (snapshot.source.files[0] as { content: string }).content = 'mutated outside the service';
    expect(service.snapshot().source.files[0]?.content).not.toBe('mutated outside the service');
  });

  it('rejects unbounded or ambiguous trusted adapter configuration', () => {
    const base = {
      id: 'agent',
      label: 'Agent',
      command: '/bin/echo',
      args: [],
      workspaceRoot: '/tmp',
      readOnly: true
    };
    expect(() =>
      parseTrustedAgentConfiguration({
        version: TRUSTED_AGENT_CONFIG_VERSION,
        agents: [{ ...base, command: 'node', capabilityGrants: ['react.revise'] }]
      })
    ).toThrow(/absolute executable/);
    expect(() =>
      parseTrustedAgentConfiguration({
        version: TRUSTED_AGENT_CONFIG_VERSION,
        agents: [{ ...base, capabilityGrants: ['simulation.run'] }]
      })
    ).toThrow(/designOperation must be present/);
    expect(() =>
      parseTrustedAgentConfiguration({
        version: TRUSTED_AGENT_CONFIG_VERSION,
        agents: [{ ...base, capabilityGrants: ['react.revise'], designOperation: 'simulation.run' }]
      })
    ).toThrow(/designOperation must be present/);
    expect(() =>
      parseTrustedAgentConfiguration({
        version: TRUSTED_AGENT_CONFIG_VERSION,
        agents: Array.from({ length: 17 }, (_, index) => ({
          ...base,
          id: `agent-${index}`,
          capabilityGrants: ['react.revise']
        }))
      })
    ).toThrow(/at most 16 agents/);
    expect(() =>
      parseTrustedAgentConfiguration({
        version: TRUSTED_AGENT_CONFIG_VERSION,
        agents: [
          {
            ...base,
            args: Array.from({ length: 33 }, () => 'arg'),
            capabilityGrants: ['react.revise']
          }
        ]
      })
    ).toThrow(/at most 32 strings/);
    expect(() =>
      parseTrustedAgentConfiguration({
        version: TRUSTED_AGENT_CONFIG_VERSION,
        agents: [
          {
            ...base,
            args: ['x'.repeat(4_097)],
            capabilityGrants: ['react.revise']
          }
        ]
      })
    ).toThrow(/up to 4096 characters/);
    expect(() =>
      parseTrustedAgentConfiguration({
        version: TRUSTED_AGENT_CONFIG_VERSION,
        agents: [
          {
            ...base,
            capabilityGrants: ['react.revise'],
            requestTimeoutMs: 60_001
          }
        ]
      })
    ).toThrow(/1000 to 60000/);
  });

  it('rejects oversized trusted configuration files before parsing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-agent-config-'));
    try {
      const path = join(directory, 'designer-agents.json');
      await writeFile(path, 'x'.repeat(MAX_TRUSTED_AGENT_CONFIG_BYTES + 1));
      await expect(loadTrustedAgentConfiguration(path)).rejects.toThrow(/exceeds/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
