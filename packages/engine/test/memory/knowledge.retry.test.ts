import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

const embedTextMock = vi.fn();
vi.mock("../../src/memory/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/memory/embeddings.js")>();
  return { ...actual, embedText: (...args: unknown[]) => embedTextMock(...args) };
});

const { MAX_SERIALIZATION_RETRIES, addEvidence, createKnowledge, decayKnowledgeConfidence, reinforceKnowledge } =
  await import("../../src/memory/knowledge.js");

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const KNOWLEDGE_ID = "22222222-2222-2222-2222-222222222222";
const EXPERIENCE_ID = "33333333-3333-3333-3333-333333333333";

function makeError(message: string, code?: string): Error & { code?: string } {
  const err: Error & { code?: string } = new Error(message);
  if (code) err.code = code;
  return err;
}

const ROW = {
  id: KNOWLEDGE_ID,
  org_id: ORG_ID,
  domain: "ops",
  statement: "Restart the pool before scaling replicas.",
  confidence: 0.5,
  reinforcement_count: 1,
  last_reinforced_at: new Date("2026-08-01T00:00:00Z"),
  created_at: new Date("2026-08-01T00:00:00Z"),
};

function createMockPool(
  runQuery: (attempt: number) => "ok" | (Error & { code?: string }),
  row: Record<string, unknown> = ROW,
) {
  let attempt = 0;
  const query = vi.fn(async () => {
    attempt += 1;
    const outcome = runQuery(attempt);
    if (outcome !== "ok") {
      throw outcome;
    }
    return { rows: [row] };
  });
  const pool = { query } as unknown as Pool;
  return { pool, query };
}

