# Engineering Standards

This is the production-engineering constitution for this project — and the intended default
for future projects too. It applies proportionally: **production-grade appropriate to this
system's actual scale and risk, not enterprise-scale for its own sake.**

Explicitly **yes**: structured logging, input validation, timeouts and bounded retries, clear
error handling, secure secrets management, database constraints and transactions,
organization-scoped data isolation, an audit trail for agent actions, tests including
failure-path tests, health checks, CI, documented configuration.

Explicitly **no, not for this system**: Kubernetes, a service mesh, Kafka or another
message broker, a microservice split, elaborate distributed tracing infrastructure, a formal
event-sourcing framework. If a suggestion trends toward any of these, that's a signal the
suggestion doesn't fit this project's actual scale — say so instead of implementing it.
Staying simple enough that every component is fully understood is itself a strength, not a
shortcut.

## 1. Reliability

- **Failure modes are considered explicitly, not implicitly.** For any new integration
  point, state what happens when the dependency is slow, unavailable, or returns something
  unexpected.
- **Every external call has a timeout.** CockroachDB queries, the Anthropic API, the
  embeddings API — none of them wait indefinitely.
- **Retries are bounded and safe, never silent and unlimited.** CockroachDB serialization
  conflicts (`40001`) are caught and retried with backoff at the transaction level — retry
  the whole transaction, not individual statements. LLM calls get a small number of retries
  with backoff, then a defined fallback, never an infinite loop.
- **Idempotency is considered wherever a request could plausibly be sent twice** — e.g. a
  duplicate `POST /incidents/:id/analyze` should not silently create two divergent agent runs.
- **Graceful degradation over hard failure where it's honest to do so** — e.g. if the LLM
  call in `/analyze` fails, return the retrieved memory with a clear "recommendation
  unavailable" rather than a bare 500 with no information.
- **Crash recovery is a first-class concern for the reflection process**, via `agent_state`
  checkpointing — a crash mid-run must resume, not restart or duplicate work.

### Concrete failure modes to have an explicit answer for

- **Database unavailable:** API → DB timeout → bounded retry → still failing → structured
  error response → logged → user gets a clear, non-cryptic message.
- **LLM API unavailable or times out:** retry → still failing → "recommendation unavailable,"
  memory itself remains intact and queryable regardless.
- **Embedding generation fails:** the experience should still be persisted; embedding can be
  generated separately/retried rather than blocking the whole write.
- **Reflection job (Lambda) crashes mid-run:** resumes from the last checkpoint in
  `agent_state`, doesn't restart from zero or double-process.
- **LLM returns a malformed or invalid proposal:** schema validation rejects it, nothing is
  written to the database, the rejection itself is recorded in `agent_audit_log`.
- **A request is sent twice:** define and implement the idempotency behavior before shipping
  the endpoint, don't discover it in the demo.

## 2. Database reliability

- Every multi-statement operation that must succeed or fail together uses a transaction.
- `SERIALIZABLE` isolation means occasional retry-on-conflict is expected, correct behavior —
  handle it, don't treat it as a bug.
- Connections are pooled, not opened per-request.
- Migrations are additive and reversible where practical; never a destructive change without
  a stated reason.
- Queries that could scan meaningfully large tables have appropriate indexes.
- Foreign keys and constraints do real work — they're not decorative.

## 3. Security

- No secrets hardcoded, ever — configuration only, read from environment variables.
- Every table and query that should be organization-scoped is actually filtered by
  `org_id` — no exceptions.
- All inputs are validated before use; all queries are parameterized, never built by string
  concatenation.
- LLM output is never trusted directly — see "LLM proposes, code validates" in
  `ARCHITECTURE.md`; this is a security boundary, not just a style preference.
