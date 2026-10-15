import * as v from "valibot";
import { eligibleOpeningSchema, maxJobsPerBatch, pipelineStageSchema, type AddFeedback, type AddJobs, type AddStage, type CalendarEvent, type EligibleOpening, type FollowUps, type ListFeedback, type ListJobs, type Pipeline, type RecordOutreach, type SetApplicantContact, type Upcoming, type UpdateContact, type UpdateFeedback, type UpdateJob, type UpdateOutreach, type UpdateStage } from "./schemas.ts";

export interface UserStore {
  db: D1Database;
  userId: string;
}

interface Criteria {
  user_id: string;
  text: string;
  updated_at: string;
}

interface ApplicationContext {
  text: string;
  updated_at: string;
}

interface ApplicantContact {
  email: string | null;
  phone: string | null;
  updated_at: string;
}

interface ApplicantProfile {
  gender: string;
  updated_at: string;
}

interface CV {
  language: string;
  url: string;
}

interface Job {
  id: string;
  company: string;
  company_url: string | null;
  phase: "lead" | "application";
  eligible_opening: string | null;
  title: string | null;
  nickname: string | null;
  description: string | null;
  source_url: string | null;
  location: string | null;
  recruiter_name: string | null;
  recruiter_email: string | null;
  notes: string | null;
  status: string;
  current_stage: string;
  recruiter_engaged_at: string | null;
  reapply_policy: "allowed" | "not_allowed" | null;
  reapply_after: string | null;
  score: number | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: "hour" | "day" | "week" | "month" | "year" | null;
  salary_ask_amount: number | null;
  salary_ask_currency: string | null;
  salary_ask_period: "hour" | "day" | "week" | "month" | "year" | null;
  salary_ask_basis: "gross" | "net" | null;
  created_at: string;
  updated_at: string;
}

interface Stage {
  id: string;
  job_id: string;
  name: string;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string | null;
  location: string | null;
  contact_name: string | null;
  contact_email: string | null;
  notes: string | null;
  calendar_event_id: string | null;
  calendar_id: string | null;
  created_at: string;
  updated_at: string;
}

interface Feedback {
  id: string;
  stage_id: string;
  text: string;
  source: string;
  created_at: string;
  updated_at: string;
}

interface Contact {
  id: string;
  job_id: string;
  name: string;
  relationship: string;
  url: string | null;
  email: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface Outreach {
  id: string;
  job_id: string;
  contact_id: string;
  stage_id: string | null;
  direction: "outbound" | "inbound";
  occurred_at: string;
  time_basis: "reported" | "recorded";
  channel: string | null;
  notes: string | null;
  follow_up_at: string | null;
  follow_up_status: "pending" | "done" | "cancelled" | null;
  created_at: string;
  updated_at: string;
}

interface ContactActivity extends Contact {
  last_interaction_id: string | null;
  last_interaction_direction: "outbound" | "inbound" | null;
  last_interaction_at: string | null;
  last_interaction_time_basis: "reported" | "recorded" | null;
  last_interaction_recorded_at: string | null;
  last_interaction_stage_id: string | null;
  first_outreach_at: string | null;
  last_outreach_at: string | null;
  last_response_at: string | null;
  awaiting_reply: number;
  needs_follow_up: number;
  follow_up_at: string | null;
}

interface PipelineSummary {
  applications: number;
  active: number;
  offers: number;
  awaiting_reply: number;
  follow_ups_due: number;
  scheduled_stages: number;
}

interface PipelineJob extends Pick<Job, "id" | "company" | "title" | "source_url" | "status" | "current_stage" | "recruiter_engaged_at" | "salary_min" | "salary_max" | "salary_currency" | "salary_period" | "salary_ask_amount" | "salary_ask_currency" | "salary_ask_period" | "salary_ask_basis"> {
  current_stage_status: string | null;
  last_outreach_at: string | null;
  last_response_at: string | null;
}

type PipelineContact = Pick<ContactActivity, "id" | "job_id" | "name" | "relationship" | "url" | "email" | "awaiting_reply" | "follow_up_at" | "last_interaction_at" | "last_interaction_time_basis" | "last_outreach_at" | "last_response_at">;
type PipelineStage = Pick<Stage, "id" | "job_id" | "name" | "status" | "starts_at" | "ends_at" | "timezone">;

function fail(message: string): never {
  throw new Error(message, { cause: "user" });
}

export const getCriteria = ({ db, userId }: UserStore) => db.prepare("SELECT * FROM criteria WHERE user_id IS ?").bind(userId).first<Criteria>();

export function setCriteria({ db, userId }: UserStore, text: string) {
  return db.prepare(`INSERT INTO criteria (user_id, text, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
    RETURNING *`).bind(userId, text, new Date().toISOString()).first<Criteria>();
}

export async function getApplicationContext({ db, userId }: UserStore) {
  const [applicationContext, applicantContact, applicantProfile, cvs] = await Promise.all([
    db.prepare("SELECT text, updated_at FROM application_context WHERE user_id IS ?").bind(userId).first<ApplicationContext>(),
    db.prepare("SELECT email, phone, updated_at FROM applicant_contact WHERE user_id IS ?").bind(userId).first<ApplicantContact>(),
    db.prepare("SELECT gender, updated_at FROM applicant_profile WHERE user_id IS ?").bind(userId).first<ApplicantProfile>(),
    db.prepare("SELECT language, url FROM cvs WHERE user_id IS ? ORDER BY language").bind(userId).all<CV>(),
  ]);
  return { application_context: applicationContext, applicant_contact: applicantContact, applicant_profile: applicantProfile, cvs: Object.fromEntries(cvs.results.map((cv) => [cv.language, cv.url])) };
}

export async function setApplicantProfile({ db, userId }: UserStore, gender: string | null) {
  if (gender === null) {
    await db.prepare("DELETE FROM applicant_profile WHERE user_id IS ?").bind(userId).run();
    return null;
  }
  return db.prepare(`INSERT INTO applicant_profile (user_id, gender, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET gender = excluded.gender, updated_at = excluded.updated_at
    RETURNING gender, updated_at`).bind(userId, gender, new Date().toISOString()).first<ApplicantProfile>();
}

export function setApplicantContact({ db, userId }: UserStore, input: SetApplicantContact) {
  if (input.email === undefined && input.phone === undefined) fail("Supply email or phone; use null to clear a field.");
  return db.prepare(`INSERT INTO applicant_contact (user_id, email, phone, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      email = CASE WHEN ? THEN excluded.email ELSE applicant_contact.email END,
      phone = CASE WHEN ? THEN excluded.phone ELSE applicant_contact.phone END,
      updated_at = excluded.updated_at
    RETURNING email, phone, updated_at`)
    .bind(userId, input.email ?? null, input.phone ?? null, new Date().toISOString(),
      Number(input.email !== undefined), Number(input.phone !== undefined)).first<ApplicantContact>();
}

export async function setApplicationContext({ db, userId }: UserStore, text: string | null) {
  if (text === null) {
    await db.prepare("DELETE FROM application_context WHERE user_id IS ?").bind(userId).run();
    return null;
  }
  return db.prepare(`INSERT INTO application_context (user_id, text, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
    RETURNING text, updated_at`).bind(userId, text, new Date().toISOString()).first<ApplicationContext>();
}

export async function setCV({ db, userId }: UserStore, language: string, url: string | null) {
  language = language.toLowerCase();
  if (url === null) {
    await db.prepare("DELETE FROM cvs WHERE user_id IS ? AND language IS ?").bind(userId, language).run();
  } else {
    await db.prepare(`INSERT INTO cvs (user_id, language, url, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, language) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at`)
      .bind(userId, language, url, new Date().toISOString()).run();
  }
  return { language, url };
}

function duplicateError(error: unknown): never {
  if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
    fail("A nickname or source URL already exists. Use list_jobs to find the existing job; choose a distinct nickname for another opening.");
  }
  throw error;
}

