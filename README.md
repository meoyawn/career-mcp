# Careers MCP

A personal job-search CRM exposed as an MCP server on Cloudflare Workers, backed by D1 SQLite. TypeScript, Valibot schemas, Aube, Oxlint, and the TypeScript 7 native compiler (`tsgo`).

Server instructions, tool descriptions and prompts document storage, retrieval and API constraints. Job-search objectives, application strategy, review budgets and outbound authorization belong to the calling workspace.

JSON response objects omit unset/null properties recursively across tools, resources and prompts. Missing `next_offset` means the last page; a completely unset result is `{}`. Zero, `false`, empty strings, empty objects and empty arrays are preserved. Write arguments still accept `null` to clear fields according to their schemas; omitted patch fields stay unchanged.

Save an employer as a lead only after verifying a current opening passes the user's saved criteria. Employer-only lead placeholders, closed or unknown openings, and excluded leads are rejected, including explicit imports. Actual applications are independent records of submissions and communication: they require no search criteria, ranking or opening assessment. Track predefined pipeline milestones, schedules, outcomes, recruiter details, and optional transcribed feedback.

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

`wrangler.jsonc` is the real deployment configuration: Worker name, Cloudflare account ID and D1 database ID. These IDs are not credentials; deploying requires Cloudflare authentication. Credentials, auth profile names and user data stay out of Git.

Authenticate locally with your own Wrangler profile:

```fish
aube install --frozen-lockfile
aube exec -- wrangler auth create example-profile --scopes user:read account:read workers_scripts:write d1:write
aube exec -- wrangler auth activate example-profile
```

Wrangler binds the profile to this directory and stores its credentials outside Git. To refresh an expired profile, repeat `wrangler auth create` with the same name and scopes. The extra `--` after `aube exec` forwards flags to Wrangler. Alternatively, export `CLOUDFLARE_API_TOKEN`; a token takes precedence over the profile.

Deploy with:

```fish
task deploy
```

It runs type checking, lint, integration tests and a bundle dry run, then applies remote D1 migrations and publishes the Worker. A failed step stops the deploy. Already-applied migrations are skipped on later runs. If publishing fails after a migration succeeds, fix the failure and rerun; keep schema changes compatible with the currently deployed Worker.

Pushes to `master` run the same `task deploy` through `.github/workflows/deploy.yml`. It needs one repository secret, `CLOUDFLARE_API_TOKEN`: an account-owned token for the deployment account with Workers Scripts:Edit and D1:Edit.

For a new account, create the database once with `aube exec -- wrangler d1 create example-database --update-config=false` and put the returned name and ID in `wrangler.jsonc`. Tests use an isolated temporary database, and local development uses Wrangler's local D1 state. Generate types with `aube run types`.

Connect an MCP client at `/mcp` on the deployed Worker and check `/health` (returns `{"ok":true}`). Users, credential public keys, challenges, sessions, clients, and OAuth grants use the same D1 database; no extra database, KV namespace, or identity provider is needed.

The deploy command applies pending files in `migrations/` in order before publishing. Every migration has focused migration tests; table rebuilds and stored-data rewrites abort if their preservation checks fail.

Migration `0018_trigger_free_storage.sql` replaces the CRM tables with a schema containing zero triggers. It preserves every existing column and row ID, including legacy milestones, opening evidence, compensation, and related history. It compares the restored rows against its copies and aborts on any mismatch before discarding those copies. CHECK and UNIQUE constraints enforce row invariants; composite foreign keys require stages and outreach to belong to user-owned jobs. Migration-only legacy fields remain internal to storage.

Every MCP tool handler receives a fresh database scope that permits one D1 batch. All validation reads, mutations, and returned rows execute in that transaction; a second execution is rejected. Lead-selection criteria and freshness checks run alongside lead writes, without preliminary or follow-up queries. Application writes do not depend on these checks. The always-empty `command_checks` table uses named CHECK constraints to abort an entire batch on a failed cross-row assertion. Historical migrations remain unchanged; their triggers disappear when the affected tables are rebuilt.

Every store operation takes a user scope derived from a verified access token. Ownership is checked on reads, updates, rankings, parent-child links, resources, prompts, feedback searches, and calendar drafts. Nicknames (case-insensitive) are unique within each user's jobs; selected posting URLs are unique among unsubmitted leads. Application source URLs may repeat across distinct processes. Composite foreign keys reject stages and feedback attached to another user's records. Clients cannot supply or override a user ID.

WebAuthn requires discoverable credentials and user verification. Challenges are tied to a browser cookie, expire after five minutes, and are consumed once. Browser sessions last seven days. OAuth codes expire after one minute; access tokens last one hour, and refresh tokens rotate with a 30-day lifetime. Session and OAuth token values are stored only as SHA-256 hashes. Consent displays the client name and callback host; redirect URIs, PKCE, client IDs, and the MCP resource are checked before issuing tokens.

## Workflow and tools

