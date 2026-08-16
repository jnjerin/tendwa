import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retrieveMemory } from "../../src/memory/retrieve.js";

const VALID_INPUT = {
  orgId: "11111111-1111-1111-1111-111111111111",
  query: "database connection pool exhausted",
};

/**
 * Deliberately does NOT mock src/memory/embeddings.js (unlike retrieve.test.ts) — this exercises
 * the real embedText -> loadEmbeddingsConfig() -> requireEnv chain, so it actually proves the
 * fix: a missing VOYAGE_API_KEY reaches retrieveMemory as an EmbeddingError and triggers the
 * same experiences-only degradation as any other embedding failure, not just that embedText in
 * isolation throws the right error type. No network call happens (loadEmbeddingsConfig() throws
 * before fetch is reached) and no real database is needed (Pool is mocked), so this runs as a
 * fast, dependency-free unit test rather than needing the integration suite's live credentials.
 */
describe("retrieveMemory end-to-end when VOYAGE_API_KEY is unset", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.VOYAGE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
  });

  afterEach(() => {
    if (originalKey !== undefined) process.env.VOYAGE_API_KEY = originalKey;
  });

  it("degrades to experiences-only instead of hard-failing the whole retrieval", async () => {
    const experienceRow = {
      id: "e1",
      org_id: VALID_INPUT.orgId,
      domain: "incident-response",
      content: "Pool exhausted under load.",
      metadata: null,
      occurred_at: new Date(),
      created_at: new Date(),
    };
    const query = vi.fn().mockResolvedValue({ rows: [experienceRow] });
    const pool = { query } as unknown as Pool;

    const result = await retrieveMemory(pool, VALID_INPUT);

    expect(result.knowledgeUnavailable).toBe(true);
    expect(result.knowledge).toEqual([]);
    expect(result.experiences).toHaveLength(1);
    expect(result.experiences[0]!.content).toBe("Pool exhausted under load.");
    // Only the experiences query ran — the knowledge query was never attempted, since embedText
    // failed on the missing-config check before any DB call could happen.
    expect(query).toHaveBeenCalledTimes(1);
  });
});
