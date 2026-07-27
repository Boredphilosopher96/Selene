import { describe, expect, it } from 'vitest';

import { PreviewTargetCancel } from './preview-target-cancel';

describe('PreviewTargetCancel', () => {
  it('keeps Escape inert until a trusted preview is ready and the desktop arms a target', () => {
    const published: boolean[] = [];
    const intent = new PreviewTargetCancel((enabled) => published.push(enabled));

    intent.setEnabled(true);
    expect(published).toEqual([]);

    intent.previewAvailable();
    intent.setEnabled(false);
    expect(published).toEqual([true, false]);
  });
});