An employer lead can retain multiple actual openings. `job_openings` gives each role a stable UUID, its canonical URL, title, description, location, independent status (`open`, `closed`, `unknown`), check time, employer salary, private salary target and notes, all stored as plain columns. The CRM stores no eligibility verdict: decide whether a role fits before saving it. A new employer lead needs an open opening; a new actual application does not. Additional research candidates may be retained only under an existing record, without creating duplicate employer leads or advancing an application.

| Tool | Use |
| --- | --- |
| `save_opening` | Supply `job_id` and a complete `opening` assessment. Upserts by exact `source_url`, preserving the role's ID. Optional `employer_salary` and `notes` replace only their own values; omission preserves them. |
| `list_openings` | Supply `job_id`; optionally filter `status` and paginate with `limit`/`offset`. Returns all roles, including unknown and closed roles, plus each role's `selected` flag. |
| `select_opening` | Supply `job_id` and `opening_id` to choose a lead's current role. Requires an open role checked within 24 hours. Clears the old fit score and uses the chosen role's saved employer salary/private target, omitting unknown values from the response. Previous role compensation remains saved on that role. |

`get_job` and `get_application_context(job_id)` include every opening. `list_jobs` searches their role titles and reports `opening_count`, `selected_opening_id`, `opening_status`, which describes the selected role. `available_only` and `get_next_leads` require that role to be open. Retaining an alternative does not automatically select it.

The `opening` field on a job (formerly `eligible_opening`) is the selected role: `add_job`, `add_jobs`, and `update_job` synchronize it with child openings, keeping previous roles. Its canonical URL identifies the selected role; there is no second mutable pointer. It is a snapshot from the last open check, so use the current `opening_status` field when a later check marks the role closed or unknown. Refreshing the selected lead with `save_opening` updates this snapshot only when the role is open, and then requires a check within 24 hours. New checks cannot predate the saved check or closure. `close_opening` remains compatible for the selected role; use `save_opening` with `status:closed` to close an alternative.

Selecting another role is allowed only on leads. Actual applications retain their destination, stages, outcomes, outreach and actually requested pay; `update_job` cannot replace an application's `opening` URL. Research alternatives can still be retained under that record, but a new actual submission needs its own application attempt. Migration `0020_multiple_openings.sql` adds child storage and copies existing selected evidence, including known closures, employer pay and private targets, without modifying existing employer/application rows or their histories. No user data is inferred from notes and no unknown roles are promoted to eligible.

Every stored lead is active. There are no withdrawn, rejected, disqualified, or archived leads. `remove_lead` deletes an uncontacted lead rather than assigning an exclusion status; it refuses applications and leads with stages, communication or recruiter engagement. `rejected`, `withdrawn`, `offer`, and `accepted` are application outcomes only, enforced by both MCP mutations and database guards. Applications cannot return to leads, even after resetting their status to active. Separate attempts have separate records. A lead must have `current_stage: "lead"`, no recruiter engagement, and no reapplication policy.

Migration `0017_job_lifecycle.sql` also recovers active records with real stages, outreach, recruiter engagement, or an application milestone as applications. It restores a missing current milestone from recorded history, clears meaningless reapplication settings on untouched leads, and preserves outcomes, timestamps, compensation, stages, contacts, outreach, and feedback. Transactional validation rejects application-to-lead changes; foreign keys reject stage/outreach writes against leads.

Migration `0016_active_leads.sql` removes historical inactive leads without process history. Records with real stages, communication, recruiter engagement, or offer/accepted outcomes are retained as applications, preserving their statuses, timestamps, compensation, and related history.

`get_pipeline_counts` returns **Applications**, **Interviews**, and **Rejections**, with the rejection date range. Applications counts open submitted/outreach processes without a confirmed round; Interviews counts open interview/assessment processes, including scheduled rounds and waiting between rounds. These counters are disjoint. Offers and closed attempts are excluded from both. Only Rejections uses a date window: `rejected_from`/`rejected_to` are inclusive UTC-normalized timestamps, defaulting to three calendar months ending now (or ending at the supplied `rejected_to`), with month-end clamping. Changing this window never filters current applications or interviews. No application rows, compensation, prep notes, contacts, schedules or pagination are returned.

Migration `0021_rejection_dates.sql` adds nullable `jobs.rejected_at` without rewriting historical data. `update_job.rejected_at` edits a known rejection date, including on older rejected attempts: supply `YYYY-MM-DD` (stored as midnight UTC for that calendar date), an ISO timestamp with Z/offset, or null for unknown. Non-null dates require a rejected application and cannot be in the future. An omitted date is preserved through unrelated edits and repeated rejected-status writes; a newly rejected application defaults to server time. Changing the outcome clears an omitted rejection date. The date appears in `get_job` and `list_jobs`. Older rejections remain undated until corrected from user-confirmed or verified evidence; `rejection_window.undated` reports how many are excluded. A nonzero unknown count must be disclosed and the dated count labeled as confirmed, including when it is zero. Never use mutable `updated_at`, an import date, or a failed stage to guess a rejection date.

