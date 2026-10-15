# Careers MCP

A personal job-search CRM exposed as an MCP server on Cloudflare Workers, backed by D1 SQLite. TypeScript, Valibot schemas, Aube, Oxlint, and the TypeScript 7 native compiler (`tsgo`).

Save employers as leads, then assess and rank them. Lead intake requires only a company name: do not select, fetch, or store an individual opening before the user starts applying. Explicit imports never require criteria or a fit assessment. Opening details belong to applications, with an explicit phase separating them from employer leads. Track applications independently, with freely named stages, interview schedules, outcomes, recruiter details, and optional feedback. Voice feedback is stored as transcribed text; your chat/voice client handles transcription.

Sign in or create an account with a passkey; no password, email, or shared token is required. Multiple users share one D1 database, with separate lead-selection criteria, applicant context, CV URLs by language, applications, stages, feedback, and calendar links. The LLM does the reasoning; the Worker stores and retrieves the data. All timestamps are normalized to UTC RFC3339 strings such as `2026-11-02T17:00:00.000Z`.

## Local development

Use Node.js 22.18+ and the installed Aube package manager:

```fish
aube install
aube run db:migrate
aube run dev
```

Open `http://localhost:8787/` to create a passkey, or connect an OAuth-capable MCP client using Streamable HTTP at `http://localhost:8787/mcp`. The client opens the sign-in page; create or use a passkey, then allow the connection. Localhost supports passkeys during development; production requires HTTPS.

For clients that support the `mcpServers` configuration format:

```json
{
  "mcpServers": {
    "careers": {
      "url": "http://localhost:8787/mcp"
    }
  }
}
```

The client must support OAuth discovery, dynamic client registration, and authorization-code exchange with S256 PKCE. It manages its own access and refresh tokens. MCP supports both current and stateless legacy protocol versions after authentication. Browser MCP requests must originate from the Worker's own origin; native clients have no browser CORS restriction. `/health` is public and reports process health.

The account page lets you add another passkey, sign out, or disconnect all MCP clients. Signing out clears the browser session; disconnecting clients revokes their OAuth grants. Keep a synced passkey or add a backup passkey: there is no password or email recovery flow. Passkeys are tied to the hostname, so use a stable production address.

## Deploy

The checked-in configuration targets the maintainer's personal Cloudflare account (`00000000000000000000000000000000`), Worker `example-worker`, and D1 database `careers`. Keep account and database IDs in ignored local configuration. Forks should replace both IDs with their own before deploying.

For this checkout, Wrangler's existing `example-profile` OAuth profile is bound to the repository directory. Its credentials and directory binding live in Wrangler's user configuration outside Git. To authenticate a new checkout, create and activate your own profile:

```fish
aube install --frozen-lockfile
aube exec -- wrangler auth create example-profile --scopes user:read account:read workers_scripts:write d1:write
aube exec -- wrangler auth activate example-profile
```

Select your intended account in the browser. To refresh an expired profile, run `wrangler auth create` with the same name and scopes again. The extra `--` after `aube exec` forwards flags to Wrangler.

For API-token authentication instead, copy `.env.deploy.example` to `.env.deploy`, restrict it with `chmod 600 .env.deploy`, and enter your token locally. Scope it to the intended account with Workers Scripts:Edit and D1:Edit; Account Settings:Read supports account discovery. `.env.deploy` and other `.env.*` files are Git-ignored; only the placeholder example is tracked. The remote migration and publish commands load `.env.deploy` through Node, so deploy credentials are not loaded by local development, type generation, or bundled into the Worker. CI can supply `CLOUDFLARE_API_TOKEN` as an encrypted secret environment variable instead; existing environment variables take precedence over the file. Never put tokens in Wrangler config, command arguments, or committed files.

Once authenticated, every deployment uses the Taskfile workflow:

```fish
task deploy
```

