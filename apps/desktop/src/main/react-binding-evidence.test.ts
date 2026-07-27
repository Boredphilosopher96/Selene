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
});
