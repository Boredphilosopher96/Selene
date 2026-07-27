import { describe, expect, it } from 'vitest';

import { previewInteractionFailureNotice, safeDesignerNotice } from './presentation-error';

describe('renderer presentation errors', () => {
  it('fails closed on terminal, filesystem, URL, host, and provider details', () => {
    for (const unsafe of [
      '\u001B[31mProvider timeout\u001B[0m',
      'ENOENT /Users/designer/project',
      'EACCES /home/designer/project',
      String.raw`C:\Users\designer\Selene\package.json`,
      String.raw`\\enterprise-host\designs\selene`,
      'Request failed at https://api.example.test/v1/designs',
      'Remote host github.enterprise.test refused the request',
      'connect ECONNREFUSED 127.0.0.1:11434',
      'Anthropic provider model_id claude-enterprise failed',
      'at renderPreview (file.ts:42:9)',
      'Could not load node_modules/react'
    ])
      expect(safeDesignerNotice(unsafe, 'Try again.')).toBe('Try again.');
    expect(safeDesignerNotice('The destination screen is unavailable.')).toBe(
      'The destination screen is unavailable.'
    );
    expect(safeDesignerNotice('ENOENT /home/designer/project', 'See C:\\temp\\error.log')).toBe(
      'Try the canvas action again.'
    );
  });

  it('returns fixed actionable notices for preview interaction failures', () => {
    expect(previewInteractionFailureNotice('select-node')).toBe(
      'Could not select that preview element. Try again or refresh the preview.'
    );
    expect(previewInteractionFailureNotice('trigger-action')).toBe(
      'Could not run that prototype action. Try again or refresh the preview.'
    );
  });
});
