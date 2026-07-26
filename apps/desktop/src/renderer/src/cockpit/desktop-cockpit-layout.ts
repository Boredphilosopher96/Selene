export const compactCockpitMediaQuery = '(max-width: 64rem)';
export const compactCanvasMediaQuery = '(max-width: 44rem)';
export const desktopSplitPaneMinimumViewport = 1025;

/** Source-level layout contract for the viewport fixtures exercised in CI. */
export function desktopCockpitViewportExpectation(viewportWidth: number): {
  readonly layout: DesktopCockpitLayoutMode;
  readonly aiRail: 'contained' | 'overlay';
} {
  return {
    layout: viewportWidth < desktopSplitPaneMinimumViewport ? 'inspector-drawer' : 'split-pane',
    aiRail: viewportWidth <= 704 ? 'overlay' : 'contained'
  };
}

export type DesktopCockpitLayoutMode = 'split-pane' | 'inspector-drawer';

/** Fixtures may force compact mode; production otherwise follows its observed media query. */
export function desktopCockpitLayoutMode({
  compactLayout,
  viewportIsCompact
}: {
  readonly compactLayout: boolean | undefined;
  readonly viewportIsCompact: boolean;
}): DesktopCockpitLayoutMode {
  return (compactLayout ?? viewportIsCompact) ? 'inspector-drawer' : 'split-pane';
}

/** A closed compact drawer must not leave an invisible event-capturing layer behind. */
export function inspectorDrawerBlocksInteraction(
  layout: DesktopCockpitLayoutMode,
  isOpen: boolean
): boolean {
  return layout === 'inspector-drawer' && isOpen;
}

/** Flow owns the physical workspace, so it must never inherit a modal drawer's inert background. */
export function centerStageClosesInspectorDrawer(
  layout: DesktopCockpitLayoutMode,
  isDrawerOpen: boolean,
  stage: 'preview' | 'flow'
): boolean {
  return stage === 'flow' && layout === 'inspector-drawer' && isDrawerOpen;
}

/** Compact AI overlay controls replace each other, so focus always follows the visible control. */
export function compactAiRailFocusTarget(isOpen: boolean): 'close' | 'open-trigger' {
  return isOpen ? 'close' : 'open-trigger';
}

/** Target selection owns Escape; otherwise an open compact AI overlay closes and restores focus. */
export function compactAiRailEscapeAction({
  isOpen,
  targetSelectionActive
}: {
  readonly isOpen: boolean;
  readonly targetSelectionActive: boolean;
}): 'cancel-target-selection' | 'close-ai-rail' | 'none' {
  if (targetSelectionActive) return 'cancel-target-selection';
  return isOpen ? 'close-ai-rail' : 'none';
}

export function inspectorDrawerAccessibilityState(
  layout: DesktopCockpitLayoutMode,
  isOpen: boolean
): {
  readonly isModal: boolean;
  readonly backgroundIsInert: boolean;
  readonly drawerIsInert: boolean;
  readonly drawerContentIsMounted: boolean;
} {
  const isDrawer = layout === 'inspector-drawer';
  const isModal = inspectorDrawerBlocksInteraction(layout, isOpen);
  return {
    isModal,
    backgroundIsInert: isModal,
    drawerIsInert: isDrawer && !isOpen,
    drawerContentIsMounted: !isDrawer || isOpen
  };
}
