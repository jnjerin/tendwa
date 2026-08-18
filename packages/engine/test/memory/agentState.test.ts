import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  AgentStateValidationError,
  checkpointGroup,
  claimReflectionRun,
  completeReflectionRun,
  failReflectionRun,
  findActiveReflectionState,
  getLastCompletedWatermark,
  resumeReflectionRun,
} from "../../src/memory/agentState.js";
import type { ReflectionRunPayload } from "../../src/memory/agentState.js";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const STATE_ID = "22222222-2222-2222-2222-222222222222";
const EXPERIENCE_ID = "33333333-3333-3333-3333-333333333333";

function makePayload(overrides: Partial<ReflectionRunPayload> = {}): ReflectionRunPayload {
  return {
    runId: "44444444-4444-4444-4444-444444444444",
    watermarkBefore: "1970-01-01T00:00:00.000Z",
    watermarkAfter: { createdAt: "2026-08-18T00:00:00.000Z", id: EXPERIENCE_ID },
    groups: [{ groupIndex: 0, experienceIds: [EXPERIENCE_ID], domain: "ops", status: "pending" }],
    ...overrides,
  };
}

function makeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: STATE_ID,
    org_id: ORG_ID,
    status: "running",
    step: "reflection",
    payload: makePayload(),
    updated_at: new Date("2026-08-18T00:00:00.000Z"),
    ...overrides,
  };
}

describe("findActiveReflectionState", () => {
  it("returns null when no active run exists", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;

    expect(await findActiveReflectionState(pool, ORG_ID)).toBeNull();
  });

  it("returns the mapped row when an active run exists", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [makeDbRow()] });
    const pool = { query } as unknown as Pool;

    const state = await findActiveReflectionState(pool, ORG_ID);

    expect(state?.id).toBe(STATE_ID);
    expect(state?.status).toBe("running");
    expect(state?.payload?.runId).toBe("44444444-4444-4444-4444-444444444444");
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/status != 'completed'/);
    expect(params).toEqual([ORG_ID, "reflection"]);
  });

  it("rejects an invalid orgId", async () => {
    const pool = { query: vi.fn() } as unknown as Pool;
    await expect(findActiveReflectionState(pool, "not-a-uuid")).rejects.toThrow(AgentStateValidationError);
  });
});

describe("getLastCompletedWatermark", () => {
  it("returns null when reflection has never completed a run", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;

    expect(await getLastCompletedWatermark(pool, ORG_ID)).toBeNull();
  });

  it("returns the frozen watermarkAfter from the most recent completed run", async () => {
    const payload = makePayload();
    const query = vi.fn().mockResolvedValue({ rows: [{ payload }] });
    const pool = { query } as unknown as Pool;

    expect(await getLastCompletedWatermark(pool, ORG_ID)).toEqual(payload.watermarkAfter);
  });
});

describe("claimReflectionRun", () => {
  it("inserts a new row with status running and step reflection", async () => {
    const payload = makePayload();
    const query = vi.fn().mockResolvedValue({ rows: [makeDbRow({ payload })] });
    const pool = { query } as unknown as Pool;

    const state = await claimReflectionRun(pool, ORG_ID, payload);

    expect(state.status).toBe("running");
    expect(state.step).toBe("reflection");
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO agent_state/);
    expect(sql).toMatch(/'running'/);
    expect(params).toEqual([ORG_ID, "reflection", payload]);
  });
});

describe("resumeReflectionRun", () => {
  it("claims the row via compare-and-swap and returns the mapped state", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [makeDbRow()] });
    const pool = { query } as unknown as Pool;
    const expectedUpdatedAt = new Date("2026-08-18T00:00:00.000Z");

    const state = await resumeReflectionRun(pool, STATE_ID, ORG_ID, expectedUpdatedAt);

    expect(state?.id).toBe(STATE_ID);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE agent_state/);
    expect(sql).toMatch(/updated_at = \$3/);
    expect(params).toEqual([STATE_ID, ORG_ID, expectedUpdatedAt]);
  });

  it("returns null when the compare-and-swap affects zero rows (already claimed elsewhere)", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;

    const state = await resumeReflectionRun(pool, STATE_ID, ORG_ID, new Date());

    expect(state).toBeNull();
  });
});

describe("checkpointGroup", () => {
  it("overwrites payload and bumps updated_at", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;
    const payload = makePayload({ groups: [{ groupIndex: 0, experienceIds: [EXPERIENCE_ID], domain: "ops", status: "completed" }] });

    await checkpointGroup(pool, STATE_ID, ORG_ID, payload);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE agent_state SET payload = \$3, updated_at = now\(\)/);
    expect(params).toEqual([STATE_ID, ORG_ID, payload]);
  });
});

describe("completeReflectionRun", () => {
  it("sets status to completed and writes the final payload", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;
    const payload = makePayload();

    await completeReflectionRun(pool, STATE_ID, ORG_ID, payload);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/status = 'completed'/);
    expect(params).toEqual([STATE_ID, ORG_ID, payload]);
  });
});

describe("failReflectionRun", () => {
  it("sets status to failed without touching payload", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;

    await failReflectionRun(pool, STATE_ID, ORG_ID);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/status = 'failed'/);
    expect(sql).not.toMatch(/payload/);
    expect(params).toEqual([STATE_ID, ORG_ID]);
  });
});
