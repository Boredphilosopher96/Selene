-- Enforce that every revision, thread, and generated-design baseline remains
-- within one project. This is forward-only so deployed 0001-0003 schemas gain
-- the same protection as newly provisioned databases.
ALTER TABLE revisions
  ADD CONSTRAINT revisions_project_id_id_key UNIQUE (project_id, id);

ALTER TABLE revisions
  ADD CONSTRAINT revisions_parent_revision_project_fkey
  FOREIGN KEY (project_id, parent_revision_id) REFERENCES revisions(project_id, id);

ALTER TABLE threads
  ADD CONSTRAINT threads_project_revision_project_fkey
  FOREIGN KEY (project_id, revision_id) REFERENCES revisions(project_id, id);

ALTER TABLE design_baselines
  ADD CONSTRAINT design_baselines_project_revision_project_fkey
  FOREIGN KEY (project_id, revision_id) REFERENCES revisions(project_id, id);

ALTER TABLE design_review_states
  ADD CONSTRAINT design_review_states_project_baseline_project_fkey
  FOREIGN KEY (project_id, baseline_id) REFERENCES design_baselines(project_id, id);

ALTER TABLE design_baseline_changes
  ADD CONSTRAINT design_baseline_changes_project_baseline_project_fkey
  FOREIGN KEY (project_id, baseline_id) REFERENCES design_baselines(project_id, id),
  ADD CONSTRAINT design_baseline_changes_before_revision_project_fkey
  FOREIGN KEY (project_id, before_revision_id) REFERENCES revisions(project_id, id),
  ADD CONSTRAINT design_baseline_changes_current_revision_project_fkey
  FOREIGN KEY (project_id, current_revision_id) REFERENCES revisions(project_id, id);