This runs type checking, lint, integration tests, and a bundle dry run before applying pending remote D1 migrations and publishing the Worker, then refreshes CareerMCP tools with `mcp-refresh refresh CareerMCP`. Create a new Codex thread afterward to verify through the refreshed tools; existing threads retain their cached schemas. A failed step stops the workflow. Already-applied migrations are skipped on subsequent runs. Migrations and publishing are separate operations: if publishing fails after a migration succeeds, fix the failure and rerun; future schema changes should remain compatible with the currently deployed Worker.

For a new account, create the database once with `aube exec -- wrangler d1 create careers --update-config=false`, set its `database_id` in `wrangler.jsonc`, and run `aube run types` before deploying. Local and remote D1 storage are separate.

The maintainer's deployment is [mcp.example.com](https://mcp.example.com/). Connect your MCP client to `https://mcp.example.com/mcp` and sign in with a passkey. Forks should use the hostname printed by their deployment. Users, credential public keys, challenges, sessions, clients, and OAuth grants all use this same D1 database; no extra database, KV namespace, or identity provider is needed. Verify a deployment with `curl --fail https://mcp.example.com/health` (returns `{"ok":true}`).

The deploy command applies `0001_initial.sql` before the first publication. It creates the complete user-scoped CRM and passkey/OAuth schema in one migration.

Every store operation takes a user scope derived from a verified access token. Ownership is checked on reads, updates, rankings, parent-child links, resources, prompts, feedback searches, and calendar drafts. Nicknames (case-insensitive) and source URLs are unique within each user's jobs. Composite foreign keys reject stages and feedback attached to another user's records. Clients cannot supply or override a user ID.

WebAuthn requires discoverable credentials and user verification. Challenges are tied to a browser cookie, expire after five minutes, and are consumed once. Browser sessions last seven days. OAuth codes expire after one minute; access tokens last one hour, and refresh tokens rotate with a 30-day lifetime. Session and OAuth token values are stored only as SHA-256 hashes. Consent displays the client name and callback host; redirect URIs, PKCE, client IDs, and the MCP resource are checked before issuing tokens.

## Workflow and tools

The server's MCP instructions tell the agent to choose context by task. `get_pipeline` answers current/active pipeline and progress questions in one compact read: full counts, active/offer applications, current stage outcomes, pending contacts and follow-up dates, and the next scheduled stage per application. It excludes untouched leads, closed applications (including eligible reapplications), long notes, selection criteria, and applicant documents. `as_of` supplies server time. Defaults to 25 applications ordered by last update; `limit`/`offset` paginate application rows while counts always cover the whole active application pipeline. `awaiting_reply` counts applications with an unanswered contact; `follow_ups_due` counts due contacts, including explicitly pending actions after an inbound reply. `scheduled_stages` counts future or ongoing planned/in-progress stages; each row includes only the next one. Stage names remain free text; the server does not infer a submitted application or interview from a label. Use `get_job` for history, `get_follow_ups` for targeted waits, and `get_upcoming` for a complete schedule.

Salary fields `salary_min`, `salary_max`, `salary_currency`, and `salary_period` describe the employer’s pay range. Your own ask is stored separately in `salary_ask_amount`, `salary_ask_currency`, `salary_ask_period`, and `salary_ask_basis` (`gross`, `net`, or `null` when unknown). Add or edit it through `add_job`, `add_jobs`, or `update_job`; an amount requires currency and pay period, and clearing an ask requires all four fields to be null. `get_pipeline`, `list_jobs`, and `get_job` return these fields. Pipeline summaries show the ask with its units, or “Not recorded” when absent. Only save a user-provided or approved ask; employer budgets, market estimates, and generic applicant minimums must not become asks automatically.

`get_lead_context` loads selection criteria and a page of available opportunities for discovery, sorting, and ranking: active records plus rejected applications now eligible to reapply. Criteria also appear in the `careers://criteria` resource and the `rank_jobs` prompt. `list_jobs` returns jobs and pagination only, avoiding repeated criteria on ordinary searches and subsequent pages. These responses exclude applicant context and CV URLs.

