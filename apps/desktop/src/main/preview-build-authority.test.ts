import type { ReactSourceWorkspace } from '@selene/core';
import { describe, expect, it } from 'vitest';

import type { DesignerSnapshot, PreviewBuildTicket } from '../shared/designer-api';
import { CurrentPreviewBuildAuthority } from './preview-build-authority';

const source: ReactSourceWorkspace = {
  format: 'selene-react-workspace/v1',
  projectId: 'orders',
  entrypoint: 'src/App.tsx',
  files: [
    {
      path: 'src/App.tsx',
      language: 'tsx',
      content:
        'export default function App(){return <main data-selene-node-id="app.root">Orders</main>}'
    }
  ],
  dependencies: [],
  nodes: [{ nodeId: 'app.root', path: 'src/App.tsx', exportName: 'default' }],
  revision: {
    id: 'orders-r4',
    createdAt: '2026-07-30T00:00:00.000Z',
    summary: 'Authority fixture'
  }
};

const ticket: PreviewBuildTicket = {
  format: 'selene-preview-build-ticket/v1',
  projectId: 'orders',
  sourceRevisionId: 'orders-r4',
  graphRevision: 7,
  bindingId: 'a'.repeat(64)
};

function snapshot(currentTicket: PreviewBuildTicket = ticket): DesignerSnapshot {
  return {
    source,
    editablePrototype: {
      revision: 7,
      previewTicket: currentTicket
    }
  } as DesignerSnapshot;
}

describe('CurrentPreviewBuildAuthority', () => {
  it('resolves only the exact current host ticket to cloned source', () => {
    const authority = new CurrentPreviewBuildAuthority(() => snapshot());
    const resolved = authority.resolve(ticket);

    expect(resolved.identity).toEqual({
      projectId: 'orders',
      sourceRevisionId: 'orders-r4',
      graphRevision: 7,
      bindingId: 'a'.repeat(64)
    });
    expect(resolved.workspace).toEqual(source);
    expect(resolved.workspace).not.toBe(source);
  });

  it('rejects stale, modified, and cross-project tickets', () => {
    const authority = new CurrentPreviewBuildAuthority(() => snapshot());

    expect(() => authority.resolve({ ...ticket, graphRevision: 8 })).toThrow('stale');
    expect(() => authority.resolve({ ...ticket, bindingId: 'b'.repeat(64) })).toThrow('stale');
    expect(() => authority.resolve({ ...ticket, projectId: 'checkout' })).toThrow('stale');
  });
});
