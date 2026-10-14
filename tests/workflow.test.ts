import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import * as v from "valibot";

const execute = promisify(execFile);
const wrangler = resolve("node_modules/wrangler/bin/wrangler.js");
const token = crypto.randomUUID();
const jobSchema = v.object({
  id: v.string(), company: v.string(), title: v.string(), nickname: v.nullable(v.string()),
  current_stage: v.string(), status: v.string(), qualification: v.string(), score: v.nullable(v.number()),
});
const jobsSchema = v.object({ jobs: v.array(jobSchema), next_offset: v.optional(v.nullable(v.number())) });
const stageSchema = v.object({
  id: v.string(), job_id: v.string(), name: v.string(), status: v.string(),
  starts_at: v.nullable(v.string()), ends_at: v.nullable(v.string()), timezone: v.nullable(v.string()),
  calendar_event_id: v.nullable(v.string()), calendar_id: v.nullable(v.string()),
});
const feedbackOutput = v.object({ id: v.string(), stage_id: v.string(), text: v.string(), source: v.string() });
let directory: string;
let worker: ChildProcess | undefined;
let client: Client;
let endpoint: URL;

function parseTool<Schema extends v.GenericSchema>(result: CallToolResult, schema: Schema): v.InferOutput<Schema> {
  assert.ok(!result.isError, JSON.stringify(result.content));
  assert.ok(result.content[0]?.type === "text");
  return v.parse(schema, JSON.parse(result.content[0].text));
}

async function call<Schema extends v.GenericSchema>(name: string, args: Record<string, unknown>, schema: Schema) {
  return parseTool(await client.callTool({ name, arguments: args }), schema);
}

async function error(name: string, args: Record<string, unknown>, message: RegExp) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true);
  assert.ok(result.content[0]?.type === "text");
  assert.match(result.content[0].text, message);
}

