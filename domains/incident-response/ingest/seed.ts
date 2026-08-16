import "../../../packages/engine/src/env.js";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createPool } from "../../../packages/engine/src/db/client.js";
import { requireEnv } from "../../../packages/engine/src/config.js";
import { recordExperience } from "../../../packages/engine/src/memory/experience.js";
import { recordOutcome } from "../../../packages/engine/src/memory/outcome.js";
import { incidentHasOutcome, incidentToExperience, incidentToOutcome } from "../mapping.js";
import { SEED_INCIDENTS } from "./seed-data.js";

const DEMO_ORG_NAME = "Tendwa Demo";

/**
 * Idempotent — a name lookup first, insert only on miss — so re-running the script (e.g. by
 * accident before a demo) doesn't create a second "Tendwa Demo" org. `orgs` has no unique
 * constraint on `name`, so this is a best-effort find-or-create, not a race-safe one; acceptable
 * for a single-operator demo seed script, not something a concurrent multi-caller path should
 * copy.
 */
export async function findOrCreateOrg(pool: Pool, name: string): Promise<string> {
  const existing = await pool.query<{ id: string }>("SELECT id FROM orgs WHERE name = $1", [name]);
  const existingRow = existing.rows[0];
  if (existingRow) {
    return existingRow.id;
  }
  const created = await pool.query<{ id: string }>("INSERT INTO orgs (name) VALUES ($1) RETURNING id", [name]);
  const row = created.rows[0];
  if (!row) {
    throw new Error("INSERT INTO orgs ... RETURNING produced no row");
  }
  return row.id;
}

export type SeedStatus = "empty" | "partial" | "complete";

/**
 * Per ENGINEERING.md §1, "idempotency is considered wherever a request could plausibly be sent
 * twice" — but "any experiences exist" isn't enough to answer that, because seedIncidents()
 * writes 11 experience+outcome pairs one at a time with no transaction across the pair or the
 * loop. If the process dies partway (a network blip, a timeout on incident #7, Ctrl-C before a
 * demo), a plain "count > 0" check can't tell a fully-seeded org apart from a half-seeded one —
 * so it would either look done (re-running silently skips, leaving the gap) or, with --force,
 * duplicate the incidents that already landed (recordExperience has no dedupe key; see
 * DECISIONS.md). Comparing both the experience count AND the joined outcome count against the
 * expected total catches both failure points: a dead process before its last recordExperience,
 * and a recordExperience that committed but whose paired recordOutcome then failed.
 */
export async function getSeedStatus(pool: Pool, orgId: string): Promise<SeedStatus> {
  const expected = SEED_INCIDENTS.filter((entry) => entry.seedNow).length;
  const experiences = await pool.query<{ count: string }>(
    "SELECT count(*) AS count FROM experiences WHERE org_id = $1 AND domain = $2",
    [orgId, "incident-response"],
  );
  const outcomes = await pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM outcomes o
     JOIN experiences e ON e.id = o.experience_id
     WHERE e.org_id = $1 AND e.domain = $2`,
    [orgId, "incident-response"],
  );
  const experienceCount = Number(experiences.rows[0]?.count ?? 0);
  const outcomeCount = Number(outcomes.rows[0]?.count ?? 0);
  if (experienceCount === 0 && outcomeCount === 0) {
    return "empty";
  }
  if (experienceCount === expected && outcomeCount === expected) {
    return "complete";
  }
  return "partial";
}

/** Seeds every non-FRESH incident (B6 is held out — see seed-data.ts) as an experience+outcome pair. */
export async function seedIncidents(pool: Pool, orgId: string): Promise<number> {
  const toSeed = SEED_INCIDENTS.filter((entry) => entry.seedNow);
  let seeded = 0;
  for (const entry of toSeed) {
    const experience = await recordExperience(pool, incidentToExperience(entry.incident, orgId));
    if (incidentHasOutcome(entry.incident)) {
      await recordOutcome(pool, incidentToOutcome(entry.incident, experience.id, orgId));
    }
    seeded++;
  }
  return seeded;
}

async function main(): Promise<void> {
  const useTest = process.argv.includes("--test");
  const force = process.argv.includes("--force");
  const varName = useTest ? "TEST_DATABASE_URL" : "DATABASE_URL";
  const connectionString = requireEnv(process.env, varName);
  const pool = createPool({ connectionString });
  try {
    const orgId = await findOrCreateOrg(pool, DEMO_ORG_NAME);
    const status = await getSeedStatus(pool, orgId);
    if (status === "complete" && !force) {
      console.log(`Org "${DEMO_ORG_NAME}" (${orgId}) is already fully seeded — skipping. Pass --force to re-seed (this will duplicate rows).`);
      return;
    }
    if (status === "partial" && !force) {
      console.error(
        `Org "${DEMO_ORG_NAME}" (${orgId}) is partially seeded — a previous run likely failed partway through. ` +
          "Refusing to continue automatically: skipping would leave it incomplete, and reseeding on top would " +
          "duplicate the incidents that already landed. Inspect the data, then pass --force once you know which " +
          "outcome you want (a full reseed from scratch will duplicate existing rows).",
      );
      process.exitCode = 1;
      return;
    }
    const seeded = await seedIncidents(pool, orgId);
    console.log(`Seeded ${seeded} incident(s) for org "${DEMO_ORG_NAME}" (${orgId}).`);
  } finally {
    await pool.end();
  }
}

// main() deliberately uses console.log/console.error, not the structured pino logger — CLI
// operator output for a human running this script, same rationale as migrate.ts's main().
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
