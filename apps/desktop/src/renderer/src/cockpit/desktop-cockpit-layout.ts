export const compactCockpitMediaQuery = '(max-width: 60rem)';

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
