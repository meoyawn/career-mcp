import type { AddFeedback, AddJobs, AddStage, CalendarEvent, ListFeedback, ListJobs, QualifyJobs, Upcoming, UpdateFeedback, UpdateJob, UpdateStage } from "./schemas.ts";

export interface UserStore {
  db: D1Database;
  userId: string;
}

interface Criteria {
  id: number;
  text: string;
  revision: number;
  updated_at: string;
}

interface Job {
  id: string;
  company: string;
  title: string;
  nickname: string | null;
  description: string;
  source_url: string | null;
  location: string | null;
  recruiter_name: string | null;
  recruiter_email: string | null;
  notes: string | null;
  status: string;
  current_stage: string;
  qualification: string;
  score: number | null;
  qualification_reason: string | null;
  criteria_revision: number | null;
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

function fail(message: string): never {
  throw new Error(message, { cause: "user" });
}

export const getCriteria = ({ db, userId }: UserStore) => db.prepare("SELECT * FROM criteria WHERE user_id IS ?").bind(userId).first<Criteria>();

export function setCriteria({ db, userId }: UserStore, text: string) {
  return db.prepare(`INSERT INTO criteria (user_id, id, text, revision, updated_at) VALUES (?, 1, ?, 1, ?)
    ON CONFLICT(user_id) DO UPDATE SET text = excluded.text, revision = criteria.revision + 1, updated_at = excluded.updated_at
    RETURNING *`).bind(userId, text, new Date().toISOString()).first<Criteria>();
}

function duplicateError(error: unknown): never {
  if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
    fail("A nickname or source URL already exists. Use list_jobs to find the existing job; choose a distinct nickname for another opening.");
  }
  throw error;
}

