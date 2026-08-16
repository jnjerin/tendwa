import { describe, expect, it } from "vitest";
import { incidentHasOutcome } from "../mapping.js";
import { SEED_INCIDENTS } from "../ingest/seed-data.js";

// Regression guard: the whole point of B6 is that it's held back for a live demo submission
// with no prior memory to find. If someone edits seed-data.ts and flips its seedNow flag (or
// drops one of the intended 11), the demo's "retrieval finds nothing for a truly fresh
// incident" moment silently breaks — this test exists to catch exactly that.
describe("SEED_INCIDENTS", () => {
  it("marks exactly 11 incidents to seed now and exactly 1 (B6) held back", () => {
    const toSeed = SEED_INCIDENTS.filter((entry) => entry.seedNow);
    const heldBack = SEED_INCIDENTS.filter((entry) => !entry.seedNow);
    expect(toSeed).toHaveLength(11);
    expect(heldBack).toHaveLength(1);
    expect(heldBack[0]?.id).toBe("B6");
  });

  it("gives every incident seeded now a full outcome (resolved, as backstory)", () => {
    const toSeed = SEED_INCIDENTS.filter((entry) => entry.seedNow);
    for (const entry of toSeed) {
      expect(incidentHasOutcome(entry.incident), `${entry.id} should have an outcome`).toBe(true);
    }
  });

  it("leaves B6 without an outcome — it's submitted live during the demo", () => {
    const b6 = SEED_INCIDENTS.find((entry) => entry.id === "B6");
    expect(b6).toBeDefined();
    expect(incidentHasOutcome(b6!.incident)).toBe(false);
  });

  it("has no duplicate reference labels", () => {
    const ids = SEED_INCIDENTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
