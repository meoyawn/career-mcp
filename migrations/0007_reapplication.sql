ALTER TABLE jobs ADD COLUMN reapply_policy TEXT
  CHECK (reapply_policy IS NULL OR reapply_policy IN ('allowed', 'not_allowed'));
ALTER TABLE jobs ADD COLUMN reapply_after TEXT
  CHECK (reapply_after IS NULL OR (
    reapply_policy IS 'allowed'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', reapply_after) IS reapply_after
  ));

CREATE INDEX jobs_reapplication ON jobs(user_id, status, reapply_policy, reapply_after);
