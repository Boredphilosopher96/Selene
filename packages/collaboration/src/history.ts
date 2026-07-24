import type { Approval, Membership, MembershipRole, Revision } from './index.js';

export type RevisionChangeKind = 'add' | 'remove' | 'replace';
export interface RevisionChange {
  readonly kind: RevisionChangeKind;
  /** RFC 6901-style JSON pointer. The root document is an empty string. */
  readonly path: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface RevisionDiff {
  readonly fromRevisionId: string;
  readonly toRevisionId: string;
  readonly changes: readonly RevisionChange[];
}

export interface RestoreRevisionInput {
  readonly id: string;
  readonly contentSha256: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly reason: string;
}

export interface RestoredRevision {
  readonly revision: Revision;
  readonly restoredFromRevisionId: string;
  readonly reason: string;
}

export interface RevisionMergeConflict {
  readonly path: string;
  readonly target: RevisionChange;
  readonly source: RevisionChange;
}

export interface RevisionMergePlan {
  readonly baseRevisionId: string;
  readonly targetRevisionId: string;
  readonly sourceRevisionId: string;
  readonly changes: readonly RevisionChange[];
  readonly conflicts: readonly RevisionMergeConflict[];
}

export interface ApprovalPolicy {
  readonly minimumApprovals: number;
  readonly requiredRoles: readonly MembershipRole[];
  readonly changesRequestedBlocks: boolean;
}

export interface ApprovalPolicyEvaluation {
  readonly approved: boolean;
  readonly approvedBy: readonly string[];
  readonly missingRoles: readonly MembershipRole[];
  readonly changesRequestedBy: readonly string[];
}

export interface BaselineApprovalStatus {
  readonly currency: 'current' | 'stale' | 'none';
  readonly approvalsStale: boolean;
}

const permissionByRole: Readonly<Record<MembershipRole, readonly string[]>> = {
  owner: ['read', 'comment', 'edit', 'approve', 'restore', 'merge'],
  admin: ['read', 'comment', 'edit', 'approve', 'restore', 'merge'],
  editor: ['read', 'comment', 'edit'],
  commenter: ['read', 'comment'],
  viewer: ['read'],
  guest: ['read', 'comment']
};

export function canPerformRevisionAction(role: MembershipRole, action: string): boolean {
  return permissionByRole[role].includes(action);
}

function pointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function recordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diffValue(left: unknown, right: unknown, path: string, changes: RevisionChange[]): void {
  if (equal(left, right)) return;
  if (recordObject(left) && recordObject(right)) {
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      const next = `${path}/${pointerToken(key)}`;
      if (!(key in left)) changes.push({ kind: 'add', path: next, after: right[key] });
      else if (!(key in right)) changes.push({ kind: 'remove', path: next, before: left[key] });
      else diffValue(left[key], right[key], next, changes);
    }
    return;
  }
  changes.push({
    kind: left === undefined ? 'add' : right === undefined ? 'remove' : 'replace',
    path,
    ...(left === undefined ? {} : { before: left }),
    ...(right === undefined ? {} : { after: right })
  });
}

/** Computes a deterministic structural diff without treating package history as design history. */
export function diffRevisions(from: Revision, to: Revision): RevisionDiff {
  if (from.projectId !== to.projectId)
    throw new Error('Cannot diff revisions from different projects');
  const changes: RevisionChange[] = [];
  diffValue(from.content, to.content, '', changes);
  return { fromRevisionId: from.id, toRevisionId: to.id, changes };
}

/** Restoring creates a new append-only revision; it never mutates historical content. */
export function createRestoredRevision(
  target: Revision,
  current: Revision,
  input: RestoreRevisionInput
): RestoredRevision {
  if (target.projectId !== current.projectId) throw new Error('Cannot restore across projects');
  if (!input.reason.trim()) throw new Error('Restore reason must not be empty');
  return {
    restoredFromRevisionId: target.id,
    reason: input.reason,
    revision: {
      id: input.id,
      projectId: current.projectId,
      sequence: current.sequence + 1,
      parentRevisionId: current.id,
      content: target.content,
      contentSha256: input.contentSha256,
      scenarioIds: target.scenarioIds,
      createdBy: input.createdBy,
      createdAt: input.createdAt
    }
  };
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** Produces a conflict-first, host-applicable three-way merge plan. */
export function planRevisionMerge(
  base: Revision,
  target: Revision,
  source: Revision
): RevisionMergePlan {
  if (base.projectId !== target.projectId || base.projectId !== source.projectId)
    throw new Error('Cannot merge revisions from different projects');
  const targetChanges = diffRevisions(base, target).changes;
  const sourceChanges = diffRevisions(base, source).changes;
  const conflicts: RevisionMergeConflict[] = [];
  const safeSource = sourceChanges.filter((candidate) => {
    const colliding = targetChanges.find((targetChange) =>
      pathsOverlap(targetChange.path, candidate.path)
    );
    if (colliding === undefined || equal(colliding.after, candidate.after)) return true;
    conflicts.push({ path: candidate.path, target: colliding, source: candidate });
    return false;
  });
  return {
    baseRevisionId: base.id,
    targetRevisionId: target.id,
    sourceRevisionId: source.id,
    changes: safeSource,
    conflicts
  };
}

/** Evaluates approvals against membership roles; hosts enforce it before an effectful merge/handoff. */
export function evaluateApprovalPolicy(
  policy: ApprovalPolicy,
  approvals: readonly Approval[],
  memberships: readonly Membership[]
): ApprovalPolicyEvaluation {
  if (!Number.isInteger(policy.minimumApprovals) || policy.minimumApprovals < 1)
    throw new Error('minimumApprovals must be a positive integer');
  const roleByUser = new Map(memberships.map((membership) => [membership.userId, membership.role]));
  const latest = new Map<string, Approval>();
  for (const approval of approvals) latest.set(approval.userId, approval);
  const approvedBy = [...latest.values()]
    .filter((approval) => approval.decision === 'approved')
    .filter((approval) => {
      const role = roleByUser.get(approval.userId);
      return role !== undefined && canPerformRevisionAction(role, 'approve');
    })
    .map((approval) => approval.userId)
    .sort();
  const changesRequestedBy = [...latest.values()]
    .filter((approval) => approval.decision === 'changes_requested')
    .map((approval) => approval.userId)
    .sort();
  const approverRoles = new Set(approvedBy.map((id) => roleByUser.get(id)));
  const missingRoles = [...new Set(policy.requiredRoles)]
    .filter((role) => !approverRoles.has(role))
    .sort();
  return {
    approved:
      approvedBy.length >= policy.minimumApprovals &&
      missingRoles.length === 0 &&
      (!policy.changesRequestedBlocks || changesRequestedBy.length === 0),
    approvedBy,
    missingRoles,
    changesRequestedBy
  };
}

/** A prior approval cannot authorize a changed generated design. */
export function evaluateBaselineApprovalPolicy(
  baseline: BaselineApprovalStatus,
  policy: ApprovalPolicy,
  approvals: readonly Approval[],
  memberships: readonly Membership[]
): ApprovalPolicyEvaluation {
  const evaluation = evaluateApprovalPolicy(policy, approvals, memberships);
  return baseline.currency !== 'current' || baseline.approvalsStale
    ? { ...evaluation, approved: false }
    : evaluation;
}
