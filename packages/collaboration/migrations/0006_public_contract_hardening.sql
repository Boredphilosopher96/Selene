-- Forward-compatible public-contract hardening for existing v2 installations.
ALTER TABLE ai_change_requests
  DROP CONSTRAINT ai_change_requests_lifecycle_check,
  ADD CONSTRAINT ai_change_requests_lifecycle_check
    CHECK (lifecycle IN ('queued', 'running', 'applied', 'failed', 'cancelled', 'undone'));

-- Annotations created before categories were introduced retain a deterministic
-- compatibility category instead of making an otherwise-valid export unreadable.
UPDATE developer_annotations
SET annotation = jsonb_set(annotation, '{category}', '"development"'::jsonb, true)
WHERE NOT annotation ? 'category';
