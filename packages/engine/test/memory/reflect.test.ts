import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingError } from "../../src/memory/embeddings.js";
import type { KnowledgeMatch } from "../../src/memory/retrieve.js";
import type { AgentStateRow, ReflectionRunPayload } from "../../src/memory/agentState.js";
import type { ExperienceWithOutcome } from "../../src/memory/reflect.js";

const embedTextMock = vi.fn();
vi.mock("../../src/memory/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/memory/embeddings.js")>();
  return { ...actual, embedText: (...args: unknown[]) => embedTextMock(...args) };
});

const queryKnowledgeBySimilarityMock = vi.fn();
vi.mock("../../src/memory/retrieve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/memory/retrieve.js")>();
  return { ...actual, queryKnowledgeBySimilarity: (...args: unknown[]) => queryKnowledgeBySimilarityMock(...args) };
});

const createKnowledgeMock = vi.fn();
const reinforceKnowledgeMock = vi.fn();
const addEvidenceMock = vi.fn();
vi.mock("../../src/memory/knowledge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/memory/knowledge.js")>();
  return {
    ...actual,
    createKnowledge: (...args: unknown[]) => createKnowledgeMock(...args),
    reinforceKnowledge: (...args: unknown[]) => reinforceKnowledgeMock(...args),
    addEvidence: (...args: unknown[]) => addEvidenceMock(...args),
  };
});

const recordAuditEntryMock = vi.fn();
vi.mock("../../src/memory/auditLog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/memory/auditLog.js")>();
  return { ...actual, recordAuditEntry: (...args: unknown[]) => recordAuditEntryMock(...args) };
});

const findActiveReflectionStateMock = vi.fn();
const getLastCompletedWatermarkMock = vi.fn();
const claimReflectionRunMock = vi.fn();
const resumeReflectionRunMock = vi.fn();
const checkpointGroupMock = vi.fn();
const completeReflectionRunMock = vi.fn();
const failReflectionRunMock = vi.fn();
vi.mock("../../src/memory/agentState.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/memory/agentState.js")>();
  return {
    ...actual,
    findActiveReflectionState: (...args: unknown[]) => findActiveReflectionStateMock(...args),
    getLastCompletedWatermark: (...args: unknown[]) => getLastCompletedWatermarkMock(...args),
    claimReflectionRun: (...args: unknown[]) => claimReflectionRunMock(...args),
    resumeReflectionRun: (...args: unknown[]) => resumeReflectionRunMock(...args),
    checkpointGroup: (...args: unknown[]) => checkpointGroupMock(...args),
    completeReflectionRun: (...args: unknown[]) => completeReflectionRunMock(...args),
    failReflectionRun: (...args: unknown[]) => failReflectionRunMock(...args),
  };
});

const {
  ReflectionProposalValidationError,
  ReflectionValidationError,
  buildGroupPrompt,
  groupExperiences,
  jaccardSimilarity,
  runReflection,
  tokenize,
  validateReflectionProposal,
} = await import("../../src/memory/reflect.js");

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const STATE_ID = "22222222-2222-2222-2222-222222222222";
const EXP_ID = "33333333-3333-3333-3333-333333333333";
const EXP_ID_2 = "44444444-4444-4444-4444-444444444444";
const KID = "55555555-5555-5555-5555-555555555555";

const EXPERIENCE_WITH_OUTCOME: ExperienceWithOutcome = {
  id: EXP_ID,
  orgId: ORG_ID,
  domain: "ops",
  content: "Pool exhausted under sustained load; restarted pool service.",
  metadata: null,
  occurredAt: new Date("2026-08-01T00:00:00Z"),
  createdAt: new Date("2026-08-01T00:05:00Z"),
  outcomeId: "outcome-1",
  outcomeStatus: "resolved",
  rootCause: "Connection leak",
  actionTaken: "Restarted the pool service",
  result: "Service recovered within 2 minutes",
};

function makeExpDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EXP_ID,
    org_id: ORG_ID,
    domain: "ops",
    content: "Pool exhausted under sustained load; restarted pool service.",
    metadata: null,
    occurred_at: new Date("2026-08-01T00:00:00Z"),
    created_at: new Date("2026-08-01T00:05:00Z"),
    outcome_id: "outcome-1",
    outcome_status: "resolved",
    root_cause: "Connection leak",
    action_taken: "Restarted the pool service",
    result: "Service recovered within 2 minutes",
    ...overrides,
  };
}

