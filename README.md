# Tendwa

**A compound memory engine for agentic systems.** Tendwa turns raw experience into durable,
confidence-weighted knowledge — and uses that knowledge to improve future decisions. It's
demonstrated here through an incident-response assistant that remembers what actually worked.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](tsconfig.base.json)
[![CockroachDB](https://img.shields.io/badge/CockroachDB-vector--indexed-6933FF)](ARCHITECTURE.md)

**[Read the story behind this project →](PROJECT_STORY.md)**

## Table of contents

- [Why this exists](#why-this-exists)
- [How it works](#how-it-works)
- [Demo](#demo)
- [Tech stack](#tech-stack)
- [Repository structure](#repository-structure)
- [Getting started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [1. Clone and install](#1-clone-and-install)
  - [2. Provision a CockroachDB Cloud cluster](#2-provision-a-cockroachdb-cloud-cluster)
  - [3. Get API keys](#3-get-api-keys)
  - [4. Configure environment variables](#4-configure-environment-variables)
  - [5. Run migrations](#5-run-migrations)
  - [6. Seed demo data](#6-seed-demo-data)
  - [7. Configure the web app](#7-configure-the-web-app)
  - [8. Run everything](#8-run-everything)
  - [9. See it learn](#9-see-it-learn)
- [Testing](#testing)
- [API overview](#api-overview)
- [Documentation](#documentation)
- [Design principles](#design-principles)
- [Current limitations](#current-limitations)
- [License](#license)
- [Acknowledgments](#acknowledgments)

## Why this exists

Most "AI agent memory" is really just retrieval — store some text, embed it, fetch similar text
later. That's useful, but it isn't learning: nothing ever gets stronger or weaker based on
whether it actually helped. Knowledge doesn't accumulate, doesn't get reinforced by real
outcomes, and doesn't decay when it stops being relevant.

Tendwa gives memory a lifecycle instead: something happens (**experience**), the system
periodically looks for patterns across related experiences (**reflection**), durable,
confidence-scored facts get written or reinforced (**knowledge**), and future decisions are
shaped by that knowledge rather than by raw, undigested history (**strategy**). Confidence rises
when a real outcome confirms a piece of knowledge, and decays when nothing reinforces it.

The demonstration domain is incident response — engineering teams responding to production
incidents are a natural fit: postmortems and resolutions become experiences, recurring
root-cause patterns become knowledge, and a new incident retrieves and cites the specific past
cases and lessons it's drawing from. The core memory engine has **zero knowledge of "incident"**
anywhere in it — see [Design principles](#design-principles).

## How it works

```text
Experience → Reflection → Knowledge → Strategy → Recommendation → Outcome → Reflection...
```

1. **Experience** — a raw, dated event gets recorded (an incident occurred, a fix was applied).
2. **Reflection** — on a schedule, related experiences are clustered and an LLM is asked "what's
   the durable pattern here?" Every proposal is validated in code before anything is written —
   the model never touches the database directly (see [`ARCHITECTURE.md`](ARCHITECTURE.md#llm-proposes-code-validates--the-required-pattern-for-the-reflection-job)).
3. **Knowledge** — reflection reinforces existing knowledge (raising confidence) or writes new
   knowledge, each with a confidence score, evidence links back to the experiences that produced
   it, and a decay policy.
4. **Strategy** — a new situation retrieves relevant knowledge (not raw experience, via
   CockroachDB's vector index) and the agent's recommendation is shaped by what's actually been
   learned, citing exactly which past cases and knowledge it used.

## Demo

**[Watch the 3-minute demo video](https://vimeo.com/1219346407?share=copy&fl=sv&fe=ci)**

## Tech stack

| Layer | Technology |
| --- | --- |
| Language | TypeScript, Node.js ≥ 22 |
| API | [Fastify](https://fastify.dev) |
| Dashboard | [Next.js](https://nextjs.org) 16 (App Router, React 19 Server Components/Actions) |
| Database | [CockroachDB Cloud](https://www.cockroachlabs.com/product/cockroachdb-cloud/) — Postgres wire-compatible, with native [vector indexing](https://www.cockroachlabs.com/docs/stable/vector-search) (C-SPANN) for knowledge similarity search |
| LLM reasoning | [Anthropic API](https://www.anthropic.com/api) (Claude) — agent loop + reflection job |
| Embeddings | [Voyage AI](https://www.voyageai.com/) (`voyage-3.5`, 1024-dim) |
| Scheduled job | AWS Lambda — the reflection job runs on a schedule, independent of the API |
| Monorepo | pnpm workspaces, no build step for the backend (runs directly via [`tsx`](https://github.com/privatenumber/tsx)) |
| Testing | [Vitest](https://vitest.dev) |

No LangGraph or other agent-orchestration framework — the agent loop
(retrieve → reason → propose → observe) is hand-rolled TypeScript, deliberately, so the whole
thing is explainable without framework internals in the way.

## Repository structure

```text
tendwa/
├── packages/
│   └── engine/                 # domain-agnostic core — zero knowledge of "incident"
│       └── src/
│           ├── db/             # CockroachDB client + plain-SQL migrations
│           ├── memory/         # experience, knowledge, retrieval, reflection
│           └── agent/          # the hand-rolled retrieve → reason → propose loop
├── domains/
│   └── incident-response/      # the ONLY place incident-specific code lives
├── apps/
│   ├── api/                    # Fastify — HTTP surface over packages/engine
│   ├── worker/                 # AWS Lambda — thin wrapper that runs reflection on a schedule
│   └── web/                    # Next.js dashboard — incidents, agent recommendations, knowledge
├── ARCHITECTURE.md             # schema, system diagram, API reference, tooling decisions
├── PROJECT.md                  # what this is and why it's built this way
├── ENGINEERING.md              # production engineering standards this repo holds itself to
├── DECISIONS.md                # a running log of real decisions made along the way
└── CLAUDE.md                   # working conventions for AI-assisted development on this repo
```

Full schema and structure: see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Getting started

### Prerequisites

- **Node.js ≥ 22** and **[pnpm](https://pnpm.io)** (`corepack enable` will get you the right
  pnpm version automatically, per `package.json`'s `packageManager` field)
- A **[CockroachDB Cloud](https://cockroachlabs.cloud/)** account (free tier is fine) — this
  project connects to a real cloud cluster in both development and testing; there's no
  Docker/local-database option (see [`ARCHITECTURE.md`](ARCHITECTURE.md#resolved-tooling-decisions-locked-in-dont-reopen-without-a-real-reason) for why)
- An **[Anthropic API key](https://console.anthropic.com/)** — powers the agent's reasoning and
  the reflection job
- A **[Voyage AI API key](https://dashboard.voyageai.com/)** — powers embeddings

### 1. Clone and install

```bash
git clone https://github.com/jnjerin/tendwa.git
cd tendwa
pnpm install
```

### 2. Provision a CockroachDB Cloud cluster

Create a free cluster at [cockroachlabs.cloud](https://cockroachlabs.cloud/), then create **two**
databases on it: one for development, one for tests (never point both at the same database — see
[`ARCHITECTURE.md`](ARCHITECTURE.md#resolved-tooling-decisions-locked-in-dont-reopen-without-a-real-reason)).
Grab the connection strings from the Cloud Console's "Connect" tab for each.

### 3. Get API keys

- Anthropic: [console.anthropic.com](https://console.anthropic.com/) → API Keys
- Voyage AI: [dashboard.voyageai.com](https://dashboard.voyageai.com/) → API Keys

> **Voyage's free tier is rate-limited to 3 requests/minute.** Reflection makes one embedding
> call per experience group (sometimes two), so with a non-trivial amount of seed data a
> reflection run can take a few minutes and may need to resume after hitting the limit — that's
> expected, not a bug (the reflection job checkpoints its progress and safely resumes; just
> re-run the same command). Adding a payment method on Voyage removes this limit.

### 4. Configure environment variables

```bash
cp .env.example .env
```

Fill in `.env` at the repo root:

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Your dev database's connection string |
| `TEST_DATABASE_URL` | for tests | A **separate** database on the same cluster |
| `ANTHROPIC_API_KEY` | yes | From step 3 |
| `VOYAGE_API_KEY` | yes | From step 3 |
| `LOG_LEVEL` | no | Defaults to `info` |
| `PORT` | no | Port for `apps/api`; defaults to `3000` |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | only for deploying `apps/worker` | Leave blank for local development |

This one `.env` file is shared by `packages/engine`, `domains/incident-response`, and
`apps/api` — they all resolve it from the repo root automatically.

### 5. Run migrations

```bash
cd packages/engine
pnpm run migrate
```

Plain, numbered SQL files, tracked in a `schema_migrations` table — safe to re-run any time,
already-applied versions are skipped.

### 6. Seed demo data

```bash
cd domains/incident-response
pnpm run seed
```

This creates a demo organization and 11 realistic incident-response experiences (each with a
recorded outcome), so there's something real to explore immediately. **Copy the org id it
prints** — you'll need it in the next step.

### 7. Configure the web app

```bash
cd apps/web
cp .env.example .env.local
```

Fill in `apps/web/.env.local`:

```text
TENDWA_API_BASE_URL=http://localhost:3000
TENDWA_ORG_ID=<the org id printed by the seed script>
```

### 8. Run everything

Three processes, three terminals, from the repo root:

```bash
# Terminal 1 — the API
cd apps/api && pnpm run dev

# Terminal 2 — the dashboard
cd apps/web && pnpm run dev
```

Open **<http://localhost:3001>** — you should see the 11 seeded incidents.

### 9. See it learn

Reflection doesn't run automatically in local development — trigger it once so the Knowledge
page has something to show:

```bash
cd packages/engine
pnpm run reflect --org=<your org id>
```

Then refresh **<http://localhost:3001/knowledge>**.

The scheduled path in production is `apps/worker` (AWS Lambda), which calls the same reflection
function directly rather than through the HTTP API — see
[`DECISIONS.md`](DECISIONS.md) for why.

## Testing

```bash
pnpm run typecheck   # every package
pnpm run test        # unit tests, every package (mocked dependencies, no live DB needed)
pnpm run test:integration   # exercises the real CockroachDB cluster in TEST_DATABASE_URL
```

Testing philosophy, in brief: unit tests for logic with no external dependency, integration
tests for repository methods against the real database, explicit failure-path tests (not just
happy paths), and agent/reflection tests that mock the LLM response specifically to verify
malformed proposals get rejected. Full standard: [`ENGINEERING.md`](ENGINEERING.md#6-testing).

## API overview

All routes are org-scoped (`orgId` as a body field on writes, a `?orgId=` query param on reads).

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/incidents` | Record a new incident (experience) |
| `GET` | `/incidents` | List incidents for an org |
| `GET` | `/incidents/:id` | Fetch one incident |
| `POST` | `/incidents/:id/analyze` | Retrieve memory + agent reasoning → recommendation |
| `POST` | `/incidents/:id/outcome` | Record what actually happened |
| `GET` | `/incidents/:id/outcome` | Fetch the recorded outcome, if any |
| `GET` | `/memory/search` | Hybrid structured + vector retrieval |
| `POST` | `/reflection/run` | Manually trigger reflection for an org |
| `GET` | `/knowledge` | List distilled knowledge |
| `GET` | `/knowledge/:id` | Fetch one knowledge item |
| `GET` | `/health` / `GET /ready` | Liveness / readiness |

Full request/response shapes: [`ARCHITECTURE.md`](ARCHITECTURE.md#api-endpoints-mvp).

## Documentation

| Document | What it covers |
| --- | --- |
| [`PROJECT_STORY.md`](PROJECT_STORY.md) | Why this was built, how it came together, and the real bugs found along the way |
| [`PROJECT.md`](PROJECT.md) | What this is, why it's built this way, who it's for |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Full schema, system diagram, API reference, resolved tooling decisions |
| [`ENGINEERING.md`](ENGINEERING.md) | Production engineering standards this repo holds itself to — reliability, security, observability |
| [`DECISIONS.md`](DECISIONS.md) | A running log of real decisions made while building this, with reasoning — including bugs found and fixed along the way |
| [`CLAUDE.md`](CLAUDE.md) | Working conventions for AI-assisted development on this repo |

## Design principles

- **The engine/domain separation is real, not aspirational.** `packages/engine` has zero
  references to "incident" or any domain-specific concept anywhere in it. All domain logic lives
  in `domains/incident-response`. The same engine could support a different domain without
  touching its internals.
- **LLM proposes, code validates — always, no exceptions.** The model never generates or
  executes SQL, and its output is never written directly to the database. It returns a
  structured proposal; application code validates it before applying it through repository
  methods. Every reflection run logs both the proposal and what was actually applied.
- **Every table is scoped by `org_id`.** No exceptions.
- **`knowledge_evidence` is a junction table with foreign keys**, never a UUID array column —
  every knowledge row's provenance is queryable via a plain JOIN.
- **No agent-orchestration framework.** The retrieve → reason → propose → observe loop is
  hand-rolled TypeScript on purpose.

## Current limitations

Honest about what's deliberately out of scope for this MVP (see
[`PROJECT.md`](PROJECT.md#explicit-non-goals-for-now) for the full list):

- Single organization, single domain adapter (incident response) — the engine itself is
  domain-agnostic, but nothing else in the demo exercises a second domain yet.
- No authentication/authorization beyond `org_id` scoping.
- No live "reflection is running" indicator in the dashboard — reflection is triggered
  out-of-band (CLI or Lambda), and its results simply appear once complete.
- Knowledge cards don't yet surface an evidence count/reference list in the UI, even though the
  underlying `knowledge_evidence` links exist and are queryable — nothing currently exposes them
  through an API response.

## License

[MIT](LICENSE) — see the [`LICENSE`](LICENSE) file for the full text.

## Acknowledgments

- [CockroachDB](https://www.cockroachlabs.com/) — distributed SQL with native vector search
- [Anthropic](https://www.anthropic.com/) — Claude, for both agent reasoning and reflection
- [Voyage AI](https://www.voyageai.com/) — embeddings
