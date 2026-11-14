import { execFileSync } from "node:child_process";

export interface LocalSupabase {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}

/** Reads the running local Supabase (never a remote one). Keys are the CLI's fixed local keys. */
export function localSupabase(): LocalSupabase {
  let raw: string;
  try {
    raw = execFileSync("pnpm", ["exec", "supabase", "status", "-o", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error("Local Supabase is not running: run `pnpm db:start` (or `pnpm test:all`).");
  }
  const s = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, string | undefined>;
  const url = s.API_URL;
  const anonKey = s.ANON_KEY ?? s.PUBLISHABLE_KEY;
  const serviceRoleKey = s.SERVICE_ROLE_KEY ?? s.SECRET_KEY;
  if (!url || !anonKey || !serviceRoleKey) throw new Error("supabase status is incomplete");
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url)) {
    throw new Error(`Refusing a non-local Supabase URL in tests: ${url}`);
  }
  return { url, anonKey, serviceRoleKey };
}

/** Env for the app under test: local Supabase plus fake providers only. */
export function testAppEnv(port: number): Record<string, string> {
  const sb = localSupabase();
  return {
    NEXT_PUBLIC_SUPABASE_URL: sb.url,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: sb.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey,
    NEXT_PUBLIC_APP_URL: `http://localhost:${port}`,
    OCR_PROVIDER: "fake",
    LLM_PROVIDER: "fake",
    MAIL_PROVIDER: "fake",
    DEMO_MODE: "1",
  };
}
