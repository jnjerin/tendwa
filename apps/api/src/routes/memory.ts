import type { FastifyInstance } from "fastify";
import { retrieveMemory } from "../../../../packages/engine/src/memory/retrieve.js";

export async function memoryRoutes(app: FastifyInstance): Promise<void> {
  // GET /memory/search?orgId=&query=&domain=&limit= — retrieveMemory's own validate*
  // remains the single source of truth for what counts as valid input; this route only
  // extracts query params and coerces `limit` to a number.
  app.get("/search", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const result = await retrieveMemory(
      app.pool,
      {
        orgId: query.orgId ?? "",
        query: query.query ?? "",
        domain: query.domain,
        limit: query.limit !== undefined ? Number(query.limit) : undefined,
      },
      { requestId: request.id },
    );
    return result;
  });
}
