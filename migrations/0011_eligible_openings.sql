-- Preserve legacy records and their histories; new leads need verified evidence.
ALTER TABLE jobs ADD COLUMN eligible_opening TEXT CHECK (
  eligible_opening IS NULL OR (
    json_valid(eligible_opening) AND json_type(eligible_opening) IS 'object'
    AND json_type(eligible_opening, '$.title') IS 'text' AND length(trim(json_extract(eligible_opening, '$.title'))) > 0
    AND json_type(eligible_opening, '$.description') IS 'text' AND length(trim(json_extract(eligible_opening, '$.description'))) > 0
    AND json_type(eligible_opening, '$.source_url') IS 'text'
    AND (json_extract(eligible_opening, '$.source_url') GLOB 'https://?*' OR json_extract(eligible_opening, '$.source_url') GLOB 'http://?*')
    AND json_type(eligible_opening, '$.location') IS 'text' AND length(trim(json_extract(eligible_opening, '$.location'))) > 0
    AND json_extract(eligible_opening, '$.status') IS 'open'
    AND json_extract(eligible_opening, '$.eligibility') IS 'eligible'
    AND json_type(eligible_opening, '$.eligibility_reason') IS 'text' AND length(trim(json_extract(eligible_opening, '$.eligibility_reason'))) > 0
    AND json_type(eligible_opening, '$.checked_at') IS 'text' AND julianday(json_extract(eligible_opening, '$.checked_at')) IS NOT NULL
    AND json_type(eligible_opening, '$.criteria_updated_at') IS 'text' AND julianday(json_extract(eligible_opening, '$.criteria_updated_at')) IS NOT NULL
  )
);

CREATE TRIGGER jobs_require_eligible_opening_insert BEFORE INSERT ON jobs
WHEN NEW.phase IS 'lead'
BEGIN
  SELECT CASE WHEN NEW.eligible_opening IS NULL
    THEN RAISE(ABORT, 'A lead requires a verified eligible opening') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM criteria WHERE user_id IS NEW.user_id
      AND updated_at IS json_extract(NEW.eligible_opening, '$.criteria_updated_at')
  ) THEN RAISE(ABORT, 'Opening eligibility must use current saved criteria') END;
  SELECT CASE WHEN coalesce(julianday(json_extract(NEW.eligible_opening, '$.checked_at')) BETWEEN julianday('now') - 1 AND julianday('now'), 0) IS 0
    THEN RAISE(ABORT, 'Opening verification must be within the last 24 hours') END;
END;

CREATE TRIGGER jobs_require_eligible_opening_update
BEFORE UPDATE OF company, company_url, phase, eligible_opening, status ON jobs
WHEN NEW.phase IS 'lead' AND NEW.status IN ('active', 'offer') AND (
  NEW.company IS NOT OLD.company OR NEW.company_url IS NOT OLD.company_url
  OR NEW.phase IS NOT OLD.phase OR NEW.eligible_opening IS NOT OLD.eligible_opening OR NEW.status IS NOT OLD.status
)
BEGIN
  SELECT CASE WHEN NEW.eligible_opening IS NULL
    THEN RAISE(ABORT, 'A lead requires a verified eligible opening') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM criteria WHERE user_id IS NEW.user_id
      AND updated_at IS json_extract(NEW.eligible_opening, '$.criteria_updated_at')
  ) THEN RAISE(ABORT, 'Opening eligibility must use current saved criteria') END;
  SELECT CASE WHEN coalesce(julianday(json_extract(NEW.eligible_opening, '$.checked_at')) BETWEEN julianday('now') - 1 AND julianday('now'), 0) IS 0
    THEN RAISE(ABORT, 'Opening verification must be within the last 24 hours') END;
END;

CREATE UNIQUE INDEX jobs_eligible_opening_url ON jobs(user_id, json_extract(eligible_opening, '$.source_url'))
WHERE phase IS 'lead' AND eligible_opening IS NOT NULL;
