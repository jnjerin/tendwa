// The only place incident-specific code lives — packages/engine must have zero references to
// "incident" (see CLAUDE.md rule 1). Everything here does is translate the domain's own shape
// into the generic experience/outcome shapes the engine already knows how to write.
//
// packages/engine has no public entrypoint yet (no index.ts / package.json "exports" — a
// separate tooling decision, not one this adapter should make on its own), so these are plain
// relative imports into the engine's source rather than a package-name import. See
// DECISIONS.md.
import type { NewExperienceInput } from "../../packages/engine/src/memory/experience.js";
import type { NewOutcomeInput } from "../../packages/engine/src/memory/outcome.js";

export interface Incident {
  title: string;
  description: string;
  service: string;
  environment: string;
  severity: string;
  occurredAt: Date | string;
  sourceUrl?: string;
  rootCause?: string;
  actionTaken?: string;
  result?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Converts an Incident into exactly the shape recordExperience expects. `content` is the
 * natural-language paragraph that gets embedded and read back during reflection — title and
 * description are combined into it (there's no separate title column on `experiences`), with
 * `title` a no-op when empty so pre-written seed narratives (which are already a single fused
 * paragraph — see seed-incidents.md) pass through unchanged rather than gaining a duplicated
 * lead sentence. service/environment/severity/sourceUrl live only in metadata JSONB, never as
 * columns or branching logic in packages/engine.
 */
export function incidentToExperience(incident: Incident, orgId: string): NewExperienceInput {
  const metadata: Record<string, unknown> = {
    service: incident.service,
    environment: incident.environment,
    severity: incident.severity,
  };
  if (incident.sourceUrl) {
    metadata.sourceUrl = incident.sourceUrl;
  }
  return {
    orgId,
    domain: "incident-response",
    content: isNonEmptyString(incident.title) ? `${incident.title}. ${incident.description}` : incident.description,
    occurredAt: incident.occurredAt,
    metadata,
  };
}

/**
 * An incident only has a recorded outcome once actionTaken and result are both known —
 * rootCause is optional even then, matching outcomes' nullable root_cause column (the fix is
 * sometimes known before the root cause is fully understood). Narrows the type so
 * incidentToOutcome() can read actionTaken/result without re-checking them.
 */
export function incidentHasOutcome(
  incident: Incident,
): incident is Incident & { actionTaken: string; result: string } {
  return isNonEmptyString(incident.actionTaken) && isNonEmptyString(incident.result);
}

/**
 * Every incident seeded from domains/incident-response/ingest/seed-data.ts is a resolved one —
 * this dataset doesn't currently exercise a 'failed' or 'partial' outcome, so status is fixed
 * here rather than exposed as an Incident field nothing sets yet. Revisit (add a `status` field
 * to Incident) if a non-resolved incident is ever seeded or submitted live.
 */
export function incidentToOutcome(
  incident: Incident & { actionTaken: string; result: string },
  experienceId: string,
  orgId: string,
): NewOutcomeInput {
  return {
    orgId,
    experienceId,
    status: "resolved",
    actionTaken: incident.actionTaken,
    result: incident.result,
    rootCause: incident.rootCause ?? null,
  };
}
