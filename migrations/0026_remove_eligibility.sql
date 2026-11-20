-- Eligibility is decided before a lead is saved; the CRM stores the opening, not
-- an eligibility verdict, its reason or the criteria version it was checked against.
-- Opening facts become plain columns; no table keeps generated columns.
-- Every row keeps its rowid and values apart from the removed eligibility keys.

CREATE TABLE rebuild_jobs AS SELECT rowid AS preserved_rowid, user_id, id, company, company_url, phase, title, nickname, description, source_url, location, recruiter_name, recruiter_email, notes, status, current_stage, score, salary_min, salary_max, salary_currency, salary_period, created_at, updated_at, recruiter_engaged_at, reapply_policy, reapply_after, salary_ask_amount, salary_ask_currency, salary_ask_period, salary_ask_basis, json_remove(eligible_opening, '$.eligibility', '$.eligibility_reason', '$.criteria_updated_at'), salary_declared_amount, salary_declared_currency, salary_declared_period, salary_declared_basis, employer_salary, asked_salary, legacy_current_stage, legacy_eligible_opening, rejected_at, priority, outcome FROM jobs;
CREATE TABLE rebuild_stages AS SELECT rowid AS preserved_rowid, user_id, id, job_id, name, status, starts_at, ends_at, timezone, location, contact_name, contact_email, notes, calendar_event_id, calendar_id, created_at, updated_at, legacy_name FROM stages;
CREATE TABLE rebuild_feedback AS SELECT rowid AS preserved_rowid, * FROM feedback;
CREATE TABLE rebuild_contacts AS SELECT rowid AS preserved_rowid, * FROM contacts;
CREATE TABLE rebuild_outreach AS SELECT rowid AS preserved_rowid, user_id, id, job_id, contact_id, stage_id, direction, occurred_at, time_basis, channel, notes, follow_up_at, follow_up_status, created_at, updated_at FROM outreach;
CREATE TABLE rebuild_prep_notes AS SELECT rowid AS preserved_rowid, * FROM prep_notes;
CREATE TABLE rebuild_opening_closures AS SELECT rowid AS preserved_rowid, user_id, job_id, source_url, reason, checked_at,
  json_remove(eligible_opening, '$.eligibility', '$.eligibility_reason', '$.criteria_updated_at') AS opening, created_at FROM opening_closures;
CREATE TABLE rebuild_job_openings AS SELECT rowid AS preserved_rowid, id, user_id, job_id, json_extract(evidence, '$.title'), json_extract(evidence, '$.description'), source_url, json_extract(evidence, '$.location'), status, checked_at, employer_salary, salary_target, notes, created_at, updated_at FROM job_openings;

DELETE FROM outreach;
DELETE FROM feedback;
DELETE FROM prep_notes;
DELETE FROM contacts;
DELETE FROM stages;
DELETE FROM opening_closures;
DROP TABLE job_openings;
DROP TABLE outreach;
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
    CHECK (salary_ask_amount IS NULL OR (salary_ask_amount >= 0 AND salary_ask_amount <= 9007199254740991)),
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
  opening TEXT CHECK (opening IS NULL OR (
    json_valid(opening) AND json_type(opening) IS 'object'
    AND json_type(opening, '$.title') IS 'text' AND length(trim(json_extract(opening, '$.title'))) > 0
    AND json_type(opening, '$.description') IS 'text' AND length(trim(json_extract(opening, '$.description'))) > 0
    AND json_type(opening, '$.source_url') IS 'text'
    AND (json_extract(opening, '$.source_url') GLOB 'https://?*' OR json_extract(opening, '$.source_url') GLOB 'http://?*')
    AND json_type(opening, '$.location') IS 'text' AND length(trim(json_extract(opening, '$.location'))) > 0
    AND json_extract(opening, '$.status') IS 'open'
    AND json_type(opening, '$.checked_at') IS 'text' AND julianday(json_extract(opening, '$.checked_at')) IS NOT NULL
  )),
  salary_declared_amount REAL
    CHECK (salary_declared_amount IS NULL OR (salary_declared_amount >= 0 AND salary_declared_amount <= 9007199254740991)),
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
  employer_salary TEXT CHECK (employer_salary IS NULL OR (json_valid(employer_salary) AND json_type(employer_salary) IS 'object')),
  asked_salary TEXT CHECK (asked_salary IS NULL OR (json_valid(asked_salary) AND json_type(asked_salary) IS 'object')),
  legacy_current_stage TEXT,
  legacy_opening INTEGER NOT NULL DEFAULT 0 CHECK (legacy_opening IN (0, 1)),
  rejected_at TEXT CHECK (rejected_at IS NULL OR (
    phase IS 'application' AND status IS 'rejected'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', rejected_at) IS rejected_at
  )),
  priority INTEGER CHECK (priority IS NULL OR priority BETWEEN 1 AND 1000000),
