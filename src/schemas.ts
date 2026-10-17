import * as v from "valibot";

const text = (max: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(max), v.regex(/^[\s\S]*\S[\s\S]*$/, "Use non-blank text."));
const id = v.pipe(v.string(), v.uuid());
const email = v.pipe(v.string(), v.email(), v.maxLength(320));
const url = v.pipe(v.string(), v.url(), v.regex(/^https?:\/\/[\s\S]*$/, "Use an HTTP or HTTPS URL."), v.maxLength(2_000));
const timestamp = v.pipe(v.string(), v.isoTimestamp());
const jobStatus = v.picklist(["active", "rejected", "withdrawn", "offer", "accepted"]);
const phase = v.picklist(["lead", "application"]);
const reapplyStatus = v.picklist(["not_applicable", "unknown", "not_allowed", "cooldown", "eligible"]);
const score = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100), v.description("Employer/opening fit against saved selection criteria, 0–100 with higher better. Never encode application order, practice sequencing, or temporary priority."));
const stageStatus = v.picklist(["planned", "in_progress", "passed", "failed", "completed", "cancelled"]);
export const pipelineStageSchema = v.picklist([
  "applied", "outreach", "recruiter_screen", "assessment", "technical_interview",
  "system_design", "hiring_manager", "final_interview", "reference_check", "offer",
], "Choose a predefined pipeline milestone. Prepared forms, drafts, and browser handoffs are not pipeline stages.");
const currentStage = v.picklist(["lead", ...pipelineStageSchema.options]);
export const jobLifecycleSchema = v.variant("phase", [
  v.object({
    phase: v.literal("lead"),
    status: v.literal("active"),
    current_stage: v.literal("lead"),
    recruiter_engaged_at: v.null(),
    reapply_policy: v.null(),
    reapply_after: v.null(),
  }),
  v.object({
    phase: v.literal("application"),
    status: jobStatus,
    current_stage: pipelineStageSchema,
    recruiter_engaged_at: v.nullable(timestamp),
    reapply_policy: v.nullable(v.picklist(["allowed", "not_allowed"])),
    reapply_after: v.nullable(timestamp),
  }),
]);
const source = v.picklist(["self", "recruiter", "interviewer"]);
const pageSize = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100));
const limit = v.optional(pageSize, 25);
const offset = v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100_000)), 0);
const scoreOrder = v.optional(v.picklist(["highest", "lowest"]), "highest");
const salaryAmount = v.pipe(v.number(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));
const salaryCurrency = v.pipe(v.string(), v.regex(/^[A-Z]{3}$/, "Use a three-letter uppercase currency code, such as USD, EUR, or RUB."));
const salaryPeriod = v.picklist(["hour", "day", "week", "month", "year"]);
export const salaryRangeSchema = v.strictObject({
  min: v.optional(v.nullable(salaryAmount), null),
  max: v.optional(v.nullable(salaryAmount), null),
  currency: v.optional(v.nullable(salaryCurrency), null),
  period: v.optional(v.nullable(salaryPeriod), null),
  basis: v.optional(v.nullable(v.picklist(["gross", "net"])), null),
  text: v.optional(v.nullable(text(2_000)), null),
  source_url: v.optional(v.nullable(url), null),
  context: v.optional(v.nullable(text(2_000)), null),
});
const compensationFields = {
  employer_salary: v.optional(v.nullable(v.pipe(salaryRangeSchema, v.description("Pay advertised or confirmed by the employer. Full replacement; null clears only employer pay. Preserve original text and source_url; leave unknown units null. Never save the applicant's ask here.")))),
  asked_salary: v.optional(v.nullable(v.pipe(salaryRangeSchema, v.description("Salary actually requested by the applicant in a submitted form, message, or call. Use min=max for an exact amount. Full replacement; null clears only this communicated ask. context can identify the form/call and date. A private target or employer budget is not an actual ask.")))),
};
const salaryFields = {
  salary_min: v.optional(v.nullable(v.pipe(salaryAmount, v.description("Legacy employer-advertised minimum; prefer employer_salary. This is not the applicant's ask.")))),
  salary_max: v.optional(v.nullable(salaryAmount)),
  salary_currency: v.optional(v.nullable(salaryCurrency)),
  salary_period: v.optional(v.nullable(salaryPeriod)),
};
const salaryAskFields = {
  salary_ask_amount: v.optional(v.nullable(v.pipe(salaryAmount, v.description("Private current negotiation target. This does not establish that an amount was communicated; use asked_salary for actual asks.")))),
  salary_ask_currency: v.optional(v.nullable(salaryCurrency)),
  salary_ask_period: v.optional(v.nullable(salaryPeriod)),
  salary_ask_basis: v.optional(v.nullable(v.picklist(["gross", "net"]))),
};
const salaryDeclaredFields = {
  salary_declared_amount: v.optional(v.nullable(v.pipe(salaryAmount, v.description("Legacy exact amount actually communicated by the applicant. Prefer asked_salary, which also supports ranges. This is not employer-advertised pay or a private target.")))),
  salary_declared_currency: v.optional(v.nullable(salaryCurrency)),
  salary_declared_period: v.optional(v.nullable(salaryPeriod)),
  salary_declared_basis: v.optional(v.nullable(v.picklist(["gross", "net"]))),
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
export const pipelineSchema = v.strictObject({ limit, offset });
export const interviewPrepSchema = v.strictObject({
  job_id: v.optional(id),
  stage_id: v.optional(id),
  stage_name: v.optional(pipelineStageSchema),
});

export const eligibleOpeningSchema = v.strictObject({
  title: text(300),
  description: text(30_000),
  source_url: url,
  location: text(500),
  status: v.literal("open"),
  eligibility: v.literal("eligible"),
  checked_at: timestamp,
  criteria_updated_at: timestamp,
  eligibility_reason: text(5_000),
});

export const addJobSchema = v.strictObject({
  ...compensationFields,
  ...salaryFields,
  ...salaryAskFields,
  ...salaryDeclaredFields,
  company: text(200),
  company_url: v.optional(url),
  phase: v.optional(phase, "lead"),
  eligible_opening: v.optional(eligibleOpeningSchema),
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
  jobs: v.pipe(v.array(addJobSchema), v.minLength(1), v.maxLength(maxJobsPerBatch, `Save at most ${maxJobsPerBatch} employers or applications per call. Split larger imports into batches of up to ${maxJobsPerBatch}; save only opportunities that meet the criteria.`)),
});

export const listJobsSchema = v.strictObject({
  query: v.optional(text(300)),
  status: v.optional(jobStatus),
  phase: v.optional(phase),
  available_only: v.optional(v.boolean(), false),
  reapply_status: v.optional(reapplyStatus),
  as_of: v.optional(timestamp),
  include_descriptions: v.optional(v.boolean(), false),
  score_order: scoreOrder,
  ranked_only: v.optional(v.boolean(), false),
  limit,
  offset,
});

export const nextLeadsSchema = v.strictObject({
  order: scoreOrder,
  limit: v.optional(pageSize, 1),
  offset,
});

export const updateJobSchema = v.strictObject({
  ...compensationFields,
  ...salaryFields,
  ...salaryAskFields,
  ...salaryDeclaredFields,
  job_id: id,
  company: v.optional(text(200)),
  company_url: v.optional(v.nullable(url)),
  phase: v.optional(phase),
  eligible_opening: v.optional(eligibleOpeningSchema),
  title: v.optional(v.nullable(text(300))),
  nickname: v.optional(v.nullable(text(200))),
  description: v.optional(v.nullable(text(30_000))),
  source_url: v.optional(v.nullable(url)),
  location: v.optional(v.nullable(text(500))),
  recruiter_name: v.optional(v.nullable(text(200))),
  recruiter_email: v.optional(v.nullable(email)),
  notes: v.optional(v.nullable(text(20_000))),
  status: v.optional(v.pipe(jobStatus, v.description("Leads must stay active. Other statuses describe actual application outcomes only. Use remove_lead when an uncontacted lead no longer meets the selection criteria; never mark it withdrawn or rejected."))),
  current_stage: v.optional(currentStage),
  recruiter_engaged_at: v.optional(v.nullable(timestamp)),
  reapply_policy: v.optional(v.nullable(v.picklist(["allowed", "not_allowed"]))),
  reapply_after: v.optional(v.nullable(timestamp)),
  score: v.optional(v.nullable(score)),
});

export const addPrepNoteSchema = v.strictObject({
  job_id: id,
  kind: v.picklist(["question", "reminder", "correction", "context"]),
  text: text(5_000),
  stage_name: v.optional(v.nullable(pipelineStageSchema)),
});

export const updatePrepNoteSchema = v.strictObject({
  prep_note_id: id,
  kind: v.optional(v.picklist(["question", "reminder", "correction", "context"])),
  text: v.optional(text(5_000)),
  stage_name: v.optional(v.nullable(pipelineStageSchema)),
  status: v.optional(v.picklist(["pending", "resolved", "cancelled"])),
  resolution: v.optional(v.nullable(text(5_000))),
});

const stageFields = {
  name: pipelineStageSchema,
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
export type EligibleOpening = v.InferOutput<typeof eligibleOpeningSchema>;
export type ListJobs = v.InferOutput<typeof listJobsSchema>;
export type Pipeline = v.InferOutput<typeof pipelineSchema>;
export type InterviewPrep = v.InferOutput<typeof interviewPrepSchema>;
export type SetApplicantContact = v.InferOutput<typeof applicantContactSchema>;
export type UpdateJob = v.InferOutput<typeof updateJobSchema>;
export type AddPrepNote = v.InferOutput<typeof addPrepNoteSchema>;
export type UpdatePrepNote = v.InferOutput<typeof updatePrepNoteSchema>;
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
