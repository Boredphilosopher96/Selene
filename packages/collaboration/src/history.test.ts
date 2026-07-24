import { describe, expect, it } from 'vitest';

import {
  canPerformRevisionAction,
  createRestoredRevision,
  diffRevisions,
  evaluateBaselineApprovalPolicy,
  evaluateApprovalPolicy,
  planRevisionMerge
} from './history';

const revision = (id: string, sequence: number, content: unknown) => ({
  id,
  projectId: 'project-1',
  sequence,
  content,
  contentSha256: id.padEnd(64, '0'),
  scenarioIds: ['default', 'empty'],
  createdBy: 'editor-1',
  createdAt: '2026-07-23T22:00:00Z'
});

describe('immutable revision history', () => {
  it('computes deterministic design-content diffs and restores as a new revision', () => {
    const initial = revision('r1', 1, { title: 'Orders', empty: false });
    const current = revision('r2', 2, { title: 'Orders', empty: true });
    expect(diffRevisions(initial, current).changes).toEqual([
      { kind: 'replace', path: '/empty', before: false, after: true }
    ]);
    expect(
      createRestoredRevision(initial, current, {
        id: 'r3',
        contentSha256: '3'.repeat(64),
        createdBy: 'owner-1',
        createdAt: '2026-07-23T22:02:00Z',
        reason: 'Revert failed empty treatment'
      })
    ).toMatchObject({
      restoredFromRevisionId: 'r1',
      revision: { id: 'r3', parentRevisionId: 'r2', sequence: 3 }
    });
  });

  it('plans disjoint branch changes and surfaces overlapping branch conflicts', () => {
    const base = revision('r1', 1, { title: 'Orders', color: 'blue' });
    const target = revision('r2', 2, { title: 'Orders', color: 'green' });
    const source = revision('r3', 2, { title: 'Open orders', color: 'blue' });
    expect(planRevisionMerge(base, target, source)).toMatchObject({
      changes: [{ path: '/title', after: 'Open orders' }],
      conflicts: []
    });
    expect(
      planRevisionMerge(base, target, revision('r4', 2, { title: 'Orders', color: 'red' }))
        .conflicts
    ).toEqual([expect.objectContaining({ path: '/color' })]);
  });

  it('enforces role-aware approvals and does not grant editor merge authority', () => {
    expect(canPerformRevisionAction('editor', 'merge')).toBe(false);
    const evaluation = evaluateApprovalPolicy(
      { minimumApprovals: 2, requiredRoles: ['owner'], changesRequestedBlocks: true },
      [
        { id: 'a1', revisionId: 'r2', userId: 'owner-1', decision: 'approved', createdAt: 'x' },
        { id: 'a2', revisionId: 'r2', userId: 'admin-1', decision: 'approved', createdAt: 'x' },
        { id: 'a3', revisionId: 'r2', userId: 'editor-1', decision: 'approved', createdAt: 'x' }
      ],
      [
        { organizationId: 'org', userId: 'owner-1', role: 'owner' },
        { organizationId: 'org', userId: 'admin-1', role: 'admin' },
        { organizationId: 'org', userId: 'editor-1', role: 'editor' }
      ]
    );
    expect(evaluation).toMatchObject({ approved: true, approvedBy: ['admin-1', 'owner-1'] });
  });

  it('makes previously valid approvals stale after a generated design mutation', () => {
    const policy = {
      minimumApprovals: 1,
      requiredRoles: ['owner'] as const,
      changesRequestedBlocks: true
    };
    const approvals = [
      {
        id: 'a1',
        revisionId: 'r2',
        userId: 'owner-1',
        decision: 'approved' as const,
        createdAt: 'x'
      }
    ];
    const members = [{ organizationId: 'org', userId: 'owner-1', role: 'owner' as const }];
    expect(
      evaluateBaselineApprovalPolicy(
        { currency: 'current', approvalsStale: false },
        policy,
        approvals,
        members
      ).approved
    ).toBe(true);
    expect(
      evaluateBaselineApprovalPolicy(
        { currency: 'stale', approvalsStale: true },
        policy,
        approvals,
        members
      ).approved
    ).toBe(false);
  });
});
