import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify, stripVTControlCharacters } from "node:util";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import * as v from "valibot";
import { addJobs } from "../src/store.ts";
import { assertion, authorize, browserFor, enroll, exchange } from "./passkey-client.ts";

const execute = promisify(execFile);
const wrangler = resolve("node_modules/wrangler/bin/wrangler.js");
let token: string;
const jobSchema = v.object({
  id: v.string(), company: v.string(), title: v.nullable(v.string()), nickname: v.nullable(v.string()),
  current_stage: v.string(), status: v.string(), score: v.nullable(v.number()),
  source_url: v.nullable(v.string()), created_at: v.pipe(v.string(), v.isoTimestamp(), v.regex(/Z$/u)),
});
const jobsSchema = v.object({ jobs: v.array(jobSchema), next_offset: v.optional(v.nullable(v.number())) });
const stageSchema = v.object({
  id: v.string(), job_id: v.string(), name: v.string(), status: v.string(),
  starts_at: v.nullable(v.string()), ends_at: v.nullable(v.string()), timezone: v.nullable(v.string()),
  calendar_event_id: v.nullable(v.string()), calendar_id: v.nullable(v.string()),
});
const feedbackOutput = v.object({ id: v.string(), stage_id: v.string(), text: v.string(), source: v.string() });
const contactOutput = v.object({ id: v.string(), job_id: v.string(), name: v.string(), relationship: v.string(), url: v.nullable(v.string()) });
const outreachOutput = v.object({
  id: v.string(), contact_id: v.string(), stage_id: v.nullable(v.string()), direction: v.string(),
  occurred_at: v.string(), time_basis: v.string(), follow_up_at: v.nullable(v.string()), follow_up_status: v.nullable(v.string()),
  created_at: v.string(), updated_at: v.string(),
});
const outreachHistory = {
  contacts: v.array(contactOutput), outreach: v.array(outreachOutput), last_outreach_at: v.nullable(v.string()), last_response_at: v.nullable(v.string()),
};
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