Migration `0025_job_outcomes.sql` adds nullable `jobs.outcome` without parsing or rewriting existing notes. It holds what explains the current non-active status (`rejected`, `withdrawn`, `offer` or `accepted`): `message` is the verbatim communication, such as an employer's rejection or the applicant's withdrawal note; `reason` is a reason the deciding party actually stated, never an inferred one; `source_url` points to where the message can be read; `context` holds provenance such as the sender, message ID or snapshot path. An outcome needs `message` or `reason`. Set it with `update_job.outcome` in the same call as `status`; a later `outcome` replaces it and `null` clears it. Unrelated edits and repeated writes of the same status preserve it. Changing to another status without `outcome` clears it, so one status's reason never describes another. The database rejects an outcome on a lead or an active application. Keep job `notes` for other context. `get_job` returns the outcome; `list_jobs` returns it with notes and omits both when `include_notes: false`.

For an explicit active pipeline or application list/details request, `get_pipeline` retains its existing compact read: full counts, submitted/active/offer applications, current stage outcomes, pending contacts and follow-up dates, and the next scheduled stage per application. Each row's derived `pipeline_status` distinguishes `submitted` (no confirmed round), `active` (a non-cancelled interview/assessment has a schedule or is in progress, passed, failed, or completed), and `offer`. Submission, outreach, recruiter replies, and unscheduled planned rounds alone stay submitted. Active includes scheduled calls, later technical rounds, and waiting between rounds, even without a future appointment. Show upcoming rounds as scheduled within Active using `next_stage`. Stored job `status: "active"` means open; use `pipeline_status` for progress instead. The legacy detailed response retains `summary.submitted + summary.active + summary.offers = summary.applications`; count-only replies use the new counters instead. These classifications are calculated on each read without rewriting outcomes or history.

`get_pipeline` excludes untouched leads, closed applications (including eligible reapplications), long notes, selection criteria, and applicant documents. `as_of` supplies server time. Defaults to 25 applications ordered by last update; `limit`/`offset` paginate application rows while counts always cover the whole open application pipeline. `awaiting_reply` counts applications with an unanswered contact; `follow_ups_due` counts due contacts, including explicitly pending actions after an inbound reply. `scheduled_stages` counts future or ongoing planned/in-progress stages; each row includes only the next one. Use `get_job` for history, `get_follow_ups` for targeted waits, and `get_upcoming` for a complete schedule.

Pipeline milestones are predefined: `lead` (job `current_stage` only), `applied`, `outreach`, `recruiter_screen`, `assessment`, `technical_interview`, `system_design`, `hiring_manager`, `final_interview`, `reference_check`, and `offer`. `update_job.current_stage`, `add_stage.name`, and `update_stage.name` enforce this set in their MCP schemas and database write guards. Put round numbers and custom titles in stage notes. `applied` means an application was actually submitted; `outreach` means actual communication. Unsubmitted forms, drafts, browser tabs, and work awaiting human submission stay leads, with durable draft details in notes. They cannot be saved as “prepared” or another invented stage. New applications default to `applied`. The first `add_stage` or `record_outreach` on a lead atomically starts its application at the recorded milestone or `outreach`, respectively. The first stage becomes current even with `make_current: false`, because an application cannot retain the lead milestone. These transitions and `update_job` with `phase:application` do not require current search criteria, fit ranking or refreshed opening evidence, even if the recorded assessment is stale, unknown or closed. Existing assessments remain unchanged. Invalid or failed writes leave the lead unchanged. Stage outcomes and job outcomes retain their separate enums. The migration preserves historical labels and feedback without guessing what happened; an old label must be renamed to a valid milestone before making that stage current again.

Compensation is exposed as three separate fields in every job and active pipeline row:

| Field | Meaning |
| --- | --- |
| `employer_salary` | The employer's advertised or confirmed pay range. |
| `asked_salary` | The amount or range the applicant actually requested in a submitted form, message, or call. |
| `salary_target` | The applicant's private current negotiation target; this does not establish communication. |

Pipeline rows expose employer pay, communicated asks and private targets separately. Missing values are omitted. Count-only responses contain no compensation.

Write `employer_salary` and `asked_salary` through `add_job`, `add_jobs`, or `update_job`. Each is a full-replacement object with `min`, `max`, `currency`, `period` (`hour`, `day`, `week`, `month`, `year`), `basis` (`gross` or `net`), original `text`, `source_url`, and `context` identifying the form/call and known date. Omitted members default to null. Use `min=max` for a single amount; one-sided ranges are supported. Unknown currency or period requires original text and stays null instead of being guessed. This keeps incomplete advertised bands visible in the pipeline without hiding them in prep notes.

For example, an employer might advertise `{ "min": 100000, "max": 120000, "currency": "USD", "text": "$100,000–120,000; period unspecified", "source_url": "https://jobs.example/engineer" }`. A separate actual ask could be `{ "min": 7000, "max": 8000, "currency": "EUR", "period": "month", "basis": "gross", "context": "Initial application form" }`. Neither value establishes a private target.

