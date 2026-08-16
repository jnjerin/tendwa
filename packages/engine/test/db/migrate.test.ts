import { describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import {
  applyMigrations,
  pendingMigrations,
  MAX_SERIALIZATION_RETRIES,
  type MigrationFile,
} from "../../src/db/migrate.js";

const migrations: MigrationFile[] = [
  { version: "001_init", filename: "001_init.sql", sql: "-- noop" },
  { version: "002_add_foo", filename: "002_add_foo.sql", sql: "-- noop" },
];

describe("pendingMigrations", () => {
  it("skips versions already recorded in schema_migrations", () => {
    const result = pendingMigrations(migrations, new Set(["001_init"]));
    expect(result.map((m) => m.version)).toEqual(["002_add_foo"]);
  });

  it("returns everything when nothing has been applied yet", () => {
    const result = pendingMigrations(migrations, new Set());
    expect(result.map((m) => m.version)).toEqual(["001_init", "002_add_foo"]);
  });

  it("returns nothing when everything is already applied", () => {
    const result = pendingMigrations(migrations, new Set(["001_init", "002_add_foo"]));
    expect(result).toHaveLength(0);
  });
});

function makeError(message: string, code?: string): Error & { code?: string } {
  const err: Error & { code?: string } = new Error(message);
  if (code) err.code = code;
  return err;
}

/** Mocks the subset of pg.Client's `query` that applyMigrations actually calls. */
function createMockClient(runDdl: (attempt: number) => "ok" | (Error & { code?: string })) {
  const calls: string[] = [];
  let ddlAttempt = 0;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push(params ? `${sql} :: ${JSON.stringify(params)}` : sql);
    if (sql === "SOME_MIGRATION_SQL") {
      ddlAttempt += 1;
      const outcome = runDdl(ddlAttempt);
      if (outcome !== "ok") {
        throw outcome;
      }
    }
    return { rows: [] };
  });
  const client = { query } as unknown as Client;
  return { client, calls };
}

const failingMigration: MigrationFile[] = [
  { version: "001_init", filename: "001_init.sql", sql: "SOME_MIGRATION_SQL" },
];

describe("applyMigrations failure paths", () => {
  it("rolls back and never records the version on a non-retryable error, without retrying", async () => {
    const { client, calls } = createMockClient(() => makeError("syntax error"));

    await expect(applyMigrations(client, failingMigration)).rejects.toThrow("syntax error");

    expect(calls.filter((c) => c === "BEGIN")).toHaveLength(1);
    expect(calls.filter((c) => c === "ROLLBACK")).toHaveLength(1);
    expect(calls.some((c) => c.startsWith("INSERT INTO schema_migrations"))).toBe(false);
  });

  it("keeps a prior successful migration committed when a later one fails", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push(params ? `${sql} :: ${JSON.stringify(params)}` : sql);
      if (sql === "BREAKS") {
        throw makeError("syntax error");
      }
      return { rows: [] };
    });
    const client = { query } as unknown as Client;
    const twoMigrations: MigrationFile[] = [
      { version: "001_init", filename: "001_init.sql", sql: "-- noop" },
      { version: "002_broken", filename: "002_broken.sql", sql: "BREAKS" },
    ];

    await expect(applyMigrations(client, twoMigrations)).rejects.toThrow("syntax error");

    expect(calls.some((c) => c.includes('"001_init"'))).toBe(true);
    expect(calls.filter((c) => c === "COMMIT")).toHaveLength(1);
    expect(calls.some((c) => c.includes('"002_broken"'))).toBe(false);
  });

  it("retries a 40001 serialization conflict with exponential backoff and succeeds once it clears", async () => {
    const { client, calls } = createMockClient((attempt) =>
      attempt < 3 ? makeError("restart transaction", "40001") : "ok",
    );
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    const applied = await applyMigrations(client, failingMigration);

    expect(applied).toEqual(["001_init"]);
    expect(calls.filter((c) => c === "BEGIN")).toHaveLength(3);
    expect(calls.filter((c) => c === "ROLLBACK")).toHaveLength(2);
    expect(calls.filter((c) => c === "COMMIT")).toHaveLength(1);
    expect(calls.some((c) => c.includes('"001_init"'))).toBe(true);
    // Proves delay() actually ran between retries, with the right backoff schedule — not just
    // that the retry count happened to come out right. RETRY_BASE_DELAY_MS(100) * 2^(attempt-1).
    const delaysMs = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(delaysMs).toEqual([100, 200]);

    setTimeoutSpy.mockRestore();
  });

  it(`gives up after ${MAX_SERIALIZATION_RETRIES} attempts of a persistent 40001 conflict`, async () => {
    const { client, calls } = createMockClient(() => makeError("restart transaction", "40001"));

    await expect(applyMigrations(client, failingMigration)).rejects.toMatchObject({ code: "40001" });

    expect(calls.filter((c) => c === "BEGIN")).toHaveLength(MAX_SERIALIZATION_RETRIES);
    expect(calls.filter((c) => c === "ROLLBACK")).toHaveLength(MAX_SERIALIZATION_RETRIES);
    expect(calls.some((c) => c.startsWith("INSERT INTO schema_migrations"))).toBe(false);
  });
});
