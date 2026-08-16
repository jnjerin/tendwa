import { describe, expect, it } from "vitest";
import { ExperienceValidationError, validateNewExperience, type NewExperienceInput } from "../../src/memory/experience.js";

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
