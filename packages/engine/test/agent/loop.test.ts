import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RetrievalValidationError } from "../../src/memory/retrieve.js";
import type { ExperienceMatch, KnowledgeMatch, RetrievalResult } from "../../src/memory/retrieve.js";

const retrieveMemoryMock = vi.fn();
vi.mock("../../src/memory/retrieve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/memory/retrieve.js")>();
  return { ...actual, retrieveMemory: (...args: unknown[]) => retrieveMemoryMock(...args) };
});

const {
  AgentProposalValidationError,
  buildPrompt,
  runAgentLoop,
  validateAgentProposal,
} = await import("../../src/agent/loop.js");

const ORG_ID = "11111111-1111-1111-1111-111111111111";

const EXPERIENCE: ExperienceMatch = {
  id: "e1",
  orgId: ORG_ID,
  domain: "ops",
  content: "Pool exhausted under load.",
  metadata: { severity: "high" },
  occurredAt: new Date("2026-08-01T00:00:00Z"),
  createdAt: new Date("2026-08-01T00:05:00Z"),
};

const KNOWLEDGE: KnowledgeMatch = {
  id: "k1",
  orgId: ORG_ID,
  domain: "ops",
  statement: "Restart the pool before scaling replicas.",
  confidence: 0.72,
  reinforcementCount: 3,
  lastReinforcedAt: new Date("2026-08-01T00:00:00Z"),
  createdAt: new Date("2026-08-01T00:00:00Z"),
  similarity: 0.891,
};

function makeRetrieval(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    experiences: [EXPERIENCE],
    knowledge: [KNOWLEDGE],
    knowledgeUnavailable: false,
    ...overrides,
  };
}

const VALID_RAW_PROPOSAL = {
  likelyCause: "Connection pool exhausted under sustained load.",
  recommendation: "Restart the pool and add a max-connections alert.",
  confidence: 0.8,
  citedExperienceIds: ["e1"],
  citedKnowledgeIds: ["k1"],
};

function textResponse(body: unknown, overrides: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    stop_reason: "end_turn",
    stop_details: null,
    ...overrides,
  };
}

describe("buildPrompt", () => {
  it("includes experience content and metadata", () => {
    const { user } = buildPrompt({ orgId: ORG_ID, query: "pool exhausted" }, makeRetrieval());
    expect(user).toContain("[experience:e1]");
    expect(user).toContain("Pool exhausted under load.");
    expect(user).toContain('"severity":"high"');
  });

  it("includes knowledge statement, confidence, and similarity", () => {
    const { user } = buildPrompt({ orgId: ORG_ID, query: "pool exhausted" }, makeRetrieval());
    expect(user).toContain("[knowledge:k1]");
    expect(user).toContain("Restart the pool before scaling replicas.");
    expect(user).toContain("confidence 0.72");
    expect(user).toContain("similarity 0.891");
  });

  it("honestly reflects knowledgeUnavailable instead of silently omitting the section", () => {
    const { user } = buildPrompt(
      { orgId: ORG_ID, query: "pool exhausted" },
      makeRetrieval({ knowledgeUnavailable: true, knowledge: [] }),
    );
    expect(user).toContain("No knowledge base results are available");
    expect(user).not.toContain("[knowledge:");
  });

  it("contains no domain-specific ('incident') wording", () => {
    const { system, user } = buildPrompt({ orgId: ORG_ID, query: "pool exhausted" }, makeRetrieval());
    expect(system.toLowerCase()).not.toContain("incident");
    expect(user.toLowerCase()).not.toContain("incident");
  });
});

