import { existsSync } from "node:fs";
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (!existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate repo root (pnpm-workspace.yaml) above ${startDir}`);
    }
    dir = parent;
  }
  return dir;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Loads .env from the repo root, resolved relative to this file rather than process.cwd() —
 * `pnpm -C packages/engine <script>` changes cwd to packages/engine, which made the bare
 * `dotenv/config` side-effect import silently miss the root .env entirely. Walking up to
 * pnpm-workspace.yaml (rather than a fixed "../../.." offset) keeps this correct regardless of
 * whether this file runs from src/ (via tsx) or one directory deeper from dist/ (once anything
 * bundles/compiles this package). dotenv never overrides variables already present in
 * process.env, so this is a no-op (and harmless) in environments like Lambda where real env
 * vars are injected directly and no .env file exists.
 */
config({ path: path.join(findRepoRoot(__dirname), ".env") });
