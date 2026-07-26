-- Review mutations use a server-owned monotonically increasing version. The
-- idempotency table stores bounded compact operation receipts keyed by the
-- project/thread scope, in the same transaction as the row mutation.
ALTER TABLE review_threads
  ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT review_threads_version_positive_check CHECK (version >= 1);

CREATE INDEX review_thread_operation_receipts_idx
  ON idempotency_keys (scope, created_at)
  WHERE scope LIKE 'review:%';
