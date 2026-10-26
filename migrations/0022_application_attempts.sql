DROP INDEX jobs_source_url;

CREATE INDEX jobs_source_url ON jobs(user_id, source_url);
