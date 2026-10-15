import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";

describe("User ownership schema and lead migrations", () => {
  test("pipeline milestone guards reject arbitrary database writes without rewriting legacy histories", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const migration of (await readdir("migrations")).filter((name) => name < "0011" && name.endsWith(".sql")).sort()) {
        db.exec(await readFile(`migrations/${migration}`, "utf8"));
      }
      db.exec(`INSERT INTO users (id, created_at) VALUES ('alice', 'created');
        INSERT INTO jobs (user_id, id, company, phase, current_stage, created_at, updated_at)
          VALUES ('alice', 'legacy', 'Example employer', 'application', 'Prepared — awaiting human submission', 'created', 'updated');
        INSERT INTO stages (user_id, id, job_id, name, created_at, updated_at)
          VALUES ('alice', 'legacy-round', 'legacy', 'Custom historical round', 'created', 'updated');
        INSERT INTO feedback (user_id, id, stage_id, text, created_at, updated_at)
          VALUES ('alice', 'reflection', 'legacy-round', 'Preserve this feedback', 'created', 'updated');`);
      db.exec(await readFile("migrations/0011_eligible_openings.sql", "utf8"));
      db.exec(await readFile("migrations/0012_all_job_openings.sql", "utf8"));
      const jobs = db.prepare("SELECT * FROM jobs").all();
      const stages = db.prepare("SELECT * FROM stages").all();
      const feedback = db.prepare("SELECT * FROM feedback").all();
      db.exec(await readFile("migrations/0013_pipeline_milestones.sql", "utf8"));
      assert.deepEqual(db.prepare("SELECT * FROM jobs").all(), jobs);
      assert.deepEqual(db.prepare("SELECT * FROM stages").all(), stages);
      assert.deepEqual(db.prepare("SELECT * FROM feedback").all(), feedback);
      db.exec("UPDATE jobs SET notes = 'Historical label needs review' WHERE id IS 'legacy'");
      db.exec("UPDATE stages SET status = 'completed' WHERE id IS 'legacy-round'");
      const now = new Date().toISOString();
      db.prepare("INSERT INTO criteria (user_id, text, updated_at) VALUES ('alice', 'Remote engineering', ?)").run(now);
      const proof = JSON.stringify({
        title: "Engineer", description: "Build developer tools", source_url: "https://jobs.example/fixed-milestones", location: "Remote",
        status: "open", eligibility: "eligible", checked_at: now, criteria_updated_at: now, eligibility_reason: "Passes all exclusions",
      });
      const insertJob = db.prepare("INSERT INTO jobs (user_id, id, company, current_stage, eligible_opening, created_at, updated_at) VALUES ('alice', 'new', 'New employer', ?, ?, 'created', 'updated')");
      const insertStage = db.prepare("INSERT INTO stages (user_id, id, job_id, name, created_at, updated_at) VALUES ('alice', 'new-round', 'legacy', ?, 'created', 'updated')");
      for (const invalid of ["prepared", "Prepared — awaiting human submission", "draft", "arbitrary milestone"]) {
        assert.throws(() => insertJob.run(invalid, proof), /predefined pipeline milestone/u);
        assert.throws(() => db.prepare("UPDATE jobs SET current_stage = ? WHERE id IS 'legacy'").run(invalid), /predefined pipeline milestone/u);
        assert.throws(() => insertStage.run(invalid), /predefined pipeline milestone/u);
        assert.throws(() => db.prepare("UPDATE stages SET name = ? WHERE id IS 'legacy-round'").run(invalid), /predefined pipeline milestone/u);
      }
      insertJob.run("lead", proof);
      insertStage.run("applied");
      db.exec("UPDATE stages SET name = 'recruiter_screen' WHERE id IS 'new-round'");
      db.exec("UPDATE jobs SET current_stage = 'recruiter_screen' WHERE id IS 'legacy'");
      assert.equal(db.prepare("SELECT current_stage FROM jobs WHERE id IS 'legacy'").get()?.current_stage, "recruiter_screen");
      assert.equal(db.prepare("SELECT name FROM stages WHERE id IS 'new-round'").get()?.name, "recruiter_screen");
      assert.deepEqual(db.prepare("SELECT * FROM feedback").all(), feedback);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }
  });

  test("opening migrations preserve history and block unqualified inserts in either phase and employer transitions directly in D1", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const migration of (await readdir("migrations")).filter((name) => name < "0011" && name.endsWith(".sql")).sort()) {
        db.exec(await readFile(`migrations/${migration}`, "utf8"));
      }
      const now = new Date().toISOString();
      db.exec(`INSERT INTO users (id, created_at) VALUES ('alice', 'created'), ('bob', 'created');
        INSERT INTO jobs (user_id, id, company, phase, created_at, updated_at)
          VALUES ('alice', 'legacy', 'Legacy employer', 'lead', 'created', 'updated'),
            ('alice', 'application', 'Applied employer', 'application', 'created', 'updated');
        INSERT INTO stages (user_id, id, job_id, name, created_at, updated_at)
          VALUES ('alice', 'round', 'application', 'Screening', 'created', 'updated');
        INSERT INTO feedback (user_id, id, stage_id, text, created_at, updated_at)
          VALUES ('alice', 'feedback', 'round', 'Keep this history', 'created', 'updated');`);
      const original = db.prepare("SELECT * FROM jobs ORDER BY id").all();
      const stages = db.prepare("SELECT * FROM stages").all();
      const feedback = db.prepare("SELECT * FROM feedback").all();
      db.exec(await readFile("migrations/0011_eligible_openings.sql", "utf8"));
      db.exec(await readFile("migrations/0012_all_job_openings.sql", "utf8"));
      assert.deepEqual(db.prepare("SELECT * FROM jobs ORDER BY id").all().map((row) => ({ ...row })), original.map((row) => ({ ...row, eligible_opening: null })));
      assert.deepEqual(db.prepare("SELECT * FROM stages").all(), stages);
      assert.deepEqual(db.prepare("SELECT * FROM feedback").all(), feedback);
      db.prepare("INSERT INTO criteria (user_id, text, updated_at) VALUES ('alice', 'Remote EMEA engineering', ?)").run(now);
      const proof = {
        title: "Engineer", description: "Build TypeScript developer tools", source_url: "https://jobs.example/eligible", location: "Remote EMEA",
        status: "open", eligibility: "eligible", checked_at: now, criteria_updated_at: now, eligibility_reason: "Passes all exclusions",
      };
      const insert = db.prepare("INSERT INTO jobs (user_id, id, company, eligible_opening, created_at, updated_at) VALUES (?, ?, 'New employer', ?, 'created', 'updated')");
      assert.throws(() => insert.run("alice", "invalid", null), /eligible opening/u);
      assert.throws(() => db.exec("INSERT INTO jobs (user_id, id, company, phase, created_at, updated_at) VALUES ('alice', 'bypass', 'Unqualified application', 'application', 'created', 'updated')"), /eligible opening/u);
      assert.throws(() => db.exec("UPDATE jobs SET company = 'New application employer' WHERE id IS 'application'"), /eligible opening/u);
      assert.throws(() => insert.run("bob", "invalid", JSON.stringify(proof)), /current saved criteria/u);
      for (const invalid of [
        { status: "closed" }, { eligibility: "excluded" }, { eligibility: "unknown" }, { title: " " },
        { source_url: "" }, { description: "" }, { location: "" }, { eligibility_reason: "" },
        { checked_at: "2000-01-01T00:00:00Z" }, { checked_at: "2099-01-01T00:00:00Z" },
        { criteria_updated_at: "2000-01-01T00:00:00Z" },
      ]) assert.throws(() => insert.run("alice", "invalid", JSON.stringify({ ...proof, ...invalid })), /CHECK|24 hours|current saved criteria/u);
      assert.throws(() => db.exec("UPDATE jobs SET phase = 'lead' WHERE id IS 'application'"), /eligible opening/u);
      assert.throws(() => db.exec("UPDATE jobs SET company = 'Different employer' WHERE id IS 'legacy'"), /eligible opening/u);
      db.exec("UPDATE jobs SET status = 'withdrawn' WHERE id IS 'legacy'");
      assert.throws(() => db.exec("UPDATE jobs SET status = 'active' WHERE id IS 'legacy'"), /eligible opening/u);
      insert.run("alice", "qualified", JSON.stringify(proof));
      assert.throws(() => insert.run("alice", "duplicate", JSON.stringify(proof)), /UNIQUE/u);
      db.prepare("UPDATE jobs SET eligible_opening = ?, phase = 'lead' WHERE id IS 'application'")
        .run(JSON.stringify({ ...proof, source_url: "https://jobs.example/converted" }));
      db.prepare("UPDATE criteria SET updated_at = ? WHERE user_id IS 'alice'").run(new Date(Date.parse(now) + 1).toISOString());
      assert.throws(() => insert.run("alice", "stale", JSON.stringify({ ...proof, source_url: "https://jobs.example/stale" })), /current saved criteria/u);
      assert.deepEqual(db.prepare("SELECT * FROM stages").all(), stages);
      assert.deepEqual(db.prepare("SELECT * FROM feedback").all(), feedback);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }
  });

  test("salary ask migration preserves employer budgets, leaves legacy asks unknown, and constrains amount and units", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const migration of ["0001_initial", "0002_single_criteria", "0003_qualified_leads", "0004_application_context_cvs", "0005_employer_leads", "0006_outreach", "0007_reapplication", "0008_applicant_contact", "0009_applicant_profile"]) {
        db.exec(await readFile(`migrations/${migration}.sql`, "utf8"));
      }
      db.exec(`INSERT INTO users (id, created_at) VALUES ('alice', 'created');
        INSERT INTO jobs (user_id, id, company, phase, salary_min, salary_max, salary_currency, salary_period, notes, created_at, updated_at)
          VALUES ('alice', 'application', 'Example employer', 'application', 100000, 120000, 'USD', 'year', 'Preserve salary research notes', 'created', 'updated');`);
      const original = db.prepare("SELECT * FROM jobs").get();
      db.exec(await readFile("migrations/0010_salary_ask.sql", "utf8"));
      const unknown = { salary_ask_amount: null, salary_ask_currency: null, salary_ask_period: null, salary_ask_basis: null };
      assert.deepEqual({ ...db.prepare("SELECT * FROM jobs").get() }, { ...original, ...unknown });
      db.exec("UPDATE jobs SET salary_ask_amount = 5500, salary_ask_currency = 'EUR', salary_ask_period = 'month', salary_ask_basis = 'gross'");
      for (const invalid of [
        "salary_ask_amount = -1", "salary_ask_amount = 1e100", "salary_ask_amount = 'unknown'", "salary_ask_amount = NULL",
        "salary_ask_currency = NULL", "salary_ask_currency = 'eur'", "salary_ask_period = NULL", "salary_ask_period = 'unknown'", "salary_ask_basis = 'unknown'",
      ]) assert.throws(() => db.exec(`UPDATE jobs SET ${invalid}`), /CHECK|cannot store TEXT/u);
      db.exec("UPDATE jobs SET salary_ask_amount = 45.5, salary_ask_period = 'hour', salary_ask_basis = 'net'");
      const ask = db.prepare("SELECT salary_ask_amount, salary_ask_currency, salary_ask_period, salary_ask_basis FROM jobs").get();
      assert.deepEqual({ ...ask }, { salary_ask_amount: 45.5, salary_ask_currency: "EUR", salary_ask_period: "hour", salary_ask_basis: "net" });
      db.exec("UPDATE jobs SET salary_ask_basis = NULL");
      db.exec("UPDATE jobs SET salary_ask_amount = NULL, salary_ask_currency = NULL, salary_ask_period = NULL, salary_ask_basis = NULL");
      assert.deepEqual({ ...db.prepare("SELECT * FROM jobs").get() }, { ...original, ...unknown });
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }
  });

  test("reapplication migration preserves rejected histories without inventing cooldowns and constrains eligibility deadlines", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const migration of ["0001_initial", "0002_single_criteria", "0003_qualified_leads", "0004_application_context_cvs", "0005_employer_leads", "0006_outreach"]) {
        db.exec(await readFile(`migrations/${migration}.sql`, "utf8"));
      }
      db.exec(`INSERT INTO users (id, created_at) VALUES ('alice', 'created');
        INSERT INTO jobs (user_id, id, company, phase, status, current_stage, created_at, updated_at)
          VALUES ('alice', 'attempt', 'Example employer', 'application', 'rejected', 'System design', 'created', 'updated');
        INSERT INTO stages (user_id, id, job_id, name, status, created_at, updated_at)
          VALUES ('alice', 'round', 'attempt', 'System design', 'failed', 'created', 'updated');
        INSERT INTO feedback (user_id, id, stage_id, text, source, created_at, updated_at)
          VALUES ('alice', 'feedback', 'round', 'Try again later', 'recruiter', 'created', 'updated');`);
      const job = db.prepare("SELECT * FROM jobs").get();
      const stages = db.prepare("SELECT * FROM stages").all();
      const feedback = db.prepare("SELECT * FROM feedback").all();
      db.exec(await readFile("migrations/0007_reapplication.sql", "utf8"));
      assert.deepEqual({ ...db.prepare("SELECT * FROM jobs").get() }, { ...job, reapply_policy: null, reapply_after: null });
      assert.deepEqual(db.prepare("SELECT * FROM stages").all(), stages);
      assert.deepEqual(db.prepare("SELECT * FROM feedback").all(), feedback);
      for (const invalid of ["reapply_policy = 'maybe'", "reapply_after = '2026-08-30T00:00:00.000Z'", "reapply_policy = 'allowed', reapply_after = 'bad-date'"]) {
        assert.throws(() => db.exec(`UPDATE jobs SET ${invalid}`), /CHECK/u);
      }
      db.exec("UPDATE jobs SET reapply_policy = 'allowed', reapply_after = '2026-08-30T00:00:00.000Z'");
      assert.throws(() => db.exec("UPDATE jobs SET reapply_policy = 'not_allowed'"), /CHECK/u);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }
  });

  test("outreach migration preserves histories and enforces contact, job, timestamp and user boundaries in D1", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const migration of ["0001_initial", "0002_single_criteria", "0003_qualified_leads", "0004_application_context_cvs", "0005_employer_leads"]) {
        db.exec(await readFile(`migrations/${migration}.sql`, "utf8"));
      }
      db.exec(`INSERT INTO users (id, created_at) VALUES ('alice', 'now'), ('bob', 'now');
        INSERT INTO jobs (user_id, id, company, created_at, updated_at)
          VALUES ('alice', 'a', 'Employer A', 'now', 'now'), ('alice', 'b', 'Employer B', 'now', 'now'), ('bob', 'c', 'Employer C', 'now', 'now');
        INSERT INTO stages (user_id, id, job_id, name, created_at, updated_at)
          VALUES ('alice', 'stage-a', 'a', 'attempt_referral', 'now', 'now'), ('alice', 'stage-b', 'b', 'Screening', 'now', 'now');`);
      const stages = db.prepare("SELECT * FROM stages ORDER BY id").all();
      db.exec(await readFile("migrations/0006_outreach.sql", "utf8"));
      assert.deepEqual(db.prepare("SELECT * FROM stages ORDER BY id").all(), stages);
      assert.deepEqual(db.prepare("SELECT * FROM outreach").all(), []);
      db.exec(`INSERT INTO contacts (user_id, id, job_id, name, relationship, created_at, updated_at)
        VALUES ('alice', 'friend', 'a', 'Example friend', 'friend', 'now', 'now'), ('bob', 'bob-contact', 'c', 'Bob friend', 'friend', 'now', 'now');`);
      const insert = db.prepare(`INSERT INTO outreach (user_id, id, job_id, contact_id, stage_id, direction, occurred_at, time_basis, follow_up_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'outbound', ?, 'reported', 'pending', 'now', 'now')`);
      insert.run('alice', 'sent', 'a', 'friend', 'stage-a', '2026-09-01T09:00:00.000Z');
      for (const [user, job, contact, stage] of [
        ['bob', 'a', 'friend', 'stage-a'], ['alice', 'b', 'friend', 'stage-b'], ['alice', 'a', 'friend', 'stage-b'], ['alice', 'a', 'bob-contact', null],
      ] as const) assert.throws(() => insert.run(user, crypto.randomUUID(), job, contact, stage, '2026-09-01T09:00:00.000Z'), /FOREIGN KEY/u);
      assert.throws(() => insert.run('alice', 'invalid', 'a', 'friend', null, 'not-a-timestamp'), /CHECK/u);
      assert.throws(() => db.exec("UPDATE outreach SET follow_up_at = '2026-08-01T09:00:00.000Z' WHERE id IS 'sent'"), /CHECK/u);
      assert.throws(() => db.exec("UPDATE outreach SET follow_up_status = NULL WHERE id IS 'sent'"), /CHECK/u);
      db.exec("UPDATE jobs SET current_stage = 'Screening' WHERE id IS 'a'");
      assert.equal(db.prepare("SELECT last_outreach_at FROM contact_activity WHERE id IS 'friend'").get()?.last_outreach_at, '2026-09-01T09:00:00.000Z');
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      db.exec("DELETE FROM jobs WHERE id IS 'a'");
      assert.deepEqual(db.prepare("SELECT * FROM outreach").all(), []);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM contacts").get()?.n, 1);
    } finally {
      db.close();
    }
  });

  test("employer migration removes lead openings, preserves application histories, and enforces opening and salary storage boundaries", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const migration of ["0001_initial", "0002_single_criteria", "0003_qualified_leads", "0004_application_context_cvs"]) {
        db.exec(await readFile(`migrations/${migration}.sql`, "utf8"));
      }
      db.exec(`INSERT INTO users (id, created_at) VALUES ('alice', 'created');
        INSERT INTO jobs (user_id, id, company, title, description, source_url, location, current_stage, notes, score, created_at, updated_at)
          VALUES ('alice', 'lead', 'Employer', 'Old opening', 'Old description', 'https://jobs.example/old', 'Remote', 'lead', 'Employer research; Old opening; Old description; https://jobs.example/old', 90, 'created', 'updated'),
            ('alice', 'application', 'Applicant Co', 'Engineer', 'Applied role', 'https://jobs.example/applied', 'Remote', 'Technical', 'Application notes', 95, 'created', 'updated');
        INSERT INTO stages (rowid, user_id, id, job_id, name, calendar_event_id, calendar_id, created_at, updated_at)
          VALUES (7, 'alice', 'interview', 'application', 'Technical', 'event', 'primary', 'created', 'updated');
        INSERT INTO feedback (rowid, user_id, id, stage_id, text, created_at, updated_at)
          VALUES (11, 'alice', 'reflection', 'interview', 'Interview feedback', 'created', 'updated');`);
      const application = db.prepare("SELECT * FROM jobs WHERE id IS 'application'").get();
      const stages = db.prepare("SELECT rowid, * FROM stages").all();
      const feedback = db.prepare("SELECT rowid, * FROM feedback").all();
      db.exec("BEGIN");
      db.exec(await readFile("migrations/0005_employer_leads.sql", "utf8"));
      db.exec("COMMIT");
      const lead = db.prepare("SELECT * FROM jobs WHERE id IS 'lead'").get();
      assert.ok(lead);
      assert.equal(lead.phase, "lead");
      assert.equal(lead.notes, "Employer research; ; ; ");
      assert.equal(lead.score, 90);
      for (const field of ["title", "description", "source_url", "location"]) assert.equal(lead[field], null);
      const migrated = db.prepare("SELECT * FROM jobs WHERE id IS 'application'").get();
      assert.ok(migrated && application);
      assert.equal(migrated.phase, "application");
      for (const [key, value] of Object.entries(application)) assert.deepEqual(migrated[key], value);
      assert.deepEqual(db.prepare("SELECT rowid, * FROM stages").all(), stages);
      assert.deepEqual(db.prepare("SELECT rowid, * FROM feedback").all(), feedback);
      db.exec("INSERT INTO jobs (user_id, id, company, created_at, updated_at) VALUES ('alice', 'new-lead', 'New employer', 'now', 'now')");
      for (const field of ["title", "description", "source_url", "location"]) {
        assert.throws(() => db.prepare(`UPDATE jobs SET ${field} = ? WHERE id IS 'lead'`).run("Forbidden opening"), /opening_requires_application/u);
      }
      assert.throws(() => db.exec("UPDATE jobs SET phase = 'lead' WHERE id IS 'application'"), /opening_requires_application/u);
      db.exec("UPDATE jobs SET salary_min = 45.5, salary_max = 75, salary_currency = 'EUR', salary_period = 'hour' WHERE id IS 'lead'");
      assert.deepEqual({ ...db.prepare("SELECT salary_min, salary_max, salary_currency, salary_period FROM jobs WHERE id IS 'lead'").get() },
        { salary_min: 45.5, salary_max: 75, salary_currency: "EUR", salary_period: "hour" });
      for (const invalid of ["salary_min = -1", "salary_max = 40", "salary_currency = NULL", "salary_period = NULL", "salary_currency = 'eur'", "salary_period = 'unknown'"]) {
        assert.throws(() => db.exec(`UPDATE jobs SET ${invalid} WHERE id IS 'lead'`), /CHECK/u);
      }
      assert.throws(() => db.exec("UPDATE jobs SET salary_min = 100 WHERE id IS 'new-lead'"), /salary_units/u);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      db.exec("DELETE FROM jobs WHERE id IS 'application'");
      assert.deepEqual(db.prepare("SELECT * FROM stages").all(), []);
      assert.deepEqual(db.prepare("SELECT * FROM feedback").all(), []);
    } finally {
      db.close();
    }
  });

  test("enforces ownership on parent-child relationships and requires an owner for stored jobs", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(await readFile("migrations/0001_initial.sql", "utf8"));
      db.exec(await readFile("migrations/0002_single_criteria.sql", "utf8"));
      db.exec(await readFile("migrations/0003_qualified_leads.sql", "utf8"));
      db.exec(`INSERT INTO users (id, created_at) VALUES ('alice', 'now'), ('bob', 'now');
        INSERT INTO jobs (user_id, id, company, title, description, created_at, updated_at)
          VALUES ('alice', 'alice-job', 'Company', 'Engineer', 'Alice description', 'now', 'now'),
            ('bob', 'bob-job', 'Company', 'Engineer', 'Bob description', 'now', 'now');
        INSERT INTO stages (user_id, id, job_id, name, created_at, updated_at)
          VALUES ('alice', 'alice-stage', 'alice-job', 'Screening', 'now', 'now'),
            ('bob', 'bob-stage', 'bob-job', 'Screening', 'now', 'now');
        INSERT INTO feedback (user_id, id, stage_id, text, created_at, updated_at)
          VALUES ('alice', 'alice-feedback', 'alice-stage', 'Alice private feedback', 'now', 'now'),
            ('bob', 'bob-feedback', 'bob-stage', 'Bob private feedback', 'now', 'now');`);
      db.exec("INSERT INTO criteria (user_id, text, updated_at) VALUES ('alice', 'Remote roles', 'now')");
      const existing = ["criteria", "jobs", "stages", "feedback"].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY user_id`).all());
      db.exec(await readFile("migrations/0004_application_context_cvs.sql", "utf8"));
      assert.deepEqual(["criteria", "jobs", "stages", "feedback"].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY user_id`).all()), existing);
      db.exec(`INSERT INTO application_context (user_id, text, updated_at) VALUES ('alice', 'Applicant background', 'now');
        INSERT INTO cvs (user_id, language, url, updated_at)
          VALUES ('alice', 'en', 'https://cv.example/alice-en.pdf', 'now'),
            ('alice', 'ru', 'https://cv.example/alice-ru.pdf', 'now'),
            ('bob', 'en', 'https://cv.example/bob-en.pdf', 'now');`);
      assert.throws(() => db.exec("INSERT INTO application_context (user_id, text, updated_at) VALUES ('unknown', 'Unowned', 'now')"), /FOREIGN KEY/u);
      assert.throws(() => db.exec("INSERT INTO cvs (user_id, language, url, updated_at) VALUES ('unknown', 'en', 'https://cv.example/unowned.pdf', 'now')"), /FOREIGN KEY/u);
      assert.throws(() => db.exec("INSERT INTO cvs (user_id, language, url, updated_at) VALUES ('alice', 'EN', 'https://cv.example/duplicate.pdf', 'now')"), /UNIQUE/u);
      assert.throws(() => db.exec(`INSERT INTO stages (user_id, id, job_id, name, created_at, updated_at)
        VALUES ('bob', 'foreign-stage', 'alice-job', 'Cross-user stage', 'now', 'now')`), /FOREIGN KEY/u);
      assert.throws(() => db.exec(`INSERT INTO feedback (user_id, id, stage_id, text, created_at, updated_at)
        VALUES ('bob', 'foreign-feedback', 'alice-stage', 'Cross-user feedback', 'now', 'now')`), /FOREIGN KEY/u);
      assert.throws(() => db.exec(`INSERT INTO jobs (id, company, title, description, created_at, updated_at)
        VALUES ('unowned-job', 'Company', 'Engineer', 'No owner', 'now', 'now')`), /NOT NULL/u);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }
  });

  test("qualified-lead migration preserves existing leads and histories, moves rationale into notes, and removes exclusions", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(await readFile("migrations/0001_initial.sql", "utf8"));
      db.exec(await readFile("migrations/0002_single_criteria.sql", "utf8"));
      db.exec(`INSERT INTO users (id, created_at) VALUES ('alice', 'created'), ('bob', 'created');
        INSERT INTO criteria (user_id, text, updated_at) VALUES ('alice', 'Remote roles', 'saved');
        INSERT INTO jobs (user_id, id, company, title, description, qualification, score, qualification_reason, notes, created_at, updated_at)
          VALUES ('alice', 'qualified', 'Product Co', 'Engineer', 'Remote role', 'qualified', 95, 'Strong fit', 'Recruiter contacted', 'created', 'assessed'),
            ('alice', 'excluded', 'Office Co', 'Engineer', 'Office role', 'excluded', 0, 'Onsite only', NULL, 'created', 'assessed'),
            ('bob', 'legacy-lead', 'New Co', 'Engineer', 'Remote role', 'pending', NULL, NULL, NULL, 'created', 'created');
        INSERT INTO stages (rowid, user_id, id, job_id, name, calendar_event_id, calendar_id, created_at, updated_at)
          VALUES (7, 'alice', 'interview', 'qualified', 'Screening', 'event-id', 'primary', 'created', 'scheduled'),
            (8, 'alice', 'excluded-interview', 'excluded', 'Screening', NULL, NULL, 'created', 'created'),
            (9, 'bob', 'legacy-interview', 'legacy-lead', 'Technical', NULL, NULL, 'created', 'created');
        INSERT INTO feedback (rowid, user_id, id, stage_id, text, created_at, updated_at)
          VALUES (11, 'alice', 'reflection', 'interview', 'Ask about product scope', 'created', 'recorded'),
            (12, 'alice', 'excluded-reflection', 'excluded-interview', 'Old reflection', 'created', 'recorded'),
            (13, 'bob', 'legacy-reflection', 'legacy-interview', 'Follow up', 'created', 'recorded');`);
      const criteria = db.prepare("SELECT * FROM criteria").all();
      const stages = db.prepare("SELECT rowid, * FROM stages WHERE id IS NOT 'excluded-interview' ORDER BY rowid").all();
      const feedback = db.prepare("SELECT rowid, * FROM feedback WHERE id IS NOT 'excluded-reflection' ORDER BY rowid").all();
      db.exec("BEGIN");
      db.exec(await readFile("migrations/0003_qualified_leads.sql", "utf8"));
      db.exec("COMMIT");
      assert.deepEqual(db.prepare("SELECT id, score, notes FROM jobs ORDER BY id").all().map((row) => ({ ...row })), [
        { id: "legacy-lead", score: null, notes: null },
        { id: "qualified", score: 95, notes: "Recruiter contacted\n\nStrong fit" },
      ]);
      assert.deepEqual(db.prepare("SELECT * FROM criteria").all(), criteria);
      assert.deepEqual(db.prepare("SELECT rowid, * FROM stages ORDER BY rowid").all(), stages);
      assert.deepEqual(db.prepare("SELECT rowid, * FROM feedback ORDER BY rowid").all(), feedback);
      db.exec(`INSERT INTO jobs (user_id, id, company, title, description, score, created_at, updated_at)
        VALUES ('alice', 'new-lead', 'New Co', 'Engineer', 'Remote role', 80, 'new', 'new')`);
      assert.throws(() => db.prepare("SELECT qualification FROM jobs"), /no such column/u);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      db.exec("DELETE FROM jobs WHERE id IS 'qualified'");
      assert.deepEqual(db.prepare("SELECT id FROM stages").all().map((row) => row.id), ["legacy-interview"]);
      assert.deepEqual(db.prepare("SELECT id FROM feedback").all().map((row) => row.id), ["legacy-reflection"]);
    } finally {
      db.close();
    }
  });

  test("removes criteria revisions while preserving documents, openings, assessments and child records", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(await readFile("migrations/0001_initial.sql", "utf8"));
      db.exec(`INSERT INTO users (id, created_at) VALUES ('alice', 'created'), ('bob', 'created');
        INSERT INTO criteria (user_id, id, text, revision, updated_at)
          VALUES ('alice', 1, 'Remote product teams', 2, 'changed'), ('bob', 1, 'Onsite roles', 1, 'original');
        INSERT INTO jobs (user_id, id, company, title, description, qualification, score, qualification_reason, criteria_revision, created_at, updated_at)
          VALUES ('alice', 'current', 'Current Co', 'Engineer', 'Remote role', 'qualified', 95, 'Good fit', 2, 'created', 'assessed'),
            ('alice', 'previous', 'Previous Co', 'Engineer', 'Office role', 'excluded', 0, 'Onsite only', 1, 'created', 'assessed'),
            ('bob', 'pending', 'New Co', 'Engineer', 'New role', 'pending', NULL, NULL, NULL, 'created', 'created');
        INSERT INTO stages (rowid, user_id, id, job_id, name, calendar_event_id, calendar_id, created_at, updated_at)
          VALUES (7, 'alice', 'interview', 'previous', 'Screening', 'event-id', 'primary', 'created', 'scheduled');
        INSERT INTO feedback (rowid, user_id, id, stage_id, text, created_at, updated_at)
          VALUES (11, 'alice', 'reflection', 'interview', 'Ask about product scope', 'created', 'recorded');`);
      const jobs = db.prepare(`SELECT rowid, user_id, id, company, title, nickname, description, source_url, location,
        recruiter_name, recruiter_email, notes, status, current_stage, qualification, score,
        qualification_reason, created_at, updated_at FROM jobs ORDER BY id`).all();
      const stages = db.prepare("SELECT rowid, * FROM stages ORDER BY rowid").all();
      const feedback = db.prepare("SELECT rowid, * FROM feedback ORDER BY rowid").all();
      db.exec("BEGIN");
      db.exec(await readFile("migrations/0002_single_criteria.sql", "utf8"));
      db.exec("COMMIT");
      assert.deepEqual(db.prepare("SELECT rowid, * FROM jobs ORDER BY id").all(), jobs);
      assert.deepEqual(db.prepare("SELECT rowid, * FROM stages ORDER BY rowid").all(), stages);
      assert.deepEqual(db.prepare("SELECT rowid, * FROM feedback ORDER BY rowid").all(), feedback);
      assert.deepEqual(db.prepare("SELECT * FROM criteria ORDER BY user_id").all().map((row) => ({ ...row })), [
        { user_id: "alice", text: "Remote product teams", updated_at: "changed" },
        { user_id: "bob", text: "Onsite roles", updated_at: "original" },
      ]);
      assert.throws(() => db.exec("INSERT INTO criteria (user_id, text, updated_at) VALUES ('alice', 'Duplicate', 'later')"), /UNIQUE/u);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      db.exec("DELETE FROM jobs WHERE id IS 'previous'");
      assert.deepEqual(db.prepare("SELECT * FROM stages").all(), []);
      assert.deepEqual(db.prepare("SELECT * FROM feedback").all(), []);
    } finally {
      db.close();
    }
  });
});
