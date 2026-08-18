"use client";

import { useActionState } from "react";
import { createIncidentAction, type ActionState } from "./actions";

const initialState: ActionState<never> = {};

export function CreateIncidentForm() {
  const [state, formAction, isPending] = useActionState(createIncidentAction, initialState);

  return (
    <form action={formAction} className="form">
      <div className="form-row">
        <div className="form-field">
          <label htmlFor="title">Title</label>
          <input id="title" name="title" required placeholder="Database pool exhausted" />
        </div>
        <div className="form-field">
          <label htmlFor="occurredAt">Occurred at</label>
          <input id="occurredAt" name="occurredAt" type="datetime-local" required />
        </div>
      </div>

      <div className="form-field">
        <label htmlFor="description">Description</label>
        <textarea id="description" name="description" required placeholder="What happened, in a sentence or two." />
      </div>

      <div className="form-row">
        <div className="form-field">
          <label htmlFor="service">Service</label>
          <input id="service" name="service" required placeholder="orders-api" />
        </div>
        <div className="form-field">
          <label htmlFor="environment">Environment</label>
          <input id="environment" name="environment" required placeholder="production" />
        </div>
        <div className="form-field">
          <label htmlFor="severity">Severity</label>
          <select id="severity" name="severity" required defaultValue="sev2">
            <option value="sev1">sev1</option>
            <option value="sev2">sev2</option>
            <option value="sev3">sev3</option>
          </select>
        </div>
      </div>

      <div className="form-field">
        <label htmlFor="sourceUrl">Source URL (optional)</label>
        <input id="sourceUrl" name="sourceUrl" placeholder="https://postmortems.example.com/123" />
      </div>

      <div>
        <button type="submit" className="btn btn-primary" disabled={isPending}>
          {isPending ? "Recording…" : "Record incident"}
        </button>
      </div>

      {state.error ? <div className="error-banner">{state.error}</div> : null}
    </form>
  );
}
