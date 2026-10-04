import { expect, it } from 'vitest';
import type { ReactSourceWorkspace } from '@selene/core';
import { sourceDesignInputUsage } from './source-design-input-usage';

it('finds package and subpath dependencies without treating inert text as an import', () => {
  const workspace: ReactSourceWorkspace = {
    format: 'selene-react-workspace/v1',
    projectId: 'usage-project',
    revision: { id: 'usage-r1', createdAt: '2026-09-30T00:00:00.000Z', summary: 'Usage' },
    entrypoint: 'src/App.tsx',
    dependencies: [],
    nodes: [],
    files: [
      {
        path: 'src/App.tsx',
        language: 'tsx',
        content: `
import { Button } from '@acme/ui';
export { colors } from '@acme/ui/tokens';
const future = import('@acme/later');
const other = require('@acme/legacy');
const message = "import '@acme/inert'";
// import '@acme/comment';
export default function App() { return <Button>{message}</Button>; }`
      }
    ]
  };
  expect(
    sourceDesignInputUsage(workspace, [
      '@acme/ui',
      '@acme/later',
      '@acme/legacy',
      '@acme/inert',
      '@acme/comment'
    ])
  ).toEqual([
    { path: 'src/App.tsx', packageName: '@acme/ui' },
    { path: 'src/App.tsx', packageName: '@acme/later' },
    { path: 'src/App.tsx', packageName: '@acme/legacy' }
  ]);
  expect(sourceDesignInputUsage(workspace, ['@acme/u'])).toEqual([]);
});
