import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { ReflectionValidationError } from "../../../../packages/engine/src/memory/reflect.js";

const runReflectionMock = vi.fn();
vi.mock("../../../../packages/engine/src/memory/reflect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../packages/engine/src/memory/reflect.js")>();
  return { ...actual, runReflection: (...args: unknown[]) => runReflectionMock(...args) };
});

const { buildApp } = await import("../../src/app.js");

const ORG_ID = "11111111-1111-1111-1111-111111111111";

describe("POST /reflection/run", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    runReflectionMock.mockReset();
  });

  it("returns the reflection summary on the happy path", async () => {
    const summary = { status: "completed", orgId: ORG_ID, groupsProcessed: 2, groupsApplied: 1, groupsRejected: 0, groupsSkipped: 1 };
    runReflectionMock.mockResolvedValue(summary);
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "POST", url: "/reflection/run", payload: { orgId: ORG_ID } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(summary);
    expect(runReflectionMock).toHaveBeenCalledWith(
      {},
      {},
      { orgId: ORG_ID },
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });

  it("maps ReflectionValidationError (missing orgId) to 400", async () => {
    runReflectionMock.mockRejectedValue(new ReflectionValidationError("orgId is required and must be a UUID"));
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "POST", url: "/reflection/run", payload: {} });

    expect(response.statusCode).toBe(400);
  });

  it("does not silently swallow an empty body", async () => {
    runReflectionMock.mockRejectedValue(new ReflectionValidationError("orgId is required and must be a UUID"));
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "POST", url: "/reflection/run" });

    expect(response.statusCode).toBe(400);
  });

  it("maps an unclassified engine error to a generic 500", async () => {
    runReflectionMock.mockRejectedValue(new Error("anthropic timeout"));
    app = await buildApp({} as unknown as Pool);

    const response = await app.inject({ method: "POST", url: "/reflection/run", payload: { orgId: ORG_ID } });

    expect(response.statusCode).toBe(500);
  });
});
