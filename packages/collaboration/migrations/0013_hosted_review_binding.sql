-- Hosted review threads retain the exact server-owned tenant/artifact/revision/
-- baseline contract that authorized their creation. Browser deep links remain
-- presentation-only and cannot reconstruct or change this binding.
ALTER TABLE review_threads
  ADD COLUMN hosted_binding jsonb;

ALTER TABLE review_threads
  ADD CONSTRAINT review_threads_hosted_binding_object_check
  CHECK (hosted_binding IS NULL OR jsonb_typeof(hosted_binding) = 'object');

CREATE INDEX review_threads_hosted_binding_idx
  ON review_threads (
    project_id,
    (hosted_binding ->> 'artifactId'),
    (hosted_binding ->> 'revisionId'),
    (hosted_binding ->> 'baselineId')
  )
  WHERE hosted_binding IS NOT NULL;
