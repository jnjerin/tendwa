import type { Pool } from "pg";
import { log } from "../logger.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same retry stance as knowledge.ts: a 40001 guarantees nothing committed, so bounded retry is
// safe. All write paths in this file share withSerializationRetry rather than each hand-rolling
// it, matching knowledge.ts's precedent for a file with more than one write function.
export const MAX_SERIALIZATION_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 100;

/**
 * agent_state.step for a reflection run. Kept as a plain constant rather than a union type of
 * every possible step this table could ever hold — nothing else writes to agent_state yet, and
 * this file's functions are named/scoped to reflection specifically (see reflect.ts's plan);
 * a future second step (e.g. a resumable agent loop) would get its own find/claim/checkpoint
 * functions here, reusing the same underlying row shape and retry helper.
 */
const REFLECTION_STEP = "reflection";

export type AgentStateStatus = "running" | "completed" | "failed" | "awaiting_feedback";

export type ReflectionAction = "create" | "reinforce";

/**
 * A validated proposal from Claude for one group — action taken here (not "create" | "reinforce"
 * | "skip" as three separate interfaces) because a single group's checkpoint needs to store
 * whichever one was actually validated, uniformly, regardless of which action it turned out to be.
 */
export interface ReflectionProposal {
  action: "create" | "reinforce" | "skip";
  statement?: string;
  targetKnowledgeId?: string;
  confidence: number;
  citedExperienceIds: string[];
  reasoning?: string;
}

export interface ReflectionGroupState {
  groupIndex: number;
  /** Fixed at plan time (grouping happens once, at run start) — never recomputed on resume. */
  experienceIds: string[];
  domain: string;
  status: "pending" | "completed" | "rejected" | "skipped";
  /**
   * Checkpointed the instant a proposal is validated, before anything is applied from it. A
   * resumed run replays this exact proposal instead of asking Claude again — the LLM call isn't
   * pinned to temperature 0, so a fresh sample for the same group isn't guaranteed to return the
   * same action as one that may already be partially or fully applied. Without this, a resumed
   * "skip" or a differently-actioned resample could silently orphan an already-committed
   * create/reinforce write, or worse, record a group as "skipped" when a real write already
   * landed for it (code-reviewer finding, 2026-08-18 — see DECISIONS.md).
   */
  proposal?: ReflectionProposal;
  /**
   * Populated only once a write has actually been attempted for this group, so the apply step
   * itself is resumable at a finer grain than "the whole group" — see reflect.ts's
   * applyProposal for why createKnowledge/reinforceKnowledge each need this.
   */
  applyAttempt?: {
    action: ReflectionAction;
    /** Set immediately once createKnowledge returns, before the evidence-linking loop starts. */
    knowledgeId?: string;
    /** Read via a plain SELECT before calling reinforceKnowledge, so a resumed run can tell
     *  "the write never landed" from "it already applied" by re-reading and comparing. */
    reinforceSnapshot?: { confidenceBefore: number; reinforcementCountBefore: number };
    /** Set once the "reflection.proposal_applied" audit entry has actually been written for
     *  this apply attempt — without this, a crash between that write committing and the group
     *  being marked complete would re-record a second "applied" audit entry on resume for a
     *  proposal that was only actually applied once (production-reviewer finding, 2026-08-18). */
    auditRecorded?: boolean;
  };
}

/** A deterministic (created_at, id) cursor — see reflect.ts for why both fields are needed. */
export interface ReflectionWatermark {
  createdAt: string;
  id: string;
}

export interface ReflectionRunPayload {
  runId: string;
  watermarkBefore: string;
  /** Computed once, from the run's frozen input batch, at claim time — not recomputed at
   *  completion, so it's available identically whether this run finishes in one pass or is
   *  resumed after a crash. */
  watermarkAfter: ReflectionWatermark;
  groups: ReflectionGroupState[];
}

export interface AgentStateRow {
  id: string;
  orgId: string;
  status: AgentStateStatus;
  step: string;
  payload: ReflectionRunPayload | null;
  updatedAt: Date;
  /** Full-precision (microsecond) CockroachDB-native string form of updated_at — see
   *  resumeReflectionRun's comment for why this exists alongside updatedAt: Date. */
  updatedAtRaw: string;
}

interface AgentStateDbRow {
  id: string;
  org_id: string;
  status: AgentStateStatus;
  step: string;
  payload: ReflectionRunPayload | null;
  updated_at: Date;
  updated_at_raw: string;
}

export class AgentStateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentStateValidationError";
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateOrgId(orgId: string): void {
  if (!isNonEmptyString(orgId)) {
    throw new AgentStateValidationError("orgId is required");
  }
  if (!UUID_RE.test(orgId)) {
    throw new AgentStateValidationError("orgId must be a UUID");
  }
}

function mapRow(row: AgentStateDbRow): AgentStateRow {
  return {
    id: row.id,
    orgId: row.org_id,
    status: row.status,
    step: row.step,
    payload: row.payload,
    updatedAt: row.updated_at,
    updatedAtRaw: row.updated_at_raw,
  };
}

