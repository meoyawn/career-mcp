CREATE TABLE job_openings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  evidence TEXT NOT NULL CHECK (
    json_valid(evidence) AND json_type(evidence) IS 'object'
    AND json_type(evidence, '$.title') IS 'text' AND length(trim(json_extract(evidence, '$.title'))) > 0
    AND json_type(evidence, '$.description') IS 'text' AND length(trim(json_extract(evidence, '$.description'))) > 0
    AND json_type(evidence, '$.location') IS 'text' AND length(trim(json_extract(evidence, '$.location'))) > 0
    AND json_type(evidence, '$.eligibility_reason') IS 'text' AND length(trim(json_extract(evidence, '$.eligibility_reason'))) > 0
    AND json_type(evidence, '$.criteria_updated_at') IS NOT NULL
    AND (json_type(evidence, '$.criteria_updated_at') IS 'null'
      OR strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(evidence, '$.criteria_updated_at')) IS json_extract(evidence, '$.criteria_updated_at'))
    AND (json_extract(evidence, '$.eligibility') IS NOT 'eligible' OR json_type(evidence, '$.criteria_updated_at') IS 'text')
  ),
  source_url TEXT GENERATED ALWAYS AS (json_extract(evidence, '$.source_url')) STORED NOT NULL
    CHECK (source_url GLOB 'https://?*' OR source_url GLOB 'http://?*'),
  status TEXT GENERATED ALWAYS AS (json_extract(evidence, '$.status')) STORED NOT NULL CHECK (status IN ('open', 'closed', 'unknown')),
  eligibility TEXT GENERATED ALWAYS AS (json_extract(evidence, '$.eligibility')) STORED NOT NULL CHECK (eligibility IN ('eligible', 'ineligible', 'unknown')),
  checked_at TEXT GENERATED ALWAYS AS (json_extract(evidence, '$.checked_at')) STORED NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', checked_at) IS checked_at),
  employer_salary TEXT CHECK (employer_salary IS NULL OR (json_valid(employer_salary) AND json_type(employer_salary) IS 'object')),
  salary_target TEXT CHECK (salary_target IS NULL OR (json_valid(salary_target) AND json_type(salary_target) IS 'object')),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, job_id, source_url),
  FOREIGN KEY (user_id, job_id) REFERENCES jobs(user_id, id) ON DELETE CASCADE
) STRICT;

INSERT INTO job_openings (id, user_id, job_id, evidence, employer_salary, salary_target, created_at, updated_at)
SELECT j.id, j.user_id, j.id,
  CASE WHEN c.checked_at >= json_extract(j.eligible_opening, '$.checked_at')
    THEN json_set(j.eligible_opening, '$.status', 'closed', '$.checked_at', c.checked_at)
    ELSE j.eligible_opening END,
  CASE WHEN j.employer_salary IS NOT NULL THEN j.employer_salary
    WHEN j.salary_min IS NOT NULL OR j.salary_max IS NOT NULL THEN json_object(
      'min', j.salary_min, 'max', j.salary_max, 'currency', j.salary_currency, 'period', j.salary_period)
    ELSE NULL END,
  CASE WHEN j.salary_ask_amount IS NOT NULL THEN json_object('amount', j.salary_ask_amount,
    'currency', j.salary_ask_currency, 'period', j.salary_ask_period, 'basis', j.salary_ask_basis) ELSE NULL END,
  j.created_at, j.updated_at
FROM jobs j LEFT JOIN opening_closures c ON c.user_id IS j.user_id AND c.job_id IS j.id
  AND c.source_url IS json_extract(j.eligible_opening, '$.source_url')
WHERE j.eligible_opening IS NOT NULL;

CREATE TABLE job_opening_checks (
  error TEXT NOT NULL CHECK (error IN ('opening_not_found', 'opening_unavailable', 'opening_outdated', 'application_opening')),
  CONSTRAINT opening_not_found CHECK (error IS NOT 'opening_not_found'),
  CONSTRAINT opening_unavailable CHECK (error IS NOT 'opening_unavailable'),
  CONSTRAINT opening_outdated CHECK (error IS NOT 'opening_outdated'),
  CONSTRAINT application_opening CHECK (error IS NOT 'application_opening')
) STRICT;
