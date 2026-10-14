-- Existing leads carry forward; previously excluded openings leave the CRM.
-- Preserve histories while rebuilding jobs, which cascades to child records.
CREATE TABLE leads_migration_stages AS
SELECT s.rowid AS original_rowid, s.* FROM stages s
JOIN jobs j ON j.user_id IS s.user_id AND j.id IS s.job_id
WHERE j.qualification IS NOT 'excluded';
CREATE TABLE leads_migration_feedback AS
SELECT f.rowid AS original_rowid, f.* FROM feedback f
JOIN stages s ON s.user_id IS f.user_id AND s.id IS f.stage_id
JOIN jobs j ON j.user_id IS s.user_id AND j.id IS s.job_id
WHERE j.qualification IS NOT 'excluded';

CREATE TABLE jobs_qualified (
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
  score INTEGER CHECK (score BETWEEN 0 AND 100),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, id)
) STRICT;

INSERT INTO jobs_qualified (
  rowid, user_id, id, company, title, nickname, description, source_url, location,
  recruiter_name, recruiter_email, notes, status, current_stage, score, created_at, updated_at
)
SELECT rowid, user_id, id, company, title, nickname, description, source_url, location,
  recruiter_name, recruiter_email,
  CASE WHEN qualification_reason IS NULL THEN notes
    WHEN notes IS NULL OR length(notes) IS 0 THEN qualification_reason
    ELSE notes || char(10) || char(10) || qualification_reason END,
  status, current_stage, score, created_at, updated_at
FROM jobs WHERE qualification IS NOT 'excluded';

DROP TABLE jobs;
ALTER TABLE jobs_qualified RENAME TO jobs;

INSERT INTO stages (
  rowid, user_id, id, job_id, name, status, starts_at, ends_at, timezone, location,
  contact_name, contact_email, notes, calendar_event_id, calendar_id, created_at, updated_at
)
SELECT * FROM leads_migration_stages;

INSERT INTO feedback (rowid, user_id, id, stage_id, text, source, created_at, updated_at)
SELECT * FROM leads_migration_feedback;

DROP TABLE leads_migration_stages;
DROP TABLE leads_migration_feedback;

CREATE UNIQUE INDEX jobs_nickname ON jobs(user_id, nickname COLLATE NOCASE);
CREATE UNIQUE INDEX jobs_source_url ON jobs(user_id, source_url);
CREATE INDEX jobs_pipeline ON jobs(user_id, status, score DESC);
