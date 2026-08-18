# Tendwa Architecture Reference

**What and why, briefly (full version in CLAUDE.md):** Tendwa is a compound memory engine —
experience → reflection → knowledge → strategy — demonstrated through a thin incident-response
adapter on top of a genuinely domain-agnostic core. The engine/domain split is a design
decision, not an implementation detail: it's what makes this reusable as infrastructure rather
than a single-purpose application. This file is the detailed reference; consult it when
implementing a specific piece, not as a substitute for CLAUDE.md.

This is the detailed reference. `CLAUDE.md` has the always-loaded summary and rules; this
file has the full schema and structure to consult when implementing a specific piece.

## The four-stage pipeline
1. **Experience** — a raw, dated event gets recorded (an incident occurred, a fix was applied).
2. **Reflection** — on a schedule, related experiences are clustered and asked "what's the
   durable pattern here?"
3. **Knowledge** — reflection reinforces existing knowledge (raising confidence) or writes new
   knowledge, each with a confidence score, evidence links, and a decay policy.
4. **Strategy** — a new situation retrieves relevant knowledge (not raw experience) and the
   agent's recommendation is shaped by what's actually been learned.

## Repository structure
```
tendwa/
├── LICENSE (MIT)
├── README.md
├── ARCHITECTURE.md
├── DECISIONS.md
├── CLAUDE.md
├── packages/
│   └── engine/                     # domain-agnostic — zero knowledge of "incident"
│       ├── src/
│       │   ├── db/                 # CockroachDB client, migrations
│       │   ├── memory/
│       │   │   ├── experience.ts   # write raw events
│       │   │   ├── reflect.ts      # clustering + distillation job
│       │   │   ├── knowledge.ts    # read/write distilled knowledge, confidence/decay,
│       │   │   │                   # evidence linking via knowledge_evidence
│       │   │   └── retrieve.ts     # hybrid structured + vector retrieval
│       │   ├── agent/
│       │   │   ├── loop.ts         # retrieve → reason → propose → observe (hand-rolled)
│       │   │   └── tools.ts        # tool-use definitions
│       │   └── index.ts            # public engine API surface
│       └── test/
├── domains/
│   └── incident-response/          # ONLY place incident-specific code lives
│       ├── ingest/
│       │   ├── postmortems.ts      # parses postmortem docs into "experience" records
│       │   └── seed-data/          # public postmortem summaries + synthetic set
│       └── mapping.ts              # incident fields → generic experience schema
├── apps/
│   ├── api/                        # Fastify — uses packages/engine + domains/incident-response
│   ├── worker/                     # Lambda handler — scheduled reflection job
│   └── web/                        # Next.js dashboard + memory explorer
└── .github/workflows/ci.yml
```

## Database schema (CockroachDB)
```sql
-- Migration bookkeeping — required by the "plain SQL files, no framework" approach to be
-- safely re-runnable. Created first, by 001_init.sql itself.
CREATE TABLE schema_migrations (
  version STRING PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE orgs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name STRING NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Stage 1: Experience (raw, dated, unprocessed)
CREATE TABLE experiences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id),
  domain STRING NOT NULL,           -- 'incident-response' (engine doesn't care what this means)
  content STRING NOT NULL,
  metadata JSONB,                   -- domain-specific fields live here, NOT as new columns
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Stage 3: Knowledge (distilled, confidence-weighted, decaying)
CREATE TABLE knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id),
  domain STRING NOT NULL,
  statement STRING NOT NULL,
  embedding VECTOR(1024),           -- matches Voyage AI voyage-3.5 default output dimension
  confidence FLOAT DEFAULT 0.5,
  reinforcement_count INT DEFAULT 1,
  last_reinforced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE VECTOR INDEX idx_knowledge_embedding ON knowledge (org_id, embedding);

-- Junction table — REQUIRED, replaces any UUID[] array approach.
CREATE TABLE knowledge_evidence (
  knowledge_id UUID NOT NULL REFERENCES knowledge(id),
  experience_id UUID NOT NULL REFERENCES experiences(id),
  PRIMARY KEY (knowledge_id, experience_id)
);

-- Stage 4: agent working memory (crash-safe, resumable)
CREATE TABLE agent_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id),
  status STRING NOT NULL,           -- 'running' | 'completed' | 'failed' | 'awaiting_feedback'
  step STRING NOT NULL,
  payload JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Feedback loop: what actually happened to this specific incident. Deliberately does NOT
-- reference knowledge directly — the link between an outcome and the knowledge it
-- reinforces or contradicts is inferred during reflection (via knowledge_evidence and
-- semantic similarity), not declared at outcome-recording time. This keeps "what happened"
-- (outcomes) cleanly separate from "what we've learned" (knowledge), which is the same
-- separation of concerns the rest of this schema is built around.
CREATE TABLE outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id),
  experience_id UUID NOT NULL REFERENCES experiences(id),
  status STRING NOT NULL,           -- 'resolved' | 'failed' | 'partial'
  root_cause STRING,
  action_taken STRING NOT NULL,
  result STRING NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE agent_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id),
  action STRING NOT NULL,
  detail JSONB,                     -- for reflection runs: { proposal, applied }
  created_at TIMESTAMPTZ DEFAULT now()
);
```

