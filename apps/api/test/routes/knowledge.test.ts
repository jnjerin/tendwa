import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { KnowledgeNotFoundError, KnowledgeValidationError } from "../../../../packages/engine/src/memory/knowledge.js";

const listKnowledgeMock = vi.fn();
const getKnowledgeByIdMock = vi.fn();
vi.mock("../../../../packages/engine/src/memory/knowledge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../packages/engine/src/memory/knowledge.js")>();
  return {
    ...actual,
    listKnowledge: (...args: unknown[]) => listKnowledgeMock(...args),
    getKnowledgeById: (...args: unknown[]) => getKnowledgeByIdMock(...args),
  };
});

const { buildApp } = await import("../../src/app.js");

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const KNOWLEDGE_ID = "22222222-2222-2222-2222-222222222222";

describe("GET /knowledge", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    listKnowledgeMock.mockReset();
    getKnowledgeByIdMock.mockReset();
  });

  it("returns { items } on the happy path", async () => {
    const rows = [{ id: KNOWLEDGE_ID, orgId: ORG_ID, domain: "ops", statement: "x", confidence: 0.6 }];
    listKnowledgeMock.mockResolvedValue(rows);
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "GET", url: `/knowledge?orgId=${ORG_ID}&domain=ops&limit=10` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: rows });
    expect(listKnowledgeMock).toHaveBeenCalledWith(
      {},
      { orgId: ORG_ID, domain: "ops", limit: 10 },
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });

  it("maps KnowledgeValidationError (e.g. missing orgId) to 400", async () => {
    listKnowledgeMock.mockRejectedValue(new KnowledgeValidationError("orgId is required"));
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "GET", url: "/knowledge" });

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /knowledge/:id", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    listKnowledgeMock.mockReset();
    getKnowledgeByIdMock.mockReset();
  });

  it("returns the knowledge row on the happy path", async () => {
    const row = { id: KNOWLEDGE_ID, orgId: ORG_ID, domain: "ops", statement: "x", confidence: 0.6 };
    getKnowledgeByIdMock.mockResolvedValue(row);
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "GET", url: `/knowledge/${KNOWLEDGE_ID}?orgId=${ORG_ID}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(row);
    expect(getKnowledgeByIdMock).toHaveBeenCalledWith(
      {},
      ORG_ID,
      KNOWLEDGE_ID,
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });

  it("maps KnowledgeNotFoundError to 404", async () => {
    getKnowledgeByIdMock.mockRejectedValue(new KnowledgeNotFoundError("not found"));
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "GET", url: `/knowledge/${KNOWLEDGE_ID}?orgId=${ORG_ID}` });

    expect(response.statusCode).toBe(404);
  });
});
