import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("returns the database URL when set", () => {
    const config = loadConfig({ DATABASE_URL: "postgresql://user:pass@host:26257/tendwa" } as NodeJS.ProcessEnv);
    expect(config.databaseUrl).toBe("postgresql://user:pass@host:26257/tendwa");
  });

  it("throws a clear error when DATABASE_URL is missing", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL is not set/);
  });
});
