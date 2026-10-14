-- Preserve child records and their ordering before rebuilding jobs: dropping
-- jobs runs ON DELETE CASCADE even when foreign-key checks are deferred.
CREATE TABLE criteria_migration_stages AS SELECT rowid AS original_rowid, * FROM stages;
CREATE TABLE criteria_migration_feedback AS SELECT rowid AS original_rowid, * FROM feedback;

CREATE TABLE jobs_current (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL CHECK (length(trim(company)) > 0),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  nickname TEXT COLLATE NOCASE,
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  source_url TEXT,
  location TEXT,
  recruiter_name TEXT,
  recruiter_email TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'rejected', 'withdrawn', 'offer', 'accepted')),
  current_stage TEXT NOT NULL DEFAULT 'lead',
  qualification TEXT NOT NULL DEFAULT 'pending'
    CHECK (qualification IN ('pending', 'qualified', 'excluded')),
  score INTEGER CHECK (score BETWEEN 0 AND 100),
  qualification_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, id),
  CHECK (
    (qualification IS 'pending' AND score IS NULL AND qualification_reason IS NULL)
    OR (qualification IS NOT 'pending' AND score IS NOT NULL AND qualification_reason IS NOT NULL)
  )
) STRICT;

INSERT INTO jobs_current (
  rowid, user_id, id, company, title, nickname, description, source_url, location,
  recruiter_name, recruiter_email, notes, status, current_stage, qualification,
  score, qualification_reason, created_at, updated_at
)
SELECT rowid, user_id, id, company, title, nickname, description, source_url, location,
  recruiter_name, recruiter_email, notes, status, current_stage, qualification,
  score, qualification_reason, created_at, updated_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_current RENAME TO jobs;

INSERT INTO stages (
  rowid, user_id, id, job_id, name, status, starts_at, ends_at, timezone, location,
  contact_name, contact_email, notes, calendar_event_id, calendar_id, created_at, updated_at
)
SELECT * FROM criteria_migration_stages;

INSERT INTO feedback (rowid, user_id, id, stage_id, text, source, created_at, updated_at)
SELECT * FROM criteria_migration_feedback;

DROP TABLE criteria_migration_stages;
DROP TABLE criteria_migration_feedback;

CREATE UNIQUE INDEX jobs_nickname ON jobs(user_id, nickname COLLATE NOCASE);
CREATE UNIQUE INDEX jobs_source_url ON jobs(user_id, source_url);
CREATE INDEX jobs_pipeline ON jobs(user_id, status, qualification, score DESC);

CREATE TABLE criteria_current (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO criteria_current (user_id, text, updated_at)
SELECT user_id, text, updated_at FROM criteria;

DROP TABLE criteria;
ALTER TABLE criteria_current RENAME TO criteria;