## LLM proposes, code validates — the required pattern for the reflection job
The reflection job is also where the `outcomes` → `knowledge` link actually gets made —
by the LLM proposing which knowledge a cluster of experiences+outcomes supports, not by a
foreign key declared when the outcome was first recorded.
```typescript
// Never this — LLM-generated SQL executed directly:
// const llmResponse = await claude.complete("UPDATE knowledge SET confidence = 0.84 ...");
// await db.execute(llmResponse);

// Always this:
const proposal = await getStructuredLLMProposal(clusterData);
// { action: "update", knowledgeId: "K17", newConfidence: 0.84, supportingExperienceIds: [...] }

validateProposal(proposal); // type checks, confidence in [0,1], knowledgeId exists, org_id matches

await knowledgeManager.update(proposal.knowledgeId, { confidence: proposal.newConfidence });
for (const expId of proposal.supportingExperienceIds) {
  await knowledgeManager.addEvidence(proposal.knowledgeId, expId); // writes knowledge_evidence
}
await auditLog.record({ action: 'reflection.proposal_applied', detail: { proposal } });
```

## Resolved tooling decisions (locked in, don't reopen without a real reason)
- **Embeddings: Voyage AI, model `voyage-3.5`, default 1024-dimensional output.** This is
  Anthropic's recommended embedding partner. All `VECTOR` columns in this schema are sized
  to 1024 to match — if the embedding model ever changes, the column size must change with it.
- **No dedicated `reflections` table.** Reflection is a process, not a data entity — its
  output lands in `knowledge` (new/updated rows), `knowledge_evidence` (new evidence links),
  and `agent_audit_log` (a record that the run happened and what it did). Do not add one.
- **No migration framework.** Plain numbered SQL files in `db/migrations/` (`001_init.sql`,
  `002_...`), run in order via a short script against `DATABASE_URL`. Adopting a framework
  like drizzle-kit is unnecessary tooling overhead for this project's size.
- **No local Docker database.** Local development and CI both connect to the real
  CockroachDB Cloud cluster (via `DATABASE_URL`), not a Dockerized local instance — one real
  environment, not two that can drift apart.
- **Test framework: Vitest.** Native TypeScript/ESM support with minimal config, and it
  handles a multi-package pnpm workspace more cleanly than Jest does out of the box.
- **Test database: a separate `tendwa_test` database on the same CockroachDB Cloud cluster**
  (not Docker, not transaction-rollback wrapping), migrated identically to dev via the same
  runner. Provisioned manually once via the Cloud Console or a SQL client — the migration
  runner itself should not hold `CREATE DATABASE` privileges, only DDL/DML on the database
  it's given, per the least-privilege standard in `ENGINEERING.md` §3.
- **Test isolation: a fresh `org_id` per test file, not truncation between runs.** Vitest
  runs test files in parallel by default; truncating shared tables between concurrently
  running files risks them colliding mid-run. Every table is already `org_id`-scoped, so
  each test file creating its own org and only ever operating within it gives free, real
  isolation — parallel files never collide, the same way two real customers never would.
  This also means normal test runs continuously exercise the org-isolation guarantee itself
  as a side effect. `tendwa_test` doesn't need routine truncation; an occasional manual wipe
  if it accumulates stale data is enough, since none of it is consequential.
- **Migration bookkeeping:** a `schema_migrations (version STRING PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT now())` table, created by `001_init.sql` itself. The runner
  script checks this table and skips already-applied versions — this is the minimum
  bookkeeping the "plain SQL files, no framework" approach needs to actually be safe to
  re-run, not a framework in disguise.
- **Migrations live at `packages/engine/src/db/migrations/`**, not a top-level `db/` — the
  engine owns its own persistence layer, migrations included, consistent with the repo tree.

## System diagram
```
              ┌───────────────────────┐
              │  Next.js Dashboard     │
              └───────────┬────────────┘
                          │ REST
              ┌───────────▼────────────┐
              │      Fastify API       │  uses packages/engine + domains/incident-response
              └───────────┬────────────┘
                          │ SQL + VECTOR
              ┌───────────▼────────────┐
              │      CockroachDB       │◄── Managed MCP Server (dev-time schema
              │ experiences            │    inspection + optional runtime query)
              │ knowledge (VECTOR)     │
              │ knowledge_evidence     │
              │ agent_state, outcomes  │
              │ agent_audit_log        │
              └───────────┬────────────┘
                          │
               ┌──────────┴───────────┐
               │                      │
    ┌──────────▼─────────┐  ┌─────────▼──────────┐
    │  AWS Lambda          │  │   Amazon S3         │
    │  reflection job       │  │  raw postmortems    │
    └──────────┬────────────┘  └────────────────────┘
               │
    ┌──────────▼──────────┐
    │  Anthropic API        │
    │  (Claude)              │
    └────────────────────────┘
```

## API endpoints (MVP)
```
POST   /incidents                  # create an experience
GET    /incidents/:id
POST   /incidents/:id/analyze      # retrieve memory + agent reasoning → recommendation
POST   /incidents/:id/outcome      # record what actually happened
GET    /memory/search
POST   /reflection/run             # manual/dashboard-triggered run — the scheduled Lambda
                                    # (apps/worker) calls runReflection() directly, in-process,
                                    # not through this HTTP route (see DECISIONS.md)
GET    /knowledge
GET    /knowledge/:id
GET    /health                      # liveness — is the process running
GET    /ready                       # readiness — can this instance reach the database
```