describe("Careers MCP through a real local Worker and D1", { concurrency: false }, () => {
  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "careers-mcp-"));
    const config: Record<string, unknown> = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
    const testConfig = join(directory, "wrangler.json");
    await writeFile(testConfig, JSON.stringify({
      ...config,
      main: resolve("src/index.ts"),
      d1_databases: [{ binding: "DB", database_name: "careers", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: resolve("migrations") }],
    }));
    await writeFile(join(directory, ".dev.vars"), `MCP_AUTH_TOKEN=${token}\n`, { mode: 0o600 });
    const environment = { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" };
    await execute(process.execPath, [wrangler, "d1", "migrations", "apply", "careers", "--local", "--config", testConfig, "--persist-to", directory], { env: environment });
    worker = spawn(process.execPath, [wrangler, "dev", "--local", "--port", "0", "--inspector-port", "0", "--config", testConfig, "--persist-to", directory], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    function capture(chunk: Buffer) { output += chunk.toString(); }
    worker.stdout?.on("data", capture);
    worker.stderr?.on("data", capture);
    for (let attempt = 0; attempt < 200; attempt++) {
      const match = output.match(/Ready on (http:\/\/(?:localhost|127\.0\.0\.1):\d+)/u);
      if (match?.[1]) { endpoint = new URL("/mcp", match[1]); break; }
      if (worker.exitCode !== null) throw new Error(`Worker exited during startup:\n${output}`);
      await setTimeout(100);
    }
    assert.ok(endpoint, `Worker never became ready:\n${output}`);
    client = new Client({ name: "workflow-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  }, { timeout: 30_000 });

  after(async () => {
    if (client) await client.close();
    if (worker && worker.exitCode === null) {
      const exited = once(worker, "exit");
      worker.kill("SIGTERM");
      await exited;
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test("HTTP authentication and origin checks protect MCP, and modern clients can also call tools", async () => {
    assert.equal((await fetch(endpoint, { method: "POST" })).status, 401);
    assert.equal((await fetch(endpoint, { method: "POST", headers: { Authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: "https://untrusted.example" } })).status, 403);
    assert.equal((await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } })).status, 405);
    const modern = new Client({ name: "modern-test", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    try {
      await modern.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      assert.equal(parseTool(await modern.callTool({ name: "get_context", arguments: {} }), v.object({ criteria: v.null() })).criteria, null);
    } finally {
      await modern.close();
    }
  });

  test("criteria reach agent context, rankings persist, stale decisions fail, and editing an opening resets its assessment", async () => {
    const criteria = await call("set_criteria", { text: "Remote TypeScript roles. Exclude onsite-only work." }, v.object({ revision: v.number(), text: v.string() }));
    const imported = await call("add_jobs", { jobs: [
      { company: "Google", title: "TypeScript engineer", nickname: "google-ts", description: "Remote TypeScript platform work" },
      { company: "Microsoft", title: "Backend engineer", description: "Remote backend work" },
      { company: "Facebook", title: "Office engineer", description: "Onsite only" },
    ] }, jobsSchema);
    assert.equal(imported.jobs.length, 3);
    const google = imported.jobs.find((job) => job.company === "Google");
    const microsoft = imported.jobs.find((job) => job.company === "Microsoft");
    const facebook = imported.jobs.find((job) => job.company === "Facebook");
    assert.ok(google && microsoft && facebook);
    const context = await call("get_context", {}, v.object({ criteria: v.object({ text: v.string(), revision: v.number() }) }));
    assert.deepEqual(context.criteria, criteria);
    const resource = await client.readResource({ uri: "careers://criteria" });
    assert.ok(resource.contents[0] && "text" in resource.contents[0]);
    assert.match(resource.contents[0].text, /Remote TypeScript roles/u);
    const prompt = await client.getPrompt({ name: "rank_jobs" });
    assert.ok(prompt.messages[0]?.content.type === "text");
    assert.match(prompt.messages[0].content.text, /Remote TypeScript platform work/u);
    await call("qualify_jobs", { criteria_revision: criteria.revision, decisions: [
      { job_id: google.id, qualification: "qualified", score: 95, reason: "Remote and exact stack match" },
      { job_id: microsoft.id, qualification: "qualified", score: 70, reason: "Remote with less stack overlap" },
      { job_id: facebook.id, qualification: "excluded", score: 0, reason: "Onsite-only fails the criteria" },
    ] }, jobsSchema);
    const ranked = await call("list_jobs", { qualification: "qualified", limit: 1 }, jobsSchema);
    assert.equal(ranked.jobs[0]?.id, google.id);
    assert.equal(ranked.next_offset, 1);
    assert.equal((await call("list_jobs", { qualification: "qualified", limit: 1, offset: 1 }, jobsSchema)).jobs[0]?.id, microsoft.id);
    const changed = await call("set_criteria", { text: "Remote TypeScript roles, prefer product teams." }, v.object({ revision: v.number() }));
    assert.equal(changed.revision, criteria.revision + 1);
    assert.equal((await call("list_jobs", { needs_review: true }, jobsSchema)).jobs.length, 3);
    await error("qualify_jobs", { criteria_revision: criteria.revision, decisions: [{ job_id: google.id, qualification: "qualified", score: 100, reason: "Old criteria" }] }, /Criteria changed/u);
    const updated = await call("update_job", { job_id: google.id, description: "Now an onsite-only role" }, jobSchema);
    assert.equal(updated.qualification, "pending");
    assert.equal(updated.score, null);
  });

  test("concurrent applications keep independent stages, failures, optional feedback, and corrected voice transcriptions", async () => {
    const imported = await call("add_jobs", { jobs: [
      { company: "Track A", title: "Engineer", description: "Role A" },
      { company: "Track B", title: "Engineer", description: "Role B" },
    ] }, jobsSchema);
    assert.ok(imported.jobs[0] && imported.jobs[1]);
    const [screening, technical] = await Promise.all([
      call("add_stage", { job_id: imported.jobs[0].id, name: "HR screening", status: "completed" }, stageSchema),
      call("add_stage", { job_id: imported.jobs[1].id, name: "System design", status: "in_progress" }, stageSchema),
    ]);
    await call("update_stage", { stage_id: technical.id, status: "failed" }, stageSchema);
    const reflection = "I rushed the trade-offs. Next time ask about scale first.";
    const feedback = await call("add_feedback", { stage_id: technical.id, text: reflection }, feedbackOutput);
    assert.equal(feedback.text, reflection);
    await call("update_feedback", { feedback_id: feedback.id, text: "I rushed the tradeoffs. Ask about scale first." }, feedbackOutput);
    await call("update_job", { job_id: imported.jobs[1].id, status: "rejected" }, jobSchema);
    const a = await call("get_job", { job_id: imported.jobs[0].id }, v.object({ job: jobSchema, feedback: v.array(feedbackOutput) }));
    const b = await call("get_job", { job_id: imported.jobs[1].id }, v.object({ job: jobSchema, stages: v.array(stageSchema), feedback: v.array(feedbackOutput) }));
    assert.equal(a.job.current_stage, screening.name);
    assert.equal(a.job.status, "active");
    assert.deepEqual(a.feedback, []);
    assert.equal(b.job.current_stage, technical.name);
    assert.equal(b.job.status, "rejected");
    assert.equal(b.stages[0]?.status, "failed");
    assert.equal(b.feedback[0]?.text, "I rushed the tradeoffs. Ask about scale first.");
    const history = await call("list_feedback", { stage_name: "system design" }, v.object({ feedback: v.array(feedbackOutput) }));
    assert.equal(history.feedback[0]?.id, feedback.id);
  });

  test("UTC scheduling produces Google Calendar arguments and retains event IDs for rescheduling and cancellation", async () => {
    const imported = await call("add_jobs", { jobs: [{ company: "Calendar Co", title: "Engineer", description: "Remote", notes: "Private salary target" }] }, jobsSchema);
    assert.ok(imported.jobs[0]);
    const stage = await call("add_stage", {
      job_id: imported.jobs[0].id, name: "Technical interview",
      starts_at: "2026-11-02T09:00:00-08:00", ends_at: "2026-11-02T10:00:00-08:00",
      timezone: "America/Los_Angeles", location: "https://meet.google.com/example",
      contact_email: "recruiter@example.com", notes: "Private prep notes",
    }, stageSchema);
    assert.equal(stage.starts_at, "2026-11-02T17:00:00.000Z");
    assert.equal(stage.ends_at, "2026-11-02T18:00:00.000Z");
    const calendarSchema = v.object({
      suggested_action: v.string(), missing_fields: v.array(v.string()),
      create_event_args: v.nullable(v.object({
        title: v.string(), start_time: v.string(), end_time: v.string(), timezone_str: v.string(),
        calendar_id: v.string(), attendees: v.array(v.string()), description: v.string(),
      })),
      update_event_args: v.nullable(v.object({ event_id: v.string(), calendar_id: v.string(), start_time: v.string() })),
      delete_event_args: v.nullable(v.object({ event_id: v.string(), calendar_id: v.string() })),
    });
    const draft = await call("get_calendar_event", { stage_id: stage.id }, calendarSchema);
    assert.equal(draft.suggested_action, "create");
    assert.deepEqual(draft.missing_fields, []);
    assert.ok(draft.create_event_args);
    assert.equal(draft.create_event_args.start_time, stage.starts_at);
    assert.equal(draft.create_event_args.end_time, stage.ends_at);
    assert.equal(draft.create_event_args.timezone_str, "UTC");
    assert.equal(draft.create_event_args.calendar_id, "primary");
    assert.deepEqual(draft.create_event_args.attendees, []);
    assert.match(draft.create_event_args.description, new RegExp(stage.id, "u"));
    assert.doesNotMatch(draft.create_event_args.description, /Private|salary/u);
    await call("update_stage", { stage_id: stage.id, calendar_id: "primary", calendar_event_id: "google-event-123" }, stageSchema);
    await call("update_stage", { stage_id: stage.id, starts_at: "2026-11-02T18:30:00Z", ends_at: "2026-11-02T19:30:00Z" }, stageSchema);
    const rescheduled = await call("get_calendar_event", { stage_id: stage.id }, calendarSchema);
    assert.equal(rescheduled.suggested_action, "update");
    assert.equal(rescheduled.update_event_args?.event_id, "google-event-123");
    assert.equal(rescheduled.update_event_args?.start_time, "2026-11-02T18:30:00.000Z");
    assert.equal(rescheduled.create_event_args, null);
    await error("get_calendar_event", { stage_id: stage.id, calendar_id: "another-calendar" }, /different calendar/u);
    const upcoming = await call("get_upcoming", { from: "2026-11-02T18:30:00Z", to: "2026-11-02T20:00:00Z" }, v.object({ stages: v.array(stageSchema) }));
    assert.equal(upcoming.stages[0]?.id, stage.id);
    await call("update_stage", { stage_id: stage.id, status: "cancelled" }, stageSchema);
    const cancelled = await call("get_calendar_event", { stage_id: stage.id }, calendarSchema);
    assert.deepEqual(cancelled.delete_event_args, { calendar_id: "primary", event_id: "google-event-123" });
    assert.deepEqual((await call("get_upcoming", { from: "2026-11-02T00:00:00Z" }, v.object({ stages: v.array(stageSchema) }))).stages, []);
    await call("update_stage", { stage_id: stage.id, calendar_id: null, calendar_event_id: null }, stageSchema);
  });

  test("invalid input and duplicate imports leave D1 unchanged; incomplete calendar details are reported", async () => {
    await error("add_jobs", { jobs: [{ company: " ", title: "Engineer", description: "Role" }] }, /non-blank/u);
    await error("add_jobs", { jobs: [{ company: "Unknown-key Co", title: "Engineer", description: "Role", ignored_typo: true }] }, /ignored_typo|Invalid key/u);
    const imported = await call("add_jobs", { jobs: [{ company: "Validation Co", title: "Engineer", description: "Role", nickname: "unique-role" }] }, jobsSchema);
    assert.ok(imported.jobs[0]);
    await error("add_jobs", { jobs: [
      { company: "Atomic rollback", title: "Engineer", description: "Role" },
      { company: "Duplicate", title: "Engineer", description: "Role", nickname: "UNIQUE-ROLE" },
    ] }, /already exists/u);
    assert.deepEqual((await call("list_jobs", { query: "Atomic rollback" }, jobsSchema)).jobs, []);
    await error("add_stage", { job_id: imported.jobs[0].id, name: "Invalid time", starts_at: "2026-11-02T10:00:00" }, /timestamp/u);
    await error("add_stage", { job_id: imported.jobs[0].id, name: "Invalid date", starts_at: "2026-02-30T10:00:00Z" }, /impossible/u);
    await error("add_stage", { job_id: imported.jobs[0].id, name: "Backwards", starts_at: "2026-11-02T10:00:00Z", ends_at: "2026-11-02T09:00:00Z" }, /later/u);
    const stage = await call("add_stage", { job_id: imported.jobs[0].id, name: "Screening", starts_at: "2026-11-03T10:00:00Z" }, stageSchema);
    assert.equal(stage.timezone, "UTC");
    const draft = await call("get_calendar_event", { stage_id: stage.id }, v.object({ missing_fields: v.array(v.string()), create_event_args: v.null() }));
    assert.deepEqual(draft.missing_fields, ["ends_at"]);
    await error("update_stage", { stage_id: stage.id, calendar_event_id: "orphan-event" }, /calendar_id/u);
    await error("update_job", { job_id: imported.jobs[0].id }, /at least one/u);
    await error("add_feedback", { stage_id: crypto.randomUUID(), text: "Unattached feedback" }, /Stage not found/u);
    const untouched = await call("get_job", { job_id: imported.jobs[0].id }, v.object({ stages: v.array(stageSchema), feedback: v.array(feedbackOutput) }));
    assert.equal(untouched.stages.length, 1);
    assert.deepEqual(untouched.feedback, []);
  });
});
