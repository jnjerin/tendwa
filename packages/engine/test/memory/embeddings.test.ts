import { afterEach, describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIMENSIONS, EmbeddingError, embedText } from "../../src/memory/embeddings.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("embedText", () => {
  it("returns the embedding from a successful response", async () => {
    const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i / EMBEDDING_DIMENSIONS);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ embedding }] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await embedText("database connection pool exhausted", { apiKey: "test-key" });

    expect(result).toEqual(embedding);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key" });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "voyage-3.5", output_dimension: EMBEDDING_DIMENSIONS, input: ["database connection pool exhausted"] });
  });

  it("includes input_type when provided", async () => {
    const embedding = new Array(EMBEDDING_DIMENSIONS).fill(0.1);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ embedding }] }));
    vi.stubGlobal("fetch", fetchMock);

    await embedText("some query", { apiKey: "test-key", inputType: "query" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.input_type).toBe("query");
  });

  it("throws EmbeddingError, not a generic error, when the request times out", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(embedText("slow query", { apiKey: "test-key", timeoutMs: 10 })).rejects.toThrow(EmbeddingError);
  });

  it("throws EmbeddingError on a non-2xx response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("invalid api key", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(embedText("text", { apiKey: "bad-key" })).rejects.toThrow(/Voyage API returned 401/);
  });

  it("throws EmbeddingError when the response has no embedding of the expected shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ embedding: [1, 2, 3] }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(embedText("text", { apiKey: "test-key" })).rejects.toThrow(/unexpected shape/);
  });

  it("throws EmbeddingError when the response has no data at all", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(embedText("text", { apiKey: "test-key" })).rejects.toThrow(EmbeddingError);
  });
});