function makePoolQueryRouter(routes: { unreflected?: unknown[]; byIds?: unknown[]; knowledgeSnapshot?: unknown[] }) {
  return vi.fn(async (sql: string) => {
    if (sql.includes("(e.created_at, e.id) >")) {
      return { rows: routes.unreflected ?? [] };
    }
    if (sql.includes("e.id = ANY")) {
      return { rows: routes.byIds ?? [] };
    }
    if (sql.includes("FROM knowledge WHERE org_id")) {
      return { rows: routes.knowledgeSnapshot ?? [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
}

function makeState(payload: ReflectionRunPayload, overrides: Partial<AgentStateRow> = {}): AgentStateRow {
  return {
    id: STATE_ID,
    orgId: ORG_ID,
    status: "running",
    step: "reflection",
    payload,
    updatedAt: new Date("2026-08-18T00:00:00Z"),
    updatedAtRaw: "2026-08-18 00:00:00.000000+00",
    ...overrides,
  };
}

function textResponse(body: unknown, overrides: Record<string, unknown> = {}) {
  return { content: [{ type: "text", text: JSON.stringify(body) }], stop_reason: "end_turn", stop_details: null, ...overrides };
}

describe("tokenize", () => {
  it("lowercases, strips punctuation, and drops stopwords", () => {
    const tokens = tokenize("The Pool was exhausted, and it crashed!");
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("and")).toBe(false);
    expect(tokens.has("pool")).toBe(true);
    expect(tokens.has("exhausted")).toBe(true);
    expect(tokens.has("crashed")).toBe(true);
  });
});

describe("jaccardSimilarity", () => {
  it("is 1 for identical token sets", () => {
    const a = new Set(["pool", "exhausted"]);
    expect(jaccardSimilarity(a, new Set(a))).toBe(1);
  });

  it("is 0 for disjoint sets", () => {
    expect(jaccardSimilarity(new Set(["pool"]), new Set(["database"]))).toBe(0);
  });

  it("is 0 for two empty sets", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });
});

describe("groupExperiences", () => {
  it("partitions by domain before grouping by similarity", () => {
    const rows: ExperienceWithOutcome[] = [
      { ...EXPERIENCE_WITH_OUTCOME, id: "e1", domain: "ops" },
      { ...EXPERIENCE_WITH_OUTCOME, id: "e2", domain: "billing" },
    ];
    const groups = groupExperiences(rows);
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((group) => group.domain))).toEqual(new Set(["ops", "billing"]));
  });

  it("groups similar-content experiences together within a domain", () => {
    const rows: ExperienceWithOutcome[] = [
      { ...EXPERIENCE_WITH_OUTCOME, id: "e1", content: "Connection pool exhausted under load, restarted the service." },
      { ...EXPERIENCE_WITH_OUTCOME, id: "e2", content: "Connection pool exhausted again under load, restarted the service." },
    ];
    const groups = groupExperiences(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.experienceIds).toEqual(["e1", "e2"]);
  });

  it("splits dissimilar experiences into separate groups within the same domain", () => {
    const rows: ExperienceWithOutcome[] = [
      { ...EXPERIENCE_WITH_OUTCOME, id: "e1", content: "Connection pool exhausted under load." },
      { ...EXPERIENCE_WITH_OUTCOME, id: "e2", content: "Billing invoice failed to generate for a customer." },
    ];
    const groups = groupExperiences(rows);
    expect(groups).toHaveLength(2);
  });

  it("assigns sequential groupIndex values across all groups", () => {
    const rows: ExperienceWithOutcome[] = [
      { ...EXPERIENCE_WITH_OUTCOME, id: "e1", domain: "ops", content: "Alpha situation entirely." },
      { ...EXPERIENCE_WITH_OUTCOME, id: "e2", domain: "billing", content: "Beta situation entirely." },
    ];
    const groups = groupExperiences(rows);
    expect(groups.map((group) => group.groupIndex)).toEqual([0, 1]);
  });

  it("caps a single group at the max group size", () => {
    const rows: ExperienceWithOutcome[] = Array.from({ length: 15 }, (_, i) => ({
      ...EXPERIENCE_WITH_OUTCOME,
      id: `e${i}`,
      content: "Connection pool exhausted under load, restarted the service.",
    }));
    const groups = groupExperiences(rows);
    expect(groups.every((group) => group.experienceIds.length <= 10)).toBe(true);
    expect(groups.reduce((sum, group) => sum + group.experienceIds.length, 0)).toBe(15);
  });
});

describe("buildGroupPrompt", () => {
  const NEARBY: KnowledgeMatch = {
    id: KID,
    orgId: ORG_ID,
    domain: "ops",
    statement: "Restart the pool before scaling replicas.",
    confidence: 0.6,
    reinforcementCount: 2,
    lastReinforcedAt: new Date("2026-08-01T00:00:00Z"),
    createdAt: new Date("2026-08-01T00:00:00Z"),
    similarity: 0.8,
  };

  it("labels experiences and nearby knowledge with bracketed ids, domain-neutral throughout", () => {
    const { system, user } = buildGroupPrompt([EXPERIENCE_WITH_OUTCOME], [NEARBY]);
    expect(user).toContain(`[experience:${EXP_ID}]`);
    expect(user).toContain(`[knowledge:${KID}]`);
    expect(system.toLowerCase()).not.toContain("incident");
    expect(user.toLowerCase()).not.toContain("incident");
  });

  it("shows '(none found)' when there is no nearby knowledge", () => {
    const { user } = buildGroupPrompt([EXPERIENCE_WITH_OUTCOME], []);
    expect(user).toContain("(none found)");
  });
});

describe("validateReflectionProposal", () => {
  const GROUP_IDS = ["e1", "e2"];
  const KNOWLEDGE_IDS = ["k1"];

  it("accepts a well-formed create proposal", () => {
    const proposal = validateReflectionProposal(
      { action: "create", statement: "Restart the pool.", confidence: 0.7, citedExperienceIds: ["e1"] },
      GROUP_IDS,
      KNOWLEDGE_IDS,
    );
    expect(proposal.action).toBe("create");
    expect(proposal.statement).toBe("Restart the pool.");
    expect(proposal.citedExperienceIds).toEqual(["e1"]);
  });

  it("accepts a well-formed reinforce proposal", () => {
    const proposal = validateReflectionProposal(
      { action: "reinforce", targetKnowledgeId: "k1", confidence: 0.8, citedExperienceIds: ["e2"] },
      GROUP_IDS,
      KNOWLEDGE_IDS,
    );
    expect(proposal.targetKnowledgeId).toBe("k1");
  });

  it("accepts a well-formed skip proposal with no citations", () => {
    const proposal = validateReflectionProposal({ action: "skip", confidence: 0.1, citedExperienceIds: [] }, GROUP_IDS, KNOWLEDGE_IDS);
    expect(proposal.action).toBe("skip");
  });

  it("rejects an invalid action", () => {
    expect(() =>
      validateReflectionProposal({ action: "delete", confidence: 0.5, citedExperienceIds: [] }, GROUP_IDS, KNOWLEDGE_IDS),
    ).toThrow(/action must be/);
  });

  it("rejects confidence out of range", () => {
    expect(() =>
      validateReflectionProposal({ action: "skip", confidence: 1.5, citedExperienceIds: [] }, GROUP_IDS, KNOWLEDGE_IDS),
    ).toThrow(/confidence must be a number between 0 and 1/);
  });

  it("rejects create with no citations", () => {
    expect(() =>
      validateReflectionProposal({ action: "create", statement: "x", confidence: 0.5, citedExperienceIds: [] }, GROUP_IDS, KNOWLEDGE_IDS),
    ).toThrow(/citedExperienceIds must be non-empty/);
  });

  it("rejects a citation from outside the group", () => {
    expect(() =>
      validateReflectionProposal(
        { action: "create", statement: "x", confidence: 0.5, citedExperienceIds: ["e-not-in-group"] },
        GROUP_IDS,
        KNOWLEDGE_IDS,
      ),
    ).toThrow(/citedExperienceIds references an id outside this group: e-not-in-group/);
  });

  it("rejects create with no statement", () => {
    expect(() =>
      validateReflectionProposal({ action: "create", confidence: 0.5, citedExperienceIds: ["e1"] }, GROUP_IDS, KNOWLEDGE_IDS),
    ).toThrow(/statement is required/);
  });

  it("rejects reinforce with no targetKnowledgeId", () => {
    expect(() =>
      validateReflectionProposal({ action: "reinforce", confidence: 0.5, citedExperienceIds: ["e1"] }, GROUP_IDS, KNOWLEDGE_IDS),
    ).toThrow(/targetKnowledgeId is required/);
  });

  it("rejects a targetKnowledgeId that wasn't shown", () => {
    expect(() =>
      validateReflectionProposal(
        { action: "reinforce", targetKnowledgeId: "k-hallucinated", confidence: 0.5, citedExperienceIds: ["e1"] },
        GROUP_IDS,
        KNOWLEDGE_IDS,
      ),
    ).toThrow(/targetKnowledgeId references an id that was not shown: k-hallucinated/);
  });

  it("tolerates a bracket-label-prefixed citation and normalizes it to the bare id", () => {
    const proposal = validateReflectionProposal(
      { action: "reinforce", targetKnowledgeId: "knowledge:k1", confidence: 0.5, citedExperienceIds: ["experience:e1"] },
      GROUP_IDS,
      KNOWLEDGE_IDS,
    );
    expect(proposal.citedExperienceIds).toEqual(["e1"]);
    expect(proposal.targetKnowledgeId).toBe("k1");
  });

  it("throws ReflectionProposalValidationError specifically", () => {
    expect(() => validateReflectionProposal({}, GROUP_IDS, KNOWLEDGE_IDS)).toThrow(ReflectionProposalValidationError);
  });
});

describe("runReflection", () => {
  beforeEach(() => {
    findActiveReflectionStateMock.mockReset();
    getLastCompletedWatermarkMock.mockReset();
    claimReflectionRunMock.mockReset();
    resumeReflectionRunMock.mockReset();
    checkpointGroupMock.mockReset().mockResolvedValue(undefined);
    completeReflectionRunMock.mockReset().mockResolvedValue(undefined);
    failReflectionRunMock.mockReset().mockResolvedValue(undefined);
    recordAuditEntryMock.mockReset().mockResolvedValue({});
    createKnowledgeMock.mockReset();
    reinforceKnowledgeMock.mockReset();
    addEvidenceMock.mockReset().mockResolvedValue({ added: true });
    embedTextMock.mockReset().mockResolvedValue(new Array(1024).fill(0.01));
    queryKnowledgeBySimilarityMock.mockReset().mockResolvedValue([]);
  });

  it("rejects a missing or malformed orgId before touching agent_state or the database", async () => {
    const pool = { query: vi.fn() } as unknown as Pool;

    await expect(runReflection(pool, {}, { orgId: "not-a-uuid" })).rejects.toThrow(ReflectionValidationError);
    expect(findActiveReflectionStateMock).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("returns completed with zero counts when there are no unreflected experiences", async () => {
    findActiveReflectionStateMock.mockResolvedValue(null);
    getLastCompletedWatermarkMock.mockResolvedValue(null);
    const pool = { query: makePoolQueryRouter({ unreflected: [] }) } as unknown as Pool;

    const result = await runReflection(pool, {}, { orgId: ORG_ID });

    expect(result).toEqual({ status: "completed", orgId: ORG_ID, groupsProcessed: 0, groupsApplied: 0, groupsRejected: 0, groupsSkipped: 0 });
    expect(claimReflectionRunMock).not.toHaveBeenCalled();
  });

  it("returns skipped_concurrent_run when the compare-and-swap claim fails", async () => {
    const activeState = makeState({
      runId: "r1",
      watermarkBefore: "x",
      watermarkAfter: { createdAt: "x", id: "y" },
      groups: [],
    });
    findActiveReflectionStateMock.mockResolvedValue(activeState);
    resumeReflectionRunMock.mockResolvedValue(null);
    const pool = { query: vi.fn() } as unknown as Pool;

    const result = await runReflection(pool, {}, { orgId: ORG_ID });

    expect(result).toEqual({ status: "skipped_concurrent_run", orgId: ORG_ID });
    expect(claimReflectionRunMock).not.toHaveBeenCalled();
  });

  it("processes a single group end-to-end for a create proposal", async () => {
    findActiveReflectionStateMock.mockResolvedValue(null);
    getLastCompletedWatermarkMock.mockResolvedValue(null);
    const row = makeExpDbRow();
    const pool = { query: makePoolQueryRouter({ unreflected: [row], byIds: [row] }) } as unknown as Pool;
    const payload: ReflectionRunPayload = {
      runId: "run-1",
      watermarkBefore: "1970-01-01T00:00:00.000Z",
      watermarkAfter: { createdAt: (row.created_at as Date).toISOString(), id: EXP_ID },
      groups: [{ groupIndex: 0, experienceIds: [EXP_ID], domain: "ops", status: "pending" }],
    };
    claimReflectionRunMock.mockResolvedValue(makeState(payload));

    const rawProposal = { action: "create", statement: "Restart the pool to clear a connection leak.", confidence: 0.75, citedExperienceIds: [EXP_ID] };
    const createMock = vi.fn().mockResolvedValue(textResponse(rawProposal));
    createKnowledgeMock.mockResolvedValue({
      id: KID,
      orgId: ORG_ID,
      domain: "ops",
      statement: rawProposal.statement,
      confidence: 0.75,
      reinforcementCount: 1,
      lastReinforcedAt: new Date(),
      createdAt: new Date(),
    });

    const result = await runReflection(pool, { anthropicClient: { messages: { create: createMock } } }, { orgId: ORG_ID });

    expect(result.status).toBe("completed");
    expect(result.groupsApplied).toBe(1);
    expect(createKnowledgeMock).toHaveBeenCalledWith(
      pool,
      { orgId: ORG_ID, domain: "ops", statement: rawProposal.statement, initialConfidence: 0.75 },
      expect.anything(),
    );
    expect(addEvidenceMock).toHaveBeenCalledWith(pool, { orgId: ORG_ID, knowledgeId: KID, experienceId: EXP_ID }, expect.anything());
    expect(recordAuditEntryMock).toHaveBeenCalledWith(
      pool,
      ORG_ID,
      "reflection.proposal_applied",
      expect.objectContaining({ knowledgeId: KID }),
      expect.anything(),
    );
    expect(checkpointGroupMock).toHaveBeenCalledTimes(5); // proposal cached, applyAttempt marker, knowledgeId set, audit recorded, group completed
    expect(completeReflectionRunMock).toHaveBeenCalledTimes(1);
    expect(failReflectionRunMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid proposal, records the rejection, and still completes the run", async () => {
    findActiveReflectionStateMock.mockResolvedValue(null);
    getLastCompletedWatermarkMock.mockResolvedValue(null);
    const row = makeExpDbRow();
    const pool = { query: makePoolQueryRouter({ unreflected: [row], byIds: [row] }) } as unknown as Pool;
    const payload: ReflectionRunPayload = {
      runId: "run-1",
      watermarkBefore: "x",
      watermarkAfter: { createdAt: (row.created_at as Date).toISOString(), id: EXP_ID },
      groups: [{ groupIndex: 0, experienceIds: [EXP_ID], domain: "ops", status: "pending" }],
    };
    claimReflectionRunMock.mockResolvedValue(makeState(payload));
    // action "create" but missing the required `statement` field
    const createMock = vi.fn().mockResolvedValue(textResponse({ action: "create", confidence: 0.7, citedExperienceIds: [EXP_ID] }));

    const result = await runReflection(pool, { anthropicClient: { messages: { create: createMock } } }, { orgId: ORG_ID });

    expect(result.status).toBe("completed");
    expect(result.groupsRejected).toBe(1);
    expect(createKnowledgeMock).not.toHaveBeenCalled();
    expect(recordAuditEntryMock).toHaveBeenCalledWith(
      pool,
      ORG_ID,
      "reflection.proposal_rejected",
      expect.objectContaining({ groupIndex: 0 }),
      expect.anything(),
    );
    expect(failReflectionRunMock).not.toHaveBeenCalled();
  });

  it("aborts the run on a transient Anthropic failure without marking the group terminal", async () => {
    findActiveReflectionStateMock.mockResolvedValue(null);
    getLastCompletedWatermarkMock.mockResolvedValue(null);
    const row = makeExpDbRow();
    const pool = { query: makePoolQueryRouter({ unreflected: [row], byIds: [row] }) } as unknown as Pool;
    const payload: ReflectionRunPayload = {
      runId: "run-1",
      watermarkBefore: "x",
      watermarkAfter: { createdAt: (row.created_at as Date).toISOString(), id: EXP_ID },
      groups: [{ groupIndex: 0, experienceIds: [EXP_ID], domain: "ops", status: "pending" }],
    };
    claimReflectionRunMock.mockResolvedValue(makeState(payload));
    const createMock = vi.fn().mockRejectedValue(new Error("rate limited"));

    await expect(runReflection(pool, { anthropicClient: { messages: { create: createMock } } }, { orgId: ORG_ID })).rejects.toThrow();

    expect(failReflectionRunMock).toHaveBeenCalledWith(pool, STATE_ID, ORG_ID, expect.anything());
    expect(completeReflectionRunMock).not.toHaveBeenCalled();
    expect(recordAuditEntryMock).not.toHaveBeenCalled();
    expect(payload.groups[0]!.status).toBe("pending");
  });

  it("resumes a crashed run using the frozen plan, processing only pending groups", async () => {
    const rowB = makeExpDbRow({ id: EXP_ID_2, content: "Billing invoice failed to generate for a customer." });
    const pool = { query: makePoolQueryRouter({ byIds: [rowB] }) } as unknown as Pool;
    const payload: ReflectionRunPayload = {
      runId: "run-1",
      watermarkBefore: "x",
      watermarkAfter: { createdAt: (rowB.created_at as Date).toISOString(), id: EXP_ID_2 },
      groups: [
        { groupIndex: 0, experienceIds: [EXP_ID], domain: "ops", status: "completed" },
        { groupIndex: 1, experienceIds: [EXP_ID_2], domain: "billing", status: "pending" },
      ],
    };
    findActiveReflectionStateMock.mockResolvedValue(makeState(payload, { status: "failed" }));
    resumeReflectionRunMock.mockResolvedValue(makeState(payload));
    const createMock = vi.fn().mockResolvedValue(textResponse({ action: "skip", confidence: 0.2, citedExperienceIds: [] }));

    const result = await runReflection(pool, { anthropicClient: { messages: { create: createMock } } }, { orgId: ORG_ID });

    expect(getLastCompletedWatermarkMock).not.toHaveBeenCalled();
    expect(claimReflectionRunMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1); // only the pending group gets a Claude call
    expect(result.groupsSkipped).toBe(1);
    expect(payload.groups[0]!.status).toBe("completed"); // untouched
  });

  it("processes a reinforce proposal via reinforceKnowledge + addEvidence", async () => {
    findActiveReflectionStateMock.mockResolvedValue(null);
    getLastCompletedWatermarkMock.mockResolvedValue(null);
    const row = makeExpDbRow();
    const pool = {
      query: makePoolQueryRouter({ unreflected: [row], byIds: [row], knowledgeSnapshot: [{ confidence: 0.5, reinforcement_count: 1 }] }),
    } as unknown as Pool;
    const payload: ReflectionRunPayload = {
      runId: "run-1",
      watermarkBefore: "x",
      watermarkAfter: { createdAt: (row.created_at as Date).toISOString(), id: EXP_ID },
      groups: [{ groupIndex: 0, experienceIds: [EXP_ID], domain: "ops", status: "pending" }],
    };
    claimReflectionRunMock.mockResolvedValue(makeState(payload));
    queryKnowledgeBySimilarityMock.mockResolvedValue([
      { id: KID, orgId: ORG_ID, domain: "ops", statement: "Restart the pool.", confidence: 0.5, reinforcementCount: 1, lastReinforcedAt: new Date(), createdAt: new Date(), similarity: 0.9 },
    ]);
    const createMock = vi
      .fn()
      .mockResolvedValue(textResponse({ action: "reinforce", targetKnowledgeId: KID, confidence: 0.8, citedExperienceIds: [EXP_ID] }));
    reinforceKnowledgeMock.mockResolvedValue({
      id: KID,
      orgId: ORG_ID,
      domain: "ops",
      statement: "Restart the pool.",
      confidence: 0.8,
      reinforcementCount: 2,
      lastReinforcedAt: new Date(),
      createdAt: new Date(),
    });

    const result = await runReflection(pool, { anthropicClient: { messages: { create: createMock } } }, { orgId: ORG_ID });

    expect(result.groupsApplied).toBe(1);
    expect(reinforceKnowledgeMock).toHaveBeenCalledWith(pool, { orgId: ORG_ID, knowledgeId: KID, newConfidence: 0.8 }, expect.anything());
    expect(addEvidenceMock).toHaveBeenCalledWith(pool, { orgId: ORG_ID, knowledgeId: KID, experienceId: EXP_ID }, expect.anything());
    expect(checkpointGroupMock).toHaveBeenCalledTimes(4); // proposal cached, reinforceSnapshot marker, audit recorded, group completed
  });

  it("reinforce resume: retries reinforceKnowledge when the pre-call snapshot is unchanged", async () => {
    const row = makeExpDbRow();
    const pool = {
      query: makePoolQueryRouter({ byIds: [row], knowledgeSnapshot: [{ confidence: 0.5, reinforcement_count: 1 }] }),
    } as unknown as Pool;
    const payload: ReflectionRunPayload = {
      runId: "run-1",
      watermarkBefore: "x",
      watermarkAfter: { createdAt: (row.created_at as Date).toISOString(), id: EXP_ID },
      groups: [
        {
          groupIndex: 0,
          experienceIds: [EXP_ID],
          domain: "ops",
          status: "pending",
          applyAttempt: { action: "reinforce", reinforceSnapshot: { confidenceBefore: 0.5, reinforcementCountBefore: 1 } },
        },
      ],
    };
    findActiveReflectionStateMock.mockResolvedValue(makeState(payload, { status: "failed" }));
    resumeReflectionRunMock.mockResolvedValue(makeState(payload));
    queryKnowledgeBySimilarityMock.mockResolvedValue([
      { id: KID, orgId: ORG_ID, domain: "ops", statement: "x", confidence: 0.5, reinforcementCount: 1, lastReinforcedAt: new Date(), createdAt: new Date(), similarity: 0.9 },
    ]);
    const createMock = vi
      .fn()
      .mockResolvedValue(textResponse({ action: "reinforce", targetKnowledgeId: KID, confidence: 0.8, citedExperienceIds: [EXP_ID] }));
    reinforceKnowledgeMock.mockResolvedValue({
      id: KID,
      orgId: ORG_ID,
      domain: "ops",
      statement: "x",
      confidence: 0.8,
      reinforcementCount: 2,
      lastReinforcedAt: new Date(),
      createdAt: new Date(),
    });

    await runReflection(pool, { anthropicClient: { messages: { create: createMock } } }, { orgId: ORG_ID });

    expect(reinforceKnowledgeMock).toHaveBeenCalledTimes(1);
  });

  it("reinforce resume: skips reinforceKnowledge when the snapshot already moved (write already landed)", async () => {
    const row = makeExpDbRow();
    const pool = {
      query: makePoolQueryRouter({ byIds: [row], knowledgeSnapshot: [{ confidence: 0.8, reinforcement_count: 2 }] }),
    } as unknown as Pool;
    const payload: ReflectionRunPayload = {
      runId: "run-1",
      watermarkBefore: "x",
      watermarkAfter: { createdAt: (row.created_at as Date).toISOString(), id: EXP_ID },
      groups: [
        {
          groupIndex: 0,
          experienceIds: [EXP_ID],
          domain: "ops",
          status: "pending",
          applyAttempt: { action: "reinforce", reinforceSnapshot: { confidenceBefore: 0.5, reinforcementCountBefore: 1 } },
        },
      ],
    };
    findActiveReflectionStateMock.mockResolvedValue(makeState(payload, { status: "failed" }));
    resumeReflectionRunMock.mockResolvedValue(makeState(payload));
    queryKnowledgeBySimilarityMock.mockResolvedValue([
      { id: KID, orgId: ORG_ID, domain: "ops", statement: "x", confidence: 0.8, reinforcementCount: 2, lastReinforcedAt: new Date(), createdAt: new Date(), similarity: 0.9 },
    ]);
    const createMock = vi
      .fn()
      .mockResolvedValue(textResponse({ action: "reinforce", targetKnowledgeId: KID, confidence: 0.8, citedExperienceIds: [EXP_ID] }));

    await runReflection(pool, { anthropicClient: { messages: { create: createMock } } }, { orgId: ORG_ID });

    expect(reinforceKnowledgeMock).not.toHaveBeenCalled();
    expect(addEvidenceMock).toHaveBeenCalledWith(pool, { orgId: ORG_ID, knowledgeId: KID, experienceId: EXP_ID }, expect.anything());
  });

  it("create resume: reuses the checkpointed knowledgeId rather than calling createKnowledge again", async () => {
    const row = makeExpDbRow();
    const pool = { query: makePoolQueryRouter({ byIds: [row] }) } as unknown as Pool;
    const payload: ReflectionRunPayload = {
      runId: "run-1",
      watermarkBefore: "x",
      watermarkAfter: { createdAt: (row.created_at as Date).toISOString(), id: EXP_ID },
      groups: [{ groupIndex: 0, experienceIds: [EXP_ID], domain: "ops", status: "pending", applyAttempt: { action: "create", knowledgeId: KID } }],
    };
    findActiveReflectionStateMock.mockResolvedValue(makeState(payload, { status: "failed" }));
    resumeReflectionRunMock.mockResolvedValue(makeState(payload));
    const createMock = vi
      .fn()
      .mockResolvedValue(textResponse({ action: "create", statement: "Some durable statement.", confidence: 0.7, citedExperienceIds: [EXP_ID] }));

    await runReflection(pool, { anthropicClient: { messages: { create: createMock } } }, { orgId: ORG_ID });

    expect(createKnowledgeMock).not.toHaveBeenCalled();
    expect(addEvidenceMock).toHaveBeenCalledWith(pool, { orgId: ORG_ID, knowledgeId: KID, experienceId: EXP_ID }, expect.anything());
  });

  it("create resume: does not re-record the audit entry when auditRecorded is already checkpointed true", async () => {
    const row = makeExpDbRow();
    const pool = { query: makePoolQueryRouter({ byIds: [row] }) } as unknown as Pool;
    const payload: ReflectionRunPayload = {
      runId: "run-1",
      watermarkBefore: "x",
      watermarkAfter: { createdAt: (row.created_at as Date).toISOString(), id: EXP_ID },
      // Simulates a crash after recordAuditEntry committed but before the group was marked
      // "completed" — the checkpoint already recorded auditRecorded: true.
      groups: [{ groupIndex: 0, experienceIds: [EXP_ID], domain: "ops", status: "pending", applyAttempt: { action: "create", knowledgeId: KID, auditRecorded: true } }],
    };
    findActiveReflectionStateMock.mockResolvedValue(makeState(payload, { status: "failed" }));
    resumeReflectionRunMock.mockResolvedValue(makeState(payload));
    const createMock = vi
      .fn()
      .mockResolvedValue(textResponse({ action: "create", statement: "Some durable statement.", confidence: 0.7, citedExperienceIds: [EXP_ID] }));

    const result = await runReflection(pool, { anthropicClient: { messages: { create: createMock } } }, { orgId: ORG_ID });

    expect(recordAuditEntryMock).not.toHaveBeenCalled();
    expect(addEvidenceMock).toHaveBeenCalledWith(pool, { orgId: ORG_ID, knowledgeId: KID, experienceId: EXP_ID }, expect.anything());
    expect(result.groupsApplied).toBe(1);
  });

  it("resume: replays the cached proposal instead of asking Claude again", async () => {
    // Simulates a crash right after the proposal was validated and checkpointed, before any
    // apply attempt began — group.proposal is set, group.applyAttempt is not.
    const payload: ReflectionRunPayload = {
      runId: "run-1",
      watermarkBefore: "x",
      watermarkAfter: { createdAt: "2026-08-01T00:00:00.000Z", id: EXP_ID },
      groups: [
        {
          groupIndex: 0,
          experienceIds: [EXP_ID],
          domain: "ops",
          status: "pending",
          proposal: { action: "create", statement: "Cached statement from before the crash.", confidence: 0.7, citedExperienceIds: [EXP_ID] },
        },
      ],
    };
    findActiveReflectionStateMock.mockResolvedValue(makeState(payload, { status: "failed" }));
    resumeReflectionRunMock.mockResolvedValue(makeState(payload));
    const pool = { query: vi.fn() } as unknown as Pool; // no experience/knowledge queries should run at all
    const createMock = vi.fn();
    createKnowledgeMock.mockResolvedValue({
      id: KID,
      orgId: ORG_ID,
      domain: "ops",
      statement: "Cached statement from before the crash.",
      confidence: 0.7,
      reinforcementCount: 1,
      lastReinforcedAt: new Date(),
      createdAt: new Date(),
    });

    const result = await runReflection(pool, { anthropicClient: { messages: { create: createMock } } }, { orgId: ORG_ID });

    expect(createMock).not.toHaveBeenCalled();
    expect(embedTextMock).not.toHaveBeenCalled();
    expect(createKnowledgeMock).toHaveBeenCalledWith(
      pool,
      { orgId: ORG_ID, domain: "ops", statement: "Cached statement from before the crash.", initialConfidence: 0.7 },
      expect.anything(),
    );
    expect(result.groupsApplied).toBe(1);
  });

  it("resume: replays a cached proposal even when a prior partial apply already committed a write, instead of re-sampling a possibly different action", async () => {
    // The exact failure mode code-reviewer found: without caching, a resumed run could re-ask
    // Claude, get "skip" this time, and silently orphan the already-created knowledge row with
    // no audit trail pointing to it. With the proposal cached, resume must replay "create" and
    // finish applying it — Claude must not be consulted again for this group at all.
    const payload: ReflectionRunPayload = {
      runId: "run-1",
      watermarkBefore: "x",
      watermarkAfter: { createdAt: "2026-08-01T00:00:00.000Z", id: EXP_ID },
      groups: [
        {
          groupIndex: 0,
          experienceIds: [EXP_ID],
          domain: "ops",
          status: "pending",
          proposal: { action: "create", statement: "Cached statement.", confidence: 0.7, citedExperienceIds: [EXP_ID] },
          applyAttempt: { action: "create", knowledgeId: KID },
        },
      ],
    };
    findActiveReflectionStateMock.mockResolvedValue(makeState(payload, { status: "failed" }));
    resumeReflectionRunMock.mockResolvedValue(makeState(payload));
    const pool = { query: vi.fn() } as unknown as Pool;
    const createMock = vi.fn();

    const result = await runReflection(pool, { anthropicClient: { messages: { create: createMock } } }, { orgId: ORG_ID });

    expect(createMock).not.toHaveBeenCalled();
    expect(createKnowledgeMock).not.toHaveBeenCalled(); // the write already committed — reused, not repeated
    expect(addEvidenceMock).toHaveBeenCalledWith(pool, { orgId: ORG_ID, knowledgeId: KID, experienceId: EXP_ID }, expect.anything());
    expect(recordAuditEntryMock).toHaveBeenCalledWith(
      pool,
      ORG_ID,
      "reflection.proposal_applied",
      expect.objectContaining({ knowledgeId: KID }),
      expect.anything(),
    );
    expect(result.groupsApplied).toBe(1); // never silently downgraded to skipped/rejected
  });

  it("does not reuse a stale applyAttempt whose action no longer matches the freshly-fetched proposal", async () => {
    const row = makeExpDbRow();
    const pool = {
      query: makePoolQueryRouter({ byIds: [row], knowledgeSnapshot: [{ confidence: 0.5, reinforcement_count: 1 }] }),
    } as unknown as Pool;
    const payload: ReflectionRunPayload = {
      runId: "run-1",
      watermarkBefore: "x",
      watermarkAfter: { createdAt: (row.created_at as Date).toISOString(), id: EXP_ID },
      // Stale checkpoint from a prior attempt that proposed "create" and got as far as recording
      // a knowledgeId — this run's resumed Claude call proposes "reinforce" instead.
      groups: [
        { groupIndex: 0, experienceIds: [EXP_ID], domain: "ops", status: "pending", applyAttempt: { action: "create", knowledgeId: "stale-knowledge-id" } },
      ],
    };
    findActiveReflectionStateMock.mockResolvedValue(makeState(payload, { status: "failed" }));
    resumeReflectionRunMock.mockResolvedValue(makeState(payload));
    queryKnowledgeBySimilarityMock.mockResolvedValue([
      { id: KID, orgId: ORG_ID, domain: "ops", statement: "x", confidence: 0.5, reinforcementCount: 1, lastReinforcedAt: new Date(), createdAt: new Date(), similarity: 0.9 },
    ]);
    const createMock = vi
      .fn()
      .mockResolvedValue(textResponse({ action: "reinforce", targetKnowledgeId: KID, confidence: 0.8, citedExperienceIds: [EXP_ID] }));
    reinforceKnowledgeMock.mockResolvedValue({
      id: KID,
      orgId: ORG_ID,
      domain: "ops",
      statement: "x",
      confidence: 0.8,
      reinforcementCount: 2,
      lastReinforcedAt: new Date(),
      createdAt: new Date(),
    });

    await runReflection(pool, { anthropicClient: { messages: { create: createMock } } }, { orgId: ORG_ID });

    expect(reinforceKnowledgeMock).toHaveBeenCalledWith(pool, { orgId: ORG_ID, knowledgeId: KID, newConfidence: 0.8 }, expect.anything());
    expect(addEvidenceMock).toHaveBeenCalledWith(pool, { orgId: ORG_ID, knowledgeId: KID, experienceId: EXP_ID }, expect.anything());
    expect(addEvidenceMock).not.toHaveBeenCalledWith(pool, expect.objectContaining({ knowledgeId: "stale-knowledge-id" }), expect.anything());
  });

  it("continues without nearby-knowledge context when embedding is unavailable", async () => {
    findActiveReflectionStateMock.mockResolvedValue(null);
    getLastCompletedWatermarkMock.mockResolvedValue(null);
    const row = makeExpDbRow();
    const pool = { query: makePoolQueryRouter({ unreflected: [row], byIds: [row] }) } as unknown as Pool;
    const payload: ReflectionRunPayload = {
      runId: "run-1",
      watermarkBefore: "x",
      watermarkAfter: { createdAt: (row.created_at as Date).toISOString(), id: EXP_ID },
      groups: [{ groupIndex: 0, experienceIds: [EXP_ID], domain: "ops", status: "pending" }],
    };
    claimReflectionRunMock.mockResolvedValue(makeState(payload));
    embedTextMock.mockReset().mockRejectedValue(new EmbeddingError("Voyage unavailable"));
    const createMock = vi
      .fn()
      .mockResolvedValue(textResponse({ action: "create", statement: "Some durable statement.", confidence: 0.7, citedExperienceIds: [EXP_ID] }));
    createKnowledgeMock.mockResolvedValue({
      id: KID,
      orgId: ORG_ID,
      domain: "ops",
      statement: "x",
      confidence: 0.7,
      reinforcementCount: 1,
      lastReinforcedAt: new Date(),
      createdAt: new Date(),
    });

    const result = await runReflection(pool, { anthropicClient: { messages: { create: createMock } } }, { orgId: ORG_ID });

    expect(result.groupsApplied).toBe(1);
    expect(queryKnowledgeBySimilarityMock).not.toHaveBeenCalled();
    const requestArgs = createMock.mock.calls[0]![0] as { messages: Array<{ content: string }> };
    expect(requestArgs.messages[0]!.content).toContain("(none found)");
  });
});
