ALTER TABLE jobs ADD COLUMN rejected_at TEXT
  CHECK (rejected_at IS NULL OR (
    phase IS 'application' AND status IS 'rejected'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', rejected_at) IS rejected_at
  ));

CREATE INDEX jobs_rejection_dates ON jobs(user_id, rejected_at) WHERE status IS 'rejected';
