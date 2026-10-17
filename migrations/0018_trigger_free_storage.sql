-- Rebuild the CRM without triggers. Historical row IDs and values remain unchanged.

-- D1 runs each migration atomically; copy children before replacing their parents.

CREATE TABLE rebuild_jobs AS SELECT rowid AS preserved_rowid, * FROM jobs;

CREATE TABLE rebuild_stages AS SELECT rowid AS preserved_rowid, * FROM stages;

CREATE TABLE rebuild_feedback AS SELECT rowid AS preserved_rowid, * FROM feedback;

CREATE TABLE rebuild_contacts AS SELECT rowid AS preserved_rowid, * FROM contacts;

CREATE TABLE rebuild_outreach AS SELECT rowid AS preserved_rowid, * FROM outreach;

CREATE TABLE rebuild_prep_notes AS SELECT rowid AS preserved_rowid, * FROM prep_notes;

DROP VIEW contact_activity;

DROP TABLE outreach;

DROP TABLE feedback;

DROP TABLE prep_notes;

DROP TABLE contacts;

DROP TABLE stages;

DROP TABLE jobs;

CREATE TABLE jobs (
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
  recruiter_engaged_at TEXT
  CHECK (recruiter_engaged_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', recruiter_engaged_at) IS recruiter_engaged_at),
  reapply_policy TEXT
  CHECK (reapply_policy IS NULL OR reapply_policy IN ('allowed', 'not_allowed')),
  reapply_after TEXT
  CONSTRAINT reapply_deadline CHECK (reapply_after IS NULL OR (
    reapply_policy IS 'allowed'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', reapply_after) IS reapply_after
  )),
  salary_ask_amount REAL
  CHECK (salary_ask_amount IS NULL OR
    (salary_ask_amount >= 0 AND salary_ask_amount <= 9007199254740991)),
  salary_ask_currency TEXT,
  salary_ask_period TEXT,
  salary_ask_basis TEXT
  CONSTRAINT salary_ask_units CHECK (
    (salary_ask_amount IS NULL AND salary_ask_currency IS NULL AND salary_ask_period IS NULL AND salary_ask_basis IS NULL)
    OR (salary_ask_amount IS NOT NULL
      AND salary_ask_currency IS NOT NULL AND length(salary_ask_currency) IS 3 AND salary_ask_currency NOT GLOB '*[^A-Z]*'
      AND salary_ask_period IS NOT NULL AND salary_ask_period IN ('hour', 'day', 'week', 'month', 'year')
      AND (salary_ask_basis IS NULL OR salary_ask_basis IN ('gross', 'net')))
  ),
  eligible_opening TEXT CHECK (
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
),
  salary_declared_amount REAL
  CHECK (salary_declared_amount IS NULL OR
    (salary_declared_amount >= 0 AND salary_declared_amount <= 9007199254740991)),
  salary_declared_currency TEXT,
  salary_declared_period TEXT,
  salary_declared_basis TEXT
  CONSTRAINT salary_declared_units CHECK (
    (salary_declared_amount IS NULL AND salary_declared_currency IS NULL AND salary_declared_period IS NULL AND salary_declared_basis IS NULL)
    OR (salary_declared_amount IS NOT NULL
      AND salary_declared_currency IS NOT NULL AND length(salary_declared_currency) IS 3 AND salary_declared_currency NOT GLOB '*[^A-Z]*'
      AND salary_declared_period IS NOT NULL AND salary_declared_period IN ('hour', 'day', 'week', 'month', 'year')
      AND (salary_declared_basis IS NULL OR salary_declared_basis IN ('gross', 'net')))
  ),
  employer_salary TEXT
  CHECK (employer_salary IS NULL OR (json_valid(employer_salary) AND json_type(employer_salary) IS 'object')),
  asked_salary TEXT
  CHECK (asked_salary IS NULL OR (json_valid(asked_salary) AND json_type(asked_salary) IS 'object')),
  legacy_current_stage TEXT,
  legacy_eligible_opening INTEGER NOT NULL DEFAULT 0 CHECK (legacy_eligible_opening IN (0, 1)),
  UNIQUE (user_id, id, phase),
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
  ),
  CONSTRAINT opening_required CHECK (eligible_opening IS NOT NULL OR legacy_eligible_opening IS 1),
  CONSTRAINT leads_stay_active CHECK (phase IS NOT 'lead' OR status IS 'active'),
  CONSTRAINT lead_application_state CHECK (phase IS NOT 'lead' OR (
    current_stage IS 'lead' AND recruiter_engaged_at IS NULL AND reapply_policy IS NULL AND reapply_after IS NULL
  )),
  CONSTRAINT application_milestone CHECK (phase IS NOT 'application' OR current_stage IS NOT 'lead'),
  CONSTRAINT pipeline_milestone CHECK (current_stage IN ('lead', 'applied', 'outreach', 'recruiter_screen', 'assessment', 'technical_interview', 'system_design', 'hiring_manager', 'final_interview', 'reference_check', 'offer') OR current_stage IS legacy_current_stage)
) STRICT;

