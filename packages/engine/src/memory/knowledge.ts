import type { Pool } from "pg";
import { log } from "../logger.js";
import { embedText } from "./embeddings.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same retry stance as experience.ts/outcome.ts: a 40001 guarantees nothing committed, so
// bounded retry is safe. All four write paths in this file share one retry loop
// (withSerializationRetry, below) instead of each hand-rolling it — see DECISIONS.md.
export const MAX_SERIALIZATION_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 100;

const DEFAULT_INITIAL_CONFIDENCE = 0.5;

// No decay formula is specified anywhere in ARCHITECTURE.md/DECISIONS.md — this is a new,
// deliberately simple design choice, recorded in DECISIONS.md rather than left implicit.
const DECAY_GRACE_PERIOD_DAYS = 30;
const DAILY_DECAY_RATE = 0.01;
const MIN_CONFIDENCE = 0.05;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class KnowledgeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeValidationError";
  }
}

/** Thrown when an org-scoped knowledge id doesn't resolve to a row — wrong id or wrong org. */
export class KnowledgeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeNotFoundError";
  }
}

export interface Knowledge {
  id: string;
  orgId: string;
  domain: string;
  statement: string;
  confidence: number;
  reinforcementCount: number;
  lastReinforcedAt: Date;
  createdAt: Date;
}

export interface NewKnowledgeInput {
  orgId: string;
  domain: string;
  statement: string;
  /** Defaults to 0.5, matching the schema default — set explicitly here rather than relying
   *  on it implicitly, same reasoning embeddings.ts uses for EMBEDDING_DIMENSIONS. */
  initialConfidence?: number;
}

export interface ReinforceKnowledgeInput {
  orgId: string;
  knowledgeId: string;
  /** Caller-computed (e.g. from an already-validated LLM proposal) — this module only
   *  writes a validated value, it doesn't decide how much to reinforce. */
  newConfidence: number;
}

export interface AddEvidenceInput {
  orgId: string;
  knowledgeId: string;
  experienceId: string;
}

export interface AddEvidenceResult {
  /** False when the (knowledge_id, experience_id) pair already existed — a safe no-op, not an error. */
  added: boolean;
}

export interface DecayKnowledgeInput {
  orgId: string;
  knowledgeId: string;
}