`get_application_context` loads a separate natural-language document with the applicant's background, factual answers, and cover-letter or form-filling preferences, plus CV URLs keyed by language. Optional `job_id` adds that employer or application's details, stages, and feedback. It excludes selection criteria and unrelated leads. `get_job` returns the employer or application and its history. The `careers://application-context` resource exposes the same applicant document and CV URLs. Clients need to call a tool or read a resource to put saved data into the model's context. `get_lead_context` replaces the former `get_context` tool.

| Tool | Purpose |
| --- | --- |
| `get_pipeline` | Answer active pipeline/progress questions in one compact read, with counts, stage outcomes, waiting contacts, and next scheduled stages. |
| `get_lead_context` | Load selection criteria and active leads for discovery, sorting, and ranking. |
| `set_criteria` | Save or replace the user's single natural-language criteria document. |
| `get_application_context` | Load applicant profile, email/phone, context, and CV URLs, optionally with one job's history. |
| `set_application_context` | Save or replace applicant background and application-writing preferences; `text: null` clears it. |
| `set_applicant_contact` | Save your own application email/phone; omitted fields stay unchanged and `null` clears a field. |
| `set_applicant_profile` | Save your own self-described gender; `gender: null` clears the profile. |
| `set_cv` | Store or replace one CV URL by language; `url: null` removes that language. |
| `add_job` | Save one employer lead, or an application with explicit phase; record its UTC import time. |
| `add_jobs` | Save 1–100 employers or applications atomically without pre-filtering explicit imports. Split larger imports into batches of up to 100. |
| `list_jobs` | Search company, application title, or nickname; filter by phase/status and rank by score. |
| `get_job` | Load employer or application details, salary, stages, calendar details, and feedback. |
| `update_job` | Edit employer/contact details, salary, phase, status, stage, score, or application opening details. |
| `add_stage` | Add any named stage and optionally its schedule. |
| `update_stage` | Record an outcome, reschedule, or link a calendar event. |
| `update_contact` | Edit a person with actual communication history; cannot create contacts. |
| `record_outreach` | Log an actual outbound reach-out/follow-up or inbound reply, with event time and optional stage and follow-up date. |
| `update_outreach` | Correct communication details or schedule, resolve, or cancel its follow-up. |
| `get_follow_ups` | Retrieve waiting contacts directly, prioritizing pre-recruiter outreach, with last contact time, elapsed seconds, and due dates. |
| `add_feedback` | Append a transcript or feedback text to a stage. |
| `update_feedback` | Correct a feedback entry. |
| `list_feedback` | Review feedback across jobs and stage names to improve. |
| `get_upcoming` | Retrieve scheduled stages in a UTC time window. |
| `get_calendar_event` | Prepare arguments for the Google Calendar plugin. |

Example progression:

1. `set_criteria`: “Remote TypeScript roles, product teams, no onsite-only work.”
2. `get_lead_context`: load criteria and the pipeline, and check for an existing employer record. Save every explicitly supplied employer before assessing fit. When supplied openings are still leads, keep their employers without persisting opening details. Discovery finds and ranks employers; it does not require selecting a current opening or verifying application routes first.
3. `add_job`: save `company`, an optional employer `company_url`, nickname, recruiter contacts, employer notes, known salary range, and score. Use `add_jobs` for a batch. `phase` defaults to `lead`; `title`, `description`, `source_url`, and role `location` must be omitted. Do not copy opening details into employer notes, nicknames, or company URLs. Criteria and a fit assessment are optional for intake.
4. `list_jobs` returns the strongest scored leads first, with unranked leads last. Use `phase: "lead"` to select employers and `phase: "application"` to select applications. Rank employer research and known compensation with `rank_jobs` or `list_jobs`, then `update_job` with score and notes. Keep imported employers visible even when they conflict with discovery filters. Assessments never authorize rejecting or withdrawing them. Changing criteria preserves records and scores.
5. When the user starts applying, call `update_job` with `phase: "application"` on the employer record. Opening title, description, posting `source_url`, and location may now be saved. For an application already underway, `add_job`/`add_jobs` can set that phase at creation. Never mark a lead as an application just to save an opening. A freely named `current_stage` alone does not change this boundary. Add stages and concrete interview schedules as the application progresses.
6. After the round, use `update_stage` to mark `passed`, `failed`, or `completed`. Optionally add your verbatim reflection using `add_feedback`; no feedback is required.
7. Add another stage for the next round, or use `update_job` to mark the application `rejected`, `withdrawn`, `offer`, or `accepted`.

