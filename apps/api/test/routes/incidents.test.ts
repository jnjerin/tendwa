import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { ExperienceNotFoundError, ExperienceValidationError } from "../../../../packages/engine/src/memory/experience.js";
import { OutcomeValidationError } from "../../../../packages/engine/src/memory/outcome.js";

const recordExperienceMock = vi.fn();
const getExperienceByIdMock = vi.fn();
vi.mock("../../../../packages/engine/src/memory/experience.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../packages/engine/src/memory/experience.js")>();
  return {
    ...actual,
    recordExperience: (...args: unknown[]) => recordExperienceMock(...args),
    getExperienceById: (...args: unknown[]) => getExperienceByIdMock(...args),
  };
});

const recordOutcomeMock = vi.fn();
const getOutcomeByExperienceIdMock = vi.fn();
vi.mock("../../../../packages/engine/src/memory/outcome.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../packages/engine/src/memory/outcome.js")>();
  return {
    ...actual,
    recordOutcome: (...args: unknown[]) => recordOutcomeMock(...args),
    getOutcomeByExperienceId: (...args: unknown[]) => getOutcomeByExperienceIdMock(...args),
  };
});

const runAgentLoopMock = vi.fn();
vi.mock("../../../../packages/engine/src/agent/loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../packages/engine/src/agent/loop.js")>();
  return { ...actual, runAgentLoop: (...args: unknown[]) => runAgentLoopMock(...args) };
});

const recordAuditEntryMock = vi.fn();
vi.mock("../../../../packages/engine/src/memory/auditLog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../packages/engine/src/memory/auditLog.js")>();
  return { ...actual, recordAuditEntry: (...args: unknown[]) => recordAuditEntryMock(...args) };
});

const { buildApp } = await import("../../src/app.js");

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const EXPERIENCE_ID = "22222222-2222-2222-2222-222222222222";

function resetAllMocks() {
  recordExperienceMock.mockReset();
  getExperienceByIdMock.mockReset();
  recordOutcomeMock.mockReset();
  getOutcomeByExperienceIdMock.mockReset();
  runAgentLoopMock.mockReset();
  recordAuditEntryMock.mockReset();
}

const EXPERIENCE = {
  id: EXPERIENCE_ID,
  orgId: ORG_ID,
  domain: "incident-response",
  content: "Database connection pool exhausted under load.",
  metadata: null,
  occurredAt: new Date("2026-08-15T10:00:00Z"),
  createdAt: new Date("2026-08-15T10:00:00Z"),
};

describe("POST /incidents", () => {
  let app: FastifyInstance | undefined;

  const INCIDENT_PAYLOAD = {
    orgId: ORG_ID,
    title: "Database pool exhausted",
    description: "Connections maxed out under load.",
    service: "orders-api",
    environment: "production",
    severity: "sev2",
    occurredAt: "2026-08-15T10:00:00Z",
  };

  afterEach(async () => {
    await app?.close();
    app = undefined;
    resetAllMocks();
  });

  it("translates an incident-shaped body through incidentToExperience before calling recordExperience", async () => {
    recordExperienceMock.mockResolvedValue(EXPERIENCE);
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "POST", url: "/incidents", payload: INCIDENT_PAYLOAD });

    expect(response.statusCode).toBe(201);
    expect(recordExperienceMock).toHaveBeenCalledWith(
      {},
      {
        orgId: ORG_ID,
        domain: "incident-response",
        content: "Database pool exhausted. Connections maxed out under load.",
        occurredAt: "2026-08-15T10:00:00Z",
        metadata: { service: "orders-api", environment: "production", severity: "sev2" },
      },
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });

  it("includes sourceUrl in metadata only when supplied", async () => {
    recordExperienceMock.mockResolvedValue(EXPERIENCE);
    app = await buildApp({} as unknown as Pool);

    await app.inject({
      method: "POST",
      url: "/incidents",
      payload: { ...INCIDENT_PAYLOAD, sourceUrl: "https://postmortems.example.com/123" },
    });

    const [, input] = recordExperienceMock.mock.calls[0] as [unknown, { metadata: Record<string, unknown> }];
    expect(input.metadata).toEqual({
      service: "orders-api",
      environment: "production",
      severity: "sev2",
      sourceUrl: "https://postmortems.example.com/123",
    });
  });

  it("maps ExperienceValidationError to 400 (e.g. missing description produces empty content)", async () => {
    recordExperienceMock.mockRejectedValue(new ExperienceValidationError("content is required"));
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "POST", url: "/incidents", payload: { orgId: ORG_ID } });

    expect(response.statusCode).toBe(400);
  });

  it("degrades an empty/malformed body to a validation error instead of a raw 500", async () => {
    recordExperienceMock.mockRejectedValue(new ExperienceValidationError("orgId is required"));
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "POST", url: "/incidents" });

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /incidents/:id", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    resetAllMocks();
  });

  it("returns the experience on the happy path", async () => {
    getExperienceByIdMock.mockResolvedValue(EXPERIENCE);
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "GET", url: `/incidents/${EXPERIENCE_ID}?orgId=${ORG_ID}` });

    expect(response.statusCode).toBe(200);
    expect(getExperienceByIdMock).toHaveBeenCalledWith(
      {},
      ORG_ID,
      EXPERIENCE_ID,
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });

  it("maps ExperienceNotFoundError to 404", async () => {
    getExperienceByIdMock.mockRejectedValue(new ExperienceNotFoundError("not found"));
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "GET", url: `/incidents/${EXPERIENCE_ID}?orgId=${ORG_ID}` });

    expect(response.statusCode).toBe(404);
  });
});

