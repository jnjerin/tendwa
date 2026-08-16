# Seed Incidents for domains/incident-response

Source data for the demo seed script. Real-inspired incidents are paraphrased summaries in our
own words, never copied text, with a sourceUrl noting what they're inspired by. Synthetic
incidents are invented for this project and carry no sourceUrl.

Format for each: `content` is the natural-language paragraph to store (title + description
combined — this is what gets embedded and read during reflection). `metadata` fields map
directly into the `metadata JSONB` column. Most are seeded as **resolved** (with a paired
outcome) to act as pre-existing "backstory" memory; the one marked **FRESH** is held back to
submit live during the demo, since it should arrive with no prior memory to find yet.

---

## Cluster A — connection/resource exhaustion following deployment

### A1 (real-inspired)

- content: "A database provider experienced a major multi-hour outage after an operator, during
  routine debugging, mistyped a command that removed far more capacity than intended. The
  mistake cascaded into a large-scale service disruption because the command had insufficient
  guardrails against accidental over-scoping."
- metadata: { service: "database-cluster", environment: "production", severity: "critical", sourceUrl: "public postmortem — cloud database provider, 2017 capacity-removal incident" }
- status: resolved — rootCause: "insufficient guardrails on a manual operational command" — actionTaken: "added confirmation/scoping safeguards to the operational command" — result: "capacity restored after failover; safeguard added to prevent recurrence"

### A2 (real-inspired)

- content: "A CDN provider suffered a global outage after deploying a routine rule update
  containing a regular expression with catastrophic backtracking behavior. The pattern caused
  CPU exhaustion across the edge network within minutes of rollout."
- metadata: { service: "edge-cdn", environment: "production", severity: "critical", sourceUrl: "public postmortem — CDN provider, catastrophic-backtracking regex incident" }
- status: resolved — rootCause: "catastrophic backtracking in a newly deployed regex rule" — actionTaken: "reverted the rule update; added regex complexity limits to the deploy pipeline" — result: "service restored within the hour; regression prevented via pipeline check"

### A3 (real-inspired)

- content: "A source-control platform experienced an extended outage triggered by a network
  partition during a database failover. Automated failover logic made the situation worse
  before a manual intervention resolved it."
- metadata: { service: "source-control-db", environment: "production", severity: "high", sourceUrl: "public postmortem — source control platform, database failover incident" }
- status: resolved — rootCause: "automated failover logic behaved incorrectly under a network partition" — actionTaken: "manual failover override; failover logic revised" — result: "service restored after manual intervention"

### A4 (synthetic)

- content: "Payments API latency spiked to roughly 8x baseline 12 minutes after a routine
  deploy. Investigation found the database connection pool size had been left at its default
  of 10 despite traffic having grown roughly 4x since it was last tuned."
- metadata: { service: "payments-api", environment: "production", severity: "high" }
- status: resolved — rootCause: "connection pool size left at default despite traffic growth" — actionTaken: "raised pool size; added pool-saturation alerting" — result: "latency returned to baseline within 15 minutes"

### A5 (synthetic)

- content: "Checkout service began timing out under normal Friday-evening traffic. Root cause
  was a newly upgraded ORM version that had silently changed the default connection lifetime,
  causing connections to be recycled far more aggressively than intended."
- metadata: { service: "checkout-service", environment: "production", severity: "high" }
- status: resolved — rootCause: "ORM upgrade silently changed default connection lifetime" — actionTaken: "pinned connection lifetime explicitly in configuration" — result: "timeouts stopped after redeploy with pinned config"

### A6 (synthetic)

- content: "Internal reporting service exhausted its database connection pool after a scheduled
  batch job's concurrency was increased without a corresponding increase to the pool size."
- metadata: { service: "reporting-service", environment: "production", severity: "medium" }
- status: resolved — rootCause: "batch job concurrency increased independently of connection pool size" — actionTaken: "coupled batch concurrency and pool size in shared configuration" — result: "no further pool exhaustion after fix deployed"

---

## Cluster B — cascading failure from a single upstream dependency

### B1 (real-inspired)

- content: "A communication platform experienced a multi-hour outage caused by a client
  reconnection strategy that, under a specific failure condition, triggered a massive
  synchronized reconnect surge overwhelming their own infrastructure."
- metadata: { service: "realtime-messaging", environment: "production", severity: "critical", sourceUrl: "public postmortem — communication platform, reconnect storm incident" }
- status: resolved — rootCause: "synchronized client reconnection surge ('thundering herd')" — actionTaken: "added jitter and backoff to the reconnection strategy" — result: "service stabilized; reconnect storms prevented going forward"

### B2 (real-inspired)

- content: "A major cloud provider's DNS-related outage cascaded into dozens of dependent
  services failing simultaneously, illustrating how a single upstream dependency failure can
  present as many seemingly unrelated failures at once."
- metadata: { service: "dns-resolution", environment: "production", severity: "critical", sourceUrl: "public postmortem — cloud provider, DNS-related cascading outage" }
- status: resolved — rootCause: "single upstream DNS dependency failure with no fallback across dependents" — actionTaken: "added fallback resolution paths in the most critical dependents" — result: "resolved after upstream recovery; fallback added to reduce blast radius next time"

### B3 (real-inspired)

- content: "An e-commerce platform's outage during a high-traffic sales event traced to a
  caching layer failing open in a way that sent all read traffic directly to the primary
  database instead of degrading gracefully."
- metadata: { service: "product-catalog-cache", environment: "production", severity: "critical", sourceUrl: "public postmortem — e-commerce platform, cache failure during peak sale event" }
- status: resolved — rootCause: "cache failed open, sending 100% of read load to the primary database" — actionTaken: "changed cache failure behavior to degrade gracefully instead of bypassing entirely" — result: "database load returned to normal after graceful-degradation fix deployed"

### B4 (synthetic)

- content: "Search service errors began appearing across every downstream feature that
  depended on it. Root cause was the search index rebuild job holding a lock far longer than
  expected, blocking all reads during the rebuild window."
- metadata: { service: "search-service", environment: "production", severity: "high" }
- status: resolved — rootCause: "index rebuild job held a blocking lock longer than expected" — actionTaken: "changed rebuild job to use a non-blocking index-swap strategy" — result: "subsequent rebuilds no longer block reads"

### B5 (synthetic)

- content: "Notification delivery failed platform-wide during a brief outage of a third-party
  email API. The notification service had no fallback path and no circuit breaker, so every
  attempt hung until timeout, backing up the whole queue."
- metadata: { service: "notification-service", environment: "production", severity: "medium" }
- status: resolved — rootCause: "no circuit breaker or timeout handling around a third-party dependency" — actionTaken: "added a circuit breaker and short timeout with queued retry" — result: "subsequent third-party outages no longer back up the queue"

### B6 — FRESH, submit live during the demo (synthetic)

- content: "Recommendation engine outage cascaded to the homepage becoming fully unresponsive.
  The homepage was calling the recommendation service synchronously with no timeout, rather
  than treating recommendations as non-critical, gracefully-omittable content."
- metadata: { service: "homepage", environment: "production", severity: "high" }
- status: **not yet recorded — this is the one submitted live in the demo**, expected to retrieve
  B4/B5 (same cluster: unguarded synchronous dependency calls) and cite whatever knowledge
  reflection has already distilled from that cluster.