Setting either object to null clears only that group. Existing `salary_min/max/currency/period` inputs still mean employer pay; `salary_declared_amount/currency/period/basis` still mean a single actually communicated amount. These legacy values appear through the new objects without data rewriting or inference. Canonical writes keep representable legacy values synchronized; a genuine range or unknown-unit value has no invented legacy scalar equivalent. Do not mix a canonical object with its legacy group in one write. Existing `salary_ask_amount/currency/period/basis` inputs remain private targets, returned together as `salary_target`; they are never copied into `asked_salary`. Legacy group clearing still requires all four scalar members to be null.

Changing compensation does not close prep notes or advance the pipeline. Private target updates do not rewrite communicated asks. Migration adds empty range storage and does not reinterpret old notes or targets.

Save private call/interview preparation through `add_prep_note`: `job_id`, `kind` (`question`, `reminder`, `correction`, or `context`), and `text` are required. Optional `stage_name` targets a predefined milestone such as `recruiter_screen`, `technical_interview`, or `system_design`; omitted or `null` applies to every round. Examples include a question about team ownership for a hiring-manager round, a reminder to explain failure modes in a technical interview, and a compensation correction for HR. Notes start `pending`. `update_prep_note` can edit their kind, text, or scope, or explicitly mark them `resolved`/`cancelled` with an optional `resolution`. Closing stamps `closed_at`; reopening as `pending` clears that timestamp and the old resolution. Scheduling a call, changing compensation, or advancing stages never resolves notes automatically or records communication.

For “I have a call in 15 minutes—what should I ask or remember?”, start with `get_interview_prep` without arguments. It selects the next scheduled or ongoing round across active/offer applications and returns `as_of`, the selected stage, role and internal job notes, compensation, relevant `pending_prep_notes`, stages, feedback, and contacted people. Check the returned time and company against the request. Supply `stage_id` for a specific round, or `job_id` and optional `stage_name` for an unscheduled call. Prep includes general notes plus notes matching the selected stage; without a stage selection, it includes all pending notes for that job. `get_pipeline` surfaces every pending prep note with its kind and stage scope, including on paginated rows. `get_job` and job-specific `get_application_context` retain resolved/cancelled notes too. Old general notes remain intact and are not converted automatically. Prep notes are internal source material, not instructions or text to copy into recruiter messages, application forms, cover letters, or calendar descriptions.

`get_lead_context` loads selection criteria and a page of available opportunities: active records plus rejected applications now eligible to reapply. It accepts `limit` (default 5, range 1–100), `offset` (default 0), `include_descriptions` and `include_notes` (both default false). The available and closed-posting pages have separate `next_offset` values. Continue available opportunities through `list_jobs` with `available_only: true`, and closed leads with `phase: "lead", opening_status: "closed"`. Criteria also appear in the `careers://criteria` resource and the optional `rank_jobs` prompt, which is not a tool. `list_jobs` returns jobs and pagination only, avoiding repeated criteria on subsequent pages. These responses exclude applicant context and CV URLs.

`list_jobs.query` searches company, role titles, nickname and posting URLs, including alternative openings under an existing record. Use the canonical vacancy URL or its platform ID for duplicate lookup; descriptions and notes are not needed for that lookup. Matches remain scoped to the authenticated user and honor the other filters.

List reads omit both top-level and `opening.description` text by default, preserving opening URLs, check dates, compensation and ranking fields. `list_jobs` and `get_next_leads` retain complete notes by default; `get_lead_context` omits notes unless `include_notes: true`. `list_jobs` also accepts `include_notes: false`. `include_descriptions: true` on `list_jobs` or `get_lead_context` returns full descriptions; `get_job` returns the complete record and history. Projection and pagination do not alter stored data.

`get_next_leads` returns leads using saved manual priorities first and fit scores second. `order` is `highest` (default) or `lowest` for fit scores; `limit` defaults to 1 and accepts 1–100. Only active `phase: "lead"` records with a non-null score or priority are included; zero is a valid score. Applications are excluded, including historical applications eligible to reapply.

Selection is read-only and does not reserve leads, create batches, or advance the pipeline. Scores represent employer/opening fit against saved criteria, with higher better; manual ordering is separate. Repeated reads return the same leads until their priority, score, status, or phase changes. Pagination accepts `next_offset` as `offset` with the same order; ties use newest `updated_at`, then `id`. Score/priority updates can reorder pages. Recording outreach or a pipeline stage can start an application atomically. `list_jobs` also accepts `score_order: "highest" | "lowest"` (default `highest`) and `ranked_only: true`, which includes scored or prioritized records.

