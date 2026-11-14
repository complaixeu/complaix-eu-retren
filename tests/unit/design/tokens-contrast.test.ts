import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The design tokens in app/globals.css follow the Complaix app look (docs/plans/A-intake.md,
// "Design direction"). This test reads the real stylesheet, pins the palette and checks WCAG AA
// for every text/background pair and every input border, in light and dark.

const css = readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8");

/** Custom properties declared in the first block that opens after `from`. */
function declarations(from: number): Record<string, string> {
  const open = css.indexOf("{", from);
  const close = css.indexOf("}", open);
  const out: Record<string, string> = {};
  for (const m of css.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim().toLowerCase();
  }
  return out;
}

const light = declarations(css.indexOf(":root {"));
const dark = declarations(css.indexOf("@media (prefers-color-scheme: dark)") + 40);

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("design tokens: palette", () => {
  it("light theme uses the Complaix palette", () => {
    expect(light).toMatchObject({
      "--color-bg": "#fafafa",
      "--color-surface": "#ffffff",
      "--color-surface-sunken": "#f4f4f5",
      "--color-border": "#e4e4e7",
      "--color-divider": "#f0f0f2",
      "--color-text": "#09090b",
      "--color-text-strong": "#3f3f46",
      "--color-text-secondary": "#52525b",
      "--color-text-muted": "#6b6b74",
      "--color-placeholder": "#71717a",
      "--color-primary": "#18181b",
      "--color-primary-hover": "#27272a",
      "--color-on-primary": "#fafafa",
      "--color-accent": "#2563eb",
      "--color-accent-hover": "#1d4ed8",
      "--color-accent-soft": "#eff6ff",
      "--color-accent-line": "#bfdbfe",
      "--color-danger": "#b91c1c",
      "--color-danger-soft": "#fef2f2",
      "--color-danger-line": "#fecaca",
      "--color-warning": "#9c5e06",
      "--color-warning-soft": "#fffbeb",
      "--color-warning-line": "#fde68a",
      "--color-success": "#15803d",
      "--color-success-soft": "#f0fdf4",
      "--color-success-line": "#bbf7d0",
    });
  });

  it("dark theme is derived from the same zinc ramp", () => {
    expect(dark).toMatchObject({
      "--color-bg": "#09090b",
      "--color-surface": "#18181b",
      "--color-surface-sunken": "#27272a",
      "--color-border": "#27272a",
      "--color-divider": "#1f1f23",
      "--color-text": "#fafafa",
      "--color-text-secondary": "#a1a1aa",
      "--color-text-muted": "#9797a0",
      "--color-primary": "#fafafa",
      "--color-primary-hover": "#e4e4e7",
      "--color-on-primary": "#09090b",
      "--color-accent": "#60a5fa",
    });
  });

  it("uses the Complaix fonts and no mono or Google font", () => {
    expect(light["--font-sans"]).toMatch(/^"dm sans"/);
    expect(light["--font-heading"]).toMatch(/^"montserrat"/);
    expect(css).not.toMatch(/JetBrains|googleapis/i);
  });

  it("ships every local font file referenced by the stylesheet", () => {
    const sources = [...css.matchAll(/url\("(\/fonts\/[^\"]+\.woff2)"\)/g)].map(
      ([, source]) => source,
    );

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(existsSync(new URL(`../../../public${source}`, import.meta.url)), source).toBe(true);
    }
  });

  it("keeps controls at 6px, cards at 8px and the tap target at 44px", () => {
    expect(light["--radius-md"]).toBe("6px");
    expect(light["--radius-lg"]).toBe("8px");
    expect(light["--tap-target"]).toBe("44px");
  });
});

const AA_TEXT = 4.5;
const NON_TEXT = 3;
const surfaces = ["--color-bg", "--color-surface", "--color-surface-sunken"];
const textColours = [
  "--color-text",
  "--color-text-strong",
  "--color-text-secondary",
  "--color-text-muted",
  "--color-accent",
  "--color-danger",
  "--color-warning",
  "--color-success",
];
// [foreground, background, minimum ratio]
const pairs: [string, string, number][] = [
  ...surfaces.flatMap((bg) => textColours.map((fg): [string, string, number] => [fg, bg, AA_TEXT])),
  ["--color-placeholder", "--color-surface", AA_TEXT],
  ["--color-on-primary", "--color-primary", AA_TEXT],
  ["--color-on-primary", "--color-primary-hover", AA_TEXT],
  ["--color-accent", "--color-accent-soft", AA_TEXT],
  ["--color-accent-hover", "--color-accent-soft", AA_TEXT],
  ["--color-text", "--color-accent-soft", AA_TEXT],
  ["--color-danger", "--color-danger-soft", AA_TEXT],
  ["--color-text", "--color-danger-soft", AA_TEXT],
  ["--color-warning", "--color-warning-soft", AA_TEXT],
  ["--color-text", "--color-warning-soft", AA_TEXT],
  ["--color-success", "--color-success-soft", AA_TEXT],
  ["--color-text", "--color-success-soft", AA_TEXT],
  // Input borders and the focus ring must be visible against the page
  ["--color-border-strong", "--color-surface", NON_TEXT],
  ["--color-border-strong", "--color-bg", NON_TEXT],
  ["--color-focus", "--color-surface", NON_TEXT],
  ["--color-focus", "--color-bg", NON_TEXT],
];

describe.each([
  ["light", light],
  ["dark", { ...light, ...dark }],
] as const)("design tokens: contrast (%s)", (_name, theme) => {
  it.each(pairs)("%s on %s is at least %s:1", (fg, bg, min) => {
    expect(theme[fg], `${fg} missing`).toMatch(/^#[0-9a-f]{6}$/);
    expect(theme[bg], `${bg} missing`).toMatch(/^#[0-9a-f]{6}$/);
    expect(ratio(theme[fg], theme[bg])).toBeGreaterThanOrEqual(min);
  });
});