async function verifiedOpening(company: string, owner: Client = client) {
  const { criteria } = parseTool(await owner.callTool({ name: "get_lead_context", arguments: {} }),
    v.object({ criteria: v.nullable(v.object({ updated_at: v.string() })) }));
  return {
    title: "TypeScript product engineer", description: "Build TypeScript developer tools for EMEA customers.",
    source_url: `https://jobs.example/${encodeURIComponent(company)}`, location: "Remote EMEA",
    status: "open", eligibility: "eligible", checked_at: new Date().toISOString(),
    criteria_updated_at: criteria?.updated_at ?? new Date().toISOString(), eligibility_reason: "Live EMEA product engineering role passes the current hard exclusions.",
  };
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
    // Exercise startup with the terminal formatting used by interactive deployments.
    const environment = {
      ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false",
      FORCE_COLOR: "1", TERM: "xterm-256color", NO_COLOR: undefined, NODE_DISABLE_COLORS: undefined,
    };
    await execute(process.execPath, [wrangler, "d1", "migrations", "apply", "careers", "--local", "--config", testConfig, "--persist-to", directory], { env: environment });
    worker = spawn(process.execPath, [wrangler, "dev", "--local", "--port", "0", "--inspector-port", "0", "--config", testConfig, "--persist-to", directory], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    function capture(chunk: Buffer) { output += chunk.toString(); }
    worker.stdout?.on("data", capture);
    worker.stderr?.on("data", capture);
    for (let attempt = 0; attempt < 200; attempt++) {
      const match = stripVTControlCharacters(output).match(/Ready on (http:\/\/(?:localhost|127\.0\.0\.1):\d+)/u);
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

  test("HTTP authentication and origin checks protect MCP, and legacy and modern clients discover and call tools", async () => {
    assert.equal((await fetch(endpoint, { method: "POST" })).status, 401);
    assert.equal((await fetch(endpoint, { method: "POST", headers: { Authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: "https://untrusted.example" } })).status, 403);
    assert.equal((await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } })).status, 405);
    for (const mode of ["legacy", { pin: "2026-07-28" }] as const) {
      const connection = new Client({ name: "discovery-test", version: "1.0.0" }, { versionNegotiation: { mode } });
      try {
        await connection.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
        const { tools } = await connection.listTools();
        assert.ok(tools.some((tool) => tool.name === "set_criteria" && tool.inputSchema.type === "object"));
        const { prompts } = await connection.listPrompts();
        assert.ok(prompts.some((prompt) => prompt.name === "rank_jobs" && prompt.arguments?.some((argument) => argument.name === "limit")));
        assert.equal(parseTool(await connection.callTool({ name: "get_lead_context", arguments: {} }), v.object({ criteria: v.null() })).criteria, null);
      } finally {
        await connection.close();
      }
    }
  });

  test("all job imports require current criteria and opening evidence, while criteria edits preserve histories and ranking", async () => {
    const criteriaOutput = v.strictObject({ user_id: v.string(), text: v.string(), updated_at: v.string() });
    const opening = { phase: "application", company: "Google", eligible_opening: await verifiedOpening("Google"), title: "TypeScript engineer", nickname: "google-ts", description: "Remote TypeScript platform work", source_url: "https://jobs.example/google" };
    assert.equal((await call("get_lead_context", {}, v.object({ criteria: v.null() }))).criteria, null);
    await error("add_job", { ...opening, eligible_opening: await verifiedOpening("Google") }, /criteria/u);
    await call("set_criteria", { text: "Remote TypeScript product engineering roles." }, criteriaOutput);
    const importStartedAt = Date.now();
    const google = await call("add_job", { ...opening, eligible_opening: await verifiedOpening("Google"), score: 95 }, jobSchema);
    const firstBatch = await call("add_jobs", { jobs: [
      { phase: "application", company: "Google", eligible_opening: await verifiedOpening("Google"), title: "Backend engineer", nickname: "google-backend", description: "Remote backend work", score: 70, source_url: "http://jobs.example/google-backend" },
    ] }, jobsSchema);
    assert.equal((await call("list_jobs", {}, jobsSchema)).jobs.length, 2);
    const text = "\n# Job selection criteria\r\n\r\n- Remote TypeScript roles.\r\n- Exclude onsite-only work.\r\n\r\n## Ranking\nPrefer product teams; score stack fit from 0–100.\nПродуктовые команды в приоритете.\n ";
    const { tools } = await client.listTools();
    const criteriaTool = tools.find((tool) => tool.name === "set_criteria");
    assert.ok(criteriaTool);
    const { properties: { text: { pattern } } } = v.parse(v.object({
      properties: v.object({ text: v.object({ pattern: v.string() }) }),
    }), criteriaTool.inputSchema);
    for (const document of ["Remote TypeScript roles.", text, " \tX\n", "x".repeat(20_000)]) {
      // Some MCP clients require patterns to match the entire argument.
      assert.equal(new RegExp(pattern).exec(document)?.[0], document);
    }
    for (const blank of ["", " \t\r\n", "\u00a0\u2003"]) {
      assert.equal(new RegExp(pattern).exec(blank), null);
    }
    for (const name of ["add_job", "add_jobs", "update_job"]) {
      const sourceTool = tools.find((tool) => tool.name === name);
      assert.ok(sourceTool);
      const schema = name === "add_jobs"
        ? v.parse(v.object({ properties: v.object({ jobs: v.object({ items: v.record(v.string(), v.unknown()) }) }) }), sourceTool.inputSchema).properties.jobs.items
        : sourceTool.inputSchema;
      const { properties: { source_url: sourceSchema } } = v.parse(v.object({
        properties: v.object({ source_url: v.record(v.string(), v.unknown()) }),
      }), schema);
      const variants = Array.isArray(sourceSchema.anyOf) ? sourceSchema.anyOf : [sourceSchema];
      const patternSchema = v.object({ type: v.literal("string"), pattern: v.string() });
      const { pattern: urlPattern } = v.parse(patternSchema, variants.find((variant) => v.is(patternSchema, variant)));
      for (const sourceUrl of [opening.source_url, "http://jobs.example/engineer?team=tools#apply"]) {
        assert.equal(new RegExp(urlPattern).exec(sourceUrl)?.[0], sourceUrl);
      }
      assert.equal(new RegExp(urlPattern).exec("ftp://jobs.example/engineer"), null);
    }
    const criteria = await call("set_criteria", { text }, criteriaOutput);
    assert.equal(criteria.text, text);
    await error("set_criteria", { text: " \t\r\n" }, /non-blank/u);
    await error("set_criteria", { text: "x".repeat(20_001) }, /length|characters/u);
    assert.equal(google.current_stage, "applied");
    assert.equal(google.score, 95);
    assert.equal(google.source_url, opening.source_url);
    const imported = await call("add_jobs", { jobs: [
      { phase: "application", company: "New Co", eligible_opening: await verifiedOpening("New Co"), title: "Onsite engineer", description: "Onsite-only product work explicitly supplied by the user" },
    ] }, jobsSchema);
    assert.equal(imported.jobs.length, 1);
    const backend = firstBatch.jobs.find((job) => job.title === "Backend engineer");
    assert.ok(backend);
    assert.equal(backend.source_url, "http://jobs.example/google-backend");
    const importFinishedAt = Date.now();
    for (const job of [google, ...firstBatch.jobs, ...imported.jobs]) {
      assert.ok(Date.parse(job.created_at) >= importStartedAt && Date.parse(job.created_at) <= importFinishedAt);
    }
    assert.equal(imported.jobs.find((job) => job.company === "New Co")?.score, null);
    const context = await call("get_lead_context", {}, v.object({ criteria: criteriaOutput }));
    assert.deepEqual(context.criteria, criteria);
    const resource = await client.readResource({ uri: "careers://criteria" });
    assert.ok(resource.contents[0] && "text" in resource.contents[0]);
    assert.deepEqual(v.parse(criteriaOutput, JSON.parse(resource.contents[0].text)), criteria);
    const prompt = await client.getPrompt({ name: "rank_jobs" });
    assert.ok(prompt.messages[0]?.content.type === "text");
    assert.match(prompt.messages[0].content.text, /Remote TypeScript platform work/u);
    const ranked = await call("list_jobs", { limit: 1 }, v.strictObject(jobsSchema.entries));
    assert.equal(ranked.jobs[0]?.id, google.id);
    assert.equal(ranked.jobs[0]?.created_at, google.created_at);
    assert.equal(ranked.next_offset, 1);
    assert.equal((await call("list_jobs", { limit: 1, offset: 1 }, jobsSchema)).jobs[0]?.id, backend.id);
    await call("set_criteria", { text }, criteriaOutput);
    const openingsOutput = v.object({ jobs: v.array(v.record(v.string(), v.unknown())), next_offset: v.null() });
    const openingsBefore = await call("list_jobs", { include_descriptions: true }, openingsOutput);
    for (const job of openingsBefore.jobs) {
      assert.equal(job.status, "active");
      for (const field of ["qualification", "qualification_reason", "needs_review"]) assert.equal(Object.hasOwn(job, field), false);
    }
    const changed = await call("set_criteria", { text: "Remote TypeScript roles, prefer product teams." }, criteriaOutput);
    assert.equal(changed.text, "Remote TypeScript roles, prefer product teams.");
    assert.deepEqual((await call("get_lead_context", {}, v.object({ criteria: criteriaOutput }))).criteria, changed);
    assert.deepEqual(await call("list_jobs", { include_descriptions: true }, openingsOutput), openingsBefore);
    await call("update_job", { job_id: google.id, score: 100, notes: "Best match for the current criteria" }, jobSchema);
    assert.equal((await call("list_jobs", {}, jobsSchema)).jobs.length, 3);
    const updated = await call("update_job", { job_id: google.id, description: "Remote TypeScript product role" }, jobSchema);
    assert.equal(updated.score, null);
    assert.equal(updated.created_at, google.created_at);
    const reranked = await call("update_job", { job_id: google.id, title: "Senior TypeScript engineer", score: 98 }, jobSchema);
    assert.equal(reranked.score, 98);
  });

  test("salary asks persist independently of employer budgets and appear in the active pipeline with explicit units and unknowns", async () => {
    const askFields = {
      salary_ask_amount: v.nullable(v.number()), salary_ask_currency: v.nullable(v.string()),
      salary_ask_period: v.nullable(v.string()), salary_ask_basis: v.nullable(v.string()),
    };
    const row = v.object({ ...jobSchema.entries, ...askFields,
      salary_min: v.nullable(v.number()), salary_max: v.nullable(v.number()),
      salary_currency: v.nullable(v.string()), salary_period: v.nullable(v.string()),
    });
    const ask = { salary_ask_amount: 5_500, salary_ask_currency: "EUR", salary_ask_period: "month", salary_ask_basis: "gross" };
    const unknown = { salary_ask_amount: null, salary_ask_currency: null, salary_ask_period: null, salary_ask_basis: null };
    const budget = { salary_min: 100_000, salary_max: 120_000, salary_currency: "USD", salary_period: "year" };
    const imported = await call("add_jobs", { jobs: [
      { company: "Salary ask employer", phase: "application", eligible_opening: await verifiedOpening("Salary ask employer"), score: 90, ...budget, ...ask },
      { company: "Salary ask unknown", phase: "application", eligible_opening: await verifiedOpening("Salary ask unknown"), ...budget },
    ] }, v.object({ jobs: v.array(row) }));
    const asked = imported.jobs[0];
    const unasked = imported.jobs[1];
    assert.ok(asked && unasked);
    const projection = v.object(askFields);
    const pipeline = v.object({ applications: v.array(v.object({ id: v.string(), ...askFields,
      salary_min: v.nullable(v.number()), salary_max: v.nullable(v.number()),
      salary_currency: v.nullable(v.string()), salary_period: v.nullable(v.string()),
    })) });
    assert.deepEqual(v.parse(projection, asked), ask);
    assert.deepEqual(v.parse(projection, unasked), unknown);
    const active = await call("get_pipeline", {}, pipeline);
    assert.deepEqual(active.applications.find((job) => job.id === asked.id), { id: asked.id, ...budget, ...ask });
    assert.deepEqual(active.applications.find((job) => job.id === unasked.id), { id: unasked.id, ...budget, ...unknown });
    assert.deepEqual(v.parse(projection, (await call("get_job", { job_id: asked.id }, v.object({ job: row }))).job), ask);
    const listed = await call("list_jobs", { query: "Salary ask employer" }, v.object({ jobs: v.array(row) }));
    assert.deepEqual(v.parse(projection, listed.jobs[0]), ask);
    for (const invalid of [
      { salary_ask_amount: -1 }, { salary_ask_amount: null }, { salary_ask_currency: null },
      { salary_ask_currency: "eur" }, { salary_ask_period: null }, { salary_ask_period: "never" }, { salary_ask_basis: "unknown" },
    ]) await error("update_job", { job_id: asked.id, ...invalid }, /salary_ask|Salary ask|Invalid/u);
    assert.deepEqual(v.parse(projection, (await call("get_job", { job_id: asked.id }, v.object({ job: row }))).job), ask);
    const changed = await call("update_job", { job_id: asked.id, salary_ask_amount: 70_000,
      salary_ask_currency: "USD", salary_ask_period: "year", salary_ask_basis: "net" }, row);
    assert.deepEqual(v.parse(projection, changed), { salary_ask_amount: 70_000, salary_ask_currency: "USD", salary_ask_period: "year", salary_ask_basis: "net" });
    assert.equal(changed.score, asked.score);
    assert.equal(changed.created_at, asked.created_at);
    assert.equal(changed.salary_min, budget.salary_min);
    const unspecifiedBasis = await call("update_job", { job_id: asked.id, salary_ask_basis: null }, row);
    assert.equal(unspecifiedBasis.salary_ask_basis, null);
    await call("update_job", { job_id: asked.id, ...unknown }, row);
    assert.deepEqual(v.parse(projection, (await call("get_pipeline", {}, pipeline)).applications.find((job) => job.id === asked.id)), unknown);
    await error("add_jobs", { jobs: [{ company: "Salary ask atomic rollback", phase: "application", eligible_opening: await verifiedOpening("Salary ask atomic rollback") },
      { company: "Salary ask invalid", phase: "application", eligible_opening: await verifiedOpening("Salary ask invalid"), salary_ask_amount: 5_500 }] }, /Salary ask/u);
    assert.deepEqual((await call("list_jobs", { query: "Salary ask atomic rollback" }, jobsSchema)).jobs, []);
  });

  test("lead intake rejects missing, closed, excluded, unverified and stale openings atomically", async () => {
    const opening = await verifiedOpening("No opening");
    await error("add_job", { company: "No opening employer" }, /eligible opening/u);
    await error("add_job", { company: "No opening application", phase: "application" }, /eligible opening/u);
    await error("add_jobs", { jobs: [{ company: "No opening batch" }] }, /eligible opening/u);
    for (const invalid of [
      { status: "closed" }, { status: "unknown" }, { eligibility: "excluded" }, { eligibility: "unknown" },
      { source_url: "" }, { description: "" }, { location: " " }, { eligibility_reason: " " },
      { criteria_updated_at: "2000-01-01T00:00:00.000Z" },
      { checked_at: new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString() },
      { checked_at: "2099-01-01T00:00:00.000Z" },
    ]) await error("add_job", { company: "No opening invalid", eligible_opening: { ...opening, ...invalid } }, /Invalid|length|characters|non-blank|criteria|24 hours/u);
    await error("add_jobs", { jobs: [
      { company: "No opening rollback", eligible_opening: opening }, { company: "No opening invalid" },
    ] }, /0 of 2 records saved.*Record 2:.*eligible opening/u);
    assert.deepEqual((await call("list_jobs", { query: "No opening" }, jobsSchema)).jobs, []);
    await call("set_criteria", { text: "Updated remote TypeScript product roles, exclude onsite work." }, v.unknown());
    await error("add_job", { company: "No opening stale criteria", eligible_opening: opening }, /outdated criteria/u);
  });

  test("eligible leads retain proof and salary, and employer changes, reactivation and returns to leads require fresh proof", async () => {
    const detailSchema = v.object({ job: v.object({ ...jobSchema.entries, phase: v.string(), description: v.nullable(v.string()), location: v.nullable(v.string()) }) });
    const eligibleOpening = await verifiedOpening("Employer only");
    const lead = await call("add_job", { company: "Employer only", eligible_opening: eligibleOpening, company_url: "https://employer.example/careers",
      salary_min: 120_000, salary_max: 160_000, salary_currency: "USD", salary_period: "year" }, jobSchema);
    assert.equal(lead.title, null);
    const salarySchema = v.object({ job: v.object({ salary_min: v.nullable(v.number()), salary_max: v.nullable(v.number()), salary_currency: v.nullable(v.string()), salary_period: v.nullable(v.string()) }) });
    const salary = { salary_min: 120_000, salary_max: 160_000, salary_currency: "USD", salary_period: "year" };
    assert.deepEqual((await call("get_job", { job_id: lead.id }, salarySchema)).job, salary);
    for (const invalid of [{ salary_min: 200_000 }, { salary_currency: null }, { salary_period: null }, { salary_min: -1 }]) {
      const result = await client.callTool({ name: "update_job", arguments: { job_id: lead.id, ...invalid } });
      assert.equal(result.isError, true);
    }
    const fields = { title: "Engineer", description: "An opening", source_url: "https://jobs.example/employer", location: "Remote" };
    for (const [key, value] of Object.entries(fields)) {
      await error("add_job", { company: `Forbidden ${key}`, [key]: value }, /application/u);
      await error("update_job", { job_id: lead.id, [key]: value }, /application/u);
    }
    await error("add_jobs", { jobs: [{ company: "Lead batch rollback", eligible_opening: await verifiedOpening("Lead batch rollback") }, { company: "Forbidden batch", title: "Engineer" }] }, /application/u);
    assert.deepEqual((await call("list_jobs", { query: "Lead batch rollback" }, jobsSchema)).jobs, []);
    await call("update_job", { job_id: lead.id, current_stage: "outreach" }, jobSchema);
    await error("update_job", { job_id: lead.id, ...fields }, /application/u);
    await call("update_job", { job_id: lead.id, phase: "application", eligible_opening: eligibleOpening, ...fields }, jobSchema);
    const application = await call("get_job", { job_id: lead.id }, detailSchema);
    assert.equal(application.job.phase, "application");
    assert.equal(application.job.description, fields.description);
    await error("update_job", { job_id: lead.id, phase: "lead" }, /eligible opening/u);
    await call("update_job", { job_id: lead.id, phase: "lead", eligible_opening: eligibleOpening }, jobSchema);
    await error("update_job", { job_id: lead.id, company: "Different employer" }, /eligible opening/u);
    await call("update_job", { job_id: lead.id, status: "withdrawn" }, jobSchema);
    await error("update_job", { job_id: lead.id, status: "active" }, /eligible opening/u);
    await call("update_job", { job_id: lead.id, status: "active", eligible_opening: eligibleOpening }, jobSchema);
    const proof = v.object({ eligible_opening: v.record(v.string(), v.unknown()) });
    assert.deepEqual((await call("get_job", { job_id: lead.id }, v.object({ job: proof }))).job.eligible_opening, eligibleOpening);
    assert.deepEqual((await call("list_jobs", { query: "Employer only" }, v.object({ jobs: v.array(proof) }))).jobs[0]?.eligible_opening, eligibleOpening);
    const returned = await call("get_job", { job_id: lead.id }, detailSchema);
    assert.equal(returned.job.phase, "lead");
    assert.equal(returned.job.current_stage, "lead");
    for (const key of ["title", "description", "source_url", "location"] as const) assert.equal(returned.job[key], null);
    assert.deepEqual((await call("get_job", { job_id: lead.id }, salarySchema)).job, salary);
    await call("update_job", { job_id: lead.id, salary_min: 45.5, salary_max: null, salary_currency: "EUR", salary_period: "hour" }, jobSchema);
    assert.deepEqual((await call("get_job", { job_id: lead.id }, salarySchema)).job,
      { salary_min: 45.5, salary_max: null, salary_currency: "EUR", salary_period: "hour" });
    await call("update_job", { job_id: lead.id, salary_min: null, salary_max: null, salary_currency: null, salary_period: null }, jobSchema);
    assert.deepEqual((await call("get_job", { job_id: lead.id }, salarySchema)).job,
      { salary_min: null, salary_max: null, salary_currency: null, salary_period: null });
  });

  test("pipeline writes reject prepared and arbitrary states through every MCP mutation", async () => {
    const application = await call("add_job", { phase: "application", company: "Fixed milestones", eligible_opening: await verifiedOpening("Fixed milestones") }, jobSchema);
    for (const current_stage of ["prepared", "Prepared — awaiting human submission", "draft", "arbitrary milestone"]) {
      await error("update_job", { job_id: application.id, current_stage }, /current_stage/u);
      await error("add_stage", { job_id: application.id, name: current_stage }, /name/u);
    }
    assert.equal(application.current_stage, "applied");
    const stage = await call("add_stage", { job_id: application.id, name: "recruiter_screen" }, stageSchema);
    await error("update_stage", { stage_id: stage.id, name: "prepared", make_current: true }, /name/u);
    await error("update_stage", { stage_id: stage.id, status: "prepared" }, /status/u);
    await error("update_job", { job_id: application.id, status: "prepared" }, /status/u);
    const unchanged = await call("get_job", { job_id: application.id }, v.object({ job: jobSchema, stages: v.array(stageSchema) }));
    assert.equal(unchanged.job.current_stage, "recruiter_screen");
    assert.deepEqual(unchanged.stages, [stage]);
    const { tools } = await client.listTools();
    for (const [name, field] of [["update_job", "current_stage"], ["add_stage", "name"], ["update_stage", "name"]]) {
      const tool = tools.find((entry) => entry.name === name);
      assert.ok(tool);
      const { properties } = v.parse(v.object({ properties: v.record(v.string(), v.unknown()) }), tool.inputSchema);
      const { enum: allowed } = v.parse(v.object({ enum: v.array(v.string()) }), properties[field ?? ""]);
      assert.ok(allowed.includes("applied"));
      assert.ok(!allowed.includes("prepared"));
    }
    for (const name of ["applied", "outreach", "recruiter_screen", "assessment", "technical_interview", "system_design", "hiring_manager", "final_interview", "reference_check", "offer"]) {
      const round = await call("add_stage", { job_id: application.id, name, status: "completed" }, stageSchema);
      const detail = await call("get_job", { job_id: application.id }, v.object({ job: jobSchema }));
      assert.equal(round.name, name);
      assert.equal(detail.job.current_stage, name);
    }
  });

  test("concurrent applications keep independent stages, failures, optional feedback, and corrected voice transcriptions", async () => {
    const imported = await call("add_jobs", { jobs: [
      { phase: "application", company: "Track A", eligible_opening: await verifiedOpening("Track A"), title: "Engineer", description: "Role A" },
      { phase: "application", company: "Track B", eligible_opening: await verifiedOpening("Track B"), title: "Engineer", description: "Role B" },
    ] }, jobsSchema);
    assert.ok(imported.jobs[0] && imported.jobs[1]);
    const [screening, technical] = await Promise.all([
      call("add_stage", { job_id: imported.jobs[0].id, name: "recruiter_screen", status: "completed" }, stageSchema),
      call("add_stage", { job_id: imported.jobs[1].id, name: "system_design", status: "in_progress" }, stageSchema),
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
    const history = await call("list_feedback", { stage_name: "system_design" }, v.object({ feedback: v.array(feedbackOutput) }));
    assert.equal(history.feedback[0]?.id, feedback.id);
  });

  test("expired rejections return to available opportunities without reopening the failed application", async () => {
    const application = await call("add_job", { company: "Reapplication Co", phase: "application", eligible_opening: await verifiedOpening("Reapplication Co") }, jobSchema);
    const stage = await call("add_stage", { job_id: application.id, name: "system_design", status: "failed" }, stageSchema);
    const feedback = await call("add_feedback", { stage_id: stage.id, source: "recruiter", text: "Please return after the cooldown." }, feedbackOutput);
    const eligibility = v.object({ ...jobSchema.entries, reapply_policy: v.nullable(v.string()), reapply_after: v.nullable(v.string()), reapply_status: v.string() });
    const available = v.object({ jobs: v.array(eligibility), next_offset: v.nullable(v.number()) });
    const deadline = "2026-08-30T00:00:00.000Z";
    await call("update_job", { job_id: application.id, status: "rejected", reapply_policy: "allowed", reapply_after: "2026-08-30T03:00:00+03:00" }, jobSchema);
    for (const [as_of, expected] of [["2026-08-29T23:59:59.999Z", "cooldown"], [deadline, "eligible"]] as const) {
      const query = { query: "Reapplication Co", as_of };
      const listed = await call("list_jobs", query, available);
      assert.equal(listed.jobs[0]?.reapply_status, expected);
      assert.equal(listed.jobs[0]?.reapply_after, deadline);
      const opportunities = await call("list_jobs", { ...query, available_only: true }, available);
      assert.deepEqual(opportunities.jobs.map((job) => job.id), expected === "eligible" ? [application.id] : []);
      assert.deepEqual((await call("list_jobs", { ...query, reapply_status: expected }, available)).jobs.map((job) => job.id), [application.id]);
    }
    const detail = await call("get_job", { job_id: application.id }, v.object({ job: eligibility, stages: v.array(stageSchema), feedback: v.array(feedbackOutput) }));
    assert.equal(detail.job.status, "rejected");
    assert.equal(detail.job.created_at, application.created_at);
    assert.equal(detail.stages[0]?.status, "failed");
    assert.equal(detail.feedback[0]?.id, feedback.id);
    assert.deepEqual((await call("list_jobs", { query: "Reapplication Co", status: "active" }, available)).jobs, []);
    await call("update_job", { job_id: application.id, reapply_after: "2000-01-01T00:00:00Z" }, jobSchema);
    assert.ok((await call("get_lead_context", {}, jobsSchema)).jobs.some((job) => job.id === application.id));
    const prompt = await client.getPrompt({ name: "rank_jobs", arguments: { limit: "25" } });
    assert.ok(prompt.messages[0]?.content.type === "text");
    assert.match(prompt.messages[0].content.text, new RegExp(application.id, "u"));
    for (const invalid of [{ reapply_policy: null }, { reapply_policy: "not_allowed" }, { reapply_after: "2026-02-30T00:00:00Z" }]) {
      await error("update_job", { job_id: application.id, ...invalid }, /reapply|impossible/u);
    }
    for (const [policy, expected] of [["not_allowed", "not_allowed"], [null, "unknown"], ["allowed", "eligible"]] as const) {
      await call("update_job", { job_id: application.id, reapply_policy: policy, reapply_after: null }, jobSchema);
      const result = await call("list_jobs", { query: "Reapplication Co", available_only: true }, available);
      assert.deepEqual(result.jobs.map((job) => job.id), expected === "eligible" ? [application.id] : []);
      assert.equal((await call("get_job", { job_id: application.id }, v.object({ job: eligibility }))).job.reapply_status, expected);
    }
  });

  test("UTC scheduling produces Google Calendar arguments and retains event IDs for rescheduling and cancellation", async () => {
    const imported = await call("add_jobs", { jobs: [{ phase: "application", company: "Calendar Co", eligible_opening: await verifiedOpening("Calendar Co"), title: "Engineer", description: "Remote", notes: "Private salary target" }] }, jobsSchema);
    assert.ok(imported.jobs[0]);
    const stage = await call("add_stage", {
      job_id: imported.jobs[0].id, name: "technical_interview",
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
    await error("add_jobs", { jobs: [{ phase: "application", company: " ", title: "Engineer", description: "Role" }] }, /non-blank/u);
    await error("add_jobs", { jobs: [{ phase: "application", company: "Unknown-key Co", title: "Engineer", description: "Role", ignored_typo: true }] }, /ignored_typo|Invalid key/u);
    const imported = await call("add_jobs", { jobs: [{ phase: "application", company: "Validation Co", eligible_opening: await verifiedOpening("Validation Co"), title: "Engineer", description: "Role", nickname: "unique-role" }] }, jobsSchema);
    assert.ok(imported.jobs[0]);
    await error("add_jobs", { jobs: [
      { phase: "application", company: "Atomic rollback", eligible_opening: await verifiedOpening("Atomic rollback"), title: "Engineer", description: "Role" },
      { phase: "application", company: "Duplicate", eligible_opening: await verifiedOpening("Duplicate"), title: "Engineer", description: "Role", nickname: "UNIQUE-ROLE" },
    ] }, /already exists/u);
    assert.deepEqual((await call("list_jobs", { query: "Atomic rollback" }, jobsSchema)).jobs, []);
    await error("add_stage", { job_id: imported.jobs[0].id, name: "technical_interview", starts_at: "2026-11-02T10:00:00" }, /timestamp/u);
    await error("add_stage", { job_id: imported.jobs[0].id, name: "technical_interview", starts_at: "2026-02-30T10:00:00Z" }, /impossible/u);
    await error("add_stage", { job_id: imported.jobs[0].id, name: "technical_interview", starts_at: "2026-11-02T10:00:00Z", ends_at: "2026-11-02T09:00:00Z" }, /later/u);
    const stage = await call("add_stage", { job_id: imported.jobs[0].id, name: "recruiter_screen", starts_at: "2026-11-03T10:00:00Z" }, stageSchema);
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
      parseTool(await original.callTool({ name: "set_criteria", arguments: { text: "Returning passkey owner" } }), v.object({ text: v.string() }));
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
      const context = parseTool(await returning.callTool({ name: "get_lead_context", arguments: {} }), v.object({ criteria: v.object({ text: v.string() }) }));
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

  test("two users have separate lead and application contexts, applicant profiles and contacts, multilingual CVs, and isolated pipelines in one D1", async () => {
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
      await scoped(alice, "set_criteria", { text: "Alice remote product roles" }, v.unknown());
      await scoped(bob, "set_criteria", { text: "Bob onsite roles" }, v.unknown());
      const applicantContactOutput = v.strictObject({ email: v.nullable(v.string()), phone: v.nullable(v.string()), updated_at: v.string() });
      const applicantProfileOutput = v.strictObject({ gender: v.string(), updated_at: v.string() });
      const applicationOutput = v.strictObject({
        application_context: v.nullable(v.strictObject({ text: v.string(), updated_at: v.string() })),
        applicant_contact: v.nullable(applicantContactOutput),
        applicant_profile: v.nullable(applicantProfileOutput),
        cvs: v.record(v.string(), v.string()),
      });
      assert.deepEqual(await scoped(alice, "get_application_context", {}, applicationOutput), { application_context: null, applicant_contact: null, applicant_profile: null, cvs: {} });
      await scoped(alice, "set_applicant_profile", { gender: "male" }, applicantProfileOutput);
      assert.equal((await scoped(bob, "get_application_context", {}, applicationOutput)).applicant_profile, null);
      const aliceProfile = await scoped(alice, "set_applicant_profile", { gender: "non-binary" }, applicantProfileOutput);
      assert.equal(aliceProfile.gender, "non-binary");
      const bobProfile = await scoped(bob, "set_applicant_profile", { gender: "female" }, applicantProfileOutput);
      await scoped(alice, "set_applicant_contact", { email: "alice@example.com" }, applicantContactOutput);
      const aliceContactDetails = await scoped(alice, "set_applicant_contact", { phone: "+12025550123" }, applicantContactOutput);
      assert.equal(aliceContactDetails.email, "alice@example.com");
      assert.equal(aliceContactDetails.phone, "+12025550123");
      const bobContactDetails = await scoped(bob, "set_applicant_contact", { email: "bob@example.com", phone: "+12025550124" }, applicantContactOutput);
      const applicationText = "\nAlice applicant background.\r\nUse concise cover letters.\nОпыт работы.\n";
      await scoped(alice, "set_application_context", { text: applicationText }, v.unknown());
      await scoped(bob, "set_application_context", { text: "Bob applicant background" }, v.unknown());
      for (const [owner, language, url] of [
        [alice, "en", "https://cv.example/alice-en.pdf"],
        [alice, "RU", "https://cv.example/alice-ru.pdf"],
        [alice, "pt-BR", "https://cv.example/alice-pt-br.pdf"],
        [bob, "en", "https://cv.example/bob-en.pdf"],
      ] as const) await scoped(owner, "set_cv", { language, url }, v.unknown());
      const aliceApplication = await scoped(alice, "get_application_context", {}, applicationOutput);
      assert.equal(aliceApplication.application_context?.text, applicationText);
      assert.deepEqual(aliceApplication.applicant_contact, aliceContactDetails);
      assert.deepEqual(aliceApplication.applicant_profile, aliceProfile);
      assert.deepEqual(aliceApplication.cvs, {
        en: "https://cv.example/alice-en.pdf", ru: "https://cv.example/alice-ru.pdf", "pt-br": "https://cv.example/alice-pt-br.pdf",
      });
      const bobApplication = await scoped(bob, "get_application_context", {}, applicationOutput);
      assert.equal(bobApplication.application_context?.text, "Bob applicant background");
      assert.deepEqual(bobApplication.applicant_contact, bobContactDetails);
      assert.deepEqual(bobApplication.applicant_profile, bobProfile);
      assert.deepEqual(bobApplication.cvs, { en: "https://cv.example/bob-en.pdf" });
      for (const [name, args] of [
        ["set_applicant_profile", {}],
        ["set_applicant_profile", { gender: " \t\n" }],
        ["set_applicant_profile", { gender: "x".repeat(201) }],
        ["set_applicant_profile", { gender: "male", user_id: "bob" }],
        ["set_applicant_contact", {}],
        ["set_applicant_contact", { email: "invalid" }],
        ["set_applicant_contact", { phone: "+1 202 555 0123" }],
        ["set_applicant_contact", { phone: "+0123456" }],
        ["set_applicant_contact", { phone: "+1234567890123456" }],
        ["set_applicant_contact", { email: null, user_id: "bob" }],
        ["set_application_context", { text: " \t\n" }],
        ["set_application_context", { text: "x".repeat(30_001) }],
        ["set_cv", { language: "", url: "https://cv.example/invalid.pdf" }],
        ["set_cv", { language: "ru/en", url: "https://cv.example/invalid.pdf" }],
        ["set_cv", { language: "en", url: "file:///private/cv.pdf" }],
        ["set_cv", { language: "en", url: "https://cv.example/foreign.pdf", user_id: "bob" }],
        ["set_application_context", { text: "Foreign edit", user_id: "bob" }],
        ["get_application_context", { user_id: "bob" }],
      ] as const) assert.equal((await alice.callTool({ name, arguments: args })).isError, true, name);
      assert.deepEqual(await scoped(alice, "get_application_context", {}, applicationOutput), aliceApplication);
      const opening = { phase: "application", company: "Shared company", title: "Engineer", nickname: "shared-role", source_url: "https://jobs.example/shared", description: "A role both users can track" };
      const aliceJob = (await scoped(alice, "add_jobs", { jobs: [{ ...opening, eligible_opening: await verifiedOpening("Shared company", alice) }] }, jobsSchema)).jobs[0];
      const bobJob = (await scoped(bob, "add_jobs", { jobs: [{ ...opening, eligible_opening: await verifiedOpening("Shared company", bob) }] }, jobsSchema)).jobs[0];
      assert.ok(aliceJob && bobJob);
      assert.notEqual(aliceJob.id, bobJob.id);
      const aliceStage = await scoped(alice, "add_stage", { job_id: aliceJob.id, name: "technical_interview", starts_at: "2026-12-01T10:00:00Z", ends_at: "2026-12-01T11:00:00Z" }, stageSchema);
      const bobStage = await scoped(bob, "add_stage", { job_id: bobJob.id, name: "system_design", starts_at: "2026-12-01T10:00:00Z", ends_at: "2026-12-01T11:00:00Z" }, stageSchema);
      await scoped(alice, "add_feedback", { stage_id: aliceStage.id, text: "Alice private feedback" }, feedbackOutput);
      const bobFeedback = await scoped(bob, "add_feedback", { stage_id: bobStage.id, text: "Bob private feedback" }, feedbackOutput);
      const aliceOutreach = await scoped(alice, "record_outreach", { contact: { job_id: aliceJob.id, name: "Alice referrer", relationship: "friend", url: "https://t.me/example_referrer" }, direction: "outbound" }, outreachOutput);
      const bobOutreach = await scoped(bob, "record_outreach", { contact: { job_id: bobJob.id, name: "Bob referrer", relationship: "friend", url: "https://t.me/example_referrer" }, direction: "outbound" }, outreachOutput);
      const aliceContact = { id: aliceOutreach.contact_id };
      const bobContact = { id: bobOutreach.contact_id };
      await scoped(alice, "update_job", { job_id: aliceJob.id, score: 90, notes: "Alice assessment" }, jobSchema);
      await scoped(bob, "update_job", { job_id: bobJob.id, score: 80, notes: "Bob assessment" }, jobSchema);
      for (const [owner, ownJob, ownStage, criteria] of [[alice, aliceJob, aliceStage, "Alice remote product roles"], [bob, bobJob, bobStage, "Bob onsite roles"]] as const) {
        const context = await scoped(owner, "get_lead_context", {}, v.strictObject({ criteria: v.object({ text: v.string() }), jobs: v.array(jobSchema), next_offset: v.null() }));
        assert.equal(context.criteria.text, criteria);
        assert.deepEqual(context.jobs.map((job) => job.id), [ownJob.id]);
        assert.deepEqual((await scoped(owner, "list_jobs", { include_descriptions: true }, jobsSchema)).jobs.map((job) => job.id), [ownJob.id]);
        assert.deepEqual((await scoped(owner, "get_upcoming", { from: "2026-12-01T00:00:00Z" }, v.object({ stages: v.array(stageSchema) }))).stages.map((stage) => stage.id), [ownStage.id]);
        assert.deepEqual((await scoped(owner, "list_feedback", {}, v.object({ feedback: v.array(feedbackOutput) }))).feedback.map((feedback) => feedback.stage_id), [ownStage.id]);
        const detail = await scoped(owner, "get_job", { job_id: ownJob.id }, v.strictObject({ job: jobSchema, stages: v.array(stageSchema), feedback: v.array(feedbackOutput), ...outreachHistory }));
        assert.deepEqual(detail.stages.map((stage) => stage.id), [ownStage.id]);
        assert.deepEqual(detail.feedback.map((feedback) => feedback.stage_id), [ownStage.id]);
        const ownContact = owner === alice ? aliceContact : bobContact;
        assert.deepEqual(detail.contacts.map((contact) => contact.id), [ownContact.id]);
        assert.deepEqual(detail.outreach.map((outreach) => outreach.id), [owner === alice ? aliceOutreach.id : bobOutreach.id]);
        assert.deepEqual((await scoped(owner, "get_follow_ups", {}, v.object({ follow_ups: v.array(contactOutput) }))).follow_ups.map((contact) => contact.id), [ownContact.id]);
        const pipeline = await scoped(owner, "get_pipeline", {}, v.object({
          summary: v.object({ applications: v.number(), awaiting_reply: v.number() }),
          applications: v.array(v.object({
            id: v.string(), pending_contacts: v.array(v.object({ id: v.string() })), next_stage: v.object({ id: v.string() }),
          })),
        }));
        assert.equal(pipeline.summary.applications, 1);
        assert.equal(pipeline.summary.awaiting_reply, 1);
        assert.deepEqual(pipeline.applications.map((job) => job.id), [ownJob.id]);
        assert.deepEqual(pipeline.applications[0]?.pending_contacts.map((contact) => contact.id), [ownContact.id]);
        assert.equal(pipeline.applications[0]?.next_stage.id, ownStage.id);
        const application = await scoped(owner, "get_application_context", { job_id: ownJob.id }, v.strictObject({
          ...applicationOutput.entries, job: jobSchema, stages: v.array(stageSchema), feedback: v.array(feedbackOutput), ...outreachHistory,
        }));
        assert.equal(application.job.id, ownJob.id);
        assert.deepEqual(application.stages, detail.stages);
        assert.deepEqual(application.feedback, detail.feedback);
        assert.deepEqual({ application_context: application.application_context, applicant_contact: application.applicant_contact, applicant_profile: application.applicant_profile, cvs: application.cvs }, owner === alice ? aliceApplication : bobApplication);
        const resource = await owner.readResource({ uri: "careers://criteria" });
        const first = resource.contents[0];
        assert.ok(first && "text" in first);
        assert.equal(v.parse(v.object({ text: v.string() }), JSON.parse(first.text)).text, criteria);
        const applicationResource = await owner.readResource({ uri: "careers://application-context" });
        assert.ok(applicationResource.contents[0] && "text" in applicationResource.contents[0]);
        assert.deepEqual(v.parse(applicationOutput, JSON.parse(applicationResource.contents[0].text)), owner === alice ? aliceApplication : bobApplication);
      }
      const forbidden = [
        ["get_job", { job_id: bobJob.id }], ["get_application_context", { job_id: bobJob.id }], ["update_job", { job_id: bobJob.id, company: "Stolen" }],
        ["add_stage", { job_id: bobJob.id, name: "assessment" }], ["update_stage", { stage_id: bobStage.id, name: "assessment", make_current: true }],
        ["add_feedback", { stage_id: bobStage.id, text: "Foreign feedback" }], ["update_feedback", { feedback_id: bobFeedback.id, text: "Foreign edit" }],
        ["get_calendar_event", { stage_id: bobStage.id }],
        ["record_outreach", { contact: { job_id: bobJob.id, name: "Foreign contact" }, direction: "outbound" }],
        ["update_contact", { job_id: aliceJob.id, contact_id: bobContact.id, name: "Stolen contact" }],
        ["record_outreach", { contact_id: bobContact.id, direction: "outbound" }],
        ["record_outreach", { contact_id: aliceContact.id, stage_id: bobStage.id, direction: "outbound" }],
        ["update_outreach", { outreach_id: bobOutreach.id, follow_up_status: "done" }],
        ["update_job", { job_id: bobJob.id, score: 0, notes: "Foreign assessment" }],
        ["update_job", { job_id: bobJob.id, reapply_policy: "allowed", reapply_after: "2000-01-01T00:00:00Z" }],
      ] as const;
      for (const [name, args] of forbidden) {
        const result = await alice.callTool({ name, arguments: args });
        assert.equal(result.isError, true, name);
        assert.ok(result.content[0]?.type === "text");
        assert.match(result.content[0].text, /not found|do not exist/iu);
      }
      assert.deepEqual((await scoped(alice, "list_feedback", { job_id: bobJob.id }, v.object({ feedback: v.array(feedbackOutput) }))).feedback, []);
      assert.deepEqual((await scoped(alice, "get_follow_ups", { job_id: bobJob.id }, v.object({ follow_ups: v.array(contactOutput) }))).follow_ups, []);
      const aliceUnchanged = await scoped(alice, "get_job", { job_id: aliceJob.id }, v.object({ job: jobSchema }));
      assert.equal(aliceUnchanged.job.score, 90);
      const bobUnchanged = await scoped(bob, "get_job", { job_id: bobJob.id }, v.object({ job: jobSchema, stages: v.array(stageSchema), feedback: v.array(feedbackOutput) }));
      assert.equal(bobUnchanged.job.company, opening.company);
      assert.equal(bobUnchanged.job.score, 80);
      assert.equal(bobUnchanged.stages[0]?.name, "system_design");
      assert.equal(bobUnchanged.feedback[0]?.text, "Bob private feedback");
      const bobDraft = await scoped(bob, "get_calendar_event", { stage_id: bobStage.id }, v.object({ create_event_args: v.object({ description: v.string() }) }));
      assert.match(bobDraft.create_event_args.description, /system_design/u);
      assert.doesNotMatch(bobDraft.create_event_args.description, /Alice|private feedback/u);
      await scoped(alice, "set_criteria", { text: "Alice changed again" }, v.unknown());
      assert.deepEqual((await scoped(alice, "list_jobs", {}, jobsSchema)).jobs.map((job) => job.id), [aliceJob.id]);
      assert.deepEqual((await scoped(bob, "list_jobs", {}, jobsSchema)).jobs.map((job) => job.id), [bobJob.id]);
      const lead = await scoped(alice, "add_job", { company: "Alice lead", eligible_opening: await verifiedOpening("Alice lead", alice) }, jobSchema);
      const prompt = await alice.getPrompt({ name: "rank_jobs", arguments: { limit: "25", offset: "0" } });
      assert.ok(prompt.messages[0]?.content.type === "text");
      assert.match(prompt.messages[0].content.text, new RegExp(lead.id, "u"));
      assert.match(prompt.messages[0].content.text, new RegExp(aliceJob.id, "u"));
      assert.doesNotMatch(prompt.messages[0].content.text, new RegExp(bobJob.id, "u"));
      assert.doesNotMatch(prompt.messages[0].content.text, /applicant background|applicant_profile|non-binary|cv\.example|alice@example\.com|12025550123/u);
      await scoped(bob, "update_job", { job_id: bobJob.id, status: "rejected", reapply_policy: "allowed" }, jobSchema);
      assert.deepEqual((await scoped(alice, "list_jobs", { available_only: true, reapply_status: "eligible" }, jobsSchema)).jobs, []);
      assert.deepEqual((await scoped(bob, "list_jobs", { available_only: true, reapply_status: "eligible" }, jobsSchema)).jobs.map((job) => job.id), [bobJob.id]);
      await scoped(alice, "set_cv", { language: "EN", url: "https://cv.example/alice-new-en.pdf" }, v.unknown());
      await scoped(alice, "set_cv", { language: "PT-br", url: null }, v.unknown());
      await scoped(alice, "set_application_context", { text: "Alice updated applicant background" }, v.unknown());
      const updatedApplication = await scoped(alice, "get_application_context", {}, applicationOutput);
      assert.equal(updatedApplication.application_context?.text, "Alice updated applicant background");
      assert.deepEqual(updatedApplication.applicant_contact, aliceContactDetails);
      assert.deepEqual(updatedApplication.applicant_profile, aliceProfile);
      assert.deepEqual(updatedApplication.cvs, { en: "https://cv.example/alice-new-en.pdf", ru: "https://cv.example/alice-ru.pdf" });
      assert.equal((await scoped(alice, "get_lead_context", {}, v.object({ criteria: v.object({ text: v.string() }) }))).criteria.text, "Alice changed again");
      await scoped(alice, "set_application_context", { text: null }, v.null());
      const cleared = await scoped(alice, "get_application_context", {}, applicationOutput);
      assert.equal(cleared.application_context, null);
      assert.deepEqual(cleared.applicant_contact, aliceContactDetails);
      assert.deepEqual(cleared.applicant_profile, aliceProfile);
      assert.deepEqual(cleared.cvs, updatedApplication.cvs);
      const withoutEmail = await scoped(alice, "set_applicant_contact", { email: null }, applicantContactOutput);
      assert.equal(withoutEmail.email, null);
      assert.equal(withoutEmail.phone, "+12025550123");
      await scoped(alice, "set_applicant_contact", { phone: null }, applicantContactOutput);
      const clearedContact = (await scoped(alice, "get_application_context", {}, applicationOutput)).applicant_contact;
      assert.equal(clearedContact?.email, null);
      assert.equal(clearedContact?.phone, null);
      await scoped(alice, "set_applicant_profile", { gender: null }, v.null());
      const clearedProfile = await scoped(alice, "get_application_context", {}, applicationOutput);
      assert.equal(clearedProfile.applicant_profile, null);
      assert.equal(clearedProfile.application_context, null);
      assert.deepEqual(clearedProfile.applicant_contact, clearedContact);
      assert.deepEqual(clearedProfile.cvs, updatedApplication.cvs);
      assert.deepEqual(await scoped(bob, "get_application_context", {}, applicationOutput), bobApplication);
      const spoofed = await alice.callTool({ name: "get_lead_context", arguments: { user_id: "another-user" } });
      assert.equal(spoofed.isError, true);
      assert.equal((await aliceBrowser.request("/auth/revoke", {})).status, 200);
      assert.equal((await fetch(endpoint, { headers: { Authorization: `Bearer ${aliceConnection.token}` } })).status, 401);
      assert.equal((await scoped(bob, "get_lead_context", {}, v.object({ criteria: v.object({ text: v.string() }) }))).criteria.text, "Bob onsite roles");
    } finally {
      await Promise.all([alice.close(), bob.close()]);
    }
  });

  test("prospective contacts cannot be saved before communication", async () => {
    const employer = await call("add_job", { company: "Uncontacted prospect example", eligible_opening: await verifiedOpening("Uncontacted prospect example") }, jobSchema);
    await assert.rejects(client.callTool({ name: "save_contact", arguments: { job_id: employer.id, name: "Uncontacted prospect" } }), /not found/u);
    await error("update_contact", { job_id: employer.id, name: "Uncontacted prospect" }, /contact_id/u);
    await error("record_outreach", { direction: "outbound" }, /exactly one/u);
    await error("record_outreach", { contact: { job_id: employer.id, name: "Uncontacted prospect" } }, /direction/u);
    await error("record_outreach", { contact: { job_id: employer.id, name: "Future prospect" }, direction: "outbound", occurred_at: "2099-01-01T00:00:00Z" }, /future/u);
    const other = await call("add_job", { company: "Other prospect employer", eligible_opening: await verifiedOpening("Other prospect employer") }, jobSchema);
    const foreignStage = await call("add_stage", { job_id: other.id, name: "technical_interview" }, stageSchema);
    await error("record_outreach", { contact: { job_id: employer.id, name: "Wrong stage prospect" }, direction: "outbound", stage_id: foreignStage.id }, /same job/u);
    const history = await call("get_job", { job_id: employer.id }, v.object(outreachHistory));
    assert.deepEqual(history.contacts, []);
    assert.deepEqual(history.outreach, []);
    const incoming = await call("record_outreach", {
      contact: { job_id: employer.id, name: "Recruiter who contacted me", relationship: "recruiter" }, direction: "inbound",
      occurred_at: "2026-09-01T09:00:00Z", notes: "Received an introduction from the recruiter.",
    }, outreachOutput);
    const received = await call("get_job", { job_id: employer.id }, v.object(outreachHistory));
    assert.equal(received.contacts.length, 1);
    assert.equal(received.contacts[0]?.id, incoming.contact_id);
    assert.deepEqual(received.outreach, [incoming]);
    assert.equal(received.last_outreach_at, null);
    assert.equal(received.last_response_at, incoming.occurred_at);
    await error("record_outreach", { contact_id: incoming.contact_id, contact: { job_id: employer.id, name: "Ambiguous contact" }, direction: "outbound" }, /exactly one/u);
  });

  test("referral contacts keep an event-time outreach clock across stage changes and surface actionable follow-ups", async () => {
    const employer = await call("add_job", { company: "Referral Example", eligible_opening: await verifiedOpening("Referral Example") }, jobSchema);
    const activity = v.object({
      id: v.string(), company: v.string(), relationship: v.string(), current_stage: v.string(),
      first_outreach_at: v.string(), last_outreach_at: v.string(), last_interaction_time_basis: v.string(),
      follow_up_at: v.nullable(v.string()), seconds_since_outreach: v.number(), due: v.boolean(),
    });
    const followUps = v.object({ follow_ups: v.array(activity), next_offset: v.nullable(v.number()) });
    const referral = await call("add_stage", { job_id: employer.id, name: "outreach", status: "in_progress" }, stageSchema);
    const first = await call("record_outreach", {
      contact: { job_id: employer.id, name: "Example friend", relationship: "friend/referrer", url: "https://t.me/referrer_example" },
      stage_id: referral.id, direction: "outbound", channel: "telegram",
      occurred_at: "2026-09-01T12:00:00+03:00", follow_up_at: "2026-09-04T12:00:00+03:00",
    }, outreachOutput);
    const friend = { id: first.contact_id };
    assert.equal(first.occurred_at, "2026-09-01T09:00:00.000Z");
    assert.equal(first.time_basis, "reported");
    assert.notEqual(first.created_at, first.occurred_at);
    const screening = await call("add_stage", { job_id: employer.id, name: "recruiter_screen" }, stageSchema);
    const detail = await call("get_job", { job_id: employer.id }, v.object({ job: jobSchema, ...outreachHistory }));
    assert.equal(detail.job.current_stage, "recruiter_screen");
    assert.equal(detail.last_outreach_at, "2026-09-01T09:00:00.000Z");
    assert.equal(detail.contacts[0]?.relationship, "friend/referrer");
    assert.deepEqual(detail.outreach.map((entry) => entry.stage_id), [referral.id]);
    const due = await call("get_follow_ups", { job_id: employer.id, due_only: true, as_of: "2026-09-04T09:00:00Z" }, followUps);
    assert.equal(due.follow_ups[0]?.id, friend.id);
    assert.equal(due.follow_ups[0]?.seconds_since_outreach, 3 * 86_400);
    assert.equal(due.follow_ups[0]?.current_stage, "recruiter_screen");
    assert.equal(due.follow_ups[0]?.due, true);
    const listed = await call("list_jobs", { query: "Referral Example" }, v.object({ jobs: v.array(v.object({ last_outreach_at: v.string(), follow_up_at: v.string() })) }));
    assert.equal(listed.jobs[0]?.last_outreach_at, first.occurred_at);
    assert.equal(listed.jobs[0]?.follow_up_at, first.follow_up_at);
    const touched = await call("update_outreach", { outreach_id: first.id, notes: "Clarified referral context" }, outreachOutput);
    assert.equal(touched.created_at, first.created_at);
    assert.equal(touched.occurred_at, first.occurred_at);

    // A reply to one person must not clear another person's wait, even at a later stage.
    const hrOutreach = await call("record_outreach", { contact: { job_id: employer.id, name: "Example HR", relationship: "recruiter" }, stage_id: screening.id, direction: "outbound", occurred_at: "2026-09-02T09:00:00Z" }, outreachOutput);
    const hr = { id: hrOutreach.contact_id };
    await call("record_outreach", { contact_id: friend.id, direction: "inbound", occurred_at: "2026-09-04T10:00:00Z" }, outreachOutput);
    assert.deepEqual((await call("get_follow_ups", { job_id: employer.id }, followUps)).follow_ups.map((entry) => entry.id), [hr.id]);
    const second = await call("record_outreach", { contact_id: friend.id, direction: "outbound", occurred_at: "2026-09-05T09:00:00Z" }, outreachOutput);
    assert.equal(second.follow_up_at, null);
    assert.deepEqual((await call("get_follow_ups", { job_id: employer.id, due_only: true }, followUps)).follow_ups, []);
    await call("record_outreach", { contact_id: friend.id, direction: "inbound", occurred_at: "2026-09-03T09:00:00Z" }, outreachOutput);
    const waiting = await call("get_follow_ups", { job_id: employer.id, reached_out_before: "2026-09-06T09:00:00Z", limit: 1 }, followUps);
    assert.equal(waiting.next_offset, 1);
    const rest = await call("get_follow_ups", { job_id: employer.id, reached_out_before: "2026-09-06T09:00:00Z", limit: 1, offset: 1 }, followUps);
    assert.equal(rest.next_offset, null);
    assert.equal(rest.follow_ups[0]?.last_outreach_at, "2026-09-05T09:00:00.000Z");
    assert.equal(rest.follow_ups[0]?.first_outreach_at, "2026-09-01T09:00:00.000Z");
    await call("update_outreach", { outreach_id: second.id, follow_up_at: "2026-09-08T09:00:00Z" }, outreachOutput);
    assert.equal((await call("get_follow_ups", { job_id: employer.id, due_only: true, as_of: "2026-09-08T09:00:00Z" }, followUps)).follow_ups[0]?.id, friend.id);
    await call("update_outreach", { outreach_id: second.id, follow_up_status: "done" }, outreachOutput);
    assert.deepEqual((await call("get_follow_ups", { job_id: employer.id }, followUps)).follow_ups.map((entry) => entry.id), [hr.id]);
    await call("update_outreach", { outreach_id: second.id, occurred_at: "2026-09-03T08:00:00Z", follow_up_status: "pending" }, outreachOutput);
    assert.deepEqual((await call("get_follow_ups", { job_id: employer.id }, followUps)).follow_ups.map((entry) => entry.id), [hr.id]);
    const loggingStartedAt = Date.now();
    const logged = await call("record_outreach", { contact_id: friend.id, direction: "outbound" }, outreachOutput);
    assert.equal(logged.time_basis, "recorded");
    assert.ok(Date.parse(logged.occurred_at) >= loggingStartedAt && Date.parse(logged.occurred_at) <= Date.now());
    await call("update_contact", { job_id: employer.id, contact_id: friend.id, name: "Renamed friend", relationship: "referrer" }, contactOutput);
    const persisted = await call("get_job", { job_id: employer.id }, v.object(outreachHistory));
    assert.equal(persisted.contacts.find((contact) => contact.id === friend.id)?.url, "https://t.me/referrer_example");
    assert.equal(persisted.last_outreach_at, logged.occurred_at);
    assert.equal(persisted.outreach.length, 6);
    for (const [name, args, message] of [
      ["record_outreach", { contact: { job_id: employer.id, name: "Duplicate", url: "https://t.me/referrer_example" }, direction: "outbound" }, /already exists/u],
      ["record_outreach", { contact_id: friend.id, direction: "outbound", time_basis: "reported" }, /require occurred_at/u],
      ["record_outreach", { contact_id: friend.id, direction: "outbound", occurred_at: "2099-01-01T00:00:00Z" }, /future/u],
      ["update_outreach", { outreach_id: first.id, follow_up_at: "2026-08-01T00:00:00Z" }, /earlier/u],
      ["record_outreach", { contact_id: friend.id, direction: "outbound", occurred_at: "2026-02-30T00:00:00Z" }, /impossible/u],
    ] as const) await error(name, args, message);
    const unchanged = await call("get_job", { job_id: employer.id }, v.object(outreachHistory));
    assert.equal(unchanged.contacts.length, 2);
    assert.equal(unchanged.outreach.length, persisted.outreach.length);
    const other = await call("add_job", { company: "Different employer", eligible_opening: await verifiedOpening("Different employer") }, jobSchema);
    const otherStage = await call("add_stage", { job_id: other.id, name: "technical_interview" }, stageSchema);
    await error("record_outreach", { contact_id: friend.id, stage_id: otherStage.id, direction: "outbound" }, /same job/u);
    await error("update_contact", { job_id: other.id, contact_id: friend.id, name: "Wrong employer" }, /does not belong/u);
    const otherOutreach = await call("record_outreach", { contact: { job_id: other.id, name: "Recruiter", relationship: "recruiter" }, direction: "outbound", occurred_at: "2026-08-01T09:00:00Z" }, outreachOutput);
    const otherContact = { id: otherOutreach.contact_id };
    await call("update_job", { job_id: other.id, recruiter_engaged_at: "2026-08-01T12:00:00+03:00" }, jobSchema);
    assert.deepEqual((await call("get_follow_ups", { job_id: other.id, pre_recruiter_only: true }, followUps)).follow_ups, []);
    assert.deepEqual((await call("get_follow_ups", { job_id: other.id }, followUps)).follow_ups.map((contact) => contact.id), [otherContact.id]);
    const priority = (await call("get_follow_ups", {}, followUps)).follow_ups.map((contact) => contact.id);
    assert.ok(priority.indexOf(friend.id) >= 0 && priority.indexOf(friend.id) < priority.indexOf(otherContact.id));
    const acknowledgement = await call("record_outreach", {
      contact_id: hr.id, direction: "inbound", occurred_at: "2026-09-06T09:00:00Z", follow_up_at: "2026-09-09T09:00:00Z",
    }, outreachOutput);
    const checkBack = await call("get_follow_ups", { job_id: employer.id, due_only: true }, v.object({ follow_ups: v.array(v.object({
      id: v.string(), awaiting_reply: v.number(), needs_follow_up: v.number(), last_outreach_at: v.string(),
    })) }));
    assert.equal(checkBack.follow_ups[0]?.id, hr.id);
    assert.equal(checkBack.follow_ups[0]?.awaiting_reply, 0);
    assert.equal(checkBack.follow_ups[0]?.needs_follow_up, 1);
    assert.equal(checkBack.follow_ups[0]?.last_outreach_at, "2026-09-02T09:00:00.000Z");
    await call("update_outreach", { outreach_id: acknowledgement.id, follow_up_status: "cancelled" }, outreachOutput);
    assert.deepEqual((await call("get_follow_ups", { job_id: employer.id }, followUps)).follow_ups.map((contact) => contact.id), [friend.id]);
    await call("update_job", { job_id: employer.id, status: "withdrawn" }, jobSchema);
    assert.deepEqual((await call("get_follow_ups", { job_id: employer.id }, followUps)).follow_ups, []);
  });

  test("one pipeline read summarizes active applications and offers with compact paginated stages and pending contacts", async () => {
    const browser = browserFor(endpoint);
    await enroll(browser);
    const connection = await authorize(browser);
    const owner = new Client({ name: "pipeline-test", version: "1" });
    async function scoped<Schema extends v.GenericSchema>(name: string, args: Record<string, unknown>, schema: Schema) {
      return parseTool(await owner.callTool({ name, arguments: args }), schema);
    }
    const summarySchema = v.strictObject({
      applications: v.number(), active: v.number(), offers: v.number(), awaiting_reply: v.number(),
      follow_ups_due: v.number(), scheduled_stages: v.number(),
    });
    const pipelineSchema = v.strictObject({
      as_of: v.pipe(v.string(), v.isoTimestamp()), summary: summarySchema,
      applications: v.array(v.object({
        id: v.string(), company: v.string(), current_stage: v.string(), current_stage_status: v.nullable(v.string()),
        pending_contacts: v.array(v.object({
          id: v.string(), name: v.string(), relationship: v.string(), url: v.nullable(v.string()),
          awaiting_reply: v.boolean(), due: v.boolean(), follow_up_at: v.nullable(v.string()),
          last_interaction_time_basis: v.string(), last_outreach_at: v.nullable(v.string()), last_response_at: v.nullable(v.string()),
        })),
        next_stage: v.nullable(v.object({ id: v.string(), name: v.string(), starts_at: v.string() })),
      })), next_offset: v.nullable(v.number()),
    });
    try {
      await owner.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${connection.token}` } } }));
      const empty = await scoped("get_pipeline", {}, pipelineSchema);
      assert.deepEqual(empty.summary, { applications: 0, active: 0, offers: 0, awaiting_reply: 0, follow_ups_due: 0, scheduled_stages: 0 });
      assert.deepEqual(empty.applications, []);
      assert.equal(empty.next_offset, null);
      await scoped("set_criteria", { text: "Remote TypeScript product engineering roles." }, v.unknown());
      const imported = await scoped("add_jobs", { jobs: [
        { company: "Pipeline submitted", phase: "application", eligible_opening: await verifiedOpening("Pipeline submitted", owner), title: "Engineer", notes: "Private application notes", description: "Long opening description" },
        { company: "Pipeline referral", phase: "application", eligible_opening: await verifiedOpening("Pipeline referral", owner) },
        { company: "Pipeline offer", phase: "application", eligible_opening: await verifiedOpening("Pipeline offer", owner) },
        { company: "Pipeline rejected", phase: "application", eligible_opening: await verifiedOpening("Pipeline rejected", owner) },
        { company: "Pipeline withdrawn", phase: "application", eligible_opening: await verifiedOpening("Pipeline withdrawn", owner) },
        { company: "Pipeline accepted", phase: "application", eligible_opening: await verifiedOpening("Pipeline accepted", owner) },
        { company: "Pipeline lead", eligible_opening: await verifiedOpening("Pipeline lead", owner) },
      ] }, jobsSchema);
      const [submitted, referral, offer, rejected, withdrawn, accepted, lead] = imported.jobs;
      assert.ok(submitted && referral && offer && rejected && withdrawn && accepted && lead);
      for (const [job, status] of [[offer, "offer"], [rejected, "rejected"], [withdrawn, "withdrawn"], [accepted, "accepted"]] as const) {
        await scoped("update_job", { job_id: job.id, status }, jobSchema);
      }
      await scoped("update_job", { job_id: rejected.id, reapply_policy: "allowed" }, jobSchema);
      await scoped("set_criteria", { text: "Private selection criteria" }, v.unknown());
      await scoped("set_application_context", { text: "Private applicant document" }, v.unknown());
      await scoped("set_applicant_profile", { gender: "self-described" }, v.unknown());
      await scoped("add_stage", { job_id: submitted.id, name: "applied", status: "completed" }, stageSchema);
      await scoped("add_stage", { job_id: submitted.id, name: "applied", status: "planned" }, stageSchema);
      const latest = await scoped("add_stage", { job_id: submitted.id, name: "applied", status: "completed" }, stageSchema);
      const yesterday = new Date(Date.now() - 86_400_000).toISOString();
      const pastDue = new Date(Date.now() - 3_600_000).toISOString();
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
      const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
      for (const job of [lead, rejected, withdrawn, accepted]) {
        await scoped("record_outreach", { contact: { job_id: job.id, name: "technical_interview" }, direction: "outbound", occurred_at: yesterday, follow_up_at: pastDue }, outreachOutput);
        await scoped("add_stage", { job_id: job.id, name: "technical_interview", starts_at: tomorrow }, stageSchema);
      }
      const friend = await scoped("record_outreach", {
        contact: { job_id: referral.id, name: "Example referrer", relationship: "friend/referrer", url: "https://t.me/pipeline_example" },
        direction: "outbound", occurred_at: yesterday, follow_up_at: pastDue,
      }, outreachOutput);
      const hr = await scoped("record_outreach", { contact: { job_id: referral.id, name: "Example HR" }, direction: "outbound", occurred_at: yesterday }, outreachOutput);
      await scoped("record_outreach", { contact_id: hr.contact_id, direction: "inbound", occurred_at: pastDue }, outreachOutput);
      const acknowledgement = await scoped("record_outreach", {
        contact: { job_id: offer.id, name: "Example recruiter" }, direction: "inbound", occurred_at: yesterday, follow_up_at: pastDue,
      }, outreachOutput);
      await scoped("add_stage", { job_id: offer.id, name: "technical_interview", starts_at: tomorrow, status: "cancelled", make_current: false }, stageSchema);
      await scoped("add_stage", { job_id: offer.id, name: "technical_interview", starts_at: yesterday, status: "completed", make_current: false }, stageSchema);
      await scoped("add_stage", { job_id: offer.id, name: "technical_interview", make_current: false }, stageSchema);
      const ongoing = await scoped("add_stage", { job_id: offer.id, name: "technical_interview", starts_at: yesterday, status: "in_progress", make_current: false }, stageSchema);
      await scoped("add_stage", { job_id: offer.id, name: "technical_interview", starts_at: later, make_current: false }, stageSchema);
      const soon = await scoped("add_stage", { job_id: referral.id, name: "recruiter_screen", starts_at: tomorrow, make_current: false }, stageSchema);
      const response = await owner.callTool({ name: "get_pipeline", arguments: {} });
      const pipeline = parseTool(response, pipelineSchema);
      assert.deepEqual(pipeline.summary, { applications: 3, active: 2, offers: 1, awaiting_reply: 1, follow_ups_due: 2, scheduled_stages: 3 });
      assert.deepEqual(new Set(pipeline.applications.map((job) => job.id)), new Set([submitted.id, referral.id, offer.id]));
      const submittedRow = pipeline.applications.find((job) => job.id === submitted.id);
      assert.ok(submittedRow);
      assert.equal(submittedRow?.current_stage, latest.name);
      assert.equal(submittedRow?.current_stage_status, "completed");
      assert.equal(submittedRow.next_stage, null);
      const referralRow = pipeline.applications.find((job) => job.id === referral.id);
      assert.deepEqual(referralRow?.pending_contacts.map((contact) => contact.id), [friend.contact_id]);
      assert.equal(referralRow?.pending_contacts[0]?.awaiting_reply, true);
      assert.equal(referralRow?.pending_contacts[0]?.due, true);
      assert.equal(referralRow?.pending_contacts[0]?.last_interaction_time_basis, "reported");
      assert.equal(referralRow?.next_stage?.id, soon.id);
      const offerRow = pipeline.applications.find((job) => job.id === offer.id);
      assert.equal(offerRow?.pending_contacts[0]?.id, acknowledgement.contact_id);
      assert.equal(offerRow?.pending_contacts[0]?.awaiting_reply, false);
      assert.equal(offerRow?.next_stage?.id, ongoing.id);
      assert.ok(response.content[0]?.type === "text");
      assert.doesNotMatch(response.content[0].text, /Private |Long opening|"criteria"|"notes"|"description"|"applicant_profile"|"cvs"/u);
      const page = await scoped("get_pipeline", { limit: 1 }, pipelineSchema);
      assert.deepEqual(page.summary, pipeline.summary);
      assert.equal(page.next_offset, 1);
      const second = await scoped("get_pipeline", { limit: 1, offset: 1 }, pipelineSchema);
      const third = await scoped("get_pipeline", { limit: 1, offset: 2 }, pipelineSchema);
      assert.deepEqual([page, second, third].flatMap((part) => part.applications), pipeline.applications);
      assert.equal(third.next_offset, null);
      const emptyPage = await scoped("get_pipeline", { offset: 3 }, pipelineSchema);
      assert.deepEqual(emptyPage.applications, []);
      assert.deepEqual(emptyPage.summary, pipeline.summary);
    } finally {
      await owner.close();
    }
  });

  test("invalid batch sizes are rejected before accessing D1", async () => {
    const scope = {
      userId: crypto.randomUUID(),
      get db(): never { throw new Error("Invalid batch must not access D1."); },
    };
    for (const size of [0, 101]) {
      await assert.rejects(addJobs(scope, { jobs: Array.from({ length: size }, (_, index) => ({
        company: `Invalid batch employer ${index}`, phase: "lead",
      })) }), /1[–-]100/u);
    }
  });

  test("bulk imports save 44 and 100 employers atomically and reject oversized batches without writes", async () => {
    for (const size of [44, 100]) {
      const opening = await verifiedOpening(`Bulk ${size}`);
      const jobs = Array.from({ length: size }, (_, index) => ({
        company: `Bulk ${size} employer ${index}`, nickname: `bulk-${size}-${index}`,
        eligible_opening: { ...opening, source_url: `https://jobs.example/bulk-${size}-${index}` },
      }));
      const imported = await call("add_jobs", { jobs }, jobsSchema);
      assert.deepEqual(imported.jobs.map((job) => job.company).sort(), jobs.map((job) => job.company).sort());
      assert.equal(new Set(imported.jobs.map((job) => job.id)).size, size);
      const saved = await call("list_jobs", { query: `Bulk ${size} employer`, limit: 100 }, jobsSchema);
      assert.deepEqual(saved.jobs.map((job) => job.id).sort(), imported.jobs.map((job) => job.id).sort());
      assert.equal(saved.next_offset, null);
      const conflicting = Array.from({ length: size }, (_, index) => ({
        company: `Bulk rollback ${size} employer ${index}`,
        eligible_opening: { ...opening, source_url: `https://jobs.example/rollback-${size}-${index}` },
        nickname: index === size - 1 ? `BULK-${size}-0` : `bulk-rollback-${size}-${index}`,
      }));
      await error("add_jobs", { jobs: conflicting }, /already exists/u);
      assert.deepEqual((await call("list_jobs", { query: `Bulk rollback ${size} employer`, limit: 100 }, jobsSchema)).jobs, []);
    }
    await error("add_jobs", { jobs: [] }, /length|items/u);
    await error("add_jobs", { jobs: Array.from({ length: 101 }, (_, index) => ({ company: `Oversized bulk employer ${index}` })) }, /100/u);
    assert.deepEqual((await call("list_jobs", { query: "Oversized bulk employer", limit: 100 }, jobsSchema)).jobs, []);
    for (const mode of ["legacy", { pin: "2026-07-28" }] as const) {
      const connection = new Client({ name: "bulk-validation-test", version: "1.0.0" }, { versionNegotiation: { mode } });
      try {
        await connection.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
        for (const size of [44, 100, 101]) {
          const result = await connection.callTool({ name: "add_jobs", arguments: {
            jobs: Array.from({ length: size }, (_, index) => ({ company: `Protocol bulk employer ${index}`, salary_min: 1 })),
          } });
          assert.equal(result.isError, true);
          assert.ok(result.content[0]?.type === "text");
          assert.match(result.content[0].text, size > 100 ? /100/u : /Salary needs/u);
          if (size <= 100) assert.match(result.content[0].text, new RegExp(`0 of ${size} records saved\\. Record 1:`, "u"));
        }
      } finally {
        await connection.close();
      }
    }
  });
});
