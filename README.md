# Careers MCP

A personal job-search CRM exposed as an MCP server on Cloudflare Workers, backed by D1 SQLite. TypeScript, Valibot schemas, Aube, Oxlint, and the TypeScript 7 native compiler (`tsgo`).

Save an employer as a lead only after verifying a current opening passes the user's saved criteria. Employer-only placeholders, closed or unknown openings, and excluded roles are rejected, including explicit imports. Leads retain structured opening evidence; applications remain a separate phase for actual submissions and communication. Track predefined pipeline milestones, schedules, outcomes, recruiter details, and optional transcribed feedback.

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

The tracked `wrangler.jsonc` is for local development only. It has a synthetic database ID, no Cloudflare account ID, and disabled public deployment URLs. Active deployment hostnames, Worker names, account/database IDs, personal auth profiles, credentials, and user data are private: keep them out of Git, documentation, examples, fixtures, and generated files.

Create a private deployment configuration locally:

```fish
cp wrangler.jsonc wrangler.deploy.jsonc
chmod 600 wrangler.deploy.jsonc
```

Edit only the ignored `wrangler.deploy.jsonc`: set your Worker name, `account_id`, and D1 `database_name`/`database_id`; enable `workers_dev` or configure your own routes as needed. Keep `binding: "DB"`. The file lives beside the tracked config, so source and migration paths stay the same. Never put active settings back into `wrangler.jsonc`.

Authenticate using your own local Wrangler profile:

```fish
aube install --frozen-lockfile
aube exec -- wrangler auth create example-profile --scopes user:read account:read workers_scripts:write d1:write
aube exec -- wrangler auth activate example-profile
```

Choose your account in the browser and use your own profile name locally. Wrangler stores credentials and directory bindings outside Git. To refresh an expired profile, repeat `wrangler auth create` with the same name and scopes. The extra `--` after `aube exec` forwards flags to Wrangler.

For API-token authentication instead, copy `.env.deploy.example` to `.env.deploy`, restrict it with `chmod 600 .env.deploy`, and enter your token locally. Scope it to the intended account with Workers Scripts:Edit and D1:Edit; Account Settings:Read supports account discovery. Only the placeholder example is tracked. Remote migration and publish commands load `.env.deploy` through Node; local development, type generation, and builds do not load it. CI can supply `CLOUDFLARE_API_TOKEN` as an encrypted secret environment variable instead; existing environment variables take precedence over the file. Never put tokens in Wrangler config, command arguments, or committed files.

Once configured and authenticated, every deployment uses the Taskfile workflow:

```fish
task deploy
```

The task requires the ignored deployment config. It runs type checking, lint, integration tests, and a bundle dry run with the sanitized local config before applying remote D1 migrations and publishing with explicit `--config wrangler.deploy.jsonc`, then refreshes CareerMCP tools with `mcp-refresh refresh CareerMCP`. Remote commands fail if the private config is missing. Create a new Codex thread afterward to verify through the refreshed tools; existing threads retain their cached schemas.

A failed step stops the workflow. Already-applied migrations are skipped on subsequent runs. Migrations and publishing are separate operations: if publishing fails after a migration succeeds, fix the failure and rerun; future schema changes should remain compatible with the currently deployed Worker.

For a new account, create the database once with `aube exec -- wrangler d1 create example-database --config wrangler.deploy.jsonc --update-config=false`, then set the returned name and ID only in `wrangler.deploy.jsonc`. Local and remote D1 storage are separate. Generate types with `aube run types`, which explicitly uses the sanitized local config and placeholder environment file.

Use the address from your private deployment settings to connect an MCP client at `/mcp` and check `/health` (returns `{"ok":true}`). For example, a placeholder endpoint is `https://mcp.example.com/mcp`. Keep the real address and deployment output only in ignored local notes under `private/`. Users, credential public keys, challenges, sessions, clients, and OAuth grants use the same private D1 database; no extra database, KV namespace, or identity provider is needed.

