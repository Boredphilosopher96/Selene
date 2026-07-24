import {
  federationSchemaVersion,
  projectSchema,
  type Project,
  type ProjectStatus,
  type ReactSourcePointer
} from '@selene/project-schema';

export * from './generation.js';
export * from './prototype-graph.js';
export * from './artifact-manifests.js';

export const corePackageName = '@selene/core';

export * from './design-baseline.js';
export * from './enterprise-handoff.js';
export * from './enterprise-security.js';
export * from './federation-baseline.js';
export * from './project-operations.js';

export interface FederationIssue {
  readonly code:
    | 'duplicate-child'
    | 'invalid-manifest'
    | 'ownership-conflict'
    | 'parent-mismatch'
    | 'role-mismatch'
    | 'route-conflict'
    | 'shell-children-mismatch'
    | 'design-system-conflict';
  readonly message: string;
  readonly projectIds: readonly string[];
}

export class FederationCompatibilityError extends Error {
  public constructor(readonly issues: readonly FederationIssue[]) {
    super(issues.map((issue) => issue.message).join('\n'));
    this.name = 'FederationCompatibilityError';
  }
}

export interface FederationCatalog {
  readonly schemaVersion: typeof federationSchemaVersion;
  readonly shellProjectId: string;
  readonly overallStatus: ProjectStatus['state'];
  readonly projects: readonly Project[];
  readonly changelog: readonly (Project['changelog'][number] & { readonly projectId: string })[];
  readonly routes: readonly (Project['routes'][number] & { readonly projectId: string })[];
  readonly storybook: readonly (Project['storybook'][number] & { readonly projectId: string })[];
  readonly deployments: readonly (Project['deployment'] & { readonly projectId: string })[];
}

export interface HandoffBundleOptions {
  readonly bundleId: string;
  readonly issuedAt: string;
  readonly href: string;
  readonly sha256: string;
  readonly comments: readonly string[];
  readonly developerDirections: readonly string[];
  readonly agentDownload: {
    readonly href: string;
    readonly mediaType: 'application/json';
    readonly checksum: string;
    readonly instructions: string;
  };
}

export interface HandoffBundle {
  readonly format: 'selene-federation-handoff/v1';
  readonly bundleId: string;
  readonly issuedAt: string;
  readonly download: { readonly href: string; readonly sha256: string };
  /** Complete portable manifests; this is data, not runtime module federation. */
  readonly manifest: {
    readonly schemaVersion: typeof federationSchemaVersion;
    readonly shellProjectId: string;
    readonly projects: readonly Project[];
  };
  readonly reactSource: readonly (ReactSourcePointer & { readonly projectId: string })[];
  readonly comments: readonly string[];
  readonly developerDirections: readonly string[];
  readonly agentDownload: HandoffBundleOptions['agentDownload'];
}

