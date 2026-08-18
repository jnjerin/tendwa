"use server";

import { redirect } from "next/navigation";
import {
  ApiError,
  analyzeIncident,
  createIncident,
  recordIncidentOutcome,
  type AgentLoopResult,
  type CreateIncidentInput,
  type Outcome,
} from "@/lib/api";

export interface ActionState<T> {
  data?: T;
  error?: string;
}

function messageFor(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export async function createIncidentAction(_prevState: ActionState<never>, formData: FormData): Promise<ActionState<never>> {
  const input: CreateIncidentInput = {
    title: String(formData.get("title") ?? "").trim(),
    description: String(formData.get("description") ?? "").trim(),
    service: String(formData.get("service") ?? "").trim(),
    environment: String(formData.get("environment") ?? "").trim(),
    severity: String(formData.get("severity") ?? "").trim(),
    occurredAt: String(formData.get("occurredAt") ?? ""),
  };
  const sourceUrl = String(formData.get("sourceUrl") ?? "").trim();
  if (sourceUrl) {
    input.sourceUrl = sourceUrl;
  }

  let experienceId: string;
  try {
    const experience = await createIncident(input);
    experienceId = experience.id;
  } catch (err) {
    return { error: messageFor(err, "Failed to create incident") };
  }
  redirect(`/incidents/${experienceId}`);
}

export async function analyzeIncidentAction(
  incidentId: string,
  _prevState: ActionState<AgentLoopResult>,
  _formData: FormData,
): Promise<ActionState<AgentLoopResult>> {
  try {
    const result = await analyzeIncident(incidentId);
    return { data: result };
  } catch (err) {
    return { error: messageFor(err, "Analysis failed") };
  }
}

export async function recordOutcomeAction(
  incidentId: string,
  _prevState: ActionState<Outcome>,
  formData: FormData,
): Promise<ActionState<Outcome>> {
  try {
    const outcome = await recordIncidentOutcome(incidentId, {
      status: String(formData.get("status") ?? "").trim(),
      actionTaken: String(formData.get("actionTaken") ?? "").trim(),
      result: String(formData.get("result") ?? "").trim(),
      rootCause: String(formData.get("rootCause") ?? "").trim() || undefined,
    });
    return { data: outcome };
  } catch (err) {
    return { error: messageFor(err, "Failed to record outcome") };
  }
}
