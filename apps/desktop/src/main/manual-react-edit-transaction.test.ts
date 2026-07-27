import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import {
  serializeCanonicalData,
  type DesignEditProposal,
  type ReactSourceWorkspace
} from '@selene/core';

import {
  CompilerBoundManualReactEditTransactionPort,
  UnavailableManualReactEditTransactionPort
} from './manual-react-edit-transaction';

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

  it('returns a bounded compiler failure without exposing artifact diagnostics or attempting a write', async () => {
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
        designSystemLockDigest: 'a'.repeat(64),
        designRevisionId: 'design-r1'
      })
    ).resolves.toEqual({
      format: 'selene-design-edit-result/v1',
      kind: 'rejected',
      diagnostics: [{ code: 'COMPILER_BINDING_UNAVAILABLE' }]
    });
    expect(createHash('sha256').update(serializeCanonicalData(workspace)).digest('hex')).toBe(
      before
    );
  });
});
