import "../../../packages/engine/src/env.js";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../../packages/engine/src/db/client.js";
import { findOrCreateOrg, getSeedStatus, seedIncidents } from "../ingest/seed.js";
import { SEED_INCIDENTS } from "../ingest/seed-data.js";

const connectionString = process.env.TEST_DATABASE_URL;
const ORG_NAME = "seed.integration.test.ts";

// Fresh org_id per test file, not truncation — see ARCHITECTURE.md's test isolation decision.
describe.skipIf(!connectionString)("seedIncidents against tendwa_test", () => {
  let pool: Pool;
  let orgId: string;

  beforeAll(async () => {
    pool = createPool({ connectionString });
    orgId = await findOrCreateOrg(pool, ORG_NAME);
  });

  afterAll(async () => {
    await pool.query(
      "DELETE FROM outcomes WHERE experience_id IN (SELECT id FROM experiences WHERE org_id = $1)",
      [orgId],
    );
    await pool.query("DELETE FROM experiences WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("findOrCreateOrg is idempotent — a second call returns the same org id", async () => {
    const secondCallId = await findOrCreateOrg(pool, ORG_NAME);
    expect(secondCallId).toBe(orgId);
  });

  it("is empty before the first run", async () => {
    expect(await getSeedStatus(pool, orgId)).toBe("empty");
  });

  it("seeds exactly the 11 non-FRESH incidents as experience+outcome pairs, leaving B6 out", async () => {
    const seeded = await seedIncidents(pool, orgId);
    expect(seeded).toBe(11);

    const experiences = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM experiences WHERE org_id = $1 AND domain = $2",
      [orgId, "incident-response"],
    );
    expect(Number(experiences.rows[0]?.count)).toBe(11);

    const outcomes = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM outcomes o
       JOIN experiences e ON e.id = o.experience_id
       WHERE e.org_id = $1`,
      [orgId],
    );
    expect(Number(outcomes.rows[0]?.count)).toBe(11);

    // B6's content never landed — it's held back for a live demo submission.
    const b6 = SEED_INCIDENTS.find((entry) => entry.id === "B6")!;
    const b6Match = await pool.query<{ id: string }>(
      "SELECT id FROM experiences WHERE org_id = $1 AND content = $2",
      [orgId, b6.incident.description],
    );
    expect(b6Match.rows).toHaveLength(0);
  });

  it("reports complete after the first run", async () => {
    expect(await getSeedStatus(pool, orgId)).toBe("complete");
  });

  // Simulates the exact failure mode both reviewers flagged: recordExperience commits but its
  // paired recordOutcome never lands (e.g. the process dies between the two calls). A plain
  // "does at least one experience exist" check would misreport this as fully seeded.
  it("reports partial when an experience is missing its paired outcome", async () => {
    const anyOutcome = await pool.query<{ id: string }>(
      `SELECT o.id FROM outcomes o
       JOIN experiences e ON e.id = o.experience_id
       WHERE e.org_id = $1 LIMIT 1`,
      [orgId],
    );
    await pool.query("DELETE FROM outcomes WHERE id = $1", [anyOutcome.rows[0]!.id]);

    expect(await getSeedStatus(pool, orgId)).toBe("partial");
  });
});
