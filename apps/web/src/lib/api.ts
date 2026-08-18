import { getApiBaseUrl, getOrgId } from "./config";

// Wire types mirroring apps/api's actual JSON response shapes (confirmed by reading
// apps/api/src/routes/*.ts directly) — dates are ISO strings over HTTP, not Date instances,
// which is the one deliberate difference from packages/engine's own internal TS types.

export interface Experience {
  id: string;
  orgId: string;
  domain: string;
  content: string;
  metadata: Record<string, unknown> | null;
  occurredAt: string;
  createdAt: string;
}

export interface ExperienceMatch {
  id: string;
  orgId: string;
  domain: string;
  content: string;
  metadata: Record<string, unknown> | null;
  occurredAt: string;
  createdAt: string;
}

export interface KnowledgeMatch {
  id: string;
  orgId: string;
  domain: string;
  statement: string;
  confidence: number;
  reinforcementCount: number;
  lastReinforcedAt: string;
  createdAt: string;
  similarity: number;
}

export interface Knowledge {
  id: string;
  orgId: string;
  domain: string;
  statement: string;
  confidence: number;
  reinforcementCount: number;
  lastReinforcedAt: string;
  createdAt: string;
}

export interface RetrievalResult {
  knowledge: KnowledgeMatch[];
  experiences: ExperienceMatch[];
  knowledgeUnavailable: boolean;
}

export interface AgentProposal {
  likelyCause: string;
  recommendation: string;
  confidence: number;
  citedExperienceIds: string[];
  citedKnowledgeIds: string[];
  knowledgeUnavailable: boolean;
}

export interface AgentLoopResult {
  status: "ok" | "unavailable";
  retrieval: RetrievalResult;
  proposal?: AgentProposal;
  reason?: string;
}

export interface Outcome {
  id: string;
  orgId: string;
  experienceId: string;
  status: string;
  rootCause: string | null;
  actionTaken: string;
  result: string;
  createdAt: string;
}

interface ApiErrorBody {
  error: { code: string; message: string; requestId: string };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(response.status, body?.error?.code ?? "UNKNOWN", body?.error?.message ?? `Request failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function listIncidents(): Promise<Experience[]> {
  const data = await apiFetch<{ items: Experience[] }>(`/incidents?orgId=${getOrgId()}&domain=incident-response`);
  return data.items;
}

export async function getIncident(id: string): Promise<Experience> {
  return apiFetch<Experience>(`/incidents/${id}?orgId=${getOrgId()}`);
}

export interface CreateIncidentInput {
  title: string;
  description: string;
  service: string;
  environment: string;
  severity: string;
  occurredAt: string;
  sourceUrl?: string;
}

export async function createIncident(input: CreateIncidentInput): Promise<Experience> {
  return apiFetch<Experience>("/incidents", {
    method: "POST",
    body: JSON.stringify({ orgId: getOrgId(), ...input }),
  });
}

export async function analyzeIncident(id: string): Promise<AgentLoopResult> {
  return apiFetch<AgentLoopResult>(`/incidents/${id}/analyze`, {
    method: "POST",
    body: JSON.stringify({ orgId: getOrgId() }),
  });
}

export async function getIncidentOutcome(id: string): Promise<Outcome | null> {
  const data = await apiFetch<{ outcome: Outcome | null }>(`/incidents/${id}/outcome?orgId=${getOrgId()}`);
  return data.outcome;
}

export interface RecordOutcomeInput {
  status: string;
  actionTaken: string;
  result: string;
  rootCause?: string;
}

export async function recordIncidentOutcome(id: string, input: RecordOutcomeInput): Promise<Outcome> {
  return apiFetch<Outcome>(`/incidents/${id}/outcome`, {
    method: "POST",
    body: JSON.stringify({ orgId: getOrgId(), ...input }),
  });
}

export async function listKnowledge(): Promise<Knowledge[]> {
  const data = await apiFetch<{ items: Knowledge[] }>(`/knowledge?orgId=${getOrgId()}`);
  return data.items;
}
