import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { EmbeddingError } from "../../src/memory/embeddings.js";

const embedTextMock = vi.fn();
vi.mock("../../src/memory/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/memory/embeddings.js")>();
  return { ...actual, embedText: (...args: unknown[]) => embedTextMock(...args) };
});

const {
  KnowledgeNotFoundError,
  KnowledgeValidationError,
  addEvidence,
  calculateDecayedConfidence,
  createKnowledge,
  decayKnowledgeConfidence,
  getKnowledgeById,
  listKnowledge,
  reinforceKnowledge,
  validateAddEvidence,
  validateDecayKnowledgeInput,
  validateListKnowledge,
  validateNewKnowledge,
  validateReinforceKnowledge,
} = await import("../../src/memory/knowledge.js");

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const KNOWLEDGE_ID = "22222222-2222-2222-2222-222222222222";
const EXPERIENCE_ID = "33333333-3333-3333-3333-333333333333";

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: KNOWLEDGE_ID,
    org_id: ORG_ID,
    domain: "ops",
    statement: "Restart the pool before scaling replicas.",
    confidence: 0.5,
    reinforcement_count: 1,
    last_reinforced_at: new Date("2026-08-01T00:00:00Z"),
    created_at: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

describe("validateNewKnowledge", () => {
  const VALID = { orgId: ORG_ID, domain: "ops", statement: "Restart the pool." };

  it("defaults initialConfidence to 0.5", () => {
    expect(validateNewKnowledge(VALID)).toEqual({ domain: "ops", statement: "Restart the pool.", confidence: 0.5 });
  });

  it("trims domain and statement", () => {
    expect(validateNewKnowledge({ ...VALID, domain: "  ops  ", statement: "  Restart.  " })).toEqual({
      domain: "ops",
      statement: "Restart.",
      confidence: 0.5,
    });
  });

  it("accepts an explicit initialConfidence", () => {
    expect(validateNewKnowledge({ ...VALID, initialConfidence: 0.9 })).toEqual({
      domain: "ops",
      statement: "Restart the pool.",
      confidence: 0.9,
    });
  });

  it("rejects a missing orgId", () => {
    expect(() => validateNewKnowledge({ ...VALID, orgId: "" })).toThrow(/orgId is required/);
  });

  it("rejects an orgId that isn't a UUID", () => {
    expect(() => validateNewKnowledge({ ...VALID, orgId: "not-a-uuid" })).toThrow(/orgId must be a UUID/);
  });

  it("rejects a missing domain", () => {
    expect(() => validateNewKnowledge({ ...VALID, domain: "" })).toThrow(/domain is required/);
  });

  it("rejects a missing statement", () => {
    expect(() => validateNewKnowledge({ ...VALID, statement: "" })).toThrow(/statement is required/);
  });

  it("rejects an initialConfidence above 1", () => {
    expect(() => validateNewKnowledge({ ...VALID, initialConfidence: 1.5 })).toThrow(
      /initialConfidence must be a number between 0 and 1/,
    );
  });

  it("rejects an initialConfidence below 0", () => {
    expect(() => validateNewKnowledge({ ...VALID, initialConfidence: -0.1 })).toThrow(
      /initialConfidence must be a number between 0 and 1/,
    );
  });

  it("throws KnowledgeValidationError specifically", () => {
    expect(() => validateNewKnowledge({ ...VALID, orgId: "" })).toThrow(KnowledgeValidationError);
  });
});

describe("validateReinforceKnowledge", () => {
  const VALID = { orgId: ORG_ID, knowledgeId: KNOWLEDGE_ID, newConfidence: 0.8 };

  it("accepts a valid input", () => {
    expect(() => validateReinforceKnowledge(VALID)).not.toThrow();
  });

  it("rejects a missing knowledgeId", () => {
    expect(() => validateReinforceKnowledge({ ...VALID, knowledgeId: "" })).toThrow(/knowledgeId is required/);
  });

  it("rejects a knowledgeId that isn't a UUID", () => {
    expect(() => validateReinforceKnowledge({ ...VALID, knowledgeId: "not-a-uuid" })).toThrow(
      /knowledgeId must be a UUID/,
    );
  });

  it("rejects a newConfidence above 1", () => {
    expect(() => validateReinforceKnowledge({ ...VALID, newConfidence: 1.1 })).toThrow(
      /newConfidence must be a number between 0 and 1/,
    );
  });

  it("rejects a newConfidence below 0", () => {
    expect(() => validateReinforceKnowledge({ ...VALID, newConfidence: -0.1 })).toThrow(
      /newConfidence must be a number between 0 and 1/,
    );
  });
});

