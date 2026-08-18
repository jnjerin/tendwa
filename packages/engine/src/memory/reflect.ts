import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { requireEnv, loadAgentConfig } from "../config.js";
import { createPool } from "../db/client.js";
import { log } from "../logger.js";
import { AgentReasoningError } from "../agent/loop.js";
import type { AnthropicMessagesClient } from "../agent/loop.js";
import { EmbeddingError, embedText } from "./embeddings.js";
import { queryKnowledgeBySimilarity } from "./retrieve.js";
import type { KnowledgeMatch } from "./retrieve.js";
import { KnowledgeNotFoundError, addEvidence, createKnowledge, reinforceKnowledge } from "./knowledge.js";
import { recordAuditEntry } from "./auditLog.js";
import {
  checkpointGroup,
  claimReflectionRun,
  completeReflectionRun,
  failReflectionRun,
  findActiveReflectionState,
  getLastCompletedWatermark,
  resumeReflectionRun,
} from "./agentState.js";
import type {
  AgentStateRow,
  ReflectionGroupState,
  ReflectionProposal,
  ReflectionRunPayload,
  ReflectionWatermark,
} from "./agentState.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const MAX_ITEM_CHARS = 2000;

// Bounds how many un-reflected experiences a single invocation considers — keeps one run's
// cost/duration predictable regardless of how much backlog has accumulated; a large backlog
// simply takes multiple runs (each one's watermark picks up exactly where the last left off).
const MAX_EXPERIENCES_PER_RUN = 200;
// Caps a single group's size so one large near-duplicate cluster still splits into multiple,
// boundedly-sized LLM calls rather than one oversized prompt.
const MAX_GROUP_SIZE = 10;
// Jaccard similarity is naturally much lower than embedding cosine similarity for related-but-
// differently-worded text, so this threshold is deliberately low — tuned by inspection against
// the seed data, not derived from any formal analysis. See DECISIONS.md for why this heuristic
// exists in the first place (a dev-velocity tradeoff, not a claim it's the better general design).
const JACCARD_THRESHOLD = 0.2;
const NEARBY_KNOWLEDGE_LIMIT = 5;

// A minimal, generic English stopword list — not tuned to this project's seed data — used only
// to keep grouping from being dominated by near-universal words ("the", "was") that carry no
// similarity signal of their own.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for", "from", "had", "has",
  "have", "in", "into", "is", "it", "its", "of", "on", "or", "that", "the", "this", "to", "was",
  "were", "will", "with", "would",
]);

const EPOCH_WATERMARK: ReflectionWatermark = {
  createdAt: "1970-01-01T00:00:00.000Z",
  id: "00000000-0000-0000-0000-000000000000",
};

export class ReflectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReflectionValidationError";
  }
}

export class ReflectionProposalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReflectionProposalValidationError";
  }
}

export interface ExperienceWithOutcome {
  id: string;
  orgId: string;
  domain: string;
  content: string;
  metadata: Record<string, unknown> | null;
  occurredAt: Date;
  createdAt: Date;
  outcomeId: string;
  outcomeStatus: string;
  rootCause: string | null;
  actionTaken: string;
  result: string;
}

interface ExperienceOutcomeRow {
  id: string;
  org_id: string;
  domain: string;
  content: string;
  metadata: Record<string, unknown> | null;
  occurred_at: Date;
  created_at: Date;
  outcome_id: string;
  outcome_status: string;
  root_cause: string | null;
  action_taken: string;
  result: string;
}

export interface ReflectionDeps {
  anthropicClient?: AnthropicMessagesClient;
}