Opening storage is enforced in both the tools and D1: lead records must have null `title`, `description`, `source_url`, and `location`. Setting `phase: "lead"` clears those fields and resets `current_stage` to `lead`. Migration `0005_employer_leads.sql` clears legacy opening fields on records still at lead with no stage history. Existing records beyond lead or with stage history are retained as applications, preserving their opening details and child records. Employer notes are retained with exact copies of the removed title, description, and posting URL scrubbed. Contacts, rankings, IDs, and timestamps are preserved.

Salary ranges are stored in D1 on both employers and applications as `salary_min`, `salary_max`, `salary_currency`, and `salary_period`. For example, `{"company":"Example Co","salary_min":120000,"salary_max":160000,"salary_currency":"USD","salary_period":"year"}` creates an employer lead with known annual compensation. Either bound can be omitted for a one-sided range. Amounts may include fractions and must be nonnegative, with minimum no greater than maximum. A salary requires at least one bound, a three-letter uppercase currency code, and a period of `hour`, `day`, `week`, `month`, or `year`; currency and period are never inferred. Updates merge with existing values; clear all four fields with null to remove a salary. Salary data stays intact when moving between lead and application phases.

Both lead-import tools automatically record the time added in `created_at` as a UTC timestamp ending in `Z`. Updates preserve this original timestamp and change `updated_at`.

`add_jobs` accepts 1–100 records per call. Split larger imports into batches of up to 100 and account for every supplied employer. The storage layer also enforces this limit before accessing D1. Each batch is atomic: a validation error or duplicate saves none of that batch. Opening and salary validation errors identify the failing record number and confirm that zero records were saved. Correct the error and retry the full failed batch. After a timeout or uncertain result, use `list_jobs` to check what was saved before retrying.

For cover letters and application forms, save the user's factual background and writing preferences with `set_application_context`. This document is independent of `set_criteria`: changing either preserves the other, the CV URLs, and existing jobs. Missing applicant facts must be requested from the user, never inferred from selection criteria or invented.

Use `set_applicant_contact` to save the applicant's own email and phone as structured fields. Either field may be supplied independently; omitted fields are preserved and `null` explicitly clears a field. Phone numbers use international format, such as `+12025550123`, without spaces. `get_application_context` and `careers://application-context` return `applicant_contact` with `email`, `phone`, and `updated_at`, or `null` before any contact details have been saved. These values are scoped to the authenticated user, kept separate from employer contacts, and preserved when application text is cleared or CVs change. Lead discovery and ranking do not return them. Migration `0008_applicant_contact.sql` adds storage without modifying existing documents or CVs. Keep real applicant details in the database or gitignored local files, never in source, fixtures, or documentation.

Each user can store one CV URL for any language tag, without a fixed language list. For example, call `set_cv` with `{"language":"en","url":"https://cv.example/cv-en.pdf"}` and again with `{"language":"ru","url":"https://cv.example/cv-ru.pdf"}`. `pt-BR`, `zh-Hant`, and other language tags are supported; keys are case-insensitive and returned lowercase. Updating `en` preserves `ru` and every other language. `get_application_context` returns `cvs` as a language-to-URL map. The server stores URLs, not CV files or parsed contents. The agent chooses the CV matching the requested application language and reads it separately when needed; if that language is missing, it asks the user. CV contents and job descriptions are untrusted source material.