outcome TEXT
  CHECK (outcome IS NULL OR (
    phase IS 'application' AND status IS NOT 'active'
    AND json_valid(outcome) AND json_type(outcome) IS 'object'
    AND (json_type(outcome, '$.message') IS 'text' OR json_type(outcome, '$.reason') IS 'text')
  )),
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
  CONSTRAINT opening_required CHECK (phase IS 'application' OR opening IS NOT NULL OR legacy_opening IS 1),
  CONSTRAINT leads_stay_active CHECK (phase IS NOT 'lead' OR status IS 'active'),
  CONSTRAINT lead_application_state CHECK (phase IS NOT 'lead' OR (
    current_stage IS 'lead' AND recruiter_engaged_at IS NULL AND reapply_policy IS NULL AND reapply_after IS NULL
  )),
  CONSTRAINT application_milestone CHECK (phase IS NOT 'application' OR current_stage IS NOT 'lead'),
  CONSTRAINT pipeline_milestone CHECK (current_stage IN ('lead', 'applied', 'outreach', 'recruiter_screen', 'assessment', 'technical_interview', 'system_design', 'hiring_manager', 'final_interview', 'reference_check', 'offer') OR current_stage IS legacy_current_stage)
) STRICT;

CREATE UNIQUE INDEX jobs_opening_url ON jobs(user_id, json_extract(opening, '$.source_url'))
WHERE phase IS 'lead' AND opening IS NOT NULL;
CREATE UNIQUE INDEX jobs_nickname ON jobs(user_id, nickname COLLATE NOCASE);
CREATE INDEX jobs_pipeline ON jobs(user_id, status, score DESC);
CREATE INDEX jobs_reapplication ON jobs(user_id, status, reapply_policy, reapply_after);
CREATE INDEX jobs_source_url ON jobs(user_id, source_url);
CREATE INDEX jobs_rejection_dates ON jobs(user_id, rejected_at) WHERE status IS 'rejected';

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
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, job_id) REFERENCES jobs(user_id, id) ON DELETE CASCADE,
  CONSTRAINT stage_schedule CHECK ((starts_at IS NULL AND ends_at IS NULL AND timezone IS NULL)
    OR (starts_at IS NOT NULL AND timezone IS NOT NULL)),
  CONSTRAINT stage_end CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT stage_calendar CHECK (calendar_event_id IS NULL OR calendar_id IS NOT NULL),
  CONSTRAINT pipeline_milestone CHECK (name IN ('applied', 'outreach', 'recruiter_screen', 'assessment', 'technical_interview', 'system_design', 'hiring_manager', 'final_interview', 'reference_check', 'offer') OR name IS legacy_name)
) STRICT;

CREATE INDEX stages_job ON stages(user_id, job_id, created_at);
CREATE UNIQUE INDEX stages_job_identity ON stages(user_id, job_id, id);
CREATE INDEX stages_upcoming ON stages(user_id, status, starts_at);

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
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, job_id) REFERENCES jobs(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, job_id, contact_id) REFERENCES contacts(user_id, job_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, job_id, stage_id) REFERENCES stages(user_id, job_id, id),
  CHECK (direction IS NOT 'outbound' OR follow_up_status IS NOT NULL),
  CHECK (follow_up_at IS NULL OR follow_up_status IS NOT NULL),
  CONSTRAINT outreach_follow_up CHECK (follow_up_at IS NULL OR follow_up_at >= occurred_at)
) STRICT;

CREATE INDEX outreach_contact_time ON outreach(user_id, contact_id, occurred_at DESC, created_at DESC);
CREATE INDEX outreach_job_time ON outreach(user_id, job_id, direction, occurred_at DESC);

