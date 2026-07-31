import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import {
  serializeCanonicalData,
  type ReactBuildReceipt,
  type ReactSourceWorkspace
} from '@selene/core';
import { createInitialWorkspace } from './designer-service';
import {
  issueReactBindingCompilerEvidence,
  validateCurrentReactBindingEvidence
} from './react-binding-evidence';

function receipt(workspace: ReactSourceWorkspace): ReactBuildReceipt {
  return {
    format: 'selene-react-build-receipt/v1',
    compilerIdentity: 'selene-vite-react-compiler/v1',
    projectId: workspace.projectId,
    sourceRevisionId: workspace.revision.id,
    sourceSha256: createHash('sha256').update(serializeCanonicalData(workspace)).digest('hex'),
    outputSha256: 'a'.repeat(64),
    reachableFiles: [workspace.entrypoint]
  };
}

describe('host-issued React binding evidence', () => {
  it('maps only declared literal TSX anchors from the exact workspace bytes', () => {
    const workspace = createInitialWorkspace('evidence-project');
    const buildReceipt = receipt(workspace);
    const evidence = issueReactBindingCompilerEvidence(workspace, buildReceipt);

    expect(evidence).toMatchObject({
      parserIdentity: '@typescript/typescript6@6.0.2',
      projectId: 'evidence-project',
      sourceRevisionId: 'evidence-project-r1',
      outputSha256: 'a'.repeat(64),
      entrypoint: 'src/App.tsx'
    });
    expect(evidence.nodeMarkers.map((item) => item.sourceNodeId).sort()).toEqual([
      'designer.action',
      'designer.root',
      'designer.summary',
      'designer.title'
    ]);
    expect(validateCurrentReactBindingEvidence(evidence, workspace, buildReceipt)).toEqual(
      evidence
    );
  });

  it('rejects a receipt once host source bytes change', () => {
    const workspace = createInitialWorkspace('evidence-project');
    const buildReceipt = receipt(workspace);
    const changed = {
      ...workspace,
      files: workspace.files.map((file) =>
        file.path === 'src/App.tsx' ? { ...file, content: `${file.content}\n// changed` } : file
      )
    };

    expect(() => issueReactBindingCompilerEvidence(changed, buildReceipt)).toThrow(
      'React build receipt does not match the current workspace.'
    );
  });

  it('excludes markers declared only in unreachable TSX modules', () => {
    const base = createInitialWorkspace('evidence-project');
    const workspace = {
      ...base,
      files: [
        ...base.files,
        {
          path: 'src/unreachable.tsx',
          language: 'tsx' as const,
          content:
            'export default function Unreachable(){return <aside data-selene-node-id="hidden.marker"/>;}'
        }
      ],
      nodes: [
        ...base.nodes,
        { nodeId: 'hidden.marker', path: 'src/unreachable.tsx', exportName: 'default' }
      ]
    };
    const evidence = issueReactBindingCompilerEvidence(workspace, receipt(workspace));

    expect(evidence.reachableFiles).toEqual([workspace.entrypoint]);
    expect(evidence.nodeMarkers.some((marker) => marker.sourceNodeId === 'hidden.marker')).toBe(
      false
    );
  });

  it('requires an explicit compiler-approved policy for governed bare dependencies', () => {
    const base = createInitialWorkspace('evidence-project');
    const workspace = {
      ...base,
      dependencies: ['@acme/design-system'],
      files: base.files.map((file) =>
        file.path === base.entrypoint
          ? {
              ...file,
              content: `import { Button } from '@acme/design-system';\n${file.content}`
            }
          : file
      )
    };
    const buildReceipt = receipt(workspace);

    expect(() => issueReactBindingCompilerEvidence(workspace, buildReceipt)).toThrow(
      'Dependency is not allowlisted'
    );
    expect(
      issueReactBindingCompilerEvidence(workspace, buildReceipt, {
        allowedBareDependencies: workspace.dependencies
      }).nodeMarkers
    ).toHaveLength(base.nodes.length);
  });
});