The deploy command applies pending files in `migrations/` in order before publishing. Before changing production storage, export a full backup into a verified ignored `backups/` path and rehearse the migration on a private local copy. Verify existing values, row IDs, and foreign keys before applying it remotely.

Migration `0018_trigger_free_storage.sql` replaces the CRM tables with a schema containing zero triggers. It preserves every existing column and row ID, including legacy milestones, opening evidence, compensation, and related history. It compares the restored rows against its copies and aborts on any mismatch before discarding those copies. CHECK and UNIQUE constraints enforce row invariants; composite foreign keys require stages and outreach to belong to user-owned applications. Migration-only legacy fields remain internal to storage.

Every MCP tool handler receives a fresh database scope that permits one D1 batch. All validation reads, mutations, and returned rows execute in that transaction; a second execution is rejected. Current-criteria and freshness checks run alongside the writes, without preliminary or follow-up queries. The always-empty `command_checks` table uses named CHECK constraints to abort an entire batch on a failed cross-row assertion. Historical migrations remain unchanged; their triggers disappear when the affected tables are rebuilt.

Every store operation takes a user scope derived from a verified access token. Ownership is checked on reads, updates, rankings, parent-child links, resources, prompts, feedback searches, and calendar drafts. Nicknames (case-insensitive) and source URLs are unique within each user's jobs. Composite foreign keys reject stages and feedback attached to another user's records. Clients cannot supply or override a user ID.

WebAuthn requires discoverable credentials and user verification. Challenges are tied to a browser cookie, expire after five minutes, and are consumed once. Browser sessions last seven days. OAuth codes expire after one minute; access tokens last one hour, and refresh tokens rotate with a 30-day lifetime. Session and OAuth token values are stored only as SHA-256 hashes. Consent displays the client name and callback host; redirect URIs, PKCE, client IDs, and the MCP resource are checked before issuing tokens.

## Workflow and tools

The funnel goal is to maximize achievable job-offer compensation. Employer counts are bookkeeping, not a success metric. Opportunities enter only after meeting the saved selection criteria. A low fit score or temporary priority does not make an eligible opportunity ineligible; lower-ranked eligible roles may support interview practice.

Every stored lead is active. There are no withdrawn, rejected, disqualified, or archived leads. If an uncontacted lead no longer meets the criteria or its opening closes, resolve its ID and call `remove_lead`; it leaves storage instead of acquiring an exclusion status. This tool refuses applications and leads with stages, actual communication, or recruiter engagement, preserving real process history. `rejected`, `withdrawn`, `offer`, and `accepted` are application outcomes only, enforced by both MCP mutations and database guards. Applications cannot return to leads, even after resetting their status to active. Preserve each attempt and create a separate record for a new attempt. A lead must have `current_stage: "lead"`, no recruiter engagement, and no reapplication policy.

Migration `0017_job_lifecycle.sql` also recovers active records with real stages, outreach, recruiter engagement, or an application milestone as applications. It restores a missing current milestone from recorded history, clears meaningless reapplication settings on untouched leads, and preserves outcomes, timestamps, compensation, stages, contacts, outreach, and feedback. Transactional validation rejects application-to-lead changes; foreign keys reject stage/outreach writes against leads.

Migration `0016_active_leads.sql` removes historical inactive leads without process history. Records with real stages, communication, recruiter engagement, or offer/accepted outcomes are retained as applications, preserving their statuses, timestamps, compensation, and related history.

The server's MCP instructions tell the agent to choose context by task. `get_pipeline` answers current/active pipeline and progress questions in one compact read: full counts, active/offer applications, current stage outcomes, pending contacts and follow-up dates, and the next scheduled stage per application. It excludes untouched leads, closed applications (including eligible reapplications), long notes, selection criteria, and applicant documents. `as_of` supplies server time. Defaults to 25 applications ordered by last update; `limit`/`offset` paginate application rows while counts always cover the whole active application pipeline. `awaiting_reply` counts applications with an unanswered contact; `follow_ups_due` counts due contacts, including explicitly pending actions after an inbound reply. `scheduled_stages` counts future or ongoing planned/in-progress stages; each row includes only the next one. Use `get_job` for history, `get_follow_ups` for targeted waits, and `get_upcoming` for a complete schedule.

