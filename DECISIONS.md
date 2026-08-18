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

2026-08-16 — embedText makes a single attempt, no bounded retry, unlike recordExperience's
40001 retry or migrate.ts's retry-with-backoff. retrieveMemory already has a defined,
well-tested fallback for embedding failure (degrade to experiences-only), and the Voyage
account used in development is on a 3 RPM free tier, where an automatic retry would burn
through the rate limit faster than it would recover from a transient failure. If embeddings
move to a paid tier with real capacity, revisit adding one bounded retry before degrading.

2026-08-16 — Added packages/engine/src/memory/outcome.ts (recordOutcome), mirroring
recordExperience's validation shape, 40001-retry scope, and logging conventions exactly.
outcomes lives in the engine, not domains/incident-response, because its columns (status,
root_cause, action_taken, result) carry zero incident-specific meaning — the same
domain-agnostic reasoning that already puts experiences and knowledge in the engine.

2026-08-16 — recordOutcome/incidentToOutcome don't verify that experienceId's org_id actually
matches the orgId being written with — validateNewOutcome only checks UUID shape. Nothing in
this codebase can currently produce a mismatch (experienceId always comes from a
recordExperience call made moments earlier with the same orgId, in both the seed script and its
tests), so this is a deliberately deferred check, not an oversight. Revisit before building any
endpoint (e.g. a future POST /incidents/:id/outcome) that accepts an experienceId from outside
its own immediately-prior recordExperience call — that's the point at which a mismatched
org_id/experience_id pair becomes reachable, not merely theoretical.

2026-08-16 — domains/incident-response imports from packages/engine via plain relative paths
(e.g. `../../packages/engine/src/memory/experience.js`), not a `@tendwa/engine` package-name
import. packages/engine has no public entrypoint yet — no index.ts, no package.json "exports"
field — and deciding that surface (what to export, whether it points at src/ or a built dist/)
is a real tooling decision of its own, not one to make implicitly as a side effect of building
the first domain adapter. Relative imports work fine in a monorepo with everything checked out
on disk; formalize a real package boundary (index.ts + exports) before a second domain or an
app package needs to consume the engine the same way.

2026-08-16 — domains/incident-response's seed script hardcodes every seeded outcome's status to
'resolved' rather than exposing a `status` field on the Incident type. Every incident in
seed-incidents.md is deliberately a resolved one (backstory for the demo); nothing in this
dataset exercises outcomes.status's 'failed' or 'partial' values yet, so a field nobody sets is
not worth adding. Revisit incidentToOutcome() in mapping.ts if a non-resolved incident is ever
seeded or submitted live.