- Least privilege wherever credentials are involved (e.g. read-only database access where
  read access is all that's needed).

## 4. Observability

- **Structured JSON logs via `pino`, never bare `console.log` and never a hand-rolled JSON
  logger.** Every log line includes a level, timestamp, the service/component, and a
  request/correlation ID. `pino` is required specifically (not just "a structured logger")
  because it's Fastify's built-in default logger — the API and everything else share one
  logging system instead of two — and because its `redact` option gives "never log secrets"
  (below) an actual enforcement mechanism, not just discipline.
- **The `redact` path list in `logger.ts` must be extended whenever a new config field or
  parameter could carry a secret** — it only protects the field names explicitly listed, not
  anything added later by default. Adding a new credential, token, or connection string
  anywhere in the codebase includes updating this list in the same change. Both forms of the
  key must be added, not just one: the bare name (e.g. `"apiKey"`) *and* the `"*."`-prefixed
  form (e.g. `"*.apiKey"`). pino's wildcard paths only match a key nested one level under
  something else — they do not match that same key sitting at the top level of the logged
  object, which is exactly the shape this codebase's `log()` calls use. A list with only the
  wildcard form silently fails to redact top-level fields; this exact gap was already found
  and fixed once (see `DECISIONS.md`), so it's stated explicitly here rather than left implicit.

```json
{
  "level": "error",
  "timestamp": "2026-08-15T10:22:03Z",
  "service": "api",
  "requestId": "req_abc123",
  "orgId": "org_xyz",
  "operation": "incident.analyze",
  "errorCode": "LLM_TIMEOUT",
  "durationMs": 3012
}
```

- **Never log secrets, API keys, credentials, or raw sensitive prompt content.**
- A request ID is generated at the API boundary and threaded through every log line touched
  by that request, all the way down to the database and LLM calls — so a real failure can be
  reconstructed from logs alone.
- Significant state transitions (a knowledge item's confidence changing, a reflection run
  completing) are logged, not just errors.
- `agent_audit_log` is the durable audit trail for agent decisions specifically — distinct
  from application logs, which are operational/debugging-focused.

## 5. Health and readiness

- `GET /health` — is the process alive. Minimal, no dependency checks.
- `GET /ready` — is this instance actually able to serve traffic (can it reach the
  database). Distinct from `/health` on purpose — don't conflate "running" with "working."

## 6. Testing

- Unit tests for logic with no external dependency.
- Integration tests for repository methods against the real database.
- Migration tests — a fresh migration actually produces the expected schema.
- API contract tests for each endpoint's happy path and its documented error responses.
- **Explicit failure-path tests**, not just happy-path — a passing test suite that never
  exercises a single failure mode hasn't tested reliability at all.
- Agent/reflection tests use a mocked LLM response, specifically to verify
  `validateProposal()` rejects malformed proposals correctly.

## 7. API standards

- Input validation on every endpoint, with clear 4xx responses for invalid input — never a
  500 for a client error.
- Consistent error response shape across endpoints.
- Appropriate status codes, not everything collapsed to 200 or 500.

## 8. LLM / agent safety

- All LLM output for anything that becomes a database write is structured (not free text)
  and validated before use — see `ARCHITECTURE.md`'s "LLM proposes, code validates" pattern.
- The model is never given the ability to generate or execute SQL.
- Tool access for the agent loop is explicit and minimal — it can call what it needs, not
  everything the codebase can do.
- Retries and a token/cost ceiling are defined for LLM calls, not open-ended.

## 9. Configuration and deployment

- All configuration is validated at application startup — a missing required variable
  (e.g. `DATABASE_URL`) causes the application to refuse to start with a clear error message,
  not fail mysteriously deep in a request handler later.
- `.env.example` documents every variable the application needs, with no real values.
- Local development and CI both use real configuration pointed at the actual database — see
  `ARCHITECTURE.md`'s resolved tooling decisions.
- The distinction between configuration (safe to have defaults, e.g. `LOG_LEVEL`) and
  secrets (never defaulted, never committed) is explicit.

## 10. Definition of Done

A feature is not complete when the happy path works. Before calling a non-trivial feature
done, check:

**Functionality** — happy path works; invalid inputs are handled; relevant edge cases are handled.

**Reliability** — dependency failures are considered; timeouts are configured where relevant;
retries are bounded; idempotency is considered where relevant; CockroachDB serialization
conflicts are handled where relevant; partial-failure behavior is defined, not accidental.

**Security** — inputs validated; queries parameterized; organization isolation enforced;
secrets never exposed; LLM output validated before any mutation.

**Observability** — structured logs present; request/correlation ID threaded through; errors
classified, not generic; significant state transitions logged; audit trail present where the
feature involves an agent decision.

**Testing** — unit tests exist; integration tests exist where appropriate; at least one
failure-path test exists; database behavior is tested where relevant.

**Operations** — new configuration is documented in `.env.example`; health/readiness
implications considered; deployment implications considered.

**Documentation** — `ARCHITECTURE.md` updated if the change is architectural; `DECISIONS.md`
updated if a real decision was made; `README.md` updated if the change is user-facing.

**Git** — diff has been read; no secrets are staged; tests pass; commit message follows the
convention in `CLAUDE.md`.
