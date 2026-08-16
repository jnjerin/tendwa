import type { Pool } from "pg";
import { log } from "../logger.js";
import { EmbeddingError, embedText } from "./embeddings.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export class RetrievalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetrievalValidationError";
  }
}

export interface RetrieveMemoryInput {
  orgId: string;
  query: string;
  /** Optional structured filter, applied to both knowledge and experiences. */
  domain?: string;
  limit?: number;
}

export interface KnowledgeMatch {
  id: string;
  orgId: string;
  domain: string;
  statement: string;
  confidence: number;
  reinforcementCount: number;
  lastReinforcedAt: Date;
  createdAt: Date;
  /** Cosine similarity in [0, 1] — 1 - cosine distance, matching the vector_cosine_ops index. */
  similarity: number;
}

export interface ExperienceMatch {
  id: string;
  orgId: string;
  domain: string;
  content: string;
  metadata: Record<string, unknown> | null;
  occurredAt: Date;
  createdAt: Date;
}

export interface RetrievalResult {
  knowledge: KnowledgeMatch[];
  experiences: ExperienceMatch[];
  /**
   * True when the query embedding failed and knowledge similarity search was skipped —
   * experiences (structured filtering only, no embedding required) are still returned. See
   * ENGINEERING.md §1: "recommendation unavailable" over a bare failure where honest to do so.
   */
  knowledgeUnavailable: boolean;
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
  similarity: number;
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Pure validation, independent of any DB/embeddings call. Normalizes `limit` to a bounded
 * default so callers can't request an unbounded result set.
 */
export function validateRetrieveMemoryInput(input: RetrieveMemoryInput): { limit: number } {
  if (!isNonEmptyString(input.orgId)) {
    throw new RetrievalValidationError("orgId is required");
  }
  if (!UUID_RE.test(input.orgId)) {
    throw new RetrievalValidationError("orgId must be a UUID");
  }
  if (!isNonEmptyString(input.query)) {
    throw new RetrievalValidationError("query is required");
  }
  if (input.domain !== undefined && !isNonEmptyString(input.domain)) {
    throw new RetrievalValidationError("domain must be a non-empty string when provided");
  }
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RetrievalValidationError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return { limit };
}

/** CockroachDB's VECTOR literal syntax is a bracketed list, e.g. "[0.1,0.2,0.3]". */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export function mapKnowledgeRow(row: KnowledgeRow): KnowledgeMatch {
  return {
    id: row.id,
    orgId: row.org_id,
    domain: row.domain,
    statement: row.statement,
    confidence: row.confidence,
    reinforcementCount: row.reinforcement_count,
    lastReinforcedAt: row.last_reinforced_at,
    createdAt: row.created_at,
    similarity: row.similarity,
  };
}

export function mapExperienceRow(row: ExperienceRow): ExperienceMatch {
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
 * Single-statement SELECT (no explicit BEGIN/COMMIT), so unlike migrate.ts's multi-statement
 * transactions this doesn't need client-side 40001 retry logic: CockroachDB automatically
 * retries an implicit single-statement transaction internally before any result reaches the
 * client. See ARCHITECTURE.md's resolved decision on vector_cosine_ops for why `<=>` (not
 * `<->`) is the correct operator here — confirmed live against tendwa_test, matching the
 * cosine-distance opclass the index was built with.
 */
export async function queryKnowledgeBySimilarity(
  pool: Pool,
  orgId: string,
  embedding: number[],
  domain: string | undefined,
  limit: number,
): Promise<KnowledgeMatch[]> {
  const result = await pool.query<KnowledgeRow>(
    `SELECT id, org_id, domain, statement, confidence, reinforcement_count, last_reinforced_at, created_at,
            1 - (embedding <=> $2::VECTOR) AS similarity
     FROM knowledge
     WHERE org_id = $1
       AND embedding IS NOT NULL
       AND ($3::STRING IS NULL OR domain = $3)
     ORDER BY embedding <=> $2::VECTOR
     LIMIT $4::INT8`,
    [orgId, toVectorLiteral(embedding), domain ?? null, limit],
  );
  return result.rows.map(mapKnowledgeRow);
}

/**
 * experiences has no embedding column by design (see DECISIONS.md, 2026-08-16) — retrieved by
 * structured filtering and recency, not similarity search.
 */
export async function queryRecentExperiences(
  pool: Pool,
  orgId: string,
  domain: string | undefined,
  limit: number,
): Promise<ExperienceMatch[]> {
  const result = await pool.query<ExperienceRow>(
    `SELECT id, org_id, domain, content, metadata, occurred_at, created_at
     FROM experiences
     WHERE org_id = $1
       AND ($2::STRING IS NULL OR domain = $2)
     ORDER BY occurred_at DESC
     LIMIT $3::INT8`,
    [orgId, domain ?? null, limit],
  );
  return result.rows.map(mapExperienceRow);
}

/**
 * Hybrid retrieval: embeds the query text, ranks `knowledge` by cosine similarity, and
 * separately filters `experiences` structurally (org_id, optional domain, recency). If
 * embedding generation fails, knowledge search degrades gracefully — experiences are still
 * returned and `knowledgeUnavailable` is set — rather than failing the whole retrieval; a
 * database failure on either query still propagates, since that's not a condition this
 * function can meaningfully work around.
 */
export async function retrieveMemory(
  pool: Pool,
  input: RetrieveMemoryInput,
  context: { requestId?: string } = {},
): Promise<RetrievalResult> {
  let limit: number;
  try {
    ({ limit } = validateRetrieveMemoryInput(input));
  } catch (err) {
    log("warn", "Rejected invalid retrieval request", {
      service: "engine",
      component: "memory.retrieve",
      operation: "retrieve.memory",
      requestId: context.requestId,
      orgId: typeof input.orgId === "string" ? input.orgId : undefined,
      errorCode: "RETRIEVAL_VALIDATION_FAILED",
      err: err as Error,
    });
    throw err;
  }

  let knowledge: KnowledgeMatch[] = [];
  let knowledgeUnavailable = false;
  try {
    const embedding = await embedText(input.query, { inputType: "query", requestId: context.requestId });
    knowledge = await queryKnowledgeBySimilarity(pool, input.orgId, embedding, input.domain, limit);
  } catch (err) {
    if (!(err instanceof EmbeddingError)) {
      throw err;
    }
    knowledgeUnavailable = true;
    log("warn", "Knowledge similarity search unavailable, degrading to experiences-only", {
      service: "engine",
      component: "memory.retrieve",
      operation: "retrieve.memory",
      requestId: context.requestId,
      orgId: input.orgId,
      errorCode: "KNOWLEDGE_RETRIEVAL_DEGRADED",
      err: err as Error,
    });
  }

  const experiences = await queryRecentExperiences(pool, input.orgId, input.domain, limit);

  log("info", "Retrieved memory", {
    service: "engine",
    component: "memory.retrieve",
    operation: "retrieve.memory",
    requestId: context.requestId,
    orgId: input.orgId,
    knowledgeCount: knowledge.length,
    experienceCount: experiences.length,
    knowledgeUnavailable,
  });

  return { knowledge, experiences, knowledgeUnavailable };
}
