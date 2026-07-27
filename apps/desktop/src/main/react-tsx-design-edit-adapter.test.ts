import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createCompilerRenderedInstanceDigest, migrateDesignRevisionV1 } from '@selene/core';

import {
  prepareReactTsxDesignEdit,
  type ReactTsxDesignEditContext
} from './react-tsx-design-edit-adapter';

const source = `import React from 'react';

// Keep this comment byte-identical.
export default function App() {
  return <main data-selene-node-id="orders.root"><h1 data-selene-node-id="orders.title">Orders</h1></main>;
}
`;

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const sourceDigest = digest(source);
const bindingDigest = digest('binding');
const designSystemLockDigest = digest('design-system');
const compilerDigest = digest('compiler');

const revision = migrateDesignRevisionV1({
  format: 'selene-design-revision/v1',
  tenantId: 'tenant-1',
  projectId: 'orders',
  revisionId: 'revision-1',
  sequence: 1,
  createdAt: '2026-07-27T00:00:00.000Z',
  tuple: {
    sourceDigest,
    graphDigest: digest('graph'),
    bindingDigest,
    commandLogDigest: digest('commands'),
    designSystemLockDigest,
    deployment: {
      format: 'selene-deployment-identity/v1',
      state: 'unpublished',
      draftId: 'draft-1',
      manifestDigest: digest('manifest')
    },
    preview: {
      format: 'selene-compiled-preview-identity/v1',
      buildId: 'preview-1',
      previewDigest: digest('preview')
    },
    compiler: {
      format: 'selene-compiler-identity/v1',
      compilerId: 'typescript-7',
      compilerDigest
    }
  },
  privacy: {
    format: 'selene-design-privacy/v1',
    classification: 'restricted',
    contentDigest: digest('privacy-content'),
    lifecycle: 'active',
    fields: [],
    retention: { deleteAfter: '2026-07-28T00:00:00.000Z' },
    deletion: { action: 'tombstone', tombstoneDigest: digest('tombstone') },
    exportPolicyDigest: digest('export-policy'),
    auditCorrelationId: 'audit-1',
    exclusions: ['raw-prompt']
  }
}).migratedRevision;
const sourceIdentity = {
  format: 'selene-compiler-source-identity/v1',
  moduleId: 'orders-app',
  exportName: 'default',
  astNodeId: 'orders.title',
  sourceDigest,
  bindingDigest
} as const;
const instance = {
  format: 'selene-compiler-rendered-instance-identity/v1',
  instanceId: 'instance-1',
  ancestry: ['orders.root'],
  repeat: { kind: 'singleton' as const }
};

const context = (): ReactTsxDesignEditContext => ({
  sourceDigest,
  bindingDigest,
  designSystemLockDigest,
  sourceBindings: [
    {
      sourceAnchorId: 'orders.title',
      moduleId: 'orders-app',
      path: 'src/App.tsx',
      exportName: 'default',
      sourceDigest,
      bindingDigest
    }
  ],
  workspace: {
    format: 'selene-react-workspace/v1',
    projectId: 'orders',
    entrypoint: 'src/App.tsx',
    files: [{ path: 'src/App.tsx', content: source, language: 'tsx' }],
    dependencies: ['react'],
    nodes: [
      { nodeId: 'orders.root', path: 'src/App.tsx', exportName: 'default' },
      { nodeId: 'orders.title', path: 'src/App.tsx', exportName: 'default' }
    ],
    revision: { id: 'r1', createdAt: '2026-07-27T00:00:00.000Z', summary: 'Initial' }
  }
});

const proposal = () => ({
  format: 'selene-design-edit-proposal/v1',
  schemaVersion: 1,
  proposalId: 'proposal-1',
  commandId: 'command-1',
  actorId: 'designer-1',
  origin: 'manual-canvas',
  operation: {
    format: 'selene-design-revision-operation-reference/v2',
    kind: 'edit',
    tenantId: revision.tenantId,
    projectId: revision.projectId,
    actorId: 'designer-1',
    commandId: 'command-1',
    revisionId: 'revision-1',
    tupleBinding: revision.tupleBinding,
    revisionCommitment: revision.revisionCommitment
  },
  base: revision,
  commands: [
    {
      kind: 'set-content',
      target: {
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
            projectId: 'orders',
            nodeId: 'orders.title',
            compilerDigest,
            source: sourceIdentity,
            instance: {
              ...instance,
              instanceDigest: createCompilerRenderedInstanceDigest(
                revision,
                sourceIdentity,
                instance
              )
            }
          }
        },
        sourceAnchorId: 'orders.title'
      },
      content: 'Open orders'
    }
  ],
  preconditions: [
    { kind: 'source-revision', sourceDigest },
    { kind: 'binding-revision', bindingDigest },
    { kind: 'design-system-lock', designSystemLockDigest }
  ],
  requestedAt: '2026-07-27T00:00:00.000Z'
});