Use `set_applicant_profile` with `gender` to save a user's explicitly provided gender as structured data. Self-described text is supported, without a fixed binary list or default. `gender: null` clears the profile. `get_application_context` and its resource return `applicant_profile` with `gender` and `updated_at`, or `null` when unknown. Profiles are scoped to the authenticated user and excluded from lead discovery/ranking. Changing or clearing the profile preserves contact details, application text, and CVs; editing those documents also preserves the profile. Never infer demographic facts. Migration `0009_applicant_profile.sql` adds storage for every user without assigning anyone a gender or changing existing data.

Stage names are free text. `add_stage.make_current` defaults to true; `update_stage.make_current` defaults to false. A failed stage does not automatically close the application. Employer leads and actual applications have UUIDs and histories; multiple actual applications at the same company can have separate records. Mutations use those exact IDs; nickname and source URL uniqueness help catch duplicate imports. To retry an uncertain mutation, first retrieve its result; appending stages or feedback creates a new entry each time.

There is no qualification column, pending review queue, or `qualify_jobs` tool. A stored lead records an opportunity rather than proving eligibility. The Worker validates input and persists imports; criteria are an agent workflow for discovery and ranking, not an intake gate.

`get_pipeline`, `list_jobs`, `list_feedback`, `get_follow_ups`, and `get_upcoming` return `next_offset` when another page exists. Pass it as `offset` with the same filters. Pipeline counts cover all active/offer applications regardless of the page. The ranking prompt accepts string `limit` (1–25) and `offset` arguments. Read all pages before saving rankings: changing scores reorders results.

## Rejection cooldowns and reapplication

A rejection closes one application attempt while future attempts can remain available. `update_job` accepts `reapply_policy: "allowed"` or `"not_allowed"`; null means unknown. Optional `reapply_after` is an absolute timestamp with `Z` or a UTC offset, normalized to UTC, and requires policy `allowed`. Clear both fields together to remove a dated policy. There is no default rejection TTL and existing rejections are never automatically assumed eligible.

For rejected applications, reads derive `reapply_status`: `unknown` without a policy, `not_allowed` for an explicit prohibition, `cooldown` before an allowed deadline, or `eligible` at or after it. Allowed without a deadline means eligibility is already confirmed, including when the user says a cooldown has expired but the exact expiry date is unknown. Other application statuses return `not_applicable`. Expiration is evaluated at read time without a scheduled job, and it never rewrites the rejected outcome, failed interview stages, or feedback.

`get_lead_context` and `rank_jobs` include active records and eligible reapplications. Use `list_jobs` with `available_only: true` to paginate the same opportunities, or filter `reapply_status` directly. A `status: "active"` filter still means exactly active; rejected history remains accessible with `status: "rejected"`. Optional `list_jobs.as_of` previews cooldown eligibility at an explicit timestamp; it does not reconstruct historical application state. Eligibility and priority are separate: keep a user's decision to apply later in notes. When a fresh attempt actually starts, create its own application record and clear the previous attempt's policy and deadline together to consume that next-attempt eligibility and avoid listing both attempts as opportunities. Preserve the older stages and feedback.

Migration `0007_reapplication.sql` adds the policy and deadline without changing existing outcomes or inferring private interview dates. These facts belong in D1 or Git-ignored private exports, not source fixtures.

## Outreach and follow-ups

Communication is stored separately from stage scheduling and audit timestamps. Contacts are saved only after actual communication. There is no standalone contact-creation tool. For the first real outbound message or inbound communication, use `record_outreach` with `contact: {job_id, name, relationship, url, email, notes}`; only job_id and name are required inside contact. The contact and communication are committed atomically. For subsequent communications pass `contact_id` instead; supplying both or neither is rejected. `update_contact` edits an existing person with communication history and requires contact_id, job_id, and name. A friend helping with a referral is a `friend/referrer`, independently of any later recruiter. Duplicate URLs/emails for the same employer are rejected. `get_job` returns contacts and their IDs. Prospective referral shortlists stay in the conversation; do not store them in contact records, recruiter fields, or employer notes, and never invent outreach to persist a prospect.

