import type { Context } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createPoolMock = vi.fn();
vi.mock("../../../packages/engine/src/db/client.js", () => ({
  createPool: (...args: unknown[]) => createPoolMock(...args),
}));

const runReflectionMock = vi.fn();
vi.mock("../../../packages/engine/src/memory/reflect.js", () => ({
  runReflection: (...args: unknown[]) => runReflectionMock(...args),
}));

const ORG_ID = "11111111-1111-1111-1111-111111111111";

const FAKE_POOL = { query: vi.fn() };

const FAKE_CONTEXT = { awsRequestId: "test-request-id" } as Context;

// handler.ts caches its Pool in a module-scope variable (deliberately — see its own comment on
// warm-invocation reuse), so each test re-imports a fresh module instance via resetModules()
// rather than sharing one import across the file — otherwise an earlier test's first call would
// silently satisfy every later test's cache, and no test could isolate "does this call
// createPool" from "was it already cached by a previous test."
let handler: typeof import("../src/handler.js").handler;

beforeEach(async () => {
  vi.resetModules();
  createPoolMock.mockReset();
  runReflectionMock.mockReset();
  createPoolMock.mockReturnValue(FAKE_POOL);
  ({ handler } = await import("../src/handler.js"));
});

describe("handler", () => {
  afterEach(() => {
    createPoolMock.mockReset();
    runReflectionMock.mockReset();
  });

  it("calls runReflection with the event's orgId and the awsRequestId as requestId", async () => {
    const summary = { status: "completed", orgId: ORG_ID, groupsProcessed: 0, groupsApplied: 0, groupsRejected: 0, groupsSkipped: 0 };
    runReflectionMock.mockResolvedValue(summary);

    const result = await handler({ orgId: ORG_ID }, FAKE_CONTEXT);

    expect(result).toEqual(summary);
    expect(runReflectionMock).toHaveBeenCalledWith(FAKE_POOL, {}, { orgId: ORG_ID }, { requestId: "test-request-id" });
  });

  it("throws immediately when orgId is missing, without calling runReflection", async () => {
    await expect(handler({} as { orgId: string }, FAKE_CONTEXT)).rejects.toThrow(/orgId/);
    expect(runReflectionMock).not.toHaveBeenCalled();
  });

  it("propagates a runReflection failure rather than swallowing it", async () => {
    runReflectionMock.mockRejectedValue(new Error("Anthropic request failed"));

    await expect(handler({ orgId: ORG_ID }, FAKE_CONTEXT)).rejects.toThrow("Anthropic request failed");
  });

  it("reuses the same pool across two invocations instead of creating a fresh one each time", async () => {
    runReflectionMock.mockResolvedValue({ status: "completed", orgId: ORG_ID });

    await handler({ orgId: ORG_ID }, FAKE_CONTEXT);
    await handler({ orgId: ORG_ID }, FAKE_CONTEXT);

    expect(createPoolMock).toHaveBeenCalledTimes(1);
  });
});
