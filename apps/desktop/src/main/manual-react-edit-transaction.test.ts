import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import {
  serializeCanonicalData,
  migrateDesignRevisionV1,
  createCompilerRenderedInstanceDigest,
  parseDesignEditProposal,
  type DesignEditProposal,
  type ReactCompilerPort,
  type ReactSourceWorkspace
} from '@selene/core';

import {
  CompilerBoundManualReactEditTransactionPort,
  UnavailableManualReactEditTransactionPort
} from './manual-react-edit-transaction';
import type { ManualReactEditAtomicPersistencePort } from './manual-react-edit-transaction';
import { ViteReactCompilerPort } from './react-compiler';
import { issueReactBindingCompilerEvidence } from './react-binding-evidence';

const workspace: ReactSourceWorkspace = {
  format: 'selene-react-workspace/v1',
  projectId: 'orders',
  entrypoint: 'src/App.tsx',
  files: [
    {
      path: 'src/App.tsx',
      language: 'tsx',
      content:
        'export default function App(){return <h1 data-selene-node-id="orders.title">Orders</h1>;}'
    }
  ],
  dependencies: ['react'],
  nodes: [{ nodeId: 'orders.title', path: 'src/App.tsx', exportName: 'default' }],
  revision: { id: 'source-r1', createdAt: '2026-07-27T00:00:00.000Z', summary: 'Initial' }
};

const proposal = {
  base: { projectId: 'orders', revisionId: 'design-r1' }
} as unknown as DesignEditProposal;

