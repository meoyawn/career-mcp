export interface Statement {
  bind(...values: unknown[]): Statement;
}

export interface Database {
  prepare(sql: string): Statement;
  batch<T = unknown>(statements: Statement[]): Promise<D1Result<T>[]>;
}

export function createToolStore(database: D1Database, userId: string) {
  let executed = false;
  const prepared = new WeakMap<Statement, D1PreparedStatement>();
  function wrap(native: D1PreparedStatement): Statement {
    const statement: Statement = { bind: (...values) => wrap(native.bind(...values)) };
    prepared.set(statement, native);
    return statement;
  }
  const db: Database = {
    prepare: (sql) => wrap(database.prepare(sql)),
    batch<T>(statements: Statement[]) {
      if (executed) throw new Error("An MCP tool may execute only one database transaction.");
      executed = true;
      return database.batch<T>(statements.map((statement) => {
        const native = prepared.get(statement);
        if (!native) throw new Error("Statement belongs to another tool call.");
        return native;
      }));
    },
  };
  return { db, userId };
}

const errors: Record<string, string> = {
  rejected_at: "rejected_at requires a rejected application. Set status:rejected with the known rejection date, or clear the date with null.",
  opening_not_found: "Opening not found for this employer. Use list_openings with its job_id to resolve opening_id.",
  opening_unavailable: "The selected opening must be open and eligible. Unknown or ineligible roles can be retained with save_opening, but cannot start an application.",
  opening_outdated: "New opening evidence predates a saved check or closure. Reload list_openings and verify the posting again.",
  application_opening: "An actual application's destination is historical. Select openings only on leads; preserve this attempt and create a separate record for a new application.",
  opening_closed: "This opening is closed. Browse the same company's live career inventory and save a verified eligible replacement through update_job. Preserve the employer and application history.",
  opening_mismatch: "Closure URL does not match the current opening. Reload get_job before recording a closure.",
  closure_outdated: "Closure evidence predates the current opening check. Verify the live posting again.",
  job_not_found: "Job not found. Use list_jobs to resolve a company, role, or nickname to its job_id.",
  stage_not_found: "Stage not found. Use get_job to load its stages and stage_id values.",
  contact_not_found: "Contact not found. Use get_job to find this employer's contacts.",
  outreach_not_found: "Outreach not found. Use get_job to find the communication history.",
  prep_note_not_found: "Prep note not found. Use get_job to load prep_note_id values.",
  criteria_required: "Save selection criteria before adding jobs, then verify an open role against those criteria.",
  opening_required: "Every new job record and employer or phase change requires a verified eligible opening. Refresh eligible_opening first.",
  outdated_criteria: "Opening eligibility uses outdated criteria. Load get_lead_context and reassess against the current criteria.",
  opening_expired: "Verify the opening is still open within the last 24 hours; checked_at cannot be in the future.",
  leads_stay_active: "Leads must stay active. Use remove_lead if an uncontacted lead no longer meets the criteria; other statuses describe actual applications only.",
  application_to_lead: "An application cannot return to a lead. Preserve its outcome and process history.",
  lead_application_state: "A lead must stay at the lead milestone without recruiter engagement or reapplication policy. Start an actual application first.",
  application_milestone: "An application requires an application milestone; it cannot return to the lead milestone.",
  opening_requires_application: "Top-level opening details require an application. For a lead, put the verified role in eligible_opening.",
  salary_range: "salary_min must not exceed salary_max.",
  salary_units: "Salary needs at least one amount, a currency, and a pay period. Clear all four salary fields to remove it.",
  salary_ask_units: "Salary ask needs salary_ask_amount, salary_ask_currency, and salary_ask_period. Clear all four salary_ask fields to remove it.",
  salary_declared_units: "Declared salary needs salary_declared_amount, salary_declared_currency, and salary_declared_period. Clear all four salary_declared fields to remove it.",
  reapply_deadline: "reapply_after requires reapply_policy:allowed. Clear the deadline when clearing or denying reapplication.",
  stage_schedule: "A timezone or end time requires starts_at. Scheduled stages require an IANA timezone.",
  stage_end: "ends_at must be later than starts_at.",
  stage_calendar: "Provide calendar_id with calendar_event_id.",
  legacy_milestone: "Rename this legacy stage to a predefined pipeline milestone before making it current.",
  contact_job: "Contact does not belong to this job.",
  contact_communication: "Contacts require actual communication. Record the real interaction with record_outreach first.",
  stage_job: "Stage and contact must belong to the same job.",
  outreach_follow_up: "follow_up_at cannot be earlier than occurred_at.",
  prep_resolution: "A resolution requires resolved or cancelled status. Reopening clears the previous resolution.",
};

export function fail(message: string): never {
  throw new Error(message, { cause: "user" });
}

export async function execute<T = unknown>(db: Database, statements: Statement[]) {
  try {
    const results = await db.batch<T>(statements);
    for (const result of results) {
      for (const row of result.results) {
        if (row !== null && typeof row === "object") {
          for (const column of ["legacy_current_stage", "legacy_eligible_opening", "legacy_name", "job_phase"]) {
            delete (row as Record<string, unknown>)[column];
          }
        }
      }
    }
    return results;
  } catch (error) {
    const code = error instanceof Error ? /CHECK constraint failed: (\w+)/u.exec(error.message)?.[1] : undefined;
    if (code && errors[code]) fail(errors[code]);
    throw error;
  }
}

export async function first<T>(db: Database, statement: Statement) {
  const results = await execute<T>(db, [statement]);
  return results[0]?.results[0] ?? null;
}

export const check = (db: Database, code: string, condition: string, ...bindings: unknown[]) =>
  db.prepare(`INSERT INTO command_checks (error) SELECT ? WHERE ${condition}`).bind(code, ...bindings);

export const openingCheck = (db: Database, code: "opening_closed" | "opening_mismatch" | "closure_outdated", condition: string, ...bindings: unknown[]) =>
  db.prepare(`INSERT INTO opening_checks (error) SELECT ? WHERE ${condition}`).bind(code, ...bindings);

export const jobOpeningCheck = (db: Database, code: "opening_not_found" | "opening_unavailable" | "opening_outdated" | "application_opening", condition: string, ...bindings: unknown[]) =>
  db.prepare(`INSERT INTO job_opening_checks (error) SELECT ? WHERE ${condition}`).bind(code, ...bindings);
