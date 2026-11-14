/**
 * A deterministic tripwire run before any classifier. A reply goes straight to the team queue
 * (`other`) when it names an address or a link outside the trusted set, or when its text reads
 * like instructions to the system. Operator mail is data, never orders (ARCHITECTURE §5, rule 5).
 * A false positive costs a human look; a false negative still meets the model's hardened prompt
 * and the closed-set verdict, and the classifier never sends anything either way.
 *
 * Pure: the trusted set is built by the caller (`trustFor` in ./index.ts) from the operator's
 * verified config, our own sending domain and the case user's address. The From header is never
 * trusted: it is whatever the sender claims.
 */

export type Trust = {
  /** Domains whose addresses and links are fine to mention (subdomains included). */
  domains: readonly string[];
  /** Exact addresses that are fine to mention (the case user). */
  addresses: readonly string[];
};

type Mail = { from: string; subject: string; text: string };

const ZERO_WIDTH = /[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

/** NFKC (fullwidth → ASCII), no zero-width characters, no diacritics, lower case. */
export function normalize(s: string): string {
  return s
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** The address in `Name <a@b>`, `a@b (Name)` or a bare `a@b`. */
export function parseAddress(header: string): string | undefined {
  const angle = /<\s*([^<>\s@]+@[^<>\s@]+)\s*>/.exec(header);
  const bare = /([^\s<>()@,;"]+@[^\s<>()@,;"]+)/.exec(header);
  return (angle?.[1] ?? bare?.[1])?.toLowerCase();
}

const QUOTE_HEADER = [
  /^\s*el\b.{0,200}\bescribio\s*:\s*$/,
  /^\s*on\b.{0,200}\bwrote\s*:\s*$/,
  /^\s*-{2,}\s*(mensaje original|original message|mensaje reenviado|forwarded message)\s*-{2,}\s*$/,
];

/**
 * The new part of a reply: lines starting with `>` are dropped, and everything after an
 * `El … escribió:` / `On … wrote:` (or an "original message" separator) line is cut. Works on
 * normalised or raw text.
 */
export function stripQuoted(text: string): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const n = normalize(line);
    if (QUOTE_HEADER.some((re) => re.test(n))) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Addresses and links

/** Tokens that look like addresses but are not: inline images and Message-IDs. */
function dropNonAddresses(text: string): string {
  return text
    .replace(/\bcid:[^\s\]>)]+/g, " ")
    .replace(/^\s*(message-id|in-reply-to|references)\s*:.*$/gm, " ")
    .replace(/<([^<>\s@]+)@[^<>\s]+>/g, (m, local: string) =>
      looksLikeMessageIdLocal(local) ? " " : m,
    );
}

function looksLikeMessageIdLocal(local: string): boolean {
  const digits = (local.match(/\d/g) ?? []).length;
  return local.length >= 12 && digits >= 4;
}

/** `pagos [at] evil.example`, `pagos (arroba) evil.example`, `evil [dot] example`. */
function deobfuscate(text: string): string {
  return text
    .replace(/\s*[[({]\s*(at|arroba)\s*[\])}]\s*/g, "@")
    .replace(/(\S)\s+arroba\s+(\S)/g, "$1@$2")
    .replace(/\s*[[({]\s*(dot|punto)\s*[\])}]\s*/g, ".");
}

