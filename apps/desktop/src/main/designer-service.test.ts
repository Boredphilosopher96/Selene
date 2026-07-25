import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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
  type DesignerAgentAdapter
} from './designer-service';
import type { CrashDiagnosticSink } from './crash-diagnostics';
import { desktopDesignInputRuntime } from './design-input-runtime';
import { createLocalCatalogFixturePort, DesktopDesignSystemIntake } from './designer-setup-host';
import type { PersistedPrototypeGraph, PrototypeGraphPersistencePort } from './designer-host-ports';

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

function configuredAdapter(mode: 'cancel' | 'failure'): ConfiguredProcessDesignerAdapter {
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

function fixtureDesignSystemIntake(): DesktopDesignSystemIntake {
  return new DesktopDesignSystemIntake(createLocalCatalogFixturePort(), desktopDesignInputRuntime, {
    requiredPeerDependencies: { react: '^19.0.0' },
    provider: {
      label: 'designer-service local catalog fixture',
      fixture: 'demo-only-local-catalog',
      supports: (input) => input.name === '@selene/design-tokens' && input.version === '1.0.0'
    }
  });
}

function fixtureService(
  options: { readonly diagnostics?: CrashDiagnosticSink } = {}
): DesktopDesignerApplicationService {
  return new DesktopDesignerApplicationService(
    createEmbeddedBuildMetadataPort(),
    options.diagnostics ?? fixtureDiagnostics,
    fixtureGraphPersistence(),
    fixtureDesignSystemIntake()
  );
}

function freshWorkspace() {
  const service = fixtureService();
  service.registerAgent(new DeterministicDesignerFixtureAdapter());
  return service.snapshot().source;
}

describe('desktop designer application service', () => {
  it('takes a spatial AI request through adapter, source validation, revision, and handoff', async () => {
    const service = fixtureService();
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
    expect(next.source.files.find((file) => file.path === 'src/App.tsx')?.content).toContain(
      'history.pushState'
    );
    expect(await service.exportHandoff()).toContain('[accessibility]');
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
