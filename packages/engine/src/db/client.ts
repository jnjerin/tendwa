import { Pool, type PoolConfig } from "pg";
import { loadConfig } from "../config.js";
import { log } from "../logger.js";

const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

/**
 * Connection string carries CockroachDB Cloud's sslmode (e.g. verify-full) already, so it's
 * passed through as-is rather than overridden with a hardcoded ssl option here.
 */
export function createPool(overrides: Partial<PoolConfig> = {}): Pool {
  const config = loadConfig();
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    // Covers acquiring a connection from the pool — does not cover a query that hangs
    // after the connection is established, which statement_timeout/query_timeout handle.
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    // Server-enforced: CockroachDB kills the statement itself if it runs past this.
    statement_timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
    // Client-enforced: pg cancels and rejects the query on its own if the server doesn't.
    query_timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
    ...overrides,
  });

  // Idle pooled clients can emit network errors (e.g. the server closing a connection)
  // outside of any query. Without a handler, that's an uncaught 'error' event and Node
  // crashes the process — see ENGINEERING.md §1, failure modes must be handled explicitly.
  pool.on("error", (err) => {
    log("error", "Unexpected error on idle CockroachDB client", {
      service: "engine",
      component: "db.pool",
      errorCode: "DB_POOL_IDLE_ERROR",
      err,
    });
  });

  return pool;
}
