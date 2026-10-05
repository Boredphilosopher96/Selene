import { describe, expect, it } from 'vitest';

import { enterpriseScenarioFixtures, validateReactSourceWorkspace } from '@selene/core';
import { parseSnapshot } from '@selene/collaboration';
import { createEmbeddedBuildMetadataPort } from './build-metadata';
import {
  DesktopDesignerApplicationService,
  createInitialWorkspace,
  DeterministicDesignerFixtureAdapter
} from './designer-service';
import {
  DesktopDesignSystemIntake,
  DesktopProjectSetup,
  createLocalCatalogFixturePort
} from './designer-setup-host';
import { desktopDesignInputRuntime } from './design-input-runtime';
import { LifecyclePrototypeGraphPersistencePort } from './lifecycle-prototype-graph';
import { CompilerBoundManualReactEditTransactionPort } from './manual-react-edit-transaction';
import {
  LocalProjectLifecycleService,
  createInMemoryProjectLifecycleStorage
} from './project-lifecycle';
import { ViteReactCompilerPort } from './react-compiler';
import { issueReactBindingCompilerEvidence } from './react-binding-evidence';
import {
  createStarterWorkspace,
  starterPrototypeGraphForWorkspace,
  type StarterTemplate
} from './starter-workspace';

const templates = ['dashboard', 'review', 'blank'] as const;
const headings = {
  dashboard: 'Good work, in view.',
  review: 'A calmer first hello.',
  blank: 'Your next idea'
};

function createService(lifecycle: LocalProjectLifecycleService, compiler: ViteReactCompilerPort) {
  const service = new DesktopDesignerApplicationService(
    createEmbeddedBuildMetadataPort(),
    undefined,
    new LifecyclePrototypeGraphPersistencePort(lifecycle, {
      read: async () => undefined,
      compareAndSwap: async () => {
        throw new Error('Unexpected legacy write');
      },
      recoverFromFixture: async () => {
        throw new Error('Unexpected recovery');
      }
    }),
    new DesktopDesignSystemIntake(createLocalCatalogFixturePort(), desktopDesignInputRuntime, {
      requiredPeerDependencies: { react: '^19.0.0' },
      provider: { label: 'Local test', supports: () => true }
    }),
    'local-designer-11111111-1111-4111-8111-111111111111',
    undefined,
    undefined,
    lifecycle
  );
  service.registerAgent(new DeterministicDesignerFixtureAdapter());
  service.bindManualEditTransaction(
    new CompilerBoundManualReactEditTransactionPort(
      compiler,
      service.createManualEditPersistencePort()
    )
  );
  return service;
}

