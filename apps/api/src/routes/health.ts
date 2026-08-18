import type { FastifyInstance } from "fastify";

/**
 * GET /health and GET /ready are the one place org_id is deliberately not required — per
 * ENGINEERING.md §5 they carry no domain data at all (liveness/readiness only), so there is no
 * org to scope.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness — is the process running. Minimal, no dependency checks (ENGINEERING.md §5).
  app.get("/health", async () => ({ status: "ok" }));

  // Readiness — can this instance actually reach the database. Bounded by the pool's own
  // statement_timeout/query_timeout (db/client.ts), so a hanging DB doesn't hang this route.
  app.get("/ready", async (request, reply) => {
    try {
      await app.pool.query("SELECT 1");
      return { status: "ready" };
    } catch (err) {
      request.log.error({ err, errorCode: "READY_DB_UNREACHABLE" }, "Readiness check failed: database unreachable");
      reply.code(503);
      return { status: "not_ready" };
    }
  });
}
