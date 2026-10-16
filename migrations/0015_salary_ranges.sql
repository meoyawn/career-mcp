ALTER TABLE jobs ADD COLUMN employer_salary TEXT
  CHECK (employer_salary IS NULL OR (json_valid(employer_salary) AND json_type(employer_salary) IS 'object'));
ALTER TABLE jobs ADD COLUMN asked_salary TEXT
  CHECK (asked_salary IS NULL OR (json_valid(asked_salary) AND json_type(asked_salary) IS 'object'));
