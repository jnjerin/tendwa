import type { FastifyInstance } from "fastify";
import { getKnowledgeById, listKnowledge } from "../../../../packages/engine/src/memory/knowledge.js";

export async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
  // GET /knowledge?orgId=&domain=&limit=
  app.get("/", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const items = await listKnowledge(
      app.pool,
      {
        orgId: query.orgId ?? "",
        domain: query.domain,
        limit: query.limit !== undefined ? Number(query.limit) : undefined,
      },
      { requestId: request.id },
    );
    return { items };
  });

  // GET /knowledge/:id?orgId=
  app.get("/:id", async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, string | undefined>;
    const knowledge = await getKnowledgeById(app.pool, query.orgId ?? "", id, { requestId: request.id });
    return knowledge;
  });
}
