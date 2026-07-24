import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ConfiguredProcessDesignerAdapter, parseTrustedAgentConfiguration } from './agent-config';
import { createEmbeddedBuildMetadataPort } from './build-metadata';
import {
  DesktopDesignerApplicationService,
  DeterministicDesignerFixtureAdapter,
  type DesignerAgentAdapter
} from './designer-service';

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
        capabilityGrants: ['react.revise']
      }
    ]
  });
  const agent = configuration.agents[0];
  if (agent === undefined) throw new Error('configured fixture was not created');
  return new ConfiguredProcessDesignerAdapter(agent);
}

describe('desktop designer application service', () => {
  it('takes a spatial AI request through adapter, source validation, revision, and handoff', async () => {
    const service = new DesktopDesignerApplicationService(createEmbeddedBuildMetadataPort());
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const next = await service.requestAIChange({
      agentId: 'fixture-designer',
      instruction: 'Make the target action descriptive.',
      target
    });
    expect(next.aiChangeRequests).toMatchObject([
      { status: 'applied', target: { x: 0.25, scenarioId: 'owner-loading-desktop' } }
    ]);
    expect(next.source.revision.parentId).toBe('desktop-r1');
    expect(next.source.files.find((file) => file.path === 'src/App.tsx')?.content).toContain(
      'history.pushState'
    );
    expect(await service.exportHandoff()).toContain('[accessibility]');
  });

  it('records unavailable custom adapter failures without mutating the source revision', async () => {
    const failing: DesignerAgentAdapter = {
      descriptor: { id: 'offline-agent', label: 'Offline', capabilities: ['react.revise'] },
      async propose() {
        throw new Error('adapter unavailable');
      }
    };
    const service = new DesktopDesignerApplicationService(createEmbeddedBuildMetadataPort());
    service.registerAgent(failing);
    await expect(
      service.requestAIChange({ agentId: 'offline-agent', instruction: 'Change this.', target })
    ).rejects.toThrow('adapter unavailable');
    expect(service.snapshot().aiChangeRequests).toMatchObject([
      { status: 'failed', error: 'adapter unavailable' }
    ]);
    expect(service.snapshot().source.revision.id).toBe('desktop-r1');
  });

  it('records configured JSONL process failures without mutating the source revision', async () => {
    const service = new DesktopDesignerApplicationService(createEmbeddedBuildMetadataPort());
    service.registerAgent(configuredAdapter('failure'));
    await expect(
      service.requestAIChange({
        agentId: 'configured-failure',
        instruction: 'Fail predictably.',
        target
      })
    ).rejects.toThrow('Configured fixture failed');
    expect(service.snapshot().aiChangeRequests).toMatchObject([{ status: 'failed' }]);
    expect(service.snapshot().source.revision.id).toBe('desktop-r1');
  });

  it('cancels a configured JSONL process request without mutating the source revision', async () => {
    const service = new DesktopDesignerApplicationService(createEmbeddedBuildMetadataPort());
    service.registerAgent(configuredAdapter('cancel'));
    service.subscribe((event) => {
      if (event.stage === 'started') setTimeout(() => service.cancel(event.requestId), 10);
    });
    await expect(
      service.requestAIChange({
        agentId: 'configured-cancel',
        instruction: 'Cancel predictably.',
        target
      })
    ).rejects.toThrow(/cancel/i);
    expect(service.snapshot().aiChangeRequests).toMatchObject([{ status: 'cancelled' }]);
    expect(service.snapshot().source.revision.id).toBe('desktop-r1');
  });

  it('returns deep-cloned snapshot data across the application boundary', () => {
    const service = new DesktopDesignerApplicationService(createEmbeddedBuildMetadataPort());
    service.registerAgent(new DeterministicDesignerFixtureAdapter());
    const snapshot = service.snapshot();
    (snapshot.source.files[0] as { content: string }).content = 'mutated outside the service';
    expect(service.snapshot().source.files[0]?.content).not.toBe('mutated outside the service');
  });

  it('accepts only trusted, absolute configured adapter definitions', () => {
    expect(() =>
      parseTrustedAgentConfiguration({
        version: 'selene-desktop-agents/v1',
        agents: [
          {
            id: 'bad',
            label: 'Bad',
            command: 'node',
            args: [],
            workspaceRoot: '/tmp',
            readOnly: true,
            capabilityGrants: ['react.revise']
          }
        ]
      })
    ).toThrow(/absolute executable/);
    expect(() =>
      parseTrustedAgentConfiguration({
        version: 'selene-desktop-agents/v1',
        agents: [
          {
            id: 'bad-capability',
            label: 'Bad',
            command: '/bin/echo',
            args: [],
            workspaceRoot: '/tmp',
            readOnly: true,
            capabilityGrants: ['NOT VALID']
          }
        ]
      })
    ).toThrow(/invalid capability/);
  });
});
