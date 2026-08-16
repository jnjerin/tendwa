import "./env.js";

export interface EngineConfig {
  databaseUrl: string;
}

/**
 * Shared validation primitive: a missing required env var fails loudly with a clear message
 * here, rather than surfacing as a cryptic connection error deep inside a request handler or
 * a migration run. Used both by loadConfig() below (the application's runtime config, always
 * DATABASE_URL) and by migrate.ts (which chooses between DATABASE_URL and TEST_DATABASE_URL
 * based on its own --test flag — a concern specific to that operational script, not something
 * loadConfig() itself should know about).
 */
export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill in a value for it.`);
  }
  return value;
}

/** Validates required configuration at startup. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  return { databaseUrl: requireEnv(env, "DATABASE_URL") };
}