describe("POST /incidents/:id/analyze", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    resetAllMocks();
  });

  it("fetches the experience, runs the agent loop, and records an audit entry on the ok path", async () => {
    getExperienceByIdMock.mockResolvedValue(EXPERIENCE);
    const result = { status: "ok", retrieval: { knowledge: [], experiences: [], knowledgeUnavailable: false }, proposal: { likelyCause: "x", recommendation: "y", confidence: 0.7, citedExperienceIds: [], citedKnowledgeIds: [], knowledgeUnavailable: false } };
    runAgentLoopMock.mockResolvedValue(result);
    recordAuditEntryMock.mockResolvedValue({});
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "POST", url: `/incidents/${EXPERIENCE_ID}/analyze`, payload: { orgId: ORG_ID } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
    expect(runAgentLoopMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ orgId: ORG_ID, query: EXPERIENCE.content, domain: EXPERIENCE.domain }),
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    expect(recordAuditEntryMock).toHaveBeenCalledWith(
      {},
      ORG_ID,
      "agent.analyze",
      expect.objectContaining({ experienceId: EXPERIENCE_ID, status: "ok" }),
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });

  it("still records an audit entry when the agent loop degrades to unavailable", async () => {
    getExperienceByIdMock.mockResolvedValue(EXPERIENCE);
    const result = { status: "unavailable", retrieval: { knowledge: [], experiences: [], knowledgeUnavailable: false }, reason: "Claude timed out" };
    runAgentLoopMock.mockResolvedValue(result);
    recordAuditEntryMock.mockResolvedValue({});
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "POST", url: `/incidents/${EXPERIENCE_ID}/analyze`, payload: { orgId: ORG_ID } });

    expect(response.statusCode).toBe(200);
    expect(recordAuditEntryMock).toHaveBeenCalledWith(
      {},
      ORG_ID,
      "agent.analyze",
      expect.objectContaining({ status: "unavailable", reason: "Claude timed out" }),
      expect.anything(),
    );
  });

  it("404s and never calls the agent loop or records an audit entry when the experience isn't found", async () => {
    getExperienceByIdMock.mockRejectedValue(new ExperienceNotFoundError("not found"));
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "POST", url: `/incidents/${EXPERIENCE_ID}/analyze`, payload: { orgId: ORG_ID } });

    expect(response.statusCode).toBe(404);
    expect(runAgentLoopMock).not.toHaveBeenCalled();
    expect(recordAuditEntryMock).not.toHaveBeenCalled();
  });

  it("still returns the agent result (not a 500) when recordAuditEntry itself fails", async () => {
    getExperienceByIdMock.mockResolvedValue(EXPERIENCE);
    const result = { status: "ok", retrieval: { knowledge: [], experiences: [], knowledgeUnavailable: false }, proposal: { likelyCause: "x", recommendation: "y", confidence: 0.7, citedExperienceIds: [], citedKnowledgeIds: [], knowledgeUnavailable: false } };
    runAgentLoopMock.mockResolvedValue(result);
    recordAuditEntryMock.mockRejectedValue(new Error("connection terminated"));
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "POST", url: `/incidents/${EXPERIENCE_ID}/analyze`, payload: { orgId: ORG_ID } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
  });

  it("uses an explicit query from the body instead of the experience's content when supplied", async () => {
    getExperienceByIdMock.mockResolvedValue(EXPERIENCE);
    runAgentLoopMock.mockResolvedValue({ status: "unavailable", retrieval: { knowledge: [], experiences: [], knowledgeUnavailable: false }, reason: "x" });
    recordAuditEntryMock.mockResolvedValue({});
    app = await buildApp({} as unknown as Pool);

    await app.inject({
      method: "POST",
      url: `/incidents/${EXPERIENCE_ID}/analyze`,
      payload: { orgId: ORG_ID, query: "a different situation entirely" },
    });

    expect(runAgentLoopMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ query: "a different situation entirely" }),
      expect.anything(),
    );
  });
});

