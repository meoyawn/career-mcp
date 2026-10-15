import * as v from "valibot";

const text = (max: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(max), v.regex(/^[\s\S]*\S[\s\S]*$/, "Use non-blank text."));
const id = v.pipe(v.string(), v.uuid());
const email = v.pipe(v.string(), v.email(), v.maxLength(320));
const url = v.pipe(v.string(), v.url(), v.regex(/^https?:\/\/[\s\S]*$/, "Use an HTTP or HTTPS URL."), v.maxLength(2_000));
const timestamp = v.pipe(v.string(), v.isoTimestamp());
const jobStatus = v.picklist(["active", "rejected", "withdrawn", "offer", "accepted"]);
const phase = v.picklist(["lead", "application"]);
const reapplyStatus = v.picklist(["not_applicable", "unknown", "not_allowed", "cooldown", "eligible"]);
const score = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100));
const stageStatus = v.picklist(["planned", "in_progress", "passed", "failed", "completed", "cancelled"]);
const source = v.picklist(["self", "recruiter", "interviewer"]);
const limit = v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)), 25);
const offset = v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100_000)), 0);
const salaryAmount = v.pipe(v.number(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));
const salaryFields = {
  salary_min: v.optional(v.nullable(salaryAmount)),
  salary_max: v.optional(v.nullable(salaryAmount)),
  salary_currency: v.optional(v.nullable(v.pipe(v.string(), v.regex(/^[A-Z]{3}$/, "Use a three-letter uppercase currency code, such as USD, EUR, or RUB.")))),
  salary_period: v.optional(v.nullable(v.picklist(["hour", "day", "week", "month", "year"]))),
};

export const emptySchema = v.strictObject({});
export const criteriaSchema = v.strictObject({ text: text(20_000) });
export const applicationContextSchema = v.strictObject({ text: v.nullable(text(30_000)) });
export const applicantProfileSchema = v.strictObject({ gender: v.nullable(text(200)) });
export const applicantContactSchema = v.strictObject({
  email: v.optional(v.nullable(email)),
  phone: v.optional(v.nullable(v.pipe(v.string(), v.regex(/^\+[1-9]\d{1,14}$/, "Use an international phone number such as +12025550123, without spaces.")))),
});
export const getApplicationContextSchema = v.strictObject({ job_id: v.optional(id) });
export const cvSchema = v.strictObject({
  language: v.pipe(v.string(), v.maxLength(100), v.regex(/^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/, "Use a language tag such as en, ru, or pt-BR.")),
  url: v.nullable(url),
});
export const jobIdSchema = v.strictObject({ job_id: id });

export const addJobSchema = v.strictObject({
  ...salaryFields,
  company: text(200),
  company_url: v.optional(url),
  phase: v.optional(phase, "lead"),
  title: v.optional(text(300)),
  nickname: v.optional(text(200)),
  description: v.optional(text(30_000)),
  source_url: v.optional(url),
  location: v.optional(text(500)),
  recruiter_name: v.optional(text(200)),
  recruiter_email: v.optional(email),
  notes: v.optional(text(20_000)),
  score: v.optional(score),
});

export const maxJobsPerBatch = 100;
export const addJobsSchema = v.strictObject({
  jobs: v.pipe(v.array(addJobSchema), v.minLength(1), v.maxLength(maxJobsPerBatch, `Save at most ${maxJobsPerBatch} employers or applications per call. Split larger imports into batches of up to ${maxJobsPerBatch}; keep every employer.`)),
});

export const listJobsSchema = v.strictObject({
  query: v.optional(text(300)),
  status: v.optional(jobStatus),
  phase: v.optional(phase),
  available_only: v.optional(v.boolean(), false),
  reapply_status: v.optional(reapplyStatus),
  as_of: v.optional(timestamp),
  include_descriptions: v.optional(v.boolean(), false),
  limit,
  offset,
});

export const updateJobSchema = v.strictObject({
  ...salaryFields,
  job_id: id,
  company: v.optional(text(200)),
  company_url: v.optional(v.nullable(url)),
  phase: v.optional(phase),
  title: v.optional(v.nullable(text(300))),
  nickname: v.optional(v.nullable(text(200))),
  description: v.optional(v.nullable(text(30_000))),
  source_url: v.optional(v.nullable(url)),
  location: v.optional(v.nullable(text(500))),
  recruiter_name: v.optional(v.nullable(text(200))),
  recruiter_email: v.optional(v.nullable(email)),
  notes: v.optional(v.nullable(text(20_000))),
  status: v.optional(jobStatus),
  current_stage: v.optional(text(200)),
  recruiter_engaged_at: v.optional(v.nullable(timestamp)),
  reapply_policy: v.optional(v.nullable(v.picklist(["allowed", "not_allowed"]))),
  reapply_after: v.optional(v.nullable(timestamp)),
  score: v.optional(v.nullable(score)),
});

