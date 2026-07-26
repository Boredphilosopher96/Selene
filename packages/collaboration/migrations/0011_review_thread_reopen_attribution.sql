-- Preserve the latest reopen actor and timestamp as durable review history.
-- Existing rows remain valid because both columns are nullable and are added
-- together before paired and chronological invariants are enforced.
ALTER TABLE review_threads
  ADD COLUMN reopened_at timestamptz,
  ADD COLUMN reopened_by text;

ALTER TABLE review_threads
  ADD CONSTRAINT review_threads_reopen_metadata_check
    CHECK ((reopened_at IS NULL) = (reopened_by IS NULL)),
  ADD CONSTRAINT review_threads_reopen_created_order_check
    CHECK (reopened_at IS NULL OR reopened_at > created_at),
  ADD CONSTRAINT review_threads_reopen_resolved_order_check
    CHECK (reopened_at IS NULL OR resolved_at IS NULL OR resolved_at > reopened_at);
