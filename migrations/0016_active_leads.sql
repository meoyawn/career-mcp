-- Preserve actual process history that was stored under the wrong phase.
DROP TRIGGER jobs_require_eligible_opening_employer_update;
UPDATE jobs SET phase = 'application'
WHERE phase IS 'lead' AND status IS NOT 'active' AND (
  status IN ('offer', 'accepted') OR current_stage IS NOT 'lead' OR recruiter_engaged_at IS NOT NULL
  OR EXISTS (SELECT 1 FROM stages s WHERE s.user_id IS jobs.user_id AND s.job_id IS jobs.id)
  OR EXISTS (SELECT 1 FROM outreach o WHERE o.user_id IS jobs.user_id AND o.job_id IS jobs.id)
);

-- Exclusions without application or communication history do not belong in the funnel.
DELETE FROM jobs WHERE phase IS 'lead' AND status IS NOT 'active';

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

CREATE TRIGGER jobs_active_leads_insert BEFORE INSERT ON jobs
WHEN NEW.phase IS 'lead' AND NEW.status IS NOT 'active'
BEGIN
  SELECT RAISE(ABORT, 'Leads must stay active; other statuses describe actual applications only');
END;

CREATE TRIGGER jobs_active_leads_update BEFORE UPDATE OF phase, status ON jobs
WHEN NEW.phase IS 'lead' AND NEW.status IS NOT 'active'
BEGIN
  SELECT RAISE(ABORT, 'Leads must stay active; other statuses describe actual applications only');
END;
