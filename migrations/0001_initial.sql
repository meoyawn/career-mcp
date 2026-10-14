CREATE TABLE criteria (
  id INTEGER PRIMARY KEY CHECK (id IS 1),
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL CHECK (length(trim(company)) > 0),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  nickname TEXT COLLATE NOCASE UNIQUE,
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  source_url TEXT UNIQUE,
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
  criteria_revision INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (qualification IS 'pending' AND score IS NULL AND qualification_reason IS NULL AND criteria_revision IS NULL)
    OR (qualification IS NOT 'pending' AND score IS NOT NULL AND qualification_reason IS NOT NULL AND criteria_revision IS NOT NULL)
  )
) STRICT;

CREATE INDEX jobs_pipeline ON jobs(status, qualification, score DESC);

CREATE TABLE stages (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'in_progress', 'passed', 'failed', 'completed', 'cancelled')),
  starts_at TEXT,
  ends_at TEXT,
  timezone TEXT,
  location TEXT,
  contact_name TEXT,
  contact_email TEXT,
  notes TEXT,
  calendar_event_id TEXT,
  calendar_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((starts_at IS NULL AND ends_at IS NULL AND timezone IS NULL)
    OR (starts_at IS NOT NULL AND timezone IS NOT NULL)),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (calendar_event_id IS NULL OR calendar_id IS NOT NULL)
) STRICT;

CREATE INDEX stages_job ON stages(job_id, created_at);
CREATE INDEX stages_upcoming ON stages(status, starts_at);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  source TEXT NOT NULL DEFAULT 'self' CHECK (source IN ('self', 'recruiter', 'interviewer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX feedback_stage ON feedback(stage_id, created_at);
