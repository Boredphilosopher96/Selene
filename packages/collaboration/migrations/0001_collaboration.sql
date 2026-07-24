-- Selene collaboration service schema.  Apply with a transaction-aware migrator.
-- IDs are application generated UUIDs so local/offline clients can safely retry.
CREATE TABLE organizations (
  id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE users (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
  external_subject text, email text NOT NULL, display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (organization_id, external_subject), UNIQUE (organization_id, email)
);
CREATE TABLE memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner','admin','editor','commenter','viewer','guest')),
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  PRIMARY KEY (organization_id, user_id)
);
CREATE TABLE projects (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE revisions (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), sequence integer NOT NULL CHECK (sequence > 0),
  parent_revision_id uuid REFERENCES revisions(id), content jsonb NOT NULL, content_sha256 char(64) NOT NULL,
  scenario_ids jsonb NOT NULL DEFAULT '[]'::jsonb, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, sequence), UNIQUE (project_id, content_sha256)
);
CREATE TABLE threads (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), revision_id uuid NOT NULL REFERENCES revisions(id),
  react_node_id text NOT NULL, scenario_id text NOT NULL, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz, resolved_by uuid REFERENCES users(id), CHECK (char_length(react_node_id) BETWEEN 1 AND 128),
  CHECK (char_length(scenario_id) BETWEEN 1 AND 128)
);
CREATE TABLE comments (
  id uuid PRIMARY KEY, thread_id uuid NOT NULL REFERENCES threads(id), parent_comment_id uuid REFERENCES comments(id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000), created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), edited_at timestamptz
);
CREATE TABLE comment_mentions (comment_id uuid NOT NULL REFERENCES comments(id), user_id uuid NOT NULL REFERENCES users(id), PRIMARY KEY (comment_id, user_id));
CREATE TABLE comment_reactions (comment_id uuid NOT NULL REFERENCES comments(id), user_id uuid NOT NULL REFERENCES users(id), emoji text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 64), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (comment_id, user_id, emoji));
CREATE TABLE approvals (id uuid PRIMARY KEY, revision_id uuid NOT NULL REFERENCES revisions(id), user_id uuid NOT NULL REFERENCES users(id), decision text NOT NULL CHECK (decision IN ('approved','changes_requested')), note text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (revision_id, user_id));
CREATE TABLE share_links (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), token_hash char(64) NOT NULL UNIQUE, permission text NOT NULL CHECK (permission IN ('viewer','commenter')), expires_at timestamptz NOT NULL, revoked_at timestamptz, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE audit_events (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), actor_id uuid REFERENCES users(id), action text NOT NULL, resource_type text NOT NULL, resource_id uuid NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, occurred_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE idempotency_keys (scope text NOT NULL, key text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (scope, key));
CREATE INDEX revisions_project_sequence_idx ON revisions(project_id, sequence DESC);
CREATE INDEX threads_revision_anchor_idx ON threads(revision_id, react_node_id, scenario_id);
CREATE INDEX comments_thread_created_idx ON comments(thread_id, created_at);
CREATE INDEX audit_events_organization_occurred_idx ON audit_events(organization_id, occurred_at DESC);
CREATE INDEX share_links_active_idx ON share_links(project_id, expires_at) WHERE revoked_at IS NULL;
