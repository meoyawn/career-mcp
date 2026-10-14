import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";

describe("User ownership schema and criteria migration", () => {
  test("enforces ownership on parent-child relationships and requires an owner for stored jobs", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(await readFile("migrations/0001_initial.sql", "utf8"));
      db.exec(await readFile("migrations/0002_single_criteria.sql", "utf8"));
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
