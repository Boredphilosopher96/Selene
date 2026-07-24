/**
 * Optional product-workspace surface. Import this subpath only in hosts that
 * render the commercial designer workspace; foundation consumers stay lean.
 */
export { DesignerWorkspace } from './designer-workspace';
export type {
  DesignerWorkspaceModel,
  DesignerWorkspaceProps,
  WorkspaceComment,
  WorkspaceDirection,
  WorkspaceScreen,
  WorkspaceStatus
} from './designer-workspace';
