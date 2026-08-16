import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { getSeedStatus } from "../ingest/seed.js";
import { SEED_INCIDENTS } from "../ingest/seed-data.js";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const EXPECTED_COUNT = SEED_INCIDENTS.filter((entry) => entry.seedNow).length;

/** Mocks the two count queries getSeedStatus issues, in call order: experiences, then outcomes. */
function createMockPool(experienceCount: number, outcomeCount: number): Pool {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ count: String(experienceCount) }] })
    .mockResolvedValueOnce({ rows: [{ count: String(outcomeCount) }] });
  return { query } as unknown as Pool;
}

describe("getSeedStatus", () => {
  it("reports empty when neither experiences nor outcomes exist", async () => {
    const pool = createMockPool(0, 0);
    expect(await getSeedStatus(pool, ORG_ID)).toBe("empty");
  });

  it("reports complete when both counts exactly match the expected total", async () => {
    const pool = createMockPool(EXPECTED_COUNT, EXPECTED_COUNT);
    expect(await getSeedStatus(pool, ORG_ID)).toBe("complete");
  });

  it("reports partial when a process died before its last recordExperience — fewer experiences than expected", async () => {
    const pool = createMockPool(EXPECTED_COUNT - 5, EXPECTED_COUNT - 5);
    expect(await getSeedStatus(pool, ORG_ID)).toBe("partial");
  });

  it("reports partial when an experience committed but its paired recordOutcome failed", async () => {
    const pool = createMockPool(EXPECTED_COUNT, EXPECTED_COUNT - 1);
    expect(await getSeedStatus(pool, ORG_ID)).toBe("partial");
  });

  it("reports partial rather than complete if counts somehow exceed the expected total", async () => {
    const pool = createMockPool(EXPECTED_COUNT + 1, EXPECTED_COUNT + 1);
    expect(await getSeedStatus(pool, ORG_ID)).toBe("partial");
  });
});
