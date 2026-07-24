import type { DeveloperRecheckManifest } from './design-baseline.js';
import type { GeneratedDesignHandoff } from './enterprise-handoff.js';

export interface FederatedDesignProjectStatus {
  readonly projectId: string;
  /** Ownership is data-only; no remote runtime modules are loaded. */
  readonly owner: string;
  readonly baseline: DeveloperRecheckManifest;
}

export interface FederatedDesignBlocker {
  readonly projectId: string;
  readonly kind: 'no-baseline' | 'stale-design' | 'stale-approval';
  readonly message: string;
}

export interface FederatedDesignCatalog {
  readonly shellProjectId: string;
  readonly projects: readonly FederatedDesignProjectStatus[];
  readonly blockers: readonly FederatedDesignBlocker[];
  readonly readyForHandoff: boolean;
}

/** Aggregates independently owned static projects into a developer-readable baseline catalog. */
export function createFederatedDesignCatalog(
  shellProjectId: string,
  projects: readonly FederatedDesignProjectStatus[]
): FederatedDesignCatalog {
  if (!shellProjectId || projects.length < 3)
    throw new Error('Federation requires a shell and two child projects');
  const ids = new Set(projects.map((project) => project.projectId));
  if (ids.size !== projects.length || !ids.has(shellProjectId))
    throw new Error('Federation project IDs must be unique and include the shell');
  if (projects.some((project) => project.baseline.projectId !== project.projectId))
    throw new Error('Federation baseline status must belong to its project');
  const blockers = projects.flatMap((project) => {
    if (project.baseline.currency === 'none')
      return [
        {
          projectId: project.projectId,
          kind: 'no-baseline' as const,
          message: 'No immutable generated-design baseline exists.'
        }
      ];
    const values: FederatedDesignBlocker[] = [];
    if (project.baseline.currency === 'stale')
      values.push({
        projectId: project.projectId,
        kind: 'stale-design',
        message: 'Exact generated-design changes require re-review.'
      });
    if (project.baseline.approvalsStale)
      values.push({
        projectId: project.projectId,
        kind: 'stale-approval',
        message: 'Approvals must be renewed for this design baseline.'
      });
    return values;
  });
  return {
    shellProjectId,
    projects: [...projects].sort((left, right) => left.projectId.localeCompare(right.projectId)),
    blockers: blockers.sort(
      (left, right) =>
        left.projectId.localeCompare(right.projectId) || left.kind.localeCompare(right.kind)
    ),
    readyForHandoff: blockers.length === 0
  };
}

export interface FederatedDesignHandoff {
  readonly format: 'selene-federated-generated-design-handoff/v1';
  readonly catalog: FederatedDesignCatalog;
  readonly projects: readonly {
    readonly projectId: string;
    readonly handoff: GeneratedDesignHandoff;
  }[];
}

/** Preserves per-project node maps, source maps, comments and exact recheck deltas in one static artifact. */
export function createFederatedDesignHandoff(
  shellProjectId: string,
  projects: readonly {
    readonly projectId: string;
    readonly owner: string;
    readonly handoff: GeneratedDesignHandoff;
  }[]
): FederatedDesignHandoff {
  if (
    projects.some(
      ({ projectId, handoff }) =>
        handoff.project.id !== projectId || handoff.baseline.projectId !== projectId
    )
  ) {
    throw new Error('Federated handoff project identity must match its baseline');
  }
  const catalog = createFederatedDesignCatalog(
    shellProjectId,
    projects.map(({ projectId, owner, handoff }) => ({
      projectId,
      owner,
      baseline: handoff.baseline
    }))
  );
  return {
    format: 'selene-federated-generated-design-handoff/v1',
    catalog,
    projects: [...projects]
      .map(({ projectId, handoff }) => ({ projectId, handoff }))
      .sort((left, right) => left.projectId.localeCompare(right.projectId))
  };
}
