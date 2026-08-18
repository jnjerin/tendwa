import type { Pool } from "pg";
import { log } from "../logger.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same retry stance as every other write module in this codebase: a 40001 guarantees nothing
// committed, so bounded retry is safe.
export const MAX_SERIALIZATION_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 100;

export interface AuditLogEntry {
  id: string;
  orgId: string;
  action: string;
  detail: Record<string, unknown> | null;
  createdAt: Date;
}

interface AuditLogDbRow {
  id: string;
  org_id: string;
  action: string;
  detail: Record<string, unknown> | null;
  created_at: Date;
}

export class AuditLogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditLogValidationError";
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function mapRow(row: AuditLogDbRow): AuditLogEntry {
  return {
    id: row.id,
    orgId: row.org_id,
    action: row.action,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

function isSerializationConflict(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "40001";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Writes one durable record of an agent decision to agent_audit_log — this is the mechanism
 * CLAUDE.md rule 4 requires ("every reflection run logs both the proposal and what was actually
 * applied") and that DECISIONS.md's 2026-08-17 entry on agent/loop.ts explicitly named as
 * belonging to the reflection job specifically, not to agent/loop.ts itself. `detail` is stored
 * as-is in the JSONB column — callers pass whatever shape is useful for that action (a rejected
 * proposal's validation error, an applied proposal's resulting knowledgeId, etc.).
 */
export async function recordAuditEntry(
  pool: Pool,
  orgId: string,
  action: string,
  detail: Record<string, unknown> | null,
  context: { requestId?: string } = {},
): Promise<AuditLogEntry> {
  if (!isNonEmptyString(orgId)) {
    throw new AuditLogValidationError("orgId is required");
  }
  if (!UUID_RE.test(orgId)) {
    throw new AuditLogValidationError("orgId must be a UUID");
  }
  if (!isNonEmptyString(action)) {
    throw new AuditLogValidationError("action is required");
  }

  for (let attempt = 1; ; attempt++) {
    try {
      const result = await pool.query<AuditLogDbRow>(
        `INSERT INTO agent_audit_log (org_id, action, detail)
         VALUES ($1, $2, $3)
         RETURNING id, org_id, action, detail, created_at`,
        [orgId, action.trim(), detail],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error("INSERT ... RETURNING produced no row");
      }
      const entry = mapRow(row);
      log("info", "Recorded audit log entry", {
        service: "engine",
        component: "memory.auditLog",
        operation: "auditLog.record",
        requestId: context.requestId,
        orgId: entry.orgId,
        auditLogId: entry.id,
        action: entry.action,
      });
      return entry;
    } catch (err) {
      const conflict = isSerializationConflict(err);
      const retryable = conflict && attempt < MAX_SERIALIZATION_RETRIES;
      log("error", retryable ? "Audit log write hit a serialization conflict, retrying" : "Failed to write audit log entry", {
        service: "engine",
        component: "memory.auditLog",
        operation: "auditLog.record",
        requestId: context.requestId,
        orgId,
        action,
        errorCode: conflict ? "AUDIT_LOG_SERIALIZATION_CONFLICT" : "AUDIT_LOG_WRITE_FAILED",
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