2026-08-16 — The incident-response seed script classifies its target org as empty, partial, or
complete (getSeedStatus in seed.ts) before writing, rather than a plain "do any experiences
exist" boolean. seedIncidents() writes 11 experience+outcome pairs one at a time with no
transaction across the pair or the loop, so a process death partway through (a timeout on
incident #7, Ctrl-C before a demo) is a real, reachable state — code-reviewer and
production-reviewer both independently flagged that a boolean check can't tell a fully-seeded
org apart from a half-seeded one: re-running would either silently report "already seeded" on
an incomplete set (false confidence right before a demo), or duplicate the incidents that had
already landed. getSeedStatus checks both the experience count and the joined outcome count
against the expected total (11), so it also catches the narrower case where an experience
committed but its paired recordOutcome then failed. "partial" refuses to proceed without
--force, rather than guessing which of skip-or-reseed the operator wants. This is still a
single-operator, run-it-twice-by-accident safeguard, not a race-safe concurrency mechanism —
two seed-script invocations running at the same instant against the same org are not what this
guards against.

2026-08-17 — agent/loop.ts's Claude response uses a static JSON Schema
(`output_config.format`) instead of zod or a per-request dynamic enum of valid
experience/knowledge ids. No other module in the codebase uses zod, and validation stays
hand-rolled everywhere on purpose (see the ExperienceValidationError/RetrievalValidationError
pattern) — adding zod for one call site would break that consistency. A dynamic enum was
considered (constrain `citedExperienceIds`/`citedKnowledgeIds` to only the ids actually
retrieved, at the schema level) and rejected: JSON Schema still can't express the
knowledgeUnavailable-implies-empty-citedKnowledgeIds rule or the confidence range, so code has
to validate those regardless — a dynamic schema would add real complexity (a new schema, and
therefore no compilation-cache benefit, on every request) for a check that isn't actually
removed, just partially duplicated.

2026-08-17 — agent/loop.ts's reasoning/validation failures degrade to `status: "unavailable"`
(with the retrieval still attached) rather than throwing, but retrieval failures
(RetrievalValidationError, a DB error from retrieveMemory) are left to propagate uncaught. This
matches ENGINEERING.md §1's explicit "/analyze" example verbatim — "if the LLM call fails,
return the retrieved memory with a clear 'recommendation unavailable' rather than a bare 500"
— and keeps the split consistent with retrieveMemory's own contract, which already
distinguishes "embedding unavailable, degrade" from "DB failure, propagate" the same way.

2026-08-17 — agent/loop.ts deliberately does not write to agent_audit_log, even though it
implements the exact failure mode ENGINEERING.md §1 names ("LLM returns a malformed or invalid
proposal: schema validation rejects it, nothing is written to the database, the rejection
itself is recorded in agent_audit_log"). Both CLAUDE.md rule 4 and ARCHITECTURE.md's "LLM
proposes, code validates" code sample scope the audit-log requirement to the reflection job's
writes specifically — this file makes no database writes at all (production-reviewer confirmed
`pool` is only ever forwarded to retrieveMemory), so there is nothing here for an audit log to
record yet. The audit write belongs to the future `/incidents/:id/analyze` endpoint that calls
runAgentLoop and decides what to do with the result (both `status: "ok"` proposals and
`status: "unavailable"` rejections are "agent decisions" worth a durable record there) — noted
explicitly here so it isn't silently dropped when that endpoint is built.

2026-08-17 — createKnowledge (knowledge.ts) fails the whole write if embedding the statement
fails, rather than degrading to a row with a NULL embedding (the column is nullable, so that
path is technically available). This is the opposite default from retrieveMemory's
degrade-on-embedding-failure: a read must respond with *something*, but a knowledge row with
no embedding is invisible to queryKnowledgeBySimilarity forever, with no backfill mechanism
anywhere in this codebase to fix it later. reflect.ts, the only caller, can just retry the
whole operation, so failing loud here is safer than silently creating unsearchable knowledge.

2026-08-17 — addEvidence (knowledge.ts) enforces that knowledgeId and experienceId belong to
orgId with an application-level lookup before writing to knowledge_evidence, rather than
deferring the check the way the 2026-08-16 recordOutcome/experienceId entry does. Originally
implemented as a deferred check mirroring that precedent, but code-reviewer and
production-reviewer both independently flagged that the analogy was weaker than it looked:
recordOutcome at least persists its own org_id on the row it writes, so a mismatched
experienceId is only a partial gap; knowledge_evidence has no org_id column at all (see the
2026-08-16 entry on that), so addEvidence had zero enforcement of an orgId parameter it
otherwise just accepted and logged. The lookup is one cheap indexed round trip, so there's no
real cost to closing the gap now rather than deferring it — CLAUDE.md rule 5's "no exceptions"
line is easier to honor in code than to keep re-justifying in prose.

2026-08-17 — knowledge.ts's confidence decay uses a grace period (30 days) followed by daily
multiplicative decay (1%/day), floored at a minimum of 0.05 so a knowledge item never fully
vanishes. Nothing elsewhere in this repo specifies a decay formula — ARCHITECTURE.md asserts
knowledge has "a decay policy" but never defines one, and DECISIONS.md had no prior entry
either — so these are new, deliberately simple starting numbers, not a recorded requirement.
Revisit once real usage data suggests a different grace period or rate is warranted.

2026-08-17 — decayKnowledgeConfidence's UPDATE also refreshes last_reinforced_at to now() and
is conditioned on last_reinforced_at still matching the value its own SELECT read
(WHERE ... AND last_reinforced_at = $4), rather than a plain SET confidence = $3 WHERE org_id
= $1 AND id = $2. Both reviewers independently found real bugs in the original read-then-write
shape: (1) production-reviewer — without refreshing last_reinforced_at, calling this function
twice for the same row (e.g. reflect.ts retrying after a crash) recomputed decay from the same
staleness window both times and compounded it, so a second call wasn't a no-op the way it
should have been; (2) code-reviewer — the SELECT and UPDATE are two separate autocommitted
statements, not one transaction, so CockroachDB's SERIALIZABLE guarantee never covered the
pair, and a concurrent reinforceKnowledge landing between them would have been silently
overwritten by a decay computed from the pre-reinforcement snapshot (a lost update).
Refreshing last_reinforced_at fixes (1) by resetting the staleness clock on every applied
decay, the same way a genuine reinforcement would. Conditioning the UPDATE on the original
last_reinforced_at fixes (2): a concurrent write now makes the UPDATE affect 0 rows instead of
clobbering it, and the 0-row branch re-fetches and returns the row's current state rather than
retrying with a stale computed value. reinforceKnowledge's own duplicate-call case (a caller
retrying after a network timeout could double-increment reinforcement_count) is a separate,
lower-severity, pre-existing gap — deferred for the same reason recordExperience's 40001 retry
comment already gives for not solving idempotency at this layer: no natural dedupe key exists
yet, and request-level idempotency keys are a future concern for whatever endpoint calls this.

2026-08-18 — createPool() (db/client.ts) registers a global pg type parser for OID 20 (INT8),
coercing it via parseInt instead of pg's own default of returning it as a string. Found by
actually running knowledge.ts's integration test against real CockroachDB (the unit suite's
mocks always hand back a plain JS number, so this never surfaced there): CockroachDB's INT
defaults to 64-bit (INT8), and pg's default parser deliberately returns INT8 as a string
rather than a number, to avoid silently truncating a value beyond Number.MAX_SAFE_INTEGER —
which meant `Knowledge.reinforcementCount` and `KnowledgeMatch.reinforcementCount` (both typed
`number`) were actually strings ("1", not 1) at runtime the whole time. reinforcement_count is
the only INT column in the schema today, and it's a small counter with no realistic path to
exceeding safe-integer range, so a global coercion is safe here. This is a real precision
tradeoff, not a free lunch: if a future column genuinely needs true 64-bit integers, it must
not rely on this global parser — read it as a string explicitly and handle it with a bigint or
string-based representation, or that column will silently truncate past 2^53-1 the same way
this bug silently stringified before the fix.

