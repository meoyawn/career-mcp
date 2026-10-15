ALTER TABLE jobs ADD COLUMN salary_declared_amount REAL
  CHECK (salary_declared_amount IS NULL OR
    (salary_declared_amount >= 0 AND salary_declared_amount <= 9007199254740991));
ALTER TABLE jobs ADD COLUMN salary_declared_currency TEXT;
ALTER TABLE jobs ADD COLUMN salary_declared_period TEXT;
ALTER TABLE jobs ADD COLUMN salary_declared_basis TEXT
  CONSTRAINT salary_declared_units CHECK (
    (salary_declared_amount IS NULL AND salary_declared_currency IS NULL AND salary_declared_period IS NULL AND salary_declared_basis IS NULL)
    OR (salary_declared_amount IS NOT NULL
      AND salary_declared_currency IS NOT NULL AND length(salary_declared_currency) IS 3 AND salary_declared_currency NOT GLOB '*[^A-Z]*'
      AND salary_declared_period IS NOT NULL AND salary_declared_period IN ('hour', 'day', 'week', 'month', 'year')
      AND (salary_declared_basis IS NULL OR salary_declared_basis IN ('gross', 'net')))
  );

CREATE TABLE prep_notes (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('question', 'reminder', 'correction', 'context')),
  text TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 5000),
  stage_name TEXT CHECK (stage_name IS NULL OR stage_name IN (
    'applied', 'outreach', 'recruiter_screen', 'assessment', 'technical_interview',
    'system_design', 'hiring_manager', 'final_interview', 'reference_check', 'offer'
  )),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'cancelled')),
  resolution TEXT CHECK (resolution IS NULL OR length(trim(resolution)) BETWEEN 1 AND 5000),
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id, job_id) REFERENCES jobs(user_id, id) ON DELETE CASCADE,
  CHECK ((status IS 'pending' AND closed_at IS NULL AND resolution IS NULL)
    OR (status IN ('resolved', 'cancelled') AND closed_at IS NOT NULL))
) STRICT;

CREATE INDEX prep_notes_job ON prep_notes(user_id, job_id, status, created_at);
