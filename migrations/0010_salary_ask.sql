ALTER TABLE jobs ADD COLUMN salary_ask_amount REAL
  CHECK (salary_ask_amount IS NULL OR
    (salary_ask_amount >= 0 AND salary_ask_amount <= 9007199254740991));
ALTER TABLE jobs ADD COLUMN salary_ask_currency TEXT;
ALTER TABLE jobs ADD COLUMN salary_ask_period TEXT;
ALTER TABLE jobs ADD COLUMN salary_ask_basis TEXT
  CONSTRAINT salary_ask_units CHECK (
    (salary_ask_amount IS NULL AND salary_ask_currency IS NULL AND salary_ask_period IS NULL AND salary_ask_basis IS NULL)
    OR (salary_ask_amount IS NOT NULL
      AND salary_ask_currency IS NOT NULL AND length(salary_ask_currency) IS 3 AND salary_ask_currency NOT GLOB '*[^A-Z]*'
      AND salary_ask_period IS NOT NULL AND salary_ask_period IN ('hour', 'day', 'week', 'month', 'year')
      AND (salary_ask_basis IS NULL OR salary_ask_basis IN ('gross', 'net')))
  );