Use `record_outreach` for each actual first reach-out, later follow-up, or received reply. `direction` is `outbound` or `inbound`. An optional `stage_id` ties the communication to a stage of the same job, such as `attempt_referral`. Contacts and outreach remain accessible after the current stage changes. Preparing a message or moving stages does not record a communication.

`occurred_at` is the communication timestamp, normalized from a timestamp with `Z` or a UTC offset. Explicit timestamps default to `time_basis: "reported"`. If the actual time is unknown, omit it: the server records now with `time_basis: "recorded"`, clearly identifying a logging-time fallback. When transferring an older attempt into the outreach log, use its original recorded timestamp with `time_basis: "recorded"`. The separate, immutable `created_at` records when the log entry was inserted; editing notes, contacts, follow-up dates, or stages never resets the outreach clock. Future communication times and impossible dates are rejected.

An outbound record starts a pending wait for that contact. Optional `follow_up_at` schedules a due date; there is no assumed interval. `update_outreach` can set/clear this date, correct the event timestamp, or set `follow_up_status` to `pending`, `done`, or `cancelled`. A newer communication supersedes the older wait: an inbound reply normally ends it, while a new outbound message starts a fresh wait without inheriting an old deadline. For an acknowledgement that needs checking later, explicitly set a date or pending status on the inbound record, such as a friend promising an introduction. This keeps a follow-up without fabricating an outbound message. `awaiting_reply` distinguishes unanswered outreach from these explicitly pending actions; `needs_follow_up` includes both. Backdated records are ordered by event time rather than insertion time. A reply from one contact never clears another contact's wait.

`get_follow_ups` reads pending waits across active/offer employers and applications without loading selection criteria or CVs. It returns the contact's relationship and URL, first and last outreach, last reply, timestamp basis, elapsed seconds, current stage, explicit due date, and whether it is due. Use `job_id`, `reached_out_before`, pagination, or `due_only` to narrow the response. `due_only` includes only explicit due dates at or before `as_of` (default now); waits with no chosen date remain visible in the default response. `as_of` controls due/age calculations, not historical reconstruction.

Early outreach and referral attempts have priority. When actual recruiter dialogue is evidenced, `update_job.recruiter_engaged_at` records that boundary in UTC; clear it with null to correct a mistake. A friend, an unanswered HR message, or a stage name alone does not establish recruiter engagement. `get_follow_ups` puts pre-recruiter waits first, and `pre_recruiter_only` filters to them. Later recruiter/interview/negotiation waits remain accessible with lower default priority. `list_jobs` includes last outreach/reply and the earliest pending follow-up date. No outreach tool sends a message or creates a reminder.

Migration `0006_outreach.sql` adds the contact and communication tables, indexed activity summaries, and the explicit recruiter-engagement boundary. Existing stage timestamps and notes are preserved; the migration does not infer communications from historical stage creation times. User/job/contact/stage ownership is enforced in both the tools and composite D1 foreign keys. Actual contacts and communication logs belong in D1 or Git-ignored private exports, never tracked fixtures or source.

## Read-only database queries

`scripts/d1.ts` uses this checkout's Wrangler authentication and remote `careers` database. It also loads `.env.deploy` when present. It accepts one `SELECT` or read-only CTE, wraps it in a subquery so SQL writes cannot execute, and checks that D1 reports no writes.

```fish
node scripts/d1.ts 'SELECT COUNT(*) AS count FROM jobs'
node scripts/d1.ts "SELECT name FROM pragma_table_info('jobs')"
```

Results print as JSON. Query results can contain private account or CRM data: redirect saved output into `private/` or `backups/`, which are Git-ignored. Environment files, `.cloudflare-api-token`, secret files, local databases, and `.wrangler/` backups are also ignored. Keep credentials and database exports out of tracked files; `AGENTS.md` requires this.

