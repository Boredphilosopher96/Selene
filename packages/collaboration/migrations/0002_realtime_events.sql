-- Durable cursor stream for reconnecting clients. `cursor` is intentionally
-- global: a client must treat it as an opaque watermark, never as a count.
CREATE TABLE collaboration_events (
  cursor bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  project_id uuid NOT NULL REFERENCES projects(id),
  type text NOT NULL CHECK (char_length(type) BETWEEN 1 AND 128),
  actor_id uuid REFERENCES users(id),
  resource_type text NOT NULL CHECK (char_length(resource_type) BETWEEN 1 AND 128),
  resource_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collaboration_events_project_cursor_idx
  ON collaboration_events(project_id, cursor);
