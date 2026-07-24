-- Rows written before compensating undo results were distinct only retained the
-- historical result. Preserve that evidence and make it explicit on upgrade.
UPDATE ai_change_requests
SET request = jsonb_set(request, '{undoResult}', request -> 'result', true)
WHERE lifecycle = 'undone'
  AND request ? 'result'
  AND NOT request ? 'undoResult';
