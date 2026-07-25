import { useRef, useState } from 'react';

import type { DesignBaselineState } from '@selene/core';

import type { DesignerSnapshot, GeneratedCodePublishReceipt } from '../../../shared/designer-api';
import type { WorkspaceControlActions } from './workspace-controls';

export interface ReviewHandoffPanelProps {
  readonly baseline: DesignBaselineState;
  readonly actions: WorkspaceControlActions;
  readonly onSnapshot: (snapshot: DesignerSnapshot) => void;
  readonly onStatus: (message: string) => void;
  readonly onExportHandoff: (contents: string) => void;
  readonly publishStatus: string;
  readonly publishActive: boolean;
  readonly receipt?: Extract<GeneratedCodePublishReceipt, { readonly mode: 'github-remote' }>;
  readonly onOpenReceipt: () => Promise<void>;
}

/** A capability-limited summary of the host-backed review, publish, and handoff journey. */
export function ReviewHandoffPanel({
  baseline,
  actions,
  onSnapshot,
  onStatus,
  onExportHandoff,
  publishStatus,
  publishActive,
  receipt,
  onOpenReceipt
}: ReviewHandoffPanelProps) {
  const [status, setStatus] = useState('Choose a host-backed next step.');
  const [active, setActive] = useState<'review' | 'handoff' | 'export' | 'receipt'>();
  const activeRef = useRef(false);
  const run = (
    kind: NonNullable<typeof active>,
    work: () => Promise<DesignerSnapshot | string | void>,
    success: string
  ) => {
    if (activeRef.current) return;
    activeRef.current = true;
    setActive(kind);
    setStatus(`${success.replace(/\.$/, '')}…`);
    void work()
      .then((result) => {
        if (typeof result === 'object' && result !== null && 'apiVersion' in result) onSnapshot(result);
        setStatus(success);
        onStatus(success);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Host operation failed.';
        setStatus(message);
        onStatus(message);
      })
      .finally(() => {
        activeRef.current = false;
        setActive(undefined);
      });
  };
  const collaboration = receipt?.hostedReview.collaboration;

  return (
    <section className="review-handoff-panel" aria-label="Review and developer handoff">
      <header>
        <p className="review-handoff-panel__eyebrow">Release journey</p>
        <h2>Review → handoff</h2>
        <p>Design changes, stakeholder threads, and developer delivery remain separate records.</p>
      </header>
      <dl className="review-handoff-panel__baseline">
        <div>
          <dt>Readiness</dt>
          <dd>{baseline.readiness}</dd>
        </div>
        <div>
          <dt>Baseline</dt>
          <dd>{baseline.baseline ? `${baseline.baseline.intent} · ${baseline.currency}` : baseline.currency}</dd>
        </div>
        <div>
          <dt>Changes</dt>
          <dd>{baseline.changesSinceBaseline.length} since baseline</dd>
        </div>
      </dl>
      {baseline.approvalsStale ? (
        <p className="review-handoff-panel__notice" role="status">
          Prior approvals are stale; the host will evaluate readiness for the next step.
        </p>
      ) : null}
      <section className="review-handoff-panel__changes" aria-labelledby="review-handoff-changes">
        <h3 id="review-handoff-changes">Changed since baseline</h3>
        {baseline.changesSinceBaseline.length === 0 ? (
          <p>No recorded design changes since the current baseline.</p>
        ) : (
          <ul>
            {baseline.changesSinceBaseline.slice(0, 3).map((change) => (
              <li key={change.id}>
                <strong>{change.kind}</strong> · {change.reason}
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="review-handoff-panel__actions" role="group" aria-label="Review and handoff actions">
        <button
          type="button"
          disabled={active !== undefined}
          onClick={() =>
            run('review', actions.markReadyForReview, 'Marked the current design ready for review.')
          }
        >
          {active === 'review' ? 'Marking review…' : 'Ready for review'}
        </button>
        <button
          type="button"
          disabled={active !== undefined}
          onClick={() =>
            run('handoff', actions.markReadyForHandoff, 'Marked the current design ready for handoff.')
          }
        >
          {active === 'handoff' ? 'Preparing handoff…' : 'Ready for handoff'}
        </button>
        <button
          type="button"
          disabled={active !== undefined}
          onClick={() =>
            run(
              'export',
              () => actions.exportHandoff().then((contents) => {
                onExportHandoff(contents);
              }),
              'Exported the developer handoff.'
            )
          }
        >
          {active === 'export' ? 'Exporting handoff…' : 'Export handoff'}
        </button>
      </div>
      <section className="review-handoff-panel__publish" aria-label="Publish and hosted review status">
        <h3>Publish & hosted review</h3>
        <p>{publishStatus}</p>
        {publishActive ? <p aria-live="polite">The host publish operation is still active.</p> : null}
        {receipt ? (
          <div>
            <p>
              Published {receipt.repository} at {receipt.commitSha}.
            </p>
            <p>
              Static review: {receipt.hostedReview.staticReview.status}. Stakeholder collaboration:{' '}
              {collaboration?.status}.
            </p>
            <button
              type="button"
              disabled={active !== undefined}
              onClick={() => run('receipt', onOpenReceipt, 'Opened the immutable publish receipt.')}
            >
              {active === 'receipt' ? 'Opening receipt…' : 'Open publish receipt'}
            </button>
          </div>
        ) : (
          <p>Publish a remote artifact to receive a hosted-review receipt.</p>
        )}
      </section>
      <p className="review-handoff-panel__status" role="status" aria-live="polite">
        {status}
      </p>
    </section>
  );
}
