import { listKnowledge } from "@/lib/api";

export const dynamic = "force-dynamic";

function confidenceBadgeClass(confidence: number): string {
  if (confidence >= 0.7) return "badge badge-ok";
  if (confidence >= 0.4) return "badge badge-warn";
  return "badge badge-danger";
}

export default async function KnowledgePage() {
  const items = await listKnowledge();
  const sorted = [...items].sort((a, b) => b.confidence - a.confidence);

  return (
    <main className="container">
      <h1>Knowledge</h1>
      <p className="page-subtitle">
        Durable, confidence-weighted facts distilled from past incidents by reflection — reinforced by real outcomes,
        not written once and trusted forever.
      </p>

      {sorted.length === 0 ? (
        <div className="empty-state">
          No knowledge yet. Knowledge is distilled by the reflection process from experiences that already have a
          recorded outcome — run reflection once a few incidents have outcomes attached.
        </div>
      ) : (
        <div className="list">
          {sorted.map((k) => {
            const pct = Math.round(k.confidence * 100);
            return (
              <div key={k.id} className="card">
                <p className="card-title" style={{ marginBottom: 8 }}>
                  {k.statement}
                </p>
                <div className="meter-row" style={{ marginBottom: 6 }}>
                  <div className="meter" style={{ maxWidth: 200 }}>
                    <div className="meter-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className={confidenceBadgeClass(k.confidence)}>{pct}% confidence</span>
                </div>
                <p className="card-meta">
                  Reinforced {k.reinforcementCount} time{k.reinforcementCount === 1 ? "" : "s"} · domain {k.domain} ·
                  last reinforced {new Date(k.lastReinforcedAt).toLocaleString()}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
