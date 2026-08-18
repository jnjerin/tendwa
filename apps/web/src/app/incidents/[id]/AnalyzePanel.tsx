"use client";

import { useActionState } from "react";
import { analyzeIncidentAction, type ActionState } from "../../actions";
import type { AgentLoopResult, ExperienceMatch, KnowledgeMatch } from "@/lib/api";

const initialState: ActionState<AgentLoopResult> = {};

function ConfidenceMeter({ value, label }: { value: number; label: string }) {
  const pct = Math.round(value * 100);
  return (
    <div className="meter-row">
      <div className="meter" style={{ maxWidth: 160 }}>
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="meter-label">
        {label}: {pct}%
      </span>
    </div>
  );
}

function findExperience(experiences: ExperienceMatch[], id: string) {
  return experiences.find((e) => e.id === id);
}

function findKnowledge(knowledge: KnowledgeMatch[], id: string) {
  return knowledge.find((k) => k.id === id);
}

export function AnalyzePanel({ incidentId }: { incidentId: string }) {
  const boundAction = analyzeIncidentAction.bind(null, incidentId);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  const result = state.data;

  return (
    <>
      <div className="stage">
        <div className="stage-header">
          <span className="stage-number">2–3</span>
          <h2>Retrieved Memory &amp; Agent Recommendation</h2>
        </div>
        {!result ? (
          <div className="card">
            <p className="muted" style={{ marginTop: 0 }}>
              Nothing retrieved yet — run analysis to retrieve similar past experiences and relevant learned
              knowledge, then have the agent reason over them.
            </p>
            <form action={formAction}>
              <button type="submit" className="btn btn-primary" disabled={isPending}>
                {isPending ? "Analyzing…" : "Run analysis"}
              </button>
            </form>
            {state.error ? <div className="error-banner">{state.error}</div> : null}
          </div>
        ) : (
          <>
            <div className="card">
              <p className="section-title" style={{ marginTop: 0 }}>
                Retrieved memory
              </p>
              <p className="card-meta">
                {result.retrieval.experiences.length} similar past experience(s) ·{" "}
                {result.retrieval.knowledgeUnavailable
                  ? "knowledge search was unavailable for this run"
                  : `${result.retrieval.knowledge.length} relevant knowledge statement(s)`}
              </p>

              {result.retrieval.knowledge.length > 0 ? (
                <div style={{ marginTop: 10 }}>
                  {result.retrieval.knowledge.map((k) => (
                    <div key={k.id} className="evidence-item">
                      <div className="evidence-kind">Knowledge · similarity {Math.round(k.similarity * 100)}%</div>
                      <p style={{ margin: "4px 0" }}>{k.statement}</p>
                      <ConfidenceMeter value={k.confidence} label="Confidence" />
                    </div>
                  ))}
                </div>
              ) : null}

              <form action={formAction} style={{ marginTop: 14 }}>
                <button type="submit" className="btn" disabled={isPending}>
                  {isPending ? "Re-analyzing…" : "Re-run analysis"}
                </button>
              </form>
              {state.error ? <div className="error-banner">{state.error}</div> : null}
            </div>

            <div className="card" style={{ marginTop: 14 }}>
              <p className="section-title" style={{ marginTop: 0 }}>
                Agent recommendation
              </p>
              {result.status === "unavailable" ? (
                <>
                  <div className="badge badge-warn">Recommendation unavailable</div>
                  <p className="muted">{result.reason ?? "The agent could not produce a recommendation for this run."}</p>
                </>
              ) : result.proposal ? (
                <>
                  <p style={{ fontWeight: 600, marginBottom: 4 }}>Likely cause</p>
                  <p style={{ marginTop: 0 }}>{result.proposal.likelyCause}</p>
                  <p style={{ fontWeight: 600, marginBottom: 4 }}>Recommendation</p>
                  <p style={{ marginTop: 0 }}>{result.proposal.recommendation}</p>
                  <ConfidenceMeter value={result.proposal.confidence} label="Recommendation confidence" />
                </>
              ) : null}
            </div>

            <div className="stage" style={{ marginTop: 14 }}>
              <div className="stage-header">
                <span className="stage-number">4</span>
                <h2>Evidence &amp; provenance</h2>
              </div>
              <div className="card">
                {result.proposal &&
                (result.proposal.citedExperienceIds.length > 0 || result.proposal.citedKnowledgeIds.length > 0) ? (
                  <>
                    <p className="muted" style={{ marginTop: 0 }}>
                      What the agent actually cited, cross-referenced against what was retrieved:
                    </p>
                    {result.proposal.citedExperienceIds.map((id) => {
                      const experience = findExperience(result.retrieval.experiences, id);
                      return (
                        <div key={id} className="evidence-item">
                          <div className="evidence-kind">Cited experience</div>
                          <p style={{ margin: "4px 0" }}>{experience ? experience.content : `(id ${id})`}</p>
                        </div>
                      );
                    })}
                    {result.proposal.citedKnowledgeIds.map((id) => {
                      const knowledge = findKnowledge(result.retrieval.knowledge, id);
                      return (
                        <div key={id} className="evidence-item">
                          <div className="evidence-kind">Cited knowledge</div>
                          <p style={{ margin: "4px 0" }}>{knowledge ? knowledge.statement : `(id ${id})`}</p>
                        </div>
                      );
                    })}
                  </>
                ) : (
                  <p className="muted" style={{ margin: 0 }}>
                    {result.status === "unavailable"
                      ? "No citations — the agent did not produce a recommendation for this run."
                      : "The agent's recommendation cited no specific prior evidence."}
                  </p>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