function isSerializationConflict(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "40001";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Identical shape to knowledge.ts's withSerializationRetry — duplicated per this codebase's
 *  established per-file convention rather than factored into a shared module (see knowledge.ts's
 *  own comment on this same helper for the reasoning). */
async function withSerializationRetry<T>(
  operation: () => Promise<T>,
  onRetryOrFailure: (attempt: number, err: unknown, retrying: boolean) => void,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const retryable = isSerializationConflict(err) && attempt < MAX_SERIALIZATION_RETRIES;
      onRetryOrFailure(attempt, err, retryable);
      if (!retryable) {
        throw err;
      }
      await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

// updated_at::STRING is included alongside the plain column so resumeReflectionRun can compare
// against CockroachDB's own full-precision (microsecond) string representation instead of a
// JS Date — see that function's comment for why the plain Date column alone isn't safe to use
// as an optimistic-concurrency comparison value.
const SELECT_COLUMNS = "id, org_id, status, step, payload, updated_at, updated_at::STRING AS updated_at_raw";

/**
 * Finds a reflection run that hasn't reached a terminal 'completed' state — either genuinely
 * still running, or left 'failed' by a prior crash. This is how a new invocation discovers
 * whether to resume instead of starting fresh; see reflect.ts's runReflection.
 */
export async function findActiveReflectionState(
  pool: Pool,
  orgId: string,
  context: { requestId?: string } = {},
): Promise<AgentStateRow | null> {
  validateOrgId(orgId);
  const result = await pool.query<AgentStateDbRow>(
    `SELECT ${SELECT_COLUMNS} FROM agent_state
     WHERE org_id = $1 AND step = $2 AND status != 'completed'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [orgId, REFLECTION_STEP],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  log("info", "Found an active reflection run to resume", {
    service: "engine",
    component: "memory.agentState",
    operation: "agentState.findActive",
    requestId: context.requestId,
    orgId,
    stateId: row.id,
    status: row.status,
  });
  return mapRow(row);
}

/** Returns the frozen watermark of the most recently *completed* reflection run for this org,
 *  or null if reflection has never completed a run — reflect.ts falls back to the epoch. */
export async function getLastCompletedWatermark(
  pool: Pool,
  orgId: string,
): Promise<ReflectionWatermark | null> {
  validateOrgId(orgId);
  const result = await pool.query<{ payload: ReflectionRunPayload | null }>(
    `SELECT payload FROM agent_state
     WHERE org_id = $1 AND step = $2 AND status = 'completed'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [orgId, REFLECTION_STEP],
  );
  return result.rows[0]?.payload?.watermarkAfter ?? null;
}

/** Starts a brand-new reflection run, freezing the grouping plan into `payload` at insert time. */
export async function claimReflectionRun(
  pool: Pool,
  orgId: string,
  payload: ReflectionRunPayload,
  context: { requestId?: string } = {},
): Promise<AgentStateRow> {
  validateOrgId(orgId);
  const result = await withSerializationRetry(
    () =>
      pool.query<AgentStateDbRow>(
        `INSERT INTO agent_state (org_id, status, step, payload)
         VALUES ($1, 'running', $2, $3)
         RETURNING ${SELECT_COLUMNS}`,
        [orgId, REFLECTION_STEP, payload],
      ),
    (attempt, err, retrying) => {
      const conflict = isSerializationConflict(err);
      log("error", retrying ? "Reflection claim hit a serialization conflict, retrying" : "Failed to claim reflection run", {
        service: "engine",
        component: "memory.agentState",
        operation: "agentState.claim",
        requestId: context.requestId,
        orgId,
        errorCode: conflict ? "AGENT_STATE_SERIALIZATION_CONFLICT" : "AGENT_STATE_CLAIM_FAILED",
        attempt,
        err: err as Error,
      });
    },
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("INSERT ... RETURNING produced no row");
  }
  return mapRow(row);
}

/**
 * Claims an existing 'running'/'failed' row via compare-and-swap on the `updated_at` this
 * caller read moments earlier, guarding against two concurrent invocations (AWS Lambda's
 * at-least-once semantics is the realistic trigger — see ARCHITECTURE.md's deployment model)
 * both trying to resume the same run. Returns null, not an error, when the swap affects zero
 * rows — that's a normal, expected outcome ("someone else already claimed it"), not a failure.
 *
 * `expectedUpdatedAt` takes the raw, full-precision string form (AgentStateRow.updatedAtRaw),
 * not a JS Date, and the comparison below casts it back to TIMESTAMPTZ rather than relying on
 * a Date round-trip. Found live against tendwa_test: CockroachDB's `now()` has microsecond
 * precision, but pg's driver parses TIMESTAMPTZ into a JS Date (millisecond precision only) —
 * a Date built from the SELECT's value and then re-sent as this UPDATE's parameter silently
 * loses the sub-millisecond digits, so `updated_at = $3` almost never matched the still-full-
 * precision value actually stored, and every resume deterministically failed with "claim lost"
 * even with no real concurrent claimant. Comparing CockroachDB's own `::STRING` cast of the
 * column (server-side, full precision) against a parameter cast back with `::TIMESTAMPTZ`
 * never touches a lossy JS Date for this value, so the round trip is exact.
 */
export async function resumeReflectionRun(
  pool: Pool,
  stateId: string,
  orgId: string,
  expectedUpdatedAt: string,
  context: { requestId?: string } = {},
): Promise<AgentStateRow | null> {
  validateOrgId(orgId);
  const result = await withSerializationRetry(
    () =>
      pool.query<AgentStateDbRow>(
        `UPDATE agent_state
         SET status = 'running', updated_at = now()
         WHERE id = $1 AND org_id = $2 AND updated_at = $3::TIMESTAMPTZ AND status != 'completed'
         RETURNING ${SELECT_COLUMNS}`,
        [stateId, orgId, expectedUpdatedAt],
      ),
    (attempt, err, retrying) => {
      const conflict = isSerializationConflict(err);
      log("error", retrying ? "Reflection resume hit a serialization conflict, retrying" : "Failed to resume reflection run", {
        service: "engine",
        component: "memory.agentState",
        operation: "agentState.resume",
        requestId: context.requestId,
        orgId,
        stateId,
        errorCode: conflict ? "AGENT_STATE_SERIALIZATION_CONFLICT" : "AGENT_STATE_RESUME_FAILED",
        attempt,
        err: err as Error,
      });
    },
  );
  const row = result.rows[0];
  if (!row) {
    log("info", "Reflection run claim lost (already claimed or state changed since it was read)", {
      service: "engine",
      component: "memory.agentState",
      operation: "agentState.resume",
      requestId: context.requestId,
      orgId,
      stateId,
    });
    return null;
  }
  return mapRow(row);
}

/** Overwrites the whole groups array and bumps updated_at — called after every group finishes
 *  (and, mid-group, around each non-idempotent apply-step write; see reflect.ts). */
export async function checkpointGroup(
  pool: Pool,
  stateId: string,
  orgId: string,
  payload: ReflectionRunPayload,
  context: { requestId?: string } = {},
): Promise<void> {
  validateOrgId(orgId);
  await withSerializationRetry(
    () =>
      pool.query(
        `UPDATE agent_state SET payload = $3, updated_at = now() WHERE id = $1 AND org_id = $2`,
        [stateId, orgId, payload],
      ),
    (attempt, err, retrying) => {
      const conflict = isSerializationConflict(err);
      log("error", retrying ? "Checkpoint write hit a serialization conflict, retrying" : "Failed to checkpoint reflection progress", {
        service: "engine",
        component: "memory.agentState",
        operation: "agentState.checkpoint",
        requestId: context.requestId,
        orgId,
        stateId,
        errorCode: conflict ? "AGENT_STATE_SERIALIZATION_CONFLICT" : "AGENT_STATE_CHECKPOINT_FAILED",
        attempt,
        err: err as Error,
      });
    },
  );
}

export async function completeReflectionRun(
  pool: Pool,
  stateId: string,
  orgId: string,
  payload: ReflectionRunPayload,
  context: { requestId?: string } = {},
): Promise<void> {
  validateOrgId(orgId);
  await withSerializationRetry(
    () =>
      pool.query(
        `UPDATE agent_state SET status = 'completed', payload = $3, updated_at = now() WHERE id = $1 AND org_id = $2`,
        [stateId, orgId, payload],
      ),
    (attempt, err, retrying) => {
      const conflict = isSerializationConflict(err);
      log("error", retrying ? "Completion write hit a serialization conflict, retrying" : "Failed to mark reflection run completed", {
        service: "engine",
        component: "memory.agentState",
        operation: "agentState.complete",
        requestId: context.requestId,
        orgId,
        stateId,
        errorCode: conflict ? "AGENT_STATE_SERIALIZATION_CONFLICT" : "AGENT_STATE_COMPLETE_FAILED",
        attempt,
        err: err as Error,
      });
    },
  );
  log("info", "Reflection run marked completed", {
    service: "engine",
    component: "memory.agentState",
    operation: "agentState.complete",
    requestId: context.requestId,
    orgId,
    stateId,
  });
}

/** Leaves `payload` exactly as last checkpointed — that's what makes the next invocation's
 *  findActiveReflectionState + resume pick this exact run back up rather than losing progress. */
export async function failReflectionRun(
  pool: Pool,
  stateId: string,
  orgId: string,
  context: { requestId?: string } = {},
): Promise<void> {
  validateOrgId(orgId);
  await withSerializationRetry(
    () => pool.query(`UPDATE agent_state SET status = 'failed', updated_at = now() WHERE id = $1 AND org_id = $2`, [stateId, orgId]),
    (attempt, err, retrying) => {
      const conflict = isSerializationConflict(err);
      log("error", retrying ? "Failure write hit a serialization conflict, retrying" : "Failed to mark reflection run failed", {
        service: "engine",
        component: "memory.agentState",
        operation: "agentState.fail",
        requestId: context.requestId,
        orgId,
        stateId,
        errorCode: conflict ? "AGENT_STATE_SERIALIZATION_CONFLICT" : "AGENT_STATE_FAIL_WRITE_FAILED",
        attempt,
        err: err as Error,
      });
    },
  );
}
