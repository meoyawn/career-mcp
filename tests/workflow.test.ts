import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import * as v from "valibot";
import { assertion, authorize, browserFor, enroll, exchange } from "./passkey-client.ts";

const execute = promisify(execFile);
const wrangler = resolve("node_modules/wrangler/bin/wrangler.js");
let token: string;
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
    await writeFile(join(directory, ".dev.vars"), "", { mode: 0o600 });
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
    const browser = browserFor(endpoint);
    await enroll(browser);
    token = (await authorize(browser)).token;
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

  test("passkeys verify signatures, reject replays and forged assertions, and sign back into the same account", async () => {
    const browser = browserFor(endpoint);
    const { passkey, response, challengeCookie } = await enroll(browser);
    browser.cookies.set("careers_challenge", challengeCookie);
    assert.equal((await browser.request("/auth/register/verify", response)).status, 401);
    const connection = await authorize(browser);
    const original = new Client({ name: "passkey-user", version: "1" });
    const returning = new Client({ name: "returning-user", version: "1" });
    try {
      await original.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${connection.token}` } } }));
      parseTool(await original.callTool({ name: "set_criteria", arguments: { text: "Returning passkey owner" } }), v.object({ revision: v.number() }));
      assert.equal((await browser.request("/auth/logout", {})).status, 200);
      assert.equal((await browser.request("/authorize/finish", { request: connection.request, allow: true })).status, 401);
      const forged = await assertion(browser, passkey);
      forged.response.signature = Buffer.alloc(64).toString("base64url");
      assert.equal((await browser.request("/auth/login/verify", forged)).status, 401);
      const wrongHandle = await assertion(browser, passkey);
      wrongHandle.response.userHandle = Buffer.from("another-user").toString("base64url");
      assert.equal((await browser.request("/auth/login/verify", wrongHandle)).status, 401);
      const unverified = await assertion(browser, passkey);
      const data = Buffer.from(unverified.response.authenticatorData, "base64url");
      data[32] = 1;
      unverified.response.authenticatorData = data.toString("base64url");
      unverified.response.signature = sign("sha256", Buffer.concat([
        data, createHash("sha256").update(Buffer.from(unverified.response.clientDataJSON, "base64url")).digest(),
      ]), passkey.privateKey).toString("base64url");
      assert.equal((await browser.request("/auth/login/verify", unverified)).status, 401);
      const valid = await assertion(browser, passkey);
      const loginChallenge = browser.cookies.get("careers_challenge");
      assert.ok(loginChallenge);
      const verified = await browser.request("/auth/login/verify", valid);
      assert.equal(verified.status, 200);
      assert.match(verified.headers.getSetCookie().join(";"), /HttpOnly/u);
      browser.cookies.set("careers_challenge", loginChallenge);
      assert.equal((await browser.request("/auth/login/verify", valid)).status, 401);
      const resumed = await authorize(browser);
      await returning.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${resumed.token}` } } }));
      const context = parseTool(await returning.callTool({ name: "get_context", arguments: {} }), v.object({ criteria: v.object({ text: v.string() }) }));
      assert.equal(context.criteria.text, "Returning passkey owner");
      const additional = await enroll(browser);
      assert.equal(additional.passkey.userHandle, passkey.userHandle);
      await browser.request("/auth/logout", {});
      assert.equal((await browser.request("/auth/login/verify", await assertion(browser, additional.passkey))).status, 200);
      for (const path of ["/auth/register/options", "/auth/login/options", "/auth/logout", "/authorize/finish"]) {
        assert.equal((await fetch(new URL(path, endpoint), { method: "POST", headers: { Origin: "https://untrusted.example", "Content-Type": "application/json" }, body: "{}" })).status, 403);
      }
    } finally {
      await Promise.all([original.close(), returning.close()]);
    }
  });

  test("OAuth discovery, consent, PKCE, refresh rotation and revocation protect individual MCP connections", async () => {
    const browser = browserFor(endpoint);
    await enroll(browser);
    const connection = await authorize(browser);
    const challenge = await fetch(endpoint, { method: "POST" });
    assert.equal(challenge.status, 401);
    assert.match(challenge.headers.get("WWW-Authenticate") ?? "", /resource_metadata=/u);
    const resource = v.parse(v.object({ resource: v.string(), authorization_servers: v.array(v.string()) }), await (await browser.request("/.well-known/oauth-protected-resource/mcp")).json());
    assert.equal(resource.resource, endpoint.href);
    assert.deepEqual(resource.authorization_servers, [endpoint.origin]);
    const metadata = v.parse(v.object({ code_challenge_methods_supported: v.array(v.string()) }), await (await browser.request("/.well-known/oauth-authorization-server")).json());
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    assert.equal((await exchange(browser.origin, connection.tokenRequest)).status, 400);
    const allowed = await browser.request("/authorize/finish", { request: connection.request, allow: true });
    const code = new URL(v.parse(v.object({ redirect: v.string() }), await allowed.json()).redirect).searchParams.get("code");
    assert.ok(code);
    assert.equal((await exchange(browser.origin, { ...connection.tokenRequest, code, code_verifier: "x".repeat(43) })).status, 400);
    assert.equal((await exchange(browser.origin, { ...connection.tokenRequest, code, redirect_uri: "https://untrusted.example" })).status, 400);
    assert.equal((await exchange(browser.origin, { ...connection.tokenRequest, code, client_id: crypto.randomUUID() })).status, 400);
    assert.equal((await exchange(browser.origin, { ...connection.tokenRequest, code, resource: "https://untrusted.example/mcp" })).status, 400);
    assert.equal((await exchange(browser.origin, { ...connection.tokenRequest, code })).status, 200);
    assert.equal((await browser.request("/authorize/finish", { request: { ...connection.request, redirect_uri: "https://untrusted.example" }, allow: true })).status, 400);
    assert.equal((await browser.request("/authorize/finish", { request: { ...connection.request, code_challenge_method: "plain" }, allow: true })).status, 400);
    const denied = await browser.request("/authorize/finish", { request: connection.request, allow: false });
    const denial = new URL(v.parse(v.object({ redirect: v.string() }), await denied.json()).redirect);
    assert.equal(denial.searchParams.get("error"), "access_denied");
    assert.equal(denial.searchParams.get("state"), connection.request.state);
    const refreshRequest = { grant_type: "refresh_token", client_id: connection.clientId, refresh_token: connection.refresh };
    const refreshed = await exchange(browser.origin, refreshRequest);
    assert.equal(refreshed.status, 200);
    const tokens = v.parse(v.object({ access_token: v.string(), refresh_token: v.string() }), await refreshed.json());
    assert.notEqual(tokens.access_token, connection.token);
    assert.equal((await exchange(browser.origin, refreshRequest)).status, 400);
    assert.equal((await fetch(endpoint, { headers: { Authorization: `Bearer ${connection.token}` } })).status, 401);
    assert.equal((await fetch(endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 405);
    const revoked = await browser.request("/auth/revoke", {});
    assert.equal(revoked.status, 200);
    assert.equal((await fetch(endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 401);
    assert.equal((await exchange(browser.origin, { ...refreshRequest, refresh_token: tokens.refresh_token })).status, 400);
  });

  test("two users have isolated criteria, jobs, stages, feedback, prompts, resources and calendar drafts in one D1", async () => {
    const aliceBrowser = browserFor(endpoint);
    const bobBrowser = browserFor(endpoint);
    await enroll(aliceBrowser);
    await enroll(bobBrowser);
    const aliceConnection = await authorize(aliceBrowser);
    const bobConnection = await authorize(bobBrowser);
    const alice = new Client({ name: "alice", version: "1" });
    const bob = new Client({ name: "bob", version: "1" });
    async function scoped<Schema extends v.GenericSchema>(owner: Client, name: string, args: Record<string, unknown>, schema: Schema) {
      return parseTool(await owner.callTool({ name, arguments: args }), schema);
    }
    try {
      await alice.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${aliceConnection.token}` } } }));
      await bob.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${bobConnection.token}` } } }));
      await scoped(alice, "set_criteria", { text: "Alice remote roles" }, v.unknown());
      await scoped(alice, "set_criteria", { text: "Alice remote roles revision two" }, v.unknown());
      await scoped(bob, "set_criteria", { text: "Bob onsite roles" }, v.unknown());
      const opening = { company: "Shared company", title: "Engineer", nickname: "shared-role", source_url: "https://jobs.example/shared", description: "A role both users can track" };
      const aliceJob = (await scoped(alice, "add_jobs", { jobs: [opening] }, jobsSchema)).jobs[0];
      const bobJob = (await scoped(bob, "add_jobs", { jobs: [opening] }, jobsSchema)).jobs[0];
      assert.ok(aliceJob && bobJob);
      assert.notEqual(aliceJob.id, bobJob.id);
      const aliceStage = await scoped(alice, "add_stage", { job_id: aliceJob.id, name: "Alice interview", starts_at: "2026-12-01T10:00:00Z", ends_at: "2026-12-01T11:00:00Z" }, stageSchema);
      const bobStage = await scoped(bob, "add_stage", { job_id: bobJob.id, name: "Bob interview", starts_at: "2026-12-01T10:00:00Z", ends_at: "2026-12-01T11:00:00Z" }, stageSchema);
      await scoped(alice, "add_feedback", { stage_id: aliceStage.id, text: "Alice private feedback" }, feedbackOutput);
      const bobFeedback = await scoped(bob, "add_feedback", { stage_id: bobStage.id, text: "Bob private feedback" }, feedbackOutput);
      await scoped(alice, "qualify_jobs", { criteria_revision: 2, decisions: [{ job_id: aliceJob.id, qualification: "qualified", score: 90, reason: "Alice assessment" }] }, jobsSchema);
      await scoped(bob, "qualify_jobs", { criteria_revision: 1, decisions: [{ job_id: bobJob.id, qualification: "qualified", score: 80, reason: "Bob assessment" }] }, jobsSchema);
      for (const [owner, ownJob, ownStage, criteria] of [[alice, aliceJob, aliceStage, "Alice remote roles revision two"], [bob, bobJob, bobStage, "Bob onsite roles"]] as const) {
        const context = await scoped(owner, "get_context", {}, v.object({ criteria: v.object({ text: v.string() }), jobs: v.array(jobSchema) }));
        assert.equal(context.criteria.text, criteria);
        assert.deepEqual(context.jobs.map((job) => job.id), [ownJob.id]);
        assert.deepEqual((await scoped(owner, "list_jobs", { include_descriptions: true, needs_review: false }, jobsSchema)).jobs.map((job) => job.id), [ownJob.id]);
        assert.deepEqual((await scoped(owner, "get_upcoming", { from: "2026-12-01T00:00:00Z" }, v.object({ stages: v.array(stageSchema) }))).stages.map((stage) => stage.id), [ownStage.id]);
        assert.deepEqual((await scoped(owner, "list_feedback", {}, v.object({ feedback: v.array(feedbackOutput) }))).feedback.map((feedback) => feedback.stage_id), [ownStage.id]);
        const detail = await scoped(owner, "get_job", { job_id: ownJob.id }, v.object({ stages: v.array(stageSchema), feedback: v.array(feedbackOutput) }));
        assert.deepEqual(detail.stages.map((stage) => stage.id), [ownStage.id]);
        assert.deepEqual(detail.feedback.map((feedback) => feedback.stage_id), [ownStage.id]);
        const resource = await owner.readResource({ uri: "careers://criteria" });
        const first = resource.contents[0];
        assert.ok(first && "text" in first);
        assert.equal(v.parse(v.object({ text: v.string() }), JSON.parse(first.text)).text, criteria);
      }
      const forbidden = [
        ["get_job", { job_id: bobJob.id }], ["update_job", { job_id: bobJob.id, company: "Stolen" }],
        ["add_stage", { job_id: bobJob.id, name: "Foreign stage" }], ["update_stage", { stage_id: bobStage.id, name: "Foreign round", make_current: true }],
        ["add_feedback", { stage_id: bobStage.id, text: "Foreign feedback" }], ["update_feedback", { feedback_id: bobFeedback.id, text: "Foreign edit" }],
        ["get_calendar_event", { stage_id: bobStage.id }],
        ["qualify_jobs", { criteria_revision: 2, decisions: [
          { job_id: aliceJob.id, qualification: "excluded", score: 0, reason: "Atomic foreign attempt" },
          { job_id: bobJob.id, qualification: "excluded", score: 0, reason: "Foreign assessment" },
        ] }],
      ] as const;
      for (const [name, args] of forbidden) {
        const result = await alice.callTool({ name, arguments: args });
        assert.equal(result.isError, true, name);
        assert.ok(result.content[0]?.type === "text");
        assert.match(result.content[0].text, /not found|do not exist/iu);
      }
      assert.deepEqual((await scoped(alice, "list_feedback", { job_id: bobJob.id }, v.object({ feedback: v.array(feedbackOutput) }))).feedback, []);
      const aliceUnchanged = await scoped(alice, "get_job", { job_id: aliceJob.id }, v.object({ job: jobSchema }));
      assert.equal(aliceUnchanged.job.score, 90);
      const bobUnchanged = await scoped(bob, "get_job", { job_id: bobJob.id }, v.object({ job: jobSchema, stages: v.array(stageSchema), feedback: v.array(feedbackOutput) }));
      assert.equal(bobUnchanged.job.company, opening.company);
      assert.equal(bobUnchanged.job.score, 80);
      assert.equal(bobUnchanged.stages[0]?.name, "Bob interview");
      assert.equal(bobUnchanged.feedback[0]?.text, "Bob private feedback");
      const bobDraft = await scoped(bob, "get_calendar_event", { stage_id: bobStage.id }, v.object({ create_event_args: v.object({ description: v.string() }) }));
      assert.match(bobDraft.create_event_args.description, /Bob interview/u);
      assert.doesNotMatch(bobDraft.create_event_args.description, /Alice|private feedback/u);
      await scoped(alice, "set_criteria", { text: "Alice changed again" }, v.unknown());
      assert.deepEqual((await scoped(bob, "list_jobs", { needs_review: false }, jobsSchema)).jobs.map((job) => job.id), [bobJob.id]);
      const prompt = await alice.getPrompt({ name: "rank_jobs", arguments: { limit: "25", offset: "0" } });
      assert.ok(prompt.messages[0]?.content.type === "text");
      assert.match(prompt.messages[0].content.text, new RegExp(aliceJob.id, "u"));
      assert.doesNotMatch(prompt.messages[0].content.text, new RegExp(bobJob.id, "u"));
      const spoofed = await alice.callTool({ name: "get_context", arguments: { user_id: "another-user" } });
      assert.equal(spoofed.isError, true);
      assert.equal((await aliceBrowser.request("/auth/revoke", {})).status, 200);
      assert.equal((await fetch(endpoint, { headers: { Authorization: `Bearer ${aliceConnection.token}` } })).status, 401);
      assert.equal((await scoped(bob, "get_context", {}, v.object({ criteria: v.object({ text: v.string() }) }))).criteria.text, "Bob onsite roles");
    } finally {
      await Promise.all([alice.close(), bob.close()]);
    }
  });
});
