import { useEffect, useState } from 'react';

import {
  loadPublicationReview,
  publicationReviewRequestFromUrl,
  type VerifiedPublicationReview
} from './publication-review';

export function PublicationReviewPortal() {
  const [review, setReview] = useState<VerifiedPublicationReview>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const allowed = import.meta.env.VITE_PUBLICATION_ARTIFACT_ORIGIN as string | undefined;
        const request = publicationReviewRequestFromUrl(window.location.href, allowed);
        if (request === undefined)
          throw new Error('A checksum-pinned publication link is required.');
        const verified = await loadPublicationReview(request, {
          pageUrl: window.location.href,
          ...(allowed === undefined ? {} : { allowedArtifactOrigin: allowed }),
          signal: controller.signal
        });
        if (!controller.signal.aborted) setReview(verified);
      } catch {
        if (!controller.signal.aborted)
          setError(
            'This publication could not be verified. Check its immutable manifest link and checksum.'
          );
      }
    }
    void load();
    return () => controller.abort();
  }, []);
  if (error)
    return (
      <main className="review-portal">
        <h1>Publication unavailable</h1>
        <p role="alert">{error}</p>
      </main>
    );
  if (review === undefined)
    return (
      <main className="review-portal">
        <h1>Verifying publication</h1>
        <p role="status">Checking the manifest, source, graph and downloads.</p>
      </main>
    );
  return (
    <main
      className="publication-review"
      style={{
        maxWidth: 1100,
        margin: '0 auto',
        padding: 24,
        fontFamily: 'system-ui',
        lineHeight: 1.6
      }}
    >
      <h1>{review.projectId}</h1>
      <p role="status">
        Verified static artifact review. Team collaboration is not configured on this route.
      </p>
      <p>
        Source <code>{review.sourceRevisionId}</code> / Graph {review.graphRevision}{' '}
        <code>{review.graphRevisionId}</code>
      </p>
      <p>
        Build commit: <code>{review.buildCommit ?? 'Unavailable for this local build'}</code>
      </p>
      <p style={{ overflowWrap: 'anywhere' }}>
        Bundle <code>{review.immutableId}</code>
        <br />
        Manifest SHA-256 <code>{review.manifestSha256}</code>
      </p>
      <nav aria-label="Publication surfaces" style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        <a href={new URL('?view=prototype', review.baseUrl).href}>Open prototype</a>
        <a href={new URL('storybook/', review.baseUrl).href}>Open component catalog / Storybook</a>
      </nav>
      <h2>Baseline and exact changes</h2>
      <p>
        {review.baseline.readiness} / {review.baseline.currency}
        {review.baseline.approvalsStale ? ' / Reapproval required' : ''}
      </p>
      {review.baseline.baseline ? (
        <p>
          Baseline <code>{review.baseline.baseline.id}</code> pins{' '}
          <code>{review.baseline.baseline.revision.id}</code>.
        </p>
      ) : (
        <p>No recorded baseline.</p>
      )}
      {review.baseline.changesSinceBaseline.map((change) => (
        <article key={change.id}>
          <h3>
            {change.kind}: {change.reason}
          </h3>
          <p>
            <code>{change.beforeRevision.id}</code> to <code>{change.currentRevision.id}</code>
          </p>
          <p>
            Affected:{' '}
            {[
              ...change.affected.screenIds,
              ...change.affected.routePaths,
              ...change.affected.scenarioIds,
              ...change.affected.componentIds,
              ...change.affected.stableNodeIds
            ].join(', ')}
          </p>
        </article>
      ))}
      <h2>Scenarios</h2>
      <ul>
        {review.scenarios.map((scenario) => (
          <li key={scenario.id}>
            <a
              href={
                new URL(
                  '?view=prototype&scenario=' + encodeURIComponent(scenario.id),
                  review.baseUrl
                ).href
              }
            >
              {scenario.name}
            </a>
          </li>
        ))}
      </ul>
      <h2>Source and graph binding</h2>
      <p>
        {review.binding === 'compiler-bound'
          ? 'Compiler evidence matches the immutable source and graph.'
          : 'Draft handoff: compiler binding is unavailable. Element inspection is unavailable.'}{' '}
        Independent acceptance and deployed team features require separate evidence.
      </p>
      {review.handoff.reactBinding === null ? null : (
        <ul>
          {review.handoff.reactBinding.nodeBindings.map((binding) => (
            <li key={binding.graphNodeId}>
              <code>{binding.graphNodeId}</code> to <code>{binding.sourceNodeId}</code>
            </li>
          ))}
        </ul>
      )}
      <h2>Immutable downloads</h2>
      <ul>
        {review.artifacts.map((artifact) => (
          <li key={artifact.kind} style={{ overflowWrap: 'anywhere' }}>
            <a download href={artifact.url}>
              Download {artifact.kind}
            </a>{' '}
            / {artifact.bytes} bytes / SHA-256 <code>{artifact.sha256}</code>
          </li>
        ))}
      </ul>
      <p>
        This route reads verified artifacts. It does not grant authoring, publish or deployment
        permissions.
      </p>
    </main>
  );
}
