"use client";

import { useActionState } from "react";
import { recordOutcomeAction, type ActionState } from "../../actions";
import type { Outcome } from "@/lib/api";

const initialState: ActionState<Outcome> = {};

function statusBadgeClass(status: string): string {
  if (status === "resolved") return "badge badge-ok";
  if (status === "failed") return "badge badge-danger";
  return "badge badge-warn";
}

function OutcomeCard({ outcome }: { outcome: Outcome }) {
  return (
    <div className="card">
      <span className={statusBadgeClass(outcome.status)}>{outcome.status}</span>
      <p style={{ fontWeight: 600, marginBottom: 4, marginTop: 10 }}>Action taken</p>
      <p style={{ marginTop: 0 }}>{outcome.actionTaken}</p>
      <p style={{ fontWeight: 600, marginBottom: 4 }}>Result</p>
      <p style={{ marginTop: 0 }}>{outcome.result}</p>
      {outcome.rootCause ? (
        <>
          <p style={{ fontWeight: 600, marginBottom: 4 }}>Root cause</p>
          <p style={{ marginTop: 0 }}>{outcome.rootCause}</p>
        </>
      ) : null}
      <p className="card-meta">Recorded {new Date(outcome.createdAt).toLocaleString()}</p>
    </div>
  );
}

export function OutcomePanel({ incidentId, initialOutcome }: { incidentId: string; initialOutcome: Outcome | null }) {
  const boundAction = recordOutcomeAction.bind(null, incidentId);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);

  const outcome = state.data ?? initialOutcome;

  if (outcome) {
    return <OutcomeCard outcome={outcome} />;
  }

  return (
    <div className="card">
      <p className="muted" style={{ marginTop: 0 }}>
        No outcome recorded yet.
      </p>
      <form action={formAction} className="form">
        <div className="form-row">
          <div className="form-field">
            <label htmlFor="status">Status</label>
            <select id="status" name="status" defaultValue="resolved" required>
              <option value="resolved">resolved</option>
              <option value="partial">partial</option>
              <option value="failed">failed</option>
            </select>
          </div>
        </div>
        <div className="form-field">
          <label htmlFor="actionTaken">Action taken</label>
          <textarea id="actionTaken" name="actionTaken" required placeholder="What was actually done." />
        </div>
        <div className="form-field">
          <label htmlFor="result">Result</label>
          <textarea id="result" name="result" required placeholder="What happened as a result." />
        </div>
        <div className="form-field">
          <label htmlFor="rootCause">Root cause (optional)</label>
          <input id="rootCause" name="rootCause" placeholder="If known." />
        </div>
        <div>
          <button type="submit" className="btn btn-primary" disabled={isPending}>
            {isPending ? "Recording…" : "Record outcome"}
          </button>
        </div>
        {state.error ? <div className="error-banner">{state.error}</div> : null}
      </form>
    </div>
  );
}