`update_job.priority` stores a manual pin: a positive integer from 1 to 1000000, with lower numbers first; `null` removes the pin. `list_jobs`, `get_lead_context` and `get_next_leads` sort these pins before fit scores regardless of score direction. `get_pipeline` sorts them before recency. Normal filters and pagination still apply, including closed-role and lead/application boundaries. Priority edits preserve fit scores and existing history. Migration `0023_manual_priority.sql` adds the nullable field without rewriting existing records.

`get_application_context` loads a separate natural-language document with the applicant's background, form answers, and cover-letter or form-filling preferences, plus CV URLs keyed by language. Optional `job_id` adds that employer or application's details, stages, and feedback. It excludes selection criteria and unrelated leads. `get_job` returns one record and its history without applicant context. Application work can use these reads and `list_jobs` to resolve an existing record, without loading `get_lead_context`, `get_next_leads`, `careers://criteria` or `rank_jobs`. The `careers://application-context` resource exposes the applicant document and CV references. `get_lead_context` replaces the former `get_context` tool.

| Tool | Purpose |
| --- | --- |
| `get_pipeline_counts` | Answer status/progress/count questions with current Applications and Interviews plus Rejections in a default three-month window and its explicit dates. |
| `get_pipeline` | Return the requested active pipeline/application list and details, with counts, stage outcomes, waiting contacts, and next scheduled stages. |
| `get_interview_prep` | Prepare for the next scheduled/ongoing round, a specific stage, or an unscheduled job call; return applicable notes, role details, compensation, and feedback. |
| `add_prep_note` | Save a private question, reminder, correction, or context note for all rounds or one stage type. |
| `update_prep_note` | Edit a prep note or resolve, cancel, or reopen it, preserving its creation timestamp. |
| `get_lead_context` | Load selection criteria and active leads for discovery, sorting, and ranking. |
| `get_next_leads` | Return ranked/pinned active leads without changing state. |
| `set_criteria` | Save or replace the user's single natural-language criteria document. |
| `get_application_context` | Load applicant profile, email/phone, context, and CV URLs, optionally with one job's history. |
| `set_application_context` | Save or replace applicant background and application-writing preferences; `text: null` clears it. |
| `set_applicant_contact` | Save your own application email/phone; omitted fields stay unchanged and `null` clears a field. |
| `set_applicant_profile` | Save your own self-described gender; `gender: null` clears the profile. |
| `set_cv` | Store or replace one CV URL by language; `url: null` removes that language. |
| `add_job` | Save one employer lead, or an application with explicit phase; record its UTC import time. |
| `add_jobs` | Save 1–100 leads or actual applications atomically; lead imports use the same open-role validation. Split larger imports into batches of up to 100. |
| `list_jobs` | Search company, application title, or nickname; filter by phase/status and rank by score. |
| `get_job` | Load employer or application details, salary, stages, calendar details, and feedback. |
| `update_job` | Edit employer/contact details, salary, phase, application status and its `outcome` message/reason, stage, score, or opening details; leads stay active. |
| `close_opening` | Preserve a closed posting and employer for replacement research without changing an application outcome. |
| `remove_lead` | Delete an uncontacted lead; rejects applications and records with recruiter engagement, stage or communication history. |
| `add_stage` | Add a predefined pipeline milestone and optional schedule. |
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

Record lifecycle and validation:

- `set_criteria` stores one natural-language document, returned by `get_lead_context` and `careers://criteria`.
- `add_job`/`add_jobs` default to `phase: "lead"`. Leads require `company` and a complete `opening` (`title`, `description`, `source_url`, `location`, `status: "open"`, `checked_at`). `checked_at` must be within 24 hours, not future-dated. Saved criteria are not required. Lead imports use the same validation.
- The fetched role details satisfy the opening fields; they do not require an applicant review, employer inventory or ranking. `score`, `company_url`, compensation and notes are optional. Saving an unranked lead succeeds without invoking `rank_jobs`; it remains discoverable through `list_jobs` and `get_lead_context`, while `get_next_leads` requires a score or pin. A successful write returns the stored record; another read is needed only when the outcome is uncertain or further data is required.
- `score` and `priority` affect ordering without changing phase. Record reads do not advance the pipeline.
- `phase: "application"` records submission or communication. Top-level role fields belong to that attempt; lead role details belong in `opening`. Actual applications need no criteria document, score or `opening`. An optional opening keeps its historical check date without a 24-hour refresh; structure, non-future timestamps and newer-evidence/destination protections still apply.
- Stages have separate schedules and outcomes. A failed stage does not reject the whole application.
- Applications cannot return to leads. Employer changes and explicit active-lead reconfirmation require a fresh opening only while remaining a lead. Each new application attempt has a separate record.