Pipeline milestones are predefined: `lead` (job `current_stage` only), `applied`, `outreach`, `recruiter_screen`, `assessment`, `technical_interview`, `system_design`, `hiring_manager`, `final_interview`, `reference_check`, and `offer`. `update_job.current_stage`, `add_stage.name`, and `update_stage.name` enforce this set in their MCP schemas and database write guards. Put round numbers and custom titles in stage notes. `applied` means an application was actually submitted; `outreach` means actual communication. Unsubmitted forms, drafts, browser tabs, and work awaiting human submission stay leads, with durable draft details in notes. They cannot be saved as “prepared” or another invented stage. New applications default to `applied`. The first `add_stage` or `record_outreach` on a lead atomically starts its application at the recorded milestone or `outreach`, respectively. The first stage becomes current even with `make_current: false`, because an application cannot retain the lead milestone. Stored opening evidence must still satisfy current criteria and the 24-hour check; refresh `eligible_opening` first if needed. Invalid or failed writes leave the lead unchanged. Stage outcomes and job outcomes retain their separate enums. The migration preserves historical labels and feedback without guessing what happened; an old label must be renamed to a valid milestone before making that stage current again.

Compensation is exposed as three separate fields in every job and active pipeline row:

| Field | Meaning |
| --- | --- |
| `employer_salary` | The employer's advertised or confirmed pay range. |
| `asked_salary` | The amount or range the applicant actually requested in a submitted form, message, or call. |
| `salary_target` | The applicant's private current negotiation target; this does not establish communication. |

Pipeline summaries must show **Employer range** and **Asked by applicant** as separate columns, including “Not recorded” for either missing value. A private target may be shown separately; it must never replace either fact.

Write `employer_salary` and `asked_salary` through `add_job`, `add_jobs`, or `update_job`. Each is a full-replacement object with `min`, `max`, `currency`, `period` (`hour`, `day`, `week`, `month`, `year`), `basis` (`gross` or `net`), original `text`, `source_url`, and `context` identifying the form/call and known date. Omitted members default to null. Use `min=max` for a single amount; one-sided ranges are supported. Unknown currency or period requires original text and stays null instead of being guessed. This keeps incomplete advertised bands visible in the pipeline without hiding them in prep notes.

For example, an employer might advertise `{ "min": 100000, "max": 120000, "currency": "USD", "text": "$100,000–120,000; period unspecified", "source_url": "https://jobs.example/engineer" }`. A separate actual ask could be `{ "min": 7000, "max": 8000, "currency": "EUR", "period": "month", "basis": "gross", "context": "Initial application form" }`. Neither value establishes a private target.

Setting either object to null clears only that group. Existing `salary_min/max/currency/period` inputs still mean employer pay; `salary_declared_amount/currency/period/basis` still mean a single actually communicated amount. These legacy values appear through the new objects without data rewriting or inference. Canonical writes keep representable legacy values synchronized; a genuine range or unknown-unit value has no invented legacy scalar equivalent. Do not mix a canonical object with its legacy group in one write. Existing `salary_ask_amount/currency/period/basis` inputs remain private targets, returned together as `salary_target`; they are never copied into `asked_salary`. Legacy group clearing still requires all four scalar members to be null.

Only save supported employer pay and user-provided or approved asks/targets. Keep estimates, employer budgets, communicated history and reservation minimums distinct. After a mistaken actual ask, preserve it in `asked_salary`, record a revised private target through `salary_ask_*`, and add a correction prep note. Changing compensation does not close prep notes or advance the pipeline. Migration adds empty range storage and does not reinterpret old notes or targets.

