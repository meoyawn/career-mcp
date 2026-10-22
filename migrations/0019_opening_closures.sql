CREATE TABLE opening_closures (
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  source_url TEXT NOT NULL CHECK (source_url GLOB 'https://?*' OR source_url GLOB 'http://?*'),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  checked_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', checked_at) IS checked_at),
  eligible_opening TEXT CHECK (eligible_opening IS NULL OR json_valid(eligible_opening)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, job_id, source_url),
  FOREIGN KEY (user_id, job_id) REFERENCES jobs(user_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE opening_checks (
  error TEXT NOT NULL CHECK (error IN ('opening_closed', 'opening_mismatch', 'closure_outdated')),
  CONSTRAINT opening_closed CHECK (error IS NOT 'opening_closed'),
  CONSTRAINT opening_mismatch CHECK (error IS NOT 'opening_mismatch'),
  CONSTRAINT closure_outdated CHECK (error IS NOT 'closure_outdated')
) STRICT;