function validateOpening(phase: Job["phase"], input: Pick<UpdateJob, "title" | "description" | "source_url" | "location">) {
  if (phase === "lead" && [input.title, input.description, input.source_url, input.location].some((value) => value != null)) {
    fail("Top-level opening details require an application. For a lead, put the verified role in eligible_opening; set phase to application only when the user starts applying.");
  }
}

function validateEligibleOpening(input: unknown, criteria: Criteria | null) {
  const result = v.safeParse(eligibleOpeningSchema, input);
  if (!result.success) fail("Every new job record requires a verified eligible opening: title, description, source_url, location, status:open, eligibility:eligible, checked_at, criteria_updated_at, and eligibility_reason. Excluded, closed, unknown, and employer-only records cannot be saved; phase:application does not bypass this check.");
  if (!criteria) fail("Save selection criteria before adding jobs, then verify an open role against those criteria.");
  const opening = result.output;
  if (normalizeTimestamp(opening.criteria_updated_at) !== criteria.updated_at) fail("Opening eligibility uses outdated criteria. Load get_lead_context and reassess against the current criteria.");
  const checkedAt = normalizeTimestamp(opening.checked_at);
  const age = Date.now() - Date.parse(checkedAt);
  if (age < 0 || age > 24 * 60 * 60 * 1_000) fail("Verify the opening is still open within the last 24 hours; checked_at cannot be in the future.");
  return { ...opening, checked_at: checkedAt, criteria_updated_at: criteria.updated_at };
}

function withEligibleOpening<T extends Pick<Job, "eligible_opening">>(job: T) {
  return { ...job, eligible_opening: job.eligible_opening === null ? null : v.parse(eligibleOpeningSchema, JSON.parse(job.eligible_opening)) };
}

function validateSalary(input: Pick<UpdateJob, "salary_min" | "salary_max" | "salary_currency" | "salary_period">) {
  const { salary_min: min, salary_max: max, salary_currency: currency, salary_period: period } = input;
  if ([min, max, currency, period].every((value) => value == null)) return;
  if ((min == null && max == null) || currency == null || period == null) {
    fail("Salary needs at least one amount, a currency, and a pay period. Clear all four salary fields to remove it.");
  }
  if (min != null && max != null && min > max) fail("salary_min must not exceed salary_max.");
}

function validateSalaryAsk(input: Pick<UpdateJob, "salary_ask_amount" | "salary_ask_currency" | "salary_ask_period" | "salary_ask_basis">) {
  const { salary_ask_amount: amount, salary_ask_currency: currency, salary_ask_period: period, salary_ask_basis: basis } = input;
  if ([amount, currency, period, basis].every((value) => value == null)) return;
  if (amount == null || currency == null || period == null) {
    fail("Salary ask needs salary_ask_amount, salary_ask_currency, and salary_ask_period. Clear all four salary_ask fields to remove it; leave salary_ask_basis null when gross/net is unknown.");
  }
}