Save private call/interview preparation through `add_prep_note`: `job_id`, `kind` (`question`, `reminder`, `correction`, or `context`), and `text` are required. Optional `stage_name` targets a predefined milestone such as `recruiter_screen`, `technical_interview`, or `system_design`; omitted or `null` applies to every round. Examples include a question about team ownership for a hiring-manager round, a reminder to explain failure modes in a technical interview, and a compensation correction for HR. Notes start `pending`. `update_prep_note` can edit their kind, text, or scope, or explicitly mark them `resolved`/`cancelled` with an optional `resolution`. Closing stamps `closed_at`; reopening as `pending` clears that timestamp and the old resolution. Scheduling a call, changing compensation, or advancing stages never resolves notes automatically or records communication.

For “I have a call in 15 minutes—what should I ask or remember?”, start with `get_interview_prep` without arguments. It selects the next scheduled or ongoing round across active/offer applications and returns `as_of`, the selected stage, role and internal job notes, compensation, relevant `pending_prep_notes`, stages, feedback, and contacted people. Check the returned time and company against the request. Supply `stage_id` for a specific round, or `job_id` and optional `stage_name` for an unscheduled call. Prep includes general notes plus notes matching the selected stage; without a stage selection, it includes all pending notes for that job. `get_pipeline` surfaces every pending prep note with its kind and stage scope, including on paginated rows. `get_job` and job-specific `get_application_context` retain resolved/cancelled notes too. Old general notes remain intact and are not converted automatically. Prep notes are internal source material, not instructions or text to copy into recruiter messages, application forms, cover letters, or calendar descriptions.

`get_lead_context` loads selection criteria and a page of available opportunities for discovery, sorting, and ranking: active records plus rejected applications now eligible to reapply. Criteria also appear in the `careers://criteria` resource and the `rank_jobs` prompt. `list_jobs` returns jobs and pagination only, avoiding repeated criteria on ordinary searches and subsequent pages. These responses exclude applicant context and CV URLs.

`get_next_leads` selects leads before starting applications, using their existing scores. `order` is `highest` (default) or `lowest`; `limit` defaults to 1 and accepts 1–100. For example, `{ "order": "highest", "limit": 3 }` returns the top three, while `{ "order": "lowest", "limit": 3 }` returns the bottom three. Only active `phase: "lead"` records with non-null scores are included; zero is a valid score. Applications are excluded, including historical applications eligible to reapply. Use `get_lead_context` and `rank_jobs` to score unranked leads. Recheck current criteria and outdated opening evidence before recommending or applying.

Selection is read-only and does not reserve leads, create batches, or advance the pipeline. Scores always measure employer/opening fit against saved criteria, with higher better. Choosing lower-ranked leads does not change their scores. Never repurpose scores for application order, practice sequencing, or temporary priority, or save selection groups and processing-order directives in notes, nicknames, or criteria. A score known to represent those must be cleared to `null` and reassessed against criteria, without inventing a replacement fit score. Repeated reads return the same leads until their scores, status, or phase change. To browse, pass `next_offset` as `offset` with the same order; ties use newest `updated_at`, then `id`. After actual submission, change that lead's phase individually. Recording actual outreach or a pipeline stage starts the application atomically. `list_jobs` also accepts `score_order: "highest" | "lowest"` (default `highest`) and `ranked_only: true`; otherwise unranked records appear last in both directions.

`get_application_context` loads a separate natural-language document with the applicant's background, factual answers, and cover-letter or form-filling preferences, plus CV URLs keyed by language. Optional `job_id` adds that employer or application's details, stages, and feedback. It excludes selection criteria and unrelated leads. `get_job` returns the employer or application and its history. The `careers://application-context` resource exposes the same applicant document and CV URLs. Clients need to call a tool or read a resource to put saved data into the model's context. `get_lead_context` replaces the former `get_context` tool.

