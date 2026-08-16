import "../../src/env.js";
import { describe, expect, it } from "vitest";
import { EmbeddingError, embedText } from "../../src/memory/embeddings.js";

// A successful real call is deliberately NOT duplicated here: this Voyage account is on the
// free tier without a payment method, capped at 3 RPM, and retrieve.integration.test.ts's
// beforeAll already makes real embedText calls to seed knowledge rows and asserts their shape
// (1024 dimensions, finite numbers) — reusing that result instead of spending another call on
// the same assertion. This file covers the failure path specifically: an invalid key should
// raise EmbeddingError, not a generic/unclassified error.
describe.skipIf(!process.env.VOYAGE_API_KEY)("embedText against the real Voyage AI API", () => {
  it("rejects with EmbeddingError, not a generic error, when the API key is invalid", async () => {
    await expect(embedText("test", { apiKey: "not-a-real-key" })).rejects.toThrow(EmbeddingError);
  });
});
