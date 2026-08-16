import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingError } from "../../src/memory/embeddings.js";

const embedTextMock = vi.fn();
vi.mock("../../src/memory/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/memory/embeddings.js")>();
  return { ...actual, embedText: (...args: unknown[]) => embedTextMock(...args) };
});

const {
  RetrievalValidationError,
  mapExperienceRow,
  mapKnowledgeRow,
  retrieveMemory,
  toVectorLiteral,
  validateRetrieveMemoryInput,
} = await import("../../src/memory/retrieve.js");

const VALID_INPUT = {
  orgId: "11111111-1111-1111-1111-111111111111",
  query: "database connection pool exhausted",
};

describe("validateRetrieveMemoryInput", () => {
  it("defaults limit to 10 when not provided", () => {
    expect(validateRetrieveMemoryInput(VALID_INPUT)).toEqual({ limit: 10 });
  });

  it("accepts an explicit limit within bounds", () => {
    expect(validateRetrieveMemoryInput({ ...VALID_INPUT, limit: 25 })).toEqual({ limit: 25 });
  });

  it("rejects a missing orgId", () => {
    expect(() => validateRetrieveMemoryInput({ ...VALID_INPUT, orgId: "" })).toThrow(/orgId is required/);
  });

  it("rejects an orgId that isn't a UUID", () => {
    expect(() => validateRetrieveMemoryInput({ ...VALID_INPUT, orgId: "not-a-uuid" })).toThrow(/orgId must be a UUID/);
  });

  it("rejects a missing query", () => {
    expect(() => validateRetrieveMemoryInput({ ...VALID_INPUT, query: "   " })).toThrow(/query is required/);
  });

  it("rejects an empty-string domain filter", () => {
    expect(() => validateRetrieveMemoryInput({ ...VALID_INPUT, domain: "" })).toThrow(/domain must be a non-empty string/);
  });

  it("rejects a limit of zero or below", () => {
    expect(() => validateRetrieveMemoryInput({ ...VALID_INPUT, limit: 0 })).toThrow(/limit must be an integer/);
  });

  it("rejects a limit above the maximum", () => {
    expect(() => validateRetrieveMemoryInput({ ...VALID_INPUT, limit: 51 })).toThrow(/limit must be an integer/);
  });

  it("rejects a non-integer limit", () => {
    expect(() => validateRetrieveMemoryInput({ ...VALID_INPUT, limit: 2.5 })).toThrow(/limit must be an integer/);
  });

  it("throws RetrievalValidationError specifically", () => {
    expect(() => validateRetrieveMemoryInput({ ...VALID_INPUT, orgId: "" })).toThrow(RetrievalValidationError);
  });
});

describe("toVectorLiteral", () => {
  it("formats a numeric array as a CockroachDB VECTOR literal", () => {
    expect(toVectorLiteral([0.1, -0.2, 1])).toBe("[0.1,-0.2,1]");
  });

  it("formats an empty array", () => {
    expect(toVectorLiteral([])).toBe("[]");
  });
});

describe("row mapping", () => {
  it("maps a knowledge row from snake_case columns to camelCase, including similarity", () => {
    const now = new Date("2026-08-15T10:00:00Z");
    const match = mapKnowledgeRow({
      id: "k1",
      org_id: "org1",
      domain: "incident-response",
      statement: "Restart the pool before scaling replicas.",
      confidence: 0.72,
      reinforcement_count: 3,
      last_reinforced_at: now,
      created_at: now,
      similarity: 0.891,
    });
    expect(match).toEqual({
      id: "k1",
      orgId: "org1",
      domain: "incident-response",
      statement: "Restart the pool before scaling replicas.",
      confidence: 0.72,
      reinforcementCount: 3,
      lastReinforcedAt: now,
      createdAt: now,
      similarity: 0.891,
    });
  });

  it("maps an experience row from snake_case columns to camelCase", () => {
    const now = new Date("2026-08-15T10:00:00Z");
    const match = mapExperienceRow({
      id: "e1",
      org_id: "org1",
      domain: "incident-response",
      content: "Pool exhausted under load.",
      metadata: { severity: "high" },
      occurred_at: now,
      created_at: now,
    });
    expect(match).toEqual({
      id: "e1",
      orgId: "org1",
      domain: "incident-response",
      content: "Pool exhausted under load.",
      metadata: { severity: "high" },
      occurredAt: now,
      createdAt: now,
    });
  });
});

describe("retrieveMemory — graceful degradation when embeddings are unavailable", () => {
  beforeEach(() => {
    embedTextMock.mockReset();
  });

  function createMockPool(experienceRows: unknown[]) {
    const query = vi.fn().mockResolvedValue({ rows: experienceRows });
    return { query } as unknown as Pool;
  }

  it("returns experiences and sets knowledgeUnavailable when embedText throws EmbeddingError", async () => {
    embedTextMock.mockRejectedValue(new EmbeddingError("Voyage API returned 401: invalid key"));
    const pool = createMockPool([
      {
        id: "e1",
        org_id: VALID_INPUT.orgId,
        domain: "incident-response",
        content: "Pool exhausted under load.",
        metadata: null,
        occurred_at: new Date(),
        created_at: new Date(),
      },
    ]);

    const result = await retrieveMemory(pool, VALID_INPUT);

    expect(result.knowledge).toEqual([]);
    expect(result.knowledgeUnavailable).toBe(true);
    expect(result.experiences).toHaveLength(1);
    // Only the experiences query ran — the knowledge query was skipped entirely.
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("propagates a non-EmbeddingError from embedText rather than swallowing it as unavailability", async () => {
    embedTextMock.mockRejectedValue(new Error("unexpected embeddings client bug"));
    const pool = createMockPool([]);

    await expect(retrieveMemory(pool, VALID_INPUT)).rejects.toThrow("unexpected embeddings client bug");
  });

  it("propagates a database error from the experiences query even when embedding succeeds", async () => {
    embedTextMock.mockResolvedValue(new Array(1024).fill(0.01));
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // knowledge query
      .mockRejectedValueOnce(new Error("connection terminated")); // experiences query
    const pool = { query } as unknown as Pool;

    await expect(retrieveMemory(pool, VALID_INPUT)).rejects.toThrow("connection terminated");
  });

  it("rejects invalid input before calling embedText or the database at all", async () => {
    const pool = createMockPool([]);

    await expect(retrieveMemory(pool, { ...VALID_INPUT, orgId: "" })).rejects.toThrow(RetrievalValidationError);
    expect(embedTextMock).not.toHaveBeenCalled();
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
