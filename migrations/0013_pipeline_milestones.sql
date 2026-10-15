-- Preserve existing histories; enforce predefined milestones on all new writes.
CREATE TRIGGER jobs_pipeline_stage_insert
BEFORE INSERT ON jobs
WHEN NEW.current_stage NOT IN (
  'lead', 'applied', 'outreach', 'recruiter_screen', 'assessment', 'technical_interview',
  'system_design', 'hiring_manager', 'final_interview', 'reference_check', 'offer'
)
BEGIN
  SELECT RAISE(ABORT, 'Choose a predefined pipeline milestone. Drafts and prepared forms are not pipeline stages.');
END;

CREATE TRIGGER jobs_pipeline_stage_update
BEFORE UPDATE OF current_stage ON jobs
WHEN NEW.current_stage NOT IN (
  'lead', 'applied', 'outreach', 'recruiter_screen', 'assessment', 'technical_interview',
  'system_design', 'hiring_manager', 'final_interview', 'reference_check', 'offer'
)
BEGIN
  SELECT RAISE(ABORT, 'Choose a predefined pipeline milestone. Drafts and prepared forms are not pipeline stages.');
END;

CREATE TRIGGER stages_pipeline_name_insert
BEFORE INSERT ON stages
WHEN NEW.name NOT IN (
  'applied', 'outreach', 'recruiter_screen', 'assessment', 'technical_interview',
  'system_design', 'hiring_manager', 'final_interview', 'reference_check', 'offer'
)
BEGIN
  SELECT RAISE(ABORT, 'Choose a predefined pipeline milestone. Drafts and prepared forms are not pipeline stages.');
END;

CREATE TRIGGER stages_pipeline_name_update
BEFORE UPDATE OF name ON stages
WHEN NEW.name NOT IN (
  'applied', 'outreach', 'recruiter_screen', 'assessment', 'technical_interview',
  'system_design', 'hiring_manager', 'final_interview', 'reference_check', 'offer'
)
BEGIN
  SELECT RAISE(ABORT, 'Choose a predefined pipeline milestone. Drafts and prepared forms are not pipeline stages.');
END;