describe("createKnowledge — 40001 serialization conflict retry", () => {
  it("retries a 40001 conflict with exponential backoff and succeeds once it clears", async () => {
    embedTextMock.mockReset().mockResolvedValue(new Array(1024).fill(0.01));
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const { pool, query } = createMockPool((attempt) => (attempt < 3 ? makeError("restart transaction", "40001") : "ok"));

    const result = await createKnowledge(pool, { orgId: ORG_ID, domain: "ops", statement: "Restart the pool." });

    expect(result.id).toBe(ROW.id);
    expect(query).toHaveBeenCalledTimes(3);
    const delaysMs = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(delaysMs).toEqual([100, 200]);
    setTimeoutSpy.mockRestore();
  });

  it(`gives up after ${MAX_SERIALIZATION_RETRIES} attempts of a persistent 40001 conflict`, async () => {
    embedTextMock.mockReset().mockResolvedValue(new Array(1024).fill(0.01));
    const { pool, query } = createMockPool(() => makeError("restart transaction", "40001"));

    await expect(
      createKnowledge(pool, { orgId: ORG_ID, domain: "ops", statement: "Restart the pool." }),
    ).rejects.toMatchObject({ code: "40001" });
    expect(query).toHaveBeenCalledTimes(MAX_SERIALIZATION_RETRIES);
  });

  it("does not retry a non-40001 error — fails immediately on the first attempt", async () => {
    embedTextMock.mockReset().mockResolvedValue(new Array(1024).fill(0.01));
    const { pool, query } = createMockPool(() => makeError("connection terminated"));

    await expect(
      createKnowledge(pool, { orgId: ORG_ID, domain: "ops", statement: "Restart the pool." }),
    ).rejects.toThrow("connection terminated");
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("reinforceKnowledge — 40001 serialization conflict retry", () => {
  const REINFORCE_INPUT = { orgId: ORG_ID, knowledgeId: KNOWLEDGE_ID, newConfidence: 0.8 };
  const REINFORCED_ROW = { ...ROW, confidence: 0.8, reinforcement_count: 2 };

  it("retries a 40001 conflict with exponential backoff and succeeds once it clears", async () => {
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const { pool, query } = createMockPool(
      (attempt) => (attempt < 3 ? makeError("restart transaction", "40001") : "ok"),
      REINFORCED_ROW,
    );

    const result = await reinforceKnowledge(pool, REINFORCE_INPUT);

    expect(result.confidence).toBe(0.8);
    expect(query).toHaveBeenCalledTimes(3);
    const delaysMs = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(delaysMs).toEqual([100, 200]);
    setTimeoutSpy.mockRestore();
  });

  it(`gives up after ${MAX_SERIALIZATION_RETRIES} attempts of a persistent 40001 conflict`, async () => {
    const { pool, query } = createMockPool(() => makeError("restart transaction", "40001"), REINFORCED_ROW);

    await expect(reinforceKnowledge(pool, REINFORCE_INPUT)).rejects.toMatchObject({ code: "40001" });
    expect(query).toHaveBeenCalledTimes(MAX_SERIALIZATION_RETRIES);
  });

  it("does not retry a non-40001 error — fails immediately on the first attempt", async () => {
    const { pool, query } = createMockPool(() => makeError("connection terminated"), REINFORCED_ROW);

    await expect(reinforceKnowledge(pool, REINFORCE_INPUT)).rejects.toThrow("connection terminated");
    expect(query).toHaveBeenCalledTimes(1);
  });
});

// addEvidence and decayKnowledgeConfidence exercise the same shared withSerializationRetry
// helper already exhaustively covered above (backoff schedule, give-up count, no-retry-on-
// other-errors) — one lighter "retries and succeeds" test each is enough to confirm they're
// actually wired to it, without re-deriving all three sub-cases per function.

describe("addEvidence — 40001 serialization conflict retry", () => {
  it("retries a 40001 conflict and succeeds once it clears", async () => {
    // The ownership-check SELECT (added after review) isn't part of the retry loop — only
    // the INSERT that follows it is. attempt 1 here is the first INSERT attempt.
    let ownershipChecked = false;
    let insertAttempt = 0;
    const query = vi.fn(async () => {
      if (!ownershipChecked) {
        ownershipChecked = true;
        return { rows: [{ knowledge_org_id: ORG_ID, experience_org_id: ORG_ID }] };
      }
      insertAttempt += 1;
      if (insertAttempt < 2) {
        throw makeError("restart transaction", "40001");
      }
      return { rows: [{ knowledge_id: KNOWLEDGE_ID }] };
    });
    const pool = { query } as unknown as Pool;

    const result = await addEvidence(pool, { orgId: ORG_ID, knowledgeId: KNOWLEDGE_ID, experienceId: EXPERIENCE_ID });

    expect(result).toEqual({ added: true });
    expect(query).toHaveBeenCalledTimes(3); // 1 ownership check + 2 INSERT attempts
  });
});

describe("decayKnowledgeConfidence — 40001 serialization conflict retry", () => {
  it("retries the UPDATE on a 40001 conflict and succeeds once it clears", async () => {
    const staleRow = { ...ROW, last_reinforced_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) };
    const expectedConfidence = 0.5 * Math.pow(0.99, 30);
    const decayedRow = { ...ROW, confidence: expectedConfidence, last_reinforced_at: staleRow.last_reinforced_at };

    let selectDone = false;
    let updateAttempt = 0;
    const query = vi.fn(async () => {
      if (!selectDone) {
        selectDone = true;
        return { rows: [staleRow] };
      }
      updateAttempt += 1;
      if (updateAttempt < 2) {
        throw makeError("restart transaction", "40001");
      }
      return { rows: [decayedRow] };
    });
    const pool = { query } as unknown as Pool;

    const result = await decayKnowledgeConfidence(pool, { orgId: ORG_ID, knowledgeId: KNOWLEDGE_ID });

    expect(result.confidence).toBeCloseTo(expectedConfidence);
    expect(query).toHaveBeenCalledTimes(3); // 1 SELECT + 2 UPDATE attempts
  });
});
