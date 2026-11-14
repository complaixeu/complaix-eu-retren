import { describe, expect, it, vi } from "vitest";
import { runClassifierEval } from "@/features/claims/classifier/eval";
import { loadGoldenSet } from "@/tests/fixtures/mail/golden";

// C5: `pnpm eval:classifier` logic, exercised with a fake fetch only (never the real model).
const KEY = "eval-key-not-real";
const golden = loadGoldenSet();

/** A fake Gemini that answers `answer(fixtureBody)` for each request. */
function fakeGemini(answer: (body: string) => string) {
  return vi.fn(async (_url: string | URL | Request, req?: RequestInit) => {
    const text: string = JSON.parse(String(req!.body)).contents[0].parts[0].text;
    const quoted = JSON.parse(text.slice(text.indexOf("<mail>") + 6, text.indexOf("</mail>")));
    const category = answer(quoted.body);
    return Response.json({
      candidates: [
        { content: { parts: [{ text: JSON.stringify({ category, confidence: 0.95 }) }] } },
      ],
    });
  });
}

const right = (body: string) => golden.find((f) => f.mail.text === body)!.accept[0];

describe("runClassifierEval", () => {
  it("without GEMINI_API_KEY it skips cleanly with a message and calls nothing", async () => {
    const fetch = vi.fn();
    const lines: string[] = [];
    const result = await runClassifierEval({ env: {}, fetch, log: (l) => lines.push(l) });
    expect(result.status).toBe("skipped");
    expect(lines.join("\n")).toMatch(/GEMINI_API_KEY/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes when every fixture is right or falls back to other, and never logs the key", async () => {
    const fetch = fakeGemini(right);
    const lines: string[] = [];
    const result = await runClassifierEval({
      env: { GEMINI_API_KEY: KEY },
      fetch,
      log: (l) => lines.push(l),
    });
    expect(result).toMatchObject({ status: "done", total: golden.length, wrong: [] });
    expect(lines.join("\n")).not.toContain(KEY);
    expect(String(fetch.mock.calls[0][0])).not.toContain(KEY);
  });

  it("counts a fallback to other as acceptable, not as wrong", async () => {
    const result = await runClassifierEval({
      env: { GEMINI_API_KEY: KEY },
      fetch: fakeGemini(() => "other"),
      log: () => {},
    });
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.wrong).toEqual([]);
    expect(result.fallbacks).toBeGreaterThan(0);
  });

  it("reports every fixture classified into a wrong category", async () => {
    const result = await runClassifierEval({
      env: { GEMINI_API_KEY: KEY },
      fetch: fakeGemini(() => "approved"),
      log: () => {},
    });
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    const expectedWrong = golden
      .filter((f) => f.kind !== "injection" && !f.accept.includes("approved"))
      .map((f) => `${f.operator}/${f.file}`);
    expect(result.wrong.map((w) => w.fixture).sort()).toEqual(expectedWrong.sort());
  });
});
