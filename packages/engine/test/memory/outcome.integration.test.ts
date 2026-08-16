import "../../src/env.js";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/client.js";
import { recordExperience } from "../../src/memory/experience.js";
import { OutcomeValidationError, recordOutcome } from "../../src/memory/outcome.js";

const connectionString = process.env.TEST_DATABASE_URL;

// Fresh org_id per test file, not truncation — see ARCHITECTURE.md's test isolation decision.
describe.skipIf(!connectionString)("recordOutcome against tendwa_test", () => {
  let pool: Pool;
  let orgId: string;
  let experienceId: string;

  beforeAll(async () => {
    pool = createPool({ connectionString });
    const org = await pool.query<{ id: string }>(
      "INSERT INTO orgs (name) VALUES ($1) RETURNING id",
      ["outcome.integration.test.ts"],
    );
    orgId = org.rows[0]!.id;
    const experience = await recordExperience(pool, {
      orgId,
      domain: "incident-response",
      content: "Payments API latency spiked after a routine deploy.",
      occurredAt: "2026-08-15T10:00:00Z",
    });
    experienceId = experience.id;
  });

  afterAll(async () => {
    await pool.query("DELETE FROM outcomes WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM experiences WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("inserts a new outcome and returns the created row", async () => {
    const outcome = await recordOutcome(pool, {
      orgId,
      experienceId,
      status: "resolved",
      rootCause: "connection pool size left at default despite traffic growth",
      actionTaken: "raised pool size; added pool-saturation alerting",
      result: "latency returned to baseline within 15 minutes",
    });

    expect(outcome.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(outcome.orgId).toBe(orgId);
    expect(outcome.experienceId).toBe(experienceId);
    expect(outcome.status).toBe("resolved");
    expect(outcome.rootCause).toBe("connection pool size left at default despite traffic growth");
    expect(outcome.actionTaken).toBe("raised pool size; added pool-saturation alerting");
    expect(outcome.result).toBe("latency returned to baseline within 15 minutes");
    expect(outcome.createdAt).toBeInstanceOf(Date);

    const persisted = await pool.query<{ status: string }>("SELECT status FROM outcomes WHERE id = $1", [
      outcome.id,
    ]);
    expect(persisted.rows[0]?.status).toBe("resolved");
  });

  it("rejects a write with a missing required field and persists nothing", async () => {
    const before = await pool.query<{ count: string }>("SELECT count(*) FROM outcomes WHERE org_id = $1", [orgId]);

    await expect(
      recordOutcome(pool, {
        orgId,
        experienceId,
        status: "resolved",
        actionTaken: "",
        result: "latency returned to baseline",
      }),
    ).rejects.toThrow(OutcomeValidationError);

    const after = await pool.query<{ count: string }>("SELECT count(*) FROM outcomes WHERE org_id = $1", [orgId]);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("propagates a clear error when the database is unavailable", async () => {
    const unavailablePool = createPool({
      connectionString: "postgresql://user:pass@127.0.0.1:1/nonexistent",
      connectionTimeoutMillis: 1000,
    });

    try {
      await expect(
        recordOutcome(unavailablePool, {
          orgId,
          experienceId,
          status: "resolved",
          actionTaken: "Should never be written.",
          result: "Should never be written.",
        }),
      ).rejects.toThrow();
    } finally {
      await unavailablePool.end();
    }
  });
});