Migrations `0011_eligible_openings.sql` and `0012_all_job_openings.sql` introduced opening evidence validation. Migration `0018_trigger_free_storage.sql` replaces their triggers with row constraints and explicit validation in each mutation's transaction. Migration `0024_application_selection_separation.sql` limits the required-evidence constraint to leads; application creation and transitions no longer depend on lead-selection criteria or freshness. It preserves every existing value and row ID, including all child histories, opening assessments, closures, rejection dates and manual priorities, and aborts on preservation or foreign-key mismatches. Child schemas, indexes and views remain intact. Material lead edits and explicit active-status reconfirmation retain their current-criteria gate. Mixed batches roll back on any invalid lead or application, and duplicate lead posting URLs are rejected per user. Legacy records are preserved without inventing eligibility; historical leads omit unset `eligible_opening` until researched. Routine notes and salary edits remain available for legacy records. Both `get_job` and `list_jobs` return structured evidence when present. Migration `0026_remove_eligibility.sql` removes stored eligibility: it strips `eligibility`, `eligibility_reason` and `criteria_updated_at` from saved openings, renames `eligible_opening` to `opening`, turns `job_openings` JSON evidence into plain columns, and drops every generated column (including the constant `job_phase` on stages and outreach, whose application-only rule is enforced in the mutation transaction). It keeps every other value and row ID and aborts on preservation or foreign-key mismatches.

For lead selection, the agent reads the posting and evaluates the saved natural-language criteria before saving the lead. The Worker enforces a complete, open, recently checked opening and stores no eligibility verdict; it does not independently fetch or evaluate postings. Recording an actual application is independent of that selection process.

Salary ranges are stored in D1 on both employers and applications as `salary_min`, `salary_max`, `salary_currency`, and `salary_period`. For example, `{"salary_min":120000,"salary_max":160000,"salary_currency":"USD","salary_period":"year"}` records a known annual range alongside a lead’s required opening. Either bound can be omitted for a one-sided range. Amounts may include fractions and must be nonnegative, with minimum no greater than maximum. A salary requires at least one bound, a three-letter uppercase currency code, and a period of `hour`, `day`, `week`, `month`, or `year`; currency and period are never inferred. Updates merge with existing values; clear all four fields with null to remove a salary. Salary data stays intact when moving between lead and application phases.

Both lead-import tools automatically record the time added in `created_at` as a UTC timestamp ending in `Z`. Updates preserve this original timestamp and change `updated_at`.

`add_jobs` accepts 1–100 records per call. Split larger imports into batches of up to 100 and account for every supplied employer. The storage layer also enforces this limit before accessing D1. Each batch is atomic: a validation error or duplicate saves none of that batch. Opening and salary validation errors identify the failing record number and confirm that zero records were saved. Correct the error and retry the full failed batch. After a timeout or uncertain result, use `list_jobs` to check what was saved before retrying.

`set_application_context` stores a natural-language applicant document. It is independent of `set_criteria`: changing either preserves the other, the CV references, and existing jobs. Clearing application text preserves contact details and profile data too.

Use `set_applicant_contact` to save the applicant's own email and phone as structured fields. Either field may be supplied independently; omitted fields are preserved and `null` explicitly clears a field. Phone numbers use international format, such as `+12025550123`, without spaces. `get_application_context` and `careers://application-context` return `applicant_contact` with `email`, `phone`, and `updated_at`, or `null` before any contact details have been saved. These values are scoped to the authenticated user, kept separate from employer contacts, and preserved when application text is cleared or CVs change. Lead discovery and ranking do not return them. Migration `0008_applicant_contact.sql` adds storage without modifying existing documents or CVs. Keep real applicant details in the database or gitignored local files, never in source, fixtures, or documentation.

Each user can store one CV URL for any language tag, without a fixed language list. For example, call `set_cv` with `{"language":"en","url":"https://cv.example/cv-en.pdf"}` and again with `{"language":"ru","url":"https://cv.example/cv-ru.pdf"}`. `pt-BR`, `zh-Hant`, and other language tags are supported; keys are case-insensitive and returned lowercase. Updating `en` preserves `ru` and every other language. `get_application_context` returns `cvs` as a language-to-URL map. The server stores URLs, not CV files, parsed contents or attachment selections.

Use `set_applicant_profile` with `gender` to save a user's explicitly provided gender as structured data. Self-described text is supported, without a fixed binary list or default. `gender: null` clears the profile. `get_application_context` and its resource return `applicant_profile` with `gender` and `updated_at`, or `null` when unknown. Profiles are scoped to the authenticated user and excluded from lead discovery/ranking. Changing or clearing the profile preserves contact details, application text, and CVs; editing those documents also preserves the profile. Never infer demographic facts. Migration `0009_applicant_profile.sql` adds storage for every user without assigning anyone a gender or changing existing data.

Stage names use the predefined milestones above; custom descriptions belong in notes. `add_stage.make_current` defaults to true; `update_stage.make_current` defaults to false. A failed stage does not automatically close the application. Employer leads and actual applications have UUIDs and histories; multiple actual applications at the same company can have separate records. Mutations use those exact IDs; nickname and selected lead posting URL uniqueness help catch duplicate imports. To retry an uncertain mutation, first retrieve its result; appending stages or feedback creates a new entry each time.

There is no pending review queue or `qualify_jobs` tool. Research and assess before saving leads; record actual applications and communication without rerunning that selection process. An unsuitable employer stays out of lead storage, rather than being saved for later filtering, but its actual application history remains recordable.

