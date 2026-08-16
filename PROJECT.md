# Tendwa

## One-line description

A compound memory engine for agentic systems — it turns raw experience into durable,
confidence-weighted knowledge, and uses that knowledge to improve future decisions.

## Problem

Most "AI agent memory" is really just retrieval — store some text, embed it, fetch similar
text later. That's useful, but it isn't learning: nothing ever gets stronger or weaker based
on whether it actually helped. Knowledge doesn't accumulate, doesn't get reinforced by real
outcomes, and doesn't decay when it stops being relevant.

## Why this matters

An agent that can only retrieve is a search engine with extra steps. An agent whose memory
compounds — where confirmed-useful knowledge gets stronger and unconfirmed or stale knowledge
fades — starts to resemble how an organization actually builds expertise over time. That's a
meaningfully different, and harder, problem than retrieval-augmented generation.

## Product thesis

Memory should have a lifecycle, not just storage: something happens (**experience**), the
system periodically looks for patterns across related experiences (**reflection**), durable,
confidence-scored facts get written or reinforced (**knowledge**), and future decisions are
shaped by that knowledge rather than by raw, undigested history (**strategy**). Confidence
rises when a real outcome confirms a piece of knowledge, and decays when nothing reinforces it.

## Target user

Teams or individuals who make repeated, similar decisions over time and currently rely on
scattered institutional memory (chat threads, personal notes, tribal knowledge) to avoid
solving the same problem twice.

## Demonstration domain: incident response

Engineering teams responding to production incidents are the concrete domain this is built
and demonstrated against first: postmortems and resolutions become experiences, recurring
root-cause patterns become knowledge, and a new incident retrieves and cites the specific
past cases and lessons it's drawing from.

## Core user journey

1. An incident (or other domain event) is submitted.
2. The system retrieves similar past experiences and relevant learned knowledge.
3. It proposes a recommendation, citing exactly which past cases and knowledge informed it.
4. A human records the actual outcome.
5. On a schedule, the reflection process looks for patterns across recent experiences and
   outcomes, and reinforces or creates knowledge accordingly — with full evidence tracking
   for why the system believes what it believes.

## Memory lifecycle

```text
Experience → Reflection → Knowledge → Strategy → Recommendation → Outcome → Reflection...
```

Full schema and technical detail: see `ARCHITECTURE.md`.

## What makes this different from a typical memory-plus-LLM app

- Memory isn't just retrieval — knowledge is confidence-weighted and reinforced (or allowed
  to decay) based on real outcomes, not just written once and trusted forever.
- Every piece of knowledge traces back to the specific experiences that produced it via an
  explicit evidence relationship — not an opaque confidence number, an inspectable one.
- The core memory engine has no knowledge of the demonstration domain at all — incident
  response is a thin adapter on top of a domain-agnostic core, so the same engine can support
  other domains without touching its internals.
- The model never writes to the database directly. It proposes a structured change;
  application code validates it before anything is persisted.

## MVP scope

Single organization, one domain adapter (incident response), a working experience → retrieve
→ recommend → outcome → reflect loop, crash-safe reflection processing, and a minimal
interface to interact with all of it.

## Explicit non-goals (for now)

Multi-tenant polish, authentication/authorization beyond basic scoping, multiple LLM
providers, multiple simultaneous domain adapters, a production-scale deployment topology.
These are reasonable future directions, not requirements of the current build.

## Future vision

The same engine, unchanged at its core, extending to other domains where the same lifecycle
applies — anywhere repeated decisions benefit from confidence-weighted, evidence-linked
memory rather than one-shot retrieval.