interface ParsedFederation {
  readonly shell: Project;
  readonly children: readonly Project[];
  readonly issues: readonly FederationIssue[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedIssues(issues: readonly FederationIssue[]): readonly FederationIssue[] {
  return [...issues].sort((left, right) => {
    const code = compareText(left.code, right.code);
    if (code !== 0) return code;
    const projects = compareText(left.projectIds.join(','), right.projectIds.join(','));
    return projects !== 0 ? projects : compareText(left.message, right.message);
  });
}

function parseManifest(value: unknown, location: string): Project | FederationIssue {
  const result = projectSchema.safeParse(value);
  if (result.success) return result.data;

  return {
    code: 'invalid-manifest',
    message: `${location} is not a valid project manifest: ${result.error.issues
      .map((issue) => `${issue.path.join('.') || 'root'} ${issue.message}`)
      .sort(compareText)
      .join('; ')}`,
    projectIds: [location]
  };
}

function ownershipClaims(project: Project): readonly string[] {
  return [
    ...project.ownership.nodeIds.map((nodeId) => `node:${nodeId}`),
    ...project.ownership.nodeIdPrefixes.map((prefix) => `prefix:${prefix}`)
  ].sort(compareText);
}

function claimsOverlap(left: string, right: string): boolean {
  const leftSeparator = left.indexOf(':');
  const rightSeparator = right.indexOf(':');
  if (leftSeparator < 0 || rightSeparator < 0) return false;
  const leftType = left.slice(0, leftSeparator);
  const leftValue = left.slice(leftSeparator + 1);
  const rightType = right.slice(0, rightSeparator);
  const rightValue = right.slice(rightSeparator + 1);
  if (leftType === 'node' && rightType === 'node') return leftValue === rightValue;
  if (leftType === 'prefix' && rightType === 'prefix') {
    return leftValue.startsWith(rightValue) || rightValue.startsWith(leftValue);
  }
  return leftType === 'prefix'
    ? rightValue.startsWith(leftValue)
    : leftValue.startsWith(rightValue);
}

function validateParsedFederation(
  shell: Project,
  children: readonly Project[]
): readonly FederationIssue[] {
  const issues: FederationIssue[] = [];
  if (shell.role !== 'shell') {
    issues.push({
      code: 'role-mismatch',
      message: `shell manifest ${shell.projectId} must have role shell`,
      projectIds: [shell.projectId]
    });
  }

  const childIds = new Set<string>();
  for (const child of children) {
    if (child.role !== 'child') {
      issues.push({
        code: 'role-mismatch',
        message: `child manifest ${child.projectId} must have role child`,
        projectIds: [child.projectId]
      });
    }
    if (childIds.has(child.projectId)) {
      issues.push({
        code: 'duplicate-child',
        message: `child project ${child.projectId} appears more than once`,
        projectIds: [child.projectId]
      });
    }
    childIds.add(child.projectId);
    if (child.parentProjectId !== shell.projectId) {
      issues.push({
        code: 'parent-mismatch',
        message: `child ${child.projectId} must name ${shell.projectId} as parent`,
        projectIds: [child.projectId, shell.projectId].sort(compareText)
      });
    }
  }

  const declaredChildren = [...shell.children].sort(compareText);
  const actualChildren = [...childIds].sort(compareText);
  if (declaredChildren.join(',') !== actualChildren.join(',')) {
    issues.push({
      code: 'shell-children-mismatch',
      message: `shell ${shell.projectId} children must exactly match supplied child manifests`,
      projectIds: [shell.projectId, ...actualChildren].sort(compareText)
    });
  }

  const projects = [shell, ...children].sort((left, right) =>
    compareText(left.projectId, right.projectId)
  );
  for (let leftIndex = 0; leftIndex < projects.length; leftIndex += 1) {
    const left = projects[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < projects.length; rightIndex += 1) {
      const right = projects[rightIndex];
      if (right === undefined) continue;
      const overlap = ownershipClaims(left)
        .flatMap((leftClaim) =>
          ownershipClaims(right)
            .filter((rightClaim) => claimsOverlap(leftClaim, rightClaim))
            .map((rightClaim) => `${leftClaim} overlaps ${rightClaim}`)
        )
        .sort(compareText)[0];
      if (overlap !== undefined) {
        issues.push({
          code: 'ownership-conflict',
          message: `projects ${left.projectId} and ${right.projectId} have conflicting ownership: ${overlap}`,
          projectIds: [left.projectId, right.projectId]
        });
      }
    }
  }

  const routeOwners = new Map<string, string>();
  for (const project of projects) {
    for (const route of project.routes) {
      const existingOwner = routeOwners.get(route.path);
      if (existingOwner !== undefined && existingOwner !== project.projectId) {
        issues.push({
          code: 'route-conflict',
          message: `route ${route.path} is declared by both ${existingOwner} and ${project.projectId}`,
          projectIds: [existingOwner, project.projectId].sort(compareText)
        });
      } else {
        routeOwners.set(route.path, project.projectId);
      }
    }
  }

  const designSystems = new Map<
    string,
    { projectId: string; version: string; tokenSource: string }
  >();
  for (const project of projects) {
    for (const reference of project.designSystem) {
      const existing = designSystems.get(reference.packageName);
      if (
        existing !== undefined &&
        (existing.version !== reference.version || existing.tokenSource !== reference.tokenSource)
      ) {
        issues.push({
          code: 'design-system-conflict',
          message: `design system ${reference.packageName} differs between ${existing.projectId} and ${project.projectId}`,
          projectIds: [existing.projectId, project.projectId].sort(compareText)
        });
      } else if (existing === undefined) {
        designSystems.set(reference.packageName, {
          projectId: project.projectId,
          version: reference.version,
          tokenSource: reference.tokenSource
        });
      }
    }
  }

  return sortedIssues(issues);
}

function parseFederation(shellValue: unknown, childValues: readonly unknown[]): ParsedFederation {
  const parsedShell = parseManifest(shellValue, 'shell');
  const parsedChildren = childValues.map((child, index) => parseManifest(child, `child[${index}]`));
  const parseIssues = [parsedShell, ...parsedChildren].filter(
    (value): value is FederationIssue => 'code' in value
  );
  if (parseIssues.length > 0)
    return { shell: undefined as never, children: [], issues: sortedIssues(parseIssues) };

  const shell = parsedShell as Project;
  const children = parsedChildren as Project[];
  return { shell, children, issues: validateParsedFederation(shell, children) };
}

/** Returns deterministic compatibility issues without loading remote code. */
export function validateFederation(
  shell: unknown,
  children: readonly unknown[]
): readonly FederationIssue[] {
  return parseFederation(shell, children).issues;
}

function aggregateStatus(projects: readonly Project[]): ProjectStatus['state'] {
  const states = new Set(projects.map((project) => project.status.state));
  if (states.has('blocked')) return 'blocked';
  if (states.has('active')) return 'active';
  if (states.has('planned')) return 'planned';
  return 'complete';
}

/**
 * Produces a stable, data-only catalog suitable for static deployment.
 * It deliberately has no remote-entry, loader, or runtime federation fields.
 */
export function aggregateFederation(
  shellValue: unknown,
  childValues: readonly unknown[]
): FederationCatalog {
  const parsed = parseFederation(shellValue, childValues);
  if (parsed.issues.length > 0) throw new FederationCompatibilityError(parsed.issues);

  const projects = [parsed.shell, ...parsed.children].sort((left, right) =>
    compareText(left.projectId, right.projectId)
  );
  return {
    schemaVersion: federationSchemaVersion,
    shellProjectId: parsed.shell.projectId,
    overallStatus: aggregateStatus(projects),
    projects,
    changelog: projects
      .flatMap((project) =>
        project.changelog.map((entry) => ({ ...entry, projectId: project.projectId }))
      )
      .sort(
        (left, right) =>
          compareText(left.at, right.at) ||
          compareText(left.projectId, right.projectId) ||
          compareText(left.id, right.id)
      ),
    routes: projects
      .flatMap((project) =>
        project.routes.map((route) => ({ ...route, projectId: project.projectId }))
      )
      .sort(
        (left, right) =>
          compareText(left.path, right.path) || compareText(left.projectId, right.projectId)
      ),
    storybook: projects
      .flatMap((project) =>
        project.storybook.map((story) => ({ ...story, projectId: project.projectId }))
      )
      .sort(
        (left, right) =>
          compareText(left.projectId, right.projectId) ||
          compareText(left.component, right.component) ||
          compareText(left.url, right.url)
      ),
    deployments: projects
      .map((project) => ({ ...project.deployment, projectId: project.projectId }))
      .sort((left, right) => compareText(left.projectId, right.projectId))
  };
}

/** Builds a portable descriptor for a host-created, downloadable handoff. */
export function createHandoffBundle(
  catalog: FederationCatalog,
  options: HandoffBundleOptions
): HandoffBundle {
  const projects = [...catalog.projects].sort((left, right) =>
    compareText(left.projectId, right.projectId)
  );
  return {
    format: 'selene-federation-handoff/v1',
    bundleId: options.bundleId,
    issuedAt: options.issuedAt,
    download: { href: options.href, sha256: options.sha256 },
    manifest: {
      schemaVersion: federationSchemaVersion,
      shellProjectId: catalog.shellProjectId,
      projects
    },
    reactSource: projects
      .flatMap((project) =>
        project.reactSource.map((source) => ({ ...source, projectId: project.projectId }))
      )
      .sort(
        (left, right) =>
          compareText(left.projectId, right.projectId) ||
          compareText(left.path, right.path) ||
          compareText(left.exportName ?? '', right.exportName ?? '')
      ),
    comments: [...options.comments],
    developerDirections: [...options.developerDirections],
    agentDownload: { ...options.agentDownload }
  };
}

/** Serializes a bundle predictably for static hosting or download. */
export function serializeHandoffBundle(bundle: HandoffBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}
