CREATE TABLE application_context (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE cvs (
  user_id TEXT NOT NULL REFERENCES users(id),
  language TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(language)) > 0),
  url TEXT NOT NULL CHECK (length(trim(url)) > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, language)
) STRICT;
