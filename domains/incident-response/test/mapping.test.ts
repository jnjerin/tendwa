import { describe, expect, it } from "vitest";
import { incidentHasOutcome, incidentToExperience, incidentToOutcome, type Incident } from "../mapping.js";

const BASE_INCIDENT: Incident = {
  title: "",
  description: "Payments API latency spiked to roughly 8x baseline 12 minutes after a routine deploy.",
  service: "payments-api",
  environment: "production",
  severity: "high",
  occurredAt: "2026-06-10T16:05:00Z",
};

const ORG_ID = "11111111-1111-1111-1111-111111111111";

describe("incidentToExperience", () => {
  it("uses description alone as content when title is empty", () => {
    const experience = incidentToExperience(BASE_INCIDENT, ORG_ID);
    expect(experience.content).toBe(BASE_INCIDENT.description);
  });

  it("combines title and description when title is present", () => {
    const experience = incidentToExperience({ ...BASE_INCIDENT, title: "Payments latency spike" }, ORG_ID);
    expect(experience.content).toBe(
      "Payments latency spike. Payments API latency spiked to roughly 8x baseline 12 minutes after a routine deploy.",
    );
  });

  it("fixes domain to incident-response, regardless of input", () => {
    const experience = incidentToExperience(BASE_INCIDENT, ORG_ID);
    expect(experience.domain).toBe("incident-response");
  });

  it("passes orgId and occurredAt through unchanged", () => {
    const experience = incidentToExperience(BASE_INCIDENT, ORG_ID);
    expect(experience.orgId).toBe(ORG_ID);
    expect(experience.occurredAt).toBe(BASE_INCIDENT.occurredAt);
  });

  it("carries service/environment/severity into metadata JSONB, never as top-level fields", () => {
    const experience = incidentToExperience(BASE_INCIDENT, ORG_ID);
    expect(experience.metadata).toEqual({
      service: "payments-api",
      environment: "production",
      severity: "high",
    });
    expect(experience).not.toHaveProperty("service");
    expect(experience).not.toHaveProperty("severity");
  });

  it("includes sourceUrl in metadata only when present", () => {
    const withSource = incidentToExperience({ ...BASE_INCIDENT, sourceUrl: "public postmortem — example" }, ORG_ID);
    expect(withSource.metadata).toMatchObject({ sourceUrl: "public postmortem — example" });

    const withoutSource = incidentToExperience(BASE_INCIDENT, ORG_ID);
    expect(withoutSource.metadata).not.toHaveProperty("sourceUrl");
  });
});

describe("incidentHasOutcome", () => {
  it("is false when actionTaken and result are both absent (a FRESH incident)", () => {
    expect(incidentHasOutcome(BASE_INCIDENT)).toBe(false);
  });

  it("is false when only one of actionTaken/result is present", () => {
    expect(incidentHasOutcome({ ...BASE_INCIDENT, actionTaken: "raised pool size" })).toBe(false);
    expect(incidentHasOutcome({ ...BASE_INCIDENT, result: "latency returned to baseline" })).toBe(false);
  });

  it("is false when actionTaken/result are present but blank", () => {
    expect(incidentHasOutcome({ ...BASE_INCIDENT, actionTaken: "   ", result: "latency returned to baseline" })).toBe(
      false,
    );
  });

  it("is true when both actionTaken and result are present and non-empty", () => {
    expect(
      incidentHasOutcome({ ...BASE_INCIDENT, actionTaken: "raised pool size", result: "latency returned to baseline" }),
    ).toBe(true);
  });
});

describe("incidentToOutcome", () => {
  const RESOLVED_INCIDENT = {
    ...BASE_INCIDENT,
    rootCause: "connection pool size left at default despite traffic growth",
    actionTaken: "raised pool size; added pool-saturation alerting",
    result: "latency returned to baseline within 15 minutes",
  };
  const EXPERIENCE_ID = "22222222-2222-2222-2222-222222222222";

  it("maps rootCause/actionTaken/result through, and always sets status to resolved", () => {
    const outcome = incidentToOutcome(RESOLVED_INCIDENT, EXPERIENCE_ID, ORG_ID);
    expect(outcome).toEqual({
      orgId: ORG_ID,
      experienceId: EXPERIENCE_ID,
      status: "resolved",
      actionTaken: "raised pool size; added pool-saturation alerting",
      result: "latency returned to baseline within 15 minutes",
      rootCause: "connection pool size left at default despite traffic growth",
    });
  });

  it("maps a missing rootCause to null rather than undefined", () => {
    const { rootCause, ...withoutRootCause } = RESOLVED_INCIDENT;
    const outcome = incidentToOutcome(withoutRootCause, EXPERIENCE_ID, ORG_ID);
    expect(outcome.rootCause).toBeNull();
  });
});
