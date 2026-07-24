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
export {
  Activity,
  AppShell,
  CanvasChrome,
  Dialog,
  InspectorSection,
  ListRow,
  Panel,
  Popover,
  Progress,
  SegmentedControl,
  SelectField,
  SplitView,
  StatePanel,
  Tabs,
  TextareaField,
  Toolbar
} from './workspace-primitives';
export type {
  ActivityProps,
  AppShellProps,
  CanvasChromeProps,
  DialogProps,
  InspectorSectionProps,
  ListRowProps,
  PanelProps,
  PopoverProps,
  ProgressProps,
  SegmentedControlItem,
  SegmentedControlProps,
  SelectFieldProps,
  SelectOption,
  SelectOptionGroup,
  SplitViewProps,
  StatePanelProps,
  TabItem,
  TabsProps,
  TextareaFieldProps,
  ToolbarProps
} from './workspace-primitives';
