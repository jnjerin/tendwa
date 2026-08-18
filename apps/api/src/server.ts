import { loadConfig } from "../../../packages/engine/src/config.js";
import { createPool } from "../../../packages/engine/src/db/client.js";
import { log } from "../../../packages/engine/src/logger.js";
import { buildApp } from "./app.js";

// Validated at startup, per ENGINEERING.md §9 — a missing DATABASE_URL fails loudly here,
// before the process ever accepts a request, rather than surfacing deep inside a handler.
loadConfig();

const pool = createPool();
const app = await buildApp(pool);

const port = Number(process.env.PORT) || 3000;

async function shutdown(signal: string): Promise<void> {
  log("info", "Shutting down", { service: "api", component: "server", operation: "server.shutdown", signal });
  await app.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ port, host: "0.0.0.0" });
} catch (err) {
  app.log.error({ err }, "Failed to start server");
  process.exit(1);
}
