// `pnpm eval:classifier`: the golden set against the real Gemini model (docs/plans/README.md §4.5).
// Not part of CI and never run by `pnpm test`. Without GEMINI_API_KEY it says so and stops.
// Every fixture must be classified correctly or fall back to `other`; any other category fails.
// The key is never printed.
import { createClassifier } from "./index";
import type { FetchLike } from "./gemini";
import { OperatorId, type ReplyCategory } from "@/shared/contracts";
import { loadGoldenSet } from "@/tests/fixtures/mail/golden";

export type EvalResult =
  | { status: "skipped"; reason: string }
  | {
      status: "done";
      total: number;
      correct: number;
      fallbacks: number;
      wrong: { fixture: string; got: ReplyCategory; accept: ReplyCategory[] }[];
    };

export async function runClassifierEval(options: {
  env: Record<string, string | undefined>;
  fetch?: FetchLike;
  log?: (line: string) => void;
}): Promise<EvalResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  if (!options.env.GEMINI_API_KEY) {
    const reason = "GEMINI_API_KEY is not set: skipping the real-model classifier eval.";
    log(reason);
    return { status: "skipped", reason };
  }

  const classifier = createClassifier(
    {
      LLM_PROVIDER: "gemini",
      GEMINI_API_KEY: options.env.GEMINI_API_KEY,
      GEMINI_MODEL: options.env.GEMINI_MODEL,
      MAIL_SENDING_DOMAIN: options.env.MAIL_SENDING_DOMAIN,
    },
    { fetch: options.fetch },
  );
  const golden = loadGoldenSet();
  let correct = 0;
  let fallbacks = 0;
  const wrong: { fixture: string; got: ReplyCategory; accept: ReplyCategory[] }[] = [];

  for (const f of golden) {
    const fixture = `${f.operator}/${f.file}`;
    const { category, confidence } = await classifier
      .forCase({ operator: OperatorId.parse(f.operator) })
      .classify(f.mail);
    let verdict: string;
    if (f.accept.includes(category)) {
      correct++;
      verdict = "ok";
    } else if (category === "other") {
      fallbacks++;
      verdict = "fallback";
    } else {
      wrong.push({ fixture, got: category, accept: f.accept });
      verdict = "WRONG";
    }
    log(
      `${verdict.padEnd(8)} ${fixture.padEnd(36)} got ${category} (${confidence.toFixed(2)}), expected ${f.accept.join(" | ")}`,
    );
  }

  log(
    `\n${golden.length} fixtures: ${correct} correct, ${fallbacks} fell back to other, ${wrong.length} wrong.`,
  );
  return { status: "done", total: golden.length, correct, fallbacks, wrong };
}
