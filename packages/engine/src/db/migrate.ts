import "../env.js";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { requireEnv } from "../config.js";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

// Migration DDL (e.g. CREATE VECTOR INDEX, which builds a C-SPANN index rather than a plain
// B-tree) can legitimately run far longer than a normal application query. client.ts's 10s
// default would be wrong here, so this context gets its own, deliberately longer, timeout.
const MIGRATION_STATEMENT_TIMEOUT_MS = 120_000;

// Per ENGINEERING.md §1: CockroachDB serialization conflicts (40001) are expected, correct
// behavior under SERIALIZABLE isolation, not a bug — retry the whole transaction, bounded,
// with backoff. Migrations are normally run by a single actor, so this rarely triggers in
// practice, but the migration runner is still a real write path and shouldn't be exempt.
export const MAX_SERIALIZATION_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 100;

export interface MigrationFile {
  version: string;
  filename: string;
  sql: string;
}

export function loadMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((filename) => filename.endsWith(".sql"))
    .sort()
    .map((filename) => ({
      version: filename.replace(/\.sql$/, ""),
      filename,
      sql: readFileSync(path.join(dir, filename), "utf8"),
    }));
}

/**
 * Pure filter, deliberately independent of any DB connection — this is what the unit test
 * exercises directly, since "skip already-applied versions" shouldn't require a real database
 * to verify.
 */
export function pendingMigrations(
  migrations: MigrationFile[],
  appliedVersions: ReadonlySet<string>,
): MigrationFile[] {
  return migrations.filter((migration) => !appliedVersions.has(migration.version));
}

/**
 * schema_migrations is created by 001_init.sql itself (see its own leading comment), so on a
 * brand-new database the table won't exist yet — that's treated as "nothing applied" rather
 * than an error.
 */
async function getAppliedVersions(client: Client): Promise<Set<string>> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'schema_migrations'
     ) AS exists`,
  );
  if (!rows[0]?.exists) {
    return new Set();
  }
  const result = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
  return new Set(result.rows.map((row) => row.version));
}

function isSerializationConflict(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "40001";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function applyOneMigration(client: Client, migration: MigrationFile): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    await client.query("BEGIN");
    try {
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
      await client.query("COMMIT");
      log("info", "Applied migration", {
        service: "engine",
        component: "db.migrate",
        operation: "migration.apply",
        version: migration.version,
      });
      return migration.version;
    } catch (err) {
      await client.query("ROLLBACK");
      const conflict = isSerializationConflict(err);
      const retryable = conflict && attempt < MAX_SERIALIZATION_RETRIES;
      log("error", retryable ? "Migration hit a serialization conflict, retrying" : "Migration failed, rolled back", {
        service: "engine",
        component: "db.migrate",
        operation: "migration.apply",
        errorCode: conflict ? "MIGRATION_SERIALIZATION_CONFLICT" : "MIGRATION_FAILED",
        version: migration.version,
        attempt,
        err: err as Error,
      });
      if (!retryable) {
        throw err;
      }
      await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

/**
 * Applies each migration in its own transaction, in order, stopping (and propagating the
 * error) on the first one that fails after exhausting retries. Split out from runMigrations()
 * so this — the actual apply/rollback/retry logic — is unit-testable against a mocked client,
 * without needing a real database connection.
 */
export async function applyMigrations(client: Client, migrations: MigrationFile[]): Promise<string[]> {
  const applied: string[] = [];
  for (const migration of migrations) {
    applied.push(await applyOneMigration(client, migration));
  }
  return applied;
}

export async function runMigrations(connectionString: string): Promise<string[]> {
  const client = new Client({
    connectionString,
    // Covers acquiring the connection only — statement_timeout/query_timeout below cover a
    // migration statement that hangs once connected (see comment on the constant above).
    connectionTimeoutMillis: 5000,
    statement_timeout: MIGRATION_STATEMENT_TIMEOUT_MS,
    query_timeout: MIGRATION_STATEMENT_TIMEOUT_MS,
  });
  await client.connect();
  try {
    const appliedVersions = await getAppliedVersions(client);
    const migrations = loadMigrationFiles();
    return await applyMigrations(client, pendingMigrations(migrations, appliedVersions));
  } finally {
    await client.end();
  }
}

// main() below deliberately uses console.error/console.log, not the structured pino logger.
// This is CLI operator output — a human running `pnpm migrate` reading their own terminal —
// not a service log line meant for a log aggregator, so ENGINEERING.md §4's structured-JSON
// requirement (which targets running services like apps/api) doesn't apply to it. The actual
// service-facing events (a migration applying, a migration failing) are logged structurally
// above, inside applyOneMigration itself; main() only formats a final human-readable summary.
async function main(): Promise<void> {
  const useTest = process.argv.includes("--test");
  const varName = useTest ? "TEST_DATABASE_URL" : "DATABASE_URL";
  const connectionString = requireEnv(process.env, varName);
  const applied = await runMigrations(connectionString);
  if (applied.length === 0) {
    console.log("No pending migrations.");
  } else {
    console.log(`Applied migrations: ${applied.join(", ")}`);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