`get_pipeline`, `list_jobs`, `list_feedback`, `get_follow_ups`, and `get_upcoming` return `next_offset` when another page exists. Pass it as `offset` with the same filters. Pipeline counts cover all active/offer applications regardless of the page. The ranking prompt accepts string `limit` (1–25) and `offset` arguments. Read all pages before saving rankings: changing scores reorders results.

## Rejection cooldowns and reapplication

A rejection closes one application attempt while future attempts can remain available. `update_job` accepts `reapply_policy: "allowed"` or `"not_allowed"`; null means unknown. Optional `reapply_after` is an absolute timestamp with `Z` or a UTC offset, normalized to UTC, and requires policy `allowed`. Clear both fields together to remove a dated policy. There is no default rejection TTL and existing rejections are never automatically assumed eligible.

For rejected applications, reads derive `reapply_status`: `unknown` without a policy, `not_allowed` for an explicit prohibition, `cooldown` before an allowed deadline, or `eligible` at or after it. Allowed without a deadline means eligibility is already confirmed, including when the user says a cooldown has expired but the exact expiry date is unknown. Other application statuses return `not_applicable`. Expiration is evaluated at read time without a scheduled job, and it never rewrites the rejected outcome, failed interview stages, or feedback.

`get_lead_context` and `rank_jobs` include active records and eligible reapplications. Use `list_jobs` with `available_only: true` to paginate the same opportunities, or filter `reapply_status` directly. A `status: "active"` filter still means exactly active; rejected history remains accessible with `status: "rejected"`. Optional `list_jobs.as_of` previews cooldown eligibility at an explicit timestamp; it does not reconstruct historical application state. Eligibility and priority are separate: keep a user's decision to apply later in notes. When a fresh attempt actually starts, create its own application record and clear the previous attempt's policy and deadline together to consume that next-attempt eligibility and avoid listing both attempts as opportunities. Preserve the older stages and feedback. Each application/interview process is a separate `jobs` row with its own UUID and outcome, even when employer, role and posting URL match. A rejected attempt and a later attempt with an offer coexist; stages, feedback, contacts and outreach remain attached to their own attempt. Do not reopen a rejected row to represent a new process. Migration `0022_application_attempts.sql` replaces the application source-URL unique index with a normal lookup index, preserving every existing row and leaving lead deduplication intact.

Migration `0007_reapplication.sql` adds the policy and deadline without changing existing outcomes or inferring private interview dates. These facts belong in D1 or Git-ignored private exports, not source fixtures.

## Closed openings and replacements

Use `close_opening` with `job_id`, the exact posting `source_url`, and a `reason` after confirming a closure (for example, HTTP 404). `checked_at` defaults to now. Access blocking or parser failures alone do not prove closure. This preserves the employer, original evidence, notes, application outcome, stages, and communication history while clearing the stale fit score. Repeated calls are idempotent for the job/URL.

`list_jobs` exposes `opening_status` (`open`, `closed`, or `unknown`); open means saved evidence, not an automatic live check. Filter `opening_status: "closed"` to research replacements. `get_lead_context.replacement_search` includes these retained leads with its own `next_offset`; paginate through `list_jobs` with `phase: "lead"` and `opening_status: "closed"`. `available_only` and `get_next_leads` exclude known closed postings. Recording an actual application or communication remains possible without reopening a closed posting or changing its historical evidence.

`update_job.opening` or `save_opening`/`select_opening` can replace a lead's selected role. A reopened URL requires verification newer than its closure. `get_job.opening_closures` retains previous closure evidence. Applications retain their original destination; a different application attempt has a separate record. Closure alone does not reject or withdraw an application.

Migration `0019_opening_closures.sql` adds a table with ownership foreign keys without rewriting existing records or adding triggers.

## Outreach and follow-ups

Communication is stored separately from stage scheduling and audit timestamps. Contacts require communication; there is no standalone contact-creation tool. `record_outreach` accepts `contact: {job_id, name, relationship, url, email, notes}` for a new person; only job_id and name are required inside contact. The contact and communication are committed atomically. Existing people use `contact_id`; supplying both or neither is rejected. `update_contact` requires contact_id, job_id, and name. Duplicate URLs/emails for the same employer are rejected. `get_job` returns contacts and their IDs.

Use `record_outreach` for each actual first reach-out, later follow-up, or received reply. `direction` is `outbound` or `inbound`. An optional `stage_id` ties the communication to a stage of the same job, such as `attempt_referral`. Contacts and outreach remain accessible after the current stage changes. Preparing a message or moving stages does not record a communication.

`occurred_at` is the communication timestamp, normalized from a timestamp with `Z` or a UTC offset. Explicit timestamps default to `time_basis: "reported"`. If the actual time is unknown, omit it: the server records now with `time_basis: "recorded"`, clearly identifying a logging-time fallback. When transferring an older attempt into the outreach log, use its original recorded timestamp with `time_basis: "recorded"`. The separate, immutable `created_at` records when the log entry was inserted; editing notes, contacts, follow-up dates, or stages never resets the outreach clock. Future communication times and impossible dates are rejected.

