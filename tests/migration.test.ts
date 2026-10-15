import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";

describe("User ownership schema and lead migrations", () => {
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
