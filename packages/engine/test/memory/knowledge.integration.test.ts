import "../../src/env.js";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/client.js";
import { recordExperience } from "../../src/memory/experience.js";
import { addEvidence, createKnowledge, decayKnowledgeConfidence, reinforceKnowledge } from "../../src/memory/knowledge.js";

const connectionString = process.env.TEST_DATABASE_URL;
const canRunEmbeddingCalls = Boolean(connectionString) && Boolean(process.env.VOYAGE_API_KEY);

// Fresh org_id per test file, not truncation — see ARCHITECTURE.md's test isolation decision.
// Exactly one real Voyage call in the whole file (inside createKnowledge), matching the
// "keep real external calls to the minimum needed for genuine coverage" precedent already
// established in retrieve.integration.test.ts.
describe.skipIf(!canRunEmbeddingCalls)("knowledge.ts against tendwa_test + real Voyage AI", () => {
  let pool: Pool;
  let orgId: string;
  let experienceId: string;

  beforeAll(async () => {
    pool = createPool({ connectionString });
    const org = await pool.query<{ id: string }>("INSERT INTO orgs (name) VALUES ($1) RETURNING id", [
      "knowledge.integration.test.ts",
    ]);
    orgId = org.rows[0]!.id;

    const experience = await recordExperience(pool, {
      orgId,
      domain: "ops",
      content: "Connection pool exhausted under sustained load.",
      occurredAt: new Date(),
    });
    experienceId = experience.id;
  }, 30000);

  afterAll(async () => {
    await pool.query("DELETE FROM knowledge_evidence WHERE experience_id = $1", [experienceId]);
    await pool.query("DELETE FROM knowledge WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM experiences WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("creates knowledge with a real embedding, reinforces it, links evidence, and applies decay end-to-end", async () => {
    const knowledge = await createKnowledge(pool, {
      orgId,
      domain: "ops",
      statement: "Restart the connection pool before scaling replicas.",
    });
    expect(knowledge.confidence).toBe(0.5);
    expect(knowledge.reinforcementCount).toBe(1);

    const reinforced = await reinforceKnowledge(pool, {
      orgId,
      knowledgeId: knowledge.id,
      newConfidence: 0.85,
    });
    expect(reinforced.confidence).toBe(0.85);
    expect(reinforced.reinforcementCount).toBe(2);

    const evidence = await addEvidence(pool, { orgId, knowledgeId: knowledge.id, experienceId });
    expect(evidence).toEqual({ added: true });

    // Re-adding the same link is a safe no-op, not an error.
    const evidenceAgain = await addEvidence(pool, { orgId, knowledgeId: knowledge.id, experienceId });
    expect(evidenceAgain).toEqual({ added: false });

    // Just reinforced — well within the 30-day grace period, so decay is a no-op.
    const decayed = await decayKnowledgeConfidence(pool, { orgId, knowledgeId: knowledge.id });
    expect(decayed.confidence).toBe(0.85);
  }, 30000);
});