An outbound record starts a pending wait for that contact. Optional `follow_up_at` schedules a due date; there is no assumed interval. `update_outreach` can set/clear this date, correct the event timestamp, or set `follow_up_status` to `pending`, `done`, or `cancelled`. A newer communication supersedes the older wait: an inbound reply normally ends it, while a new outbound message starts a fresh wait without inheriting an old deadline. For an acknowledgement that needs checking later, explicitly set a date or pending status on the inbound record, such as a friend promising an introduction. This keeps a follow-up without fabricating an outbound message. `awaiting_reply` distinguishes unanswered outreach from these explicitly pending actions; `needs_follow_up` includes both. Backdated records are ordered by event time rather than insertion time. A reply from one contact never clears another contact's wait.

`get_follow_ups` reads pending waits across active/offer applications without loading selection criteria or CVs. It returns the contact's relationship and URL, first and last outreach, last reply, timestamp basis, elapsed seconds, current stage, explicit due date, and whether it is due. Use `job_id`, `reached_out_before`, pagination, or `due_only` to narrow the response. `due_only` includes only explicit due dates at or before `as_of` (default now); waits with no chosen date remain visible in the default response. `as_of` controls due/age calculations, not historical reconstruction.

`update_job.recruiter_engaged_at` stores the recruiter-dialogue boundary in UTC; null clears it. `get_follow_ups` sorts pre-recruiter waits first, and `pre_recruiter_only` filters to them. Later waits remain accessible with lower default sort priority. `list_jobs` includes last outreach/reply and the earliest pending follow-up date. No outreach tool sends a message or creates a reminder.

Migration `0006_outreach.sql` adds the contact and communication tables, indexed activity summaries, and the explicit recruiter-engagement boundary. Existing stage timestamps and notes are preserved; the migration does not infer communications from historical stage creation times. User/job/contact/stage ownership is enforced in both the tools and composite D1 foreign keys. Actual contacts and communication logs belong in D1 or Git-ignored private exports, never tracked fixtures or source.

## Read-only database queries

`scripts/d1.ts` uses your Wrangler authentication and the remote `DB` binding from `wrangler.jsonc`. It accepts one `SELECT` or read-only CTE, wraps it in a subquery so SQL writes cannot execute, and checks that D1 reports no writes.

```fish
node scripts/d1.ts 'SELECT COUNT(*) AS count FROM jobs'
node scripts/d1.ts "SELECT name FROM pragma_table_info('jobs')"
```

Results print as JSON. Query results can contain private account or CRM data: redirect saved output into `private/` or `backups/`, which are Git-ignored. Environment files, `.cloudflare-api-token`, secret files, local databases, and `.wrangler/` backups are also ignored. Keep credentials and database exports out of tracked files; `AGENTS.md` requires this.

## Google Calendar integration

`get_calendar_event(stage_id)` returns draft arguments compatible with the Google Calendar API, a suggested action and `missing_fields`. It does not call Google or check availability. Calendar operations are external to the CRM.

Stage times require `Z` or a UTC offset and normalize to UTC. Optional IANA `timezone` metadata is stored alongside them. The draft contains `create_event_args`, `update_event_args` or `delete_event_args`; linked event IDs select update, while a cancelled linked stage selects deletion.

`attendees` defaults to `[]`. Drafts include a stable `Careers MCP stage: <stage_id>` marker and omit feedback, rankings and private CRM notes. `update_stage` stores `calendar_event_id` and `calendar_id` as external references; storing or clearing them does not perform a calendar action. There is no background synchronization.

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

This runs the TypeScript 7 native preview compiler, Oxlint, integration tests, and a Worker deployment dry run. Tests boot Wrangler with an isolated temporary D1 database and exercise signed WebAuthn registration/login, OAuth/PKCE, token rotation/revocation, two-user isolation across MCP tools/resources/prompts, separate lead and application contexts, multilingual CV replacement/removal, rejection of employer-only, closed, malformed and stale leads, structured openings, application transitions, active-only lead guards, lead removal and preservation of actual application/communication history, structured salary ranges and validation, application-phase bypass rejection, multiple applications per company, source-URL schema compatibility, stable UTC creation times, criteria/ranking, stage outcomes, transcripts, UTC calendar drafts, validation, and atomic import rollback. Schema checks reject unowned records and cross-user foreign keys, and verify migrations preserve existing CRM data. Tests do not touch your development or remote database or create Google events.

The native compiler is pinned as `@typescript/native-preview`; `tsgo` performs type checking and Wrangler bundles TypeScript. After changing Worker bindings or secrets, regenerate `worker-configuration.d.ts` with `aube run types`. Commit `aube-lock.yaml` for reproducible installs (`aube install --frozen-lockfile`).