export async function addJobs(scope: UserStore, { jobs }: AddJobs) {
  if (jobs.length < 1 || jobs.length > maxJobsPerBatch) {
    fail(`Received ${jobs.length} records. Save 1–${maxJobsPerBatch} employers or applications per call; split larger imports into batches. No records were saved.`);
  }
  const { db, userId } = scope;
  const now = new Date().toISOString();
  const criteria = await getCriteria(scope);
  for (const [index, job] of jobs.entries()) {
    try {
      validateOpening(job.phase, job);
      validateSalary(job);
      validateSalaryAsk(job);
      job.eligible_opening = validateEligibleOpening(job.eligible_opening, criteria);
    } catch (error) {
      if (error instanceof Error && error.cause === "user") {
        fail(`Batch rejected: 0 of ${jobs.length} records saved. Record ${index + 1}: ${error.message}`);
      }
      throw error;
    }
  }
  const statements = jobs.map((job) => db.prepare(`INSERT INTO jobs
    (user_id, id, company, company_url, phase, current_stage, title, nickname, description, source_url, location, recruiter_name, recruiter_email, notes, score,
      salary_min, salary_max, salary_currency, salary_period, salary_ask_amount, salary_ask_currency, salary_ask_period, salary_ask_basis, created_at, updated_at, eligible_opening)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).bind(
    userId, crypto.randomUUID(), job.company, job.company_url ?? null, job.phase, job.phase === "lead" ? "lead" : "applied",
    job.title ?? null, job.nickname ?? null, job.description ?? null, job.source_url ?? null,
    job.location ?? null, job.recruiter_name ?? null, job.recruiter_email ?? null, job.notes ?? null, job.score ?? null,
    job.salary_min ?? null, job.salary_max ?? null, job.salary_currency ?? null, job.salary_period ?? null,
    job.salary_ask_amount ?? null, job.salary_ask_currency ?? null, job.salary_ask_period ?? null, job.salary_ask_basis ?? null, now, now,
    job.eligible_opening ? JSON.stringify(job.eligible_opening) : null,
  ));
  try {
    const results = await db.batch<Job>(statements);
    return { jobs: results.flatMap((result) => result.results).map(withEligibleOpening) };
  } catch (error) {
    duplicateError(error);
  }
}

const reapplyStatusSql = `CASE
  WHEN status IS NOT 'rejected' THEN 'not_applicable'
  WHEN reapply_policy IS NULL THEN 'unknown'
  WHEN reapply_policy IS 'not_allowed' THEN 'not_allowed'
  WHEN reapply_after > ? THEN 'cooldown'
  ELSE 'eligible' END`;

async function requireJob({ db, userId }: UserStore, id: string) {
  const job = await db.prepare(`SELECT *, ${reapplyStatusSql} AS reapply_status FROM jobs WHERE user_id IS ? AND id IS ?`)
    .bind(new Date().toISOString(), userId, id).first<Job>();
  if (!job) fail("Job not found. Use list_jobs to resolve a company, role, or nickname to its job_id.");
  return job;
}

async function requireStage({ db, userId }: UserStore, id: string) {
  const stage = await db.prepare("SELECT * FROM stages WHERE user_id IS ? AND id IS ?").bind(userId, id).first<Stage>();
  if (!stage) fail("Stage not found. Use get_job to load its stages and stage_id values.");
  return stage;
}

export async function getJob(scope: UserStore, id: string) {
  const { db, userId } = scope;
  const job = await requireJob(scope, id);
  const [stages, feedback, contacts, outreach] = await Promise.all([
    db.prepare("SELECT * FROM stages WHERE user_id IS ? AND job_id IS ? ORDER BY created_at, rowid").bind(userId, id).all<Stage>(),
    db.prepare(`SELECT f.*, s.name AS stage_name FROM feedback f JOIN stages s ON s.id IS f.stage_id AND s.user_id IS f.user_id
      WHERE f.user_id IS ? AND s.job_id IS ? ORDER BY f.created_at, f.rowid`).bind(userId, id).all<Feedback & { stage_name: string }>(),
    db.prepare("SELECT * FROM contact_activity WHERE user_id IS ? AND job_id IS ? ORDER BY created_at, id")
      .bind(userId, id).all<ContactActivity>(),
    db.prepare("SELECT * FROM outreach WHERE user_id IS ? AND job_id IS ? ORDER BY occurred_at, created_at, rowid")
      .bind(userId, id).all<Outreach>(),
  ]);
  return {
    job: withEligibleOpening(job), stages: stages.results, feedback: feedback.results, contacts: contacts.results, outreach: outreach.results,
    last_outreach_at: outreach.results.filter((entry) => entry.direction === "outbound").at(-1)?.occurred_at ?? null,
    last_response_at: outreach.results.filter((entry) => entry.direction === "inbound").at(-1)?.occurred_at ?? null,
  };
}

const searchPattern = (query: string) => `%${query.replace(/[\\%_]/gu, "\\$&")}%`;

export async function getPipeline({ db, userId }: UserStore, input: Pipeline) {
  const asOf = new Date().toISOString();
  const scope = "SELECT * FROM jobs WHERE user_id IS ? AND phase IS 'application' AND status IN ('active', 'offer')";
  const page = `${scope} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`;
  const scheduled = `s.status IN ('planned', 'in_progress') AND s.starts_at IS NOT NULL
    AND (s.starts_at >= ? OR s.ends_at > ? OR (s.status IS 'in_progress' AND s.ends_at IS NULL))`;
  const [summary, jobs, contacts, stages] = await db.batch([
    db.prepare(`WITH pipeline AS (${scope}) SELECT COUNT(*) AS applications,
      COUNT(CASE WHEN j.status IS 'active' THEN 1 END) AS active,
      COUNT(CASE WHEN j.status IS 'offer' THEN 1 END) AS offers,
      COUNT(CASE WHEN EXISTS (SELECT 1 FROM contact_activity c
        WHERE c.user_id IS j.user_id AND c.job_id IS j.id AND c.awaiting_reply IS 1) THEN 1 END) AS awaiting_reply,
      (SELECT COUNT(*) FROM contact_activity c JOIN pipeline p ON p.user_id IS c.user_id AND p.id IS c.job_id
        WHERE c.needs_follow_up IS 1 AND c.follow_up_at <= ?) AS follow_ups_due,
      (SELECT COUNT(*) FROM stages s JOIN pipeline p ON p.user_id IS s.user_id AND p.id IS s.job_id
        WHERE ${scheduled}) AS scheduled_stages
      FROM pipeline j`).bind(userId, asOf, asOf, asOf),
    db.prepare(`WITH pipeline AS (${page}) SELECT j.id, j.company, j.title, j.source_url, j.status,
      j.current_stage, current.status AS current_stage_status, j.recruiter_engaged_at,
      j.salary_min, j.salary_max, j.salary_currency, j.salary_period,
      j.salary_ask_amount, j.salary_ask_currency, j.salary_ask_period, j.salary_ask_basis,
      (SELECT MAX(o.occurred_at) FROM outreach o WHERE o.user_id IS j.user_id AND o.job_id IS j.id AND o.direction IS 'outbound') AS last_outreach_at,
      (SELECT MAX(o.occurred_at) FROM outreach o WHERE o.user_id IS j.user_id AND o.job_id IS j.id AND o.direction IS 'inbound') AS last_response_at
      FROM pipeline j LEFT JOIN stages current ON current.user_id IS j.user_id AND current.id IS (
        SELECT s.id FROM stages s WHERE s.user_id IS j.user_id AND s.job_id IS j.id AND s.name IS j.current_stage
        ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1)
      ORDER BY j.updated_at DESC, j.id`).bind(userId, input.limit + 1, input.offset),
    db.prepare(`WITH pipeline AS (${page}) SELECT c.id, c.job_id, c.name, c.relationship, c.url, c.email,
      c.awaiting_reply, c.follow_up_at, c.last_interaction_at, c.last_interaction_time_basis,
      c.last_outreach_at, c.last_response_at
      FROM contact_activity c JOIN pipeline j ON j.user_id IS c.user_id AND j.id IS c.job_id
      WHERE c.needs_follow_up IS 1
      ORDER BY (j.recruiter_engaged_at IS NOT NULL), c.follow_up_at ASC NULLS LAST, c.last_outreach_at, c.id`)
      .bind(userId, input.limit, input.offset),
    db.prepare(`WITH pipeline AS (${page}), scheduled AS (
      SELECT s.id, s.job_id, s.name, s.status, s.starts_at, s.ends_at, s.timezone,
        ROW_NUMBER() OVER (PARTITION BY s.job_id ORDER BY s.starts_at, s.id) AS position
      FROM stages s JOIN pipeline j ON j.user_id IS s.user_id AND j.id IS s.job_id WHERE ${scheduled})
      SELECT id, job_id, name, status, starts_at, ends_at, timezone FROM scheduled WHERE position IS 1`)
      .bind(userId, input.limit, input.offset, asOf, asOf),
  ]) as [D1Result<PipelineSummary>, D1Result<PipelineJob>, D1Result<PipelineContact>, D1Result<PipelineStage>];
  return {
    as_of: asOf,
    summary: summary.results[0],
    applications: jobs.results.slice(0, input.limit).map((job) => ({
      ...job,
      pending_contacts: contacts.results.filter((contact) => contact.job_id === job.id).map(({ job_id: _jobId, ...contact }) => ({
        ...contact,
        awaiting_reply: contact.awaiting_reply === 1,
        due: contact.follow_up_at !== null && contact.follow_up_at <= asOf,
      })),
      next_stage: stages.results.find((stage) => stage.job_id === job.id) ?? null,
    })),
    next_offset: jobs.results.length > input.limit ? input.offset + input.limit : null,
  };
}

export async function listJobs({ db, userId }: UserStore, input: ListJobs) {
  const where: string[] = [];
  const bindings: (string | number)[] = [input.as_of ? normalizeTimestamp(input.as_of) : new Date().toISOString(), userId];
  if (input.query) {
    where.push("(company LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR nickname LIKE ? ESCAPE '\\')");
    const pattern = searchPattern(input.query);
    bindings.push(pattern, pattern, pattern);
  }
  if (input.status) { where.push("status IS ?"); bindings.push(input.status); }
  if (input.phase) { where.push("phase IS ?"); bindings.push(input.phase); }
  if (input.available_only) where.push("(status IS 'active' OR reapply_status IS 'eligible')");
  if (input.reapply_status) { where.push("reapply_status IS ?"); bindings.push(input.reapply_status); }
  const columns = input.include_descriptions ? "*" : `id, company, company_url, phase, eligible_opening, title, nickname, source_url, location,
    recruiter_name, recruiter_email, notes, status, current_stage, recruiter_engaged_at, reapply_policy, reapply_after, reapply_status,
    score, salary_min, salary_max, salary_currency, salary_period,
    salary_ask_amount, salary_ask_currency, salary_ask_period, salary_ask_basis,
    created_at, updated_at`;
  const results = await db.prepare(`WITH opportunities AS (
    SELECT *, ${reapplyStatusSql} AS reapply_status FROM jobs WHERE user_id IS ?
  ) SELECT ${columns},
    (SELECT MAX(o.occurred_at) FROM outreach o WHERE o.user_id IS jobs.user_id AND o.job_id IS jobs.id AND o.direction IS 'outbound') AS last_outreach_at,
    (SELECT MAX(o.occurred_at) FROM outreach o WHERE o.user_id IS jobs.user_id AND o.job_id IS jobs.id AND o.direction IS 'inbound') AS last_response_at,
    (SELECT MIN(c.follow_up_at) FROM contact_activity c WHERE c.user_id IS jobs.user_id AND c.job_id IS jobs.id AND c.needs_follow_up IS 1) AS follow_up_at
    FROM opportunities AS jobs
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY score DESC NULLS LAST, updated_at DESC, id LIMIT ? OFFSET ?`)
    .bind(...bindings, input.limit + 1, input.offset).all<Omit<Job, "description"> & { description?: string }>();
  const hasMore = results.results.length > input.limit;
  return {
    jobs: results.results.slice(0, input.limit).map(withEligibleOpening),
    next_offset: hasMore ? input.offset + input.limit : null,
  };
}

function patchStatement({ db, userId }: UserStore, table: "jobs" | "stages" | "feedback" | "contacts" | "outreach", id: string, patch: Record<string, string | number | null | undefined>) {
  const entries = Object.entries(patch).filter((entry) => entry[1] !== undefined);
  if (entries.length === 0) fail("Provide at least one field to update.");
  return db.prepare(`UPDATE ${table} SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE user_id IS ? AND id IS ? RETURNING *`)
    .bind(...entries.map(([, value]) => value), new Date().toISOString(), userId, id);
}

export async function updateJob(scope: UserStore, input: UpdateJob) {
  const job = await requireJob(scope, input.job_id);
  const { job_id, eligible_opening, ...patch } = input;
  const needsOpening = input.phase !== undefined || input.company !== undefined || input.company_url !== undefined ||
    ((input.phase ?? job.phase) === "lead" && (input.status === "active" || input.status === "offer"));
  let opening: EligibleOpening | undefined;
  if (needsOpening || eligible_opening !== undefined) opening = validateEligibleOpening(eligible_opening, await getCriteria(scope));
  if (patch.recruiter_engaged_at) {
    patch.recruiter_engaged_at = normalizeTimestamp(patch.recruiter_engaged_at);
    if (Date.parse(patch.recruiter_engaged_at) > Date.now()) fail("recruiter_engaged_at records actual recruiter contact and cannot be in the future.");
  }
  if (patch.reapply_after) patch.reapply_after = normalizeTimestamp(patch.reapply_after);
  const reapplyPolicy = patch.reapply_policy === undefined ? job.reapply_policy : patch.reapply_policy;
  const reapplyAfter = patch.reapply_after === undefined ? job.reapply_after : patch.reapply_after;
  if (reapplyAfter !== null && reapplyPolicy !== "allowed") fail("reapply_after requires reapply_policy:allowed. Clear the deadline when clearing or denying reapplication.");
  validateOpening(input.phase ?? job.phase, input);
  validateSalary({ ...job, ...patch });
  validateSalaryAsk({ ...job, ...patch });
  if (input.phase === "lead") {
    patch.title = null;
    patch.description = null;
    patch.source_url = null;
    patch.location = null;
    patch.current_stage = "lead";
  } else if (input.phase === "application" && job.phase === "lead" && patch.current_stage === undefined) {
    patch.current_stage = "applied";
  }
  // Scores for changed descriptions must come from a new ranking.
  const invalidates = [input.company, input.title, input.description, input.location, opening].some((value) => value !== undefined);
  if (invalidates && patch.score === undefined) patch.score = null;
  try {
    await patchStatement(scope, "jobs", job_id, { ...patch, eligible_opening: opening ? JSON.stringify(opening) : undefined }).run();
    return withEligibleOpening(await requireJob(scope, job_id));
  } catch (error) {
    duplicateError(error);
  }
}

function normalizeTimestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail("Use a valid ISO 8601 timestamp with Z or a UTC offset.");
  // Reject impossible calendar dates that Date would otherwise roll into the next month.
  const day = Number(value.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)), 0)).getUTCDate();
  if (day > daysInMonth) fail("The timestamp contains an impossible calendar date.");
  return date.toISOString();
}

function validateSchedule(stage: Pick<Stage, "starts_at" | "ends_at" | "timezone" | "calendar_event_id" | "calendar_id">) {
  if (stage.starts_at === null) {
    if (stage.ends_at !== null || stage.timezone !== null) fail("A timezone or end time requires starts_at. Clear all three to remove a schedule.");
  } else {
    if (stage.timezone === null) fail("Scheduled stages require an IANA timezone, for example America/Los_Angeles or UTC.");
    try {
      new Intl.DateTimeFormat("en", { timeZone: stage.timezone }).resolvedOptions();
    } catch {
      fail("Use a valid IANA timezone, for example America/Los_Angeles or UTC.");
    }
    if (stage.ends_at !== null && stage.ends_at <= stage.starts_at) fail("ends_at must be later than starts_at.");
  }
  if (stage.calendar_event_id !== null && stage.calendar_id === null) fail("Provide calendar_id with calendar_event_id.");
}

export async function addStage(scope: UserStore, input: AddStage) {
  const { db, userId } = scope;
  await requireJob(scope, input.job_id);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const startsAt = input.starts_at ? normalizeTimestamp(input.starts_at) : null;
  const endsAt = input.ends_at ? normalizeTimestamp(input.ends_at) : null;
  const timezone = input.timezone ?? (startsAt === null ? null : "UTC");
  validateSchedule({ starts_at: startsAt, ends_at: endsAt, timezone, calendar_event_id: null, calendar_id: null });
  const statements = [db.prepare(`INSERT INTO stages
    (user_id, id, job_id, name, status, starts_at, ends_at, timezone, location, contact_name, contact_email, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).bind(userId, id, input.job_id, input.name,
    input.status, startsAt, endsAt, timezone, input.location ?? null, input.contact_name ?? null,
    input.contact_email ?? null, input.notes ?? null, now, now)];
  if (input.make_current) statements.push(db.prepare("UPDATE jobs SET current_stage = ?, updated_at = ? WHERE user_id IS ? AND id IS ?")
    .bind(input.name, now, userId, input.job_id));
  const results = await db.batch<Stage>(statements);
  return results[0]?.results[0];
}

export async function updateStage(scope: UserStore, input: UpdateStage) {
  const { db, userId } = scope;
  const stage = await requireStage(scope, input.stage_id);
  const { stage_id, make_current, ...patch } = input;
  if (make_current && !v.is(pipelineStageSchema, patch.name ?? stage.name)) {
    fail("Rename this legacy stage to a predefined pipeline milestone before making it current. Prepared forms, drafts, and browser handoffs are not pipeline stages.");
  }
  if (patch.starts_at) patch.starts_at = normalizeTimestamp(patch.starts_at);
  if (patch.ends_at) patch.ends_at = normalizeTimestamp(patch.ends_at);
  if (patch.starts_at && patch.timezone === undefined && stage.timezone === null) patch.timezone = "UTC";
  const merged = {
    starts_at: patch.starts_at === undefined ? stage.starts_at : patch.starts_at,
    ends_at: patch.ends_at === undefined ? stage.ends_at : patch.ends_at,
    timezone: patch.timezone === undefined ? stage.timezone : patch.timezone,
    calendar_id: patch.calendar_id === undefined ? stage.calendar_id : patch.calendar_id,
    calendar_event_id: patch.calendar_event_id === undefined ? stage.calendar_event_id : patch.calendar_event_id,
  };
  validateSchedule(merged);
  const statements: D1PreparedStatement[] = [];
  if (Object.keys(patch).length > 0) statements.push(patchStatement(scope, "stages", stage_id, patch));
  if (make_current) statements.push(db.prepare("UPDATE jobs SET current_stage = ?, updated_at = ? WHERE user_id IS ? AND id IS ?")
    .bind(patch.name ?? stage.name, new Date().toISOString(), userId, stage.job_id));
  if (statements.length === 0) fail("Provide a field to update or set make_current to true.");
  await db.batch(statements);
  return requireStage(scope, stage_id);
}

async function requireContact({ db, userId }: UserStore, id: string) {
  const contact = await db.prepare("SELECT * FROM contacts WHERE user_id IS ? AND id IS ?").bind(userId, id).first<Contact>();
  if (!contact) fail("Contact not found. Use get_job to find this employer's contacts.");
  return contact;
}

async function requireOutreach({ db, userId }: UserStore, id: string) {
  const outreach = await db.prepare("SELECT * FROM outreach WHERE user_id IS ? AND id IS ?").bind(userId, id).first<Outreach>();
  if (!outreach) fail("Outreach not found. Use get_job to find the communication history.");
  return outreach;
}

export async function updateContact(scope: UserStore, input: UpdateContact) {
  const { db, userId } = scope;
  const { contact_id, job_id, ...patch } = input;
  const contact = await requireContact(scope, contact_id);
  if (contact.job_id !== job_id) fail("Contact does not belong to this job.");
  const communication = await db.prepare("SELECT id FROM outreach WHERE user_id IS ? AND contact_id IS ? LIMIT 1")
    .bind(userId, contact_id).first<{ id: string }>();
  if (!communication) fail("Contacts require actual communication. Record the real interaction with record_outreach first.");
  try {
    return await patchStatement(scope, "contacts", contact_id, patch).first<Contact>();
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      fail("A contact with this URL or email already exists for this job. Use get_job to find its contact_id.");
    }
    throw error;
  }
}

