import pino from "pino";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface LogFields {
  service: string;
  component?: string;
  operation?: string;
  requestId?: string;
  orgId?: string;
  errorCode?: string;
  durationMs?: number;
  err?: Error;
  [key: string]: unknown;
}

/**
 * Backed by pino rather than hand-rolled JSON — see DECISIONS.md. Kept behind this
 * LogFields-shaped function so call sites depend on this interface, not pino's API directly.
 */
const pinoLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  serializers: {
    err: pino.stdSerializers.err,
  },
  // Both the bare and "*."-prefixed form of each key are listed: pino's wildcard paths only
  // match a key nested one level under something else (e.g. "foo.databaseUrl"), not the same
  // key sitting at the top level of the object — which is exactly the shape log()'s LogFields
  // objects use. Verified directly: "*.databaseUrl" alone does NOT redact a top-level
  // databaseUrl field. Per ENGINEERING.md §4, extend both forms together for any new field.
  redact: {
    paths: [
      "err.config",
      "connectionString",
      "*.connectionString",
      "databaseUrl",
      "*.databaseUrl",
      "apiKey",
      "*.apiKey",
      "password",
      "*.password",
      "token",
      "*.token",
      "authorization",
      "*.authorization",
      "Authorization",
      "*.Authorization",
      "req.headers.authorization",
    ],
    censor: "[REDACTED]",
  },
});

export function log(level: LogLevel, message: string, fields: LogFields): void {
  pinoLogger[level](fields, message);
}
