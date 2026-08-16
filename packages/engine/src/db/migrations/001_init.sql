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
-- vector_cosine_ops chosen explicitly, not left to CockroachDB's implicit vector_l2_ops
-- default — Voyage AI's docs recommend cosine similarity for voyage-3.5 embeddings, and
-- cosine is the standard metric for embedding-similarity search generally. See DECISIONS.md.
CREATE VECTOR INDEX idx_knowledge_embedding ON knowledge (org_id, embedding vector_cosine_ops);

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
