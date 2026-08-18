import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { MAX_SERIALIZATION_RETRIES, recordAuditEntry } from "../../src/memory/auditLog.js";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ROW = {
  id: "22222222-2222-2222-2222-222222222222",
  org_id: ORG_ID,
  action: "reflection.proposal_applied",
  detail: null,
  created_at: new Date("2026-08-18T00:00:00.000Z"),
};

function makeError(message: string, code?: string): Error & { code?: string } {
  const err: Error & { code?: string } = new Error(message);
  if (code) err.code = code;
  return err;
}

function createMockPool(runQuery: (attempt: number) => "ok" | (Error & { code?: string })) {
  let attempt = 0;
  const query = vi.fn(async () => {
    attempt += 1;
    const outcome = runQuery(attempt);
    if (outcome !== "ok") {
      throw outcome;
    }
    return { rows: [ROW] };
  });
  const pool = { query } as unknown as Pool;
  return { pool, query };
}

describe("recordAuditEntry — 40001 serialization conflict retry", () => {
  it("retries a 40001 conflict with exponential backoff and succeeds once it clears", async () => {
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const { pool, query } = createMockPool((attempt) => (attempt < 3 ? makeError("restart transaction", "40001") : "ok"));

    const result = await recordAuditEntry(pool, ORG_ID, "reflection.proposal_applied", null);

    expect(result.id).toBe(ROW.id);
    expect(query).toHaveBeenCalledTimes(3);
    const delaysMs = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(delaysMs).toEqual([100, 200]);
    setTimeoutSpy.mockRestore();
  });

  it(`gives up after ${MAX_SERIALIZATION_RETRIES} attempts of a persistent 40001 conflict`, async () => {
    const { pool, query } = createMockPool(() => makeError("restart transaction", "40001"));

    await expect(recordAuditEntry(pool, ORG_ID, "reflection.proposal_applied", null)).rejects.toMatchObject({ code: "40001" });
    expect(query).toHaveBeenCalledTimes(MAX_SERIALIZATION_RETRIES);
  });

  it("does not retry a non-40001 error — fails immediately on the first attempt", async () => {
    const { pool, query } = createMockPool(() => makeError("connection terminated"));

    await expect(recordAuditEntry(pool, ORG_ID, "reflection.proposal_applied", null)).rejects.toThrow("connection terminated");
    expect(query).toHaveBeenCalledTimes(1);
  });
});