const ADDRESS = /([a-z0-9._%+-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/g;
const URL_HOST = /\b(?:https?:\/\/|www\.)([a-z0-9-]+(?:\.[a-z0-9-]+)+)/g;

function inDomain(domain: string, trusted: string): boolean {
  return domain === trusted || domain.endsWith(`.${trusted}`);
}

function untrustedTarget(text: string, trust: Trust): boolean {
  const domains = trust.domains.map((d) => d.toLowerCase());
  const addresses = trust.addresses.map((a) => a.toLowerCase());
  const okDomain = (d: string) => domains.some((t) => inDomain(d.replace(/^www\./, ""), t));
  const cleaned = deobfuscate(dropNonAddresses(text));

  for (const m of cleaned.matchAll(ADDRESS)) {
    const address = `${m[1]}@${m[2]}`.replace(/^[._%+-]+/, "");
    if (!addresses.includes(address) && !okDomain(m[2])) return true;
  }
  for (const m of cleaned.matchAll(URL_HOST)) {
    const host = m[0].startsWith("www.") ? `www.${m[1]}` : m[1];
    if (!okDomain(host)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Instruction-like text. Patterns run on normalised text and may span lines ([\s\S], \s).

const CATEGORY_WORD =
  "(aprobad\\w*|aceptad\\w*|denegad\\w*|rechazad\\w*|acuse\\w*|approved|denied|acknowledg\\w*|asks_for_data|refers_to_form|other|otros?|positiv\\w*|favorable\\w*)";

const INSTRUCTION_LIKE: RegExp[] = [
  // "ignore / forget / disregard the instructions | rules | everything above"
  /\b(ignor|olvid|disregard|forget|omit|pase\w* por alto)\w*\b[\s\S]{0,40}?\b(instruc|indicac|regla|norma|rules|prompt|directiv|todo lo anterior|lo anterior|everything above|the above)/,
  /\b(no (tenga|tengan|tome|tomen|haga|hagan) (en cuenta|caso)|haga\w* caso omiso)\b[\s\S]{0,40}?\b(instruc|indicac|regla|norma|lo anterior|todo lo anterior|lo dicho|lo previo)/,
  /\b(previous|prior|above|earlier) (instructions|rules|prompt)\b/,
  // "classify (this mail) as approved", in any person or tense
  new RegExp(
    `\\bclasifi\\w*\\b[\\s\\S]{0,40}?\\bcomo\\s+(un[ao]?\\s+|el\\s+|la\\s+)?${CATEGORY_WORD}`,
  ),
  new RegExp(
    `\\b(classif\\w*|categori[sz]\\w*|label\\w*|mark\\w*)\\b[\\s\\S]{0,40}?\\bas\\s+(an?\\s+)?${CATEGORY_WORD}`,
  ),
  /\b(the|la|su) (category|categoria|clasificacion) (is|es|sera|debe ser)\b/,
  // A label or JSON that tries to dictate the verdict
  /["']?\b(category|categoria|clasificacion|classification|confidence|confianza)\b["']?\s*[:=]/,
  // Role markers and jailbreak phrasing
  /^\s*(#{1,6}\s*|\[|<)?\s*(system|assistant|developer|sistema|asistente|instructions?)\s*(\]|>)?\s*:?\s*$/m,
  /^\s*(\[|<)?\s*(system|assistant|developer|sistema|asistente)\s*(\]|>)?\s*:/m,
  /<\/?\s*(system|instructions?|prompt)\s*>/,
  /\bsystem prompt\b/,
  /\byou are now\b|\bahora (eres|es usted|actua)\b|\bact as\b|\bactue como\b/,
  /\b(admin|administrator|developer|god|dan|jailbreak) mode\b|\bmodo (administrador|desarrollador|admin)\b/,
  // Sending the case or its data somewhere else
  /\b(reenvi|envi|remit|mand|forward|send|transfer)\w*\b[\s\S]{0,30}?\b(datos|data|expediente|case file|documentacion|informacion|information|details)\b[\s\S]{0,40}?\b((a|al|to)\s+(otra|otro|another|un[ao]? (nuev[ao]|distint[ao]|extern[ao]))\s+(direccion|address|cuenta|correo|e-?mail)(?!\s+postal)|extern[ao]s?|external|tercer[ao]s?|third[- ]part\w*)/,
];

export function looksLikeInjection(mail: Mail, trust: Trust): boolean {
  const full = normalize(`${mail.subject}\n${mail.text}`);
  // Instructions are looked for everywhere, quoted lines included: the model sees them all.
  if (INSTRUCTION_LIKE.some((re) => re.test(full))) return true;
  // Addresses and links only in the new part: quoted history repeats our own thread.
  const fresh = normalize(`${mail.subject}\n${stripQuoted(mail.text)}`);
  return untrustedTarget(fresh, trust);
}