export async function addJobs({ db, userId }: UserStore, { jobs }: AddJobs) {
  const now = new Date().toISOString();
  const statements = jobs.map((job) => db.prepare(`INSERT INTO jobs
    (user_id, id, company, title, nickname, description, source_url, location, recruiter_name, recruiter_email, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).bind(
    userId, crypto.randomUUID(), job.company, job.title, job.nickname ?? null, job.description, job.source_url ?? null,
    job.location ?? null, job.recruiter_name ?? null, job.recruiter_email ?? null, job.notes ?? null, now, now,
  ));
  try {
    const results = await db.batch<Job>(statements);
    return { jobs: results.flatMap((result) => result.results) };
  } catch (error) {
    duplicateError(error);
  }
}

async function requireJob({ db, userId }: UserStore, id: string) {
  const job = await db.prepare("SELECT * FROM jobs WHERE user_id IS ? AND id IS ?").bind(userId, id).first<Job>();
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
  const [criteria, stages, feedback] = await Promise.all([
    getCriteria(scope),
    db.prepare("SELECT * FROM stages WHERE user_id IS ? AND job_id IS ? ORDER BY created_at, rowid").bind(userId, id).all<Stage>(),
    db.prepare(`SELECT f.*, s.name AS stage_name FROM feedback f JOIN stages s ON s.id IS f.stage_id AND s.user_id IS f.user_id
      WHERE f.user_id IS ? AND s.job_id IS ? ORDER BY f.created_at, f.rowid`).bind(userId, id).all<Feedback & { stage_name: string }>(),
  ]);
  return { criteria, job, stages: stages.results, feedback: feedback.results };
}

const searchPattern = (query: string) => `%${query.replace(/[\\%_]/gu, "\\$&")}%`;

export async function listJobs({ db, userId }: UserStore, input: ListJobs) {
  const where = ["user_id IS ?"];
  const bindings: (string | number)[] = [userId];
  if (input.query) {
    where.push("(company LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR nickname LIKE ? ESCAPE '\\')");
    const pattern = searchPattern(input.query);
    bindings.push(pattern, pattern, pattern);
  }
  if (input.status) { where.push("status IS ?"); bindings.push(input.status); }
  if (input.qualification) { where.push("qualification IS ?"); bindings.push(input.qualification); }
  const review = "(criteria_revision IS NULL OR criteria_revision IS NOT (SELECT revision FROM criteria WHERE user_id IS jobs.user_id))";
  if (input.needs_review !== undefined) where.push(input.needs_review ? review : `NOT ${review}`);
  const columns = input.include_descriptions ? "*" : `id, company, title, nickname, source_url, location,
    recruiter_name, recruiter_email, notes, status, current_stage, qualification, score, qualification_reason,
    criteria_revision, created_at, updated_at`;
  const results = await db.prepare(`SELECT ${columns}, ${review} AS needs_review FROM jobs
    WHERE ${where.join(" AND ")} ORDER BY score DESC NULLS LAST, updated_at DESC, id LIMIT ? OFFSET ?`)
    .bind(...bindings, input.limit + 1, input.offset).all<Omit<Job, "description"> & { description?: string; needs_review: number }>();
  const hasMore = results.results.length > input.limit;
  return {
    jobs: results.results.slice(0, input.limit),
    next_offset: hasMore ? input.offset + input.limit : null,
  };
}

export async function qualifyJobs(scope: UserStore, input: QualifyJobs) {
  const { db, userId } = scope;
  const criteria = await getCriteria(scope);
  if (!criteria) fail("Save your criteria with set_criteria before qualifying jobs.");
  if (criteria.revision !== input.criteria_revision) fail("Criteria changed. Load get_context and rank against the current revision.");
  const ids = input.decisions.map((decision) => decision.job_id);
  if (new Set(ids).size !== ids.length) fail("Each job_id must occur only once in decisions.");
  const found = await db.prepare(`SELECT id FROM jobs WHERE user_id IS ? AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(userId, ...ids).all<{ id: string }>();
  if (found.results.length !== ids.length) fail("One or more job_id values do not exist. No decisions were saved.");
  const now = new Date().toISOString();
  try {
    const results = await db.batch<Job>(input.decisions.map((decision) => db.prepare(`UPDATE jobs
      SET qualification = ?, score = ?, qualification_reason = ?,
        criteria_revision = (SELECT revision FROM criteria WHERE user_id IS ? AND revision IS ?), updated_at = ?
      WHERE user_id IS ? AND id IS ? RETURNING *`).bind(decision.qualification, decision.score, decision.reason,
      userId, input.criteria_revision, now, userId, decision.job_id)));
    return { jobs: results.flatMap((result) => result.results) };
  } catch (error) {
    if (error instanceof Error && error.message.includes("CHECK constraint failed")) {
      fail("Criteria changed while saving. No decisions were saved. Load get_context and rank again.");
    }
    throw error;
  }
}

function patchStatement({ db, userId }: UserStore, table: "jobs" | "stages" | "feedback", id: string, patch: Record<string, string | null | undefined>) {
  const entries = Object.entries(patch).filter((entry) => entry[1] !== undefined);
  if (entries.length === 0) fail("Provide at least one field to update.");
  return db.prepare(`UPDATE ${table} SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE user_id IS ? AND id IS ? RETURNING *`)
    .bind(...entries.map(([, value]) => value), new Date().toISOString(), userId, id);
}

export async function updateJob(scope: UserStore, input: UpdateJob) {
  const { db, userId } = scope;
  await requireJob(scope, input.job_id);
  const { job_id, ...patch } = input;
  const statement = patchStatement(scope, "jobs", job_id, patch);
  // Changes to the opening invalidate its earlier assessment against the criteria.
  const invalidates = [input.company, input.title, input.description, input.location].some((value) => value !== undefined);
  try {
    if (invalidates) {
      const results = await db.batch<Job>([
        statement,
        db.prepare(`UPDATE jobs SET qualification = 'pending', score = NULL, qualification_reason = NULL,
          criteria_revision = NULL WHERE user_id IS ? AND id IS ? RETURNING *`).bind(userId, job_id),
      ]);
      return results[1]?.results[0];
    }
    return await statement.first<Job>();
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
    title: `${job.company} — ${stage.name} (${job.title})`,
    start_time: stage.starts_at,
    end_time: stage.ends_at,
    timezone_str: "UTC",
    description: `Company: ${job.company}\nRole: ${job.title}\nStage: ${stage.name}${job.source_url ? `\nOpening: ${job.source_url}` : ""}\nCareers MCP stage: ${stage.id}`,
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
