# Tendwa — Project Context for Claude Code

## Read these first

- `PROJECT.md` — what this is, why it's built this way, who it's for. Read before any
  product/UX/README-facing decision.
- `ARCHITECTURE.md` — schema, repo structure, system design, resolved tooling decisions.
  Read before any implementation task.
- `ENGINEERING.md` — production engineering standards and Definition of Done. Applies to
  every non-trivial feature, by default, not only when asked.
- `DECISIONS.md` — the record of real decisions made along the way. Add to it when a real
  decision gets made; check it before re-deriving something already settled.

Don't re-derive the project's design from scratch each session — these files exist so you
don't have to.

## Stack

TypeScript, Node.js, Fastify (API), Next.js (minimal dashboard), CockroachDB Cloud
(Postgres wire-compatible, but vector indexing is CockroachDB's own C-SPANN — never copy
pgvector-specific syntax like `ivfflat` or HNSW tuning params without verifying against live
docs first), AWS Lambda (reflection job), Anthropic API (Claude) for agent reasoning, Voyage
AI (`voyage-3.5`, 1024-dim) for embeddings.

## Non-negotiable rules — do not deviate from these without asking first

1. **The engine/domain separation is real, not aspirational.** `packages/engine` must have
   zero references to "incident" or any domain-specific concept. All domain logic lives in
   `domains/incident-response`. If you're about to write `if (type === 'incident')` inside
   `packages/engine`, stop — that belongs in the domain adapter instead.
2. **No LangGraph or other agent orchestration framework.** The agent loop
   (retrieve → reason → propose → observe) is hand-rolled TypeScript. This is a deliberate
   choice, not an oversight — don't suggest replacing it with a framework.
3. **`knowledge_evidence` is a junction table with foreign keys**
   (`knowledge_id`, `experience_id`), never a UUID array column. Every knowledge row's
   provenance must be queryable via a plain JOIN.
4. **LLM proposes, code validates — always, no exceptions.** The LLM never generates or
   executes SQL, and its output is never written directly to the database. It returns a
   structured proposal; application code validates it before applying it through repository
   methods. Every reflection run logs both the proposal and what was actually applied to
   `agent_audit_log`.
5. **Every table is scoped by `org_id`.** No exceptions, even though the demo seeds only one
   organization.
6. **UUID primary keys everywhere**, `gen_random_uuid()` default.
7. **Confirm CockroachDB vector index syntax against the live cluster/docs before trusting
   any cached example** — this is an actively evolving feature, don't assume prior knowledge
   is current.
8. **Production engineering standards in `ENGINEERING.md` apply by default**, on every
   non-trivial feature, without being asked each time. "Production-ready" means
   production-grade appropriate to this system's actual scale — not an excuse to add
   infrastructure this project doesn't need (see `ENGINEERING.md` for the explicit boundary).

## Engineering rationale — explain decisions, not just outcomes

When implementing a non-trivial feature:

1. Briefly state the engineering approach before implementing it.
2. Identify which `ENGINEERING.md` standards apply to this specific feature.
3. State the important tradeoffs in plain language.
4. Implement the feature, with its test, alongside each other.
5. State what production-hardening measures were actually added, and why.
6. State which failure modes were considered (and which were deliberately deferred, and why).
7. State how the tests verify the behavior that actually matters, not just that code runs.

This is a documentation and defensibility standard, not commentary — every non-trivial
decision should be traceable to a stated reason, the way a well-reviewed PR would be. Keep it
grounded in the specific code being built, not a generic explanation — a few precise sentences
in context beats a long abstract writeup every time.

## Working style

- Use Plan mode for anything touching the schema, the agent loop, or more than one file.
- Small, reviewable diffs over large ones. Commit after every task that leaves the repo in a
  working state — not just at the end of a session.
- Ask before removing, renaming, or restructuring anything already committed.
- Use `/clear` between genuinely unrelated tasks rather than letting one session sprawl;
  project context reloads from these files either way. Use `/compact` if a single session
  runs long and coherent context still matters.

## Git workflow

- Work directly on `main` for this solo project unless told otherwise.
- Never commit unrelated changes together.
- Before committing: run relevant tests, inspect the diff, run `code-reviewer` (and
  `production-reviewer` for anything touching reliability/security/observability), verify no
  secrets are staged, then summarize the changes in plain language.
- Commit messages follow Conventional Commits: `feat(memory): add experience persistence`,
  `fix(reflection): reject invalid knowledge proposals`, `test(memory): add serialization
  retry coverage`, `chore(ci): add validation pipeline`. Never vague messages like "update"
  or "fix stuff".
- Do not `git push` without being explicitly asked — commits are cheap checkpoints, a push is
  what actually reaches the public repo, keep that a deliberate human decision.