function validateOutreach(entry: Pick<Outreach, "direction" | "occurred_at" | "follow_up_at" | "follow_up_status">) {
  if (Date.parse(entry.occurred_at) > Date.now()) fail("Outreach records actual communication; occurred_at cannot be in the future.");
  if (entry.follow_up_at !== null && entry.follow_up_at < entry.occurred_at) fail("follow_up_at cannot be earlier than occurred_at.");
}

export async function recordOutreach(scope: UserStore, input: RecordOutreach) {
  const { db, userId } = scope;
  if ((input.contact_id === undefined) === (input.contact === undefined)) {
    fail("Provide exactly one of contact_id for an existing contact or contact with job_id and name for the actual first communication.");
  }
  const existing = input.contact_id ? await requireContact(scope, input.contact_id) : undefined;
  const jobId = existing?.job_id ?? input.contact?.job_id;
  if (!jobId) fail("A job is required for the actual first communication.");
  if (!existing) await requireJob(scope, jobId);
  if (input.stage_id) {
    const stage = await requireStage(scope, input.stage_id);
    if (stage.job_id !== jobId) fail("Stage and contact must belong to the same job.");
  }
  if (input.time_basis === "reported" && !input.occurred_at) fail("Reported event times require occurred_at; omit both to record the logging time.");
  const now = new Date().toISOString();
  const occurredAt = input.occurred_at ? normalizeTimestamp(input.occurred_at) : now;
  const followUpAt = input.follow_up_at ? normalizeTimestamp(input.follow_up_at) : null;
  const followUpStatus = input.follow_up_status ?? (input.direction === "outbound" || followUpAt !== null ? "pending" : null);
  validateOutreach({ direction: input.direction, occurred_at: occurredAt, follow_up_at: followUpAt, follow_up_status: followUpStatus });
  const contactId = existing?.id ?? crypto.randomUUID();
  const outreachId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [];
  if (input.contact) {
    statements.push(db.prepare(`INSERT INTO contacts (user_id, id, job_id, name, relationship, url, email, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(userId, contactId, jobId, input.contact.name,
      input.contact.relationship ?? "other", input.contact.url ?? null, input.contact.email ?? null, input.contact.notes ?? null, now, now));
  }
  statements.push(db.prepare(`INSERT INTO outreach (user_id, id, job_id, contact_id, stage_id, direction, occurred_at,
    time_basis, channel, notes, follow_up_at, follow_up_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .bind(userId, outreachId, jobId, contactId, input.stage_id ?? null, input.direction, occurredAt,
      input.time_basis ?? (input.occurred_at ? "reported" : "recorded"), input.channel ?? null, input.notes ?? null,
      followUpAt, followUpStatus, now, now));
  try {
    const results = await db.batch<Outreach>(statements);
    return results.at(-1)?.results[0];
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      fail("A contact with this URL or email already exists for this job. Use get_job, then record_outreach with its contact_id.");
    }
    throw error;
  }
}

export async function updateOutreach(scope: UserStore, input: UpdateOutreach) {
  const outreach = await requireOutreach(scope, input.outreach_id);
  const { outreach_id, ...patch } = input;
  if (patch.occurred_at) {
    patch.occurred_at = normalizeTimestamp(patch.occurred_at);
    patch.time_basis ??= "reported";
  }
  if (patch.follow_up_at) {
    patch.follow_up_at = normalizeTimestamp(patch.follow_up_at);
    patch.follow_up_status ??= "pending";
  }
  validateOutreach({
    direction: outreach.direction,
    occurred_at: patch.occurred_at ?? outreach.occurred_at,
    follow_up_at: patch.follow_up_at === undefined ? outreach.follow_up_at : patch.follow_up_at,
    follow_up_status: patch.follow_up_status ?? outreach.follow_up_status,
  });
  return patchStatement(scope, "outreach", outreach_id, patch).first<Outreach>();
}

export async function getFollowUps({ db, userId }: UserStore, input: FollowUps) {
  const asOf = input.as_of ? normalizeTimestamp(input.as_of) : new Date().toISOString();
  const where = ["c.user_id IS ?", "c.needs_follow_up IS 1", "j.status IN ('active', 'offer')"];
  const bindings: (string | number)[] = [userId];
  if (input.job_id) { where.push("c.job_id IS ?"); bindings.push(input.job_id); }
  if (input.pre_recruiter_only) where.push("j.recruiter_engaged_at IS NULL");
  if (input.due_only) { where.push("c.follow_up_at IS NOT NULL AND c.follow_up_at <= ?"); bindings.push(asOf); }
  if (input.reached_out_before) {
    where.push("c.last_outreach_at <= ?"); bindings.push(normalizeTimestamp(input.reached_out_before));
  }
  const result = await db.prepare(`SELECT c.*, j.company, j.title, j.phase, j.current_stage, j.recruiter_engaged_at
    FROM contact_activity c JOIN jobs j ON j.user_id IS c.user_id AND j.id IS c.job_id
    WHERE ${where.join(" AND ")}
    ORDER BY (j.recruiter_engaged_at IS NOT NULL), c.follow_up_at ASC NULLS LAST, c.last_outreach_at, c.id LIMIT ? OFFSET ?`)
    .bind(...bindings, input.limit + 1, input.offset).all<ContactActivity & Pick<Job, "company" | "title" | "phase" | "current_stage" | "recruiter_engaged_at">>();
  return {
    as_of: asOf,
    follow_ups: result.results.slice(0, input.limit).map((entry) => ({
      ...entry,
      pre_recruiter: entry.recruiter_engaged_at === null,
      seconds_since_outreach: entry.last_outreach_at === null ? null : Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(entry.last_outreach_at)) / 1000)),
      due: entry.follow_up_at !== null && entry.follow_up_at <= asOf,
    })),
    next_offset: result.results.length > input.limit ? input.offset + input.limit : null,
  };
}

