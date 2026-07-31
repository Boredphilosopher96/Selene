import type { DesignerSnapshot, GeneratedCodePublishReceipt } from '../../../shared/designer-api';
import { safeDesignerNotice } from '../presentation-error';
import type { ReviewHandoffAction } from './review-handoff-actions';

export interface ReviewHandoffPanelProps {
  readonly baseline: DesignerSnapshot['baseline'];
  readonly productMap?: DesignerSnapshot['productMap'];
  readonly productMapBusy: boolean;
  readonly productHandoffBusy: boolean;
  readonly onConfigureProductShell: (childProjectIds: readonly string[]) => void;
  readonly onExportProductHandoff: () => void;
  readonly active?: ReviewHandoffAction;
  readonly status: string;
  readonly reviewDisabled: boolean;
  readonly handoffDisabled: boolean;
  readonly exportDisabled: boolean;
  readonly receiptDisabled: boolean;
  readonly onReadyForReview: () => void;
  readonly onReadyForHandoff: () => void;
  readonly onExportHandoff: () => void;
  readonly onOpenReceipt: () => void;
  readonly publishStatus: string;
  readonly publishBusy: boolean;
  readonly receipt?: Extract<GeneratedCodePublishReceipt, { readonly mode: 'github-remote' }>;
}

function humanizeStatus(value: string): string {
  const words = value.replaceAll('-', ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** A capability-limited summary of the host-backed review, publish, and handoff journey. */
export function ReviewHandoffPanel({
  baseline,
  productMap,
  productMapBusy,
  productHandoffBusy,
  onConfigureProductShell,
  onExportProductHandoff,
  active,
  status,
  reviewDisabled,
  handoffDisabled,
  exportDisabled,
  receiptDisabled,
  onReadyForReview,
  onReadyForHandoff,
  onExportHandoff,
  onOpenReceipt,
  publishStatus,
  publishBusy,
  receipt
}: ReviewHandoffPanelProps) {
  return (
    <section
      className="review-handoff-panel"
      aria-busy={active !== undefined || publishBusy || undefined}
      aria-label="Review and developer handoff"
    >
      <header>
        <p className="review-handoff-panel__eyebrow">Design delivery</p>
        <h2>Review → handoff</h2>
        <p>Design changes, stakeholder threads, and developer delivery remain separate records.</p>
      </header>
      <dl className="review-handoff-panel__baseline">
        <div>
          <dt>Readiness</dt>
          <dd>
            {baseline.readiness === 'draft'
              ? 'Draft'
              : baseline.readiness === 'ready-for-review'
                ? 'Ready for review'
                : 'Ready for handoff'}
          </dd>
        </div>
        <div>
          <dt>Baseline</dt>
          <dd>
            {baseline.baseline
              ? `${baseline.baseline.intent === 'review' ? 'Review' : 'Handoff'} · ${
                  baseline.currency === 'current' ? 'Current' : 'Changed'
                }`
              : 'Not set'}
          </dd>
        </div>
        <div>
          <dt>Changes</dt>
          <dd>{baseline.changesSinceBaseline.length} since baseline</dd>
        </div>
      </dl>
      {productMap ? (
        <section className="review-handoff-panel__product-map" aria-labelledby="product-map-title">
          <header>
            <div>
              <p className="review-handoff-panel__eyebrow">Product structure</p>
              <h3 id="product-map-title">Local project portfolio</h3>
            </div>
            <span className="sl-status-badge sl-status-badge--neutral">
              {productMap.projects.length}{' '}
              {productMap.projects.length === 1 ? 'project' : 'projects'}
            </span>
          </header>
          <p>
            {productMap.scope.kind === 'standalone'
              ? 'These workspaces are independent. No product shell currently claims their routes or source.'
              : `Shell ${productMap.scope.shellProjectId} coordinates this product.`}
          </p>
          <ul aria-label="Product projects">
            {productMap.projects.map((project) => {
              const current = project.projectId === productMap.currentProjectId;
              const projectStatus =
                project.readiness === 'draft'
                  ? 'Draft'
                  : project.currency === 'stale'
                    ? 'Changed'
                    : project.readiness === 'ready-for-review'
                      ? 'Review ready'
                      : 'Handoff ready';
              return (
                <li key={project.projectId} data-current={current || undefined}>
                  <div>
                    <strong>{project.name}</strong>
                    <span>
                      {humanizeStatus(project.role)}
                      {current ? ' · Current workspace' : ''}
                    </span>
                  </div>
                  <span
                    className={`sl-status-badge ${
                      project.currency === 'stale'
                        ? 'sl-status-badge--warning'
                        : 'sl-status-badge--neutral'
                    }`}
                  >
                    {projectStatus}
                    {project.changesSinceBaseline > 0
                      ? ` · ${project.changesSinceBaseline} changed`
                      : ''}
                  </span>
                </li>
              );
            })}
          </ul>
          {(() => {
            const current = productMap.projects.find(
              (project) => project.projectId === productMap.currentProjectId
            );
            if (current?.role === 'child') {
              return (
                <p className="review-handoff-panel__map-note">
                  Membership is managed by shell {current.shellProjectId}.
                </p>
              );
            }
            const candidates = productMap.projects.filter(
              (project) => project.projectId !== productMap.currentProjectId
            );
            if (candidates.length === 0)
              return (
                <p className="review-handoff-panel__map-note">
                  Create another local project to compose a product shell.
                </p>
              );
            return (
              <form
                className="review-handoff-panel__map-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const childProjectIds = new FormData(event.currentTarget)
                    .getAll('product-child')
                    .filter((value): value is string => typeof value === 'string');
                  onConfigureProductShell(childProjectIds);
                }}
              >
                <fieldset disabled={productMapBusy}>
                  <legend>Projects in this shell</legend>
                  {candidates.map((project) => {
                    const belongsToCurrentShell =
                      project.shellProjectId === productMap.currentProjectId;
                    const claimedElsewhere =
                      project.shellProjectId !== undefined && !belongsToCurrentShell;
                    return (
                      <label key={project.projectId}>
                        <input
                          defaultChecked={belongsToCurrentShell}
                          disabled={claimedElsewhere || project.role === 'shell'}
                          name="product-child"
                          type="checkbox"
                          value={project.projectId}
                        />
                        <span>
                          <strong>{project.name}</strong>
                          <small>
                            {claimedElsewhere
                              ? `Owned by ${project.shellProjectId}`
                              : project.role === 'shell'
                                ? 'Product shell'
                                : 'Independent local project'}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
                <button
                  className="review-handoff-panel__secondary"
                  disabled={productMapBusy}
                  type="submit"
                >
                  {productMapBusy ? 'Saving product structure…' : 'Save product structure'}
                </button>
              </form>
            );
          })()}
          {productMap.scope.kind === 'federation' &&
          productMap.scope.shellProjectId === productMap.currentProjectId
            ? (() => {
                const members = productMap.projects.filter(
                  (project) => project.shellProjectId === productMap.currentProjectId
                );
                const blockers = members.filter(
                  (project) =>
                    project.readiness !== 'ready-for-handoff' || project.currency !== 'current'
                );
                const enoughProjects = members.length >= 3;
                return (
                  <section
                    className="review-handoff-panel__product-export"
                    aria-label="Product developer handoff"
                  >
                    <div>
                      <strong>Product developer handoff</strong>
                      <span>
                        {enoughProjects
                          ? `${members.length} independently owned projects · ${blockers.length} ${
                              blockers.length === 1 ? 'blocker' : 'blockers'
                            }`
                          : 'Add at least two child projects to export a federated handoff.'}
                      </span>
                    </div>
                    <button
                      className="review-handoff-panel__secondary"
                      disabled={!enoughProjects || productHandoffBusy}
                      onClick={onExportProductHandoff}
                      type="button"
                    >
                      {productHandoffBusy ? 'Exporting product…' : 'Export product handoff'}
                    </button>
                  </section>
                );
              })()
            : null}
        </section>
      ) : null}
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
                <strong>{humanizeStatus(change.kind)}</strong> · {change.reason}
              </li>
            ))}
            {baseline.changesSinceBaseline.length > 3 ? (
              <li>And {baseline.changesSinceBaseline.length - 3} more design changes.</li>
            ) : null}
          </ul>
        )}
      </section>
      {publishBusy ? (
        <p className="review-handoff-panel__notice" role="status">
          Readiness and handoff actions are locked while publish consent or the immutable host
          operation finishes.
        </p>
      ) : exportDisabled && active === undefined ? (
        <p className="review-handoff-panel__notice">
          Mark the exact current design ready for handoff before exporting its developer package.
        </p>
      ) : null}
      <div
        className="review-handoff-panel__actions"
        role="group"
        aria-label="Review and handoff actions"
      >
        <button
          className="review-handoff-panel__secondary"
          type="button"
          disabled={reviewDisabled}
          onClick={onReadyForReview}
        >
          {active === 'review' ? 'Marking review…' : 'Ready for review'}
        </button>
        <button type="button" disabled={handoffDisabled} onClick={onReadyForHandoff}>
          {active === 'handoff' ? 'Preparing handoff…' : 'Ready for handoff'}
        </button>
        <button
          className="review-handoff-panel__secondary"
          type="button"
          disabled={exportDisabled}
          onClick={onExportHandoff}
        >
          {active === 'export' ? 'Exporting handoff…' : 'Export handoff'}
        </button>
      </div>
      <section
        className="review-handoff-panel__publish"
        aria-label="Publish and hosted review status"
      >
        <h3>Publish & hosted review</h3>
        <p>{safeDesignerNotice(publishStatus, 'Publish status is unavailable. Try again.')}</p>
        {publishBusy ? (
          <p aria-live="polite">The trusted publish workflow is still active.</p>
        ) : null}
        {receipt ? (
          <div>
            <p>
              Published {receipt.repository} · commit {receipt.commitSha.slice(0, 7)}.
            </p>
            <p>
              Static review: {humanizeStatus(receipt.hostedReview.staticReview.status)}. Stakeholder
              collaboration: {humanizeStatus(receipt.hostedReview.collaboration.status)}.
            </p>
            <button
              className="review-handoff-panel__secondary"
              type="button"
              disabled={receiptDisabled}
              onClick={onOpenReceipt}
            >
              {active === 'receipt' ? 'Opening receipt…' : 'Open publish receipt'}
            </button>
          </div>
        ) : (
          <p>Publish a remote artifact to receive a hosted-review receipt.</p>
        )}
      </section>
      <p className="review-handoff-panel__status" role="status" aria-live="polite">
        {safeDesignerNotice(status, 'Handoff status is unavailable. Try the action again.')}
      </p>
    </section>
  );
}
