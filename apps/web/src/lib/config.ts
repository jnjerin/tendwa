// Server-only config (no NEXT_PUBLIC_ prefix — every page here is a Server Component/Action,
// nothing runs in the browser, so there's no reason to expose these to the client bundle).
// Matches ENGINEERING.md §9: fail loudly with a clear message rather than a cryptic error deep
// inside a fetch call.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env.local and fill in a value for it.`);
  }
  return value;
}

export function getApiBaseUrl(): string {
  return requireEnv("TENDWA_API_BASE_URL");
}

export function getOrgId(): string {
  return requireEnv("TENDWA_ORG_ID");
}
