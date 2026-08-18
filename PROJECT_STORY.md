# Tendwa — Project Story

## Inspiration

Incident response tools are good at storing what happened. They're much worse at remembering
what *worked*. Every postmortem gets written, filed, and mostly forgotten — the next on-call
engineer facing a similar outage starts from zero, even if the team solved this exact problem
three months ago.

I wanted to build something that treats that gap as an architecture problem, not a search
problem: not "can you find the old postmortem," but "can the system itself get measurably
smarter as outcomes accumulate." That's what pulled me toward agentic memory as a first-class
pipeline — **experience → reflection → knowledge → strategy** — rather than memory as a chat
log or a bag of embeddings.

## What it does

Tendwa is a compound memory engine. When an incident happens, it's recorded as a raw
**experience**. Periodically, a **reflection** process clusters related experiences and
outcomes and asks: what's the durable pattern here? That produces **knowledge** — a
confidence-weighted statement, linked back to the specific experiences that support it through
a relational `knowledge_evidence` junction table, not a black-box vector or a UUID array.

When a new incident comes in, Tendwa retrieves relevant knowledge (via CockroachDB's
distributed vector indexing) and an agent reasons over it to produce a recommendation — showing
which past incidents and knowledge it's grounded in, with citations validated against what was
actually retrieved. An agent can't invent an experience ID and claim it supports a
recommendation; the application checks. Once an outcome is recorded, it becomes a new signal
for the next reflection run.

The demo uses incident response as the concrete domain, but the engine itself has zero
knowledge of "incidents" anywhere in it — that separation is deliberate, so the same memory
pipeline could sit under a different domain adapter entirely.

## How I built it

- **CockroachDB Cloud** as the actual system of record for the agent's memory lifecycle —
  experiences, knowledge, embeddings, evidence links, agent state, outcomes, and audit logs all
  live in the same database, not split across an app DB plus a separate vector store.
- **CockroachDB's distributed vector indexing** (`VECTOR(1024)`, matching Voyage AI's
  `voyage-3.5` output) for semantic knowledge retrieval, combined with structured, org-scoped
  SQL filtering in the same hybrid query.
- **CockroachDB's Managed MCP Server**, connected during development, for live schema
  inspection against the real cluster — valuable because CockroachDB's vector indexing syntax
  differs from pgvector despite Postgres wire compatibility, and is still actively evolving.
- A strict **engine/domain separation**: `packages/engine` has zero references to "incident";
  all domain-specific logic lives in a thin `domains/incident-response` adapter.
- **"LLM proposes, code validates,"** enforced structurally: the model never generates or
  executes SQL. It returns a structured proposal — action, target, new confidence, supporting
  evidence — and application code validates structure, confidence ranges, org ownership, and
  referenced-record existence before any repository method touches the database.
- A hand-rolled agent loop (retrieve → reason → propose → observe) — deliberately no
  orchestration framework.
- **Voyage AI** for embeddings, **Claude** for agent reasoning and reflection.
- An **AWS Lambda** wrapper around the reflection job, meant to run on a schedule — separate
  from the on-demand, per-incident analysis a user triggers directly, since those are genuinely
  different kinds of operations.
- A thin Fastify API and a minimal Next.js dashboard, both intentionally kept free of business
  logic.

## Challenges I ran into

**CockroachDB's vector indexing is its own thing, not pgvector.** Copying pgvector syntax
(`ivfflat`, HNSW tuning params) would have been actively wrong despite wire compatibility. I
treated this as a "confirm against live docs every time" rule, using the Managed MCP Server to
check real, current schema state rather than trusting cached examples.

**A `pg` driver type-parsing bug.** CockroachDB's `INT8` values came back from the driver in a
form that didn't match my assumptions in mocked tests — invisible until tested against the
real database, because mocks return whatever type the test hands them. Fixed at the root.

**A citation format mismatch, caught by a real Claude call, not a mock.** The agent's prompt
displayed retrieved items using an identifier format that a real integration test call to
Claude Sonnet 5 interpreted differently than my validator expected — the model cited
`experience:<uuid>` where the validator expected the bare UUID, and correctly rejected a
genuinely valid recommendation as unsupported. I fixed both ends: the prompt now defines the
identifier format explicitly, and the validator safely normalizes recognized prefixes while
still requiring an exact match against retrieved evidence. This surfaced *only* because I ran
a real, ungated integration test against Claude — a mocked LLM response would never have
revealed it.

**CockroachDB serialization conflicts on concurrent writes.** Rather than assume writes always
succeed, every write path that can conflict (experience, outcome, knowledge, agent state, audit
log) catches CockroachDB's `40001` serialization error and retries with exponential backoff —
tested explicitly, asserting both retry count and actual delay timing, not just "it eventually
succeeds."

