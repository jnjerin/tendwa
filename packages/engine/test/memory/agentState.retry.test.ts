import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { MAX_SERIALIZATION_RETRIES, checkpointGroup, claimReflectionRun } from "../../src/memory/agentState.js";
import type { ReflectionRunPayload } from "../../src/memory/agentState.js";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const STATE_ID = "22222222-2222-2222-2222-222222222222";

const PAYLOAD: ReflectionRunPayload = {
  runId: "33333333-3333-3333-3333-333333333333",
  watermarkBefore: "1970-01-01T00:00:00.000Z",
  watermarkAfter: { createdAt: "2026-08-18T00:00:00.000Z", id: "44444444-4444-4444-4444-444444444444" },
  groups: [],
};

const ROW = {
  id: STATE_ID,
  org_id: ORG_ID,
  status: "running",
  step: "reflection",
  payload: PAYLOAD,
  updated_at: new Date("2026-08-18T00:00:00.000Z"),
};

function makeError(message: string, code?: string): Error & { code?: string } {
  const err: Error & { code?: string } = new Error(message);
  if (code) err.code = code;
  return err;
}

function createMockPool(runQuery: (attempt: number) => "ok" | (Error & { code?: string }), row: Record<string, unknown> = ROW) {
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

describe("claimReflectionRun — 40001 serialization conflict retry", () => {
  it("retries a 40001 conflict with exponential backoff and succeeds once it clears", async () => {
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const { pool, query } = createMockPool((attempt) => (attempt < 3 ? makeError("restart transaction", "40001") : "ok"));

    const result = await claimReflectionRun(pool, ORG_ID, PAYLOAD);

    expect(result.id).toBe(STATE_ID);
    expect(query).toHaveBeenCalledTimes(3);
    const delaysMs = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(delaysMs).toEqual([100, 200]);
    setTimeoutSpy.mockRestore();
  });

  it(`gives up after ${MAX_SERIALIZATION_RETRIES} attempts of a persistent 40001 conflict`, async () => {
    const { pool, query } = createMockPool(() => makeError("restart transaction", "40001"));

    await expect(claimReflectionRun(pool, ORG_ID, PAYLOAD)).rejects.toMatchObject({ code: "40001" });
    expect(query).toHaveBeenCalledTimes(MAX_SERIALIZATION_RETRIES);
  });

  it("does not retry a non-40001 error — fails immediately on the first attempt", async () => {
    const { pool, query } = createMockPool(() => makeError("connection terminated"));

    await expect(claimReflectionRun(pool, ORG_ID, PAYLOAD)).rejects.toThrow("connection terminated");
    expect(query).toHaveBeenCalledTimes(1);
  });
});

// checkpointGroup/resumeReflectionRun/completeReflectionRun/failReflectionRun share the same
// withSerializationRetry helper already exhaustively covered above — one lighter confirmation
// that it's actually wired up is enough, matching knowledge.retry.test.ts's precedent for
// addEvidence/decayKnowledgeConfidence.
describe("checkpointGroup — 40001 serialization conflict retry", () => {
  it("retries a 40001 conflict and succeeds once it clears", async () => {
    const { pool, query } = createMockPool((attempt) => (attempt < 2 ? makeError("restart transaction", "40001") : "ok"));

    await checkpointGroup(pool, STATE_ID, ORG_ID, PAYLOAD);

    expect(query).toHaveBeenCalledTimes(2);
  });
});
