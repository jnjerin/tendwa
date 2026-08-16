import { loadEmbeddingsConfig } from "../config.js";
import { log } from "../logger.js";

const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-3.5";

// Matches the VECTOR(1024) columns in the schema — passed explicitly to Voyage rather than
// relying on voyage-3.5's current default, so a future default change on Voyage's side would
// surface as a loud shape-mismatch error here instead of silently drifting from the schema.
export const EMBEDDING_DIMENSIONS = 1024;

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Distinguishes an embedding-generation failure from a database failure (ENGINEERING.md §1's
 * "Embedding generation fails" failure mode) — callers can catch this type specifically to
 * decide whether to degrade gracefully rather than treating it like a DB outage.
 */
export class EmbeddingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmbeddingError";
  }
}

interface VoyageEmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

export interface EmbedTextOptions {
  /** Voyage recommends distinguishing query vs. document text for retrieval quality. */
  inputType?: "query" | "document";
  requestId?: string;
  timeoutMs?: number;
  /** Override for tests; defaults to loadEmbeddingsConfig().voyageApiKey. */
  apiKey?: string;
}

function logFailure(errorCode: string, err: unknown, requestId: string | undefined, extra: Record<string, unknown> = {}) {
  log("error", "Voyage embedding request failed", {
    service: "engine",
    component: "memory.embeddings",
    operation: "embeddings.embed",
    requestId,
    errorCode,
    err: err as Error,
    ...extra,
  });
}

/**
 * Generates a single embedding via Voyage AI's voyage-3.5 model. Every failure mode — timeout,
 * non-2xx response, or a response of unexpected shape — is classified, logged, and raised as an
 * EmbeddingError rather than left to surface as a generic fetch rejection, so callers can tell
 * "embeddings are unavailable" apart from "the database is unavailable" (ENGINEERING.md §1).
 */
export async function embedText(text: string, options: EmbedTextOptions = {}): Promise<number[]> {
  const apiKey = options.apiKey ?? loadEmbeddingsConfig().voyageApiKey;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(VOYAGE_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        input: [text],
        model: VOYAGE_MODEL,
        output_dimension: EMBEDDING_DIMENSIONS,
        ...(options.inputType ? { input_type: options.inputType } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    const errorCode = timedOut ? "EMBEDDING_TIMEOUT" : "EMBEDDING_REQUEST_FAILED";
    logFailure(errorCode, err, options.requestId);
    throw new EmbeddingError(timedOut ? "Voyage embedding request timed out" : "Voyage embedding request failed", {
      cause: err,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const err = new EmbeddingError(`Voyage API returned ${response.status}: ${body.slice(0, 500)}`);
    logFailure("EMBEDDING_API_ERROR", err, options.requestId, { status: response.status });
    throw err;
  }

  const payload = (await response.json()) as VoyageEmbeddingResponse;
  const embedding = payload.data?.[0]?.embedding;
  if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
    const err = new EmbeddingError(
      `Voyage API returned an embedding of unexpected shape (expected ${EMBEDDING_DIMENSIONS} dimensions, got ${embedding?.length ?? "none"})`,
    );
    logFailure("EMBEDDING_SHAPE_INVALID", err, options.requestId);
    throw err;
  }

  return embedding;
}