describe("validateAgentProposal", () => {
  it("accepts a well-formed proposal", () => {
    const proposal = validateAgentProposal(VALID_RAW_PROPOSAL, makeRetrieval());
    expect(proposal).toEqual({
      likelyCause: VALID_RAW_PROPOSAL.likelyCause,
      recommendation: VALID_RAW_PROPOSAL.recommendation,
      confidence: 0.8,
      citedExperienceIds: ["e1"],
      citedKnowledgeIds: ["k1"],
      knowledgeUnavailable: false,
    });
  });

  it("rejects a missing likelyCause", () => {
    const raw = { ...VALID_RAW_PROPOSAL, likelyCause: "" };
    expect(() => validateAgentProposal(raw, makeRetrieval())).toThrow(/likelyCause is required/);
  });

  it("rejects a missing recommendation", () => {
    const raw = { ...VALID_RAW_PROPOSAL, recommendation: "   " };
    expect(() => validateAgentProposal(raw, makeRetrieval())).toThrow(/recommendation is required/);
  });

  it("rejects confidence above 1", () => {
    const raw = { ...VALID_RAW_PROPOSAL, confidence: 1.5 };
    expect(() => validateAgentProposal(raw, makeRetrieval())).toThrow(/confidence must be a number between 0 and 1/);
  });

  it("rejects confidence below 0", () => {
    const raw = { ...VALID_RAW_PROPOSAL, confidence: -0.1 };
    expect(() => validateAgentProposal(raw, makeRetrieval())).toThrow(/confidence must be a number between 0 and 1/);
  });

  it("rejects a citedExperienceIds entry that was not retrieved", () => {
    const raw = { ...VALID_RAW_PROPOSAL, citedExperienceIds: ["e1", "e-not-retrieved"] };
    expect(() => validateAgentProposal(raw, makeRetrieval())).toThrow(
      /citedExperienceIds references an id that was not retrieved: e-not-retrieved/,
    );
  });

  it("rejects a citedKnowledgeIds entry that was not retrieved", () => {
    const raw = { ...VALID_RAW_PROPOSAL, citedKnowledgeIds: ["k-not-retrieved"] };
    expect(() => validateAgentProposal(raw, makeRetrieval())).toThrow(
      /citedKnowledgeIds references an id that was not retrieved: k-not-retrieved/,
    );
  });

  it("rejects any citedKnowledgeIds when knowledge retrieval was unavailable, even a plausible-looking id", () => {
    const raw = { ...VALID_RAW_PROPOSAL, citedKnowledgeIds: ["k1"] };
    expect(() =>
      validateAgentProposal(raw, makeRetrieval({ knowledgeUnavailable: true, knowledge: [KNOWLEDGE] })),
    ).toThrow(/citedKnowledgeIds must be empty when knowledge retrieval was unavailable/);
  });

  it("throws AgentProposalValidationError specifically", () => {
    expect(() => validateAgentProposal({}, makeRetrieval())).toThrow(AgentProposalValidationError);
  });
});

