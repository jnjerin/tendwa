import { notFound } from "next/navigation";
import { ApiError, getIncident, getIncidentOutcome } from "@/lib/api";
import { AnalyzePanel } from "./AnalyzePanel";
import { OutcomePanel } from "./OutcomePanel";

export const dynamic = "force-dynamic";

export default async function IncidentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let incident;
  try {
    incident = await getIncident(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound();
    }
    throw err;
  }

  const outcome = await getIncidentOutcome(id);
  const metadata = (incident.metadata ?? {}) as Record<string, unknown>;
  const [title, ...descriptionParts] = incident.content.split(". ");
  const description = descriptionParts.join(". ") || incident.content;

  return (
    <main className="container">
      <div className="stage">
        <div className="stage-header">
          <span className="stage-number">1</span>
          <h2>Incident / experience</h2>
        </div>
        <div className="card">
          <p className="card-title" style={{ fontSize: "1.2rem" }}>
            {title}
          </p>
          <p style={{ marginTop: 0 }}>{description}</p>
          <p className="card-meta">
            {typeof metadata.service === "string" ? metadata.service : "unknown-service"} ·{" "}
            {typeof metadata.environment === "string" ? metadata.environment : "unknown-env"} ·{" "}
            {typeof metadata.severity === "string" ? <span className="badge badge-warn">{metadata.severity}</span> : null} ·{" "}
            occurred {new Date(incident.occurredAt).toLocaleString()}
          </p>
          {typeof metadata.sourceUrl === "string" ? (
            <p className="card-meta">
              <a href={metadata.sourceUrl} target="_blank" rel="noreferrer">
                Source
              </a>
            </p>
          ) : null}
        </div>
      </div>

      <AnalyzePanel incidentId={id} />

      <div className="stage">
        <div className="stage-header">
          <span className="stage-number">5</span>
          <h2>Outcome</h2>
        </div>
        <OutcomePanel incidentId={id} initialOutcome={outcome} />
      </div>
    </main>
  );
}