describe('source-backed desktop starters', () => {
  it.each(templates)(
    'creates and compiles the %s starter with honest screen/action evidence',
    async (template) => {
      const workspace = createStarterWorkspace(`starter-${template}`, template);
      validateReactSourceWorkspace(workspace);
      const graph = starterPrototypeGraphForWorkspace(workspace)!;
      expect(graph.project.projectId).toBe(workspace.projectId);
      expect(graph.revision).toEqual(workspace.revision);
      expect(graph.nodes.map((node) => node.id)).toEqual(
        template === 'blank'
          ? ['canvas']
          : template === 'dashboard'
            ? ['dashboard', 'orders']
            : ['review', 'decision']
      );
      expect(graph.transitions).toHaveLength(template === 'blank' ? 0 : 2);
      expect(workspace.nodes.map((node) => node.nodeId)).toContain('designer.title');
      expect(new Set(workspace.nodes.map((node) => node.nodeId)).size).toBe(workspace.nodes.length);
      expect(workspace.files[0]!.content).toContain(
        `data-selene-node-id="designer.title">${headings[template]}</h1>`
      );
      const build = await new ViteReactCompilerPort().compile(workspace);
      expect(build.diagnostics).toEqual([]);
      expect(build.receipt).toBeDefined();
      expect(build.css).toContain('.starter--blank');
      const evidence = issueReactBindingCompilerEvidence(workspace, build.receipt!);
      expect(evidence.nodeMarkers.map((node) => node.sourceNodeId).sort()).toEqual(
        workspace.nodes.map((node) => node.nodeId).sort()
      );
      expect(evidence.actionMarkers).toHaveLength(template === 'blank' ? 0 : 2);
      for (const marker of evidence.actionMarkers) {
        expect(
          graph.nodes
            .find((node) => node.id === marker.graphNodeId)
            ?.ports.some((port) => port.id === marker.portId)
        ).toBe(true);
      }
    }
  );

  it('limits whole-fixture demo proposals to the exact legacy App source', async () => {
    const fixture = createInitialWorkspace('explicit-fixture');
    const propose = (workspace: typeof fixture) =>
      new DeterministicDesignerFixtureAdapter().propose({
        workspace,
        scenario: enterpriseScenarioFixtures[0]!,
        target: undefined,
        instruction: 'Exercise the deliberate demo fixture',
        signal: new AbortController().signal,
        progress: () => undefined
      });
    expect((await propose(fixture)).operations).toHaveLength(2);
    const custom = {
      ...fixture,
      files: fixture.files.map((file) =>
        file.path === fixture.entrypoint
          ? { ...file, content: `${file.content}\n// Custom authored source\n` }
          : file
      )
    };
    await expect(propose(custom)).rejects.toThrow('will not replace your design');
    const lifecycle = new LocalProjectLifecycleService(createInMemoryProjectLifecycleStorage());
    await lifecycle.create({
      id: custom.projectId,
      name: 'Custom authored source',
      origin: 'created',
      workspace: custom
    });
    const service = createService(lifecycle, new ViteReactCompilerPort());
    await service.openProjectWorkspace(custom);
    await expect(
      service.requestAIChange({
        kind: 'general',
        agentId: 'fixture-designer',
        instruction: 'Keep the custom source'
      })
    ).rejects.toThrow('will not replace your design');
    expect(service.snapshot().source).toEqual(custom);
    expect(service.snapshot().pendingAIProposal).toBeUndefined();
    expect((await lifecycle.open(custom.projectId)).current).toEqual(custom);
  });

  it.each(templates)(
    'keeps the %s create → compile → edit → durable reopen → undo flow compiler-bound',
    async (template: StarterTemplate) => {
      const lifecycle = new LocalProjectLifecycleService(createInMemoryProjectLifecycleStorage());
      const setup = new DesktopProjectSetup(lifecycle, createStarterWorkspace);
      const projectId = `flow-${template}`;
      const receipt = await setup.create({ id: projectId, name: `${template} project`, template });
      expect(receipt.origin).toBe(template === 'blank' ? 'created' : 'template');
      const initial = (await setup.open(projectId)).current;
      const compiler = new ViteReactCompilerPort();
      let service = createService(lifecycle, compiler);
      await service.openProjectWorkspace(initial);
      const request = () => ({
        projectId,
        nodeId: 'designer.title',
        revisionId: service.snapshot().source.revision.id
      });
      expect(await service.requestManualTextEditCapability(request())).toMatchObject({
        kind: 'unavailable'
      });
      await service.activateReactBindingReceipt(await compiler.compile(initial));
      const capability = await service.requestManualTextEditCapability(request());
      expect(service.snapshot().scenarios).toHaveLength(1);
      expect(service.snapshot().selectedScenarioId).toBe(`${template}-start`);
      expect(service.snapshot().scenarios[0]!.title).toContain('Current design');
      expect(capability).toMatchObject({ kind: 'available', currentContent: headings[template] });
      if (capability.kind !== 'available') throw new Error('Expected literal text capability');
      const result = await service.applyManualTextEdit({
        format: 'selene-desktop-manual-text-edit-apply/v1',
        projectId,
        capabilityId: capability.capabilityId,
        content: 'A real source edit'
      });
      expect(result.kind).toBe('applied');
      const edited = service.snapshot().source;
      expect(edited.files[0]!.content).toContain('>A real source edit</h1>');
      expect(edited.files.slice(1)).toEqual(initial.files.slice(1));
      expect(edited.nodes).toEqual(initial.nodes);
      expect((await lifecycle.open(projectId)).current).toEqual(edited);

      service = createService(lifecycle, compiler);
      await service.openProjectWorkspace((await lifecycle.open(projectId)).current);
      await service.activateReactBindingReceipt(await compiler.compile(service.snapshot().source));
      expect(await service.requestManualTextEditCapability(request())).toMatchObject({
        kind: 'available',
        currentContent: 'A real source edit'
      });
      const snapshot = service.snapshot();
      const undo = snapshot.designActivity.find((entry) => entry.undo?.available)?.undo;
      expect(undo).toBeDefined();
      await service.undoLatestManualDesignEdit({
        projectId,
        undoId: undo!.undoId,
        targetRevisionId: undo!.targetRevisionId,
        currentRevisionId: snapshot.source.revision.id
      });
      expect(service.snapshot().source.files).toEqual(initial.files);
      expect((await lifecycle.open(projectId)).current.files).toEqual(initial.files);
    }
  );

  it.each(templates)(
    'keeps the %s starter intact when the demo request is accepted',
    async (template) => {
      const lifecycle = new LocalProjectLifecycleService(createInMemoryProjectLifecycleStorage());
      const initial = createStarterWorkspace(`demo-${template}`, template);
      await lifecycle.create({
        id: initial.projectId,
        name: 'Demo starter',
        origin: 'template',
        workspace: initial
      });
      const service = createService(lifecycle, new ViteReactCompilerPort());
      await service.openProjectWorkspace(initial);
      const instruction = '</script><img src=x onerror=alert(1)> {process.exit()}';
      const staged = await service.requestAIChange({
        kind: 'general',
        agentId: 'fixture-designer',
        instruction
      });
      expect(staged.pendingAIProposal).toBeDefined();
      const pending = staged.pendingAIProposal!;
      expect(pending.summary).toContain('Demo agent');
      const next = await service.acceptPendingAIProposal({
        projectId: initial.projectId,
        requestId: pending.requestId,
        candidateRevisionId: pending.candidateRevisionId
      });
      expect(next.source.files.filter((file) => file.language !== 'json')).toEqual(
        initial.files.filter((file) => file.language !== 'json')
      );
      expect(next.source.nodes).toEqual(initial.nodes);
      expect(next.editablePrototype.graph.nodes).toEqual(
        starterPrototypeGraphForWorkspace(initial)!.nodes
      );
      expect(next.scenarios).toHaveLength(1);
      await service.activateReactBindingReceipt(
        await new ViteReactCompilerPort().compile(next.source)
      );
      expect(
        await service.requestManualTextEditCapability({
          projectId: initial.projectId,
          nodeId: 'designer.title',
          revisionId: next.source.revision.id
        })
      ).toMatchObject({ kind: 'available', currentContent: headings[template] });
      const data = JSON.parse(
        next.source.files.find((file) => file.language === 'json')!.content
      ) as { fixtureNote: string };
      expect(data.fixtureNote).toBe(`Demo request: ${instruction}`);
      expect(
        await service.requestManualTextEditCapability({
          projectId: initial.projectId,
          nodeId: 'starter.fixture-note',
          revisionId: next.source.revision.id
        })
      ).toMatchObject({ kind: 'unavailable' });
    }
  );

  it.each(templates)(
    'keeps %s scenario context across configured acceptance, reopen, another request and undo',
    async (template) => {
      const lifecycle = new LocalProjectLifecycleService(createInMemoryProjectLifecycleStorage());
      const initial = createStarterWorkspace(`configured-${template}`, template);
      await lifecycle.create({
        id: initial.projectId,
        name: 'Configured starter',
        origin: 'template',
        workspace: initial
      });
      const compiler = new ViteReactCompilerPort();
      const open = async () => {
        const service = createService(lifecycle, compiler);
        service.registerAgent({
          descriptor: {
            id: 'configured-test',
            label: 'Configured test agent',
            capabilities: ['react.revise', 'scenario-aware']
          },
          propose: async ({ workspace, instruction }) => {
            const dataFile = workspace.files.find((file) => file.language === 'json')!;
            const data = JSON.parse(dataFile.content) as Record<string, unknown>;
            delete data.starterTemplate;
            delete data.fixtureNote;
            const source = workspace.files.find((file) => file.language === 'tsx')!;
            return {
              summary: 'Configured source revision',
              nodeIdMapping: { 'starter.fixture-note': 'designer.root' },
              operations: [
                { type: 'write', path: dataFile.path, content: JSON.stringify(data) },
                {
                  type: 'write',
                  path: source.path,
                  content: `${source.content
                    .split('\n')
                    .filter((line) => !line.includes('data-selene-node-id="starter.fixture-note"'))
                    .join('\n')}\n// ${JSON.stringify(instruction)}\n`
                }
              ]
            };
          }
        });
        await service.openProjectWorkspace((await lifecycle.open(initial.projectId)).current);
        return service;
      };
      let service = await open();
      const staged = await service.requestAIChange({
        kind: 'general',
        agentId: 'configured-test',
        instruction: 'Generate an authored iteration'
      });
      const proposal = staged.pendingAIProposal!;
      const decision = {
        projectId: initial.projectId,
        requestId: proposal.requestId,
        candidateRevisionId: proposal.candidateRevisionId
      };
      const accepted = await service.acceptPendingAIProposal(decision);
      expect(starterPrototypeGraphForWorkspace(accepted.source)).toBeUndefined();
      expect(accepted.source.nodes.some((node) => node.nodeId === 'starter.fixture-note')).toBe(
        false
      );
      const expectCurrentScenario = () => {
        const snapshot = service.snapshot();
        expect(snapshot.scenarios).toHaveLength(1);
        expect(snapshot.selectedScenarioId).toBe(`${template}-start`);
        expect(snapshot.scenarios[0]!.id).toBe(snapshot.selectedScenarioId);
        expect(snapshot.scenarios[0]!.title).toContain('Current design');
        expect(snapshot.editablePrototype.graph.nodes).toEqual(
          starterPrototypeGraphForWorkspace(initial)!.nodes
        );
      };
      expectCurrentScenario();
      service = await open();
      expectCurrentScenario();
      const beforeDemo = service.snapshot().source;
      await expect(
        service.requestAIChange({
          kind: 'general',
          agentId: 'fixture-designer',
          instruction: 'Preserve my configured iteration'
        })
      ).rejects.toThrow('will not replace your design');
      expect(service.snapshot().source).toEqual(beforeDemo);
      expect(service.snapshot().pendingAIProposal).toBeUndefined();
      await service.addDeveloperAnnotation({
        category: 'implementation',
        body: 'Preserve the authored starting design'
      });
      const annotations = parseSnapshot(
        (await lifecycle.designerState(initial.projectId))!.collaborationSnapshot
      ).developerAnnotations;
      expect(annotations.at(-1)!.anchor.evidence).toMatchObject({
        screenId: starterPrototypeGraphForWorkspace(initial)!.initialNodeId,
        scenarioId: `${template}-start`,
        stateId: 'success'
      });
      const next = await service.requestAIChange({
        kind: 'general',
        agentId: 'configured-test',
        instruction: 'Continue the authored iteration'
      });
      expect(next.pendingAIProposal).toBeDefined();
      await service.rejectPendingAIProposal({
        projectId: initial.projectId,
        requestId: next.pendingAIProposal!.requestId,
        candidateRevisionId: next.pendingAIProposal!.candidateRevisionId
      });
      await service.undoLastAppliedAIChange({
        projectId: initial.projectId,
        requestId: decision.requestId
      });
      expect(service.snapshot().source.files).toEqual(initial.files);
      expectCurrentScenario();
      service = await open();
      expect(service.snapshot().source.files).toEqual(initial.files);
      expectCurrentScenario();
    }
  );

  it('only recognizes the exact built-in screen declaration and never treats it as edit authority', () => {
    const initial = createStarterWorkspace('invalid-starter', 'blank');
    const replaceManifest = (content: string) => ({
      ...initial,
      files: initial.files.map((file) => (file.language === 'json' ? { ...file, content } : file))
    });
    expect(starterPrototypeGraphForWorkspace(replaceManifest('{invalid'))).toBeUndefined();
    expect(
      starterPrototypeGraphForWorkspace(
        replaceManifest(
          JSON.stringify({
            format: 'selene-desktop-preview-data/v1',
            starterTemplate: 'blank',
            initialScreenId: 'canvas',
            screens: [{ id: 'orders', route: '/' }]
          })
        )
      )
    ).toBeUndefined();
    expect(
      starterPrototypeGraphForWorkspace(
        replaceManifest(
          JSON.stringify({
            format: 'selene-desktop-preview-data/v1',
            starterTemplate: 'unknown',
            initialScreenId: 'canvas',
            screens: [{ id: 'canvas', route: '/' }]
          })
        )
      )
    ).toBeUndefined();
  });

  it.each(templates)(
    'does not replace a changed %s starter with the legacy demo source',
    async (template) => {
      const initial = createStarterWorkspace(`changed-${template}`, template);
      const workspace = {
        ...initial,
        files: initial.files.map((file) =>
          file.language === 'json' ? { ...file, content: '{invalid' } : file
        )
      };
      await expect(
        new DeterministicDesignerFixtureAdapter().propose({
          workspace,
          scenario: enterpriseScenarioFixtures[0]!,
          target: undefined,
          instruction: 'Keep my design',
          signal: new AbortController().signal,
          progress: () => undefined
        })
      ).rejects.toThrow('will not replace your design');
    }
  );

  it('keeps small starter text above the WCAG AA contrast threshold', () => {
    const css = createStarterWorkspace('contrast-check', 'dashboard').files.find(
      (file) => file.language === 'css'
    )!.content;
    const color = (selector: string, property: string) => {
      const rule = css.slice(css.indexOf(`${selector}{`) + selector.length + 1).split('}')[0]!;
      const value = rule.match(new RegExp(`(?:^|;)${property}:(#[a-f0-9]{6})(?:;|$)`))?.[1];
      if (!value) throw new Error(`Missing ${selector} ${property}`);
      return value;
    };
    const luminance = (hex: string) => {
      const channels = hex
        .slice(1)
        .match(/../g)!
        .map((channel) => parseInt(channel, 16) / 255)
        .map((channel) =>
          channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
        );
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    };
    for (const selector of [
      '.avatar',
      '.avatar--rose',
      '.avatar--green',
      '.badge',
      '.badge--amber',
      '.badge--green',
      '.blank-mark',
      '.sidebar-current'
    ]) {
      const foreground = luminance(color(selector, 'color'));
      const background = luminance(color(selector, 'background'));
      expect(
        (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
        selector
      ).toBeGreaterThanOrEqual(4.5);
    }
    for (const selector of [
      '.muted',
      '.lede',
      '.eyebrow',
      '.metric-trend',
      '.table-detail',
      '.sample-note',
      '.concept-label',
      '.concept-surface p'
    ]) {
      const foreground = luminance(color(selector, 'color'));
      const background = luminance('#f1f0fb');
      expect(
        (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
        selector
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
