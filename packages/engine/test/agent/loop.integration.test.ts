import "../../src/env.js";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAgentLoop } from "../../src/agent/loop.js";
import { createPool } from "../../src/db/client.js";
import { recordExperience } from "../../src/memory/experience.js";

const connectionString = process.env.TEST_DATABASE_URL;
const canRunLiveAgentCall = Boolean(connectionString) && Boolean(process.env.ANTHROPIC_API_KEY);

// Fresh org_id per test file, not truncation — see ARCHITECTURE.md's test isolation decision.
// Exactly one real Claude call, gated behind ANTHROPIC_API_KEY, matching the embeddings
// integration test's minimal-real-call stance. Excluded from `npm test` by the package's
// "--exclude **/*.integration.test.ts" script — only `npm run test:integration` runs this.
describe.skipIf(!canRunLiveAgentCall)("runAgentLoop against tendwa_test + real Claude Sonnet 5", () => {
  let pool: Pool;
  let orgId: string;
  let experienceId: string;

  beforeAll(async () => {
    pool = createPool({ connectionString });
    const org = await pool.query<{ id: string }>("INSERT INTO orgs (name) VALUES ($1) RETURNING id", [
      "loop.integration.test.ts",
    ]);
    orgId = org.rows[0]!.id;

    const experience = await recordExperience(pool, {
      orgId,
      domain: "ops",
      content:
        "The database connection pool was exhausted under sustained load, causing request timeouts. " +
        "Restarting the pool and adding a max-connections alert resolved it.",
      occurredAt: new Date(),
    });
    experienceId = experience.id;
  }, 30000);

  afterAll(async () => {
    await pool.query("DELETE FROM experiences WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("retrieves, reasons, and returns a validated proposal citing only ids that were actually retrieved", async () => {
    const result = await runAgentLoop(pool, {
      orgId,
      query: "Our database connection pool is exhausted and requests are timing out.",
      domain: "ops",
    });

    expect(result.status).toBe("ok");
    expect(result.retrieval.experiences.some((e) => e.id === experienceId)).toBe(true);

    const proposal = result.proposal!;
    expect(proposal.confidence).toBeGreaterThanOrEqual(0);
    expect(proposal.confidence).toBeLessThanOrEqual(1);
    expect(proposal.likelyCause.length).toBeGreaterThan(0);
    expect(proposal.recommendation.length).toBeGreaterThan(0);

    const validExperienceIds = new Set(result.retrieval.experiences.map((e) => e.id));
    const validKnowledgeIds = new Set(result.retrieval.knowledge.map((k) => k.id));
    for (const id of proposal.citedExperienceIds) {
      expect(validExperienceIds.has(id)).toBe(true);
    }
    for (const id of proposal.citedKnowledgeIds) {
      expect(validKnowledgeIds.has(id)).toBe(true);
    }
  }, 30000);
});
