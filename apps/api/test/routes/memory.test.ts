import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { RetrievalValidationError } from "../../../../packages/engine/src/memory/retrieve.js";

const retrieveMemoryMock = vi.fn();
vi.mock("../../../../packages/engine/src/memory/retrieve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../packages/engine/src/memory/retrieve.js")>();
  return { ...actual, retrieveMemory: (...args: unknown[]) => retrieveMemoryMock(...args) };
});

const { buildApp } = await import("../../src/app.js");

const ORG_ID = "11111111-1111-1111-1111-111111111111";

describe("GET /memory/search", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    retrieveMemoryMock.mockReset();
  });

  it("returns the retrieval result on the happy path", async () => {
    const retrieval = { knowledge: [], experiences: [], knowledgeUnavailable: false };
    retrieveMemoryMock.mockResolvedValue(retrieval);
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "GET", url: `/memory/search?orgId=${ORG_ID}&query=pool+exhausted&limit=5` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(retrieval);
    expect(retrieveMemoryMock).toHaveBeenCalledWith(
      {},
      { orgId: ORG_ID, query: "pool exhausted", domain: undefined, limit: 5 },
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });

  it("maps RetrievalValidationError (e.g. missing query) to 400", async () => {
    retrieveMemoryMock.mockRejectedValue(new RetrievalValidationError("query is required"));
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "GET", url: `/memory/search?orgId=${ORG_ID}` });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { message: "query is required" } });
  });

  it("maps an unclassified engine error to a generic 500", async () => {
    retrieveMemoryMock.mockRejectedValue(new Error("db offline"));
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "GET", url: `/memory/search?orgId=${ORG_ID}&query=x` });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    expect(response.body).not.toMatch(/db offline/);
  });
});
