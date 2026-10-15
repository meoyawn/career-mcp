-- Phase selection cannot bypass the evidence required for a new employer record.
DROP TRIGGER jobs_require_eligible_opening_insert;
CREATE TRIGGER jobs_require_eligible_opening_insert BEFORE INSERT ON jobs
BEGIN
  SELECT CASE WHEN NEW.eligible_opening IS NULL
    THEN RAISE(ABORT, 'Every new job record requires a verified eligible opening') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM criteria WHERE user_id IS NEW.user_id
      AND updated_at IS json_extract(NEW.eligible_opening, '$.criteria_updated_at')
  ) THEN RAISE(ABORT, 'Opening eligibility must use current saved criteria') END;
  SELECT CASE WHEN coalesce(julianday(json_extract(NEW.eligible_opening, '$.checked_at')) BETWEEN julianday('now') - 1 AND julianday('now'), 0) IS 0
    THEN RAISE(ABORT, 'Opening verification must be within the last 24 hours') END;
END;

CREATE TRIGGER jobs_require_eligible_opening_employer_update
BEFORE UPDATE OF company, company_url, phase ON jobs
WHEN NEW.company IS NOT OLD.company OR NEW.company_url IS NOT OLD.company_url OR NEW.phase IS NOT OLD.phase
BEGIN
  SELECT CASE WHEN NEW.eligible_opening IS NULL
    THEN RAISE(ABORT, 'Employer and phase changes require a verified eligible opening') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM criteria WHERE user_id IS NEW.user_id
      AND updated_at IS json_extract(NEW.eligible_opening, '$.criteria_updated_at')
  ) THEN RAISE(ABORT, 'Opening eligibility must use current saved criteria') END;
  SELECT CASE WHEN coalesce(julianday(json_extract(NEW.eligible_opening, '$.checked_at')) BETWEEN julianday('now') - 1 AND julianday('now'), 0) IS 0
    THEN RAISE(ABORT, 'Opening verification must be within the last 24 hours') END;
END;