2026-08-18 — Added packages/engine/src/memory/agentState.ts and auditLog.ts as new,
reflection-specific helper modules, ahead of reflect.ts itself. agentState.ts owns
find/claim/resume/checkpoint/complete/fail operations against agent_state (no prior read/write
helper existed for that table at all) plus the ReflectionRunPayload/ReflectionGroupState
checkpoint schema; auditLog.ts owns the one INSERT into agent_audit_log. Split into their own
files rather than inlined in reflect.ts to match the established one-file-per-table convention
(experience.ts, outcome.ts, knowledge.ts), and because agent_state's find/claim/checkpoint shape
isn't inherently reflection-specific — a future resumable agent loop could reuse the same table
and retry/logging conventions without touching reflect.ts.

2026-08-18 — reflect.ts's eligibility scope for "experiences not yet reflected on" is
outcome-paired only (INNER JOIN outcomes), and any outcome status counts — resolved, failed,
and partial all constitute evidence, not just resolved. A failed or partial outcome still
teaches something durable ("action X does not resolve Y"), which fits PROJECT.md's
confidence-weighted-knowledge framing; gating on status='resolved' would silently discard that
signal. This is unexercised by today's seed data (domains/incident-response's seed script
hardcodes every outcome to 'resolved', per the 2026-08-16 entry on that) but is the more
correct general design, chosen deliberately over the narrower "resolved only" default.

2026-08-18 — reflect.ts groups experiences by domain partition + generic token/word-overlap
similarity (Jaccard similarity over a stopword-filtered token set), not by embedding cosine
similarity, even though embeddings would be the more principled general-purpose similarity
measure. This is a deliberate dev-velocity tradeoff, not a claim that heuristic grouping is
better: Voyage's free tier (3 RPM, see the 2026-08-16 entry on embedText's retry stance) already
caused a real delay during this feature's own integration testing, and embedding-based grouping
would re-embed the entire seed set on every local reflect.ts test run across what was expected
to be (and was) many iterations while building this file. Knowledge itself still gets a real
Voyage embedding via createKnowledge, and each group's nearby-knowledge lookup still costs one
real embedding call — only the experience-to-experience grouping step avoids embeddings. Revisit
once a paid Voyage tier removes the rate-limit concern; the natural upgrade is switching
groupExperiences to embed each experience and cluster by cosine similarity, reusing embedText
the same way knowledge.ts and retrieve.ts already do.

