import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { AuditLogValidationError, recordAuditEntry } from "../../src/memory/auditLog.js";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ENTRY_ID = "22222222-2222-2222-2222-222222222222";

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    org_id: ORG_ID,
    action: "reflection.proposal_applied",
    detail: { groupIndex: 0 },
    created_at: new Date("2026-08-18T00:00:00.000Z"),
    ...overrides,
  };
}

describe("recordAuditEntry", () => {
  it("inserts a row and returns it mapped to camelCase", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [makeRow()] });
    const pool = { query } as unknown as Pool;

    const entry = await recordAuditEntry(pool, ORG_ID, "reflection.proposal_applied", { groupIndex: 0 });

    expect(entry.id).toBe(ENTRY_ID);
    expect(entry.action).toBe("reflection.proposal_applied");
    expect(entry.detail).toEqual({ groupIndex: 0 });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO agent_audit_log/);
    expect(params).toEqual([ORG_ID, "reflection.proposal_applied", { groupIndex: 0 }]);
  });

  it("accepts a null detail", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [makeRow({ detail: null })] });
    const pool = { query } as unknown as Pool;

    const entry = await recordAuditEntry(pool, ORG_ID, "reflection.proposal_skipped", null);

    expect(entry.detail).toBeNull();
  });

  it("rejects an invalid orgId", async () => {
    const pool = { query: vi.fn() } as unknown as Pool;
    await expect(recordAuditEntry(pool, "not-a-uuid", "reflection.proposal_applied", null)).rejects.toThrow(
      AuditLogValidationError,
    );
  });

  it("rejects an empty action", async () => {
    const pool = { query: vi.fn() } as unknown as Pool;
    await expect(recordAuditEntry(pool, ORG_ID, "", null)).rejects.toThrow(/action is required/);
  });
});
