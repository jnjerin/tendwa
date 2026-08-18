import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { Pool } from "pg";
import { pinoOptions } from "../../../packages/engine/src/logger.js";
import { classifyError, type ApiErrorBody } from "./errors.js";
import { healthRoutes } from "./routes/health.js";
import { incidentsRoutes } from "./routes/incidents.js";
import { memoryRoutes } from "./routes/memory.js";
import { reflectionRoutes } from "./routes/reflection.js";
import { knowledgeRoutes } from "./routes/knowledge.js";

declare module "fastify" {
  interface FastifyInstance {
    pool: Pool;
  }
}

/**
 * Builds (but does not start) the Fastify app, given an already-constructed Pool — kept
 * separate from server.ts's actual `.listen()`/shutdown wiring so tests can inject a fake pool
 * and exercise the full routing/error-mapping layer via `.inject()` without a real database.
 */
export async function buildApp(pool: Pool): Promise<FastifyInstance> {
  const app = Fastify({
    logger: pinoOptions,
    // Matches ENGINEERING.md §4's requestId log example ("req_abc123") rather than Fastify's
    // default incrementing-integer id, which is useless once more than one process is running.
    genReqId: () => `req_${randomUUID()}`,
  });

  app.decorate("pool", pool);

  await app.register(cors, {
    // Deliberately permissive for this project's actual scale: no auth/cookie boundary exists
    // for a permissive origin to weaken (PROJECT.md excludes authentication from MVP scope),
    // and apps/web (the Next.js dashboard) needs to call this cross-origin in local dev.
    origin: true,
  });

  app.setErrorHandler((err, request, reply) => {
    const { statusCode, code, message } = classifyError(err);
    const body: ApiErrorBody = { error: { code, message, requestId: request.id } };
    if (statusCode >= 500) {
      request.log.error({ err, errorCode: code }, "Unhandled request error");
    } else {
      request.log.warn({ err, errorCode: code }, "Request rejected");
    }
    reply.code(statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ApiErrorBody = {
      error: { code: "ROUTE_NOT_FOUND", message: `No route matches ${request.method} ${request.url}`, requestId: request.id },
    };
    reply.code(404).send(body);
  });

  await app.register(healthRoutes);
  await app.register(incidentsRoutes, { prefix: "/incidents" });
  await app.register(memoryRoutes, { prefix: "/memory" });
  await app.register(reflectionRoutes, { prefix: "/reflection" });
  await app.register(knowledgeRoutes, { prefix: "/knowledge" });

  return app;
}
