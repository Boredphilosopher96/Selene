import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyAgentSourcePatch } from '@selene/core';
import { ConfiguredProcessDesignerAdapter, parseTrustedAgentConfiguration } from './agent-config';
import { createStarterWorkspace, starterScenariosForWorkspace } from './starter-workspace';

const fixture = fileURLToPath(new URL('../../e2e/designer-agent.fixture.mjs', import.meta.url));

describe('configured native test fixture starter migrations', () => {
  it.each(['success', 'catalog'] as const)(
    'declares every removed Dashboard source node in its %s whole-App rewrite',
    async (mode) => {
      const workspace = createStarterWorkspace(`configured-${mode}`, 'dashboard');
      const configuration = parseTrustedAgentConfiguration({
        version: 'selene-desktop-agents/v1',
        agents: [
          {
            id: `configured-${mode}`,
            label: `Configured ${mode} fixture`,
            command: process.execPath,
            args: [fixture, mode],
            workspaceRoot: process.cwd(),
            readOnly: true,
            capabilityGrants: ['react.revise'],
            designOperation: 'react.revise',
            requestTimeoutMs: 10_000
          }
        ]
      });
      const adapter = new ConfiguredProcessDesignerAdapter(configuration.agents[0]!);
      const scenario = starterScenariosForWorkspace(workspace)![0]!;
      const proposalInput: Parameters<typeof adapter.propose>[0] = {
        instruction: 'Exercise the explicit native test fixture source rewrite.',
        target: {
          format: 'selene-authenticated-artifact-element-target/v1',
          projectId: workspace.projectId,
          nodeRef: 'designer.title',
          revisionId: workspace.revision.id,
          bindingId: 'fixture-only-adapter-input',
          anchor: {
            nodeRef: 'designer.title',
            viewport: { width: 958, height: 642 },
            x: 0.2,
            y: 0.1
          }
        },
        workspace,
        scenario,
        signal: new AbortController().signal,
        progress: () => undefined
      };
      const patch = await adapter.propose(proposalInput);
      const custom = {
        ...workspace,
        files: workspace.files.map((file) =>
          file.path !== workspace.entrypoint
            ? file
            : {
                ...file,
                content: file.content.replace(
                  '<aside className="starter-sidebar"',
                  '<p data-selene-node-id="custom.authored">Custom authored content</p><aside className="starter-sidebar"'
                )
              }
        ),
        nodes: [
          ...workspace.nodes,
          { nodeId: 'custom.authored', path: workspace.entrypoint, exportName: 'App' }
        ]
      };
      await expect(adapter.propose({ ...proposalInput, workspace: custom })).rejects.toThrow(
        'Stable node ID was removed without a mapping: custom.authored'
      );
      const { nodeIdMapping: _mapping, ...withoutMapping } = patch;
      // The same emitted whole-App patch must still fail closed without its
      // deliberate node migration. This fixture never changes that safeguard.
      expect(() =>
        applyAgentSourcePatch(workspace, withoutMapping, {
          id: 'unmapped-fixture',
          createdAt: '2026-10-04T00:00:00.000Z'
        })
      ).toThrow('Stable node ID was removed without a mapping');
      const next = applyAgentSourcePatch(workspace, patch, {
        id: 'mapped-fixture',
        createdAt: '2026-10-04T00:00:00.000Z'
      });
      const nextNodeIds = new Set(next.nodes.map((node) => node.nodeId));
      const removed = workspace.nodes.filter((node) => !nextNodeIds.has(node.nodeId));
      expect(Object.keys(patch.nodeIdMapping ?? {}).sort()).toEqual(
        removed.map((node) => node.nodeId).sort()
      );
      for (const node of removed)
        expect(nextNodeIds.has(patch.nodeIdMapping![node.nodeId]!)).toBe(true);
      expect(next.revision.parentId).toBe(workspace.revision.id);
      expect(next.nodes.some((node) => node.nodeId === 'designer.title')).toBe(true);
      expect(next.files.filter((file) => file.path !== workspace.entrypoint)).toEqual(
        workspace.files
          .filter((file) => file.path !== workspace.entrypoint)
          .sort((a, b) => a.path.localeCompare(b.path))
      );
    }
  );
});
