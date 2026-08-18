import type { FastifyInstance } from "fastify";
import { getExperienceById, recordExperience } from "../../../../packages/engine/src/memory/experience.js";
import { getOutcomeByExperienceId, recordOutcome } from "../../../../packages/engine/src/memory/outcome.js";
import { runAgentLoop } from "../../../../packages/engine/src/agent/loop.js";
import { recordAuditEntry } from "../../../../packages/engine/src/memory/auditLog.js";
import { incidentToExperience, type Incident } from "../../../../domains/incident-response/mapping.js";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function incidentsRoutes(app: FastifyInstance): Promise<void> {
  // POST /incidents — body: { orgId, title, description, service, environment, severity,
  // occurredAt, sourceUrl? }. Incident-shaped, not the engine's raw generic experience shape —
  // translated via domains/incident-response/mapping.ts's incidentToExperience, the same
  // function domains/incident-response/ingest/seed.ts already uses to seed incidents, not a
  // parallel implementation. incidentToExperience itself does no validation (it's a pure
  // transform); recordExperience's own validateNewExperience is still what rejects a missing
  // title+description (empty content) or occurredAt with a 400.
  app.post("/", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const orgId = body.orgId as string;
    const incident: Incident = {
      title: body.title as string,
      description: body.description as string,
      service: body.service as string,
      environment: body.environment as string,
      severity: body.severity as string,
      occurredAt: body.occurredAt as string,
      sourceUrl: body.sourceUrl as string | undefined,
    };
    const experience = await recordExperience(app.pool, incidentToExperience(incident, orgId), { requestId: request.id });
    reply.code(201);
    return experience;
  });

  // GET /incidents/:id?orgId=
  app.get("/:id", async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, string | undefined>;
    const experience = await getExperienceById(app.pool, query.orgId ?? "", id, { requestId: request.id });
    return experience;
  });

  // POST /incidents/:id/analyze — body: { orgId, query?, domain?, limit? }
  // Fetches the experience first (404s if missing or not owned by orgId), defaults the agent
  // loop's situation text to the experience's own content when the caller doesn't supply one,
  // then records one agent_audit_log entry for the decision (CLAUDE.md rule 4) — this is the
  // audit write DECISIONS.md's 2026-08-17 entry on agent/loop.ts deferred to this endpoint.
  app.post("/:id/analyze", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const orgId = body.orgId as string;

    const experience = await getExperienceById(app.pool, orgId, id, { requestId: request.id });

    const situationQuery = isNonEmptyString(body.query) ? body.query.trim() : experience.content;
    const result = await runAgentLoop(
      app.pool,
      {
        orgId,
        query: situationQuery,
        domain: (body.domain as string | undefined) ?? experience.domain,
        limit: body.limit as number | undefined,
      },
      { requestId: request.id },
    );

    // The audit write is a durable record of the decision, not the decision itself — a real
    // (possibly LLM-costly) result already exists by this point, and losing it to an audit-log
    // write failure would invert ENGINEERING.md §1's graceful-degradation intent for this exact
    // endpoint (a secondary write failing should never turn a valid primary result into a bare
    // 500). Logged loudly on failure, since agent_audit_log is the durable audit trail
    // (CLAUDE.md rule 4) and a missed entry is a real gap worth seeing in logs.
    try {
      await recordAuditEntry(
        app.pool,
        orgId,
        "agent.analyze",
        {
          experienceId: id,
          status: result.status,
          proposal: result.proposal ?? null,
          reason: result.reason ?? null,
        },
        { requestId: request.id },
      );
    } catch (err) {
      request.log.error(
        { err, errorCode: "AGENT_ANALYZE_AUDIT_WRITE_FAILED", experienceId: id, orgId },
        "Failed to record audit log entry for agent.analyze; returning the agent result anyway",
      );
    }

    return result;
  });

  // POST /incidents/:id/outcome — body: { orgId, status, actionTaken, result, rootCause? }
  // Verifies the experience exists and belongs to orgId before writing the outcome — closes
  // the gap DECISIONS.md's 2026-08-16 entry on recordOutcome names this exact endpoint as the
  // point where a mismatched org_id/experience_id pair becomes reachable. Also rejects a
  // duplicate outcome for the same experience (409) — this is the first HTTP-reachable,
  // retry-prone caller of recordOutcome, and reflect.ts's own grouping logic already assumes at
  // most one outcome per experience (see DECISIONS.md).
  app.post("/:id/outcome", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const orgId = body.orgId as string;

    await getExperienceById(app.pool, orgId, id, { requestId: request.id });

    const existing = await getOutcomeByExperienceId(app.pool, orgId, id, { requestId: request.id });
    if (existing) {
      reply.code(409);
      return {
        error: {
          code: "OUTCOME_ALREADY_RECORDED",
          message: `An outcome (${existing.id}) has already been recorded for this experience`,
          requestId: request.id,
        },
      };
    }

    const outcome = await recordOutcome(
      app.pool,
      {
        orgId,
        experienceId: id,
        status: body.status as string,
        actionTaken: body.actionTaken as string,
        result: body.result as string,
        rootCause: body.rootCause as string | undefined,
      },
      { requestId: request.id },
    );
    reply.code(201);
    return outcome;
  });
}
