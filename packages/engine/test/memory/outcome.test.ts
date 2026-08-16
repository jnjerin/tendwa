import { describe, expect, it } from "vitest";
import { OutcomeValidationError, validateNewOutcome, type NewOutcomeInput } from "../../src/memory/outcome.js";

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
