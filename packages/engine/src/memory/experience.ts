import type { Pool } from "pg";
import { log } from "../logger.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Per ENGINEERING.md §1: CockroachDB serialization conflicts (40001) are expected, correct
// behavior under SERIALIZABLE isolation, not a bug — retry, bounded, with backoff. A single
// INSERT is otherwise not retried on any other error class: unlike a 40001 (which guarantees
// nothing committed), a connection-level failure leaves genuine ambiguity about whether the
// write landed, and experiences has no natural dedupe key — blindly retrying those risks a
// duplicate row rather than fixing anything. That ambiguity is exactly what request-level
// idempotency keys (deferred to the future POST /incidents endpoint, per ARCHITECTURE.md's
// API surface) exist to resolve; this function assumes it's called at most once per logical
// write.
export const MAX_SERIALIZATION_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 100;

export interface NewExperienceInput {
  orgId: string;
  domain: string;
  content: string;
  occurredAt: Date | string;
  metadata?: Record<string, unknown> | null;
}

export interface Experience {
  id: string;
  orgId: string;
  domain: string;
  content: string;
  metadata: Record<string, unknown> | null;
  occurredAt: Date;
  createdAt: Date;
}

interface ExperienceRow {
  id: string;
  org_id: string;
  domain: string;
  content: string;
  metadata: Record<string, unknown> | null;
  occurred_at: Date;
  created_at: Date;
}

export class ExperienceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperienceValidationError";
  }
}

/** Thrown when an org-scoped experience id doesn't resolve to a row — wrong id or wrong org,
 *  matching KnowledgeNotFoundError's collapsed-cause rationale (knowledge.ts). */
export class ExperienceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperienceNotFoundError";
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Pure validation, deliberately independent of any DB connection — checks presence and shape
 * of the fields the `experiences` table requires (org_id, domain, content, occurred_at NOT
 * NULL), not whether org_id actually exists (that's a foreign key check, left to the database).
 * Returns the normalized occurredAt Date so callers don't re-parse it.
 */
export function validateNewExperience(input: NewExperienceInput): Date {
  if (!isNonEmptyString(input.orgId)) {
    throw new ExperienceValidationError("orgId is required");
  }
  if (!UUID_RE.test(input.orgId)) {
    throw new ExperienceValidationError("orgId must be a UUID");
  }
  if (!isNonEmptyString(input.domain)) {
    throw new ExperienceValidationError("domain is required");
  }
  if (!isNonEmptyString(input.content)) {
    throw new ExperienceValidationError("content is required");
  }
  if (input.occurredAt === undefined || input.occurredAt === null || input.occurredAt === "") {
    throw new ExperienceValidationError("occurredAt is required");
  }
  const occurredAt = input.occurredAt instanceof Date ? input.occurredAt : new Date(input.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new ExperienceValidationError("occurredAt must be a valid date");
  }
  return occurredAt;
}

function isSerializationConflict(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "40001";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapRow(row: ExperienceRow): Experience {
  return {
    id: row.id,
    orgId: row.org_id,
    domain: row.domain,
    content: row.content,
    metadata: row.metadata,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

/**
 * Inserts a new experience (Stage 1 of the pipeline — write path only). Takes a `Pool` from
 * db/client.ts's createPool() rather than opening its own connection, since a pool is meant to
 * be a long-lived singleton shared across requests, not created per call.
 */
export async function recordExperience(
  pool: Pool,
  input: NewExperienceInput,
  context: { requestId?: string } = {},
): Promise<Experience> {
  let occurredAt: Date;
  try {
    occurredAt = validateNewExperience(input);
  } catch (err) {
    log("warn", "Rejected invalid experience", {
      service: "engine",
      component: "memory.experience",
      operation: "experience.record",
      requestId: context.requestId,
      orgId: typeof input.orgId === "string" ? input.orgId : undefined,
      errorCode: "EXPERIENCE_VALIDATION_FAILED",
      err: err as Error,
    });
    throw err;
  }

  const metadata = input.metadata ?? null;
  // Trimmed to match validateNewExperience's non-empty-after-trim check above — otherwise
  // e.g. "  incident-response  " would pass validation but be stored with the whitespace.
  const domain = input.domain.trim();
  const content = input.content.trim();

  for (let attempt = 1; ; attempt++) {
    try {
      const result = await pool.query<ExperienceRow>(
        `INSERT INTO experiences (org_id, domain, content, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, org_id, domain, content, metadata, occurred_at, created_at`,
        [input.orgId, domain, content, metadata, occurredAt],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error("INSERT ... RETURNING produced no row");
      }
      const experience = mapRow(row);
      log("info", "Recorded experience", {
        service: "engine",
        component: "memory.experience",
        operation: "experience.record",
        requestId: context.requestId,
        orgId: experience.orgId,
        experienceId: experience.id,
        domain: experience.domain,
      });
      return experience;
    } catch (err) {
      const conflict = isSerializationConflict(err);
      const retryable = conflict && attempt < MAX_SERIALIZATION_RETRIES;
      log("error", retryable ? "Experience write hit a serialization conflict, retrying" : "Failed to record experience", {
        service: "engine",
        component: "memory.experience",
        operation: "experience.record",
        requestId: context.requestId,
        orgId: input.orgId,
        errorCode: conflict ? "EXPERIENCE_SERIALIZATION_CONFLICT" : "EXPERIENCE_WRITE_FAILED",
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

/**
 * Single-statement read (no retry — same convention as retrieve.ts's queries and
 * knowledge.ts's decay lookup: CockroachDB retries an implicit single-statement transaction
 * internally, so there's no client-side 40001 to handle here). org_id and id are checked in the
 * same WHERE clause, and a miss on either collapses to the same ExperienceNotFoundError, so this
 * can't be used to probe for another org's experience ids — matching KnowledgeNotFoundError's
 * stated rationale exactly.
 */
export async function getExperienceById(
  pool: Pool,
  orgId: string,
  experienceId: string,
  context: { requestId?: string } = {},
): Promise<Experience> {
  if (!isNonEmptyString(orgId) || !UUID_RE.test(orgId)) {
    const err = new ExperienceValidationError("orgId is required and must be a UUID");
    log("warn", "Rejected invalid experience lookup", {
      service: "engine",
      component: "memory.experience",
      operation: "experience.getById",
      requestId: context.requestId,
      errorCode: "EXPERIENCE_VALIDATION_FAILED",
      err,
    });
    throw err;
  }
  if (!isNonEmptyString(experienceId) || !UUID_RE.test(experienceId)) {
    const err = new ExperienceValidationError("experienceId is required and must be a UUID");
    log("warn", "Rejected invalid experience lookup", {
      service: "engine",
      component: "memory.experience",
      operation: "experience.getById",
      requestId: context.requestId,
      orgId,
      errorCode: "EXPERIENCE_VALIDATION_FAILED",
      err,
    });
    throw err;
  }

  const result = await pool.query<ExperienceRow>(
    `SELECT id, org_id, domain, content, metadata, occurred_at, created_at
     FROM experiences
     WHERE org_id = $1 AND id = $2`,
    [orgId, experienceId],
  );
  const row = result.rows[0];
  if (!row) {
    log("warn", "Experience not found", {
      service: "engine",
      component: "memory.experience",
      operation: "experience.getById",
      requestId: context.requestId,
      orgId,
      experienceId,
      errorCode: "EXPERIENCE_NOT_FOUND",
    });
    throw new ExperienceNotFoundError(`No experience found for org ${orgId} with id ${experienceId}`);
  }
  return mapRow(row);
}
