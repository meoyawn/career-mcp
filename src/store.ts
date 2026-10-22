import * as v from "valibot";
import { check, execute, fail, first, openingCheck, type Database, type Statement } from "./database.ts";
import { eligibleOpeningSchema, jobLifecycleSchema, listJobsSchema, maxJobsPerBatch, pipelineStageSchema, salaryRangeSchema, type AddFeedback, type AddJobs, type AddPrepNote, type AddStage, type CalendarEvent, type CloseOpening, type FollowUps, type InterviewPrep, type ListFeedback, type ListJobs, type Pipeline, type RecordOutreach, type SetApplicantContact, type Upcoming, type UpdateContact, type UpdateFeedback, type UpdateJob, type UpdateOutreach, type UpdatePrepNote, type UpdateStage } from "./schemas.ts";

export interface UserStore {
  db: Database;
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

interface SalaryFields {
  employer_salary: string | null;
  asked_salary: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: "hour" | "day" | "week" | "month" | "year" | null;
  salary_ask_amount: number | null;
  salary_ask_currency: string | null;
  salary_ask_period: "hour" | "day" | "week" | "month" | "year" | null;
  salary_ask_basis: "gross" | "net" | null;
  salary_declared_amount: number | null;
  salary_declared_currency: string | null;
  salary_declared_period: "hour" | "day" | "week" | "month" | "year" | null;
  salary_declared_basis: "gross" | "net" | null;
}

interface JobDetails extends SalaryFields {
  id: string;
  company: string;
  company_url: string | null;
  eligible_opening: string | null;
  title: string | null;
  nickname: string | null;
  description: string | null;
  source_url: string | null;
  location: string | null;
  recruiter_name: string | null;
  recruiter_email: string | null;
  notes: string | null;
  score: number | null;
  created_at: string;
  updated_at: string;
}

type Job = JobDetails & v.InferOutput<typeof jobLifecycleSchema>;

const openingStatusSql = `CASE WHEN EXISTS (
  SELECT 1 FROM opening_closures c WHERE c.user_id IS jobs.user_id AND c.job_id IS jobs.id
    AND c.source_url IS coalesce(json_extract(jobs.eligible_opening, '$.source_url'), jobs.source_url, c.source_url)
    AND (jobs.eligible_opening IS NULL OR c.checked_at >= json_extract(jobs.eligible_opening, '$.checked_at'))
) THEN 'closed' WHEN jobs.eligible_opening IS NOT NULL THEN 'open' ELSE 'unknown' END`;

interface PrepNote {
  id: string;
  job_id: string;
  kind: "question" | "reminder" | "correction" | "context";
  text: string;
  stage_name: string | null;
  status: "pending" | "resolved" | "cancelled";
  resolution: string | null;
  closed_at: string | null;
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
  submitted: number;
  active: number;
  offers: number;
  awaiting_reply: number;
  follow_ups_due: number;
  scheduled_stages: number;
}

interface PipelineJob extends SalaryFields, Pick<Job, "id" | "company" | "title" | "source_url" | "status" | "current_stage" | "recruiter_engaged_at"> {
  pipeline_status: "submitted" | "active" | "offer";
  current_stage_status: string | null;
  last_outreach_at: string | null;
  last_response_at: string | null;
}

type PipelineContact = Pick<ContactActivity, "id" | "job_id" | "name" | "relationship" | "url" | "email" | "awaiting_reply" | "follow_up_at" | "last_interaction_at" | "last_interaction_time_basis" | "last_outreach_at" | "last_response_at">;
type PipelineStage = Pick<Stage, "id" | "job_id" | "name" | "status" | "starts_at" | "ends_at" | "timezone">;

const criteriaStatement = ({ db, userId }: UserStore) => db.prepare("SELECT * FROM criteria WHERE user_id IS ?").bind(userId);

export const getCriteria = (scope: UserStore) => first<Criteria>(scope.db, criteriaStatement(scope));

export function setCriteria({ db, userId }: UserStore, text: string) {
  return first<Criteria>(db, db.prepare(`INSERT INTO criteria (user_id, text, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
    RETURNING *`).bind(userId, text, new Date().toISOString()));
}

export async function getApplicationContext(scope: UserStore, jobId?: string) {
  const { db, userId } = scope;
  const results = await execute(db, [
    db.prepare("SELECT text, updated_at FROM application_context WHERE user_id IS ?").bind(userId),
    db.prepare("SELECT email, phone, updated_at FROM applicant_contact WHERE user_id IS ?").bind(userId),
    db.prepare("SELECT gender, updated_at FROM applicant_profile WHERE user_id IS ?").bind(userId),
    db.prepare("SELECT language, url FROM cvs WHERE user_id IS ? ORDER BY language").bind(userId),
    ...(jobId ? jobStatements(scope, "?", [jobId]) : []),
  ]);
  return {
    application_context: (results[0]?.results[0] ?? null) as ApplicationContext | null,
    applicant_contact: (results[1]?.results[0] ?? null) as ApplicantContact | null,
    applicant_profile: (results[2]?.results[0] ?? null) as ApplicantProfile | null,
    cvs: Object.fromEntries(((results[3]?.results ?? []) as CV[]).map((cv) => [cv.language, cv.url])),
    ...(jobId ? jobResult(results.slice(4)) : {}),
  };
}

export async function setApplicantProfile({ db, userId }: UserStore, gender: string | null) {
  if (gender === null) {
    await execute(db, [db.prepare("DELETE FROM applicant_profile WHERE user_id IS ?").bind(userId)]);
    return null;
  }
  return first<ApplicantProfile>(db, db.prepare(`INSERT INTO applicant_profile (user_id, gender, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET gender = excluded.gender, updated_at = excluded.updated_at
    RETURNING gender, updated_at`).bind(userId, gender, new Date().toISOString()));
}

export function setApplicantContact({ db, userId }: UserStore, input: SetApplicantContact) {
  if (input.email === undefined && input.phone === undefined) fail("Supply email or phone; use null to clear a field.");
  return first<ApplicantContact>(db, db.prepare(`INSERT INTO applicant_contact (user_id, email, phone, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      email = CASE WHEN ? THEN excluded.email ELSE applicant_contact.email END,
      phone = CASE WHEN ? THEN excluded.phone ELSE applicant_contact.phone END,
      updated_at = excluded.updated_at
    RETURNING email, phone, updated_at`)
    .bind(userId, input.email ?? null, input.phone ?? null, new Date().toISOString(),
      Number(input.email !== undefined), Number(input.phone !== undefined)));
}

export async function setApplicationContext({ db, userId }: UserStore, text: string | null) {
  if (text === null) {
    await execute(db, [db.prepare("DELETE FROM application_context WHERE user_id IS ?").bind(userId)]);
    return null;
  }
  return first<ApplicationContext>(db, db.prepare(`INSERT INTO application_context (user_id, text, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
    RETURNING text, updated_at`).bind(userId, text, new Date().toISOString()));
}

export async function setCV({ db, userId }: UserStore, language: string, url: string | null) {
  language = language.toLowerCase();
  if (url === null) {
    await execute(db, [db.prepare("DELETE FROM cvs WHERE user_id IS ? AND language IS ?").bind(userId, language)]);
  } else {
    await execute(db, [db.prepare(`INSERT INTO cvs (user_id, language, url, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, language) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at`)
      .bind(userId, language, url, new Date().toISOString())]);
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

function validateEligibleOpening(input: unknown) {
  const result = v.safeParse(eligibleOpeningSchema, input);
  if (!result.success) fail("Every new job record requires a verified eligible opening: title, description, source_url, location, status:open, eligibility:eligible, checked_at, criteria_updated_at, and eligibility_reason. Excluded, closed, unknown, and employer-only records cannot be saved; phase:application does not bypass this check.");
  const opening = result.output;
  const checkedAt = normalizeTimestamp(opening.checked_at);
  const age = Date.now() - Date.parse(checkedAt);
  if (age < 0 || age > 24 * 60 * 60 * 1_000) fail("Verify the opening is still open within the last 24 hours; checked_at cannot be in the future.");
  return { ...opening, checked_at: checkedAt, criteria_updated_at: normalizeTimestamp(opening.criteria_updated_at) };
}

function openingChecks({ db, userId }: UserStore, opening: string, bindings: unknown[], condition = "1", conditionBindings: unknown[] = []) {
  return [
    check(db, "opening_required", `${condition} AND (${opening}) IS NULL`, ...conditionBindings, ...bindings),
    check(db, "criteria_required", `${condition} AND NOT EXISTS (SELECT 1 FROM criteria WHERE user_id IS ?)`, ...conditionBindings, userId),
    check(db, "outdated_criteria", `${condition} AND NOT EXISTS (SELECT 1 FROM criteria WHERE user_id IS ?
      AND updated_at IS json_extract((${opening}), '$.criteria_updated_at'))`, ...conditionBindings, userId, ...bindings),
    check(db, "opening_expired", `${condition} AND coalesce(julianday(json_extract((${opening}), '$.checked_at'))
      BETWEEN julianday('now') - 1 AND julianday('now'), 0) IS 0`, ...conditionBindings, ...bindings),
  ];
}

function withCompensation<T extends SalaryFields>(job: T) {
  return {
    ...job,
    employer_salary: job.employer_salary === null
      ? job.salary_min === null && job.salary_max === null ? null : v.parse(salaryRangeSchema, {
        min: job.salary_min, max: job.salary_max, currency: job.salary_currency, period: job.salary_period,
      }) : v.parse(salaryRangeSchema, JSON.parse(job.employer_salary)),
    asked_salary: job.asked_salary === null
      ? job.salary_declared_amount === null ? null : v.parse(salaryRangeSchema, {
        min: job.salary_declared_amount, max: job.salary_declared_amount, currency: job.salary_declared_currency,
        period: job.salary_declared_period, basis: job.salary_declared_basis,
      }) : v.parse(salaryRangeSchema, JSON.parse(job.asked_salary)),
    salary_target: job.salary_ask_amount === null ? null : {
      amount: job.salary_ask_amount, currency: job.salary_ask_currency, period: job.salary_ask_period, basis: job.salary_ask_basis,
    },
  };
}

function withEligibleOpening<T extends SalaryFields & Pick<Job, "eligible_opening">>(job: T) {
  return withCompensation({ ...job, eligible_opening: job.eligible_opening === null ? null : v.parse(eligibleOpeningSchema, JSON.parse(job.eligible_opening)) });
}

function validateSalaryRange(range: v.InferOutput<typeof salaryRangeSchema> | null) {
  if (range === null) return;
  if (range.min === null && range.max === null && range.text === null) fail("A salary range needs an amount or the original salary text.");
  if (range.min !== null && range.max !== null && range.min > range.max) fail("The salary range minimum must not exceed its maximum.");
  if (range.text === null && (range.currency === null || range.period === null)) fail("A salary range needs currency and pay period, or original text preserving the unknown units.");
}

function prepareSalaryInput<T extends Pick<UpdateJob, "employer_salary" | "asked_salary" | "salary_min" | "salary_max" | "salary_currency" | "salary_period" | "salary_declared_amount" | "salary_declared_currency" | "salary_declared_period" | "salary_declared_basis">>(input: T) {
  const { employer_salary, asked_salary, ...fields } = input;
  const employerLegacy = [input.salary_min, input.salary_max, input.salary_currency, input.salary_period].some((value) => value !== undefined);
  const askedLegacy = [input.salary_declared_amount, input.salary_declared_currency, input.salary_declared_period, input.salary_declared_basis].some((value) => value !== undefined);
  let employer: Partial<Pick<SalaryFields, "employer_salary" | "salary_min" | "salary_max" | "salary_currency" | "salary_period">> = {};
  let asked: Partial<Pick<SalaryFields, "asked_salary" | "salary_declared_amount" | "salary_declared_currency" | "salary_declared_period" | "salary_declared_basis">> = {};
  if (employer_salary !== undefined) {
    validateSalaryRange(employer_salary);
    if (employerLegacy) fail("Use employer_salary or legacy salary_min/max/currency/period fields, not both in one write.");
    const normalized = employer_salary?.currency != null && employer_salary.period !== null && (employer_salary.min !== null || employer_salary.max !== null);
    employer = {
      employer_salary: employer_salary === null ? null : JSON.stringify(employer_salary),
      salary_min: normalized ? employer_salary.min : null, salary_max: normalized ? employer_salary.max : null,
      salary_currency: normalized ? employer_salary.currency : null, salary_period: normalized ? employer_salary.period : null,
    };
  } else if (employerLegacy) employer.employer_salary = null;
  if (asked_salary !== undefined) {
    validateSalaryRange(asked_salary);
    if (askedLegacy) fail("Use asked_salary or legacy salary_declared fields, not both in one write.");
    const exact = asked_salary?.min != null && asked_salary.min === asked_salary.max && asked_salary.currency !== null && asked_salary.period !== null;
    asked = {
      asked_salary: asked_salary === null ? null : JSON.stringify(asked_salary),
      salary_declared_amount: exact ? asked_salary.min : null, salary_declared_currency: exact ? asked_salary.currency : null,
      salary_declared_period: exact ? asked_salary.period : null, salary_declared_basis: exact ? asked_salary.basis : null,
    };
  } else if (askedLegacy) asked.asked_salary = null;
  return { ...fields, ...employer, ...asked };
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

function validateDeclaredSalary(input: Pick<UpdateJob, "salary_declared_amount" | "salary_declared_currency" | "salary_declared_period" | "salary_declared_basis">) {
  const { salary_declared_amount: amount, salary_declared_currency: currency, salary_declared_period: period, salary_declared_basis: basis } = input;
  if ([amount, currency, period, basis].every((value) => value == null)) return;
  if (amount == null || currency == null || period == null) {
    fail("Declared salary needs salary_declared_amount, salary_declared_currency, and salary_declared_period. Clear all four salary_declared fields to remove it; leave salary_declared_basis null when gross/net is unknown.");
  }
}

export async function addJobs(scope: UserStore, { jobs }: AddJobs) {
  if (jobs.length < 1 || jobs.length > maxJobsPerBatch) {
    fail(`Received ${jobs.length} records. Save 1–${maxJobsPerBatch} employers or applications per call; split larger imports into batches. No records were saved.`);
  }
  const { db, userId } = scope;
  const now = new Date().toISOString();
  const prepared = jobs.map(prepareSalaryInput);
  for (const [index, job] of prepared.entries()) {
    try {
      validateOpening(job.phase, job);
      validateSalary(job);
      validateSalaryAsk(job);
      validateDeclaredSalary(job);
      job.eligible_opening = validateEligibleOpening(job.eligible_opening);
    } catch (error) {
      if (error instanceof Error && error.cause === "user") {
        fail(`Batch rejected: 0 of ${jobs.length} records saved. Record ${index + 1}: ${error.message}`);
      }
      throw error;
    }
  }
  const statements = prepared.map((job) => db.prepare(`INSERT INTO jobs
    (user_id, id, company, company_url, phase, current_stage, title, nickname, description, source_url, location, recruiter_name, recruiter_email, notes, score,
      salary_min, salary_max, salary_currency, salary_period, salary_ask_amount, salary_ask_currency, salary_ask_period, salary_ask_basis,
      salary_declared_amount, salary_declared_currency, salary_declared_period, salary_declared_basis, created_at, updated_at, eligible_opening, employer_salary, asked_salary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).bind(
    userId, crypto.randomUUID(), job.company, job.company_url ?? null, job.phase, job.phase === "lead" ? "lead" : "applied",
    job.title ?? null, job.nickname ?? null, job.description ?? null, job.source_url ?? null,
    job.location ?? null, job.recruiter_name ?? null, job.recruiter_email ?? null, job.notes ?? null, job.score ?? null,
    job.salary_min ?? null, job.salary_max ?? null, job.salary_currency ?? null, job.salary_period ?? null,
    job.salary_ask_amount ?? null, job.salary_ask_currency ?? null, job.salary_ask_period ?? null, job.salary_ask_basis ?? null,
    job.salary_declared_amount ?? null, job.salary_declared_currency ?? null, job.salary_declared_period ?? null, job.salary_declared_basis ?? null, now, now,
    job.eligible_opening ? JSON.stringify(job.eligible_opening) : null,
    job.employer_salary ?? null, job.asked_salary ?? null,
  ));
  try {
    const evidence = JSON.stringify(prepared.map((job) => job.eligible_opening));
    const checks = [
      check(db, "criteria_required", "NOT EXISTS (SELECT 1 FROM criteria WHERE user_id IS ?)", userId),
      check(db, "outdated_criteria", `EXISTS (SELECT 1 FROM json_each(?) opening WHERE NOT EXISTS (
        SELECT 1 FROM criteria WHERE user_id IS ? AND updated_at IS json_extract(opening.value, '$.criteria_updated_at')))`, evidence, userId),
      check(db, "opening_expired", `EXISTS (SELECT 1 FROM json_each(?) opening WHERE coalesce(
        julianday(json_extract(opening.value, '$.checked_at')) BETWEEN julianday('now') - 1 AND julianday('now'), 0) IS 0)`, evidence),
    ];
    const results = await execute<Job>(db, [...checks, ...statements]);
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

function jobStatements(scope: UserStore, idSql: string, bindings: unknown[]) {
  const { db, userId } = scope;
  return [
    db.prepare(`SELECT *, ${openingStatusSql} AS opening_status, ${reapplyStatusSql} AS reapply_status FROM jobs WHERE user_id IS ? AND id IS (${idSql})`)
      .bind(new Date().toISOString(), userId, ...bindings),
    db.prepare(`SELECT * FROM stages WHERE user_id IS ? AND job_id IS (${idSql}) ORDER BY created_at, rowid`).bind(userId, ...bindings),
    db.prepare(`SELECT f.*, s.name AS stage_name FROM feedback f JOIN stages s ON s.id IS f.stage_id AND s.user_id IS f.user_id
      WHERE f.user_id IS ? AND s.job_id IS (${idSql}) ORDER BY f.created_at, f.rowid`).bind(userId, ...bindings),
    db.prepare(`SELECT * FROM contact_activity WHERE user_id IS ? AND job_id IS (${idSql}) ORDER BY created_at, id`).bind(userId, ...bindings),
    db.prepare(`SELECT * FROM outreach WHERE user_id IS ? AND job_id IS (${idSql}) ORDER BY occurred_at, created_at, rowid`).bind(userId, ...bindings),
    db.prepare(`SELECT id, job_id, kind, text, stage_name, status, resolution, closed_at, created_at, updated_at FROM prep_notes
      WHERE user_id IS ? AND job_id IS (${idSql}) ORDER BY created_at, rowid`).bind(userId, ...bindings),
    db.prepare(`SELECT source_url, reason, checked_at, eligible_opening, created_at FROM opening_closures
      WHERE user_id IS ? AND job_id IS (${idSql}) ORDER BY checked_at, source_url`).bind(userId, ...bindings),
  ];
}

function jobResult(results: D1Result[]) {
  const [jobs, stages, feedback, contacts, outreach, prepNotes] = results as [D1Result<Job>, D1Result<Stage>, D1Result<Feedback & { stage_name: string }>, D1Result<ContactActivity>, D1Result<Outreach>, D1Result<PrepNote>];
  const job = jobs.results[0];
  if (!job) fail("Job not found. Use list_jobs to resolve a company, role, or nickname to its job_id.");
  return {
    job: withEligibleOpening(job), stages: stages.results, feedback: feedback.results, contacts: contacts.results, outreach: outreach.results,
    prep_notes: prepNotes.results,
    opening_closures: results[6]!.results.map(function parseClosure(closure) {
      const row = closure as Record<string, unknown> & { eligible_opening: string | null };
      return { ...row, eligible_opening: row.eligible_opening === null ? null : JSON.parse(row.eligible_opening) };
    }),
    last_outreach_at: outreach.results.filter((entry) => entry.direction === "outbound").at(-1)?.occurred_at ?? null,
    last_response_at: outreach.results.filter((entry) => entry.direction === "inbound").at(-1)?.occurred_at ?? null,
  };
}

export const getJob = async (scope: UserStore, id: string) => jobResult(await execute(scope.db, jobStatements(scope, "?", [id])));

export async function getInterviewPrep(scope: UserStore, input: InterviewPrep) {
  const { db, userId } = scope;
  const asOf = new Date().toISOString();
  const selected = input.stage_id ? "?" : `SELECT s.id FROM stages s JOIN jobs j ON j.user_id IS s.user_id AND j.id IS s.job_id
      WHERE s.user_id IS ? AND j.phase IS 'application' AND j.status IN ('active', 'offer')
        AND (? IS NULL OR s.job_id IS ?) AND (? IS NULL OR s.name IS ?)
        AND s.status IN ('planned', 'in_progress') AND s.starts_at IS NOT NULL
        AND (s.starts_at >= ? OR s.ends_at > ? OR (s.status IS 'in_progress' AND s.ends_at IS NULL))
      ORDER BY s.starts_at, s.id LIMIT 1`;
  const selectionBindings = input.stage_id ? [input.stage_id] : [userId, input.job_id ?? null, input.job_id ?? null, input.stage_name ?? null, input.stage_name ?? null, asOf, asOf];
  const results = await execute(db, [
    db.prepare(`SELECT * FROM stages WHERE user_id IS ? AND id IS (${selected})`).bind(userId, ...selectionBindings),
    ...jobStatements(scope, `coalesce(?, (SELECT job_id FROM stages WHERE user_id IS ? AND id IS (${selected})))`, [input.job_id ?? null, userId, ...selectionBindings]),
  ]);
  const stage = (results[0]?.results[0] ?? null) as Stage | null;
  if (input.stage_id && !stage) fail("Stage not found. Use get_job to load its stages and stage_id values.");
  if (stage && input.job_id && stage.job_id !== input.job_id) fail("Stage does not belong to this job.");
  if (stage && input.stage_name && stage.name !== input.stage_name) fail("Stage does not match stage_name.");
  if (!input.job_id && !stage) fail("No upcoming interview found. Supply job_id and optionally stage_name to prepare for an unscheduled call.");
  const { job, stages, feedback, contacts, prep_notes } = jobResult(results.slice(1));
  const stageName = input.stage_name ?? stage?.name ?? null;
  return {
    as_of: asOf, job, stage, stage_name: stageName,
    pending_prep_notes: prep_notes.filter((note) => note.status === "pending" && (note.stage_name === null || stageName === null || note.stage_name === stageName)),
    stages, feedback, contacts,
  };
}

export async function addPrepNote(scope: UserStore, input: AddPrepNote) {
  const { db, userId } = scope;
  const now = new Date().toISOString();
  const results = await execute<PrepNote>(db, [requireRow(scope, "jobs", input.job_id, "job_not_found"),
    db.prepare(`INSERT INTO prep_notes (user_id, id, job_id, kind, text, stage_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, job_id, kind, text, stage_name, status, resolution, closed_at, created_at, updated_at`)
      .bind(userId, crypto.randomUUID(), input.job_id, input.kind, input.text, input.stage_name ?? null, now, now),
  ]);
  return results.at(-1)?.results[0];
}

export async function updatePrepNote(scope: UserStore, input: UpdatePrepNote) {
  const { db, userId } = scope;
  if (input.kind === undefined && input.text === undefined && input.stage_name === undefined && input.status === undefined && input.resolution === undefined) fail("Provide at least one field to update.");
  const now = new Date().toISOString();
  const results = await execute<PrepNote>(db, [
    requireRow(scope, "prep_notes", input.prep_note_id, "prep_note_not_found"),
    check(db, "prep_resolution", `? IS NOT NULL AND EXISTS (SELECT 1 FROM prep_notes WHERE user_id IS ? AND id IS ? AND coalesce(?, status) IS 'pending')`,
      input.resolution ?? null, userId, input.prep_note_id, input.status ?? null),
    db.prepare(`UPDATE prep_notes SET kind = coalesce(?, kind), text = coalesce(?, text),
      stage_name = CASE WHEN ? THEN ? ELSE stage_name END,
      resolution = CASE WHEN coalesce(?, status) IS 'pending' THEN NULL WHEN ? THEN ? ELSE resolution END,
      closed_at = CASE WHEN coalesce(?, status) IS 'pending' THEN NULL WHEN ? IS status OR ? IS NULL THEN closed_at ELSE ? END,
      status = coalesce(?, status), updated_at = ?
      WHERE user_id IS ? AND id IS ? RETURNING id, job_id, kind, text, stage_name, status, resolution, closed_at, created_at, updated_at`)
      .bind(input.kind ?? null, input.text ?? null, Number(input.stage_name !== undefined), input.stage_name ?? null,
        input.status ?? null, Number(input.resolution !== undefined), input.resolution ?? null,
        input.status ?? null, input.status ?? null, input.status ?? null, now, input.status ?? null, now, userId, input.prep_note_id),
  ]);
  return results.at(-1)?.results[0];
}

const searchPattern = (query: string) => `%${query.replace(/[\\%_]/gu, "\\$&")}%`;

export async function getPipeline({ db, userId }: UserStore, input: Pipeline) {
  const asOf = new Date().toISOString();
  const scope = `SELECT j.*, CASE WHEN j.status IS 'offer' THEN 'offer'
    WHEN EXISTS (SELECT 1 FROM stages s WHERE s.user_id IS j.user_id AND s.job_id IS j.id
      AND s.name IN ('recruiter_screen', 'assessment', 'technical_interview', 'system_design',
        'hiring_manager', 'final_interview', 'reference_check')
      AND s.status IS NOT 'cancelled'
      AND (s.starts_at IS NOT NULL OR s.status IN ('in_progress', 'passed', 'failed', 'completed')))
    THEN 'active' ELSE 'submitted' END AS pipeline_status
    FROM jobs j WHERE j.user_id IS ? AND j.phase IS 'application' AND j.status IN ('active', 'offer')`;
  const page = `${scope} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`;
  const scheduled = `s.status IN ('planned', 'in_progress') AND s.starts_at IS NOT NULL
    AND (s.starts_at >= ? OR s.ends_at > ? OR (s.status IS 'in_progress' AND s.ends_at IS NULL))`;
  const [summary, jobs, contacts, stages, prepNotes] = await execute(db, [
    db.prepare(`WITH pipeline AS (${scope}) SELECT COUNT(*) AS applications,
      COUNT(CASE WHEN j.pipeline_status IS 'submitted' THEN 1 END) AS submitted,
      COUNT(CASE WHEN j.pipeline_status IS 'active' THEN 1 END) AS active,
      COUNT(CASE WHEN j.pipeline_status IS 'offer' THEN 1 END) AS offers,
      COUNT(CASE WHEN EXISTS (SELECT 1 FROM contact_activity c
        WHERE c.user_id IS j.user_id AND c.job_id IS j.id AND c.awaiting_reply IS 1) THEN 1 END) AS awaiting_reply,
      (SELECT COUNT(*) FROM contact_activity c JOIN pipeline p ON p.user_id IS c.user_id AND p.id IS c.job_id
        WHERE c.needs_follow_up IS 1 AND c.follow_up_at <= ?) AS follow_ups_due,
      (SELECT COUNT(*) FROM stages s JOIN pipeline p ON p.user_id IS s.user_id AND p.id IS s.job_id
        WHERE ${scheduled}) AS scheduled_stages
      FROM pipeline j`).bind(userId, asOf, asOf, asOf),
    db.prepare(`WITH pipeline AS (${page}) SELECT j.id, j.company, j.title, j.source_url, j.status, j.pipeline_status,
      j.current_stage, current.status AS current_stage_status, j.recruiter_engaged_at,
      j.salary_min, j.salary_max, j.salary_currency, j.salary_period,
      j.salary_ask_amount, j.salary_ask_currency, j.salary_ask_period, j.salary_ask_basis,
      j.salary_declared_amount, j.salary_declared_currency, j.salary_declared_period, j.salary_declared_basis,
      j.employer_salary, j.asked_salary,
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
    db.prepare(`WITH pipeline AS (${page}) SELECT t.id, t.job_id, t.kind, t.text, t.stage_name
      FROM prep_notes t JOIN pipeline j ON j.user_id IS t.user_id AND j.id IS t.job_id
      WHERE t.status IS 'pending' ORDER BY t.created_at, t.rowid`).bind(userId, input.limit, input.offset),
  ]) as [D1Result<PipelineSummary>, D1Result<PipelineJob>, D1Result<PipelineContact>, D1Result<PipelineStage>, D1Result<Pick<PrepNote, "id" | "job_id" | "kind" | "text" | "stage_name">>];
  return {
    as_of: asOf,
    summary: summary.results[0],
    applications: jobs.results.slice(0, input.limit).map((job) => ({
      ...withCompensation(job),
      pending_prep_notes: prepNotes.results.filter((note) => note.job_id === job.id).map(({ id, kind, text, stage_name }) => ({ id, kind, text, stage_name })),
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

function listJobsStatement({ db, userId }: UserStore, input: ListJobs) {
  const where: string[] = [];
  const bindings: (string | number)[] = [input.as_of ? normalizeTimestamp(input.as_of) : new Date().toISOString(), userId];
  if (input.query) {
    where.push("(company LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR nickname LIKE ? ESCAPE '\\')");
    const pattern = searchPattern(input.query);
    bindings.push(pattern, pattern, pattern);
  }
  if (input.status) { where.push("status IS ?"); bindings.push(input.status); }
  if (input.phase) { where.push("phase IS ?"); bindings.push(input.phase); }
  if (input.available_only) where.push("(status IS 'active' OR reapply_status IS 'eligible') AND opening_status IS NOT 'closed'");
  if (input.opening_status) { where.push("opening_status IS ?"); bindings.push(input.opening_status); }
  if (input.reapply_status) { where.push("reapply_status IS ?"); bindings.push(input.reapply_status); }
  if (input.ranked_only) where.push("score IS NOT NULL");
  const scoreDirection = input.score_order === "lowest" ? "ASC" : "DESC";
  const columns = input.include_descriptions ? "*" : `id, company, company_url, phase, eligible_opening, opening_status, title, nickname, source_url, location,
    recruiter_name, recruiter_email, notes, status, current_stage, recruiter_engaged_at, reapply_policy, reapply_after, reapply_status,
    score, salary_min, salary_max, salary_currency, salary_period,
    salary_ask_amount, salary_ask_currency, salary_ask_period, salary_ask_basis,
    salary_declared_amount, salary_declared_currency, salary_declared_period, salary_declared_basis,
    employer_salary, asked_salary,
    created_at, updated_at`;
  return db.prepare(`WITH opportunities AS (
    SELECT *, ${openingStatusSql} AS opening_status, ${reapplyStatusSql} AS reapply_status FROM jobs WHERE user_id IS ?
  ) SELECT ${columns},
    (SELECT MAX(o.occurred_at) FROM outreach o WHERE o.user_id IS jobs.user_id AND o.job_id IS jobs.id AND o.direction IS 'outbound') AS last_outreach_at,
    (SELECT MAX(o.occurred_at) FROM outreach o WHERE o.user_id IS jobs.user_id AND o.job_id IS jobs.id AND o.direction IS 'inbound') AS last_response_at,
    (SELECT MIN(c.follow_up_at) FROM contact_activity c WHERE c.user_id IS jobs.user_id AND c.job_id IS jobs.id AND c.needs_follow_up IS 1) AS follow_up_at
    FROM opportunities AS jobs
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY score ${scoreDirection} NULLS LAST, updated_at DESC, id LIMIT ? OFFSET ?`)
    .bind(...bindings, input.limit + 1, input.offset);
}

function listJobsResult(results: D1Result<Omit<Job, "description"> & { description?: string }>, input: ListJobs) {
  const hasMore = results.results.length > input.limit;
  return {
    jobs: results.results.slice(0, input.limit).map(withEligibleOpening),
    next_offset: hasMore ? input.offset + input.limit : null,
  };
}

export async function listJobs(scope: UserStore, input: ListJobs) {
  const results = await execute<Omit<Job, "description"> & { description?: string }>(scope.db, [listJobsStatement(scope, input)]);
  return listJobsResult(results[0]!, input);
}

export async function getLeadContext(scope: UserStore, input: ListJobs) {
  const replacements = v.parse(listJobsSchema, { phase: "lead", opening_status: "closed", limit: input.limit, offset: input.offset });
  const results = await execute(scope.db, [criteriaStatement(scope), listJobsStatement(scope, input), listJobsStatement(scope, replacements)]);
  return { criteria: (results[0]?.results[0] ?? null) as Criteria | null,
    replacement_search: listJobsResult(results[2] as D1Result<Omit<Job, "description"> & { description?: string }>, replacements),
    ...listJobsResult(results[1] as D1Result<Omit<Job, "description"> & { description?: string }>, input) };
}

const requireRow = ({ db, userId }: UserStore, table: "jobs" | "stages" | "contacts" | "outreach" | "prep_notes", id: string, code: string) =>
  check(db, code, `NOT EXISTS (SELECT 1 FROM ${table} WHERE user_id IS ? AND id IS ?)`, userId, id);

function patchStatement({ db, userId }: UserStore, table: "jobs" | "stages" | "feedback" | "contacts" | "outreach", id: string, patch: Record<string, string | number | null | undefined>, expressions: Record<string, string> = {}) {
  const entries = Object.entries(patch).filter((entry) => entry[1] !== undefined);
  const assignments = [...entries.map(([key]) => `${key} = ?`), ...Object.entries(expressions).map(([key, sql]) => `${key} = ${sql}`)];
  if (assignments.length === 0) fail("Provide at least one field to update.");
  return db.prepare(`UPDATE ${table} SET ${assignments.join(", ")}, updated_at = ? WHERE user_id IS ? AND id IS ? RETURNING *`)
    .bind(...entries.map(([, value]) => value), new Date().toISOString(), userId, id);
}

export async function updateJob(scope: UserStore, input: UpdateJob) {
  const { db, userId } = scope;
  const { job_id, eligible_opening, ...patch } = prepareSalaryInput(input);
  const opening = eligible_opening === undefined ? undefined : validateEligibleOpening(eligible_opening);
  const statements = [requireRow(scope, "jobs", job_id, "job_not_found"),
    check(db, "leads_stay_active", `EXISTS (SELECT 1 FROM jobs WHERE user_id IS ? AND id IS ?
      AND coalesce(?, phase) IS 'lead' AND coalesce(?, status) IS NOT 'active')`, userId, job_id, input.phase ?? null, input.status ?? null),
    check(db, "application_to_lead", `? IS 'lead' AND EXISTS (SELECT 1 FROM jobs WHERE user_id IS ? AND id IS ? AND phase IS 'application')`, input.phase ?? null, userId, job_id),
  ];
  if (opening) statements.push(...openingChecks(scope, "?", [JSON.stringify(opening)]));
  else statements.push(check(db, "opening_required", `? OR (? AND EXISTS (SELECT 1 FROM jobs WHERE user_id IS ? AND id IS ? AND phase IS 'lead'))`,
    Number(input.phase !== undefined || input.company !== undefined || input.company_url !== undefined),
    Number(input.status === "active"), userId, job_id));
  if (opening) statements.push(openingCheck(db, "opening_closed", `EXISTS (SELECT 1 FROM opening_closures
    WHERE user_id IS ? AND job_id IS ? AND source_url IS ? AND checked_at >= ?)`, userId, job_id, opening.source_url, opening.checked_at));
  if (patch.recruiter_engaged_at) {
    patch.recruiter_engaged_at = normalizeTimestamp(patch.recruiter_engaged_at);
    if (Date.parse(patch.recruiter_engaged_at) > Date.now()) fail("recruiter_engaged_at records actual recruiter contact and cannot be in the future.");
  }
  if (patch.reapply_after) patch.reapply_after = normalizeTimestamp(patch.reapply_after);
  // Scores for changed descriptions must come from a new ranking.
  const invalidates = [input.company, input.title, input.description, input.location, opening].some((value) => value !== undefined);
  if (invalidates && patch.score === undefined) patch.score = null;
  const expressions = input.phase === "application" && patch.current_stage === undefined
    ? { current_stage: "CASE WHEN phase IS 'lead' THEN 'applied' ELSE current_stage END" } : {};
  try {
    statements.push(patchStatement(scope, "jobs", job_id, { ...patch, eligible_opening: opening ? JSON.stringify(opening) : undefined }, expressions));
    statements.push(db.prepare(`SELECT *, ${openingStatusSql} AS opening_status FROM jobs WHERE user_id IS ? AND id IS ?`).bind(userId, job_id));
    const results = await execute<Job>(db, statements);
    const job = results.at(-1)!.results[0]!;
    return withEligibleOpening({ ...job, reapply_status: job.status !== "rejected" ? "not_applicable"
      : job.reapply_policy === null ? "unknown" : job.reapply_policy === "not_allowed" ? "not_allowed"
      : job.reapply_after !== null && job.reapply_after > new Date().toISOString() ? "cooldown" : "eligible" });
  } catch (error) {
    duplicateError(error);
  }
}

export async function closeOpening(scope: UserStore, input: CloseOpening) {
  const { db, userId } = scope;
  const checkedAt = normalizeTimestamp(input.checked_at ?? new Date().toISOString());
  if (Date.parse(checkedAt) > Date.now()) fail("A closure check cannot be in the future.");
  const now = new Date().toISOString();
  const results = await execute<Job>(db, [
    requireRow(scope, "jobs", input.job_id, "job_not_found"),
    openingCheck(db, "opening_mismatch", `EXISTS (SELECT 1 FROM jobs WHERE user_id IS ? AND id IS ?
      AND coalesce(json_extract(eligible_opening, '$.source_url'), source_url, ?) IS NOT ?)`, userId, input.job_id, input.source_url, input.source_url),
    openingCheck(db, "closure_outdated", `EXISTS (SELECT 1 FROM jobs WHERE user_id IS ? AND id IS ?
      AND json_extract(eligible_opening, '$.checked_at') > ?)`, userId, input.job_id, checkedAt),
    db.prepare(`INSERT INTO opening_closures (user_id, job_id, source_url, reason, checked_at, eligible_opening, created_at)
      SELECT user_id, id, ?, ?, ?, eligible_opening, ? FROM jobs WHERE user_id IS ? AND id IS ?
      ON CONFLICT (user_id, job_id, source_url) DO UPDATE SET reason = excluded.reason, checked_at = excluded.checked_at
      WHERE excluded.checked_at >= opening_closures.checked_at`)
      .bind(input.source_url, input.reason, checkedAt, now, userId, input.job_id),
    db.prepare(`UPDATE jobs SET score = NULL, updated_at = ? WHERE user_id IS ? AND id IS ?`).bind(now, userId, input.job_id),
    db.prepare(`SELECT *, ${openingStatusSql} AS opening_status FROM jobs WHERE user_id IS ? AND id IS ?`).bind(userId, input.job_id),
  ]);
  return withEligibleOpening(results.at(-1)!.results[0]!);
}

export async function removeLead(scope: UserStore, id: string) {
  const { db, userId } = scope;
  const results = await execute<{ id: string }>(db, [requireRow(scope, "jobs", id, "job_not_found"),
    db.prepare(`DELETE FROM jobs WHERE user_id IS ? AND id IS ? AND phase IS 'lead'
    AND current_stage IS 'lead' AND recruiter_engaged_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM stages s WHERE s.user_id IS jobs.user_id AND s.job_id IS jobs.id)
    AND NOT EXISTS (SELECT 1 FROM outreach o WHERE o.user_id IS jobs.user_id AND o.job_id IS jobs.id)
    RETURNING id`).bind(userId, id),
  ]);
  const removed = results.at(-1)?.results[0];
  if (!removed) fail("Only uncontacted leads can be removed. Preserve actual application and communication history.");
  return { job_id: removed.id, removed: true };
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
    validateTimezone(stage.timezone);
    if (stage.ends_at !== null && stage.ends_at <= stage.starts_at) fail("ends_at must be later than starts_at.");
  }
  if (stage.calendar_event_id !== null && stage.calendar_id === null) fail("Provide calendar_id with calendar_event_id.");
}

function validateTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).resolvedOptions();
  } catch {
    fail("Use a valid IANA timezone, for example America/Los_Angeles or UTC.");
  }
}

function startApplication(scope: UserStore, jobSql: string, bindings: unknown[], milestone: AddStage["name"], makeCurrent = false) {
  const { db, userId } = scope;
  const target = `FROM jobs WHERE user_id IS ? AND id IS (${jobSql})`;
  const targetBindings = [userId, ...bindings];
  return [
    check(db, "job_not_found", `NOT EXISTS (SELECT 1 ${target})`, ...targetBindings),
    openingCheck(db, "opening_closed", `EXISTS (SELECT 1 ${target} AND phase IS 'lead' AND (${openingStatusSql}) IS 'closed')`, ...targetBindings),
    ...openingChecks(scope, `SELECT eligible_opening ${target}`, targetBindings,
      `EXISTS (SELECT 1 ${target} AND phase IS 'lead')`, targetBindings),
    db.prepare(`UPDATE jobs SET phase = 'application',
      current_stage = CASE WHEN phase IS 'lead' OR ? THEN ? ELSE current_stage END, updated_at = ?
      WHERE user_id IS ? AND id IS (${jobSql}) AND (phase IS 'lead' OR ?)`)
      .bind(Number(makeCurrent), milestone, new Date().toISOString(), ...targetBindings, Number(makeCurrent)),
  ];
}

export async function addStage(scope: UserStore, input: AddStage) {
  const { db, userId } = scope;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const startsAt = input.starts_at ? normalizeTimestamp(input.starts_at) : null;
  const endsAt = input.ends_at ? normalizeTimestamp(input.ends_at) : null;
  const timezone = input.timezone ?? (startsAt === null ? null : "UTC");
  validateSchedule({ starts_at: startsAt, ends_at: endsAt, timezone, calendar_event_id: null, calendar_id: null });
  const statements = [...startApplication(scope, "?", [input.job_id], input.name, input.make_current), db.prepare(`INSERT INTO stages
    (user_id, id, job_id, name, status, starts_at, ends_at, timezone, location, contact_name, contact_email, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).bind(userId, id, input.job_id, input.name,
    input.status, startsAt, endsAt, timezone, input.location ?? null, input.contact_name ?? null,
    input.contact_email ?? null, input.notes ?? null, now, now)];
  const results = await execute<Stage>(db, statements);
  return results.at(-1)?.results[0];
}

export async function updateStage(scope: UserStore, input: UpdateStage) {
  const { db, userId } = scope;
  const { stage_id, make_current, ...patch } = input;
  if (patch.starts_at) patch.starts_at = normalizeTimestamp(patch.starts_at);
  if (patch.ends_at) patch.ends_at = normalizeTimestamp(patch.ends_at);
  if (patch.timezone) validateTimezone(patch.timezone);
  if (Object.keys(patch).length === 0 && !make_current) fail("Provide a field to update or set make_current to true.");
  const statements = [requireRow(scope, "stages", stage_id, "stage_not_found")];
  if (make_current) statements.push(check(db, "legacy_milestone", `EXISTS (SELECT 1 FROM stages WHERE user_id IS ? AND id IS ?
    AND coalesce(?, name) NOT IN (${pipelineStageSchema.options.map(() => "?").join(", ")}))`, userId, stage_id, patch.name ?? null, ...pipelineStageSchema.options));
  const expressions: Record<string, string> = patch.starts_at && patch.timezone === undefined ? { timezone: "coalesce(timezone, 'UTC')" } : {};
  if (Object.keys(patch).length > 0) statements.push(patchStatement(scope, "stages", stage_id, patch, expressions));
  if (make_current) statements.push(db.prepare(`UPDATE jobs SET current_stage = (SELECT name FROM stages WHERE user_id IS ? AND id IS ?), updated_at = ?
    WHERE user_id IS ? AND id IS (SELECT job_id FROM stages WHERE user_id IS ? AND id IS ?)`)
    .bind(userId, stage_id, new Date().toISOString(), userId, userId, stage_id));
  statements.push(db.prepare("SELECT * FROM stages WHERE user_id IS ? AND id IS ?").bind(userId, stage_id));
  const results = await execute<Stage>(db, statements);
  return results.at(-1)?.results[0];
}

export async function updateContact(scope: UserStore, input: UpdateContact) {
  const { db, userId } = scope;
  const { contact_id, job_id, ...patch } = input;
  try {
    const results = await execute<Contact>(db, [
      requireRow(scope, "contacts", contact_id, "contact_not_found"),
      check(db, "contact_job", `EXISTS (SELECT 1 FROM contacts WHERE user_id IS ? AND id IS ? AND job_id IS NOT ?)`, userId, contact_id, job_id),
      check(db, "contact_communication", `NOT EXISTS (SELECT 1 FROM outreach WHERE user_id IS ? AND contact_id IS ?)`, userId, contact_id),
      patchStatement(scope, "contacts", contact_id, patch),
    ]);
    return results.at(-1)?.results[0];
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
  const jobSql = input.contact ? "?" : "SELECT job_id FROM contacts WHERE user_id IS ? AND id IS ?";
  const jobBindings = input.contact ? [input.contact.job_id] : [userId, input.contact_id];
  if (input.time_basis === "reported" && !input.occurred_at) fail("Reported event times require occurred_at; omit both to record the logging time.");
  const now = new Date().toISOString();
  const occurredAt = input.occurred_at ? normalizeTimestamp(input.occurred_at) : now;
  const followUpAt = input.follow_up_at ? normalizeTimestamp(input.follow_up_at) : null;
  const followUpStatus = input.follow_up_status ?? (input.direction === "outbound" || followUpAt !== null ? "pending" : null);
  validateOutreach({ direction: input.direction, occurred_at: occurredAt, follow_up_at: followUpAt, follow_up_status: followUpStatus });
  const contactId = input.contact_id ?? crypto.randomUUID();
  const outreachId = crypto.randomUUID();
  const statements: Statement[] = [];
  if (input.contact_id) statements.push(requireRow(scope, "contacts", input.contact_id, "contact_not_found"));
  if (input.stage_id) statements.push(
    requireRow(scope, "stages", input.stage_id, "stage_not_found"),
    check(db, "stage_job", `EXISTS (SELECT 1 FROM stages WHERE user_id IS ? AND id IS ? AND job_id IS NOT (${jobSql}))`,
      userId, input.stage_id, ...jobBindings),
  );
  statements.push(...startApplication(scope, jobSql, jobBindings, "outreach"));
  if (input.contact) {
    statements.push(db.prepare(`INSERT INTO contacts (user_id, id, job_id, name, relationship, url, email, notes, created_at, updated_at)
      VALUES (?, ?, (${jobSql}), ?, ?, ?, ?, ?, ?, ?)`).bind(userId, contactId, ...jobBindings, input.contact.name,
      input.contact.relationship ?? "other", input.contact.url ?? null, input.contact.email ?? null, input.contact.notes ?? null, now, now));
  }
  statements.push(db.prepare(`INSERT INTO outreach (user_id, id, job_id, contact_id, stage_id, direction, occurred_at,
    time_basis, channel, notes, follow_up_at, follow_up_status, created_at, updated_at)
    VALUES (?, ?, (${jobSql}), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .bind(userId, outreachId, ...jobBindings, contactId, input.stage_id ?? null, input.direction, occurredAt,
      input.time_basis ?? (input.occurred_at ? "reported" : "recorded"), input.channel ?? null, input.notes ?? null,
      followUpAt, followUpStatus, now, now));
  try {
    const results = await execute<Outreach>(db, statements);
    return results.at(-1)?.results[0];
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      fail("A contact with this URL or email already exists for this job. Use get_job, then record_outreach with its contact_id.");
    }
    throw error;
  }
}

export async function updateOutreach(scope: UserStore, input: UpdateOutreach) {
  const { outreach_id, ...patch } = input;
  if (patch.occurred_at) {
    patch.occurred_at = normalizeTimestamp(patch.occurred_at);
    patch.time_basis ??= "reported";
  }
  if (patch.follow_up_at) {
    patch.follow_up_at = normalizeTimestamp(patch.follow_up_at);
    patch.follow_up_status ??= "pending";
  }
  if (patch.occurred_at && Date.parse(patch.occurred_at) > Date.now()) fail("Outreach records actual communication; occurred_at cannot be in the future.");
  const results = await execute<Outreach>(scope.db, [requireRow(scope, "outreach", outreach_id, "outreach_not_found"),
    patchStatement(scope, "outreach", outreach_id, patch)]);
  return results.at(-1)?.results[0];
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
  const results = await execute<ContactActivity & Pick<Job, "company" | "title" | "phase" | "current_stage" | "recruiter_engaged_at">>(db, [db.prepare(`SELECT c.*, j.company, j.title, j.phase, j.current_stage, j.recruiter_engaged_at
    FROM contact_activity c JOIN jobs j ON j.user_id IS c.user_id AND j.id IS c.job_id
    WHERE ${where.join(" AND ")}
    ORDER BY (j.recruiter_engaged_at IS NOT NULL), c.follow_up_at ASC NULLS LAST, c.last_outreach_at, c.id LIMIT ? OFFSET ?`)
    .bind(...bindings, input.limit + 1, input.offset)]);
  const result = results[0]!;
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
  const now = new Date().toISOString();
  const results = await execute<Feedback>(db, [requireRow(scope, "stages", input.stage_id, "stage_not_found"),
    db.prepare(`INSERT INTO feedback (user_id, id, stage_id, text, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`).bind(userId, crypto.randomUUID(), input.stage_id, input.text, input.source, now, now),
  ]);
  return results.at(-1)?.results[0];
}

export async function updateFeedback(scope: UserStore, input: UpdateFeedback) {
  const { feedback_id, ...patch } = input;
  const feedback = await first<Feedback>(scope.db, patchStatement(scope, "feedback", feedback_id, patch));
  if (!feedback) fail("Feedback not found. Use get_job or list_feedback to find feedback_id values.");
  return feedback;
}

export async function listFeedback({ db, userId }: UserStore, input: ListFeedback) {
  const where = ["f.user_id IS ?"];
  const bindings: string[] = [userId];
  if (input.job_id) { where.push("s.job_id IS ?"); bindings.push(input.job_id); }
  if (input.stage_name) { where.push("s.name LIKE ? ESCAPE '\\'"); bindings.push(searchPattern(input.stage_name)); }
  if (input.source) { where.push("f.source IS ?"); bindings.push(input.source); }
  const batch = await execute<Feedback>(db, [db.prepare(`SELECT f.*, s.name AS stage_name, s.status AS stage_status,
    s.job_id, j.company, j.title, j.nickname FROM feedback f JOIN stages s ON s.id IS f.stage_id AND s.user_id IS f.user_id
    JOIN jobs j ON j.id IS s.job_id AND j.user_id IS s.user_id WHERE ${where.join(" AND ")} ORDER BY f.created_at DESC, f.id LIMIT ? OFFSET ?`)
    .bind(...bindings, input.limit + 1, input.offset)]);
  const results = batch[0]!;
  return { feedback: results.results.slice(0, input.limit), next_offset: results.results.length > input.limit ? input.offset + input.limit : null };
}

export async function getUpcoming({ db, userId }: UserStore, input: Upcoming) {
  const from = normalizeTimestamp(input.from);
  const to = input.to ? normalizeTimestamp(input.to) : null;
  if (to !== null && to <= from) fail("to must be later than from.");
  const batch = await execute<Stage>(db, [db.prepare(`SELECT s.*, j.company, j.title, j.nickname, j.recruiter_name, j.recruiter_email
    FROM stages s JOIN jobs j ON j.id IS s.job_id AND j.user_id IS s.user_id WHERE s.user_id IS ? AND s.status IN ('planned', 'in_progress')
    AND j.status IN ('active', 'offer') AND s.starts_at >= ? AND (? IS NULL OR s.starts_at < ?)
    ORDER BY s.starts_at, s.id LIMIT ? OFFSET ?`).bind(userId, from, to, to, input.limit + 1, input.offset)]);
  const results = batch[0]!;
  return { stages: results.results.slice(0, input.limit), next_offset: results.results.length > input.limit ? input.offset + input.limit : null };
}

export async function getCalendarEvent(scope: UserStore, input: CalendarEvent) {
  const { db, userId } = scope;
  const results = await execute(db, [
    db.prepare("SELECT * FROM stages WHERE user_id IS ? AND id IS ?").bind(userId, input.stage_id),
    db.prepare(`SELECT * FROM jobs WHERE user_id IS ? AND id IS (SELECT job_id FROM stages WHERE user_id IS ? AND id IS ?)`)
      .bind(userId, userId, input.stage_id),
  ]);
  const stage = results[0]?.results[0] as Stage | undefined;
  if (!stage) fail("Stage not found. Use get_job to load its stages and stage_id values.");
  const job = results[1]!.results[0] as Job;
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
