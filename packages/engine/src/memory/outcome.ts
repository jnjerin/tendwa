import type { Pool } from "pg";
import { log } from "../logger.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same retry stance as experience.ts, for the same reason: a 40001 guarantees nothing
// committed, so bounded retry is safe; any other failure leaves genuine ambiguity about
// whether the write landed, and outcomes has no natural dedupe key either. See DECISIONS.md.
export const MAX_SERIALIZATION_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 100;

export interface NewOutcomeInput {
  orgId: string;
  experienceId: string;
  status: string;
  actionTaken: string;
  result: string;
  rootCause?: string | null;
}

export interface Outcome {
  id: string;
  orgId: string;
  experienceId: string;
  status: string;
  rootCause: string | null;
  actionTaken: string;
  result: string;
  createdAt: Date;
}

interface OutcomeRow {
  id: string;
  org_id: string;
  experience_id: string;
  status: string;
  root_cause: string | null;
  action_taken: string;
  result: string;
  created_at: Date;
}

export class OutcomeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutcomeValidationError";
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Pure validation, independent of any DB connection — checks presence/shape of the fields the
 * `outcomes` table requires (org_id, experience_id, status, action_taken, result NOT NULL).
 * Doesn't check that experienceId actually references a row — that's a foreign key check, left
 * to the database, matching validateNewExperience's stance on orgId.
 */
export function validateNewOutcome(input: NewOutcomeInput): void {
  if (!isNonEmptyString(input.orgId)) {
    throw new OutcomeValidationError("orgId is required");
  }
  if (!UUID_RE.test(input.orgId)) {
    throw new OutcomeValidationError("orgId must be a UUID");
  }
  if (!isNonEmptyString(input.experienceId)) {
    throw new OutcomeValidationError("experienceId is required");
  }
  if (!UUID_RE.test(input.experienceId)) {
    throw new OutcomeValidationError("experienceId must be a UUID");
  }
  if (!isNonEmptyString(input.status)) {
    throw new OutcomeValidationError("status is required");
  }
  if (!isNonEmptyString(input.actionTaken)) {
    throw new OutcomeValidationError("actionTaken is required");
  }
  if (!isNonEmptyString(input.result)) {
    throw new OutcomeValidationError("result is required");
  }
}

function isSerializationConflict(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "40001";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapRow(row: OutcomeRow): Outcome {
  return {
    id: row.id,
    orgId: row.org_id,
    experienceId: row.experience_id,
    status: row.status,
    rootCause: row.root_cause,
    actionTaken: row.action_taken,
    result: row.result,
    createdAt: row.created_at,
  };
}

/**
 * Records what actually happened for a given experience (the feedback-loop half of the
 * experience+outcome pair — see ARCHITECTURE.md). Takes a `Pool` from db/client.ts's
 * createPool() rather than opening its own connection, matching recordExperience.
 */
export async function recordOutcome(
  pool: Pool,
  input: NewOutcomeInput,
  context: { requestId?: string } = {},
): Promise<Outcome> {
  try {
    validateNewOutcome(input);
  } catch (err) {
    log("warn", "Rejected invalid outcome", {
      service: "engine",
      component: "memory.outcome",
      operation: "outcome.record",
      requestId: context.requestId,
      orgId: typeof input.orgId === "string" ? input.orgId : undefined,
      errorCode: "OUTCOME_VALIDATION_FAILED",
      err: err as Error,
    });
    throw err;
  }

  const status = input.status.trim();
  const actionTaken = input.actionTaken.trim();
  const result = input.result.trim();
  const rootCause = input.rootCause?.trim() || null;

  for (let attempt = 1; ; attempt++) {
    try {
      const queryResult = await pool.query<OutcomeRow>(
        `INSERT INTO outcomes (org_id, experience_id, status, root_cause, action_taken, result)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, org_id, experience_id, status, root_cause, action_taken, result, created_at`,
        [input.orgId, input.experienceId, status, rootCause, actionTaken, result],
      );
      const row = queryResult.rows[0];
      if (!row) {
        throw new Error("INSERT ... RETURNING produced no row");
      }
      const outcome = mapRow(row);
      log("info", "Recorded outcome", {
        service: "engine",
        component: "memory.outcome",
        operation: "outcome.record",
        requestId: context.requestId,
        orgId: outcome.orgId,
        experienceId: outcome.experienceId,
        outcomeId: outcome.id,
        status: outcome.status,
      });
      return outcome;
    } catch (err) {
      const conflict = isSerializationConflict(err);
      const retryable = conflict && attempt < MAX_SERIALIZATION_RETRIES;
      log("error", retryable ? "Outcome write hit a serialization conflict, retrying" : "Failed to record outcome", {
        service: "engine",
        component: "memory.outcome",
        operation: "outcome.record",
        requestId: context.requestId,
        orgId: input.orgId,
        experienceId: input.experienceId,
        errorCode: conflict ? "OUTCOME_SERIALIZATION_CONFLICT" : "OUTCOME_WRITE_FAILED",
        attempt,
        err: err as Error,
      });
      if (!retryable) {
        throw err;
      }
      await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}