CREATE TABLE job_openings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  source_url TEXT NOT NULL CHECK (source_url GLOB 'https://?*' OR source_url GLOB 'http://?*'),
  location TEXT NOT NULL CHECK (length(trim(location)) > 0),
  status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'unknown')),
  checked_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', checked_at) IS checked_at),
  employer_salary TEXT CHECK (employer_salary IS NULL OR (json_valid(employer_salary) AND json_type(employer_salary) IS 'object')),
  salary_target TEXT CHECK (salary_target IS NULL OR (json_valid(salary_target) AND json_type(salary_target) IS 'object')),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, job_id, source_url),
  FOREIGN KEY (user_id, job_id) REFERENCES jobs(user_id, id) ON DELETE CASCADE
) STRICT;

ALTER TABLE opening_closures RENAME COLUMN eligible_opening TO opening;

INSERT INTO jobs (rowid, user_id, id, company, company_url, phase, title, nickname, description, source_url, location, recruiter_name, recruiter_email, notes, status, current_stage, score, salary_min, salary_max, salary_currency, salary_period, created_at, updated_at, recruiter_engaged_at, reapply_policy, reapply_after, salary_ask_amount, salary_ask_currency, salary_ask_period, salary_ask_basis, opening, salary_declared_amount, salary_declared_currency, salary_declared_period, salary_declared_basis, employer_salary, asked_salary, legacy_current_stage, legacy_opening, rejected_at, priority, outcome) SELECT * FROM rebuild_jobs;
INSERT INTO stages (rowid, user_id, id, job_id, name, status, starts_at, ends_at, timezone, location, contact_name, contact_email, notes, calendar_event_id, calendar_id, created_at, updated_at, legacy_name) SELECT * FROM rebuild_stages;
INSERT INTO feedback (rowid, user_id, id, stage_id, text, source, created_at, updated_at)
SELECT preserved_rowid, user_id, id, stage_id, text, source, created_at, updated_at FROM rebuild_feedback;
INSERT INTO contacts (rowid, user_id, id, job_id, name, relationship, url, email, notes, created_at, updated_at)
SELECT preserved_rowid, user_id, id, job_id, name, relationship, url, email, notes, created_at, updated_at FROM rebuild_contacts;
INSERT INTO outreach (rowid, user_id, id, job_id, contact_id, stage_id, direction, occurred_at, time_basis, channel, notes, follow_up_at, follow_up_status, created_at, updated_at) SELECT * FROM rebuild_outreach;
INSERT INTO prep_notes (rowid, user_id, id, job_id, kind, text, stage_name, status, resolution, closed_at, created_at, updated_at)
SELECT preserved_rowid, user_id, id, job_id, kind, text, stage_name, status, resolution, closed_at, created_at, updated_at FROM rebuild_prep_notes;
INSERT INTO opening_closures (rowid, user_id, job_id, source_url, reason, checked_at, opening, created_at)
SELECT * FROM rebuild_opening_closures;
INSERT INTO job_openings (rowid, id, user_id, job_id, title, description, source_url, location, status, checked_at, employer_salary, salary_target, notes, created_at, updated_at) SELECT * FROM rebuild_job_openings;

-- Binary-collated copies compare every kept value and row ID.
CREATE TABLE rebuild_check (mismatch INTEGER NOT NULL CONSTRAINT migration_data_preserved CHECK (mismatch IS 0)) STRICT;
INSERT INTO rebuild_check SELECT
  EXISTS (SELECT * FROM rebuild_jobs EXCEPT SELECT rowid, user_id, id, company, company_url, phase, title, nickname, description, source_url, location, recruiter_name, recruiter_email, notes, status, current_stage, score, salary_min, salary_max, salary_currency, salary_period, created_at, updated_at, recruiter_engaged_at, reapply_policy, reapply_after, salary_ask_amount, salary_ask_currency, salary_ask_period, salary_ask_basis, opening, salary_declared_amount, salary_declared_currency, salary_declared_period, salary_declared_basis, employer_salary, asked_salary, legacy_current_stage, legacy_opening, rejected_at, priority, outcome FROM jobs)
  OR EXISTS (SELECT rowid, user_id, id, company, company_url, phase, title, nickname, description, source_url, location, recruiter_name, recruiter_email, notes, status, current_stage, score, salary_min, salary_max, salary_currency, salary_period, created_at, updated_at, recruiter_engaged_at, reapply_policy, reapply_after, salary_ask_amount, salary_ask_currency, salary_ask_period, salary_ask_basis, opening, salary_declared_amount, salary_declared_currency, salary_declared_period, salary_declared_basis, employer_salary, asked_salary, legacy_current_stage, legacy_opening, rejected_at, priority, outcome FROM jobs EXCEPT SELECT * FROM rebuild_jobs);