describe('React TSX design edit preparation', () => {
  it('prepares one exact text span without rewriting surrounding source', () => {
    const result = prepareReactTsxDesignEdit(proposal(), context());
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('Expected a prepared edit.');
    expect(result.patch.previousContent).toBe(source);
    expect(result.patch.nextContent).toBe(source.replace('>Orders</h1>', '>Open orders</h1>'));
    expect(result.patch.nextContent).toContain('// Keep this comment byte-identical.');
  });

  it('rejects stale source and binding revisions without producing a patch', () => {
    expect(
      prepareReactTsxDesignEdit(proposal(), { ...context(), sourceDigest: digest('new') })
    ).toEqual({
      kind: 'conflict',
      code: 'STALE_SOURCE'
    });
    expect(
      prepareReactTsxDesignEdit(proposal(), { ...context(), bindingDigest: digest('new') })
    ).toEqual({
      kind: 'conflict',
      code: 'STALE_BINDING'
    });
    expect(
      prepareReactTsxDesignEdit(proposal(), {
        ...context(),
        designSystemLockDigest: digest('new')
      })
    ).toEqual({
      kind: 'conflict',
      code: 'STALE_DESIGN_SYSTEM_LOCK'
    });
  });

  it('rejects malformed proposals and source bindings without a source mutation', () => {
    const current = context();
    expect(prepareReactTsxDesignEdit({ format: 'not-a-proposal' }, current)).toEqual({
      kind: 'rejected',
      code: 'INVALID_PROPOSAL'
    });
    const mismatched = proposal();
    const command = mismatched.commands[0]!;
    const replacementSource = {
      ...command.target.operation.node.source,
      moduleId: 'other-module'
    } as const;
    const replacementInstance = command.target.operation.node.instance;
    const mismatchedProposal = {
      ...mismatched,
      commands: [
        {
          ...command,
          target: {
            ...command.target,
            operation: {
              ...command.target.operation,
              node: {
                ...command.target.operation.node,
                source: replacementSource,
                instance: {
                  ...replacementInstance,
                  instanceDigest: createCompilerRenderedInstanceDigest(
                    revision,
                    replacementSource,
                    replacementInstance
                  )
                }
              }
            }
          }
        }
      ]
    };
    expect(prepareReactTsxDesignEdit(mismatchedProposal, current)).toEqual({
      kind: 'rejected',
      code: 'MISSING_HOST_BINDING'
    });
    expect(current.workspace.files[0]?.content).toBe(source);
  });

  it('rejects an ambiguous marker with byte-identical input source', () => {
    const ambiguous = source.replace(
      '</main>',
      '<h2 data-selene-node-id="orders.title">Duplicate</h2></main>'
    );
    const current = context();
    const input = {
      ...current,
      workspace: {
        ...current.workspace,
        files: [{ path: 'src/App.tsx', content: ambiguous, language: 'tsx' as const }]
      }
    };
    const result = prepareReactTsxDesignEdit(proposal(), input);
    expect(result).toEqual({ kind: 'conflict', code: 'AMBIGUOUS_TARGET' });
    expect(input.workspace.files[0]?.content).toBe(ambiguous);
  });

  it('rejects duplicate host node bindings and cross-project contexts', () => {
    const current = context();
    expect(
      prepareReactTsxDesignEdit(proposal(), {
        ...current,
        workspace: {
          ...current.workspace,
          nodes: [...current.workspace.nodes, current.workspace.nodes[1]!]
        }
      })
    ).toEqual({ kind: 'conflict', code: 'AMBIGUOUS_NODE_BINDING' });
    expect(
      prepareReactTsxDesignEdit(proposal(), {
        ...current,
        workspace: {
          ...current.workspace,
          files: [...current.workspace.files, current.workspace.files[0]!]
        }
      })
    ).toEqual({ kind: 'conflict', code: 'AMBIGUOUS_SOURCE_FILE' });
    expect(
      prepareReactTsxDesignEdit(proposal(), {
        ...current,
        sourceBindings: [...current.sourceBindings, current.sourceBindings[0]!]
      })
    ).toEqual({ kind: 'conflict', code: 'AMBIGUOUS_HOST_BINDING' });
    expect(
      prepareReactTsxDesignEdit(proposal(), {
        ...current,
        workspace: { ...current.workspace, projectId: 'other-project' }
      })
    ).toEqual({ kind: 'conflict', code: 'PROJECT_MISMATCH' });
  });

  it('does not bind a matching marker in a different export', () => {
    const differentExport = source
      .replace('data-selene-node-id="orders.title"', 'data-selene-node-id="other.title"')
      .concat(
        '\nexport function Detached() { return <p data-selene-node-id="orders.title">Wrong</p>; }\n'
      );
    const current = context();
    const input = {
      ...current,
      workspace: {
        ...current.workspace,
        files: [{ path: 'src/App.tsx', content: differentExport, language: 'tsx' as const }]
      }
    };
    expect(prepareReactTsxDesignEdit(proposal(), input)).toEqual({
      kind: 'rejected',
      code: 'MISSING_TARGET'
    });
    expect(input.workspace.files[0]?.content).toBe(differentExport);
  });

  it('rejects expression and mixed JSX children without producing a patch', () => {
    for (const content of [
      source.replace('>Orders</h1>', '>{label}</h1>'),
      source.replace('>Orders</h1>', '>Orders<strong>now</strong></h1>')
    ]) {
      const current = context();
      const input = {
        ...current,
        workspace: {
          ...current.workspace,
          files: [{ path: 'src/App.tsx', content, language: 'tsx' as const }]
        }
      };
      expect(prepareReactTsxDesignEdit(proposal(), input)).toEqual({
        kind: 'rejected',
        code: 'UNSAFE_CHILD'
      });
      expect(input.workspace.files[0]?.content).toBe(content);
    }
  });
});
