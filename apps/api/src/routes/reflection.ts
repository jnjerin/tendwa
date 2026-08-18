import type { FastifyInstance } from "fastify";
import { runReflection } from "../../../../packages/engine/src/memory/reflect.js";

export async function reflectionRoutes(app: FastifyInstance): Promise<void> {
  // POST /reflection/run — manual/dashboard-triggered run. The scheduled production path is
  // apps/worker's Lambda handler, which calls runReflection directly rather than through this
  // HTTP route (see DECISIONS.md). No request timeout is set here: a real run can take
  // multiple sequential LLM calls, and Fastify's default requestTimeout (0, unbounded) is what
  // this endpoint's manual-trigger use case actually wants.
  app.post("/run", async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const summary = await runReflection(app.pool, {}, { orgId: body.orgId as string }, { requestId: request.id });
    return summary;
  });
}
