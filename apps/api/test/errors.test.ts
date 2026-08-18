import { describe, expect, it } from "vitest";
import { ExperienceNotFoundError, ExperienceValidationError } from "../../../packages/engine/src/memory/experience.js";
import { KnowledgeNotFoundError, KnowledgeValidationError } from "../../../packages/engine/src/memory/knowledge.js";
import { RetrievalValidationError } from "../../../packages/engine/src/memory/retrieve.js";
import { classifyError } from "../src/errors.js";

describe("classifyError", () => {
  it("maps a *ValidationError to 400 with its own message", () => {
    const result = classifyError(new ExperienceValidationError("content is required"));
    expect(result).toEqual({ statusCode: 400, code: "EXPERIENCE_VALIDATION_ERROR", message: "content is required" });
  });

  it("maps a different *ValidationError class independently", () => {
    const result = classifyError(new KnowledgeValidationError("orgId is required"));
    expect(result.statusCode).toBe(400);
    expect(result.code).toBe("KNOWLEDGE_VALIDATION_ERROR");
  });

  it("maps RetrievalValidationError to 400", () => {
    const result = classifyError(new RetrievalValidationError("query is required"));
    expect(result.statusCode).toBe(400);
  });

  it("maps a *NotFoundError to 404 without leaking a distinct code per resource", () => {
    expect(classifyError(new ExperienceNotFoundError("not found")).statusCode).toBe(404);
    expect(classifyError(new KnowledgeNotFoundError("not found")).statusCode).toBe(404);
  });

  it("passes through a Fastify-shaped error with statusCode < 500", () => {
    const fastifyErr = Object.assign(new Error("Body is not valid JSON"), { statusCode: 400, code: "FST_ERR_CTP_INVALID_JSON" });
    const result = classifyError(fastifyErr);
    expect(result).toEqual({ statusCode: 400, code: "FST_ERR_CTP_INVALID_JSON", message: "Body is not valid JSON" });
  });

  it("collapses an unclassified error to a generic 500 without leaking its message", () => {
    const result = classifyError(new Error("connection terminated unexpectedly at internal_db_host:5432"));
    expect(result.statusCode).toBe(500);
    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result.message).not.toMatch(/internal_db_host/);
  });

  it("collapses a non-Error thrown value to a generic 500", () => {
    const result = classifyError("a plain string throw");
    expect(result).toEqual({ statusCode: 500, code: "INTERNAL_ERROR", message: "An unexpected error occurred" });
  });
});
