-- Lead records retain employer information; opening details belong to applications.
-- Preserve histories and ordering while rebuilding their parent table.
CREATE TABLE employer_migration_stages AS SELECT rowid AS original_rowid, * FROM stages;
CREATE TABLE employer_migration_feedback AS SELECT rowid AS original_rowid, * FROM feedback;

CREATE TABLE jobs_employer (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL CHECK (length(trim(company)) > 0),
  company_url TEXT,
  phase TEXT NOT NULL DEFAULT 'lead' CHECK (phase IN ('lead', 'application')),
  title TEXT CHECK (title IS NULL OR length(trim(title)) > 0),
  nickname TEXT COLLATE NOCASE,
  description TEXT CHECK (description IS NULL OR length(trim(description)) > 0),
  source_url TEXT,
  location TEXT,
  recruiter_name TEXT,
  recruiter_email TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'rejected', 'withdrawn', 'offer', 'accepted')),
  current_stage TEXT NOT NULL DEFAULT 'lead',
  score INTEGER CHECK (score BETWEEN 0 AND 100),
  salary_min REAL CHECK (salary_min IS NULL OR salary_min >= 0),
  salary_max REAL CHECK (salary_max IS NULL OR salary_max >= 0),
  salary_currency TEXT,
  salary_period TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, id),
  CONSTRAINT opening_requires_application CHECK (
    phase IS 'application' OR (title IS NULL AND description IS NULL AND source_url IS NULL AND location IS NULL)
  ),
  CONSTRAINT salary_range CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max),
  CONSTRAINT salary_units CHECK (
    (salary_min IS NULL AND salary_max IS NULL AND salary_currency IS NULL AND salary_period IS NULL)
    OR ((salary_min IS NOT NULL OR salary_max IS NOT NULL)
      AND salary_currency IS NOT NULL AND length(salary_currency) IS 3 AND salary_currency NOT GLOB '*[^A-Z]*'
      AND salary_period IS NOT NULL AND salary_period IN ('hour', 'day', 'week', 'month', 'year'))
  )
) STRICT;

WITH classified AS (
  SELECT j.*, CASE WHEN current_stage IS NOT 'lead' OR EXISTS (
    SELECT 1 FROM stages s WHERE s.user_id IS j.user_id AND s.job_id IS j.id
  ) THEN 'application' ELSE 'lead' END AS phase
  FROM jobs j
)
INSERT INTO jobs_employer (
  user_id, id, company, phase, title, nickname, description, source_url, location,
  recruiter_name, recruiter_email, notes, status, current_stage, score, created_at, updated_at
)
SELECT user_id, id, company, phase,
  CASE WHEN phase IS 'application' THEN title END,
  nickname,
  CASE WHEN phase IS 'application' THEN description END,
  CASE WHEN phase IS 'application' THEN source_url END,
  CASE WHEN phase IS 'application' THEN location END,
  recruiter_name, recruiter_email,
  CASE WHEN phase IS 'lead' THEN nullif(replace(replace(replace(notes,
    coalesce(description, ''), ''), coalesce(title, ''), ''), coalesce(source_url, ''), ''), '') ELSE notes END,
  status, current_stage, score, created_at, updated_at
FROM classified;

DROP TABLE jobs;
ALTER TABLE jobs_employer RENAME TO jobs;

INSERT INTO stages (
  rowid, user_id, id, job_id, name, status, starts_at, ends_at, timezone, location,
  contact_name, contact_email, notes, calendar_event_id, calendar_id, created_at, updated_at
)
SELECT * FROM employer_migration_stages;
INSERT INTO feedback (rowid, user_id, id, stage_id, text, source, created_at, updated_at)
SELECT * FROM employer_migration_feedback;

DROP TABLE employer_migration_stages;
DROP TABLE employer_migration_feedback;

CREATE UNIQUE INDEX jobs_nickname ON jobs(user_id, nickname COLLATE NOCASE);
CREATE UNIQUE INDEX jobs_source_url ON jobs(user_id, source_url);
CREATE INDEX jobs_pipeline ON jobs(user_id, status, score DESC);
