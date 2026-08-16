import "../../src/env.js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";

const connectionString = process.env.TEST_DATABASE_URL;

const EXPECTED_TABLES = [
  "schema_migrations",
  "orgs",
  "experiences",
  "knowledge",
  "knowledge_evidence",
  "agent_state",
  "outcomes",
  "agent_audit_log",
];

describe.skipIf(!connectionString)("migration runner against tendwa_test", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it("brings the schema to the expected state (tables, embedding column, vector index)", async () => {
    // Not asserting what this specific call's return value contains: tendwa_test isn't
    // truncated between runs (schema/migrations aren't org-scoped, so the org_id-isolation
    // test strategy doesn't cover this table), so 001_init may already be recorded from an
    // earlier run. What matters is the resulting schema, not which call happened to apply it.
    await runMigrations(connectionString!);

    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const tableNames = tables.rows.map((row) => row.table_name);
    for (const expected of EXPECTED_TABLES) {
      expect(tableNames).toContain(expected);
    }

    const embeddingColumn = await client.query<{ udt_name: string }>(
      `SELECT udt_name FROM information_schema.columns
       WHERE table_name = 'knowledge' AND column_name = 'embedding'`,
    );
    expect(embeddingColumn.rows[0]?.udt_name).toBe("vector");

    const indexes = await client.query<{ index_name: string }>("SHOW INDEXES FROM knowledge");
    const indexNames = indexes.rows.map((row) => row.index_name);
    expect(indexNames).toContain("idx_knowledge_embedding");

    // Checking the index exists by name isn't enough: DECISIONS.md records that omitting the
    // opclass silently defaults to vector_l2_ops instead of erroring, which is exactly the
    // regression that got fixed. Assert the actual distance metric, not just the index's name.
    const createTable = await client.query<{ create_statement: string }>("SHOW CREATE TABLE knowledge");
    expect(createTable.rows[0]?.create_statement).toContain("vector_cosine_ops");
  });

  it("is idempotent — a second run within the same test applies nothing new", async () => {
    await runMigrations(connectionString!);
    const secondRun = await runMigrations(connectionString!);
    expect(secondRun).toEqual([]);
  });
});
