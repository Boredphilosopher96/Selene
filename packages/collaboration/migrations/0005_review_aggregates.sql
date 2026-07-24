-- Portable review, AI-change, and developer-handoff aggregates.  The nested
-- payloads are versioned by the collaboration snapshot and validated in the
-- domain layer before persistence; relational ownership remains in Postgres.
CREATE TABLE review_threads (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  revision_id uuid NOT NULL,
  anchor jsonb NOT NULL,
  messages jsonb NOT NULL,
  deep_link text NOT NULL CHECK (char_length(deep_link) BETWEEN 1 AND 2048),
  lifecycle text NOT NULL CHECK (lifecycle IN ('open', 'resolved')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolved_by text,
  moved_at timestamptz,
  moved_by text,
  CHECK ((lifecycle = 'open' AND resolved_at IS NULL AND resolved_by IS NULL) OR
         (lifecycle = 'resolved' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)),
  CONSTRAINT review_threads_project_revision_project_fkey
    FOREIGN KEY (project_id, revision_id) REFERENCES revisions(project_id, id)
);
CREATE TABLE ai_change_requests (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  base_revision_id uuid NOT NULL,
  request jsonb NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('queued', 'running', 'applied', 'failed', 'cancelled')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT ai_change_requests_project_revision_project_fkey
    FOREIGN KEY (project_id, base_revision_id) REFERENCES revisions(project_id, id)
);
CREATE TABLE developer_annotations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  revision_id uuid NOT NULL,
  annotation jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT developer_annotations_project_revision_project_fkey
    FOREIGN KEY (project_id, revision_id) REFERENCES revisions(project_id, id)
);
CREATE INDEX review_threads_project_created_idx ON review_threads(project_id, created_at);
CREATE INDEX ai_change_requests_project_updated_idx ON ai_change_requests(project_id, updated_at);
CREATE INDEX developer_annotations_project_created_idx ON developer_annotations(project_id, created_at);