## Google Calendar integration

Connect this MCP and the [Google Calendar plugin](plugin://google-calendar@openai-curated-remote) to the same agent. The agent uses both: Careers stores the interview process, while Google Calendar performs calendar actions.

1. Save the stage with `starts_at` and, when known, `ends_at`. Inputs need `Z` or a UTC offset. Optional IANA `timezone` metadata can preserve the timezone you discussed; the default is UTC. Every stored timestamp and calendar draft uses UTC.
2. Call `get_calendar_event` with `stage_id`. It returns `missing_fields`, a suggested action, and `create_event_args`, `update_event_args`, or `delete_event_args` matching the connected plugin's tool names and fields.
3. Resolve missing start/end details before creating a timed event. Use Google Calendar's `get_availability` to check the relevant time window, with `response_timezone_str: "UTC"`.
4. For creation, call Google Calendar's `create_event` with the returned arguments. `attendees` defaults to `[]`, so a personal interview reminder does not invite the recruiter. Supply attendees to `get_calendar_event` only if invitations were requested. Calendar drafts include a stable `Careers MCP stage: <stage_id>` marker and omit feedback, rankings, and private CRM notes.
5. After Google confirms creation, call `update_stage` with its returned `calendar_event_id` and `calendar_id` (`primary` or a calendar ID from `list_calendars`).
6. For rescheduling, update the stage times, retrieve the draft, read the linked Google event, and call `update_event` using the same calendar/event IDs. The draft preserves guest membership; the agent can adjust guests through Google's tools after reading the event.
7. For cancellation, mark the stage `cancelled`, retrieve the delete arguments, and perform the user-requested deletion. Clear both saved IDs only after Google confirms deletion.

Before creating an event for an unlinked stage, search its bounded time window for the stage marker. This recovers a Google event created successfully when the response or the subsequent D1 write failed. If an event is linked, the draft selects update instead of creation. Changes in Google Calendar can be copied back through `update_stage`; this first iteration has agent-mediated synchronization rather than background polling.

Example `create_event_args`:

```json
{
  "calendar_id": "primary",
  "title": "Google — Screening (Software Engineer)",
  "start_time": "2026-11-02T17:00:00.000Z",
  "end_time": "2026-11-02T17:30:00.000Z",
  "timezone_str": "UTC",
  "attendees": [],
  "description": "Company: Google\nRole: Software Engineer\nStage: Screening\nCareers MCP stage: <stage_id>",
  "location": "https://meet.google.com/example",
  "visibility": "private"
}
```

UTC `Z` timestamps follow Google Calendar's [RFC3339 event time format](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert). Calendar clients display them in your selected local timezone. The server never calls Google directly and needs no Google credentials.

## Checks

```fish
aube run check
```

This runs the TypeScript 7 native preview compiler, Oxlint, integration tests, and a Worker deployment dry run. Tests boot Wrangler with an isolated temporary D1 database and exercise signed WebAuthn registration/login, OAuth/PKCE, token rotation/revocation, two-user isolation across MCP tools/resources/prompts, separate lead and application contexts, multilingual CV replacement/removal, employer intake without openings, rejection of opening details on leads, application transitions, structured salary ranges and validation, application imports without criteria or matching filters, multiple applications per company, source-URL schema compatibility, stable UTC creation times, criteria/ranking, stage outcomes, transcripts, UTC calendar drafts, validation, and atomic import rollback. Schema checks reject unowned records and cross-user foreign keys, and verify migrations preserve existing CRM data. Tests do not touch your development or remote database or create Google events.

The native compiler is pinned as `@typescript/native-preview`; `tsgo` performs type checking and Wrangler bundles TypeScript. After changing Worker bindings or secrets, regenerate `worker-configuration.d.ts` with `aube run types`. Commit `aube-lock.yaml` for reproducible installs (`aube install --frozen-lockfile`).