export async function addFeedback(scope: UserStore, input: AddFeedback) {
  const { db, userId } = scope;
  await requireStage(scope, input.stage_id);
  const now = new Date().toISOString();
  return db.prepare(`INSERT INTO feedback (user_id, id, stage_id, text, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`).bind(userId, crypto.randomUUID(), input.stage_id, input.text, input.source, now, now).first<Feedback>();
}

export async function updateFeedback(scope: UserStore, input: UpdateFeedback) {
  const { feedback_id, ...patch } = input;
  const feedback = await patchStatement(scope, "feedback", feedback_id, patch).first<Feedback>();
  if (!feedback) fail("Feedback not found. Use get_job or list_feedback to find feedback_id values.");
  return feedback;
}

export async function listFeedback({ db, userId }: UserStore, input: ListFeedback) {
  const where = ["f.user_id IS ?"];
  const bindings: string[] = [userId];
  if (input.job_id) { where.push("s.job_id IS ?"); bindings.push(input.job_id); }
  if (input.stage_name) { where.push("s.name LIKE ? ESCAPE '\\'"); bindings.push(searchPattern(input.stage_name)); }
  if (input.source) { where.push("f.source IS ?"); bindings.push(input.source); }
  const results = await db.prepare(`SELECT f.*, s.name AS stage_name, s.status AS stage_status,
    s.job_id, j.company, j.title, j.nickname FROM feedback f JOIN stages s ON s.id IS f.stage_id AND s.user_id IS f.user_id
    JOIN jobs j ON j.id IS s.job_id AND j.user_id IS s.user_id WHERE ${where.join(" AND ")} ORDER BY f.created_at DESC, f.id LIMIT ? OFFSET ?`)
    .bind(...bindings, input.limit + 1, input.offset).all<Feedback>();
  return { feedback: results.results.slice(0, input.limit), next_offset: results.results.length > input.limit ? input.offset + input.limit : null };
}