describe("runAgentLoop", () => {
  beforeEach(() => {
    retrieveMemoryMock.mockReset();
  });

  const pool = {} as Pool;

  it("returns status ok with the validated proposal on the happy path", async () => {
    retrieveMemoryMock.mockResolvedValue(makeRetrieval());
    const createMock = vi.fn().mockResolvedValue(textResponse(VALID_RAW_PROPOSAL));

    const result = await runAgentLoop(
      pool,
      { orgId: ORG_ID, query: "pool exhausted" },
      { anthropicClient: { messages: { create: createMock } } },
    );

    expect(result.status).toBe("ok");
    expect(result.proposal?.likelyCause).toBe(VALID_RAW_PROPOSAL.likelyCause);
    expect(result.retrieval).toEqual(makeRetrieval());
    expect(createMock).toHaveBeenCalledTimes(1);
    const requestArgs = createMock.mock.calls[0]![0];
    expect(requestArgs.model).toBe("claude-sonnet-5");
  });

  it("degrades to status unavailable when the Anthropic call throws", async () => {
    retrieveMemoryMock.mockResolvedValue(makeRetrieval());
    const createMock = vi.fn().mockRejectedValue(new Error("rate limited"));

    const result = await runAgentLoop(
      pool,
      { orgId: ORG_ID, query: "pool exhausted" },
      { anthropicClient: { messages: { create: createMock } } },
    );

    expect(result.status).toBe("unavailable");
    expect(result.retrieval).toEqual(makeRetrieval());
    expect(result.proposal).toBeUndefined();
  });

  it("degrades to status unavailable on a refusal stop reason", async () => {
    retrieveMemoryMock.mockResolvedValue(makeRetrieval());
    const createMock = vi.fn().mockResolvedValue({
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber" },
    });

    const result = await runAgentLoop(
      pool,
      { orgId: ORG_ID, query: "pool exhausted" },
      { anthropicClient: { messages: { create: createMock } } },
    );

    expect(result.status).toBe("unavailable");
    expect(result.reason).toMatch(/declined/);
  });

  it("degrades to status unavailable when the response is truncated at max_tokens", async () => {
    retrieveMemoryMock.mockResolvedValue(makeRetrieval());
    const createMock = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"likelyCause": "incomplet' }],
      stop_reason: "max_tokens",
      stop_details: null,
    });

    const result = await runAgentLoop(
      pool,
      { orgId: ORG_ID, query: "pool exhausted" },
      { anthropicClient: { messages: { create: createMock } } },
    );

    expect(result.status).toBe("unavailable");
    expect(result.reason).toMatch(/truncated/);
  });

  it("degrades to status unavailable when the context window was exceeded", async () => {
    retrieveMemoryMock.mockResolvedValue(makeRetrieval());
    const createMock = vi.fn().mockResolvedValue({
      content: [],
      stop_reason: "model_context_window_exceeded",
      stop_details: null,
    });

    const result = await runAgentLoop(
      pool,
      { orgId: ORG_ID, query: "pool exhausted" },
      { anthropicClient: { messages: { create: createMock } } },
    );

    expect(result.status).toBe("unavailable");
    expect(result.reason).toMatch(/context window/);
  });

  it("degrades to status unavailable when the response text isn't valid JSON, without leaking the response text into the reason", async () => {
    retrieveMemoryMock.mockResolvedValue(makeRetrieval());
    const createMock = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "not json — a secret detail from a retrieved experience" }],
      stop_reason: "end_turn",
      stop_details: null,
    });

    const result = await runAgentLoop(
      pool,
      { orgId: ORG_ID, query: "pool exhausted" },
      { anthropicClient: { messages: { create: createMock } } },
    );

    expect(result.status).toBe("unavailable");
    expect(result.reason).toMatch(/malformed JSON/);
    expect(result.reason).not.toContain("secret detail");
  });

  it("degrades to status unavailable when the response cites an id that was never retrieved", async () => {
    retrieveMemoryMock.mockResolvedValue(makeRetrieval());
    const createMock = vi
      .fn()
      .mockResolvedValue(textResponse({ ...VALID_RAW_PROPOSAL, citedExperienceIds: ["hallucinated-id"] }));

    const result = await runAgentLoop(
      pool,
      { orgId: ORG_ID, query: "pool exhausted" },
      { anthropicClient: { messages: { create: createMock } } },
    );

    expect(result.status).toBe("unavailable");
    expect(result.reason).toMatch(/hallucinated-id/);
  });

  it("propagates a RetrievalValidationError from retrieveMemory rather than swallowing it", async () => {
    retrieveMemoryMock.mockRejectedValue(new RetrievalValidationError("orgId must be a UUID"));
    const createMock = vi.fn();

    await expect(
      runAgentLoop(
        pool,
        { orgId: "not-a-uuid", query: "pool exhausted" },
        { anthropicClient: { messages: { create: createMock } } },
      ),
    ).rejects.toThrow(RetrievalValidationError);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("degrades to status unavailable when ANTHROPIC_API_KEY is unset and no client override is given", async () => {
    retrieveMemoryMock.mockResolvedValue(makeRetrieval());
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await runAgentLoop(pool, { orgId: ORG_ID, query: "pool exhausted" });

      expect(result.status).toBe("unavailable");
      expect(result.reason).toMatch(/not configured/);
    } finally {
      if (original === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = original;
      }
    }
  });
});