const stageFields = {
  name: text(200),
  status: stageStatus,
  starts_at: v.nullable(timestamp),
  ends_at: v.nullable(timestamp),
  timezone: v.nullable(text(100)),
  location: v.nullable(text(2_000)),
  contact_name: v.nullable(text(200)),
  contact_email: v.nullable(email),
  notes: v.nullable(text(20_000)),
  calendar_event_id: v.nullable(text(1_000)),
  calendar_id: v.nullable(text(1_000)),
};

export const addStageSchema = v.strictObject({
  job_id: id,
  name: stageFields.name,
  status: v.optional(stageStatus, "planned"),
  starts_at: v.optional(timestamp),
  ends_at: v.optional(timestamp),
  timezone: v.optional(text(100)),
  location: v.optional(text(2_000)),
  contact_name: v.optional(text(200)),
  contact_email: v.optional(email),
  notes: v.optional(text(20_000)),
  make_current: v.optional(v.boolean(), true),
});

export const updateStageSchema = v.strictObject({
  stage_id: id,
  ...v.partial(v.strictObject(stageFields)).entries,
  make_current: v.optional(v.boolean(), false),
});

const contactFields = {
  name: text(200),
  relationship: v.optional(text(200)),
  url: v.optional(v.nullable(url)),
  email: v.optional(v.nullable(email)),
  notes: v.optional(v.nullable(text(20_000))),
};

export const updateContactSchema = v.strictObject({
  job_id: id,
  contact_id: id,
  ...contactFields,
});

const outreachFields = {
  occurred_at: timestamp,
  time_basis: v.picklist(["reported", "recorded"]),
  channel: v.nullable(text(100)),
  notes: v.nullable(text(20_000)),
  follow_up_at: v.nullable(timestamp),
  follow_up_status: v.picklist(["pending", "done", "cancelled"]),
};

export const recordOutreachSchema = v.strictObject({
  contact_id: v.optional(id),
  contact: v.optional(v.strictObject({ job_id: id, ...contactFields })),
  stage_id: v.optional(id),
  direction: v.picklist(["outbound", "inbound"]),
  ...v.partial(v.strictObject(outreachFields)).entries,
});

export const updateOutreachSchema = v.strictObject({
  outreach_id: id,
  ...v.partial(v.strictObject(outreachFields)).entries,
});

export const followUpsSchema = v.strictObject({
  job_id: v.optional(id),
  as_of: v.optional(timestamp),
  due_only: v.optional(v.boolean(), false),
  pre_recruiter_only: v.optional(v.boolean(), false),
  reached_out_before: v.optional(timestamp),
  limit,
  offset,
});

export const feedbackSchema = v.strictObject({
  stage_id: id,
  text: text(30_000),
  source: v.optional(source, "self"),
});

export const updateFeedbackSchema = v.strictObject({
  feedback_id: id,
  text: text(30_000),
  source: v.optional(source),
});

export const listFeedbackSchema = v.strictObject({
  job_id: v.optional(id),
  stage_name: v.optional(text(200)),
  source: v.optional(source),
  limit,
  offset,
});

export const upcomingSchema = v.strictObject({
  from: timestamp,
  to: v.optional(timestamp),
  limit,
  offset,
});

export const calendarEventSchema = v.strictObject({
  stage_id: id,
  calendar_id: v.optional(text(1_000)),
  attendees: v.optional(v.pipe(v.array(email), v.maxLength(50)), []),
});

export const rankPromptSchema = v.strictObject({
  limit: v.optional(v.pipe(v.string(), v.regex(/^(?:[1-9]|1\d|2[0-5])$/)), "25"),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,5}$/)), "0"),
});

export type AddJobs = v.InferOutput<typeof addJobsSchema>;
export type ListJobs = v.InferOutput<typeof listJobsSchema>;
export type SetApplicantContact = v.InferOutput<typeof applicantContactSchema>;
export type UpdateJob = v.InferOutput<typeof updateJobSchema>;
export type AddStage = v.InferOutput<typeof addStageSchema>;
export type UpdateStage = v.InferOutput<typeof updateStageSchema>;
export type UpdateContact = v.InferOutput<typeof updateContactSchema>;
export type RecordOutreach = v.InferOutput<typeof recordOutreachSchema>;
export type UpdateOutreach = v.InferOutput<typeof updateOutreachSchema>;
export type FollowUps = v.InferOutput<typeof followUpsSchema>;
export type AddFeedback = v.InferOutput<typeof feedbackSchema>;
export type UpdateFeedback = v.InferOutput<typeof updateFeedbackSchema>;
export type ListFeedback = v.InferOutput<typeof listFeedbackSchema>;
export type Upcoming = v.InferOutput<typeof upcomingSchema>;
export type CalendarEvent = v.InferOutput<typeof calendarEventSchema>;