interface KnowledgeRow {
  id: string;
  org_id: string;
  domain: string;
  statement: string;
  confidence: number;
  reinforcement_count: number;
  last_reinforced_at: Date;
  created_at: Date;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** CockroachDB's VECTOR literal syntax — duplicated from retrieve.ts's toVectorLiteral rather
 *  than imported, matching this codebase's established per-file-duplication convention for
 *  small pure helpers (see UUID_RE/isNonEmptyString across experience.ts/outcome.ts/retrieve.ts). */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function mapRow(row: KnowledgeRow): Knowledge {
  return {
    id: row.id,
    orgId: row.org_id,
    domain: row.domain,
    statement: row.statement,
    confidence: row.confidence,
    reinforcementCount: row.reinforcement_count,
    lastReinforcedAt: row.last_reinforced_at,
    createdAt: row.created_at,
  };
}

function isSerializationConflict(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "40001";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shared 40001-retry-with-backoff loop for this file's four write paths. Pulled out as a
 * private helper local to this file (not a new shared cross-file module — the established
 * convention this codebase avoids is a shared *validation utility file*, not ordinary in-file
 * DRY) because, unlike experience.ts/outcome.ts which each have exactly one write function,
 * this file has four, and hand-rolling the loop four times would be worse than one helper.
 * `onRetryOrFailure` lets each call site log with its own message/errorCode, since those
 * differ per operation even though the retry mechanics are identical.
 */
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

/**
 * Pure, deliberately independent of any DB connection — checks presence/shape of the fields
 * `knowledge` requires, matching validateNewExperience's style. Returns normalized values so
 * the caller doesn't re-trim/re-default.
 */
export function validateNewKnowledge(input: NewKnowledgeInput): { domain: string; statement: string; confidence: number } {
  if (!isNonEmptyString(input.orgId)) {
    throw new KnowledgeValidationError("orgId is required");
  }
  if (!UUID_RE.test(input.orgId)) {
    throw new KnowledgeValidationError("orgId must be a UUID");
  }
  if (!isNonEmptyString(input.domain)) {
    throw new KnowledgeValidationError("domain is required");
  }
  if (!isNonEmptyString(input.statement)) {
    throw new KnowledgeValidationError("statement is required");
  }
  const confidence = input.initialConfidence ?? DEFAULT_INITIAL_CONFIDENCE;
  if (!isValidConfidence(confidence)) {
    throw new KnowledgeValidationError("initialConfidence must be a number between 0 and 1");
  }
  return { domain: input.domain.trim(), statement: input.statement.trim(), confidence };
}

export function validateReinforceKnowledge(input: ReinforceKnowledgeInput): void {
  if (!isNonEmptyString(input.orgId)) {
    throw new KnowledgeValidationError("orgId is required");
  }
  if (!UUID_RE.test(input.orgId)) {
    throw new KnowledgeValidationError("orgId must be a UUID");
  }
  if (!isNonEmptyString(input.knowledgeId)) {
    throw new KnowledgeValidationError("knowledgeId is required");
  }
  if (!UUID_RE.test(input.knowledgeId)) {
    throw new KnowledgeValidationError("knowledgeId must be a UUID");
  }
  if (!isValidConfidence(input.newConfidence)) {
    throw new KnowledgeValidationError("newConfidence must be a number between 0 and 1");
  }
}

export function validateAddEvidence(input: AddEvidenceInput): void {
  if (!isNonEmptyString(input.orgId)) {
    throw new KnowledgeValidationError("orgId is required");
  }
  if (!UUID_RE.test(input.orgId)) {
    throw new KnowledgeValidationError("orgId must be a UUID");
  }
  if (!isNonEmptyString(input.knowledgeId)) {
    throw new KnowledgeValidationError("knowledgeId is required");
  }
  if (!UUID_RE.test(input.knowledgeId)) {
    throw new KnowledgeValidationError("knowledgeId must be a UUID");
  }
  if (!isNonEmptyString(input.experienceId)) {
    throw new KnowledgeValidationError("experienceId is required");
  }
  if (!UUID_RE.test(input.experienceId)) {
    throw new KnowledgeValidationError("experienceId must be a UUID");
  }
}

export function validateDecayKnowledgeInput(input: DecayKnowledgeInput): void {
  if (!isNonEmptyString(input.orgId)) {
    throw new KnowledgeValidationError("orgId is required");
  }
  if (!UUID_RE.test(input.orgId)) {
    throw new KnowledgeValidationError("orgId must be a UUID");
  }
  if (!isNonEmptyString(input.knowledgeId)) {
    throw new KnowledgeValidationError("knowledgeId is required");
  }
  if (!UUID_RE.test(input.knowledgeId)) {
    throw new KnowledgeValidationError("knowledgeId must be a UUID");
  }
}

/**
 * Pure. Confidence is unchanged inside the grace period; past it, decays multiplicatively
 * per day and is floored so a knowledge item never fully vanishes — it stays a minimal,
 * traceable residual rather than disappearing. See DECISIONS.md for why these specific
 * numbers (nothing elsewhere in the repo specifies a decay formula).
 */
export function calculateDecayedConfidence(confidence: number, lastReinforcedAt: Date, now: Date): number {
  const daysSince = (now.getTime() - lastReinforcedAt.getTime()) / MS_PER_DAY;
  const daysPastGrace = daysSince - DECAY_GRACE_PERIOD_DAYS;
  if (daysPastGrace <= 0) {
    return confidence;
  }
  const decayed = confidence * Math.pow(1 - DAILY_DECAY_RATE, daysPastGrace);
  return Math.max(MIN_CONFIDENCE, decayed);
}

/**
 * Creates a new knowledge row (Stage 3). Embeds `statement` via the same Voyage client
 * retrieveMemory uses, with inputType "document" (vs. "query" for retrieval), matching
 * retrieve.integration.test.ts's existing seeding convention.
 *
 * Unlike retrieveMemory, embedding failure here is NOT degraded — it fails the whole write.
 * `embedding` is nullable in the schema, but a knowledge row with no embedding is invisible
 * to queryKnowledgeBySimilarity forever with no backfill mechanism in this codebase yet; a
 * write-path failure is safer to surface loudly than to silently create unsearchable
 * knowledge. See DECISIONS.md.
 */
export async function createKnowledge(
  pool: Pool,
  input: NewKnowledgeInput,
  context: { requestId?: string } = {},
): Promise<Knowledge> {
  let normalized: { domain: string; statement: string; confidence: number };
  try {
    normalized = validateNewKnowledge(input);
  } catch (err) {
    log("warn", "Rejected invalid knowledge", {
      service: "engine",
      component: "memory.knowledge",
      operation: "knowledge.create",
      requestId: context.requestId,
      orgId: typeof input.orgId === "string" ? input.orgId : undefined,
      errorCode: "KNOWLEDGE_VALIDATION_FAILED",
      err: err as Error,
    });
    throw err;
  }

  let embedding: number[];
  try {
    embedding = await embedText(normalized.statement, { inputType: "document", requestId: context.requestId });
  } catch (err) {
    log("error", "Knowledge creation failed: embedding unavailable", {
      service: "engine",
      component: "memory.knowledge",
      operation: "knowledge.create",
      requestId: context.requestId,
      orgId: input.orgId,
      errorCode: "KNOWLEDGE_CREATE_EMBEDDING_FAILED",
      err: err as Error,
    });
    throw err;
  }

  const result = await withSerializationRetry(
    () =>
      pool.query<KnowledgeRow>(
        `INSERT INTO knowledge (org_id, domain, statement, embedding, confidence)
         VALUES ($1, $2, $3, $4::VECTOR, $5)
         RETURNING id, org_id, domain, statement, confidence, reinforcement_count, last_reinforced_at, created_at`,
        [input.orgId, normalized.domain, normalized.statement, toVectorLiteral(embedding), normalized.confidence],
      ),
    (attempt, err, retrying) => {
      const conflict = isSerializationConflict(err);
      log("error", retrying ? "Knowledge write hit a serialization conflict, retrying" : "Failed to create knowledge", {
        service: "engine",
        component: "memory.knowledge",
        operation: "knowledge.create",
        requestId: context.requestId,
        orgId: input.orgId,
        errorCode: conflict ? "KNOWLEDGE_SERIALIZATION_CONFLICT" : "KNOWLEDGE_CREATE_FAILED",
        attempt,
        err: err as Error,
      });
    },
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("INSERT ... RETURNING produced no row");
  }
  const knowledge = mapRow(row);
  log("info", "Created knowledge", {
    service: "engine",
    component: "memory.knowledge",
    operation: "knowledge.create",
    requestId: context.requestId,
    orgId: knowledge.orgId,
    knowledgeId: knowledge.id,
    domain: knowledge.domain,
  });
  return knowledge;
}

/**
 * Raises confidence and reinforcement_count on an existing, org-scoped knowledge row.
 * `newConfidence` is caller-supplied (already validated upstream, e.g. by an LLM proposal's
 * own validateProposal step) — re-validated here independently, same double-validation
 * discipline every other write module in this codebase has. reinforcement_count is
 * incremented DB-side to avoid a read-modify-write race.
 */
export async function reinforceKnowledge(
  pool: Pool,
  input: ReinforceKnowledgeInput,
  context: { requestId?: string } = {},
): Promise<Knowledge> {
  try {
    validateReinforceKnowledge(input);
  } catch (err) {
    log("warn", "Rejected invalid knowledge reinforcement", {
      service: "engine",
      component: "memory.knowledge",
      operation: "knowledge.reinforce",
      requestId: context.requestId,
      orgId: typeof input.orgId === "string" ? input.orgId : undefined,
      errorCode: "KNOWLEDGE_VALIDATION_FAILED",
      err: err as Error,
    });
    throw err;
  }

  const result = await withSerializationRetry(
    () =>
      pool.query<KnowledgeRow>(
        `UPDATE knowledge
         SET confidence = $3, reinforcement_count = reinforcement_count + 1, last_reinforced_at = now()
         WHERE org_id = $1 AND id = $2
         RETURNING id, org_id, domain, statement, confidence, reinforcement_count, last_reinforced_at, created_at`,
        [input.orgId, input.knowledgeId, input.newConfidence],
      ),
    (attempt, err, retrying) => {
      const conflict = isSerializationConflict(err);
      log(
        "error",
        retrying ? "Knowledge write hit a serialization conflict, retrying" : "Failed to reinforce knowledge",
        {
          service: "engine",
          component: "memory.knowledge",
          operation: "knowledge.reinforce",
          requestId: context.requestId,
          orgId: input.orgId,
          knowledgeId: input.knowledgeId,
          errorCode: conflict ? "KNOWLEDGE_SERIALIZATION_CONFLICT" : "KNOWLEDGE_REINFORCE_FAILED",
          attempt,
          err: err as Error,
        },
      );
    },
  );

  const row = result.rows[0];
  if (!row) {
    log("warn", "Reinforce target not found", {
      service: "engine",
      component: "memory.knowledge",
      operation: "knowledge.reinforce",
      requestId: context.requestId,
      orgId: input.orgId,
      knowledgeId: input.knowledgeId,
      errorCode: "KNOWLEDGE_NOT_FOUND",
    });
    // orgId + knowledgeId mismatch and a genuinely nonexistent id collapse to the same
    // outcome deliberately, so this can't be used to probe for another org's knowledge ids.
    throw new KnowledgeNotFoundError(`No knowledge found for org ${input.orgId} with id ${input.knowledgeId}`);
  }
  const knowledge = mapRow(row);
  log("info", "Reinforced knowledge", {
    service: "engine",
    component: "memory.knowledge",
    operation: "knowledge.reinforce",
    requestId: context.requestId,
    orgId: knowledge.orgId,
    knowledgeId: knowledge.id,
    confidence: knowledge.confidence,
    reinforcementCount: knowledge.reinforcementCount,
  });
  return knowledge;
}

/**
 * Links a knowledge row to a supporting experience. Idempotent by design (ON CONFLICT DO
 * NOTHING) — reflection may reasonably propose the same evidence link across more than one
 * run, and re-linking an existing pair is a safe no-op, not an error. Does not verify
 * knowledgeId/experienceId belong to the same org — see DECISIONS.md (mirrors the existing
 * recordOutcome/experienceId precedent).
 */
export async function addEvidence(
  pool: Pool,
  input: AddEvidenceInput,
  context: { requestId?: string } = {},
): Promise<AddEvidenceResult> {
  try {
    validateAddEvidence(input);
  } catch (err) {
    log("warn", "Rejected invalid evidence link", {
      service: "engine",
      component: "memory.knowledge",
      operation: "knowledge.addEvidence",
      requestId: context.requestId,
      orgId: typeof input.orgId === "string" ? input.orgId : undefined,
      errorCode: "KNOWLEDGE_VALIDATION_FAILED",
      err: err as Error,
    });
    throw err;
  }

  const result = await withSerializationRetry(
    () =>
      pool.query<{ knowledge_id: string }>(
        `INSERT INTO knowledge_evidence (knowledge_id, experience_id)
         VALUES ($1, $2)
         ON CONFLICT (knowledge_id, experience_id) DO NOTHING
         RETURNING knowledge_id`,
        [input.knowledgeId, input.experienceId],
      ),
    (attempt, err, retrying) => {
      const conflict = isSerializationConflict(err);
      log("error", retrying ? "Evidence write hit a serialization conflict, retrying" : "Failed to add evidence", {
        service: "engine",
        component: "memory.knowledge",
        operation: "knowledge.addEvidence",
        requestId: context.requestId,
        orgId: input.orgId,
        knowledgeId: input.knowledgeId,
        experienceId: input.experienceId,
        errorCode: conflict ? "KNOWLEDGE_SERIALIZATION_CONFLICT" : "KNOWLEDGE_EVIDENCE_WRITE_FAILED",
        attempt,
        err: err as Error,
      });
    },
  );

  const added = result.rows.length > 0;
  log("info", added ? "Added evidence link" : "Evidence link already existed", {
    service: "engine",
    component: "memory.knowledge",
    operation: "knowledge.addEvidence",
    requestId: context.requestId,
    orgId: input.orgId,
    knowledgeId: input.knowledgeId,
    experienceId: input.experienceId,
    added,
  });
  return { added };
}

/**
 * Applies confidence decay to one knowledge row, if its own staleness (time since
 * last_reinforced_at) calls for it. Decides nothing about which rows across the table need
 * decaying or when to run — that selection/scheduling is reflect.ts's job; this only
 * evaluates and (if applicable) writes one row's own state, matching the "no orchestration"
 * scope for this whole file.
 */
export async function decayKnowledgeConfidence(
  pool: Pool,
  input: DecayKnowledgeInput,
  context: { requestId?: string } = {},
): Promise<Knowledge> {
  try {
    validateDecayKnowledgeInput(input);
  } catch (err) {
    log("warn", "Rejected invalid decay request", {
      service: "engine",
      component: "memory.knowledge",
      operation: "knowledge.decay",
      requestId: context.requestId,
      orgId: typeof input.orgId === "string" ? input.orgId : undefined,
      errorCode: "KNOWLEDGE_VALIDATION_FAILED",
      err: err as Error,
    });
    throw err;
  }

  // Single-statement SELECT, no client-side 40001 retry — same convention retrieve.ts
  // already uses for reads; a DB failure here just propagates.
  const current = await pool.query<KnowledgeRow>(
    `SELECT id, org_id, domain, statement, confidence, reinforcement_count, last_reinforced_at, created_at
     FROM knowledge
     WHERE org_id = $1 AND id = $2`,
    [input.orgId, input.knowledgeId],
  );
  const currentRow = current.rows[0];
  if (!currentRow) {
    log("warn", "Decay target not found", {
      service: "engine",
      component: "memory.knowledge",
      operation: "knowledge.decay",
      requestId: context.requestId,
      orgId: input.orgId,
      knowledgeId: input.knowledgeId,
      errorCode: "KNOWLEDGE_NOT_FOUND",
    });
    throw new KnowledgeNotFoundError(`No knowledge found for org ${input.orgId} with id ${input.knowledgeId}`);
  }

  const decayedConfidence = calculateDecayedConfidence(currentRow.confidence, currentRow.last_reinforced_at, new Date());
  if (decayedConfidence === currentRow.confidence) {
    log("info", "Knowledge confidence within grace period, no decay applied", {
      service: "engine",
      component: "memory.knowledge",
      operation: "knowledge.decay",
      requestId: context.requestId,
      orgId: input.orgId,
      knowledgeId: input.knowledgeId,
      confidence: currentRow.confidence,
    });
    return mapRow(currentRow);
  }

  const updated = await withSerializationRetry(
    () =>
      pool.query<KnowledgeRow>(
        `UPDATE knowledge
         SET confidence = $3
         WHERE org_id = $1 AND id = $2
         RETURNING id, org_id, domain, statement, confidence, reinforcement_count, last_reinforced_at, created_at`,
        [input.orgId, input.knowledgeId, decayedConfidence],
      ),
    (attempt, err, retrying) => {
      const conflict = isSerializationConflict(err);
      log(
        "error",
        retrying ? "Knowledge write hit a serialization conflict, retrying" : "Failed to apply confidence decay",
        {
          service: "engine",
          component: "memory.knowledge",
          operation: "knowledge.decay",
          requestId: context.requestId,
          orgId: input.orgId,
          knowledgeId: input.knowledgeId,
          errorCode: conflict ? "KNOWLEDGE_SERIALIZATION_CONFLICT" : "KNOWLEDGE_DECAY_FAILED",
          attempt,
          err: err as Error,
        },
      );
    },
  );

  const updatedRow = updated.rows[0];
  if (!updatedRow) {
    // The row existed moments ago (the SELECT above) but is gone by the time the UPDATE
    // landed — a genuine concurrent-delete race, not something client-side retry fixes.
    throw new KnowledgeNotFoundError(`No knowledge found for org ${input.orgId} with id ${input.knowledgeId}`);
  }
  const knowledge = mapRow(updatedRow);
  log("info", "Applied confidence decay", {
    service: "engine",
    component: "memory.knowledge",
    operation: "knowledge.decay",
    requestId: context.requestId,
    orgId: knowledge.orgId,
    knowledgeId: knowledge.id,
    previousConfidence: currentRow.confidence,
    confidence: knowledge.confidence,
  });
  return knowledge;
}
