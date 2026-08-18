import type { Context } from "aws-lambda";
import type { Pool } from "pg";
import { createPool } from "../../../packages/engine/src/db/client.js";
import { log } from "../../../packages/engine/src/logger.js";
import { runReflection } from "../../../packages/engine/src/memory/reflect.js";
import type { ReflectionRunSummary } from "../../../packages/engine/src/memory/reflect.js";

export interface ReflectionEvent {
  orgId: string;
}

// Created once at module scope and reused across warm invocations — standard Lambda+pg
// pattern. Ending the pool inside the handler on every invocation would force a fresh
// connection setup (and its own connection-count churn against CockroachDB) on every single
// scheduled run instead of amortizing it across the execution context's warm lifetime.
let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

/**
 * Thin Lambda wrapper around runReflection (packages/engine/src/memory/reflect.ts) — no
 * business logic is duplicated here. Calls runReflection directly rather than over HTTP to
 * POST /reflection/run (see DECISIONS.md): this scheduled path is a trusted internal call that
 * shares a workspace with the engine, so there's no reason to give the Lambda network/auth
 * access to the API just to reach the same function call. POST /reflection/run remains for
 * manual/dashboard-triggered runs.
 *
 * One org per invocation, matching runReflection's own "one org per call" contract and this
 * project's single-organization MVP scope (no multi-org iteration here). A missing orgId fails
 * loudly and immediately rather than silently no-op'ing. Errors from runReflection are not
 * caught — they propagate so Lambda's own failure/retry/alerting semantics fire, and a retry
 * lands on runReflection's existing crash-resume path (agent_state was already left 'failed' by
 * the failed attempt).
 */
export async function handler(event: ReflectionEvent, context: Context): Promise<ReflectionRunSummary> {
  if (!event?.orgId) {
    throw new Error("Event must include orgId");
  }
  const requestId = context.awsRequestId;

  log("info", "Reflection Lambda invoked", {
    service: "worker",
    component: "handler",
    operation: "worker.invoke",
    requestId,
    orgId: event.orgId,
  });

  const summary = await runReflection(getPool(), {}, { orgId: event.orgId }, { requestId });

  log("info", "Reflection Lambda completed", {
    service: "worker",
    component: "handler",
    operation: "worker.invoke",
    requestId,
    orgId: event.orgId,
    status: summary.status,
  });

  return summary;
}
