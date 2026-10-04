import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createCompilerRenderedInstanceDigest, migrateDesignRevisionV1 } from '@selene/core';

import {
  inspectReactTsxDuplicateTarget,
  prepareReactTsxDesignEdit,
  type ReactTsxDesignEditContext
} from './react-tsx-design-edit-adapter';

const source = `import React from 'react';

// Keep this comment byte-identical.
export default function App() {
  return <main data-selene-node-id="orders.root" style={{ display: 'flex' }}><h1 data-selene-node-id="orders.title">Orders</h1><section data-selene-node-id="orders.secondary" style={{ display: 'grid' }}><p data-selene-node-id="orders.summary">Summary</p></section></main>;
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
  approvedComponents: [],
  sourceBindings: [
    {
      sourceAnchorId: 'orders.root',
      moduleId: 'orders-app',
      path: 'src/App.tsx',
      exportName: 'default',
      sourceDigest,
      bindingDigest
    },
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

const layoutProposal = (
  property:
    | 'display'
    | 'flexDirection'
    | 'justifyContent'
    | 'alignItems'
    | 'gap'
    | 'order'
    | 'width'
    | 'height'
    | 'minWidth'
    | 'minHeight'
    | 'maxWidth'
    | 'maxHeight',
  value: string | number
) => {
  const current = proposal();
  return {
    ...current,
    commands: [
      {
        kind: 'set-layout',
        target: current.commands[0]!.target,
        property,
        value
      }
    ]
  };
};

const componentPropertyProposal = (prop: string, value: string | number | boolean) => {
  const current = proposal();
  return {
    ...current,
    commands: [
      {
        kind: 'set-prop',
        target: current.commands[0]!.target,
        prop,
        value
      }
    ]
  };
};

const appearanceProposal = (
  property:
    | 'color'
    | 'backgroundColor'
    | 'fontFamily'
    | 'fontSize'
    | 'fontWeight'
    | 'lineHeight'
    | 'letterSpacing'
    | 'textAlign'
    | 'borderRadius'
    | 'opacity'
    | 'padding'
    | 'margin',
  value: string | number
) => {
  const current = proposal();
  return {
    ...current,
    commands: [
      {
        kind: 'set-style',
        target: current.commands[0]!.target,
        property,
        value,
        risk: 'raw-style',
        policyDigest: digest('manual-appearance-policy'),
        provenanceDigest: digest('manual-appearance-provenance')
      }
    ]
  };
};

const positionProposal = (left: number, top: number) => {
  const current = proposal();
  const target = current.commands[0]!.target;
  return {
    ...current,
    commands: [
      {
        kind: 'set-style' as const,
        target,
        property: 'left',
        value: left,
        risk: 'raw-style' as const,
        policyDigest: digest('manual-position-policy'),
        provenanceDigest: digest('manual-position-provenance')
      },
      {
        kind: 'set-style' as const,
        target,
        property: 'top',
        value: top,
        risk: 'raw-style' as const,
        policyDigest: digest('manual-position-policy'),
        provenanceDigest: digest('manual-position-provenance')
      }
    ]
  };
};

const reorderProposal = () => {
  const current = proposal();
  const target = {
    ...current.commands[0]!.target,
    parentSourceAnchorId: 'orders.root'
  };
  return {
    ...current,
    commands: [{ kind: 'reorder-child', target, position: 'last' }],
    preconditions: [
      ...current.preconditions,
      {
        kind: 'parent-is',
        sourceAnchorId: 'orders.title',
        parentSourceAnchorId: 'orders.root'
      }
    ]
  };
};

const removeProposal = () => {
  const current = proposal();
  return {
    ...current,
    commands: [
      {
        kind: 'remove-node',
        target: {
          ...current.commands[0]!.target,
          parentSourceAnchorId: 'orders.root'
        }
      }
    ],
    preconditions: [
      ...current.preconditions,
      {
        kind: 'parent-is',
        sourceAnchorId: 'orders.title',
        parentSourceAnchorId: 'orders.root'
      }
    ]
  };
};

const duplicateProposal = (anchors = ['orders.title'], nodeId = 'orders.title') => {
  const current = proposal();
  const nodeSource = { ...sourceIdentity, astNodeId: nodeId };
  const descriptor = { ...instance, instanceId: `instance-${nodeId}` };
  return {
    ...current,
    commands: [
      {
        kind: 'duplicate-node',
        target: {
          ...current.commands[0]!.target,
          sourceAnchorId: nodeId,
          parentSourceAnchorId: 'orders.root',
          operation: {
            ...current.commands[0]!.target.operation,
            node: {
              ...current.commands[0]!.target.operation.node,
              nodeId,
              source: nodeSource,
              instance: {
                ...descriptor,
                instanceDigest: createCompilerRenderedInstanceDigest(
                  revision,
                  nodeSource,
                  descriptor
                )
              }
            }
          }
        },
        sourceAnchorRemaps: anchors.map((anchor) => ({
          fromSourceAnchorId: anchor,
          toSourceAnchorId: `${anchor}.copy`
        }))
      }
    ],
    preconditions: [
      ...current.preconditions,
      ...['orders.root', ...anchors].map((sourceAnchorId) => ({
        kind: 'node-exists',
        sourceAnchorId
      })),
      { kind: 'parent-is', sourceAnchorId: nodeId, parentSourceAnchorId: 'orders.root' }
    ]
  };
};

describe('static compiler-bound duplication', () => {
  it('duplicates disjoint static siblings from the original AST in one patch independent of command order', () => {
    const current = context();
    const nodes = ['orders.root', 'orders.title', 'orders.secondary', 'orders.summary'].map(
      (nodeId) => ({ nodeId, path: 'src/App.tsx', exportName: 'default' })
    );
    const bound: ReactTsxDesignEditContext = {
      ...current,
      workspace: { ...current.workspace, nodes },
      sourceBindings: nodes.map((node) => ({
        ...current.sourceBindings[0]!,
        sourceAnchorId: node.nodeId
      }))
    };
    const title = duplicateProposal();
    const secondary = duplicateProposal(['orders.secondary', 'orders.summary'], 'orders.secondary');
    const preconditions = [...title.preconditions, ...secondary.preconditions].filter(
      (entry, index, entries) =>
        entries.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(entry)) ===
        index
    );
    const batch = { ...title, commands: [...secondary.commands, ...title.commands], preconditions };
    const result = prepareReactTsxDesignEdit(batch, bound);
    if (result.kind !== 'prepared') throw new Error(`Batch duplicate unavailable: ${result.code}`);
    expect(result.proposal.commands).toHaveLength(2);
    expect(result.patch.nextContent).toBe(
      source
        .replace(
          '<h1 data-selene-node-id="orders.title">Orders</h1>',
          '<h1 data-selene-node-id="orders.title">Orders</h1><h1 data-selene-node-id="orders.title.copy">Orders</h1>'
        )
        .replace(
          '<section data-selene-node-id="orders.secondary" style={{ display: \'grid\' }}><p data-selene-node-id="orders.summary">Summary</p></section>',
          '<section data-selene-node-id="orders.secondary" style={{ display: \'grid\' }}><p data-selene-node-id="orders.summary">Summary</p></section><section data-selene-node-id="orders.secondary.copy" style={{ display: \'grid\' }}><p data-selene-node-id="orders.summary.copy">Summary</p></section>'
        )
    );
    expect(result.patch.addedNodes?.map((node) => node.nodeId)).toEqual([
      'orders.secondary.copy',
      'orders.summary.copy',
      'orders.title.copy'
    ]);
    const reversed = prepareReactTsxDesignEdit(
      { ...batch, commands: [...title.commands, ...secondary.commands] },
      bound
    );
    expect(reversed.kind === 'prepared' ? reversed.patch.nextContent : reversed).toBe(
      result.patch.nextContent
    );
    const unsafe = {
      ...bound,
      workspace: {
        ...bound.workspace,
        files: [
          {
            path: 'src/App.tsx',
            language: 'tsx' as const,
            content: source.replace(
              'data-selene-node-id="orders.summary"',
              'data-selene-node-id="orders.summary" onClick={save}'
            )
          }
        ]
      }
    };
    expect(prepareReactTsxDesignEdit(batch, unsafe)).toEqual({
      kind: 'rejected',
      code: 'UNSAFE_DUPLICATE'
    });
    expect(bound.workspace.files[0]?.content).toBe(source);
  });

  it('rejects overlapping roots, different parents and more than64 total mapped anchors atomically', () => {
    const title = duplicateProposal();
    const second = {
      ...title.commands[0]!,
      sourceAnchorRemaps: [
        { fromSourceAnchorId: 'orders.title', toSourceAnchorId: 'orders.title.second-copy' }
      ]
    };
    expect(
      prepareReactTsxDesignEdit({ ...title, commands: [...title.commands, second] }, context())
    ).toEqual({ kind: 'rejected', code: 'UNSAFE_DUPLICATE' });
    const elsewhere = duplicateProposal(['orders.secondary'], 'orders.secondary');
    const command = {
      ...elsewhere.commands[0]!,
      target: { ...elsewhere.commands[0]!.target, parentSourceAnchorId: 'another.parent' }
    };
    const different = {
      ...title,
      commands: [...title.commands, command],
      preconditions: [
        ...title.preconditions,
        { kind: 'node-exists', sourceAnchorId: 'orders.secondary' },
        { kind: 'node-exists', sourceAnchorId: 'another.parent' },
        {
          kind: 'parent-is',
          sourceAnchorId: 'orders.secondary',
          parentSourceAnchorId: 'another.parent'
        }
      ]
    };
    expect(prepareReactTsxDesignEdit(different, context())).toEqual({
      kind: 'rejected',
      code: 'UNSAFE_DUPLICATE'
    });
    const firstAnchors = [
      'orders.title',
      ...Array.from({ length: 32 }, (_, index) => `first-${index}`)
    ];
    const secondAnchors = [
      'orders.secondary',
      ...Array.from({ length: 31 }, (_, index) => `second-${index}`)
    ];
    const first = duplicateProposal(firstAnchors);
    const last = duplicateProposal(secondAnchors, 'orders.secondary');
    const preconditions = [...first.preconditions, ...last.preconditions].filter(
      (entry, index, entries) =>
        entries.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(entry)) ===
        index
    );
    expect(
      prepareReactTsxDesignEdit(
        { ...first, commands: [...first.commands, ...last.commands], preconditions },
        context()
      )
    ).toEqual({ kind: 'rejected', code: 'UNSAFE_DUPLICATE' });
  });
  it('duplicates exact authored markup after the target and assigns every descendant a fresh marker', () => {
    const current = context();
    const subtree =
      '<h1 data-selene-node-id="orders.title" style={{ color: "red", opacity: 0.8 }}><span data-selene-node-id={"orders.detail"}>Orders &amp; details</span><br />{42}{/* preserve comment */}</h1>';
    const authored = source.replace('<h1 data-selene-node-id="orders.title">Orders</h1>', subtree);
    const bound: ReactTsxDesignEditContext = {
      ...current,
      sourceBindings: [
        ...current.sourceBindings,
        { ...current.sourceBindings[1]!, sourceAnchorId: 'orders.detail' }
      ],
      workspace: {
        ...current.workspace,
        files: [{ path: 'src/App.tsx', content: authored, language: 'tsx' }],
        nodes: [
          ...current.workspace.nodes,
          { nodeId: 'orders.detail', path: 'src/App.tsx', exportName: 'default' }
        ]
      }
    };
    expect(inspectReactTsxDuplicateTarget(bound.workspace, 'orders.title')).toEqual({
      kind: 'supported',
      parentSourceAnchorId: 'orders.root',
      sourceAnchorIds: ['orders.detail', 'orders.title']
    });
    const result = prepareReactTsxDesignEdit(
      duplicateProposal(['orders.title', 'orders.detail']),
      bound
    );
    if (result.kind !== 'prepared') throw new Error(`Duplicate unavailable: ${result.code}`);
    const cloned = subtree
      .replace('"orders.title"', '"orders.title.copy"')
      .replace('"orders.detail"', '"orders.detail.copy"');
    expect(result.patch.nextContent).toBe(authored.replace(subtree, `${subtree}${cloned}`));
    expect(result.patch.previousContent).toBe(authored);
    expect(result.patch.addedNodes).toEqual([
      { nodeId: 'orders.title.copy', path: 'src/App.tsx', exportName: 'default' },
      { nodeId: 'orders.detail.copy', path: 'src/App.tsx', exportName: 'default' }
    ]);
    expect(bound.workspace.files[0]?.content).toBe(authored);
    expect(prepareReactTsxDesignEdit(duplicateProposal(), bound)).toEqual({
      kind: 'rejected',
      code: 'SOURCE_BINDING_MISMATCH'
    });
  });

  it('rejects identity associations, executable props and dynamic boundaries without changing source', () => {
    const current = context();
    for (const replacement of [
      '<h1 data-selene-node-id="orders.title" id="title">Orders</h1>',
      '<label data-selene-node-id="orders.title" htmlFor="field">Orders</label>',
      '<h1 data-selene-node-id="orders.title" aria-labelledby="title">Orders</h1>',
      '<h1 data-selene-node-id="orders.title" onClick={() => save()}>Orders</h1>',
      '<h1 data-selene-node-id="orders.title" ref={titleRef}>Orders</h1>',
      '<h1 data-selene-node-id="orders.title" {...props}>Orders</h1>',
      '<h1 data-selene-node-id="orders.title">{orders.map(renderOrder)}</h1>',
      '<Title data-selene-node-id="orders.title">Orders</Title>',
      '<h1 data-selene-node-id="orders.title" data-selene-action-port="save">Orders</h1>',
      '<h1 data-selene-node-id="orders.title">Orders</h1>{showSummary && <p>Summary</p>}'
    ]) {
      const content = source.replace(
        '<h1 data-selene-node-id="orders.title">Orders</h1>',
        replacement
      );
      const bound = {
        ...current,
        workspace: {
          ...current.workspace,
          files: [{ path: 'src/App.tsx', content, language: 'tsx' as const }]
        }
      };
      expect(prepareReactTsxDesignEdit(duplicateProposal(), bound)).toEqual({
        kind: 'rejected',
        code: 'UNSAFE_DUPLICATE'
      });
      expect(bound.workspace.files[0]?.content).toBe(content);
    }
  });

  it('rejects root duplication, marker collisions, stale authority and missing descendant bindings', () => {
    const current = context();
    expect(inspectReactTsxDuplicateTarget(current.workspace, 'orders.root')).toEqual({
      kind: 'unavailable',
      code: 'UNSUPPORTED_CONTAINER'
    });
    expect(
      prepareReactTsxDesignEdit(duplicateProposal(), {
        ...current,
        sourceDigest: digest('changed')
      })
    ).toEqual({ kind: 'conflict', code: 'STALE_SOURCE' });
    expect(
      prepareReactTsxDesignEdit(duplicateProposal(), {
        ...current,
        sourceBindings: current.sourceBindings.filter(
          (binding) => binding.sourceAnchorId !== 'orders.root'
        )
      })
    ).toEqual({ kind: 'rejected', code: 'SOURCE_BINDING_MISMATCH' });
    const collision = {
      ...current,
      workspace: {
        ...current.workspace,
        files: [
          ...current.workspace.files,
          {
            path: 'src/Other.tsx',
            content:
              'export default function Other(){return <div data-selene-node-id="orders.title.copy"/>}',
            language: 'tsx' as const
          }
        ]
      }
    };
    expect(prepareReactTsxDesignEdit(duplicateProposal(), collision)).toEqual({
      kind: 'rejected',
      code: 'DUPLICATE_IDENTITY_CONFLICT'
    });
    const repeated = source.replace(
      '</main>',
      '<h2 data-selene-node-id="orders.title">Repeated</h2></main>'
    );
    expect(
      prepareReactTsxDesignEdit(duplicateProposal(), {
        ...current,
        workspace: {
          ...current.workspace,
          files: [{ path: 'src/App.tsx', content: repeated, language: 'tsx' }]
        }
      })
    ).toEqual({ kind: 'conflict', code: 'AMBIGUOUS_TARGET' });
  });
});

const reparentProposal = () => {
  const current = proposal();
  const target = {
    ...current.commands[0]!.target,
    parentSourceAnchorId: 'orders.root'
  };
  return {
    ...current,
    commands: [
      {
        kind: 'reparent-child',
        target,
        newParentSourceAnchorId: 'orders.secondary',
        position: { beforeSourceAnchorId: 'orders.summary' }
      }
    ],
    preconditions: [
      ...current.preconditions,
      {
        kind: 'node-exists',
        sourceAnchorId: 'orders.secondary'
      },
      {
        kind: 'parent-is',
        sourceAnchorId: 'orders.title',
        parentSourceAnchorId: 'orders.root'
      },
      {
        kind: 'parent-is',
        sourceAnchorId: 'orders.summary',
        parentSourceAnchorId: 'orders.secondary'
      }
    ]
  };
};

const insertComponentProposal = () => {
  const current = proposal();
  const rootSource = {
    ...sourceIdentity,
    astNodeId: 'orders.root'
  };
  const rootInstance = {
    ...instance,
    instanceId: 'instance-root'
  };
  return {
    ...current,
    commands: [
      {
        kind: 'insert-child',
        target: {
          ...current.commands[0]!.target,
          sourceAnchorId: 'orders.root',
          operation: {
            ...current.commands[0]!.target.operation,
            node: {
              ...current.commands[0]!.target.operation.node,
              nodeId: 'orders.root',
              source: rootSource,
              instance: {
                ...rootInstance,
                instanceDigest: createCompilerRenderedInstanceDigest(
                  revision,
                  rootSource,
                  rootInstance
                )
              }
            }
          }
        },
        component: {
          packageName: '@acme/design-system',
          entrypoint: './button',
          exportName: 'Button',
          version: '3.2.1',
          artifactDigest: digest('acme-design-system')
        },
        props: {
          disabled: false,
          label: 'Open "orders" <now> & safely',
          priority: 2
        },
        newSourceAnchorId: 'orders.primary-action',
        position: { beforeSourceAnchorId: 'orders.secondary' }
      }
    ],
    preconditions: [
      ...current.preconditions,
      { kind: 'node-exists', sourceAnchorId: 'orders.secondary' },
      {
        kind: 'parent-is',
        sourceAnchorId: 'orders.secondary',
        parentSourceAnchorId: 'orders.root'
      }
    ]
  };
};

const replaceComponentProposal = () => {
  const current = proposal();
  return {
    ...current,
    commands: [
      {
        kind: 'replace-component',
        target: current.commands[0]!.target,
        component: {
          packageName: '@acme/design-system',
          entrypoint: './heading',
          exportName: 'Heading',
          version: '3.2.1',
          artifactDigest: digest('acme-design-system')
        },
        props: { level: 1, tone: 'strong' }
      }
    ]
  };
};

describe('React TSX design edit preparation', () => {
  it('prepares one exact text span without rewriting surrounding source', () => {
    const result = prepareReactTsxDesignEdit(proposal(), context());
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('Expected a prepared edit.');
    expect(result.patch.previousContent).toBe(source);
    expect(result.patch.nextContent).toBe(source.replace('>Orders</h1>', '>Open orders</h1>'));
    expect(result.patch.nextContent).toContain('// Keep this comment byte-identical.');
  });

  it('removes exactly one compiler-bound React element and records its stable identity', () => {
    const prepared = prepareReactTsxDesignEdit(removeProposal(), context());
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') throw new Error('Expected a prepared element removal.');
    expect(prepared.patch.removedNodeIds).toEqual(['orders.title']);
    expect(prepared.patch.nextContent).not.toContain('<h1');
    expect(prepared.patch.nextContent).toContain(
      '<main data-selene-node-id="orders.root" style={{ display: \'flex\' }}><section'
    );
    expect(prepared.patch.nextContent).toContain('// Keep this comment byte-identical.');
  });

  it('rejects removal when the claimed parent differs from the actual source parent', () => {
    const current = removeProposal();
    const wrongParent = {
      ...current,
      commands: [
        {
          ...current.commands[0]!,
          target: {
            ...current.commands[0]!.target,
            parentSourceAnchorId: 'orders.secondary'
          }
        }
      ],
      preconditions: current.preconditions.map((condition) =>
        condition.kind === 'parent-is'
          ? { ...condition, parentSourceAnchorId: 'orders.secondary' }
          : condition
      )
    };
    expect(prepareReactTsxDesignEdit(wrongParent, context())).toEqual({
      kind: 'rejected',
      code: 'UNSUPPORTED_CONTAINER'
    });
  });

  it('records every mapped descendant removed with a JSX subtree', () => {
    const nested = source.replace(
      '>Orders</h1>',
      '>Orders<span data-selene-node-id="orders.title-label">Label</span></h1>'
    );
    const current = context();
    const prepared = prepareReactTsxDesignEdit(removeProposal(), {
      ...current,
      workspace: {
        ...current.workspace,
        files: [{ path: 'src/App.tsx', content: nested, language: 'tsx' }]
      }
    });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') throw new Error('Expected a prepared subtree removal.');
    expect(prepared.patch.removedNodeIds).toEqual(['orders.title', 'orders.title-label']);
    expect(prepared.patch.nextContent).not.toContain('orders.title');
    expect(prepared.patch.nextContent).toContain('orders.summary');
  });

  it('removes a self-closing mapped element without accepting an ambiguous marker', () => {
    const selfClosing = source.replace(
      '<h1 data-selene-node-id="orders.title">Orders</h1>',
      '<OrderTitle data-selene-node-id="orders.title" />'
    );
    const current = context();
    const prepared = prepareReactTsxDesignEdit(removeProposal(), {
      ...current,
      workspace: {
        ...current.workspace,
        files: [{ path: 'src/App.tsx', content: selfClosing, language: 'tsx' }]
      }
    });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') throw new Error('Expected a self-closing element removal.');
    expect(prepared.patch.nextContent).not.toContain('<OrderTitle');

    const ambiguous = selfClosing.replace(
      '</main>',
      '<OrderTitle data-selene-node-id="orders.title" /></main>'
    );
    expect(
      prepareReactTsxDesignEdit(removeProposal(), {
        ...current,
        workspace: {
          ...current.workspace,
          files: [{ path: 'src/App.tsx', content: ambiguous, language: 'tsx' }]
        }
      })
    ).toEqual({ kind: 'conflict', code: 'AMBIGUOUS_TARGET' });
  });

  it('inserts only an exact host-approved package component with a fresh stable marker', () => {
    const input = insertComponentProposal();
    const approved = {
      packageName: '@acme/design-system',
      entrypoint: './button',
      exportName: 'Button',
      version: '3.2.1',
      artifactDigest: digest('acme-design-system')
    };
    const result = prepareReactTsxDesignEdit(input, {
      ...context(),
      approvedComponents: [approved]
    });
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('Expected a prepared component insertion.');
    expect(result.patch.nextContent).toContain(
      'import { Button } from "@acme/design-system/button";'
    );
    expect(result.patch.nextContent).toContain(
      '<Button disabled={false} label="Open &quot;orders&quot; &lt;now&gt; &amp; safely" priority={2} data-selene-node-id="orders.primary-action" /><section'
    );
    expect(result.patch.dependency).toBe('@acme/design-system/button');
    expect(result.patch.addedNodes).toEqual([
      {
        nodeId: 'orders.primary-action',
        path: 'src/App.tsx',
        exportName: 'default'
      }
    ]);
    // Replaying the same approved proposal before persistence is deterministic:
    // the host can safely deduplicate it by its proposal digest.
    expect(
      prepareReactTsxDesignEdit(input, { ...context(), approvedComponents: [approved] })
    ).toEqual(result);

    expect(prepareReactTsxDesignEdit(input, context())).toEqual({
      kind: 'rejected',
      code: 'UNAPPROVED_COMPONENT'
    });
    expect(
      prepareReactTsxDesignEdit(input, {
        ...context(),
        approvedComponents: [{ ...approved, artifactDigest: digest('forged') }]
      })
    ).toEqual({ kind: 'rejected', code: 'UNAPPROVED_COMPONENT' });
  });

  it('replaces one mapped element with an approved component while preserving its children and marker', () => {
    const input = replaceComponentProposal();
    const approved = {
      packageName: '@acme/design-system',
      entrypoint: './heading',
      exportName: 'Heading',
      version: '3.2.1',
      artifactDigest: digest('acme-design-system')
    };
    const result = prepareReactTsxDesignEdit(input, {
      ...context(),
      approvedComponents: [approved]
    });
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('Expected a prepared component replacement.');
    expect(result.patch.nextContent).toContain(
      'import { Heading } from "@acme/design-system/heading";'
    );
    expect(result.patch.nextContent).toContain(
      '<Heading level={1} tone="strong" data-selene-node-id="orders.title">Orders</Heading>'
    );
    expect(result.patch.nextContent).toContain('// Keep this comment byte-identical.');
    expect(result.patch.dependency).toBe('@acme/design-system/heading');
    expect(result.patch.addedNodes).toBeUndefined();
    const selfClosingSource = source.replace(
      '<h1 data-selene-node-id="orders.title">Orders</h1>',
      '<OrderHeading data-selene-node-id="orders.title" />'
    );
    const current = context();
    const selfClosing = prepareReactTsxDesignEdit(input, {
      ...current,
      approvedComponents: [approved],
      workspace: {
        ...current.workspace,
        files: [{ path: 'src/App.tsx', content: selfClosingSource, language: 'tsx' }]
      }
    });
    expect(selfClosing.kind).toBe('prepared');
    if (selfClosing.kind !== 'prepared')
      throw new Error('Expected a self-closing component replacement.');
    expect(selfClosing.patch.nextContent).toContain(
      '<Heading level={1} tone="strong" data-selene-node-id="orders.title" />'
    );
    expect(prepareReactTsxDesignEdit(input, context())).toEqual({
      kind: 'rejected',
      code: 'UNAPPROVED_COMPONENT'
    });
  });

  it('adds or replaces one declared literal component prop without rewriting unrelated JSX', () => {
    const added = prepareReactTsxDesignEdit(
      componentPropertyProposal('tone', 'secondary'),
      context()
    );
    expect(added.kind).toBe('prepared');
    if (added.kind !== 'prepared') throw new Error('Expected a prepared component property edit.');
    expect(added.patch.nextContent).toContain(
      '<h1 data-selene-node-id="orders.title" tone={"secondary"}>Orders</h1>'
    );
    expect(added.patch.nextContent).toContain('// Keep this comment byte-identical.');

    const expressionSource = source.replace(
      'data-selene-node-id="orders.title"',
      'data-selene-node-id="orders.title" {...headingProps} tone={theme.tone}'
    );
    const current = context();
    const updated = prepareReactTsxDesignEdit(componentPropertyProposal('tone', 'primary'), {
      ...current,
      workspace: {
        ...current.workspace,
        files: [{ path: 'src/App.tsx', content: expressionSource, language: 'tsx' }]
      }
    });
    expect(updated.kind).toBe('prepared');
    if (updated.kind !== 'prepared') throw new Error('Expected an updated component property.');
    expect(updated.patch.nextContent).toContain('{...headingProps} tone={"primary"}>Orders</h1>');

    const selfClosingSource = source.replace(
      '<h1 data-selene-node-id="orders.title">Orders</h1>',
      '<Heading data-selene-node-id="orders.title" />'
    );
    const selfClosing = prepareReactTsxDesignEdit(componentPropertyProposal('level', 2), {
      ...current,
      workspace: {
        ...current.workspace,
        files: [{ path: 'src/App.tsx', content: selfClosingSource, language: 'tsx' }]
      }
    });
    expect(selfClosing.kind).toBe('prepared');
    if (selfClosing.kind !== 'prepared')
      throw new Error('Expected a self-closing component property edit.');
    expect(selfClosing.patch.nextContent).toContain(
      '<Heading data-selene-node-id="orders.title" level={2} />'
    );
  });

  it('adds and updates bounded inline layout without rewriting the component', () => {
    const added = prepareReactTsxDesignEdit(layoutProposal('width', '320px'), context());
    expect(added.kind).toBe('prepared');
    if (added.kind !== 'prepared') throw new Error('Expected a prepared layout edit.');
    expect(added.patch.nextContent).toContain(
      '<h1 data-selene-node-id="orders.title" style={{ width: "320px" }}>Orders</h1>'
    );
    expect(added.patch.nextContent).toContain('// Keep this comment byte-identical.');

    const styled = source.replace(
      'data-selene-node-id="orders.title"',
      'data-selene-node-id="orders.title" style={{ width: "240px", gap: 8 }}'
    );
    const styledContext = context();
    const updated = prepareReactTsxDesignEdit(layoutProposal('gap', '1.5rem'), {
      ...styledContext,
      workspace: {
        ...styledContext.workspace,
        files: [{ path: 'src/App.tsx', content: styled, language: 'tsx' }]
      }
    });
    expect(updated.kind).toBe('prepared');
    if (updated.kind !== 'prepared') throw new Error('Expected an updated layout edit.');
    expect(updated.patch.nextContent).toContain('style={{ width: "240px", gap: "1.5rem" }}');

    const flex = prepareReactTsxDesignEdit(
      layoutProposal('justifyContent', 'space-between'),
      context()
    );
    expect(flex.kind).toBe('prepared');
    if (flex.kind !== 'prepared') throw new Error('Expected a prepared flex layout edit.');
    expect(flex.patch.nextContent).toContain('style={{ justifyContent: "space-between" }}');

    const order = prepareReactTsxDesignEdit(layoutProposal('order', '12'), context());
    expect(order.kind).toBe('prepared');
    if (order.kind !== 'prepared') throw new Error('Expected a prepared order edit.');
    expect(order.patch.nextContent).toContain('style={{ order: 12 }}');
  });

  it('rejects executable, unbounded, and expression-backed layout values', () => {
    for (const value of ['calc(100% - 1px)', 'url(https://example.test)', -1, 100_001]) {
      expect(prepareReactTsxDesignEdit(layoutProposal('width', value), context())).toEqual({
        kind: 'rejected',
        code: 'UNSUPPORTED_STYLE_VALUE'
      });
    }
    expect(prepareReactTsxDesignEdit(layoutProposal('display', 'absolute'), context())).toEqual({
      kind: 'rejected',
      code: 'UNSUPPORTED_STYLE_VALUE'
    });
    const expressionStyle = source.replace(
      'data-selene-node-id="orders.title"',
      'data-selene-node-id="orders.title" style={styles.title}'
    );
    const current = context();
    expect(
      prepareReactTsxDesignEdit(layoutProposal('width', '320px'), {
        ...current,
        workspace: {
          ...current.workspace,
          files: [{ path: 'src/App.tsx', content: expressionStyle, language: 'tsx' }]
        }
      })
    ).toEqual({ kind: 'rejected', code: 'UNSAFE_STYLE' });
  });

  it('updates only existing authored absolute or fixed coordinates as one source patch', () => {
    const styled = source.replace(
      'data-selene-node-id="orders.title"',
      'data-selene-node-id="orders.title" style={{ position: "absolute", left: -24, top: -72, color: theme.color }}'
    );
    const current = context();
    const prepared = prepareReactTsxDesignEdit(positionProposal(-56, -88), {
      ...current,
      workspace: {
        ...current.workspace,
        files: [{ path: 'src/App.tsx', content: styled, language: 'tsx' }]
      }
    });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') throw new Error('Expected an authored position edit.');
    expect(prepared.patch.nextContent).toContain(
      'style={{ position: "absolute", left: -56, top: -88, color: theme.color }}'
    );
    expect(prepared.patch.nextContent).toContain('// Keep this comment byte-identical.');

    const staticResult = prepareReactTsxDesignEdit(positionProposal(56, 88), context());
    expect(staticResult).toEqual({ kind: 'rejected', code: 'UNSAFE_STYLE' });

    const relative = source.replace(
      'data-selene-node-id="orders.title"',
      'data-selene-node-id="orders.title" style={{ position: "relative", left: 24, top: 72 }}'
    );
    expect(
      prepareReactTsxDesignEdit(positionProposal(56, 88), {
        ...current,
        workspace: {
          ...current.workspace,
          files: [{ path: 'src/App.tsx', content: relative, language: 'tsx' }]
        }
      })
    ).toEqual({ kind: 'rejected', code: 'UNSAFE_STYLE' });

    const hostile = positionProposal(56, 88);
    const top = hostile.commands[1];
    if (top === undefined) throw new Error('Position fixture must have a top command.');
    const hostileTarget = { ...top.target, parentSourceAnchorId: 'orders.root' };
    hostile.commands[1] = {
      ...top,
      target: hostileTarget
    };
    expect(
      prepareReactTsxDesignEdit(hostile, {
        ...current,
        workspace: {
          ...current.workspace,
          files: [{ path: 'src/App.tsx', content: styled, language: 'tsx' }]
        }
      })
    ).toEqual({ kind: 'rejected', code: 'UNSUPPORTED_COMMAND' });

    for (const style of [
      '{ ...placement, position: "absolute", left: 24, top: 72 }',
      '{ [positionProperty]: "absolute", left: 24, top: 72 }',
      '{ position: "absolute", left, top: 72 }'
    ]) {
      const ambiguous = source.replace(
        'data-selene-node-id="orders.title"',
        `data-selene-node-id="orders.title" style={${style}}`
      );
      expect(
        prepareReactTsxDesignEdit(positionProposal(56, 88), {
          ...current,
          workspace: {
            ...current.workspace,
            files: [{ path: 'src/App.tsx', content: ambiguous, language: 'tsx' }]
          }
        })
      ).toEqual({ kind: 'rejected', code: 'UNSAFE_STYLE' });
    }
  });

  it('adds and updates approved appearance values without rewriting the component', () => {
    const color = prepareReactTsxDesignEdit(appearanceProposal('color', '#2457ff'), context());
    expect(color.kind).toBe('prepared');
    if (color.kind !== 'prepared') throw new Error('Expected a prepared appearance edit.');
    expect(color.patch.nextContent).toContain('style={{ color: "#2457ff" }}');
    expect(color.patch.nextContent).toContain('// Keep this comment byte-identical.');

    const styled = source.replace(
      'data-selene-node-id="orders.title"',
      'data-selene-node-id="orders.title" style={{ color: "#111111", padding: "4px" }}'
    );
    const styledContext = context();
    const padding = prepareReactTsxDesignEdit(appearanceProposal('padding', '8px 12px'), {
      ...styledContext,
      workspace: {
        ...styledContext.workspace,
        files: [{ path: 'src/App.tsx', content: styled, language: 'tsx' }]
      }
    });
    expect(padding.kind).toBe('prepared');
    if (padding.kind !== 'prepared') throw new Error('Expected an updated appearance edit.');
    expect(padding.patch.nextContent).toContain(
      'style={{ color: "#111111", padding: "8px 12px" }}'
    );

    const weight = prepareReactTsxDesignEdit(appearanceProposal('fontWeight', '600'), context());
    expect(weight.kind).toBe('prepared');
    if (weight.kind !== 'prepared') throw new Error('Expected a numeric font weight edit.');
    expect(weight.patch.nextContent).toContain('style={{ fontWeight: 600 }}');
  });

  it('rejects executable, malformed, and unapproved appearance values', () => {
    for (const [property, value] of [
      ['color', 'url(https://example.test/pixel)'],
      ['backgroundColor', 'expression(alert(1))'],
      ['fontFamily', 'Inter; background: red'],
      ['padding', 'calc(100% - 1px)'],
      ['opacity', 2]
    ] as const)
      expect(prepareReactTsxDesignEdit(appearanceProposal(property, value), context())).toEqual({
        kind: 'rejected',
        code: 'UNSUPPORTED_STYLE_VALUE'
      });

    const unapproved = appearanceProposal('color', '#2457ff');
    const command = unapproved.commands[0]!;
    expect(
      prepareReactTsxDesignEdit(
        {
          ...unapproved,
          commands: [{ ...command, property: 'backgroundImage', value: 'none' }]
        },
        context()
      )
    ).toEqual({ kind: 'rejected', code: 'UNSUPPORTED_STYLE_VALUE' });
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
    // The digest helper accepts the descriptor form, which intentionally omits
    // the derived instanceDigest field present in a compiler-issued identity.
    const replacementInstance = { ...instance };
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
        sourceBindings: [
          ...current.sourceBindings,
          current.sourceBindings.find((binding) => binding.sourceAnchorId === 'orders.title')!
        ]
      })
    ).toEqual({ kind: 'conflict', code: 'AMBIGUOUS_HOST_BINDING' });
    expect(
      prepareReactTsxDesignEdit(proposal(), {
        ...current,
        workspace: { ...current.workspace, projectId: 'other-project' }
      })
    ).toEqual({ kind: 'conflict', code: 'PROJECT_MISMATCH' });
  });

  it('rejects duplicate workspace source paths instead of choosing one', () => {
    const current = context();
    expect(
      prepareReactTsxDesignEdit(proposal(), {
        ...current,
        workspace: {
          ...current.workspace,
          files: [...current.workspace.files, current.workspace.files[0]!]
        }
      })
    ).toEqual({ kind: 'conflict', code: 'AMBIGUOUS_SOURCE_FILE' });
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

  it('moves a compiler-bound child deterministically within a literal flex container', () => {
    const result = prepareReactTsxDesignEdit(reorderProposal(), context());
    expect(result).toMatchObject({ kind: 'prepared', patch: { path: 'src/App.tsx' } });
    if (result.kind !== 'prepared') throw new Error('Expected a prepared semantic reorder.');
    expect(result.patch.nextContent).toContain(
      '</section><h1 data-selene-node-id="orders.title">Orders</h1>'
    );
    expect(result.patch.nextContent).toContain('data-selene-node-id="orders.title"');
  });

  it('moves a compiler-bound child before a mapped child in a literal compatible container', () => {
    const result = prepareReactTsxDesignEdit(reparentProposal(), context());
    expect(result).toMatchObject({ kind: 'prepared', patch: { path: 'src/App.tsx' } });
    if (result.kind !== 'prepared') throw new Error('Expected a prepared semantic reparent.');
    expect(result.patch.nextContent).toContain(
      '<section data-selene-node-id="orders.secondary" style={{ display: \'grid\' }}><h1 data-selene-node-id="orders.title">Orders</h1><p data-selene-node-id="orders.summary">Summary</p></section>'
    );
    expect(result.patch.nextContent).toContain('// Keep this comment byte-identical.');
  });
});
