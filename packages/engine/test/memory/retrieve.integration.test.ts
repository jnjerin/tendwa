import "../../src/env.js";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/client.js";
import { EMBEDDING_DIMENSIONS, embedText } from "../../src/memory/embeddings.js";
import { queryKnowledgeBySimilarity, queryRecentExperiences, retrieveMemory, toVectorLiteral } from "../../src/memory/retrieve.js";

const connectionString = process.env.TEST_DATABASE_URL;
const canRunEmbeddingCalls = Boolean(connectionString) && Boolean(process.env.VOYAGE_API_KEY);

// Fresh org_id per test file, not truncation — see ARCHITECTURE.md's test isolation decision.
//
// Real Voyage calls are kept to the minimum needed for genuine end-to-end coverage: this
// account is on Voyage's free tier without a payment method, capped at 3 RPM. beforeAll makes
// the 2 calls needed to seed real knowledge embeddings, and exactly one test exercises the full
// retrieveMemory() -> embedText() -> DB pipeline for real. Every other assertion (domain
// filtering, recency ordering) reuses the already-computed seeding embedding via the exported
// query helpers directly, rather than re-embedding text it doesn't need to.
describe.skipIf(!canRunEmbeddingCalls)("retrieveMemory against tendwa_test + real Voyage AI", () => {
  let pool: Pool;
  let orgId: string;
  let poolEmbedding: number[];
  let poolEmbeddingId: string;
  let credentialEmbeddingId: string;

  beforeAll(async () => {
    pool = createPool({ connectionString });
    const org = await pool.query<{ id: string }>("INSERT INTO orgs (name) VALUES ($1) RETURNING id", [
      "retrieve.integration.test.ts",
    ]);
    orgId = org.rows[0]!.id;

    const poolStatement = "Restart the connection pool when it becomes exhausted under sustained load.";
    const credentialStatement = "Rotate API keys quarterly to reduce credential exposure risk.";
    const [poolEmbeddingResult, credentialEmbedding] = await Promise.all([
      embedText(poolStatement, { inputType: "document" }),
      embedText(credentialStatement, { inputType: "document" }),
    ]);
    poolEmbedding = poolEmbeddingResult;

    const poolRow = await pool.query<{ id: string }>(
      `INSERT INTO knowledge (org_id, domain, statement, embedding, confidence)
       VALUES ($1, $2, $3, $4::VECTOR, $5) RETURNING id`,
      [orgId, "incident-response", poolStatement, toVectorLiteral(poolEmbedding), 0.8],
    );
    poolEmbeddingId = poolRow.rows[0]!.id;

    const credentialRow = await pool.query<{ id: string }>(
      `INSERT INTO knowledge (org_id, domain, statement, embedding, confidence)
       VALUES ($1, $2, $3, $4::VECTOR, $5) RETURNING id`,
      [orgId, "security", credentialStatement, toVectorLiteral(credentialEmbedding), 0.6],
    );
    credentialEmbeddingId = credentialRow.rows[0]!.id;

    await pool.query(
      `INSERT INTO experiences (org_id, domain, content, occurred_at) VALUES
         ($1, 'incident-response', 'Pool exhausted at 09:00.', now() - interval '2 days'),
         ($1, 'incident-response', 'Pool exhausted again at 14:00.', now() - interval '1 day'),
         ($1, 'security', 'Rotated a leaked API key.', now())`,
      [orgId],
    );
  }, 30000);

  afterAll(async () => {
    await pool.query("DELETE FROM experiences WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM knowledge WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("seeding produced a real, correctly-shaped Voyage embedding", () => {
    expect(poolEmbedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(poolEmbedding.every((value) => typeof value === "number" && Number.isFinite(value))).toBe(true);
  });

  it("end-to-end: retrieveMemory embeds the query for real and ranks knowledge by similarity", async () => {
    const result = await retrieveMemory(pool, {
      orgId,
      query: "Our database connection pool is exhausted and requests are timing out.",
    });

    expect(result.knowledgeUnavailable).toBe(false);
    expect(result.knowledge.length).toBeGreaterThanOrEqual(2);
    expect(result.knowledge[0]!.id).toBe(poolEmbeddingId);
    expect(result.knowledge[0]!.similarity).toBeGreaterThan(
      result.knowledge.find((k) => k.id === credentialEmbeddingId)!.similarity,
    );
  });

  it("filters knowledge by domain (queried directly, no extra Voyage call)", async () => {
    const matches = await queryKnowledgeBySimilarity(pool, orgId, poolEmbedding, "security", 10);

    expect(matches.every((k) => k.domain === "security")).toBe(true);
    expect(matches.some((k) => k.id === credentialEmbeddingId)).toBe(true);
    expect(matches.some((k) => k.id === poolEmbeddingId)).toBe(false);
  });

  it("returns experiences filtered by org_id and domain, ordered by recency (no Voyage call needed)", async () => {
    const experiences = await queryRecentExperiences(pool, orgId, "incident-response", 10);

    expect(experiences.length).toBeGreaterThanOrEqual(2);
    expect(experiences.every((e) => e.domain === "incident-response")).toBe(true);
    expect(experiences[0]!.content).toBe("Pool exhausted again at 14:00.");
    for (let i = 1; i < experiences.length; i++) {
      expect(experiences[i - 1]!.occurredAt.getTime()).toBeGreaterThanOrEqual(experiences[i]!.occurredAt.getTime());
    }
  });

  it("degrades to experiences-only when the embedding call fails, rather than failing the whole retrieval", async () => {
    const original = process.env.VOYAGE_API_KEY;
    process.env.VOYAGE_API_KEY = "definitely-not-a-real-key";
    try {
      const result = await retrieveMemory(pool, { orgId, query: "connection pool exhausted" });

      expect(result.knowledgeUnavailable).toBe(true);
      expect(result.knowledge).toEqual([]);
      expect(result.experiences.length).toBeGreaterThan(0);
    } finally {
      process.env.VOYAGE_API_KEY = original;
    }
  }, 15000);
});
