import { designerWorkspaceSchema, type DesignerWorkspace } from '@selene/project-schema';

export interface LocalProjectPersistencePort {
  load(projectId: string): Promise<string | undefined>;
  save(projectId: string, serializedProject: string): Promise<void>;
}

export type ProjectCommand =
  | { readonly type: 'select-screen'; readonly screenId: string }
  | { readonly type: 'select-state'; readonly state: string }
  | { readonly type: 'select-node'; readonly nodeId: string | undefined }
  | {
      readonly type: 'add-comment';
      readonly id: string;
      readonly nodeId: string;
      readonly body: string;
      readonly author: string;
      readonly createdAt: string;
    }
  | { readonly type: 'resolve-comment'; readonly commentId: string; readonly resolvedAt: string }
  | {
      readonly type: 'add-direction';
      readonly id: string;
      readonly body: string;
      readonly createdAt: string;
    }
  | { readonly type: 'set-status'; readonly status: DesignerWorkspace['status'] };

export class ProjectCommandError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProjectCommandError';
  }
}

function parseWorkspace(value: unknown): DesignerWorkspace {
  const parsed = designerWorkspaceSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProjectCommandError(
      `Invalid designer workspace: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'} ${issue.message}`)
        .join('; ')}`
    );
  }
  return parsed.data;
}

function withUpdatedAt(
  workspace: DesignerWorkspace,
  updates: Partial<DesignerWorkspace>
): DesignerWorkspace {
  return parseWorkspace({ ...workspace, ...updates, updatedAt: workspace.updatedAt });
}

/** Applies a typed, deterministic workspace command without touching a runtime or filesystem. */
export function executeProjectCommand(
  workspaceValue: unknown,
  command: ProjectCommand
): DesignerWorkspace {
  const workspace = parseWorkspace(workspaceValue);
  switch (command.type) {
    case 'select-screen': {
      const screen = workspace.screens.find((candidate) => candidate.id === command.screenId);
      if (screen === undefined)
        throw new ProjectCommandError(`Unknown screen: ${command.screenId}`);
      return withUpdatedAt(workspace, {
        selectedScreenId: screen.id,
        selectedState: screen.states[0] ?? workspace.selectedState,
        selectedNodeId: undefined
      });
    }
    case 'select-state': {
      const screen = workspace.screens.find(
        (candidate) => candidate.id === workspace.selectedScreenId
      );
      if (screen === undefined || !screen.states.includes(command.state))
        throw new ProjectCommandError(`Unknown state: ${command.state}`);
      return withUpdatedAt(workspace, { selectedState: command.state });
    }
    case 'select-node': {
      if (
        command.nodeId !== undefined &&
        !workspace.screens.some((screen) => screen.nodeIds.includes(command.nodeId ?? ''))
      ) {
        throw new ProjectCommandError(`Unknown node: ${command.nodeId}`);
      }
      return withUpdatedAt(workspace, { selectedNodeId: command.nodeId });
    }
    case 'add-comment': {
      if (!workspace.screens.some((screen) => screen.nodeIds.includes(command.nodeId)))
        throw new ProjectCommandError(`Unknown node: ${command.nodeId}`);
      if (workspace.comments.some((comment) => comment.id === command.id))
        throw new ProjectCommandError(`Duplicate comment: ${command.id}`);
      return withUpdatedAt(workspace, {
        comments: [
          ...workspace.comments,
          {
            id: command.id,
            nodeId: command.nodeId,
            body: command.body,
            author: command.author,
            createdAt: command.createdAt
          }
        ]
      });
    }
    case 'resolve-comment': {
      const exists = workspace.comments.some((comment) => comment.id === command.commentId);
      if (!exists) throw new ProjectCommandError(`Unknown comment: ${command.commentId}`);
      return withUpdatedAt(workspace, {
        comments: workspace.comments.map((comment) =>
          comment.id === command.commentId
            ? { ...comment, resolvedAt: command.resolvedAt }
            : comment
        )
      });
    }
    case 'add-direction':
      if (workspace.developerDirections.some((direction) => direction.id === command.id))
        throw new ProjectCommandError(`Duplicate developer direction: ${command.id}`);
      return withUpdatedAt(workspace, {
        developerDirections: [
          ...workspace.developerDirections,
          { id: command.id, body: command.body, createdAt: command.createdAt }
        ]
      });
    case 'set-status':
      return withUpdatedAt(workspace, { status: command.status });
  }
}

/** Validates external project data before it crosses into a local persistence adapter. */
export function openProject(serializedProject: string): DesignerWorkspace {
  try {
    return parseWorkspace(JSON.parse(serializedProject));
  } catch (error) {
    if (error instanceof ProjectCommandError) throw error;
    throw new ProjectCommandError('Project export is not valid JSON');
  }
}

/** Produces a portable JSON export with deterministic whitespace. */
export function exportProject(workspaceValue: unknown): string {
  return `${JSON.stringify(parseWorkspace(workspaceValue), null, 2)}\n`;
}

export async function createProject(
  persistence: LocalProjectPersistencePort,
  workspaceValue: unknown
): Promise<DesignerWorkspace> {
  const workspace = parseWorkspace(workspaceValue);
  await persistence.save(workspace.projectId, exportProject(workspace));
  return workspace;
}

export async function reopenProject(
  persistence: LocalProjectPersistencePort,
  projectId: string
): Promise<DesignerWorkspace | undefined> {
  const stored = await persistence.load(projectId);
  return stored === undefined ? undefined : openProject(stored);
}