**A rate limit that became a real crash-resume test.** Voyage AI's free tier caps at 3
requests/minute; a reflection run with several experience clusters hit that limit mid-execution
during the actual build. Because the reflection job checkpoints its progress in `agent_state`,
I expected re-running the same command to resume seamlessly. It didn't — every resume attempt
failed with "claim lost," even though nothing else was touching the row. That led me to a real,
separate bug: a timestamp precision mismatch (CockroachDB's microsecond-precision `now()` vs.
the Postgres driver's millisecond-precision `Date` parsing) in the resume's optimistic-
concurrency check. Once fixed, re-running the same command correctly resumed from checkpoint
instead of restarting or duplicating work, and the run completed. Found, fixed, and covered by
a new test — documented in `DECISIONS.md`.

## Accomplishments that I'm proud of

- CockroachDB is the actual memory system, not a database with a vector column bolted on —
  transactional and semantic memory live together, with nothing to keep in sync.
- Knowledge has real provenance: every learned statement traces back to its supporting
  experiences through an actual database join, not an implied or array-based link.
- The LLM is a participant, not an authority — it proposes, and everything it proposes is
  independently validated, including its citations, before anything is written.
- I found real bugs by testing real boundaries: an integration test against a live Claude call
  surfaced a citation-format issue no mock ever could have; a live rate-limit incident surfaced
  a timestamp-precision bug in my resume logic. Both are fixed, tested, and documented.
- Failure handling for external AI dependencies is real, not aspirational: embedding failures
  degrade retrieval to experiences-only rather than failing outright, and both the agent loop
  and reflection job explicitly bound prompt size and handle Claude's context-window-exceeded
  response rather than letting it surface as an unclassified error.

## What I learned

Building the "LLM proposes, code validates" boundary changed how I think about agent
reliability — once the model's output is a structured proposal that gets validated before it
ever touches the database, most of the frightening failure modes of agentic systems stop being
frightening. The model can be wrong; it can't be destructive.

I also learned, concretely, that mocked tests and real integration tests are testing different
things. A mocked database or a mocked LLM tells you your code does what you told it to expect.
Only a real CockroachDB cluster and a real Claude call can tell you whether what you *expected*
was actually correct — and in this project, both surfaced genuine bugs mocks had no way to
catch.

**On production engineering, more generally:**

- Idempotency isn't one property you either have or don't — it's decomposed per write.
  Reflection's group processing (cluster → propose → validate → apply → checkpoint) needed a
  separate resumability answer for each individual write inside it: creating knowledge,
  reinforcing knowledge, linking evidence, and recording the audit entry each needed their own
  "did this already happen" check, not one blanket retry wrapped around the whole group.
- An optimistic-concurrency guard is only as strong as the fidelity of the value you compare
  against. The resume bug wasn't a logic error in the comparison itself — it was that the value
  being compared had already silently lost precision on the way in. That's an easy category of
  bug to write, and an easy one to never notice, because nothing about the code *looks* wrong.

**On building with LLMs specifically:**

- A third-party API's rate limit isn't just a production concern — it actively shapes what you
  can build. Voyage's free-tier limit is a real reason reflection groups experiences by
  token-overlap instead of embedding similarity: embedding-based clustering would be the more
  principled choice, but it would've meant re-embedding the whole seed set on every single test
  run while building this feature, which the rate limit made impractical long before it became
  a production concern at all.
- A structured-output schema constrains *shape*, not *correctness*. JSON Schema can require a
  field to be a number, but it can't express "this number must be between 0 and 1," and it
  definitely can't express "this id must be one of the ones actually retrieved for this
  request." Application code has to enforce both regardless of how carefully the schema is
  written — the schema narrows what you have to validate, it doesn't replace validating it.
- Graceful degradation isn't a single policy you apply everywhere — the right answer depends on
  whether the degraded state is recoverable later. When embedding a search query fails,
  degrading to experiences-only is safe, because the same search can just be retried later with
  no lasting damage. When embedding a *new piece of knowledge* fails, degrading would mean
  writing a row that's permanently invisible to future similarity search with no way to back
  it in — so that path fails loudly instead. Same failure, opposite response, because the two
  situations aren't actually the same.
- For an actively-evolving surface like CockroachDB's vector-indexing syntax, working against
  the cluster's actual live schema and current docs — rather than trusting cached knowledge —
  closed a real correctness gap, not a convenience one. Syntax that changed after any model's
  training cutoff doesn't announce itself; the live system is the only thing that's actually
  current.

**On agent loops specifically:**

- A small, hand-rolled loop keeps every failure attributable to a specific, readable line in
  code you wrote. When the citation-format bug surfaced, finding it meant reading the one file
  where the prompt and the validator both live — no framework layer sat between them to dig
  through first.
- A multi-step agent pipeline's real crash-recovery question isn't "did the whole run finish" —
  it's "which of this run's several distinct writes already landed." A crash could plausibly
  happen after the knowledge row was created but before its evidence links were, or after the
  evidence links but before the audit entry — each of those is a genuinely different state to
  resume from correctly, not one binary "done or not."
- An audit trail for agent decisions is only actually trustworthy if it can't misrepresent what
  happened *even when the process crashes mid-write* — which is why the audit-log write itself
  needed its own resume-safe guard, separate from the underlying data write it was recording.
  A durable record of "what the agent did" that can silently duplicate itself on retry isn't
  really durable.

## What's next for Tendwa

- Confidence decay is still a WIP: `calculateDecayedConfidence` and `decayKnowledgeConfidence`
  work and are tested, but nothing in the running system calls them yet. Wiring that up so
  confidence actually decays over time, not just gets reinforced, is next.
- A second domain adapter that's genuinely unlike incident response would be a much stronger
  test of whether the engine/domain separation holds up in practice and not just in principle —
  another ops/support-flavored domain wouldn't really prove anything new. Sales strategy (which
  approach actually closes a deal against a given objection), marketing or growth
  experimentation (which message angle actually moves conversion for which audience), or
  e-commerce demand planning (which reorder patterns actually prevent a stockout) are the kind
  of decision every company makes on gut feel today and rarely gets systematically better at —
  exactly the gap this pattern is built to close.
- Surfacing evidence counts and references directly on knowledge cards in the dashboard — the
  underlying `knowledge_evidence` links already exist and are queryable; nothing currently
  exposes them through an API response.
- Keyset pagination and richer filtering on knowledge/experience lists as usage grows past demo
  scale.
