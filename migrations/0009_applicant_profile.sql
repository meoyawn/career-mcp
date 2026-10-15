CREATE TABLE applicant_profile (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  gender TEXT NOT NULL CHECK (length(trim(gender)) > 0),
  updated_at TEXT NOT NULL
) STRICT;
