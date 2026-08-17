import type { Pool } from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { loadAgentConfig } from "../config.js";
import { log } from "../logger.js";
import { retrieveMemory } from "../memory/retrieve.js";
import type { ExperienceMatch, KnowledgeMatch, RetrievalResult } from "../memory/retrieve.js";

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;

export class AgentReasoningError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentReasoningError";
  }
}

export class AgentProposalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentProposalValidationError";
  }
}

export interface AgentLoopInput {
  orgId: string;
  /** Free-text description of the new situation — same "query" naming as retrieveMemory's input. */
  query: string;
  domain?: string;
  limit?: number;
}

export interface AgentProposal {
  likelyCause: string;
  recommendation: string;
  /** In [0, 1] — validated in code; JSON Schema can't express a numeric range. */
  confidence: number;
  citedExperienceIds: string[];
  citedKnowledgeIds: string[];
  /** Carried through from the retrieval so a caller doesn't have to cross-reference. */
  knowledgeUnavailable: boolean;
}

export interface AgentLoopResult {
  status: "ok" | "unavailable";
  /** Always present, even when status is "unavailable" — the retrieved memory is still useful on its own. */
  retrieval: RetrievalResult;
  proposal?: AgentProposal;
  reason?: string;
}

/**
 * Minimal shape this module depends on from the Anthropic SDK client — lets tests
 * inject a stub instead of constructing a real Anthropic client and mocking fetch.
 */
export interface AnthropicMessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

/**
 * No numeric range on confidence and no per-request enum of valid ids here — JSON
 * Schema can't express either, and code validates both regardless (CLAUDE.md rule 4),
 * so there is no reliability gained by fighting the schema to approximate them.
 */
const PROPOSAL_JSON_SCHEMA = {
  type: "object",
  properties: {
    likelyCause: { type: "string" },
    recommendation: { type: "string" },
    confidence: { type: "number" },
    citedExperienceIds: { type: "array", items: { type: "string" } },
    citedKnowledgeIds: { type: "array", items: { type: "string" } },
  },
  required: ["likelyCause", "recommendation", "confidence", "citedExperienceIds", "citedKnowledgeIds"],
  additionalProperties: false,
} as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function formatExperience(experience: ExperienceMatch): string {
  const metadata = experience.metadata ? ` Metadata: ${JSON.stringify(experience.metadata)}.` : "";
  return `- [experience:${experience.id}] (occurred ${experience.occurredAt.toISOString()}) ${experience.content}${metadata}`;
}

function formatKnowledge(knowledge: KnowledgeMatch): string {
  return `- [knowledge:${knowledge.id}] (confidence ${knowledge.confidence.toFixed(2)}, similarity ${knowledge.similarity.toFixed(3)}) ${knowledge.statement}`;
}

/**
 * Pure — no I/O, so it's independently testable. Domain-neutral throughout (CLAUDE.md
 * rule 1: packages/engine has zero references to "incident" or any other domain
 * concept) — "situation", not "incident"; that translation is the domain adapter's job.
 * Honest about degraded retrieval rather than silently omitting the knowledge section
 * (ENGINEERING.md §1's "recommendation unavailable" over a bare failure, applied here
 * to what the model itself is told, not just what the caller sees).
 */
export function buildPrompt(input: AgentLoopInput, retrieval: RetrievalResult): { system: string; user: string } {
  const system = [
    "You help an operations team reason about a new situation by comparing it against",
    "similar past experiences and distilled knowledge from the organization's history.",
    "Base your answer only on the experiences and knowledge listed in the user message —",
    "never invent or assume details that aren't there. Every experience and knowledge",
    "item is labeled with an id in brackets, e.g. [experience:abc-123] or",
    "[knowledge:def-456]. When you cite support for your reasoning, cite those ids",
    "exactly as given — never a new id, and never an id for an item that wasn't listed.",
    "Respond with your assessment of the likely cause, a concrete recommendation, your",
    "confidence in that assessment as a number between 0 and 1, and the ids of the",
    "experiences and knowledge items that actually support your reasoning.",
  ].join(" ");

  const experienceLines = retrieval.experiences.length
    ? retrieval.experiences.map(formatExperience).join("\n")
    : "(none retrieved)";

  const knowledgeSection = retrieval.knowledgeUnavailable
    ? "No knowledge base results are available for this query right now — reason only " +
      "from the experiences below, and do not cite any knowledge ids."
    : retrieval.knowledge.length
      ? retrieval.knowledge.map(formatKnowledge).join("\n")
      : "(none retrieved)";

  const user = [
    `Situation: ${input.query}`,
    "",
    "Similar past experiences:",
    experienceLines,
    "",
    "Distilled knowledge:",
    knowledgeSection,
  ].join("\n");

  return { system, user };
}

/**
 * Throws AgentProposalValidationError on the first failing check, in a fixed order —
 * same discipline as validateRetrieveMemoryInput: pure, synchronous, no DB or network
 * calls. The citation checks are the load-bearing part of this function: they're what
 * stops the LLM from inventing supporting evidence that was never actually retrieved
 * (CLAUDE.md rule 4, "LLM proposes, code validates", applied here to citations
 * specifically rather than to a database write).
 */
