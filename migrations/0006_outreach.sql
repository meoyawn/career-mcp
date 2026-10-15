ALTER TABLE jobs ADD COLUMN recruiter_engaged_at TEXT
  CHECK (recruiter_engaged_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', recruiter_engaged_at) IS recruiter_engaged_at);

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

CREATE UNIQUE INDEX contacts_url ON contacts(user_id, job_id, url) WHERE url IS NOT NULL;
CREATE UNIQUE INDEX contacts_email ON contacts(user_id, job_id, email COLLATE NOCASE) WHERE email IS NOT NULL;
CREATE INDEX contacts_job ON contacts(user_id, job_id);
CREATE UNIQUE INDEX stages_job_identity ON stages(user_id, job_id, id);

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
  FOREIGN KEY (user_id, job_id, contact_id) REFERENCES contacts(user_id, job_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, job_id, stage_id) REFERENCES stages(user_id, job_id, id),
  CHECK (direction IS NOT 'outbound' OR follow_up_status IS NOT NULL),
  CHECK (follow_up_at IS NULL OR follow_up_status IS NOT NULL),
  CHECK (follow_up_at IS NULL OR follow_up_at >= occurred_at)
) STRICT;

CREATE INDEX outreach_contact_time ON outreach(user_id, contact_id, occurred_at DESC, created_at DESC);
CREATE INDEX outreach_job_time ON outreach(user_id, job_id, direction, occurred_at DESC);

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
