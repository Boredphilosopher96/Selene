import { describe, expect, it } from 'vitest';

import {
  createDeveloperRecheckManifest,
  dispatchDesignBaselineCommand,
  executeDesignBaselineCommand,
  markDesignReady,
  recordCollaborationActivity,
  recordDesignMutation,
  type DesignBaselineState,
  type SemanticDesignChange
} from './design-baseline';

const base: DesignBaselineState = {
  projectId: 'commerce-shell',
  readiness: 'draft',
  currency: 'none',
  changesSinceBaseline: [],
  approvalsStale: false
};
const baseline = {
  id: 'baseline-1',
  projectId: 'commerce-shell',
  revision: { id: 'revision-1', fingerprint: 'sha256:initial' },
  intent: 'review' as const,
  createdAt: '2026-07-23T22:00:00Z',
  createdBy: 'designer-1'
};
const change: SemanticDesignChange = {
  id: 'change-1',
  kind: 'token',
  beforeRevision: baseline.revision,
  currentRevision: { id: 'revision-2', fingerprint: 'sha256:changed' },
  affected: {
    projectId: 'commerce-shell',
    screenIds: ['orders'],
    routePaths: ['/orders'],
    scenarioIds: ['empty'],
    componentIds: ['OrdersList'],
    stableNodeIds: ['orders.empty-state']
  },
  evidence: [{ description: 'Empty state screenshot', href: 'evidence/orders-empty.png' }],
  provenance: { kind: 'agent', agentId: 'selene-agent', promptDigest: 'sha256:prompt' },
  occurredAt: '2026-07-23T22:01:00Z',
  reason: 'Align empty-state spacing with the approved token scale.'
};

describe('generated design baseline', () => {
  it('atomically creates a current immutable baseline when review is requested', () => {
    const ready = markDesignReady(base, 'review', baseline);
    expect(ready.state).toMatchObject({
      readiness: 'ready-for-review',
      currency: 'current',
      approvalsStale: false,
      baseline: { id: 'baseline-1' }
    });
  });

  it('makes a design-affecting mutation stale with exact developer recheck context', () => {
    const ready = markDesignReady(base, 'review', baseline).state;
    const stale = recordDesignMutation(ready, change);
    const manifest = createDeveloperRecheckManifest(stale);
    expect(manifest).toMatchObject({
      baselineId: 'baseline-1',
      currency: 'stale',
      approvalsStale: true
    });
    expect(manifest.exactChangesToRecheck[0]?.beforeRevision.id).toBe('revision-1');
    expect(manifest.exactChangesToRecheck[0]?.currentRevision.id).toBe('revision-2');
    expect(manifest.exactChangesToRecheck[0]?.affected.stableNodeIds).toEqual([
      'orders.empty-state'
    ]);
  });

  it('does not let collaboration-only activity falsely dirty a review baseline', () => {
    const ready = markDesignReady(base, 'review', baseline).state;
    const afterComment = recordCollaborationActivity(ready, {
      type: 'comment.created',
      actorId: 'reviewer-1',
      occurredAt: '2026-07-23T22:01:00Z'
    });
    expect(afterComment).toBe(ready);
    expect(afterComment.currency).toBe('current');
  });

  it('runs ready → generated design mutation → stale through the central host workflow', async () => {
    const committed: { state: DesignBaselineState; collaborationActivity?: { type: string } }[] =
      [];
    const audits: string[] = [];
    const port = {
      commit: async (transaction: {
        state: DesignBaselineState;
        collaborationActivity?: { type: string };
      }) => {
        committed.push(transaction);
        if (transaction.collaborationActivity) audits.push(transaction.collaborationActivity.type);
      }
    };
    const ready = await dispatchDesignBaselineCommand(port, base, {
      type: 'mark-ready',
      intent: 'review',
      baseline
    });
    const stale = await dispatchDesignBaselineCommand(port, ready, {
      type: 'apply-design-mutation',
      change
    });
    const afterComment = await dispatchDesignBaselineCommand(port, stale, {
      type: 'record-collaboration-activity',
      activity: {
        type: 'comment.created',
        occurredAt: '2026-07-23T22:02:00Z',
        actorId: 'reviewer-1'
      }
    });
    expect(committed.map(({ state }) => state.currency)).toEqual(['current', 'stale', 'stale']);
    expect(afterComment.changesSinceBaseline).toHaveLength(1);
    expect(afterComment.approvalsStale).toBe(true);
    expect(audits).toEqual(['comment.created']);
    expect(committed[2]?.collaborationActivity?.type).toBe('comment.created');
  });

  it('does not allow a status command to bypass central design mutation classification', () => {
    const ready = executeDesignBaselineCommand(base, {
      type: 'mark-ready',
      intent: 'review',
      baseline
    });
    expect(
      executeDesignBaselineCommand(ready, { type: 'apply-design-mutation', change }).currency
    ).toBe('stale');
  });

  it('rejects adversarial incomplete provenance, visual evidence, duplicate anchors, and no-op revisions', () => {
    const ready = markDesignReady(base, 'review', baseline).state;
    expect(() => recordDesignMutation(ready, { ...change, evidence: [] })).toThrow(
      /visual evidence/
    );
    expect(() =>
      recordDesignMutation(ready, {
        ...change,
        currentRevision: baseline.revision
      })
    ).toThrow(/advance/);
    expect(() =>
      recordDesignMutation(ready, {
        ...change,
        affected: {
          ...change.affected,
          stableNodeIds: ['orders.empty-state', 'orders.empty-state']
        }
      })
    ).toThrow(/unique/);
    expect(() =>
      recordDesignMutation(ready, {
        ...change,
        provenance: { kind: 'agent', agentId: 'selene-agent', promptDigest: '' }
      })
    ).toThrow(/promptDigest/);
  });

  it('rejects a baseline or design mutation from another project', () => {
    expect(() =>
      markDesignReady(base, 'review', { ...baseline, projectId: 'other-project' })
    ).toThrow(/belong to the design baseline state project/);
    const ready = markDesignReady(base, 'review', baseline).state;
    expect(() =>
      recordDesignMutation(ready, {
        ...change,
        affected: { ...change.affected, projectId: 'other-project' }
      })
    ).toThrow(/belong to the design baseline state project/);
  });
});