describe("POST /incidents/:id/outcome", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    resetAllMocks();
  });

  it("verifies the experience exists and belongs to orgId before recording the outcome", async () => {
    getExperienceByIdMock.mockResolvedValue(EXPERIENCE);
    getOutcomeByExperienceIdMock.mockResolvedValue(null);
    const outcome = { id: "33333333-3333-3333-3333-333333333333", orgId: ORG_ID, experienceId: EXPERIENCE_ID, status: "resolved", rootCause: null, actionTaken: "restarted", result: "fixed", createdAt: new Date() };
    recordOutcomeMock.mockResolvedValue(outcome);
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({
      method: "POST",
      url: `/incidents/${EXPERIENCE_ID}/outcome`,
      payload: { orgId: ORG_ID, status: "resolved", actionTaken: "restarted", result: "fixed" },
    });

    expect(response.statusCode).toBe(201);
    expect(getExperienceByIdMock).toHaveBeenCalledWith({}, ORG_ID, EXPERIENCE_ID, expect.anything());
    expect(recordOutcomeMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ orgId: ORG_ID, experienceId: EXPERIENCE_ID }),
      expect.anything(),
    );
  });

  it("404s and never calls recordOutcome when the experience doesn't exist or isn't owned by orgId", async () => {
    getExperienceByIdMock.mockRejectedValue(new ExperienceNotFoundError("not found"));
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({
      method: "POST",
      url: `/incidents/${EXPERIENCE_ID}/outcome`,
      payload: { orgId: ORG_ID, status: "resolved", actionTaken: "restarted", result: "fixed" },
    });

    expect(response.statusCode).toBe(404);
    expect(recordOutcomeMock).not.toHaveBeenCalled();
  });

  it("returns 409 and never calls recordOutcome when an outcome already exists for this experience", async () => {
    getExperienceByIdMock.mockResolvedValue(EXPERIENCE);
    getOutcomeByExperienceIdMock.mockResolvedValue({
      id: "44444444-4444-4444-4444-444444444444",
      orgId: ORG_ID,
      experienceId: EXPERIENCE_ID,
      status: "resolved",
      rootCause: null,
      actionTaken: "restarted",
      result: "fixed",
      createdAt: new Date(),
    });
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({
      method: "POST",
      url: `/incidents/${EXPERIENCE_ID}/outcome`,
      payload: { orgId: ORG_ID, status: "resolved", actionTaken: "restarted", result: "fixed" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "OUTCOME_ALREADY_RECORDED" } });
    expect(recordOutcomeMock).not.toHaveBeenCalled();
  });

  it("maps OutcomeValidationError to 400", async () => {
    getExperienceByIdMock.mockResolvedValue(EXPERIENCE);
    getOutcomeByExperienceIdMock.mockResolvedValue(null);
    recordOutcomeMock.mockRejectedValue(new OutcomeValidationError("status is required"));
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({
      method: "POST",
      url: `/incidents/${EXPERIENCE_ID}/outcome`,
      payload: { orgId: ORG_ID, actionTaken: "x", result: "y" },
    });

    expect(response.statusCode).toBe(400);
  });
});