2026-08-18 — reflect.ts checkpoints an apply attempt (agent_state.payload.groups[i].applyAttempt)
around the one non-idempotent write per group (createKnowledge or reinforceKnowledge),
in addition to the per-group checkpoint the task called for, because a group's apply step is
itself two sequential writes and a crash between the first landing and the group being marked
complete would otherwise re-issue it on resume — a true duplicate row for createKnowledge, or
the same double-increment gap already documented for reinforceKnowledge's bare retry case
(2026-08-17 entry). For createKnowledge, the checkpoint records the new row's id the instant it
returns, before evidence-linking starts; a resume with that id already present reuses it instead
of calling createKnowledge again. For reinforceKnowledge, the checkpoint records a
confidence/reinforcement_count snapshot read just before the call; a resume re-reads the current
row and only re-calls reinforceKnowledge if the row still matches that snapshot (the same
read-a-prior-snapshot-and-compare idiom decayKnowledgeConfidence already uses, applied here at
the application layer since reinforceKnowledge itself has no built-in optimistic-concurrency
guard). Reuse is gated on the checkpointed applyAttempt.action matching the freshly-fetched
proposal's action specifically — a resumed run re-asks Claude rather than replaying the original
proposal, and sampling means the retry isn't guaranteed to return the same action; reusing a
stale create's knowledgeId for a proposal that now says reinforce would link evidence to the
wrong row while never applying the real proposal. Found and fixed while writing reflect.test.ts's
resume-path tests, before this ever ran against a real crash. Residual, deliberately accepted gap:
if the client loses the acknowledgment after the write already committed (not merely fails before
committing), the snapshot comparison correctly detects "already applied" for reinforceKnowledge,
but createKnowledge has no natural dedupe key to detect the same situation after the fact — closing
that fully needs an idempotency key on knowledge inserts, which is a schema change out of scope
here and left as a known gap, the same way reinforceKnowledge's own bare-retry gap already is.

2026-08-18 — reflect.ts's applyAttempt checkpoint gained a third field, auditRecorded, after
production-reviewer found that the "applied" path's recordAuditEntry call had no dedup guard of
its own: a crash between that INSERT committing and the group being marked "completed" would
resume into a fresh recordAuditEntry call, writing a second "reflection.proposal_applied" entry
for a proposal that was, at most, actually applied once (the underlying createKnowledge/
reinforceKnowledge write was already correctly deduped by applyAttempt's other fields — only the
audit trail itself was exposed). Since agent_audit_log is explicitly the durable record of what
was applied, not just an operational log line, a phantom duplicate there actively misrepresents
history rather than merely cluttering it. Fixed the same way as every other sub-checkpointed
write in this file: recordAuditEntry is skipped if applyAttempt.auditRecorded is already true,
and a checkpoint immediately follows a successful call to set it, before the final
group-completed checkpoint. Covered by a dedicated resume test in reflect.test.ts. Residual gap,
deliberately accepted and now stated explicitly in-code: this narrows the risk window to
"between recordAuditEntry committing and its own checkpoint landing" but doesn't fully close it —
agent_audit_log has no natural dedupe key (unlike knowledge_evidence's ON CONFLICT DO NOTHING),
so a crash in that exact narrower window can still produce one duplicate row. Same class of gap
as createKnowledge's lost-acknowledgment case above; closing it fully would need real dedupe
columns (e.g. run_id + group_index) with a unique constraint on agent_audit_log, a schema change
out of scope here.

2026-08-18 — reflect.ts's ReflectionGroupState checkpoint gained a `proposal` field (moved from
being computed fresh every call to being cached the instant it's validated), after code-reviewer
found a more serious version of the resume-replay problem than the auditRecorded gap above: since
processGroup re-asked Claude for a fresh proposal on every resume rather than persisting the one
already validated, and Claude's sampling isn't pinned to temperature 0, a resumed group's fresh
sample was never guaranteed to return the same action as one that might already be partially or
fully applied. Concretely: if a crash landed after createKnowledge/reinforceKnowledge committed
(applyAttempt.knowledgeId or .reinforceSnapshot already checkpointed) but before the group was
marked "completed", a resumed sample returning a different action would silently orphan the
already-committed write — worse, a resumed sample returning "skip" would cause the group to be
recorded as "reflection.proposal_skipped" even though a real write had already landed, which is
exactly the kind of misrepresentation CLAUDE.md rule 4's "logs both the proposal and what was
actually applied" is meant to prevent. Fixed by checkpointing the validated ReflectionProposal
itself the moment validation succeeds, before anything is applied from it; a resumed group with
an already-cached proposal replays it exactly and never calls Claude again for that group. The
ReflectionProposal interface moved from reflect.ts into agentState.ts as part of this, since it's
now genuinely part of the persisted checkpoint schema, not solely reflect.ts's own working data —
reflect.ts imports the type from there instead of defining it locally. This also fully subsumes
the narrower "stale applyAttempt.action mismatch" guard added earlier in applyProposal: under the
current code that guard is unreachable in normal operation (proposal is always cached before
applyAttempt can be set), but it's kept as defense-in-depth rather than removed, since it's a
correct, cheap safety net against any future code path that doesn't go through the caching
discipline. Covered by two dedicated resume tests in reflect.test.ts, including one that
reproduces the exact orphan/false-skip scenario code-reviewer described and asserts Claude is
never called and the group is correctly completed, not skipped.

2026-08-18 — Two lower-severity gaps production-reviewer found in reflect.ts/agentState.ts are
recorded here as deliberately deferred rather than fixed in this pass, since both require a
schema migration and CLAUDE.md's working-style rule requires Plan mode (and, in practice here,
explicit sign-off) for anything touching the schema — not something to do as a drive-by inside
an already-large feature the day before a demo:
(1) claimReflectionRun has no unique constraint backing it, unlike resumeReflectionRun's
compare-and-swap — two invocations that both see no active run (e.g. two overlapping Lambda
retries for the same org, the same at-least-once-semantics scenario the CAS guard was built for)
could each INSERT their own fresh 'running' row and process overlapping work. Closing this needs
a partial unique index, e.g. CREATE UNIQUE INDEX ON agent_state (org_id, step) WHERE status =
'running'. (2) reflect.ts introduces the first genuinely repeated, index-shaped query pattern
against experiences (a (created_at, id) keyset-paginated scan) and against agent_state (find the
latest non-completed row per org+step), and neither table has a supporting index for it yet —
harmless at demo scale, but worth a migration adding (org_id, created_at, id) on experiences and
(org_id, step, status) on agent_state before this runs against real accumulated volume.

