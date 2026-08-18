import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  OutcomeValidationError,
  getOutcomeByExperienceId,
  validateNewOutcome,
  type NewOutcomeInput,
} from "../../src/memory/outcome.js";

const VALID_INPUT: NewOutcomeInput = {
  orgId: "11111111-1111-1111-1111-111111111111",
  experienceId: "22222222-2222-2222-2222-222222222222",
  status: "resolved",
  actionTaken: "Raised the connection pool size and added saturation alerting.",
  result: "Latency returned to baseline within 15 minutes.",
};

describe("validateNewOutcome", () => {
  it("accepts a fully-populated input without throwing", () => {
    expect(() => validateNewOutcome(VALID_INPUT)).not.toThrow();
  });

  it("accepts a missing rootCause — it's optional", () => {
    const { rootCause, ...withoutRootCause } = { ...VALID_INPUT, rootCause: undefined };
    expect(() => validateNewOutcome(withoutRootCause)).not.toThrow();
  });

  it("rejects a missing orgId", () => {
    expect(() => validateNewOutcome({ ...VALID_INPUT, orgId: "" })).toThrow(OutcomeValidationError);
    expect(() => validateNewOutcome({ ...VALID_INPUT, orgId: "" })).toThrow(/orgId is required/);
  });

  it("rejects an orgId that isn't a UUID", () => {
    expect(() => validateNewOutcome({ ...VALID_INPUT, orgId: "not-a-uuid" })).toThrow(/orgId must be a UUID/);
  });

  it("rejects a missing experienceId", () => {
    expect(() => validateNewOutcome({ ...VALID_INPUT, experienceId: "" })).toThrow(/experienceId is required/);
  });

  it("rejects an experienceId that isn't a UUID", () => {
    expect(() => validateNewOutcome({ ...VALID_INPUT, experienceId: "not-a-uuid" })).toThrow(
      /experienceId must be a UUID/,
    );
  });

  it("rejects a missing status", () => {
    expect(() => validateNewOutcome({ ...VALID_INPUT, status: "   " })).toThrow(/status is required/);
  });

  it("rejects a missing actionTaken", () => {
    expect(() => validateNewOutcome({ ...VALID_INPUT, actionTaken: "" })).toThrow(/actionTaken is required/);
  });

  it("rejects a missing result", () => {
    expect(() => validateNewOutcome({ ...VALID_INPUT, result: "" })).toThrow(/result is required/);
  });
});

describe("getOutcomeByExperienceId", () => {
  it("returns the mapped row when an outcome already exists", async () => {
    const row = {
      id: "33333333-3333-3333-3333-333333333333",
      org_id: VALID_INPUT.orgId,
      experience_id: VALID_INPUT.experienceId,
      status: "resolved",
      root_cause: null,
      action_taken: VALID_INPUT.actionTaken,
      result: VALID_INPUT.result,
      created_at: new Date("2026-08-15T10:00:00Z"),
    };
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const pool = { query } as unknown as Pool;

    const outcome = await getOutcomeByExperienceId(pool, VALID_INPUT.orgId, VALID_INPUT.experienceId);

    expect(outcome?.id).toBe(row.id);
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([VALID_INPUT.orgId, VALID_INPUT.experienceId]);
  });

  it("scopes the lookup by both org_id and experience_id, so a different org's outcome for the same experienceId is never returned", async () => {
    const OTHER_ORG_ID = "99999999-9999-9999-9999-999999999999";
    // The mock doesn't itself enforce filtering (a real CockroachDB WHERE clause would) — this
    // asserts the query text/params actually scope on org_id, which is what makes that real
    // filtering possible. A query that only bound experience_id would let this same mock setup
    // silently return another org's row; matching this codebase's established convention for
    // proving org-scoping at the mocked-Pool unit level (see reinforceKnowledge's test asserting
    // exact param order in knowledge.test.ts).
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;

    const outcome = await getOutcomeByExperienceId(pool, OTHER_ORG_ID, VALID_INPUT.experienceId);

    expect(outcome).toBeNull();
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE\s+org_id\s*=\s*\$1\s+AND\s+experience_id\s*=\s*\$2/);
    expect(params).toEqual([OTHER_ORG_ID, VALID_INPUT.experienceId]);
    // Confirms org_id is a real, independently-bound filter — not folded into or shadowed by
    // the experience_id parameter.
    expect(params[0]).not.toEqual(params[1]);
  });

  it("returns null (not a thrown error) when no outcome exists yet", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;

    const outcome = await getOutcomeByExperienceId(pool, VALID_INPUT.orgId, VALID_INPUT.experienceId);

    expect(outcome).toBeNull();
  });

  it("rejects an invalid experienceId before querying", async () => {
    const query = vi.fn();
    const pool = { query } as unknown as Pool;

    await expect(getOutcomeByExperienceId(pool, VALID_INPUT.orgId, "not-a-uuid")).rejects.toThrow(
      OutcomeValidationError,
    );
    expect(query).not.toHaveBeenCalled();
  });
});
