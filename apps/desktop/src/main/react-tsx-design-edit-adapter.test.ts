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
  return <main data-selene-node-id="orders.root" style={{ display: 'flex' }}><h1 data-selene-node-id="orders.title">Orders</h1><p data-selene-node-id="orders.summary">Summary</p></main>;
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

describe('React TSX design edit preparation', () => {
  it('prepares one exact text span without rewriting surrounding source', () => {
    const result = prepareReactTsxDesignEdit(proposal(), context());
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('Expected a prepared edit.');
    expect(result.patch.previousContent).toBe(source);
    expect(result.patch.nextContent).toBe(source.replace('>Orders</h1>', '>Open orders</h1>'));
    expect(result.patch.nextContent).toContain('// Keep this comment byte-identical.');
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
      '<p data-selene-node-id="orders.summary">Summary</p><h1 data-selene-node-id="orders.title">Orders</h1>'
    );
    expect(result.patch.nextContent).toContain('data-selene-node-id="orders.title"');
  });
});
