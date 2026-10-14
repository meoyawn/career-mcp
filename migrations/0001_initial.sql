CREATE TABLE users (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE criteria (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  id INTEGER NOT NULL CHECK (id IS 1),
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE jobs (
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
  criteria_revision INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, id),
  CHECK (
    (qualification IS 'pending' AND score IS NULL AND qualification_reason IS NULL AND criteria_revision IS NULL)
    OR (qualification IS NOT 'pending' AND score IS NOT NULL AND qualification_reason IS NOT NULL AND criteria_revision IS NOT NULL)
  )
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
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, job_id) REFERENCES jobs(user_id, id) ON DELETE CASCADE,
  CHECK ((starts_at IS NULL AND ends_at IS NULL AND timezone IS NULL)
    OR (starts_at IS NOT NULL AND timezone IS NOT NULL)),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (calendar_event_id IS NULL OR calendar_id IS NOT NULL)
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

CREATE UNIQUE INDEX jobs_nickname ON jobs(user_id, nickname COLLATE NOCASE);
CREATE UNIQUE INDEX jobs_source_url ON jobs(user_id, source_url);
CREATE INDEX jobs_pipeline ON jobs(user_id, status, qualification, score DESC);
CREATE INDEX stages_job ON stages(user_id, job_id, created_at);
CREATE INDEX stages_upcoming ON stages(user_id, status, starts_at);
CREATE INDEX feedback_stage ON feedback(user_id, stage_id, created_at);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL CHECK (counter >= 0),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE auth_challenges (
  id_hash TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  user_id TEXT,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX auth_challenges_expiry ON auth_challenges(expires_at);

CREATE TABLE browser_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX browser_sessions_expiry ON browser_sessions(expires_at);

CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX oauth_codes_expiry ON oauth_codes(expires_at);

CREATE TABLE oauth_tokens (
  access_hash TEXT PRIMARY KEY,
  refresh_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  resource TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX oauth_tokens_user ON oauth_tokens(user_id);
CREATE INDEX oauth_tokens_expiry ON oauth_tokens(refresh_expires_at);