export function validateAgentProposal(raw: unknown, retrieval: RetrievalResult): AgentProposal {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgentProposalValidationError("proposal must be a JSON object");
  }
  const candidate = raw as Record<string, unknown>;

  if (!isNonEmptyString(candidate.likelyCause)) {
    throw new AgentProposalValidationError("likelyCause is required");
  }
  if (!isNonEmptyString(candidate.recommendation)) {
    throw new AgentProposalValidationError("recommendation is required");
  }

  const confidence = candidate.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new AgentProposalValidationError("confidence must be a number between 0 and 1");
  }

  const citedExperienceIds = candidate.citedExperienceIds;
  if (!Array.isArray(citedExperienceIds) || !citedExperienceIds.every((id) => typeof id === "string")) {
    throw new AgentProposalValidationError("citedExperienceIds must be an array of strings");
  }
  const citedKnowledgeIds = candidate.citedKnowledgeIds;
  if (!Array.isArray(citedKnowledgeIds) || !citedKnowledgeIds.every((id) => typeof id === "string")) {
    throw new AgentProposalValidationError("citedKnowledgeIds must be an array of strings");
  }

  const validExperienceIds = new Set(retrieval.experiences.map((experience) => experience.id));
  for (const id of citedExperienceIds as string[]) {
    if (!validExperienceIds.has(id)) {
      throw new AgentProposalValidationError(`citedExperienceIds references an id that was not retrieved: ${id}`);
    }
  }

  // No knowledge was ever in context to cite, so any id here — however plausible-looking
  // — is fabricated. Checked before the membership loop below so the error names the
  // real problem (unavailable, not "not retrieved") when both would technically fire.
  if (retrieval.knowledgeUnavailable && citedKnowledgeIds.length > 0) {
    throw new AgentProposalValidationError(
      "citedKnowledgeIds must be empty when knowledge retrieval was unavailable",
    );
  }
  const validKnowledgeIds = new Set(retrieval.knowledge.map((knowledge) => knowledge.id));
  for (const id of citedKnowledgeIds as string[]) {
    if (!validKnowledgeIds.has(id)) {
      throw new AgentProposalValidationError(`citedKnowledgeIds references an id that was not retrieved: ${id}`);
    }
  }

  return {
    likelyCause: (candidate.likelyCause as string).trim(),
    recommendation: (candidate.recommendation as string).trim(),
    confidence,
    citedExperienceIds: citedExperienceIds as string[],
    citedKnowledgeIds: citedKnowledgeIds as string[],
    knowledgeUnavailable: retrieval.knowledgeUnavailable,
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
    throw new AgentReasoningError("Anthropic API is not configured", { cause: err });
  }
  // maxRetries stated explicitly (matches the SDK default) so the bounded-retry
  // requirement in ENGINEERING.md §1 is visible in the code, not just inherited
  // silently from whatever the SDK happens to default to.
  return new Anthropic({ apiKey: anthropicApiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
}

/**
 * retrieve → reason → propose. No database writes happen in this file — this is pure
 * reasoning over what retrieveMemory already fetched (see ARCHITECTURE.md's agent loop
 * diagram; the "observe"/write-back step belongs to the reflection job, not here).
 *
 * Retrieval failures (invalid input, a database error) propagate uncaught — exactly
 * retrieveMemory's own contract, which this function doesn't change. Reasoning and
 * validation failures never propagate: they degrade to `status: "unavailable"` with the
 * retrieval still attached, per ENGINEERING.md §1 — "if the LLM call in /analyze fails,
 * return the retrieved memory with a clear 'recommendation unavailable' rather than a
 * bare 500 with no information."
 */
export async function runAgentLoop(
  pool: Pool,
  input: AgentLoopInput,
  context: { requestId?: string; anthropicClient?: AnthropicMessagesClient } = {},
): Promise<AgentLoopResult> {
  const retrieval = await retrieveMemory(
    pool,
    { orgId: input.orgId, query: input.query, domain: input.domain, limit: input.limit },
    { requestId: context.requestId },
  );

  const prompt = buildPrompt(input, retrieval);

  try {
    const client = getAnthropicClient(context.anthropicClient);

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: PROPOSAL_JSON_SCHEMA },
        },
      });
    } catch (err) {
      throw new AgentReasoningError("Anthropic request failed", { cause: err });
    }

    if (response.stop_reason === "refusal") {
      throw new AgentReasoningError(
        `Claude declined to respond (category: ${response.stop_details?.category ?? "unknown"})`,
      );
    }
    if (response.stop_reason === "max_tokens") {
      throw new AgentReasoningError("Claude's response was truncated at max_tokens before it could be validated");
    }

    const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === "text");
    if (!textBlock) {
      throw new AgentReasoningError("Claude's response contained no text content");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch (jsonErr) {
      throw new AgentProposalValidationError(
        `Claude returned malformed JSON: ${(jsonErr as Error).message}`,
      );
    }

    const proposal = validateAgentProposal(parsed, retrieval);

    log("info", "Agent loop produced a validated proposal", {
      service: "engine",
      component: "agent.loop",
      operation: "agent.run",
      requestId: context.requestId,
      orgId: input.orgId,
      knowledgeUnavailable: retrieval.knowledgeUnavailable,
      confidence: proposal.confidence,
    });

    return { status: "ok", retrieval, proposal };
  } catch (err) {
    const errorCode =
      err instanceof AgentProposalValidationError ? "AGENT_PROPOSAL_VALIDATION_FAILED" : "AGENT_REASONING_FAILED";
    log("warn", "Agent reasoning unavailable, degrading to a retrieval-only result", {
      service: "engine",
      component: "agent.loop",
      operation: "agent.run",
      requestId: context.requestId,
      orgId: input.orgId,
      errorCode,
      err: err as Error,
    });
    return {
      status: "unavailable",
      retrieval,
      reason: err instanceof Error ? err.message : "Agent reasoning failed",
    };
  }
}
