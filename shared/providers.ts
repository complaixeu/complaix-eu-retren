/**
 * Which implementation each external port uses. Default is always `fake`, so tests, CI and a
 * fresh checkout never call a real service. Real ones need keys that only Nestor can set.
 */
export const PROVIDERS = {
  OCR_PROVIDER: ["fake", "vision"],
  LLM_PROVIDER: ["fake", "gemini"],
  MAIL_PROVIDER: ["fake"],
} as const;

export type ProviderVar = keyof typeof PROVIDERS;

export function provider<V extends ProviderVar>(
  name: V,
  env: Record<string, string | undefined> = process.env,
): (typeof PROVIDERS)[V][number] {
  const value = env[name] ?? "fake";
  const allowed: readonly string[] = PROVIDERS[name];
  if (!allowed.includes(value)) {
    throw new Error(`${name}=${value} is not one of: ${allowed.join(", ")}`);
  }
  return value as (typeof PROVIDERS)[V][number];
}
