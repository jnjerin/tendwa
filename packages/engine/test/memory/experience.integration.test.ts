import "../../src/env.js";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/client.js";
import { ExperienceValidationError, recordExperience } from "../../src/memory/experience.js";

const connectionString = process.env.TEST_DATABASE_URL;

// Fresh org_id per test file, not truncation — see ARCHITECTURE.md's test isolation decision.
// Parallel Vitest files each get their own org and never collide on shared table rows.
describe.skipIf(!connectionString)("recordExperience against tendwa_test", () => {
  let pool: Pool;
  let orgId: string;

  beforeAll(async () => {
    pool = createPool({ connectionString });
    const org = await pool.query<{ id: string }>(
      "INSERT INTO orgs (name) VALUES ($1) RETURNING id",
      ["experience.integration.test.ts"],
    );
    orgId = org.rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query("DELETE FROM experiences WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("inserts a new experience and returns the created row", async () => {
    const experience = await recordExperience(pool, {
      orgId,
      domain: "incident-response",
      content: "Database connection pool exhausted under load.",
      occurredAt: "2026-08-15T10:00:00Z",
      metadata: { severity: "high" },
    });

    expect(experience.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(experience.orgId).toBe(orgId);
    expect(experience.domain).toBe("incident-response");
    expect(experience.content).toBe("Database connection pool exhausted under load.");
    expect(experience.metadata).toEqual({ severity: "high" });
    expect(experience.occurredAt.toISOString()).toBe("2026-08-15T10:00:00.000Z");
    expect(experience.createdAt).toBeInstanceOf(Date);

    const persisted = await pool.query<{ content: string }>("SELECT content FROM experiences WHERE id = $1", [
      experience.id,
    ]);
    expect(persisted.rows[0]?.content).toBe("Database connection pool exhausted under load.");
  });

  it("rejects a write with a missing required field and persists nothing", async () => {
    const before = await pool.query<{ count: string }>("SELECT count(*) FROM experiences WHERE org_id = $1", [orgId]);

    await expect(
      recordExperience(pool, {
        orgId,
        domain: "incident-response",
        content: "",
        occurredAt: "2026-08-15T10:00:00Z",
      }),
    ).rejects.toThrow(ExperienceValidationError);

    const after = await pool.query<{ count: string }>("SELECT count(*) FROM experiences WHERE org_id = $1", [orgId]);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("propagates a clear error when the database is unavailable", async () => {
    // Port 1 is a reserved, unlisted port — connection is refused immediately rather than
    // hanging, so this doesn't need to wait out a full network timeout to prove the failure
    // path. A short connectionTimeoutMillis override keeps it fast on the rare host where it
    // doesn't refuse instantly.
    const unavailablePool = createPool({
      connectionString: "postgresql://user:pass@127.0.0.1:1/nonexistent",
      connectionTimeoutMillis: 1000,
    });

    try {
      await expect(
        recordExperience(unavailablePool, {
          orgId,
          domain: "incident-response",
          content: "Should never be written.",
          occurredAt: "2026-08-15T10:00:00Z",
        }),
      ).rejects.toThrow();
    } finally {
      await unavailablePool.end();
    }
  });
});
