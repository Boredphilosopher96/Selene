import { describe, expect, it } from 'vitest';

import { createInitialWorkspace } from './designer-service';
import {
  issueReactBindingCompilerEvidence,
  validateCurrentReactBindingEvidence
} from './react-binding-evidence';

describe('host-issued React binding evidence', () => {
  it('maps only declared literal TSX anchors from the exact workspace bytes', () => {
    const workspace = createInitialWorkspace('evidence-project');
    const evidence = issueReactBindingCompilerEvidence(workspace);

    expect(evidence).toMatchObject({
      parserIdentity: '@typescript/typescript6@6.0.2',
      projectId: 'evidence-project',
      sourceRevisionId: 'evidence-project-r1',
      entrypoint: 'src/App.tsx'
    });
    expect(evidence.nodeMarkers.map((item) => item.sourceNodeId).sort()).toEqual([
      'designer.action',
      'designer.root',
      'designer.summary',
      'designer.title'
    ]);
    expect(validateCurrentReactBindingEvidence(evidence, workspace)).toEqual(evidence);
  });

  it('rejects a receipt once host source bytes change', () => {
    const workspace = createInitialWorkspace('evidence-project');
    const evidence = issueReactBindingCompilerEvidence(workspace);
    const changed = {
      ...workspace,
      files: workspace.files.map((file) =>
        file.path === 'src/App.tsx' ? { ...file, content: `${file.content}\n// changed` } : file
      )
    };

    expect(() => validateCurrentReactBindingEvidence(evidence, changed)).toThrow(
      'React binding compiler evidence is stale.'
    );
  });
});
