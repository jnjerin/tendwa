import Link from "next/link";
import { listIncidents } from "@/lib/api";
import { CreateIncidentForm } from "./CreateIncidentForm";

export const dynamic = "force-dynamic";

function severityBadgeClass(severity: unknown): string {
  if (severity === "sev1") return "badge badge-danger";
  if (severity === "sev2") return "badge badge-warn";
  return "badge badge-neutral";
}

export default async function IncidentsPage() {
  const incidents = await listIncidents();
  const sorted = [...incidents].sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());

  return (
    <main className="container">
      <h1>Incidents</h1>
      <p className="page-subtitle">Experience → Retrieval → Agent Reasoning → Recommendation → Outcome → Memory.</p>

      <div className="card">
        <h2>Record a new incident</h2>
        <div style={{ marginTop: 12 }}>
          <CreateIncidentForm />
        </div>
      </div>

      <div className="section-title">Recorded incidents ({sorted.length})</div>
      {sorted.length === 0 ? (
        <div className="empty-state">No incidents recorded yet for this org.</div>
      ) : (
        <div className="list">
          {sorted.map((incident) => {
            const metadata = (incident.metadata ?? {}) as Record<string, unknown>;
            return (
              <Link key={incident.id} href={`/incidents/${incident.id}`} className="card card-link">
                <p className="card-title">{incident.content.split(". ")[0]}</p>
                <p className="card-meta">
                  {typeof metadata.service === "string" ? metadata.service : "unknown-service"} ·{" "}
                  {new Date(incident.occurredAt).toLocaleString()}{" "}
                  {typeof metadata.severity === "string" ? (
                    <span className={severityBadgeClass(metadata.severity)}>{metadata.severity}</span>
                  ) : null}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
