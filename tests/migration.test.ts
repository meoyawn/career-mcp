import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";

describe("Initial user ownership schema", () => {
  test("enforces ownership on parent-child relationships and requires an owner for stored jobs", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(await readFile("migrations/0001_initial.sql", "utf8"));
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
});