export interface ReflectionRunSummary {
  status: "completed" | "skipped_concurrent_run";
  orgId: string;
  runId?: string;
  groupsProcessed?: number;
  groupsApplied?: number;
  groupsRejected?: number;
  groupsSkipped?: number;
  watermark?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function mapExperienceOutcomeRow(row: ExperienceOutcomeRow): ExperienceWithOutcome {
  return {
    id: row.id,
    orgId: row.org_id,
    domain: row.domain,
    content: row.content,
    metadata: row.metadata,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    outcomeId: row.outcome_id,
    outcomeStatus: row.outcome_status,
    rootCause: row.root_cause,
    actionTaken: row.action_taken,
    result: row.result,
  };
}

/**
 * Assumes at most one outcome per experience, matching how recordOutcome is used everywhere
 * else in this codebase today (the seed script, its tests). Multiple outcomes for the same
 * experience would produce duplicate rows here — grouping and prompt-building below don't guard
 * against that, since nothing in this codebase currently creates that shape.
 */
const EXPERIENCE_OUTCOME_SELECT = `
  SELECT e.id, e.org_id, e.domain, e.content, e.metadata, e.occurred_at, e.created_at,
         o.id AS outcome_id, o.status AS outcome_status, o.root_cause, o.action_taken, o.result
  FROM experiences e
  INNER JOIN outcomes o ON o.experience_id = e.id
`;

/**
 * Finds experiences+outcomes not yet reflected on, via a (created_at, id) cursor rather than a
 * flag column or a dedicated reflections table (neither exists — see DECISIONS.md, 2026-08-16).
 * The tuple comparison keeps the cursor deterministic across ties on created_at; confirmed
 * against the live tendwa_test cluster before relying on it here, per CLAUDE.md's standing rule
 * to verify evolving CockroachDB SQL behavior rather than trust cached Postgres knowledge.
 * Ordering is any-outcome-status, any-domain: eligibility scope (outcome-paired, all statuses)
 * was a deliberate decision — see DECISIONS.md.
 */
async function fetchUnreflectedExperiences(
  pool: Pool,
  orgId: string,
  watermark: ReflectionWatermark,
  limit: number,
): Promise<ExperienceWithOutcome[]> {
  const result = await pool.query<ExperienceOutcomeRow>(
    `${EXPERIENCE_OUTCOME_SELECT}
     WHERE e.org_id = $1 AND (e.created_at, e.id) > ($2::TIMESTAMPTZ, $3::UUID)
     ORDER BY e.created_at ASC, e.id ASC
     LIMIT $4::INT8`,
    [orgId, watermark.createdAt, watermark.id, limit],
  );
  return result.rows.map(mapExperienceOutcomeRow);
}

/** Re-fetches a specific group's experiences by id — used both on a fresh run (rather than
 *  keeping the whole initial batch around) and on resume (where the initial batch was never
 *  fetched by this invocation at all), so group processing doesn't need two code paths. */
async function fetchExperiencesByIds(pool: Pool, orgId: string, ids: string[]): Promise<ExperienceWithOutcome[]> {
  const result = await pool.query<ExperienceOutcomeRow>(
    `${EXPERIENCE_OUTCOME_SELECT}
     WHERE e.org_id = $1 AND e.id = ANY($2::UUID[])
     ORDER BY e.created_at ASC, e.id ASC`,
    [orgId, ids],
  );
  return result.rows.map(mapExperienceOutcomeRow);
}

/** Pure. Lowercases, strips punctuation, drops a generic stopword list and single-character
 *  tokens. No stemming/lemmatization — deliberately simple, matching the "heuristic, not real
 *  clustering" scope this function exists within (see DECISIONS.md). */
export function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
  return new Set(words);
}