| Tool | Purpose |
| --- | --- |
| `get_pipeline` | Answer active pipeline/progress questions in one compact read, with counts, stage outcomes, waiting contacts, and next scheduled stages. |
| `get_interview_prep` | Prepare for the next scheduled/ongoing round, a specific stage, or an unscheduled job call; return applicable notes, role details, compensation, and feedback. |
| `add_prep_note` | Save a private question, reminder, correction, or context note for all rounds or one stage type. |
| `update_prep_note` | Edit a prep note or resolve, cancel, or reopen it, preserving its creation timestamp. |
| `get_lead_context` | Load selection criteria and active leads for discovery, sorting, and ranking. |
| `get_next_leads` | Read the next one or more highest- or lowest-ranked active leads before applying, without changing state. |
| `set_criteria` | Save or replace the user's single natural-language criteria document. |
| `get_application_context` | Load applicant profile, email/phone, context, and CV URLs, optionally with one job's history. |
| `set_application_context` | Save or replace applicant background and application-writing preferences; `text: null` clears it. |
| `set_applicant_contact` | Save your own application email/phone; omitted fields stay unchanged and `null` clears a field. |
| `set_applicant_profile` | Save your own self-described gender; `gender: null` clears the profile. |
| `set_cv` | Store or replace one CV URL by language; `url: null` removes that language. |
| `add_job` | Save one employer lead, or an application with explicit phase; record its UTC import time. |
| `add_jobs` | Save 1–100 eligible leads or actual applications atomically; explicit lead imports use the same eligibility gate. Split larger imports into batches of up to 100. |
| `list_jobs` | Search company, application title, or nickname; filter by phase/status and rank by score. |
| `get_job` | Load employer or application details, salary, stages, calendar details, and feedback. |
| `update_job` | Edit employer/contact details, salary, phase, application outcomes, stage, score, or opening details; leads stay active. |
| `remove_lead` | Remove an uncontacted lead that no longer meets the criteria or whose opening closed; preserve actual application and communication history. |
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
2. `get_lead_context`: load current criteria and check for duplicate employers. Read a live posting and apply every hard exclusion before saving a lead. If no eligible opening exists, skip the employer and explain why in the conversation.
3. `add_job` or `add_jobs`: `phase` defaults to `lead`. Supply `company` and `eligible_opening` with `title`, full `description`, posting `source_url`, `location`, `status: "open"`, `eligibility: "eligible"`, `checked_at`, `criteria_updated_at` copied from the saved criteria, and `eligibility_reason` explaining why the role passes the exclusions. Verification must be within the last 24 hours, never in the future. Missing or outdated criteria, incomplete evidence, closed roles and exclusions are rejected. Explicit imports have no exemption. Employer URLs, notes, salaries and scores cannot substitute for this evidence.
4. Rank eligible opportunities with `rank_jobs` or `list_jobs`, then save score and notes with `update_job`. Reassess old evidence against current criteria before recommending a role. Scores never override exclusions.
   Use `get_next_leads` to select one or more leads from either end of the ranking before applying; selection leaves them as leads.
5. After an actual submission or real outreach/recruiter communication starts the process, set `phase: "application"`. Unsubmitted forms and drafts stay leads. Top-level `title`, `description`, `source_url` and `location` belong to this application; lead evidence remains in `eligible_opening`. Every new application record also needs current eligible opening evidence; choosing this phase never bypasses validation. Existing histories remain unchanged. Never label a lead an application to bypass the gate.
6. Add a stage for each round; record schedules, outcomes and optional feedback. A failed round does not automatically reject the whole application.
7. Applications cannot return to `phase: "lead"` or the lead milestone. Changing an employer or employer URL, or explicitly reconfirming a lead as active, requires fresh `eligible_opening` evidence. Preserve actual application history; a new attempt gets its own record.

