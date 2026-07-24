-- Generated-design baselines are intentionally distinct from package/release history.
-- A baseline pins the exact generated revision a reviewer or handoff recipient saw.
CREATE TABLE design_baselines (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  revision_id uuid NOT NULL REFERENCES revisions(id),
  intent text NOT NULL CHECK (intent IN ('review','handoff')),
  revision_fingerprint text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id)
);

CREATE TABLE design_review_states (
  project_id uuid PRIMARY KEY REFERENCES projects(id),
  readiness text NOT NULL CHECK (readiness IN ('draft','ready-for-review','ready-for-handoff')),
  baseline_id uuid REFERENCES design_baselines(id),
  currency text NOT NULL CHECK (currency IN ('current','stale','none')),
  approvals_stale boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Each row is a semantic generated-design change, never a release note. All
-- affected IDs and visual evidence are kept as portable data for re-review.
CREATE TABLE design_baseline_changes (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  baseline_id uuid REFERENCES design_baselines(id),
  kind text NOT NULL CHECK (kind IN ('source','design-system','token','template','dependency','visual')),
  before_revision_id uuid NOT NULL REFERENCES revisions(id),
  current_revision_id uuid NOT NULL REFERENCES revisions(id),
  affected jsonb NOT NULL,
  evidence jsonb NOT NULL,
  provenance jsonb NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 4000),
  occurred_at timestamptz NOT NULL
);
CREATE INDEX design_baseline_changes_project_baseline_idx
  ON design_baseline_changes(project_id, baseline_id, occurred_at);

-- Hosts call this in the same transaction that transitions a generated design
-- to review/handoff. It resets the exact re-review set and approval currency.
CREATE FUNCTION mark_generated_design_ready(
  p_baseline uuid, p_project uuid, p_revision uuid, p_baseline_intent text,
  p_fingerprint text, p_actor uuid, p_occurred timestamptz
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM revisions WHERE id = p_revision AND project_id = p_project FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'baseline revision must belong to project'; END IF;
  INSERT INTO design_baselines(id, project_id, revision_id, intent, revision_fingerprint, created_by, created_at)
  VALUES (p_baseline, p_project, p_revision, p_baseline_intent, p_fingerprint, p_actor, p_occurred);
  INSERT INTO design_review_states(project_id, readiness, baseline_id, currency, approvals_stale, updated_at)
  VALUES (p_project, CASE p_baseline_intent WHEN 'review' THEN 'ready-for-review' ELSE 'ready-for-handoff' END,
    p_baseline, 'current', false, p_occurred)
  ON CONFLICT (project_id) DO UPDATE SET readiness = EXCLUDED.readiness,
    baseline_id = EXCLUDED.baseline_id, currency = 'current', approvals_stale = false, updated_at = EXCLUDED.updated_at;
END;
$$;

-- Design-affecting mutations create re-review work and stale prior approvals;
-- collaboration-only audit events never call this function.
CREATE FUNCTION record_generated_design_change(
  p_change_id uuid, p_project uuid, p_change_kind text, p_before_revision uuid, p_current_revision uuid, p_change_affected jsonb,
  p_change_evidence jsonb, p_change_provenance jsonb, p_change_reason text, p_occurred timestamptz
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE active_baseline uuid;
BEGIN
  SELECT baseline_id INTO active_baseline FROM design_review_states WHERE project_id = p_project FOR UPDATE;
  IF active_baseline IS NULL THEN RAISE EXCEPTION 'project has no active design baseline'; END IF;
  PERFORM 1 FROM design_baselines WHERE id = active_baseline AND project_id = p_project FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'baseline must belong to project'; END IF;
  IF (SELECT count(*) FROM revisions WHERE id IN (p_before_revision, p_current_revision) AND project_id = p_project) <> 2 THEN
    RAISE EXCEPTION 'design change revisions must belong to project';
  END IF;
  INSERT INTO design_baseline_changes(id, project_id, baseline_id, kind, before_revision_id, current_revision_id,
    affected, evidence, provenance, reason, occurred_at)
  VALUES (p_change_id, p_project, active_baseline, p_change_kind, p_before_revision, p_current_revision,
    p_change_affected, p_change_evidence, p_change_provenance, p_change_reason, p_occurred);
  UPDATE design_review_states SET currency = 'stale', approvals_stale = true, updated_at = p_occurred
    WHERE project_id = p_project;
END;
$$;