/** Pure. Standard Jaccard similarity (intersection / union) over two token sets, in [0, 1]. */
export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Pure, independent of any DB/embeddings call — partitions by domain (engine stays
 * domain-agnostic; a domain is just a string to partition on, never interpreted), then greedily
 * single-links within each partition by token-overlap similarity against the group's accumulated
 * token set. Rows must already be ordered ascending (by created_at, id) — the caller's queries
 * both provide that — so grouping is deterministic given the same input batch, which matters for
 * why a resumed run never re-groups (see reflect.ts's runReflection).
 */
export function groupExperiences(rows: readonly ExperienceWithOutcome[]): ReflectionGroupState[] {
  const byDomain = new Map<string, ExperienceWithOutcome[]>();
  for (const row of rows) {
    const list = byDomain.get(row.domain);
    if (list) {
      list.push(row);
    } else {
      byDomain.set(row.domain, [row]);
    }
  }

  const groups: ReflectionGroupState[] = [];
  for (const [domain, domainRows] of byDomain) {
    const openGroups: Array<{ experienceIds: string[]; tokens: Set<string> }> = [];
    for (const row of domainRows) {
      const tokens = tokenize(row.content);
      const target = openGroups.find(
        (group) => group.experienceIds.length < MAX_GROUP_SIZE && jaccardSimilarity(tokens, group.tokens) >= JACCARD_THRESHOLD,
      );
      if (target) {
        target.experienceIds.push(row.id);
        for (const token of tokens) {
          target.tokens.add(token);
        }
      } else {
        openGroups.push({ experienceIds: [row.id], tokens });
      }
    }
    for (const group of openGroups) {
      groups.push({ groupIndex: groups.length, experienceIds: group.experienceIds, domain, status: "pending" });
    }
  }
  return groups;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}… [truncated, ${text.length} chars total]`;
}

/** Tolerates a cited id carrying its bracket-label prefix — same idiom and rationale as
 *  agent/loop.ts's stripCitationPrefix (duplicated here since loop.ts doesn't export it; see
 *  knowledge.ts's toVectorLiteral comment for this codebase's established stance on duplicating
 *  small pure helpers rather than sharing them across files). */
function stripCitationPrefix(id: string, prefix: string): string {
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function formatGroupExperience(row: ExperienceWithOutcome): string {
  const content = truncate(row.content, MAX_ITEM_CHARS);
  const rootCause = row.rootCause ? ` | root cause: ${truncate(row.rootCause, MAX_ITEM_CHARS)}` : "";
  return (
    `- [experience:${row.id}] (occurred ${row.occurredAt.toISOString()}, outcome: ${row.outcomeStatus}) ${content} ` +
    `| action taken: ${truncate(row.actionTaken, MAX_ITEM_CHARS)} | result: ${truncate(row.result, MAX_ITEM_CHARS)}${rootCause}`
  );
}

function formatNearbyKnowledge(match: KnowledgeMatch): string {
  const statement = truncate(match.statement, MAX_ITEM_CHARS);
  return `- [knowledge:${match.id}] (confidence ${match.confidence.toFixed(2)}, similarity ${match.similarity.toFixed(3)}) ${statement}`;
}

/**
 * Pure — no I/O. Domain-neutral throughout (CLAUDE.md rule 1): "experiences" and "outcomes",
 * never "incident". Asks for one of three actions per group, mirroring agent/loop.ts's
 * buildPrompt's citation-labeling convention exactly so validateReflectionProposal can reuse the
 * same bracket-stripping idiom.
 */
export function buildGroupPrompt(group: readonly ExperienceWithOutcome[], nearbyKnowledge: readonly KnowledgeMatch[]): { system: string; user: string } {
  const system = [
    "You distill durable, general knowledge from a group of related past experiences and their",
    "recorded outcomes. Base your answer only on the experiences and knowledge listed in the",
    "user message — never invent or assume details that aren't there.",
    "Every experience and knowledge item is labeled in brackets as [experience:<id>] or",
    "[knowledge:<id>] — the id is only the part after the colon: for [experience:abc-123] the id",
    'is abc-123, not "experience:abc-123". When you cite support for your proposal, cite only',
    "that bare id — never a new id, and never an id for an item that wasn't listed.",
    'Decide one of three actions: "create" a new knowledge statement if this group reveals a',
    "durable pattern not already captured by the knowledge listed below; \"reinforce\" one of the",
    "listed knowledge items if this group's outcomes confirm or usefully update confidence in",
    'something already known (cite its id as targetKnowledgeId); or "skip" if this group does not',
    "show a clear, generalizable pattern. Every create/reinforce action must cite at least one",
    "supporting experience id in citedExperienceIds. Give your confidence in the action as a",
    "number between 0 and 1.",
  ].join(" ");

  const experienceLines = group.map(formatGroupExperience).join("\n");
  const knowledgeLines = nearbyKnowledge.length ? nearbyKnowledge.map(formatNearbyKnowledge).join("\n") : "(none found)";

  const user = ["Group of related experiences:", experienceLines, "", "Existing knowledge nearby in this domain:", knowledgeLines].join(
    "\n",
  );

  return { system, user };
}

/**
 * No numeric range on confidence and no per-request enum of valid ids — JSON Schema can't
 * express either, and code validates both regardless (CLAUDE.md rule 4), matching
 * agent/loop.ts's PROPOSAL_JSON_SCHEMA precedent exactly.
 */
const REFLECTION_PROPOSAL_JSON_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["create", "reinforce", "skip"] },
    statement: { type: "string" },
    targetKnowledgeId: { type: "string" },
    confidence: { type: "number" },
    citedExperienceIds: { type: "array", items: { type: "string" } },
    reasoning: { type: "string" },
  },
  required: ["action", "confidence", "citedExperienceIds"],
  additionalProperties: false,
} as const;

/**
 * Throws ReflectionProposalValidationError on the first failing check, in a fixed order — same
 * discipline as agent/loop.ts's validateAgentProposal, tightened here: citedExperienceIds is
 * checked against this group's actual experience ids specifically (not "everything ever
 * retrieved"), since a reflection proposal citing an experience from outside its own group is
 * exactly the kind of fabrication this check exists to catch.
 */
export function validateReflectionProposal(
  raw: unknown,
  groupExperienceIds: readonly string[],
  nearbyKnowledgeIds: readonly string[],
): ReflectionProposal {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ReflectionProposalValidationError("proposal must be a JSON object");
  }
  const candidate = raw as Record<string, unknown>;

  const action = candidate.action;
  if (action !== "create" && action !== "reinforce" && action !== "skip") {
    throw new ReflectionProposalValidationError('action must be "create", "reinforce", or "skip"');
  }

  const confidence = candidate.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new ReflectionProposalValidationError("confidence must be a number between 0 and 1");
  }

  const citedExperienceIdsRaw = candidate.citedExperienceIds;
  if (!Array.isArray(citedExperienceIdsRaw) || !citedExperienceIdsRaw.every((id) => typeof id === "string")) {
    throw new ReflectionProposalValidationError("citedExperienceIds must be an array of strings");
  }
  const citedExperienceIds = (citedExperienceIdsRaw as string[]).map((id) => stripCitationPrefix(id, "experience:"));

  if (action !== "skip" && citedExperienceIds.length === 0) {
    throw new ReflectionProposalValidationError("citedExperienceIds must be non-empty when action is create/reinforce");
  }

  const validExperienceIds = new Set(groupExperienceIds);
  for (const id of citedExperienceIds) {
    if (!validExperienceIds.has(id)) {
      throw new ReflectionProposalValidationError(`citedExperienceIds references an id outside this group: ${id}`);
    }
  }

  let statement: string | undefined;
  if (action === "create") {
    if (!isNonEmptyString(candidate.statement)) {
      throw new ReflectionProposalValidationError('statement is required when action is "create"');
    }
    statement = candidate.statement.trim();
  }

  let targetKnowledgeId: string | undefined;
  if (action === "reinforce") {
    if (!isNonEmptyString(candidate.targetKnowledgeId)) {
      throw new ReflectionProposalValidationError('targetKnowledgeId is required when action is "reinforce"');
    }
    targetKnowledgeId = stripCitationPrefix(candidate.targetKnowledgeId, "knowledge:");
    const validKnowledgeIds = new Set(nearbyKnowledgeIds);
    if (!validKnowledgeIds.has(targetKnowledgeId)) {
      throw new ReflectionProposalValidationError(`targetKnowledgeId references an id that was not shown: ${targetKnowledgeId}`);
    }
  }

  return {
    action,
    statement,
    targetKnowledgeId,
    confidence,
    citedExperienceIds,
    reasoning: isNonEmptyString(candidate.reasoning) ? candidate.reasoning.trim() : undefined,
  };
}

function getAnthropicClient(override: AnthropicMessagesClient | undefined): AnthropicMessagesClient {
  if (override) {
    return override;
  }
  let anthropicApiKey: string;
  try {
    anthropicApiKey = loadAgentConfig().anthropicApiKey;
  } catch (err) {
    throw new AgentReasoningError("Anthropic API is not configured", { cause: err, code: "AGENT_CONFIG_MISSING" });
  }
  return new Anthropic({ apiKey: anthropicApiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
}

/** Identical classification to agent/loop.ts's classifyAnthropicError — duplicated for the same
 *  reason stripCitationPrefix is (not exported from loop.ts). */
function classifyAnthropicError(err: unknown): string {
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return "AGENT_TIMEOUT";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "AGENT_RATE_LIMITED";
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return "AGENT_AUTH_FAILED";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "AGENT_CONNECTION_FAILED";
  }
  if (err instanceof Anthropic.APIError) {
    return "AGENT_API_ERROR";
  }
  return "AGENT_REQUEST_FAILED";
}

/**
 * Gets one raw proposal from Claude for a group. Throws AgentReasoningError only for failures
 * that are safe to blindly retry the whole group for later (the request never got a usable
 * response at all — network/timeout/rate-limit/auth) — these propagate out of processGroup and
 * abort the run via failReflectionRun, per ENGINEERING.md §1's crash-resume requirement.
 * Everything else (a refusal, a truncated response, a context-window overflow, malformed JSON)
 * means a response WAS received but can't be used — those throw ReflectionProposalValidationError
 * instead, which processGroup treats as a rejected proposal for this group specifically, not a
 * run-level failure; retrying the identical prompt wouldn't fix any of those anyway.
 */
async function getProposalFromClaude(client: AnthropicMessagesClient, prompt: { system: string; user: string }): Promise<unknown> {
  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: REFLECTION_PROPOSAL_JSON_SCHEMA },
      },
    });
  } catch (err) {
    throw new AgentReasoningError("Anthropic request failed", { cause: err, code: classifyAnthropicError(err) });
  }

  if (response.stop_reason === "refusal") {
    throw new ReflectionProposalValidationError(`Claude declined to respond (category: ${response.stop_details?.category ?? "unknown"})`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new ReflectionProposalValidationError("Claude's response was truncated at max_tokens before it could be validated");
  }
  if (response.stop_reason === "model_context_window_exceeded") {
    throw new ReflectionProposalValidationError("The group's context exceeded the model's context window");
  }

  const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === "text");
  if (!textBlock) {
    throw new ReflectionProposalValidationError("Claude's response contained no text content");
  }

  try {
    return JSON.parse(textBlock.text);
  } catch {
    // Deliberately not logging the parse error or raw text — see agent/loop.ts's identical
    // comment on the same tradeoff (ENGINEERING.md §4: never log raw sensitive prompt content).
    throw new ReflectionProposalValidationError(`Claude returned malformed JSON (${textBlock.text.length} characters)`);
  }
}

async function readKnowledgeSnapshot(
  pool: Pool,
  orgId: string,
  knowledgeId: string,
): Promise<{ confidenceBefore: number; reinforcementCountBefore: number }> {
  const result = await pool.query<{ confidence: number; reinforcement_count: number }>(
    `SELECT confidence, reinforcement_count FROM knowledge WHERE org_id = $1 AND id = $2`,
    [orgId, knowledgeId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new KnowledgeNotFoundError(`No knowledge found for org ${orgId} with id ${knowledgeId}`);
  }
  return { confidenceBefore: row.confidence, reinforcementCountBefore: row.reinforcement_count };
}

/**
 * Applies a validated create/reinforce proposal, checkpointing around the one non-idempotent
 * write so a crash between that write landing and the group being marked complete doesn't
 * re-issue it on resume. See DECISIONS.md's "apply-step sub-checkpointing" note for the residual,
 * deliberately accepted gap this doesn't fully close (a lost acknowledgment after a durable
 * commit, for `create` specifically — the same class of gap already accepted for
 * reinforceKnowledge's own bare-retry case).
 *
 * A resumed run re-fetches a fresh proposal from Claude for the group rather than replaying the
 * one from before the crash (nothing in the checkpoint stores the original proposal, only the
 * apply attempt's own progress) — sampling means that fresh proposal isn't guaranteed to match
 * the checkpointed applyAttempt's action. Every reuse below is therefore gated on
 * `applyAttempt.action === proposal.action`: a checkpoint from a differently-actioned prior
 * attempt is stale and must not be silently reused (e.g. reusing an old create's knowledgeId to
 * link evidence for what Claude now proposes as a reinforce would attach evidence to the wrong,
 * unrelated knowledge row while never actually applying the new proposal).
 */
async function applyProposal(
  pool: Pool,
  orgId: string,
  state: AgentStateRow,
  group: ReflectionGroupState,
  proposal: ReflectionProposal,
  context: { requestId?: string },
): Promise<string> {
  const payload = state.payload as ReflectionRunPayload;

  if (proposal.action === "create") {
    if (group.applyAttempt?.action === "create" && group.applyAttempt.knowledgeId) {
      return group.applyAttempt.knowledgeId;
    }
    group.applyAttempt = { action: "create" };
    await checkpointGroup(pool, state.id, orgId, payload, context);

    const knowledge = await createKnowledge(
      pool,
      { orgId, domain: group.domain, statement: proposal.statement as string, initialConfidence: proposal.confidence },
      context,
    );

    group.applyAttempt.knowledgeId = knowledge.id;
    await checkpointGroup(pool, state.id, orgId, payload, context);
    return knowledge.id;
  }

  const targetKnowledgeId = proposal.targetKnowledgeId as string;
  if (group.applyAttempt?.action !== "reinforce" || !group.applyAttempt.reinforceSnapshot) {
    const snapshot = await readKnowledgeSnapshot(pool, orgId, targetKnowledgeId);
    group.applyAttempt = { action: "reinforce", reinforceSnapshot: snapshot };
    await checkpointGroup(pool, state.id, orgId, payload, context);
    await reinforceKnowledge(pool, { orgId, knowledgeId: targetKnowledgeId, newConfidence: proposal.confidence }, context);
    return targetKnowledgeId;
  }

  // Resuming after a crash whose outcome is unconfirmed: compare current state to the pre-call
  // snapshot to tell "the write never landed" from "it already applied". This assumes nothing
  // else concurrently reinforces the same knowledge row between the snapshot and this check —
  // true today since resumeReflectionRun's compare-and-swap guarantees at most one active
  // reflection run per org, and reflection is the only writer of reinforceKnowledge calls.
  const current = await readKnowledgeSnapshot(pool, orgId, targetKnowledgeId);
  if (current.reinforcementCountBefore === group.applyAttempt.reinforceSnapshot.reinforcementCountBefore) {
    await reinforceKnowledge(pool, { orgId, knowledgeId: targetKnowledgeId, newConfidence: proposal.confidence }, context);
  }
  return targetKnowledgeId;
}

async function processGroup(
  pool: Pool,
  client: AnthropicMessagesClient,
  orgId: string,
  state: AgentStateRow,
  group: ReflectionGroupState,
  context: { requestId?: string },
): Promise<void> {
  const payload = state.payload as ReflectionRunPayload;

  let proposal: ReflectionProposal;
  if (group.proposal) {
    // Resuming a group whose proposal was already validated and checkpointed before the crash —
    // replay it exactly rather than asking Claude again. See ReflectionGroupState.proposal's doc
    // comment (agentState.ts) for why re-sampling here would be unsafe: a fresh response isn't
    // guaranteed to return the same action as one that may already be partially or fully applied.
    proposal = group.proposal;
  } else {
    const groupRows = await fetchExperiencesByIds(pool, orgId, group.experienceIds);

    let nearbyKnowledge: KnowledgeMatch[] = [];
    const representative = groupRows[0];
    if (representative) {
      try {
        const embedding = await embedText(representative.content, { inputType: "query", requestId: context.requestId });
        nearbyKnowledge = await queryKnowledgeBySimilarity(pool, orgId, embedding, group.domain, NEARBY_KNOWLEDGE_LIMIT);
      } catch (err) {
        if (!(err instanceof EmbeddingError)) {
          throw err; // a DB failure here means abort the run — nothing has been written for this group yet
        }
        log("warn", "Nearby-knowledge lookup unavailable for a reflection group, continuing without it", {
          service: "engine",
          component: "memory.reflect",
          operation: "reflect.group",
          requestId: context.requestId,
          orgId,
          runId: payload.runId,
          groupIndex: group.groupIndex,
          errorCode: "REFLECTION_NEARBY_KNOWLEDGE_UNAVAILABLE",
          err: err as Error,
        });
      }
    }

    const prompt = buildGroupPrompt(groupRows, nearbyKnowledge);

    let rawProposal: unknown;
    try {
      rawProposal = await getProposalFromClaude(client, prompt);
      proposal = validateReflectionProposal(
        rawProposal,
        group.experienceIds,
        nearbyKnowledge.map((match) => match.id),
      );
    } catch (err) {
      if (err instanceof AgentReasoningError) {
        throw err; // transient — abort the run; resume will retry this exact group from scratch
      }
      await recordAuditEntry(
        pool,
        orgId,
        "reflection.proposal_rejected",
        {
          runId: payload.runId,
          groupIndex: group.groupIndex,
          experienceIds: group.experienceIds,
          rawProposal: rawProposal ?? null,
          validationError: err instanceof Error ? err.message : String(err),
        },
        context,
      );
      group.status = "rejected";
      await checkpointGroup(pool, state.id, orgId, payload, context);
      return;
    }

    // Checkpointed immediately, before anything is applied from it — this is what makes the
    // replay-on-resume above possible, and closes the orphan/false-skip failure mode a validation
    // failure can't (a rejected proposal never gets here, and never applies anything either).
    group.proposal = proposal;
    await checkpointGroup(pool, state.id, orgId, payload, context);
  }

  if (proposal.action === "skip") {
    await recordAuditEntry(
      pool,
      orgId,
      "reflection.proposal_skipped",
      { runId: payload.runId, groupIndex: group.groupIndex, experienceIds: group.experienceIds, reasoning: proposal.reasoning ?? null },
      context,
    );
    group.status = "skipped";
    await checkpointGroup(pool, state.id, orgId, payload, context);
    return;
  }

  const knowledgeId = await applyProposal(pool, orgId, state, group, proposal, context);

  for (const experienceId of proposal.citedExperienceIds) {
    await addEvidence(pool, { orgId, knowledgeId, experienceId }, context);
  }

  // applyAttempt is always set by applyProposal by this point (fresh or reused from a prior
  // checkpoint). Gated on auditRecorded for the same reason applyProposal's own writes are
  // sub-checkpointed: a crash between recordAuditEntry committing and this group being marked
  // "completed" would otherwise re-record a second "applied" entry on resume for a proposal
  // that was, at most, actually applied once — agent_audit_log is the durable record of what
  // was applied (CLAUDE.md rule 4), so a phantom duplicate there is a real audit-integrity gap,
  // not a harmless log line. This narrows the risk window to "between recordAuditEntry
  // committing and the checkpoint below landing" but doesn't fully close it — agent_audit_log
  // has no natural dedupe key (unlike knowledge_evidence's ON CONFLICT DO NOTHING), so a crash
  // in that exact window can still produce one duplicate row. Same class of deliberately
  // accepted gap as createKnowledge's lost-acknowledgment case; see DECISIONS.md.
  if (!group.applyAttempt?.auditRecorded) {
    await recordAuditEntry(
      pool,
      orgId,
      "reflection.proposal_applied",
      { runId: payload.runId, groupIndex: group.groupIndex, proposal, knowledgeId },
      context,
    );
    if (group.applyAttempt) {
      group.applyAttempt.auditRecorded = true;
    }
    await checkpointGroup(pool, state.id, orgId, payload, context);
  }
  group.status = "completed";
  await checkpointGroup(pool, state.id, orgId, payload, context);
}

function summarize(orgId: string, payload: ReflectionRunPayload): ReflectionRunSummary {
  return {
    status: "completed",
    orgId,
    runId: payload.runId,
    groupsProcessed: payload.groups.length,
    groupsApplied: payload.groups.filter((group) => group.status === "completed").length,
    groupsRejected: payload.groups.filter((group) => group.status === "rejected").length,
    groupsSkipped: payload.groups.filter((group) => group.status === "skipped").length,
    watermark: payload.watermarkAfter.createdAt,
  };
}

/**
 * Stage 2 of the memory lifecycle: finds experiences+outcomes not yet reflected on, groups them,
 * asks Claude whether each group is new knowledge or reinforcement of existing knowledge, and
 * applies validated proposals via knowledge.ts's write functions. One org per call — iterating
 * every org is the caller's job (a future Lambda handler, or this file's own CLI main() below),
 * matching every other memory module's orgId-as-input convention.
 *
 * Crash recovery: agent_state is checked for an active run before anything else. If found, this
 * invocation claims it via compare-and-swap and resumes the frozen group plan exactly, rather
 * than restarting or double-processing (ENGINEERING.md §1). If claiming fails (another
 * invocation already has it — the realistic trigger is AWS Lambda's at-least-once semantics),
 * this call is a safe no-op.
 */
export async function runReflection(
  pool: Pool,
  deps: ReflectionDeps,
  input: { orgId: string },
  context: { requestId?: string } = {},
): Promise<ReflectionRunSummary> {
  const orgId = input.orgId;
  if (!isNonEmptyString(orgId) || !UUID_RE.test(orgId)) {
    throw new ReflectionValidationError("orgId is required and must be a UUID");
  }

  const active = await findActiveReflectionState(pool, orgId, context);
  let state: AgentStateRow;

  if (active) {
    const resumed = await resumeReflectionRun(pool, active.id, orgId, active.updatedAt, context);
    if (!resumed) {
      log("info", "Another reflection run is already in progress for this org, skipping", {
        service: "engine",
        component: "memory.reflect",
        operation: "reflect.run",
        requestId: context.requestId,
        orgId,
      });
      return { status: "skipped_concurrent_run", orgId };
    }
    state = resumed;
    const payload = state.payload as ReflectionRunPayload;
    log("info", "Resumed reflection run", {
      service: "engine",
      component: "memory.reflect",
      operation: "reflect.run",
      requestId: context.requestId,
      orgId,
      runId: payload.runId,
      groupCount: payload.groups.length,
    });
  } else {
    const watermark = (await getLastCompletedWatermark(pool, orgId)) ?? EPOCH_WATERMARK;
    const rows = await fetchUnreflectedExperiences(pool, orgId, watermark, MAX_EXPERIENCES_PER_RUN);
    if (rows.length === 0) {
      log("info", "No new experiences to reflect on", {
        service: "engine",
        component: "memory.reflect",
        operation: "reflect.run",
        requestId: context.requestId,
        orgId,
      });
      return { status: "completed", orgId, groupsProcessed: 0, groupsApplied: 0, groupsRejected: 0, groupsSkipped: 0 };
    }
    const groups = groupExperiences(rows);
    const lastRow = rows[rows.length - 1] as ExperienceWithOutcome;
    const payload: ReflectionRunPayload = {
      runId: randomUUID(),
      watermarkBefore: watermark.createdAt,
      watermarkAfter: { createdAt: lastRow.createdAt.toISOString(), id: lastRow.id },
      groups,
    };
    state = await claimReflectionRun(pool, orgId, payload, context);
    log("info", "Started reflection run", {
      service: "engine",
      component: "memory.reflect",
      operation: "reflect.run",
      requestId: context.requestId,
      orgId,
      runId: payload.runId,
      experienceCount: rows.length,
      groupCount: groups.length,
    });
  }

  const payload = state.payload as ReflectionRunPayload;

  try {
    const client = getAnthropicClient(deps.anthropicClient);
    for (const group of payload.groups) {
      if (group.status !== "pending") {
        continue;
      }
      const startedAt = Date.now();
      await processGroup(pool, client, orgId, state, group, context);
      log("info", "Processed reflection group", {
        service: "engine",
        component: "memory.reflect",
        operation: "reflect.group",
        requestId: context.requestId,
        orgId,
        runId: payload.runId,
        groupIndex: group.groupIndex,
        groupStatus: group.status,
        durationMs: Date.now() - startedAt,
      });
    }
  } catch (err) {
    await failReflectionRun(pool, state.id, orgId, context);
    log("error", "Reflection run failed, will resume from checkpoint on the next invocation", {
      service: "engine",
      component: "memory.reflect",
      operation: "reflect.run",
      requestId: context.requestId,
      orgId,
      runId: payload.runId,
      err: err as Error,
    });
    throw err;
  }

  await completeReflectionRun(pool, state.id, orgId, payload, context);
  const summary = summarize(orgId, payload);
  log("info", "Completed reflection run", {
    service: "engine",
    component: "memory.reflect",
    operation: "reflect.run",
    requestId: context.requestId,
    orgId,
    runId: payload.runId,
    groupsProcessed: summary.groupsProcessed,
    groupsApplied: summary.groupsApplied,
    groupsRejected: summary.groupsRejected,
    groupsSkipped: summary.groupsSkipped,
  });
  return summary;
}

// main() below deliberately uses console.error/console.log, not the structured pino logger —
// same rationale as migrate.ts: this is CLI operator output for a human running the command
// directly, not a service log line. The actual run (group-by-group progress, applied/rejected/
// skipped outcomes) is still logged structurally above, inside runReflection itself. This is
// explicitly not the Lambda wrapper — no scheduling, no multi-org loop, no AWS integration —
// just a direct, scriptable way to trigger runReflection for one org.
async function main(): Promise<void> {
  const useTest = process.argv.includes("--test");
  const varName = useTest ? "TEST_DATABASE_URL" : "DATABASE_URL";
  const connectionString = requireEnv(process.env, varName);
  const orgId = process.argv.find((arg) => arg.startsWith("--org="))?.slice("--org=".length);
  if (!orgId) {
    throw new Error("Usage: reflect.ts --org=<orgId> [--test]");
  }
  const pool = createPool({ connectionString });
  try {
    const summary = await runReflection(pool, {}, { orgId });
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