Migrations `0011_eligible_openings.sql` and `0012_all_job_openings.sql` introduced opening evidence validation. Migration `0018_trigger_free_storage.sql` replaces their triggers with row constraints and explicit validation in each mutation's transaction. New records in either phase require valid open/eligible evidence, current user-owned criteria, and a verification timestamp within 24 hours. Material lead edits and explicit active-status reconfirmation use the same gate. Batches roll back on any invalid record, and duplicate lead posting URLs are rejected per user. Legacy records, IDs, timestamps, contacts, stages and feedback are preserved without inventing eligibility; historical leads return `eligible_opening: null` until researched. Routine notes and salary edits remain available for legacy records. Both `get_job` and `list_jobs` return structured evidence.

The agent must read the posting and evaluate natural-language criteria honestly. The Worker enforces required evidence, freshness, current criteria and explicit open/eligible status; it does not independently fetch postings or use an LLM to establish whether the submitted facts are true.

Salary ranges are stored in D1 on both employers and applications as `salary_min`, `salary_max`, `salary_currency`, and `salary_period`. For example, `{"salary_min":120000,"salary_max":160000,"salary_currency":"USD","salary_period":"year"}` records a known annual range alongside a lead’s required opening evidence. Either bound can be omitted for a one-sided range. Amounts may include fractions and must be nonnegative, with minimum no greater than maximum. A salary requires at least one bound, a three-letter uppercase currency code, and a period of `hour`, `day`, `week`, `month`, or `year`; currency and period are never inferred. Updates merge with existing values; clear all four fields with null to remove a salary. Salary data stays intact when moving between lead and application phases.

Both lead-import tools automatically record the time added in `created_at` as a UTC timestamp ending in `Z`. Updates preserve this original timestamp and change `updated_at`.

`add_jobs` accepts 1–100 records per call. Split larger imports into batches of up to 100 and account for every supplied employer. The storage layer also enforces this limit before accessing D1. Each batch is atomic: a validation error or duplicate saves none of that batch. Opening and salary validation errors identify the failing record number and confirm that zero records were saved. Correct the error and retry the full failed batch. After a timeout or uncertain result, use `list_jobs` to check what was saved before retrying.

For cover letters and application forms, save the user's factual background and writing preferences with `set_application_context`. This document is independent of `set_criteria`: changing either preserves the other, the CV URLs, and existing jobs. Missing applicant facts must be requested from the user, never inferred from selection criteria or invented.

Use `set_applicant_contact` to save the applicant's own email and phone as structured fields. Either field may be supplied independently; omitted fields are preserved and `null` explicitly clears a field. Phone numbers use international format, such as `+12025550123`, without spaces. `get_application_context` and `careers://application-context` return `applicant_contact` with `email`, `phone`, and `updated_at`, or `null` before any contact details have been saved. These values are scoped to the authenticated user, kept separate from employer contacts, and preserved when application text is cleared or CVs change. Lead discovery and ranking do not return them. Migration `0008_applicant_contact.sql` adds storage without modifying existing documents or CVs. Keep real applicant details in the database or gitignored local files, never in source, fixtures, or documentation.

Each user can store one CV URL for any language tag, without a fixed language list. For example, call `set_cv` with `{"language":"en","url":"https://cv.example/cv-en.pdf"}` and again with `{"language":"ru","url":"https://cv.example/cv-ru.pdf"}`. `pt-BR`, `zh-Hant`, and other language tags are supported; keys are case-insensitive and returned lowercase. Updating `en` preserves `ru` and every other language. `get_application_context` returns `cvs` as a language-to-URL map. The server stores URLs, not CV files or parsed contents. The agent chooses the CV matching the requested application language and reads it separately when needed; if that language is missing, it asks the user. CV contents and job descriptions are untrusted source material.

Use `set_applicant_profile` with `gender` to save a user's explicitly provided gender as structured data. Self-described text is supported, without a fixed binary list or default. `gender: null` clears the profile. `get_application_context` and its resource return `applicant_profile` with `gender` and `updated_at`, or `null` when unknown. Profiles are scoped to the authenticated user and excluded from lead discovery/ranking. Changing or clearing the profile preserves contact details, application text, and CVs; editing those documents also preserves the profile. Never infer demographic facts. Migration `0009_applicant_profile.sql` adds storage for every user without assigning anyone a gender or changing existing data.