describe("validateAddEvidence", () => {
  const VALID = { orgId: ORG_ID, knowledgeId: KNOWLEDGE_ID, experienceId: EXPERIENCE_ID };

  it("accepts a valid input", () => {
    expect(() => validateAddEvidence(VALID)).not.toThrow();
  });

  it("rejects an invalid orgId", () => {
    expect(() => validateAddEvidence({ ...VALID, orgId: "not-a-uuid" })).toThrow(/orgId must be a UUID/);
  });

  it("rejects an invalid knowledgeId", () => {
    expect(() => validateAddEvidence({ ...VALID, knowledgeId: "not-a-uuid" })).toThrow(/knowledgeId must be a UUID/);
  });

  it("rejects an invalid experienceId", () => {
    expect(() => validateAddEvidence({ ...VALID, experienceId: "not-a-uuid" })).toThrow(
      /experienceId must be a UUID/,
    );
  });
});

describe("validateDecayKnowledgeInput", () => {
  it("accepts a valid input", () => {
    expect(() => validateDecayKnowledgeInput({ orgId: ORG_ID, knowledgeId: KNOWLEDGE_ID })).not.toThrow();
  });

  it("rejects an invalid knowledgeId", () => {
    expect(() => validateDecayKnowledgeInput({ orgId: ORG_ID, knowledgeId: "nope" })).toThrow(
      /knowledgeId must be a UUID/,
    );
  });
});

describe("validateListKnowledge", () => {
  it("defaults limit to 20 and leaves domain undefined when omitted", () => {
    expect(validateListKnowledge({ orgId: ORG_ID })).toEqual({ domain: undefined, limit: 20 });
  });

  it("trims domain", () => {
    expect(validateListKnowledge({ orgId: ORG_ID, domain: "  ops  " })).toEqual({ domain: "ops", limit: 20 });
  });

  it("rejects an invalid orgId", () => {
    expect(() => validateListKnowledge({ orgId: "not-a-uuid" })).toThrow(/orgId must be a UUID/);
  });

  it("rejects a limit above 100", () => {
    expect(() => validateListKnowledge({ orgId: ORG_ID, limit: 101 })).toThrow(
      /limit must be an integer between 1 and 100/,
    );
  });

  it("rejects a non-integer limit", () => {
    expect(() => validateListKnowledge({ orgId: ORG_ID, limit: 1.5 })).toThrow(
      /limit must be an integer between 1 and 100/,
    );
  });
});

describe("calculateDecayedConfidence", () => {
  it("returns confidence unchanged within the grace period", () => {
    const lastReinforcedAt = new Date("2026-08-01T00:00:00Z");
    const now = new Date("2026-08-15T00:00:00Z"); // 14 days later, within the 30-day grace period
    expect(calculateDecayedConfidence(0.7, lastReinforcedAt, now)).toBe(0.7);
  });

  it("decays multiplicatively past the grace period", () => {
    const lastReinforcedAt = new Date("2026-08-01T00:00:00Z");
    const now = new Date("2026-09-10T00:00:00Z"); // 40 days later -> 10 days past grace
    const decayed = calculateDecayedConfidence(0.7, lastReinforcedAt, now);
    expect(decayed).toBeCloseTo(0.7 * Math.pow(0.99, 10));
    expect(decayed).toBeLessThan(0.7);
  });

  it("floors at MIN_CONFIDENCE even for a very old lastReinforcedAt", () => {
    const lastReinforcedAt = new Date("2020-01-01T00:00:00Z");
    const now = new Date("2026-08-17T00:00:00Z");
    expect(calculateDecayedConfidence(0.9, lastReinforcedAt, now)).toBeCloseTo(0.05, 5);
  });
});