export async function getUpcoming({ db, userId }: UserStore, input: Upcoming) {
  const from = normalizeTimestamp(input.from);
  const to = input.to ? normalizeTimestamp(input.to) : null;
  if (to !== null && to <= from) fail("to must be later than from.");
  const results = await db.prepare(`SELECT s.*, j.company, j.title, j.nickname, j.recruiter_name, j.recruiter_email
    FROM stages s JOIN jobs j ON j.id IS s.job_id AND j.user_id IS s.user_id WHERE s.user_id IS ? AND s.status IN ('planned', 'in_progress')
    AND j.status IN ('active', 'offer') AND s.starts_at >= ? AND (? IS NULL OR s.starts_at < ?)
    ORDER BY s.starts_at, s.id LIMIT ? OFFSET ?`).bind(userId, from, to, to, input.limit + 1, input.offset).all<Stage>();
  return { stages: results.results.slice(0, input.limit), next_offset: results.results.length > input.limit ? input.offset + input.limit : null };
}

export async function getCalendarEvent(scope: UserStore, input: CalendarEvent) {
  const stage = await requireStage(scope, input.stage_id);
  const job = await requireJob(scope, stage.job_id);
  if (stage.calendar_event_id !== null && input.calendar_id && input.calendar_id !== stage.calendar_id) {
    fail("This stage already has an event in a different calendar. Read the linked event before moving or replacing it.");
  }
  const calendarId = input.calendar_id ?? stage.calendar_id ?? "primary";
  const cancelled = stage.status === "cancelled";
  const missingFields = cancelled ? [] : [
    ...(stage.starts_at === null ? ["starts_at"] : []),
    ...(stage.ends_at === null ? ["ends_at"] : []),
  ];
  const event = {
    calendar_id: calendarId,
    title: `${job.company} — ${stage.name}${job.title ? ` (${job.title})` : ""}`,
    start_time: stage.starts_at,
    end_time: stage.ends_at,
    timezone_str: "UTC",
    description: `Company: ${job.company}${job.title ? `\nRole: ${job.title}` : ""}\nStage: ${stage.name}${job.source_url ? `\nOpening: ${job.source_url}` : ""}\nCareers MCP stage: ${stage.id}`,
    location: stage.location,
  };
  return {
    stage_id: stage.id,
    job_id: job.id,
    stage_status: stage.status,
    calendar_id: calendarId,
    event_id: stage.calendar_event_id,
    missing_fields: missingFields,
    suggested_action: cancelled ? (stage.calendar_event_id === null ? "none" : "delete")
      : (stage.calendar_event_id === null ? "create" : "update"),
    create_event_args: !cancelled && missingFields.length === 0 && stage.calendar_event_id === null
      ? { ...event, attendees: input.attendees, visibility: "private" } : null,
    update_event_args: !cancelled && missingFields.length === 0 && stage.calendar_event_id !== null
      ? { ...event, event_id: stage.calendar_event_id } : null,
    delete_event_args: cancelled && stage.calendar_event_id !== null
      ? { calendar_id: calendarId, event_id: stage.calendar_event_id } : null,
  };
}
