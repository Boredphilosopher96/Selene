import { describe, expect, it } from 'vitest';

import {
  centerStageClosesInspectorDrawer,
  compactAiRailFocusTarget,
  desktopCockpitLayoutMode,
  desktopCockpitViewportExpectation,
  inspectorDrawerAccessibilityState,
  inspectorDrawerBlocksInteraction
} from './desktop-cockpit-layout';

describe('desktop cockpit layout mode', () => {
  it('moves compact AI overlay focus to the control that remains visible', () => {
    expect(compactAiRailFocusTarget(true)).toBe('close');
    expect(compactAiRailFocusTarget(false)).toBe('open-trigger');
  });

  it('closes an open compact drawer before Flow takes over the physical workspace', () => {
    expect(centerStageClosesInspectorDrawer('inspector-drawer', true, 'flow')).toBe(true);
    expect(centerStageClosesInspectorDrawer('inspector-drawer', false, 'flow')).toBe(false);
    expect(centerStageClosesInspectorDrawer('split-pane', true, 'flow')).toBe(false);
    expect(centerStageClosesInspectorDrawer('inspector-drawer', true, 'preview')).toBe(false);
  });

  it('keeps the 1440 split workspace and intentionally transitions 960/700 widths to drawers', () => {
    expect(desktopCockpitViewportExpectation(1440)).toEqual({
      layout: 'split-pane',
      aiRail: 'contained'
    });
    expect(desktopCockpitViewportExpectation(960)).toEqual({
      layout: 'inspector-drawer',
      aiRail: 'contained'
    });
    expect(desktopCockpitViewportExpectation(700)).toEqual({
      layout: 'inspector-drawer',
      aiRail: 'overlay'
    });
  });
  it('keeps fixture normal and large layouts in contained split panes', () => {
    expect(desktopCockpitLayoutMode({ compactLayout: false, viewportIsCompact: false })).toBe(
      'split-pane'
    );
    expect(desktopCockpitLayoutMode({ compactLayout: false, viewportIsCompact: true })).toBe(
      'split-pane'
    );
  });

  it('uses drawer semantics for observed and fixture-forced compact layouts', () => {
    expect(desktopCockpitLayoutMode({ compactLayout: undefined, viewportIsCompact: true })).toBe(
      'inspector-drawer'
    );
    expect(desktopCockpitLayoutMode({ compactLayout: true, viewportIsCompact: false })).toBe(
      'inspector-drawer'
    );
    expect(desktopCockpitLayoutMode({ compactLayout: false, viewportIsCompact: true })).toBe(
      'split-pane'
    );
  });

  it('only blocks canvas interaction while the compact drawer is visibly open', () => {
    expect(inspectorDrawerBlocksInteraction('inspector-drawer', false)).toBe(false);
    expect(inspectorDrawerBlocksInteraction('inspector-drawer', true)).toBe(true);
    expect(inspectorDrawerBlocksInteraction('split-pane', true)).toBe(false);
  });

  it('mounts focusable drawer content only for an open modal drawer', () => {
    expect(inspectorDrawerAccessibilityState('inspector-drawer', false)).toEqual({
      isModal: false,
      backgroundIsInert: false,
      drawerIsInert: true,
      drawerContentIsMounted: false
    });
    expect(inspectorDrawerAccessibilityState('inspector-drawer', true)).toEqual({
      isModal: true,
      backgroundIsInert: true,
      drawerIsInert: false,
      drawerContentIsMounted: true
    });
  });
});