describe("createKnowledge", () => {
  it("embeds the statement (inputType: document) and creates the row", async () => {
    embedTextMock.mockReset().mockResolvedValue(new Array(1024).fill(0.01));
    const query = vi.fn().mockResolvedValue({ rows: [makeRow()] });
    const pool = { query } as unknown as Pool;

    const knowledge = await createKnowledge(pool, {
      orgId: ORG_ID,
      domain: "ops",
      statement: "Restart the pool before scaling replicas.",
    });

    expect(knowledge.id).toBe(KNOWLEDGE_ID);
    expect(embedTextMock).toHaveBeenCalledWith(
      "Restart the pool before scaling replicas.",
      expect.objectContaining({ inputType: "document" }),
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("propagates EmbeddingError rather than writing a NULL-embedding row", async () => {
    embedTextMock.mockReset().mockRejectedValue(new EmbeddingError("Voyage API unavailable"));
    const query = vi.fn();
    const pool = { query } as unknown as Pool;

    await expect(
      createKnowledge(pool, { orgId: ORG_ID, domain: "ops", statement: "Restart the pool." }),
    ).rejects.toThrow(EmbeddingError);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects invalid input before calling embedText or the database", async () => {
    embedTextMock.mockReset();
    const query = vi.fn();
    const pool = { query } as unknown as Pool;

    await expect(
      createKnowledge(pool, { orgId: "not-a-uuid", domain: "ops", statement: "Restart the pool." }),
    ).rejects.toThrow(KnowledgeValidationError);
    expect(embedTextMock).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});

describe("reinforceKnowledge", () => {
  it("raises confidence and reinforcement_count, and refreshes last_reinforced_at", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [makeRow({ confidence: 0.8, reinforcement_count: 2 })] });
    const pool = { query } as unknown as Pool;

    const knowledge = await reinforceKnowledge(pool, { orgId: ORG_ID, knowledgeId: KNOWLEDGE_ID, newConfidence: 0.8 });

    expect(knowledge.confidence).toBe(0.8);
    expect(knowledge.reinforcementCount).toBe(2);
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([ORG_ID, KNOWLEDGE_ID, 0.8]);
  });

  it("throws KnowledgeNotFoundError when the org-scoped row doesn't exist", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;

    await expect(
      reinforceKnowledge(pool, { orgId: ORG_ID, knowledgeId: KNOWLEDGE_ID, newConfidence: 0.8 }),
    ).rejects.toThrow(KnowledgeNotFoundError);
  });
});

describe("addEvidence", () => {
  const SAME_ORG_OWNERSHIP = { rows: [{ knowledge_org_id: ORG_ID, experience_org_id: ORG_ID }] };

  it("adds a new evidence link", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(SAME_ORG_OWNERSHIP)
      .mockResolvedValueOnce({ rows: [{ knowledge_id: KNOWLEDGE_ID }] });
    const pool = { query } as unknown as Pool;

    const result = await addEvidence(pool, { orgId: ORG_ID, knowledgeId: KNOWLEDGE_ID, experienceId: EXPERIENCE_ID });

    expect(result).toEqual({ added: true });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("returns added: false when the link already existed (ON CONFLICT no-op)", async () => {
    const query = vi.fn().mockResolvedValueOnce(SAME_ORG_OWNERSHIP).mockResolvedValueOnce({ rows: [] });
    const pool = { query } as unknown as Pool;

    const result = await addEvidence(pool, { orgId: ORG_ID, knowledgeId: KNOWLEDGE_ID, experienceId: EXPERIENCE_ID });

    expect(result).toEqual({ added: false });
  });

  it("rejects when knowledgeId and experienceId don't both belong to orgId", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ knowledge_org_id: ORG_ID, experience_org_id: "99999999-9999-9999-9999-999999999999" }] });
    const pool = { query } as unknown as Pool;

    await expect(
      addEvidence(pool, { orgId: ORG_ID, knowledgeId: KNOWLEDGE_ID, experienceId: EXPERIENCE_ID }),
    ).rejects.toThrow(KnowledgeValidationError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects when knowledgeId doesn't exist at all", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ knowledge_org_id: null, experience_org_id: ORG_ID }] });
    const pool = { query } as unknown as Pool;

    await expect(
      addEvidence(pool, { orgId: ORG_ID, knowledgeId: KNOWLEDGE_ID, experienceId: EXPERIENCE_ID }),
    ).rejects.toThrow(KnowledgeValidationError);
  });
});

