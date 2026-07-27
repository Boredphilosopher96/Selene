import { describe, expect, it } from 'vitest';

import { PreviewCanvasNavigation } from './preview-canvas-navigation';

describe('PreviewCanvasNavigation', () => {
  it('delivers the latest policy when a preview becomes ready after the canvas mode changed', () => {
    const published: boolean[] = [];
    const navigation = new PreviewCanvasNavigation((enabled) => published.push(enabled));

    navigation.setEnabled(false);
    expect(published).toEqual([]);

    navigation.previewAvailable();
    expect(published).toEqual([false]);
  });

  it('replays the current policy to a replacement preview and only streams changes while ready', () => {
    const published: boolean[] = [];
    const navigation = new PreviewCanvasNavigation((enabled) => published.push(enabled));

    navigation.previewAvailable();
    navigation.setEnabled(false);
    navigation.previewUnavailable();
    navigation.setEnabled(true);
    expect(published).toEqual([true, false]);

    navigation.previewAvailable();
    expect(published).toEqual([true, false, true]);
  });
});