2026-08-18 — agent/loop.ts's citation format was genuinely ambiguous: the prompt labels each
retrieved item in brackets as `[experience:<id>]`/`[knowledge:<id>]` and says to "cite those
ids exactly as given," without saying whether "the id" means the bare id after the colon (what
validateAgentProposal actually checks against) or the whole bracketed token including the type
prefix. Found by running agent/loop.ts's integration test against a real Claude Sonnet 5 call
(the mocked unit tests always hand back exactly the id string a test writes, so this ambiguity
had no way to surface there): the model picked the "whole token" reading, cited
`experience:<uuid>` instead of `<uuid>`, and validateAgentProposal correctly rejected it as
"not retrieved" — the validator did its job, but the underlying citation was actually correct,
so a working answer got wrongly downgraded to `status: "unavailable"`. Fixed on both ends: the
prompt now spells out explicitly that the id is only the part after the colon, and
validateAgentProposal strips a recognized `experience:`/`knowledge:` prefix (via
stripCitationPrefix) before checking membership, so either reading of the original wording now
resolves to the same validated citation. This doesn't weaken the actual security property —
CLAUDE.md rule 4's "code validates, never trust the LLM's output directly" — because the
stripped result still has to exactly match an id retrieval actually returned; a genuinely
fabricated id, prefixed or not, is still rejected.

2026-08-18 — Added apps/api (Fastify) and apps/worker (Lambda), the first external-facing
consumers of packages/engine. Three read paths the engine genuinely didn't have yet were added
first, in the exact style of their sibling functions, since the required GET routes had nothing
to call: getExperienceById + ExperienceNotFoundError (experience.ts), and
listKnowledge/getKnowledgeById/validateListKnowledge (knowledge.ts). listKnowledge uses its own
LIST_DEFAULT_LIMIT/LIST_MAX_LIMIT (20/100) rather than retrieve.ts's retrieval-sized limits,
since it's a browsing/dashboard list, not bounded LLM context, and has no keyset pagination yet
— a bounded `limit` is enough at this project's actual scale, revisit if a real dashboard needs
"load more" paging. logger.ts's inline pino options object was extracted into an exported
`pinoOptions` constant so apps/api can build Fastify's own logger from the exact same redact
config rather than a second, hand-copied one — this exact redact list already caused one real
bug from drift once before (see the 2026-08-16 entry), and a second independently-maintained
copy anywhere else in the repo would just reintroduce that risk for no benefit.

