// Golden set of operator replies (docs/plans/README.md §4, item 4).
//
// Layout: tests/fixtures/mail/<operator>/<name>.eml, where <name> is either
//   - `<category>-NN`: an ordinary reply whose expected category is <category>, or
//   - `injection-NN`, `wrong-sender-NN`, `spoofed-ref-NN`: adversarial replies. These carry an
//     `X-Retren-Golden-Accept` header listing the categories that count as correct.
// Every fixture is fictional and neutral: no real people, tickets or case data.
//
// The parser below only understands what the fixtures use (single-part text/plain, 8bit, folded
// headers). Real inbound MIME is parsed by the inbound endpoint (C4), not by this file.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ReplyCategory } from "@/shared/contracts";

export const MAIL_FIXTURES_DIR = join(process.cwd(), "tests", "fixtures", "mail");

export const SPECIAL_KINDS = ["injection", "wrong-sender", "spoofed-ref"] as const;
export type SpecialKind = (typeof SPECIAL_KINDS)[number];

export type GoldenFixture = {
  operator: string;
  file: string;
  /** `category` for an ordinary reply, otherwise the adversarial kind. */
  kind: "category" | SpecialKind;
  /** Categories that count as a correct classification. */
  accept: ReplyCategory[];
  headers: Record<string, string>;
  mail: { from: string; subject: string; text: string };
};

export function parseEml(raw: string): { headers: Record<string, string>; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const split = normalized.indexOf("\n\n");
  const head = split === -1 ? normalized : normalized.slice(0, split);
  const body = split === -1 ? "" : normalized.slice(split + 2);
  const headers: Record<string, string> = {};
  let last: string | undefined;
  for (const line of head.split("\n")) {
    if (/^[ \t]/.test(line) && last) {
      headers[last] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error(`malformed header line: ${line}`);
    last = line.slice(0, colon).trim().toLowerCase();
    headers[last] = line.slice(colon + 1).trim();
  }
  return { headers, body: body.replace(/\s+$/, "") };
}

const NAME = /^([a-z_-]+)-\d{2}\.eml$/;

export function loadFixture(operator: string, file: string): GoldenFixture {
  const match = NAME.exec(file);
  if (!match) throw new Error(`${operator}/${file}: name must be <prefix>-NN.eml`);
  const prefix = match[1];
  const { headers, body } = parseEml(readFileSync(join(MAIL_FIXTURES_DIR, operator, file), "utf8"));
  const mail = { from: headers.from ?? "", subject: headers.subject ?? "", text: body };

  const category = ReplyCategory.safeParse(prefix);
  if (category.success) {
    return { operator, file, kind: "category", accept: [category.data], headers, mail };
  }
  if (!(SPECIAL_KINDS as readonly string[]).includes(prefix)) {
    throw new Error(`${operator}/${file}: unknown fixture prefix "${prefix}"`);
  }
  const listed = headers["x-retren-golden-accept"];
  if (!listed) throw new Error(`${operator}/${file}: missing X-Retren-Golden-Accept`);
  const accept = listed.split(",").map((c) => ReplyCategory.parse(c.trim()));
  return { operator, file, kind: prefix as SpecialKind, accept, headers, mail };
}

export function loadGoldenSet(): GoldenFixture[] {
  return readdirSync(MAIL_FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      readdirSync(join(MAIL_FIXTURES_DIR, d.name))
        .filter((f) => f.endsWith(".eml"))
        .sort()
        .map((f) => loadFixture(d.name, f)),
    );
}
