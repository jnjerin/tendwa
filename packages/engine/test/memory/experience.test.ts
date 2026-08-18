import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  ExperienceNotFoundError,
  ExperienceValidationError,
  getExperienceById,
  validateNewExperience,
  type NewExperienceInput,
} from "../../src/memory/experience.js";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const EXPERIENCE_ID = "22222222-2222-2222-2222-222222222222";

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EXPERIENCE_ID,
    org_id: ORG_ID,
    domain: "incident-response",
    content: "Database connection pool exhausted under load.",
    metadata: null,
    occurred_at: new Date("2026-08-15T10:00:00Z"),
    created_at: new Date("2026-08-15T10:00:00Z"),
    ...overrides,
  };
}

const VALID_INPUT: NewExperienceInput = {
  orgId: "11111111-1111-1111-1111-111111111111",
  domain: "incident-response",
  content: "Database connection pool exhausted under load.",
  occurredAt: "2026-08-15T10:00:00Z",
};

describe("validateNewExperience", () => {
  it("accepts a fully-populated input and normalizes occurredAt to a Date", () => {
    const occurredAt = validateNewExperience(VALID_INPUT);
    expect(occurredAt).toBeInstanceOf(Date);
    expect(occurredAt.toISOString()).toBe("2026-08-15T10:00:00.000Z");
  });

  it("passes a Date instance through unchanged", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    const occurredAt = validateNewExperience({ ...VALID_INPUT, occurredAt: date });
    expect(occurredAt).toBe(date);
  });

  it("rejects a missing orgId", () => {
    expect(() => validateNewExperience({ ...VALID_INPUT, orgId: "" })).toThrow(ExperienceValidationError);
    expect(() => validateNewExperience({ ...VALID_INPUT, orgId: "" })).toThrow(/orgId is required/);
  });

  it("rejects an orgId that isn't a UUID", () => {
    expect(() => validateNewExperience({ ...VALID_INPUT, orgId: "not-a-uuid" })).toThrow(/orgId must be a UUID/);
  });

  it("rejects a missing domain", () => {
    expect(() => validateNewExperience({ ...VALID_INPUT, domain: "   " })).toThrow(/domain is required/);
  });

  it("rejects a missing content", () => {
    expect(() => validateNewExperience({ ...VALID_INPUT, content: "" })).toThrow(/content is required/);
  });

  it("rejects a missing occurredAt", () => {
    // @ts-expect-error — deliberately omitting a required field to test the runtime guard
    expect(() => validateNewExperience({ ...VALID_INPUT, occurredAt: undefined })).toThrow(/occurredAt is required/);
  });

  it("rejects an occurredAt that doesn't parse to a valid date", () => {
    expect(() => validateNewExperience({ ...VALID_INPUT, occurredAt: "not-a-date" })).toThrow(
      /occurredAt must be a valid date/,
    );
  });
});

describe("getExperienceById", () => {
  it("returns the mapped row when found", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [makeRow()] });
    const pool = { query } as unknown as Pool;

    const experience = await getExperienceById(pool, ORG_ID, EXPERIENCE_ID);

    expect(experience.id).toBe(EXPERIENCE_ID);
    expect(experience.orgId).toBe(ORG_ID);
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([ORG_ID, EXPERIENCE_ID]);
  });

  it("throws ExperienceNotFoundError when the org-scoped row doesn't exist", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;

    await expect(getExperienceById(pool, ORG_ID, EXPERIENCE_ID)).rejects.toThrow(ExperienceNotFoundError);
  });

  it("rejects an invalid orgId before querying", async () => {
    const query = vi.fn();
    const pool = { query } as unknown as Pool;

    await expect(getExperienceById(pool, "not-a-uuid", EXPERIENCE_ID)).rejects.toThrow(ExperienceValidationError);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects an invalid experienceId before querying", async () => {
    const query = vi.fn();
    const pool = { query } as unknown as Pool;

    await expect(getExperienceById(pool, ORG_ID, "not-a-uuid")).rejects.toThrow(ExperienceValidationError);
    expect(query).not.toHaveBeenCalled();
  });
});
