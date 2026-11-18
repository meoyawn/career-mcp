-- The reason and message for a closed or offered application belong to its
-- current status, separate from free-form notes. Existing notes are not parsed.
ALTER TABLE jobs ADD COLUMN outcome TEXT
  CHECK (outcome IS NULL OR (
    phase IS 'application' AND status IS NOT 'active'
    AND json_valid(outcome) AND json_type(outcome) IS 'object'
    AND (json_type(outcome, '$.message') IS 'text' OR json_type(outcome, '$.reason') IS 'text')
  ));
