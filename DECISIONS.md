# Decisions Log

Short entries, added as you go. This is what makes the design defensible later — to
contributors, to your future self, to anyone reviewing a PR — write them when the decision is
made, not reconstructed from memory afterward.

Format: date — decision — one-line reason.

2026-08-15 — Hand-rolled agent loop instead of a framework like LangGraph — a loop this size
doesn't need orchestration overhead, and a loop written directly is one that's fully
explainable and debuggable without framework internals in the way.

2026-08-15 — Added schema_migrations bookkeeping table — the "plain SQL files, no framework"
approach needs a minimum way to know what's already applied to be safely re-runnable; this
isn't a framework, it's the smallest thing that makes the chosen approach actually work.

2026-08-15 — Test isolation via fresh org_id per test file, not truncation — Vitest runs
files in parallel, and truncating shared tables risks concurrent files colliding. Every table
is already org_id-scoped, so per-file org isolation is free and also continuously exercises
the org-isolation guarantee itself as a side effect of normal test runs.

2026-08-15 — tendwa_test provisioned manually, not by the migration runner — the runner holds
DDL/DML rights only, not CREATE DATABASE, per the least-privilege standard in ENGINEERING.md.

2026-08-15 — Migrations live at packages/engine/src/db/migrations/, not a top-level db/ — the
engine owns its own persistence layer end to end, migrations included.

2026-08-15 — Added GET /ready distinct from GET /health, matching ENGINEERING.md's
liveness/readiness distinction — ARCHITECTURE.md's endpoint list had drifted from it.

2026-08-16 — Adopted pino for the engine's logging instead of a hand-rolled JSON logger —
it aligns with Fastify's default logger, avoiding two different logging systems once apps/api
exists; it provides built-in Error serialization and LOG_LEVEL-based filtering for free; and
its `redact` option gives the "never log secrets" rule in ENGINEERING.md an actual enforcement
mechanism rather than just discipline.

2026-08-16 — idx_knowledge_embedding uses vector_cosine_ops explicitly, not CockroachDB's
implicit vector_l2_ops default — Voyage AI's docs recommend cosine similarity for voyage-3.5
embeddings, and cosine is the standard metric for embedding-similarity search generally.
CockroachDB's CREATE VECTOR INDEX syntax accepts an explicit opclass suffix on the vector
column (confirmed live against tendwa_test, via a scratch table before touching the real
schema); leaving it unspecified silently defaults to L2 rather than erroring, so this had been
an accidental default rather than a real decision until now.

2026-08-16 — logger.ts's redact list now includes both the bare and "*."-prefixed form of
every secret-bearing field name — code-reviewer and production-reviewer independently tested
the original wildcard-only list against the installed pino and confirmed it does not redact a
field (e.g. databaseUrl) sitting at the top level of a logged object, only one nested under
another key. Since every log() call site in this codebase logs a flat, top-level LogFields
object, the original list gave no real protection at all for this codebase's actual usage.
ENGINEERING.md §4 now states both forms are required, not just "extend the list," so this
doesn't quietly regress the next time a field is added.

2026-08-16 — The migration runner retries CockroachDB 40001 serialization conflicts with
bounded exponential backoff, per ENGINEERING.md §1's unqualified requirement that this applies
to any write path. Migrations are normally run by a single actor, so this rarely triggers in
practice, but the runner is still a real write path and code-reviewer/production-reviewer both
flagged its absence as a standard violation rather than a justified exemption — so it's
implemented, not documented away. Covered by a mocked-client unit test asserting both the
retry/give-up counts and that delay() actually executes with the correct backoff schedule.

2026-08-16 — knowledge_evidence intentionally has no org_id column, unlike every other table.
This is carried forward exactly as ARCHITECTURE.md already specified it, not a new choice, but
it's worth stating explicitly given CLAUDE.md's "every table is scoped by org_id, no
exceptions" wording: org-scoping here is enforced transitively, via its foreign keys to
knowledge(org_id) and experiences(org_id), rather than by a column on the junction table
itself. A direct org_id column would be redundant (both referenced rows already carry it) and
could theoretically drift out of sync with them; the transitive FK relationship can't.

2026-08-16 — recordExperience retries only 40001 conflicts, not connection-level failures,
because experiences has no natural dedupe key and blind retries on ambiguous failures risk
duplicate rows. Idempotency is deferred to a future request-level key at the /incidents
endpoint.

2026-08-16 — experiences intentionally has no embedding column; only knowledge is
vector-ranked. Retrieval reaches experiences through their knowledge_evidence links (once
reflection has run) or structured filtering (org_id, domain, recency) in the meantime, not by
embedding and searching raw experience text directly. ENGINEERING.md §1's "embedding
generation fails, retry separately" failure mode is a forward-looking principle for if that
ever changes, not a commitment that this schema already embeds experiences — recorded here so
it doesn't read as a contradiction later.