describe('manual React edit transaction authority', () => {
  it.each(['single', 'batch'])(
    'compiles one %s duplicate candidate and retains exact undo source metadata on rejection',
    async (mode) => {
      const authored =
        'export default function App(){return <main data-selene-node-id="orders.root" style={{display:"flex"}}><section data-selene-node-id="orders.panel"><h1 data-selene-node-id="orders.title">Orders</h1><input data-selene-node-id="orders.input" type="text" placeholder="Name" disabled /></section><footer data-selene-node-id="orders.footer">End</footer></main>;}';
      const initial: ReactSourceWorkspace = {
        ...workspace,
        files: [{ path: 'src/App.tsx', language: 'tsx', content: authored }],
        nodes: ['orders.root', 'orders.panel', 'orders.title', 'orders.input', 'orders.footer'].map(
          (nodeId) => ({ nodeId, path: 'src/App.tsx', exportName: 'default' })
        )
      };
      let attemptedCommit:
        Parameters<ManualReactEditAtomicPersistencePort['commit']>[0] | undefined;
      const realCompiler = new ViteReactCompilerPort();
      let compilations = 0;
      const compiler: ReactCompilerPort = {
        compile: async (candidate) => {
          compilations += 1;
          return realCompiler.compile(candidate);
        }
      };
      const transaction = new CompilerBoundManualReactEditTransactionPort(compiler, {
        replay: async () => undefined,
        commit: async (request) => {
          attemptedCommit = request;
          throw new Error('Atomic storage unavailable.');
        }
      });
      const evidence = await transaction.compileWorkspace(initial);
      if (evidence === undefined) throw new Error('Real compiler did not issue current evidence.');
      compilations = 0;
      const hash = (value: string) => createHash('sha256').update(value).digest('hex');
      const designRevision = migrateDesignRevisionV1({
        format: 'selene-design-revision/v1',
        tenantId: 'tenant-1',
        projectId: initial.projectId,
        revisionId: 'design-r1',
        sequence: 1,
        createdAt: initial.revision.createdAt,
        tuple: {
          sourceDigest: evidence.sourceDigest,
          bindingDigest: evidence.bindingDigest,
          graphDigest: hash('graph'),
          commandLogDigest: hash('commands'),
          designSystemLockDigest: hash('lock'),
          compiler: {
            format: 'selene-compiler-identity/v1',
            compilerId: evidence.compilerId,
            compilerDigest: evidence.compilerDigest
          },
          preview: {
            format: 'selene-compiled-preview-identity/v1',
            buildId: 'preview-1',
            previewDigest: evidence.previewDigest
          },
          deployment: {
            format: 'selene-deployment-identity/v1',
            state: 'unpublished',
            draftId: 'draft-1',
            manifestDigest: hash('manifest')
          }
        },
        privacy: {
          format: 'selene-design-privacy/v1',
          classification: 'restricted',
          contentDigest: hash('privacy'),
          lifecycle: 'active',
          fields: [],
          retention: { deleteAfter: '2027-07-27T00:00:00.000Z' },
          deletion: { action: 'tombstone', tombstoneDigest: hash('tombstone') },
          exportPolicyDigest: hash('policy'),
          auditCorrelationId: 'audit-1',
          exclusions: ['raw-prompt']
        }
      }).migratedRevision;
      const sourceIdentity = {
        format: 'selene-compiler-source-identity/v1' as const,
        moduleId: `selene-compiler:${hash('src/App.tsx\u0000default').slice(0, 32)}`,
        exportName: 'default',
        astNodeId: 'orders.panel',
        sourceDigest: evidence.sourceDigest,
        bindingDigest: evidence.bindingDigest
      };
      const instance = {
        format: 'selene-compiler-rendered-instance-identity/v1' as const,
        instanceId: 'panel-instance',
        ancestry: ['orders.root'],
        repeat: { kind: 'singleton' as const }
      };
      const duplicate: DesignEditProposal = {
        format: 'selene-design-edit-proposal/v1',
        schemaVersion: 1,
        proposalId: 'duplicate-1',
        commandId: 'duplicate-command',
        actorId: 'designer-1',
        origin: 'manual-canvas',
        operation: {
          format: 'selene-design-revision-operation-reference/v2',
          kind: 'edit',
          tenantId: designRevision.tenantId,
          projectId: initial.projectId,
          actorId: 'designer-1',
          commandId: 'duplicate-command',
          revisionId: designRevision.revisionId,
          tupleBinding: designRevision.tupleBinding,
          revisionCommitment: designRevision.revisionCommitment
        },
        base: designRevision,
        requestedAt: initial.revision.createdAt,
        commands: [
          {
            kind: 'duplicate-node',
            target: {
              format: 'selene-design-edit-target/v1',
              sourceAnchorId: 'orders.panel',
              parentSourceAnchorId: 'orders.root',
              operation: {
                format: 'selene-design-revision-operation-target/v2',
                tenantId: designRevision.tenantId,
                projectId: initial.projectId,
                revisionId: designRevision.revisionId,
                tupleBinding: designRevision.tupleBinding,
                revisionCommitment: designRevision.revisionCommitment,
                node: {
                  format: 'selene-compiler-node-identity/v2',
                  projectId: initial.projectId,
                  nodeId: 'orders.panel',
                  compilerDigest: evidence.compilerDigest,
                  source: sourceIdentity,
                  instance: {
                    ...instance,
                    instanceDigest: createCompilerRenderedInstanceDigest(
                      designRevision,
                      sourceIdentity,
                      instance
                    )
                  }
                }
              }
            },
            sourceAnchorRemaps: ['orders.panel', 'orders.title', 'orders.input'].map((anchor) => ({
              fromSourceAnchorId: anchor,
              toSourceAnchorId: `${anchor}.copy`
            }))
          }
        ],
        preconditions: [
          { kind: 'source-revision', sourceDigest: evidence.sourceDigest },
          { kind: 'binding-revision', bindingDigest: evidence.bindingDigest },
          { kind: 'design-system-lock', designSystemLockDigest: hash('lock') },
          ...['orders.root', 'orders.panel', 'orders.title', 'orders.input'].map(
            (sourceAnchorId) => ({ kind: 'node-exists' as const, sourceAnchorId })
          ),
          { kind: 'parent-is', sourceAnchorId: 'orders.panel', parentSourceAnchorId: 'orders.root' }
        ]
      };
      const panelCommand = duplicate.commands[0];
      if (panelCommand?.kind !== 'duplicate-node') throw new Error('Expected a duplicate command.');
      const footerSource = { ...sourceIdentity, astNodeId: 'orders.footer' };
      const footerInstance = { ...instance, instanceId: 'footer-instance' };
      const footerCommand: typeof panelCommand = {
        ...panelCommand,
        target: {
          ...panelCommand.target,
          sourceAnchorId: 'orders.footer',
          operation: {
            ...panelCommand.target.operation,
            node: {
              ...panelCommand.target.operation.node,
              nodeId: 'orders.footer',
              source: footerSource,
              instance: {
                ...footerInstance,
                instanceDigest: createCompilerRenderedInstanceDigest(
                  designRevision,
                  footerSource,
                  footerInstance
                )
              }
            }
          }
        },
        sourceAnchorRemaps: [
          { fromSourceAnchorId: 'orders.footer', toSourceAnchorId: 'orders.footer.copy' }
        ]
      };
      const selectedProposal =
        mode === 'batch'
          ? {
              ...duplicate,
              commands: [panelCommand, footerCommand],
              preconditions: [
                ...duplicate.preconditions,
                { kind: 'node-exists' as const, sourceAnchorId: 'orders.footer' },
                {
                  kind: 'parent-is' as const,
                  sourceAnchorId: 'orders.footer',
                  parentSourceAnchorId: 'orders.root'
                }
              ]
            }
          : duplicate;
      await expect(
        transaction.evaluateDetailed(parseDesignEditProposal(selectedProposal), {
          workspace: initial,
          designRevision,
          designSystemLockDigest: hash('lock')
        })
      ).resolves.toEqual({
        result: {
          format: 'selene-design-edit-result/v1',
          kind: 'rejected',
          diagnostics: [{ code: 'ATOMIC_PERSISTENCE_UNAVAILABLE' }]
        }
      });
      if (attemptedCommit === undefined)
        throw new Error('Compiled candidate never reached the atomic boundary.');
      expect(compilations).toBe(2); // Current compiler authority plus one combined candidate.
      expect(attemptedCommit.proposal.commands).toHaveLength(mode === 'batch' ? 2 : 1);
      expect(attemptedCommit.baseWorkspace).toEqual(initial);
      expect(attemptedCommit.patch.previousContent).toBe(authored);
      expect(attemptedCommit.patch.addedNodes?.map((node) => node.nodeId)).toEqual([
        'orders.panel.copy',
        'orders.title.copy',
        'orders.input.copy',
        ...(mode === 'batch' ? ['orders.footer.copy'] : [])
      ]);
      expect(attemptedCommit.candidateWorkspace.nodes.map((node) => node.nodeId)).toEqual([
        'orders.footer',
        ...(mode === 'batch' ? ['orders.footer.copy'] : []),
        'orders.input',
        'orders.input.copy',
        'orders.panel',
        'orders.panel.copy',
        'orders.root',
        'orders.title',
        'orders.title.copy'
      ]);
      expect(
        attemptedCommit.candidateWorkspace.files[0]?.content.match(/data-selene-node-id="([^"]+)"/g)
      ).toEqual([
        'data-selene-node-id="orders.root"',
        'data-selene-node-id="orders.panel"',
        'data-selene-node-id="orders.title"',
        'data-selene-node-id="orders.input"',
        'data-selene-node-id="orders.panel.copy"',
        'data-selene-node-id="orders.title.copy"',
        'data-selene-node-id="orders.input.copy"',
        'data-selene-node-id="orders.footer"',
        ...(mode === 'batch' ? ['data-selene-node-id="orders.footer.copy"'] : [])
      ]);
      const artifact = await compiler.compile(attemptedCommit.candidateWorkspace);
      expect(artifact.diagnostics).toEqual([]);
      if (artifact.receipt === undefined) throw new Error('Candidate receipt missing.');
      const candidateBindings = issueReactBindingCompilerEvidence(
        attemptedCommit.candidateWorkspace,
        artifact.receipt
      );
      expect(candidateBindings.nodeMarkers.map((marker) => marker.sourceNodeId).sort()).toEqual(
        attemptedCommit.candidateWorkspace.nodes.map((node) => node.nodeId)
      );
      expect(initial.files[0]?.content).toBe(authored);
      expect(initial.nodes.map((node) => node.nodeId)).toEqual([
        'orders.root',
        'orders.panel',
        'orders.title',
        'orders.input',
        'orders.footer'
      ]);
    }
  );
  it('keeps hosts without the compiler authority explicitly unavailable', async () => {
    await expect(
      new UnavailableManualReactEditTransactionPort().evaluate(proposal, {
        workspace,
        designSystemLockDigest: 'a'.repeat(64)
      })
    ).resolves.toEqual({
      format: 'selene-design-edit-result/v1',
      kind: 'rejected',
      diagnostics: [{ code: 'HOST_BINDING_UNAVAILABLE' }]
    });
  });

  it('does not invoke the compiler or mutate workspace before a host design-revision authority exists', async () => {
    let compilations = 0;
    const transaction = new CompilerBoundManualReactEditTransactionPort({
      compile: async () => {
        compilations += 1;
        throw new Error('compiler must not run');
      }
    });
    const before = serializeCanonicalData(workspace);
    await expect(
      transaction.evaluate(proposal, { workspace, designSystemLockDigest: 'a'.repeat(64) })
    ).resolves.toMatchObject({
      kind: 'rejected',
      diagnostics: [{ code: 'DESIGN_REVISION_UNAVAILABLE' }]
    });
    expect(compilations).toBe(0);
    expect(serializeCanonicalData(workspace)).toBe(before);
  });

  it('keeps hostile compiler diagnostics unreachable without immutable design authority', async () => {
    const transaction = new CompilerBoundManualReactEditTransactionPort({
      compile: async () => ({
        revisionId: workspace.revision.id,
        code: '',
        diagnostics: [
          {
            code: 'MISSING_SOURCE',
            message: '\u001b[31m/Users/designer/private.tsx\u001b[0m',
            path: workspace.entrypoint
          }
        ]
      })
    });
    const before = createHash('sha256').update(serializeCanonicalData(workspace)).digest('hex');
    await expect(
      transaction.evaluate(proposal, {
        workspace,
        designSystemLockDigest: 'a'.repeat(64)
      })
    ).resolves.toEqual({
      format: 'selene-design-edit-result/v1',
      kind: 'rejected',
      diagnostics: [{ code: 'DESIGN_REVISION_UNAVAILABLE' }]
    });
    expect(createHash('sha256').update(serializeCanonicalData(workspace)).digest('hex')).toBe(
      before
    );
  });
});