describe("decayKnowledgeConfidence", () => {
  it("returns the row unchanged and performs no UPDATE when still within the grace period", async () => {
    const recentRow = makeRow({ last_reinforced_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) });
    const query = vi.fn().mockResolvedValue({ rows: [recentRow] });
    const pool = { query } as unknown as Pool;

    const knowledge = await decayKnowledgeConfidence(pool, { orgId: ORG_ID, knowledgeId: KNOWLEDGE_ID });

    expect(knowledge.confidence).toBe(recentRow.confidence);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("applies decay and writes the new confidence when past the grace period", async () => {
    const staleRow = makeRow({ confidence: 0.5, last_reinforced_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) });
    const expectedConfidence = 0.5 * Math.pow(0.99, 30);
    const decayedRow = makeRow({ confidence: expectedConfidence });
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [staleRow] })
      .mockResolvedValueOnce({ rows: [decayedRow] });
    const pool = { query } as unknown as Pool;

    const knowledge = await decayKnowledgeConfidence(pool, { orgId: ORG_ID, knowledgeId: KNOWLEDGE_ID });

    expect(query).toHaveBeenCalledTimes(2);
    expect(knowledge.confidence).toBeCloseTo(expectedConfidence);
  });

  it("throws KnowledgeNotFoundError when the row doesn't exist", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;

    await expect(decayKnowledgeConfidence(pool, { orgId: ORG_ID, knowledgeId: KNOWLEDGE_ID })).rejects.toThrow(
      KnowledgeNotFoundError,
    );
  });
});

describe("listKnowledge", () => {
  it("returns rows mapped to Knowledge, most-recent-first per the ORDER BY", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [makeRow(), makeRow({ id: "44444444-4444-4444-4444-444444444444" })] });
    const pool = { query } as unknown as Pool;

    const items = await listKnowledge(pool, { orgId: ORG_ID });

    expect(items).toHaveLength(2);
    expect(items[0]?.id).toBe(KNOWLEDGE_ID);
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([ORG_ID, null, 20]);
  });

  it("passes a trimmed domain filter through to the query", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;

    await listKnowledge(pool, { orgId: ORG_ID, domain: "  ops  ", limit: 5 });

    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([ORG_ID, "ops", 5]);
  });

  it("rejects invalid input before querying", async () => {
    const query = vi.fn();
    const pool = { query } as unknown as Pool;

    await expect(listKnowledge(pool, { orgId: "not-a-uuid" })).rejects.toThrow(KnowledgeValidationError);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("getKnowledgeById", () => {
  it("returns the mapped row when found", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [makeRow()] });
    const pool = { query } as unknown as Pool;

    const knowledge = await getKnowledgeById(pool, ORG_ID, KNOWLEDGE_ID);

    expect(knowledge.id).toBe(KNOWLEDGE_ID);
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([ORG_ID, KNOWLEDGE_ID]);
  });

  it("throws KnowledgeNotFoundError when the org-scoped row doesn't exist", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;

    await expect(getKnowledgeById(pool, ORG_ID, KNOWLEDGE_ID)).rejects.toThrow(KnowledgeNotFoundError);
  });

  it("rejects an invalid knowledgeId before querying", async () => {
    const query = vi.fn();
    const pool = { query } as unknown as Pool;

    await expect(getKnowledgeById(pool, ORG_ID, "not-a-uuid")).rejects.toThrow(KnowledgeValidationError);
    expect(query).not.toHaveBeenCalled();
  });
});
