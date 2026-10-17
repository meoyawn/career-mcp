-- Actual process history belongs to applications, including active histories.
DROP TRIGGER jobs_require_eligible_opening_employer_update;
UPDATE jobs SET phase = 'application'
WHERE phase IS 'lead' AND (
  current_stage IS NOT 'lead' OR recruiter_engaged_at IS NOT NULL
  OR EXISTS (SELECT 1 FROM stages s WHERE s.user_id IS jobs.user_id AND s.job_id IS jobs.id)
  OR EXISTS (SELECT 1 FROM outreach o WHERE o.user_id IS jobs.user_id AND o.job_id IS jobs.id)
);

-- Recover the current milestone from recorded history without changing that history.
UPDATE jobs SET current_stage = coalesce(
  (SELECT s.name FROM stages s WHERE s.user_id IS jobs.user_id AND s.job_id IS jobs.id
    AND s.name IN ('applied', 'outreach', 'recruiter_screen', 'assessment', 'technical_interview',
      'system_design', 'hiring_manager', 'final_interview', 'reference_check', 'offer')
    ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1),
  CASE WHEN recruiter_engaged_at IS NOT NULL OR EXISTS (
    SELECT 1 FROM outreach o WHERE o.user_id IS jobs.user_id AND o.job_id IS jobs.id
  ) THEN 'outreach' ELSE 'applied' END
) WHERE phase IS 'application' AND current_stage IS 'lead';

-- An untouched lead has no previous application to reapply to.
UPDATE jobs SET reapply_policy = NULL, reapply_after = NULL WHERE phase IS 'lead';

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

CREATE TRIGGER jobs_lifecycle_insert BEFORE INSERT ON jobs
BEGIN
  SELECT CASE WHEN NEW.phase IS 'lead' AND (
    NEW.current_stage IS NOT 'lead' OR NEW.recruiter_engaged_at IS NOT NULL
    OR NEW.reapply_policy IS NOT NULL OR NEW.reapply_after IS NOT NULL
  ) THEN RAISE(ABORT, 'Lead state cannot contain application milestones, recruiter engagement or reapplication policy') END;
  SELECT CASE WHEN NEW.phase IS 'application' AND NEW.current_stage IS 'lead'
    THEN RAISE(ABORT, 'An application requires an application milestone') END;
END;

CREATE TRIGGER jobs_lifecycle_update BEFORE UPDATE ON jobs
BEGIN
  SELECT CASE WHEN OLD.phase IS 'application' AND NEW.phase IS 'lead'
    THEN RAISE(ABORT, 'An application cannot return to a lead; preserve application history') END;
  SELECT CASE WHEN NEW.phase IS 'lead' AND (
    NEW.current_stage IS NOT 'lead' OR NEW.recruiter_engaged_at IS NOT NULL
    OR NEW.reapply_policy IS NOT NULL OR NEW.reapply_after IS NOT NULL
  ) THEN RAISE(ABORT, 'Lead state cannot contain application milestones, recruiter engagement or reapplication policy') END;
  SELECT CASE WHEN NEW.phase IS 'application' AND NEW.current_stage IS 'lead'
    THEN RAISE(ABORT, 'An application requires an application milestone') END;
END;

CREATE TRIGGER stages_application_insert BEFORE INSERT ON stages
WHEN NOT EXISTS (SELECT 1 FROM jobs WHERE user_id IS NEW.user_id AND id IS NEW.job_id AND phase IS 'application')
BEGIN
  SELECT RAISE(ABORT, 'A pipeline stage requires an application');
END;

CREATE TRIGGER stages_application_update BEFORE UPDATE OF user_id, job_id ON stages
WHEN NOT EXISTS (SELECT 1 FROM jobs WHERE user_id IS NEW.user_id AND id IS NEW.job_id AND phase IS 'application')
BEGIN
  SELECT RAISE(ABORT, 'A pipeline stage requires an application');
END;

CREATE TRIGGER outreach_application_insert BEFORE INSERT ON outreach
WHEN NOT EXISTS (SELECT 1 FROM jobs WHERE user_id IS NEW.user_id AND id IS NEW.job_id AND phase IS 'application')
BEGIN
  SELECT RAISE(ABORT, 'Actual communication requires an application');
END;

CREATE TRIGGER outreach_application_update BEFORE UPDATE OF user_id, job_id ON outreach
WHEN NOT EXISTS (SELECT 1 FROM jobs WHERE user_id IS NEW.user_id AND id IS NEW.job_id AND phase IS 'application')
BEGIN
  SELECT RAISE(ABORT, 'Actual communication requires an application');
END;