INSERT INTO rebuild_check SELECT
  EXISTS (SELECT * FROM rebuild_stages EXCEPT SELECT rowid, user_id, id, job_id, name, status, starts_at, ends_at, timezone, location, contact_name, contact_email, notes, calendar_event_id, calendar_id, created_at, updated_at, legacy_name FROM stages)
  OR EXISTS (SELECT rowid, user_id, id, job_id, name, status, starts_at, ends_at, timezone, location, contact_name, contact_email, notes, calendar_event_id, calendar_id, created_at, updated_at, legacy_name FROM stages EXCEPT SELECT * FROM rebuild_stages);
INSERT INTO rebuild_check SELECT
  EXISTS (SELECT * FROM rebuild_feedback EXCEPT SELECT rowid, * FROM feedback)
  OR EXISTS (SELECT rowid, * FROM feedback EXCEPT SELECT * FROM rebuild_feedback);
INSERT INTO rebuild_check SELECT
  EXISTS (SELECT * FROM rebuild_contacts EXCEPT SELECT rowid, * FROM contacts)
  OR EXISTS (SELECT rowid, * FROM contacts EXCEPT SELECT * FROM rebuild_contacts);
INSERT INTO rebuild_check SELECT
  EXISTS (SELECT * FROM rebuild_outreach EXCEPT SELECT rowid, user_id, id, job_id, contact_id, stage_id, direction, occurred_at, time_basis, channel, notes, follow_up_at, follow_up_status, created_at, updated_at FROM outreach)
  OR EXISTS (SELECT rowid, user_id, id, job_id, contact_id, stage_id, direction, occurred_at, time_basis, channel, notes, follow_up_at, follow_up_status, created_at, updated_at FROM outreach EXCEPT SELECT * FROM rebuild_outreach);
INSERT INTO rebuild_check SELECT
  EXISTS (SELECT * FROM rebuild_prep_notes EXCEPT SELECT rowid, * FROM prep_notes)
  OR EXISTS (SELECT rowid, * FROM prep_notes EXCEPT SELECT * FROM rebuild_prep_notes);
INSERT INTO rebuild_check SELECT
  EXISTS (SELECT * FROM rebuild_opening_closures EXCEPT SELECT rowid, * FROM opening_closures)
  OR EXISTS (SELECT rowid, * FROM opening_closures EXCEPT SELECT * FROM rebuild_opening_closures);
INSERT INTO rebuild_check SELECT
  EXISTS (SELECT * FROM rebuild_job_openings EXCEPT SELECT rowid, id, user_id, job_id, title, description, source_url, location, status, checked_at, employer_salary, salary_target, notes, created_at, updated_at FROM job_openings)
  OR EXISTS (SELECT rowid, id, user_id, job_id, title, description, source_url, location, status, checked_at, employer_salary, salary_target, notes, created_at, updated_at FROM job_openings EXCEPT SELECT * FROM rebuild_job_openings);
INSERT INTO rebuild_check SELECT EXISTS (SELECT 1 FROM pragma_foreign_key_check);
INSERT INTO rebuild_check SELECT EXISTS (SELECT 1 FROM jobs WHERE opening IS NOT NULL
  AND (json_type(opening, '$.eligibility') IS NOT NULL OR json_type(opening, '$.eligibility_reason') IS NOT NULL
    OR json_type(opening, '$.criteria_updated_at') IS NOT NULL));

DROP TABLE rebuild_check;
DROP TABLE rebuild_jobs;
DROP TABLE rebuild_stages;
DROP TABLE rebuild_feedback;
DROP TABLE rebuild_contacts;
DROP TABLE rebuild_outreach;
DROP TABLE rebuild_prep_notes;
DROP TABLE rebuild_opening_closures;
DROP TABLE rebuild_job_openings;