CREATE TABLE stages (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
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
  legacy_name TEXT,
  job_phase TEXT GENERATED ALWAYS AS ('application') STORED,
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, job_id, job_phase) REFERENCES jobs(user_id, id, phase) ON DELETE CASCADE,
  CONSTRAINT stage_schedule CHECK ((starts_at IS NULL AND ends_at IS NULL AND timezone IS NULL)
    OR (starts_at IS NOT NULL AND timezone IS NOT NULL)),
  CONSTRAINT stage_end CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT stage_calendar CHECK (calendar_event_id IS NULL OR calendar_id IS NOT NULL),
  CONSTRAINT pipeline_milestone CHECK (name IN ('applied', 'outreach', 'recruiter_screen', 'assessment', 'technical_interview', 'system_design', 'hiring_manager', 'final_interview', 'reference_check', 'offer') OR name IS legacy_name)
) STRICT;

CREATE TABLE feedback (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  source TEXT NOT NULL DEFAULT 'self' CHECK (source IN ('self', 'recruiter', 'interviewer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, stage_id) REFERENCES stages(user_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE contacts (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  relationship TEXT NOT NULL DEFAULT 'other' CHECK (length(trim(relationship)) > 0),
  url TEXT,
  email TEXT COLLATE NOCASE,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, id),
  UNIQUE (user_id, job_id, id),
  FOREIGN KEY (user_id, job_id) REFERENCES jobs(user_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE outreach (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  stage_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  occurred_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS occurred_at),
  time_basis TEXT NOT NULL CHECK (time_basis IN ('reported', 'recorded')),
  channel TEXT,
  notes TEXT,
  follow_up_at TEXT CHECK (follow_up_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', follow_up_at) IS follow_up_at),
  follow_up_status TEXT CHECK (follow_up_status IN ('pending', 'done', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  job_phase TEXT GENERATED ALWAYS AS ('application') STORED,
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, job_id, job_phase) REFERENCES jobs(user_id, id, phase) ON DELETE CASCADE,
  FOREIGN KEY (user_id, job_id, contact_id) REFERENCES contacts(user_id, job_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, job_id, stage_id) REFERENCES stages(user_id, job_id, id),
  CHECK (direction IS NOT 'outbound' OR follow_up_status IS NOT NULL),
  CHECK (follow_up_at IS NULL OR follow_up_status IS NOT NULL),
  CONSTRAINT outreach_follow_up CHECK (follow_up_at IS NULL OR follow_up_at >= occurred_at)
) STRICT;

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

CREATE UNIQUE INDEX contacts_email ON contacts(user_id, job_id, email COLLATE NOCASE) WHERE email IS NOT NULL;

CREATE INDEX contacts_job ON contacts(user_id, job_id);

CREATE UNIQUE INDEX contacts_url ON contacts(user_id, job_id, url) WHERE url IS NOT NULL;

CREATE INDEX feedback_stage ON feedback(user_id, stage_id, created_at);

CREATE UNIQUE INDEX jobs_eligible_opening_url ON jobs(user_id, json_extract(eligible_opening, '$.source_url'))
WHERE phase IS 'lead' AND eligible_opening IS NOT NULL;

CREATE UNIQUE INDEX jobs_nickname ON jobs(user_id, nickname COLLATE NOCASE);

CREATE INDEX jobs_pipeline ON jobs(user_id, status, score DESC);

CREATE INDEX jobs_reapplication ON jobs(user_id, status, reapply_policy, reapply_after);

CREATE UNIQUE INDEX jobs_source_url ON jobs(user_id, source_url);

CREATE INDEX outreach_contact_time ON outreach(user_id, contact_id, occurred_at DESC, created_at DESC);

CREATE INDEX outreach_job_time ON outreach(user_id, job_id, direction, occurred_at DESC);

CREATE INDEX prep_notes_job ON prep_notes(user_id, job_id, status, created_at);

CREATE INDEX stages_job ON stages(user_id, job_id, created_at);

CREATE UNIQUE INDEX stages_job_identity ON stages(user_id, job_id, id);

CREATE INDEX stages_upcoming ON stages(user_id, status, starts_at);

INSERT INTO jobs (rowid, user_id, id, company, company_url, phase, title, nickname, description, source_url, location, recruiter_name, recruiter_email, notes, status, current_stage, score, salary_min, salary_max, salary_currency, salary_period, created_at, updated_at, recruiter_engaged_at, reapply_policy, reapply_after, salary_ask_amount, salary_ask_currency, salary_ask_period, salary_ask_basis, eligible_opening, salary_declared_amount, salary_declared_currency, salary_declared_period, salary_declared_basis, employer_salary, asked_salary, legacy_current_stage, legacy_eligible_opening)
SELECT preserved_rowid, user_id, id, company, company_url, phase, title, nickname, description, source_url, location, recruiter_name, recruiter_email, notes, status, current_stage, score, salary_min, salary_max, salary_currency, salary_period, created_at, updated_at, recruiter_engaged_at, reapply_policy, reapply_after, salary_ask_amount, salary_ask_currency, salary_ask_period, salary_ask_basis, eligible_opening, salary_declared_amount, salary_declared_currency, salary_declared_period, salary_declared_basis, employer_salary, asked_salary, CASE WHEN current_stage NOT IN ('lead', 'applied', 'outreach', 'recruiter_screen', 'assessment', 'technical_interview', 'system_design', 'hiring_manager', 'final_interview', 'reference_check', 'offer') THEN current_stage END, eligible_opening IS NULL FROM rebuild_jobs;

INSERT INTO stages (rowid, user_id, id, job_id, name, status, starts_at, ends_at, timezone, location, contact_name, contact_email, notes, calendar_event_id, calendar_id, created_at, updated_at, legacy_name)
SELECT preserved_rowid, user_id, id, job_id, name, status, starts_at, ends_at, timezone, location, contact_name, contact_email, notes, calendar_event_id, calendar_id, created_at, updated_at, CASE WHEN name NOT IN ('applied', 'outreach', 'recruiter_screen', 'assessment', 'technical_interview', 'system_design', 'hiring_manager', 'final_interview', 'reference_check', 'offer') THEN name END FROM rebuild_stages;

INSERT INTO feedback (rowid, user_id, id, stage_id, text, source, created_at, updated_at)
SELECT preserved_rowid, user_id, id, stage_id, text, source, created_at, updated_at FROM rebuild_feedback;

INSERT INTO contacts (rowid, user_id, id, job_id, name, relationship, url, email, notes, created_at, updated_at)
SELECT preserved_rowid, user_id, id, job_id, name, relationship, url, email, notes, created_at, updated_at FROM rebuild_contacts;

INSERT INTO outreach (rowid, user_id, id, job_id, contact_id, stage_id, direction, occurred_at, time_basis, channel, notes, follow_up_at, follow_up_status, created_at, updated_at)
SELECT preserved_rowid, user_id, id, job_id, contact_id, stage_id, direction, occurred_at, time_basis, channel, notes, follow_up_at, follow_up_status, created_at, updated_at FROM rebuild_outreach;

INSERT INTO prep_notes (rowid, user_id, id, job_id, kind, text, stage_name, status, resolution, closed_at, created_at, updated_at)
SELECT preserved_rowid, user_id, id, job_id, kind, text, stage_name, status, resolution, closed_at, created_at, updated_at FROM rebuild_prep_notes;

-- Abort the migration if any original value or row ID changed during the rebuild.

CREATE TABLE rebuild_check (mismatch INTEGER NOT NULL CONSTRAINT migration_data_preserved CHECK (mismatch IS 0)) STRICT;

INSERT INTO rebuild_check (mismatch) SELECT
  EXISTS (SELECT preserved_rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, company COLLATE BINARY, company_url COLLATE BINARY, phase COLLATE BINARY, title COLLATE BINARY, nickname COLLATE BINARY, description COLLATE BINARY, source_url COLLATE BINARY, location COLLATE BINARY, recruiter_name COLLATE BINARY, recruiter_email COLLATE BINARY, notes COLLATE BINARY, status COLLATE BINARY, current_stage COLLATE BINARY, score COLLATE BINARY, salary_min COLLATE BINARY, salary_max COLLATE BINARY, salary_currency COLLATE BINARY, salary_period COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY, recruiter_engaged_at COLLATE BINARY, reapply_policy COLLATE BINARY, reapply_after COLLATE BINARY, salary_ask_amount COLLATE BINARY, salary_ask_currency COLLATE BINARY, salary_ask_period COLLATE BINARY, salary_ask_basis COLLATE BINARY, eligible_opening COLLATE BINARY, salary_declared_amount COLLATE BINARY, salary_declared_currency COLLATE BINARY, salary_declared_period COLLATE BINARY, salary_declared_basis COLLATE BINARY, employer_salary COLLATE BINARY, asked_salary COLLATE BINARY FROM rebuild_jobs
    EXCEPT SELECT rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, company COLLATE BINARY, company_url COLLATE BINARY, phase COLLATE BINARY, title COLLATE BINARY, nickname COLLATE BINARY, description COLLATE BINARY, source_url COLLATE BINARY, location COLLATE BINARY, recruiter_name COLLATE BINARY, recruiter_email COLLATE BINARY, notes COLLATE BINARY, status COLLATE BINARY, current_stage COLLATE BINARY, score COLLATE BINARY, salary_min COLLATE BINARY, salary_max COLLATE BINARY, salary_currency COLLATE BINARY, salary_period COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY, recruiter_engaged_at COLLATE BINARY, reapply_policy COLLATE BINARY, reapply_after COLLATE BINARY, salary_ask_amount COLLATE BINARY, salary_ask_currency COLLATE BINARY, salary_ask_period COLLATE BINARY, salary_ask_basis COLLATE BINARY, eligible_opening COLLATE BINARY, salary_declared_amount COLLATE BINARY, salary_declared_currency COLLATE BINARY, salary_declared_period COLLATE BINARY, salary_declared_basis COLLATE BINARY, employer_salary COLLATE BINARY, asked_salary COLLATE BINARY FROM jobs)
  OR EXISTS (SELECT rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, company COLLATE BINARY, company_url COLLATE BINARY, phase COLLATE BINARY, title COLLATE BINARY, nickname COLLATE BINARY, description COLLATE BINARY, source_url COLLATE BINARY, location COLLATE BINARY, recruiter_name COLLATE BINARY, recruiter_email COLLATE BINARY, notes COLLATE BINARY, status COLLATE BINARY, current_stage COLLATE BINARY, score COLLATE BINARY, salary_min COLLATE BINARY, salary_max COLLATE BINARY, salary_currency COLLATE BINARY, salary_period COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY, recruiter_engaged_at COLLATE BINARY, reapply_policy COLLATE BINARY, reapply_after COLLATE BINARY, salary_ask_amount COLLATE BINARY, salary_ask_currency COLLATE BINARY, salary_ask_period COLLATE BINARY, salary_ask_basis COLLATE BINARY, eligible_opening COLLATE BINARY, salary_declared_amount COLLATE BINARY, salary_declared_currency COLLATE BINARY, salary_declared_period COLLATE BINARY, salary_declared_basis COLLATE BINARY, employer_salary COLLATE BINARY, asked_salary COLLATE BINARY FROM jobs
    EXCEPT SELECT preserved_rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, company COLLATE BINARY, company_url COLLATE BINARY, phase COLLATE BINARY, title COLLATE BINARY, nickname COLLATE BINARY, description COLLATE BINARY, source_url COLLATE BINARY, location COLLATE BINARY, recruiter_name COLLATE BINARY, recruiter_email COLLATE BINARY, notes COLLATE BINARY, status COLLATE BINARY, current_stage COLLATE BINARY, score COLLATE BINARY, salary_min COLLATE BINARY, salary_max COLLATE BINARY, salary_currency COLLATE BINARY, salary_period COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY, recruiter_engaged_at COLLATE BINARY, reapply_policy COLLATE BINARY, reapply_after COLLATE BINARY, salary_ask_amount COLLATE BINARY, salary_ask_currency COLLATE BINARY, salary_ask_period COLLATE BINARY, salary_ask_basis COLLATE BINARY, eligible_opening COLLATE BINARY, salary_declared_amount COLLATE BINARY, salary_declared_currency COLLATE BINARY, salary_declared_period COLLATE BINARY, salary_declared_basis COLLATE BINARY, employer_salary COLLATE BINARY, asked_salary COLLATE BINARY FROM rebuild_jobs);

INSERT INTO rebuild_check (mismatch) SELECT
  EXISTS (SELECT preserved_rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, job_id COLLATE BINARY, name COLLATE BINARY, status COLLATE BINARY, starts_at COLLATE BINARY, ends_at COLLATE BINARY, timezone COLLATE BINARY, location COLLATE BINARY, contact_name COLLATE BINARY, contact_email COLLATE BINARY, notes COLLATE BINARY, calendar_event_id COLLATE BINARY, calendar_id COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM rebuild_stages
    EXCEPT SELECT rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, job_id COLLATE BINARY, name COLLATE BINARY, status COLLATE BINARY, starts_at COLLATE BINARY, ends_at COLLATE BINARY, timezone COLLATE BINARY, location COLLATE BINARY, contact_name COLLATE BINARY, contact_email COLLATE BINARY, notes COLLATE BINARY, calendar_event_id COLLATE BINARY, calendar_id COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM stages)
  OR EXISTS (SELECT rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, job_id COLLATE BINARY, name COLLATE BINARY, status COLLATE BINARY, starts_at COLLATE BINARY, ends_at COLLATE BINARY, timezone COLLATE BINARY, location COLLATE BINARY, contact_name COLLATE BINARY, contact_email COLLATE BINARY, notes COLLATE BINARY, calendar_event_id COLLATE BINARY, calendar_id COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM stages
    EXCEPT SELECT preserved_rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, job_id COLLATE BINARY, name COLLATE BINARY, status COLLATE BINARY, starts_at COLLATE BINARY, ends_at COLLATE BINARY, timezone COLLATE BINARY, location COLLATE BINARY, contact_name COLLATE BINARY, contact_email COLLATE BINARY, notes COLLATE BINARY, calendar_event_id COLLATE BINARY, calendar_id COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM rebuild_stages);

INSERT INTO rebuild_check (mismatch) SELECT
  EXISTS (SELECT preserved_rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, stage_id COLLATE BINARY, text COLLATE BINARY, source COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM rebuild_feedback
    EXCEPT SELECT rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, stage_id COLLATE BINARY, text COLLATE BINARY, source COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM feedback)
  OR EXISTS (SELECT rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, stage_id COLLATE BINARY, text COLLATE BINARY, source COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM feedback
    EXCEPT SELECT preserved_rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, stage_id COLLATE BINARY, text COLLATE BINARY, source COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM rebuild_feedback);

INSERT INTO rebuild_check (mismatch) SELECT
  EXISTS (SELECT preserved_rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, job_id COLLATE BINARY, name COLLATE BINARY, relationship COLLATE BINARY, url COLLATE BINARY, email COLLATE BINARY, notes COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM rebuild_contacts
    EXCEPT SELECT rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, job_id COLLATE BINARY, name COLLATE BINARY, relationship COLLATE BINARY, url COLLATE BINARY, email COLLATE BINARY, notes COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM contacts)
  OR EXISTS (SELECT rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, job_id COLLATE BINARY, name COLLATE BINARY, relationship COLLATE BINARY, url COLLATE BINARY, email COLLATE BINARY, notes COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM contacts
    EXCEPT SELECT preserved_rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, job_id COLLATE BINARY, name COLLATE BINARY, relationship COLLATE BINARY, url COLLATE BINARY, email COLLATE BINARY, notes COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM rebuild_contacts);

INSERT INTO rebuild_check (mismatch) SELECT
  EXISTS (SELECT preserved_rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, job_id COLLATE BINARY, contact_id COLLATE BINARY, stage_id COLLATE BINARY, direction COLLATE BINARY, occurred_at COLLATE BINARY, time_basis COLLATE BINARY, channel COLLATE BINARY, notes COLLATE BINARY, follow_up_at COLLATE BINARY, follow_up_status COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM rebuild_outreach
    EXCEPT SELECT rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, job_id COLLATE BINARY, contact_id COLLATE BINARY, stage_id COLLATE BINARY, direction COLLATE BINARY, occurred_at COLLATE BINARY, time_basis COLLATE BINARY, channel COLLATE BINARY, notes COLLATE BINARY, follow_up_at COLLATE BINARY, follow_up_status COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM outreach)
  OR EXISTS (SELECT rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, job_id COLLATE BINARY, contact_id COLLATE BINARY, stage_id COLLATE BINARY, direction COLLATE BINARY, occurred_at COLLATE BINARY, time_basis COLLATE BINARY, channel COLLATE BINARY, notes COLLATE BINARY, follow_up_at COLLATE BINARY, follow_up_status COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM outreach
    EXCEPT SELECT preserved_rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, job_id COLLATE BINARY, contact_id COLLATE BINARY, stage_id COLLATE BINARY, direction COLLATE BINARY, occurred_at COLLATE BINARY, time_basis COLLATE BINARY, channel COLLATE BINARY, notes COLLATE BINARY, follow_up_at COLLATE BINARY, follow_up_status COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM rebuild_outreach);

INSERT INTO rebuild_check (mismatch) SELECT
  EXISTS (SELECT preserved_rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, job_id COLLATE BINARY, kind COLLATE BINARY, text COLLATE BINARY, stage_name COLLATE BINARY, status COLLATE BINARY, resolution COLLATE BINARY, closed_at COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM rebuild_prep_notes
    EXCEPT SELECT rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, job_id COLLATE BINARY, kind COLLATE BINARY, text COLLATE BINARY, stage_name COLLATE BINARY, status COLLATE BINARY, resolution COLLATE BINARY, closed_at COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM prep_notes)
  OR EXISTS (SELECT rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, job_id COLLATE BINARY, kind COLLATE BINARY, text COLLATE BINARY, stage_name COLLATE BINARY, status COLLATE BINARY, resolution COLLATE BINARY, closed_at COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM prep_notes
    EXCEPT SELECT preserved_rowid COLLATE BINARY, user_id COLLATE BINARY, id COLLATE BINARY, job_id COLLATE BINARY, kind COLLATE BINARY, text COLLATE BINARY, stage_name COLLATE BINARY, status COLLATE BINARY, resolution COLLATE BINARY, closed_at COLLATE BINARY, created_at COLLATE BINARY, updated_at COLLATE BINARY FROM rebuild_prep_notes);

DROP TABLE rebuild_check;

DROP TABLE rebuild_jobs;

DROP TABLE rebuild_stages;

DROP TABLE rebuild_feedback;

DROP TABLE rebuild_contacts;

DROP TABLE rebuild_outreach;

DROP TABLE rebuild_prep_notes;

CREATE VIEW contact_activity AS
SELECT c.*, latest.id AS last_interaction_id, latest.direction AS last_interaction_direction,
  latest.occurred_at AS last_interaction_at, latest.time_basis AS last_interaction_time_basis,
  latest.created_at AS last_interaction_recorded_at, latest.stage_id AS last_interaction_stage_id,
  (SELECT MIN(o.occurred_at) FROM outreach o WHERE o.user_id IS c.user_id AND o.contact_id IS c.id AND o.direction IS 'outbound') AS first_outreach_at,
  (SELECT MAX(o.occurred_at) FROM outreach o WHERE o.user_id IS c.user_id AND o.contact_id IS c.id AND o.direction IS 'outbound') AS last_outreach_at,
  (SELECT MAX(o.occurred_at) FROM outreach o WHERE o.user_id IS c.user_id AND o.contact_id IS c.id AND o.direction IS 'inbound') AS last_response_at,
  CASE WHEN latest.direction IS 'outbound' AND latest.follow_up_status IS 'pending' THEN 1 ELSE 0 END AS awaiting_reply,
  CASE WHEN latest.follow_up_status IS 'pending' THEN 1 ELSE 0 END AS needs_follow_up,
  CASE WHEN latest.follow_up_status IS 'pending' THEN latest.follow_up_at END AS follow_up_at
FROM contacts c LEFT JOIN outreach latest ON latest.user_id IS c.user_id AND latest.id IS (
  SELECT o.id FROM outreach o WHERE o.user_id IS c.user_id AND o.contact_id IS c.id
  ORDER BY o.occurred_at DESC, o.created_at DESC, o.rowid DESC LIMIT 1
);

-- Failed command assertions abort the entire D1 batch. No rows can be stored here.

CREATE TABLE command_checks (
  error TEXT NOT NULL CHECK (error IN ('job_not_found', 'stage_not_found', 'contact_not_found', 'outreach_not_found', 'prep_note_not_found', 'criteria_required', 'opening_required', 'outdated_criteria', 'opening_expired', 'leads_stay_active', 'application_to_lead', 'lead_application_state', 'application_milestone', 'opening_requires_application', 'salary_range', 'salary_units', 'salary_ask_units', 'salary_declared_units', 'reapply_deadline', 'stage_schedule', 'stage_end', 'stage_calendar', 'legacy_milestone', 'contact_job', 'contact_communication', 'stage_job', 'outreach_follow_up', 'prep_resolution')),
  CONSTRAINT job_not_found CHECK (error IS NOT 'job_not_found'),
  CONSTRAINT stage_not_found CHECK (error IS NOT 'stage_not_found'),
  CONSTRAINT contact_not_found CHECK (error IS NOT 'contact_not_found'),
  CONSTRAINT outreach_not_found CHECK (error IS NOT 'outreach_not_found'),
  CONSTRAINT prep_note_not_found CHECK (error IS NOT 'prep_note_not_found'),
  CONSTRAINT criteria_required CHECK (error IS NOT 'criteria_required'),
  CONSTRAINT opening_required CHECK (error IS NOT 'opening_required'),
  CONSTRAINT outdated_criteria CHECK (error IS NOT 'outdated_criteria'),
  CONSTRAINT opening_expired CHECK (error IS NOT 'opening_expired'),
  CONSTRAINT leads_stay_active CHECK (error IS NOT 'leads_stay_active'),
  CONSTRAINT application_to_lead CHECK (error IS NOT 'application_to_lead'),
  CONSTRAINT lead_application_state CHECK (error IS NOT 'lead_application_state'),
  CONSTRAINT application_milestone CHECK (error IS NOT 'application_milestone'),
  CONSTRAINT opening_requires_application CHECK (error IS NOT 'opening_requires_application'),
  CONSTRAINT salary_range CHECK (error IS NOT 'salary_range'),
  CONSTRAINT salary_units CHECK (error IS NOT 'salary_units'),
  CONSTRAINT salary_ask_units CHECK (error IS NOT 'salary_ask_units'),
  CONSTRAINT salary_declared_units CHECK (error IS NOT 'salary_declared_units'),
  CONSTRAINT reapply_deadline CHECK (error IS NOT 'reapply_deadline'),
  CONSTRAINT stage_schedule CHECK (error IS NOT 'stage_schedule'),
  CONSTRAINT stage_end CHECK (error IS NOT 'stage_end'),
  CONSTRAINT stage_calendar CHECK (error IS NOT 'stage_calendar'),
  CONSTRAINT legacy_milestone CHECK (error IS NOT 'legacy_milestone'),
  CONSTRAINT contact_job CHECK (error IS NOT 'contact_job'),
  CONSTRAINT contact_communication CHECK (error IS NOT 'contact_communication'),
  CONSTRAINT stage_job CHECK (error IS NOT 'stage_job'),
  CONSTRAINT outreach_follow_up CHECK (error IS NOT 'outreach_follow_up'),
  CONSTRAINT prep_resolution CHECK (error IS NOT 'prep_resolution')
) STRICT;
