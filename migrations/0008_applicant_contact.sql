CREATE TABLE applicant_contact (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  email TEXT CHECK (email IS NULL OR length(trim(email)) > 0),
  phone TEXT CHECK (phone IS NULL OR length(trim(phone)) > 0),
  updated_at TEXT NOT NULL
) STRICT;
