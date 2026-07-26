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