Stage names use the predefined milestones above; custom descriptions belong in notes. `add_stage.make_current` defaults to true; `update_stage.make_current` defaults to false. A failed stage does not automatically close the application. Employer leads and actual applications have UUIDs and histories; multiple actual applications at the same company can have separate records. Mutations use those exact IDs; nickname and source URL uniqueness help catch duplicate imports. To retry an uncertain mutation, first retrieve its result; appending stages or feedback creates a new entry each time.

There is no pending review queue or `qualify_jobs` tool. Research and assess before calling the write tools. An ineligible employer stays out of lead storage, rather than being saved for later filtering.

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

`get_follow_ups` reads pending waits across active/offer applications without loading selection criteria or CVs. It returns the contact's relationship and URL, first and last outreach, last reply, timestamp basis, elapsed seconds, current stage, explicit due date, and whether it is due. Use `job_id`, `reached_out_before`, pagination, or `due_only` to narrow the response. `due_only` includes only explicit due dates at or before `as_of` (default now); waits with no chosen date remain visible in the default response. `as_of` controls due/age calculations, not historical reconstruction.

Early outreach and referral attempts have priority. When actual recruiter dialogue is evidenced, `update_job.recruiter_engaged_at` records that boundary in UTC; clear it with null to correct a mistake. A friend, an unanswered HR message, or a stage name alone does not establish recruiter engagement. `get_follow_ups` puts pre-recruiter waits first, and `pre_recruiter_only` filters to them. Later recruiter/interview/negotiation waits remain accessible with lower default priority. `list_jobs` includes last outreach/reply and the earliest pending follow-up date. No outreach tool sends a message or creates a reminder.

Migration `0006_outreach.sql` adds the contact and communication tables, indexed activity summaries, and the explicit recruiter-engagement boundary. Existing stage timestamps and notes are preserved; the migration does not infer communications from historical stage creation times. User/job/contact/stage ownership is enforced in both the tools and composite D1 foreign keys. Actual contacts and communication logs belong in D1 or Git-ignored private exports, never tracked fixtures or source.

## Read-only database queries

`scripts/d1.ts` uses this checkout's Wrangler authentication and the remote `DB` binding in the ignored `wrangler.deploy.jsonc`; it fails if that config is missing. It also loads `.env.deploy` when present. It accepts one `SELECT` or read-only CTE, wraps it in a subquery so SQL writes cannot execute, and checks that D1 reports no writes.

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

This runs the TypeScript 7 native preview compiler, Oxlint, integration tests, and a Worker deployment dry run. Tests boot Wrangler with an isolated temporary D1 database and exercise signed WebAuthn registration/login, OAuth/PKCE, token rotation/revocation, two-user isolation across MCP tools/resources/prompts, separate lead and application contexts, multilingual CV replacement/removal, rejection of employer-only, closed, excluded and stale leads, structured opening evidence, application transitions, active-only lead guards, eligibility removal and preservation of actual application/communication history, structured salary ranges and validation, application-phase bypass rejection, multiple applications per company, source-URL schema compatibility, stable UTC creation times, criteria/ranking, stage outcomes, transcripts, UTC calendar drafts, validation, and atomic import rollback. Schema checks reject unowned records and cross-user foreign keys, and verify migrations preserve existing CRM data. Tests do not touch your development or remote database or create Google events.

The native compiler is pinned as `@typescript/native-preview`; `tsgo` performs type checking and Wrangler bundles TypeScript. After changing Worker bindings or secrets, regenerate `worker-configuration.d.ts` with `aube run types`. Commit `aube-lock.yaml` for reproducible installs (`aube install --frozen-lockfile`).
