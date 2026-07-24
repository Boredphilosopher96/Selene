/**
 * Stable internal barrel for the optional `@selene/ui/workspace` entrypoint.
 * Implementations are progressively separated by responsibility; consumers
 * retain this module path and all existing symbols.
 */
export * from './workspace-layout-primitives';
export * from './workspace-selection-primitives';
export * from './workspace-feedback-primitives';
export * from './workspace-dialog';
export * from './workspace-popover';
