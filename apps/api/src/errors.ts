import { ExperienceNotFoundError, ExperienceValidationError } from "../../../packages/engine/src/memory/experience.js";
import { OutcomeValidationError } from "../../../packages/engine/src/memory/outcome.js";
import { RetrievalValidationError } from "../../../packages/engine/src/memory/retrieve.js";
import { KnowledgeNotFoundError, KnowledgeValidationError } from "../../../packages/engine/src/memory/knowledge.js";
import { ReflectionValidationError } from "../../../packages/engine/src/memory/reflect.js";
import { AgentProposalValidationError } from "../../../packages/engine/src/agent/loop.js";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export interface ClassifiedError {
  statusCode: number;
  code: string;
  message: string;
}

/**
 * Maps every error the route layer can see to an HTTP status + stable error code, per
 * ENGINEERING.md §7's "consistent error response shape, never a 500 for a client error." The
 * engine's own validation-error and not-found-error classes remain the single source of truth
 * for why something was rejected — this only decides the HTTP-facing shape, never re-derives
 * the validation logic itself.
 */
export function classifyError(err: unknown): ClassifiedError {
  if (
    err instanceof ExperienceValidationError ||
    err instanceof OutcomeValidationError ||
    err instanceof RetrievalValidationError ||
    err instanceof KnowledgeValidationError ||
    err instanceof ReflectionValidationError ||
    err instanceof AgentProposalValidationError
  ) {
    return { statusCode: 400, code: err.name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase(), message: err.message };
  }

  if (err instanceof ExperienceNotFoundError || err instanceof KnowledgeNotFoundError) {
    return { statusCode: 404, code: "NOT_FOUND", message: err.message };
  }

  // Fastify's own errors (malformed JSON body, unsupported content-type, etc.) already carry a
  // statusCode < 500 for genuine client mistakes — passed through as-is rather than collapsed
  // to a generic 500.
  if (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    typeof (err as { statusCode: unknown }).statusCode === "number" &&
    (err as { statusCode: number }).statusCode < 500
  ) {
    const fastifyErr = err as { statusCode: number; code?: string; message?: string };
    return {
      statusCode: fastifyErr.statusCode,
      code: fastifyErr.code ?? "BAD_REQUEST",
      message: fastifyErr.message ?? "Bad request",
    };
  }

  return { statusCode: 500, code: "INTERNAL_ERROR", message: "An unexpected error occurred" };
}
