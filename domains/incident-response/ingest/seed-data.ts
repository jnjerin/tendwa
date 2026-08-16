// Transcribed from domains/incident-response/../../seed-incidents.md (repo root). Real-inspired
// incidents are paraphrased summaries in our own words, never copied text, with a sourceUrl
// noting what they're inspired by; synthetic incidents are invented for this project and carry
// no sourceUrl. `title` is left empty for every entry here — the source file's `content` is
// already a single fused narrative paragraph with no separable lead sentence (see
// mapping.ts's incidentToExperience), so content is stored verbatim rather than gaining an
// invented title.
//
// occurredAt timestamps aren't given by the source file (it only records content/metadata/
// outcome) — they're synthesized here as a plausible chronological spread across the two
// months leading up to the demo, so recency-ordered retrieval has something real to sort.
import type { Incident } from "../mapping.js";

export interface SeedIncident {
  /** Reference label from seed-incidents.md — not stored, just for traceability. */
  id: string;
  incident: Incident;
  /** false for B6 — held back to submit live during the demo, not seeded now. */
  seedNow: boolean;
}

export const SEED_INCIDENTS: SeedIncident[] = [
  {
    id: "A1",
    seedNow: true,
    incident: {
      title: "",
      description:
        "A database provider experienced a major multi-hour outage after an operator, during routine debugging, mistyped a command that removed far more capacity than intended. The mistake cascaded into a large-scale service disruption because the command had insufficient guardrails against accidental over-scoping.",
      service: "database-cluster",
      environment: "production",
      severity: "critical",
      sourceUrl: "public postmortem — cloud database provider, 2017 capacity-removal incident",
      occurredAt: "2026-05-04T14:22:00Z",
      rootCause: "insufficient guardrails on a manual operational command",
      actionTaken: "added confirmation/scoping safeguards to the operational command",
      result: "capacity restored after failover; safeguard added to prevent recurrence",
    },
  },
  {
    id: "A2",
    seedNow: true,
    incident: {
      title: "",
      description:
        "A CDN provider suffered a global outage after deploying a routine rule update containing a regular expression with catastrophic backtracking behavior. The pattern caused CPU exhaustion across the edge network within minutes of rollout.",
      service: "edge-cdn",
      environment: "production",
      severity: "critical",
      sourceUrl: "public postmortem — CDN provider, catastrophic-backtracking regex incident",
      occurredAt: "2026-05-18T09:10:00Z",
      rootCause: "catastrophic backtracking in a newly deployed regex rule",
      actionTaken: "reverted the rule update; added regex complexity limits to the deploy pipeline",
      result: "service restored within the hour; regression prevented via pipeline check",
    },
  },
  {
    id: "A3",
    seedNow: true,
    incident: {
      title: "",
      description:
        "A source-control platform experienced an extended outage triggered by a network partition during a database failover. Automated failover logic made the situation worse before a manual intervention resolved it.",
      service: "source-control-db",
      environment: "production",
      severity: "high",
      sourceUrl: "public postmortem — source control platform, database failover incident",
      occurredAt: "2026-06-02T03:47:00Z",
      rootCause: "automated failover logic behaved incorrectly under a network partition",
      actionTaken: "manual failover override; failover logic revised",
      result: "service restored after manual intervention",
    },
  },
  {
    id: "A4",
    seedNow: true,
    incident: {
      title: "",
      description:
        "Payments API latency spiked to roughly 8x baseline 12 minutes after a routine deploy. Investigation found the database connection pool size had been left at its default of 10 despite traffic having grown roughly 4x since it was last tuned.",
      service: "payments-api",
      environment: "production",
      severity: "high",
      occurredAt: "2026-06-10T16:05:00Z",
      rootCause: "connection pool size left at default despite traffic growth",
      actionTaken: "raised pool size; added pool-saturation alerting",
      result: "latency returned to baseline within 15 minutes",
    },
  },
  {
    id: "A5",
    seedNow: true,
    incident: {
      title: "",
      description:
        "Checkout service began timing out under normal Friday-evening traffic. Root cause was a newly upgraded ORM version that had silently changed the default connection lifetime, causing connections to be recycled far more aggressively than intended.",
      service: "checkout-service",
      environment: "production",
      severity: "high",
      occurredAt: "2026-06-21T20:33:00Z",
      rootCause: "ORM upgrade silently changed default connection lifetime",
      actionTaken: "pinned connection lifetime explicitly in configuration",
      result: "timeouts stopped after redeploy with pinned config",
    },
  },
  {
    id: "A6",
    seedNow: true,
    incident: {
      title: "",
      description:
        "Internal reporting service exhausted its database connection pool after a scheduled batch job's concurrency was increased without a corresponding increase to the pool size.",
      service: "reporting-service",
      environment: "production",
      severity: "medium",
      occurredAt: "2026-06-29T11:15:00Z",
      rootCause: "batch job concurrency increased independently of connection pool size",
      actionTaken: "coupled batch concurrency and pool size in shared configuration",
      result: "no further pool exhaustion after fix deployed",
    },
  },
  {
    id: "B1",
    seedNow: true,
    incident: {
      title: "",
      description:
        "A communication platform experienced a multi-hour outage caused by a client reconnection strategy that, under a specific failure condition, triggered a massive synchronized reconnect surge overwhelming their own infrastructure.",
      service: "realtime-messaging",
      environment: "production",
      severity: "critical",
      sourceUrl: "public postmortem — communication platform, reconnect storm incident",
      occurredAt: "2026-07-03T22:40:00Z",
      rootCause: "synchronized client reconnection surge ('thundering herd')",
      actionTaken: "added jitter and backoff to the reconnection strategy",
      result: "service stabilized; reconnect storms prevented going forward",
    },
  },
  {
    id: "B2",
    seedNow: true,
    incident: {
      title: "",
      description:
        "A major cloud provider's DNS-related outage cascaded into dozens of dependent services failing simultaneously, illustrating how a single upstream dependency failure can present as many seemingly unrelated failures at once.",
      service: "dns-resolution",
      environment: "production",
      severity: "critical",
      sourceUrl: "public postmortem — cloud provider, DNS-related cascading outage",
      occurredAt: "2026-07-09T08:05:00Z",
      rootCause: "single upstream DNS dependency failure with no fallback across dependents",
      actionTaken: "added fallback resolution paths in the most critical dependents",
      result: "resolved after upstream recovery; fallback added to reduce blast radius next time",
    },
  },
  {
    id: "B3",
    seedNow: true,
    incident: {
      title: "",
      description:
        "An e-commerce platform's outage during a high-traffic sales event traced to a caching layer failing open in a way that sent all read traffic directly to the primary database instead of degrading gracefully.",
      service: "product-catalog-cache",
      environment: "production",
      severity: "critical",
      sourceUrl: "public postmortem — e-commerce platform, cache failure during peak sale event",
      occurredAt: "2026-07-15T13:50:00Z",
      rootCause: "cache failed open, sending 100% of read load to the primary database",
      actionTaken: "changed cache failure behavior to degrade gracefully instead of bypassing entirely",
      result: "database load returned to normal after graceful-degradation fix deployed",
    },
  },
  {
    id: "B4",
    seedNow: true,
    incident: {
      title: "",
      description:
        "Search service errors began appearing across every downstream feature that depended on it. Root cause was the search index rebuild job holding a lock far longer than expected, blocking all reads during the rebuild window.",
      service: "search-service",
      environment: "production",
      severity: "high",
      occurredAt: "2026-07-22T17:28:00Z",
      rootCause: "index rebuild job held a blocking lock longer than expected",
      actionTaken: "changed rebuild job to use a non-blocking index-swap strategy",
      result: "subsequent rebuilds no longer block reads",
    },
  },
  {
    id: "B5",
    seedNow: true,
    incident: {
      title: "",
      description:
        "Notification delivery failed platform-wide during a brief outage of a third-party email API. The notification service had no fallback path and no circuit breaker, so every attempt hung until timeout, backing up the whole queue.",
      service: "notification-service",
      environment: "production",
      severity: "medium",
      occurredAt: "2026-07-30T06:12:00Z",
      rootCause: "no circuit breaker or timeout handling around a third-party dependency",
      actionTaken: "added a circuit breaker and short timeout with queued retry",
      result: "subsequent third-party outages no longer back up the queue",
    },
  },
  {
    id: "B6",
    seedNow: false,
    incident: {
      title: "",
      description:
        "Recommendation engine outage cascaded to the homepage becoming fully unresponsive. The homepage was calling the recommendation service synchronously with no timeout, rather than treating recommendations as non-critical, gracefully-omittable content.",
      service: "homepage",
      environment: "production",
      severity: "high",
      occurredAt: "2026-08-16T00:00:00Z",
      // Deliberately no rootCause/actionTaken/result — this one is FRESH, submitted live
      // during the demo with no prior outcome, expected to retrieve B4/B5 (same cluster:
      // unguarded synchronous dependency calls).
    },
  },
];