2026-08-18 — POST /incidents/:id/outcome (apps/api) looks up the experience via
getExperienceById before calling recordOutcome, 404ing if it doesn't exist or doesn't belong to
orgId. This is the ownership check the 2026-08-16 entry on recordOutcome named this exact future
endpoint as the point where a mismatched org_id/experience_id pair becomes reachable — closed
here the same way addEvidence's ownership check closed the analogous gap for knowledge_evidence.

2026-08-18 — Added getOutcomeByExperienceId (outcome.ts) and used it in POST
/incidents/:id/outcome to reject a duplicate outcome for the same experience with 409, rather
than silently inserting a second row. outcomes has no unique constraint on experience_id, and
recordOutcome itself has never checked for one (a deliberately deferred gap — see the
2026-08-16 entry, "outcomes has no natural dedupe key either"). That was a defensible deferral
as long as recordOutcome's only callers were single-shot scripts; production-reviewer flagged
that this endpoint changes the picture — it's the first HTTP-reachable, retry-prone caller, and
reflect.ts's own EXPERIENCE_OUTCOME_SELECT comment already documents an assumption of "at most
one outcome per experience" that a duplicate row would silently violate, feeding double-counted
evidence into knowledge distillation. No schema change (no unique constraint) — an
application-level check before the write was enough to close the gap without touching the
schema outside Plan mode.

2026-08-18 — POST /incidents/:id/analyze (apps/api) now writes one agent_audit_log entry per
call via recordAuditEntry (action "agent.analyze", detail carries the proposal or the
unavailable-reason) — this is the audit write the 2026-08-17 entry on agent/loop.ts explicitly
deferred to this future endpoint, covering both the status:"ok" and status:"unavailable"
branches (CLAUDE.md rule 4 treats a degraded/unavailable result as an agent decision worth a
durable record too, not just a successful proposal). The audit write is wrapped in its own
try/catch, separate from the agent loop call: production-reviewer found that an unguarded
await let a recordAuditEntry failure turn an already-computed, possibly LLM-costly agent result
into a bare 500 — inverting ENGINEERING.md §1's graceful-degradation intent for this exact
endpoint, where a secondary (audit) write failing should never discard a valid primary result.
A failed audit write is now logged loudly (agent_audit_log is the durable audit trail, not just
an operational log line) but the agent result is still returned to the caller.

2026-08-18 — Neither POST /incidents/:id/analyze nor POST /incidents/:id/outcome gets a request-
level idempotency key. /analyze doesn't need one: a duplicate call produces two accurate,
independent agent_audit_log entries (each a real invocation, not a fabricated duplicate) and one
extra bounded LLM call — a cost, not a correctness problem, since /analyze never mutates
incident data. /outcome's duplicate-row risk is closed by the 409 guard above instead of a
dedupe key, since a plain existence check was cheaper than adding one and didn't need a schema
change.

2026-08-18 — @tendwa/api registers @fastify/cors with `origin: true` (reflects the request's own
Origin rather than a maintained allowlist) — apps/web (the Next.js dashboard) is next on the
roadmap and will call this API cross-origin in local dev, and adding CORS now avoids losing time
later to what looks like an API bug but is actually a missing plugin on the first frontend
fetch. Permissive is the right level of effort here: PROJECT.md's MVP scope explicitly excludes
authentication/authorization, so there's no auth/cookie boundary anywhere in the API for a
permissive origin to actually weaken, and org-scoping is still enforced at the query layer
regardless of request origin.

2026-08-18 — apps/worker/src/handler.ts calls packages/engine's runReflection() directly,
in-process, rather than making an HTTP call to POST /reflection/run. This is a deliberate
reading of ARCHITECTURE.md's now-corrected "Lambda calls this on schedule" note: it named the
manual/dashboard trigger path, while the actual scheduled job calls straight into the engine it
already shares a workspace with — avoiding giving the Lambda network/auth access to the API for
a call that's trusted and internal anyway, and reusing createPool()/runReflection() verbatim
with nothing duplicated from reflect.ts. POST /reflection/run remains for manual/dashboard-
triggered runs. The Lambda's Pool is created once at module scope and reused across warm
invocations (never `.end()`ed inside the handler, matching the standard Lambda+pg pattern), and
errors from runReflection are deliberately left uncaught so Lambda's own retry/alerting
semantics fire — a retry lands on runReflection's existing agent_state crash-resume path.
