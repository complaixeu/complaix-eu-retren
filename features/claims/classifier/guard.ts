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

const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const HOST = `(?:${LABEL}\\.)+[a-z]{2,24}`;
const ADDRESS = new RegExp(`([a-z0-9._%+-]+)@(${HOST})`, "g");
/** `https://host…` and `www.host…`; the captured host keeps its `www.` exactly once. */
const URL_HOST = new RegExp(`(?:\\bhttps?:\\/\\/(${HOST})|(?<![\\w.@/-])(www\\.${HOST}))`, "g");
/**
 * A bare host without a scheme: two or more labels and a letters-only TLD, not part of an
 * address or a URL, and either followed by a path or with a subdomain (3+ labels). Prose such as
 * "Sr.", "p.ej.", "S.A." or "10.30" never has that shape.
 */
const BARE_HOST = new RegExp(`(?<![\\w.@/:-])(${HOST})(?=(\\/)|[^\\w.-]|\\.(?![a-z0-9])|$)`, "g");
const FILE_EXTENSION =
  /\.(pdf|jpe?g|png|gif|webp|heic|tiff?|docx?|xlsx?|pptx?|odt|txt|csv|zip|rar|eml|html?)$/;

/**
 * Public hosts that operator footers and legal citations link to. Links only: an address in one
 * of these domains is still flagged. Social profiles are allowed as links on purpose (footers
 * carry them; the guard routes, it does not block).
 */
export const PUBLIC_LINK_HOSTS: readonly string[] = [
  "eur-lex.europa.eu",
  "transportes.gob.es",
  "apps.apple.com",
  "play.google.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "youtube.com",
  "tiktok.com",
];

function inDomain(domain: string, trusted: string): boolean {
  return domain === trusted || domain.endsWith(`.${trusted}`);
}

function untrustedTarget(text: string, trust: Trust): boolean {
  const domains = trust.domains.map((d) => d.toLowerCase());
  const addresses = trust.addresses.map((a) => a.toLowerCase());
  const host = (h: string) => h.replace(/^www\./, "");
  const okDomain = (d: string) => domains.some((t) => inDomain(host(d), t));
  const okLink = (d: string) => okDomain(d) || PUBLIC_LINK_HOSTS.some((t) => inDomain(host(d), t));
  const cleaned = deobfuscate(dropNonAddresses(text));

  for (const m of cleaned.matchAll(ADDRESS)) {
    const address = `${m[1]}@${m[2]}`.replace(/^[._%+-]+/, "");
    if (!addresses.includes(address) && !okDomain(m[2])) return true;
  }
  for (const m of cleaned.matchAll(URL_HOST)) {
    if (!okLink(m[1] ?? m[2])) return true;
  }
  // Bare hosts are looked for outside the URLs already checked (their paths, queries and
  // fragments are not hosts), and file names are not hosts.
  const withoutUrls = cleaned.replace(/\b(?:https?:\/\/|www\.)\S*/g, " ");
  for (const m of withoutUrls.matchAll(BARE_HOST)) {
    const h = m[1];
    if (FILE_EXTENSION.test(h)) continue;
    const hasPath = m[2] === "/";
    const labels = h.split(".").length;
    if ((hasPath || labels >= 3) && !okLink(h)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Instruction-like text. Patterns run on normalised text and may span lines ([\s\S], \s).

/** Words that name a verdict. Kept strict ("otros", "favorable" are ordinary ticket words). */
const CATEGORY_WORD =
  "(aprobad\\w*|aceptad\\w*|denegad\\w*|rechazad\\w*|approved|accepted|denied|rejected|acknowledg\\w*|asks_for_data|refers_to_form|other)";

/** A verb not directly negated ("no lo reenvíe", "ni copie", "do not forward"). */
const NOT_NEGATED =
  "(?<!\\b(?:no|ni|not|never|nunca|n't|do not|don't)\\s+(?:(?:l[oae]s?|se|me|nos|le|les)\\s+)?)";

const INSTRUCTION_LIKE: RegExp[] = [
  // "ignore / forget / disregard the instructions | rules | everything above" ("olvide lo
  // anterior" alone is an ordinary apology and is not flagged)
  /\b(ignor|olvid|disregard|forget|omit|pase\w* por alto)\w*\b[\s\S]{0,40}?\b(instruc|indicac|regla|norma|rules|prompt|directiv|todo lo anterior|everything above|the above)/,
  /\b(no (tenga|tengan|tome|tomen|haga|hagan) (en cuenta|caso)|haga\w* caso omiso)\b[\s\S]{0,40}?\b(instruc|indicac|regla|norma|lo anterior|todo lo anterior|lo dicho|lo previo)/,
  /\b(previous|prior|above|earlier) (instructions|rules|prompt)\b/,
  // "classify (this mail) as approved", in any person or tense
  new RegExp(
    `\\bclasifi\\w*\\b[\\s\\S]{0,40}?\\bcomo\\s+(un[ao]?\\s+|el\\s+|la\\s+)?${CATEGORY_WORD}`,
  ),
  new RegExp(
    `\\b(classif\\w*|categori[sz]\\w*|label\\w*|mark\\w*)\\b[\\s\\S]{0,40}?\\bas\\s+(an?\\s+)?${CATEGORY_WORD}`,
  ),
  // "treat this message as approved"
  new RegExp(
    `\\b(trat|consider|treat)\\w*\\b\\s+(este|el|this|the)\\s+(mensaje|correo|e-?mail|mail|message)\\b[\\s\\S]{0,20}?\\b(como|as)\\s+(un[ao]?\\s+|an?\\s+)?${CATEGORY_WORD}`,
  ),
  // "answer only with approved", "answer only: approved", "output approved"
  new RegExp(
    `\\b(respond|contest|answer|reply|devuelv|escrib|say|return)\\w*\\b[\\s\\S]{0,30}?\\b(solo|solamente|unicamente|only|just)\\b[\\s\\S]{0,30}?\\b${CATEGORY_WORD}`,
  ),
  new RegExp(`\\boutput\\b\\s*:?\\s*["']?${CATEGORY_WORD}`),
  /<!--[\s\S]{0,300}?\b(assistant|system|model|ai|llm|output|categor\w*|classif\w*|clasific\w*)\b[\s\S]{0,300}?-->/,
  /\b(the|la|su) (category|categoria|clasificacion) (is|es|sera|debe ser)\b/,
  // A label or JSON field that dictates the verdict. A ticket field ("Categoría: Retrasos") is fine.
  new RegExp(
    `["']?\\b(category|categoria|clasificacion|classification|label|etiqueta)\\b["']?\\s*[:=]\\s*["']?${CATEGORY_WORD}`,
  ),
  /["']\s*(confidence|confianza)\s*["']\s*:/,
  // Role markers and jailbreak phrasing. A lone "Sistema:" ticket line is fine.
  /^\s*(#{1,6}|\[|<)\s*(system|assistant|developer|sistema|asistente|instructions?)\s*(\]|>)?\s*:?\s*$/m,
  /^\s*(\[|<)?\s*(system|assistant|developer)\s*(\]|>)?\s*:\s*\S/m,
  /<\/?\s*(system|instructions?|prompt)\s*>/,
  /\bsystem prompt\b/,
  /\byou are now\b|\bahora (eres|es usted|actua)\b/,
  /\bact as (an? |the )?(ai|assistant|language model|chatbot|llm|bot|system|admin\w*|developer|different)\b/,
  /\bactue como (un |una |el |la )?(asistente|ia|inteligencia artificial|modelo|sistema|administrador|chatbot|bot)\b/,
  /\b(admin|administrator|developer|god|dan|jailbreak) mode\b|\bmodo (administrador|desarrollador|admin)\b/,
  // Sending the case or its data somewhere else (not when negated, as in confidentiality footers)
  new RegExp(
    `${NOT_NEGATED}\\b(reenvi|envi|remit|mand|forward|send|transfer)\\w*\\b[\\s\\S]{0,30}?\\b(datos|data|expediente|case file|documentacion|informacion|information|details)\\b[\\s\\S]{0,40}?\\b((a|al|to)\\s+(otra|otro|another|un[ao]? (nuev[ao]|distint[ao]|extern[ao]))\\s+(direccion|address|cuenta|correo|e-?mail)(?!\\s+postal)|extern[ao]s?|external|tercer[ao]s?|third[- ]part\\w*)`,
  ),
];

export function looksLikeInjection(mail: Mail, trust: Trust): boolean {
  const full = normalize(`${mail.subject}\n${mail.text}`);
  // Instructions are looked for everywhere, quoted lines included: the model sees them all.
  if (INSTRUCTION_LIKE.some((re) => re.test(full))) return true;
  // Addresses and links only in the new part: quoted history repeats our own thread.
  const fresh = normalize(`${mail.subject}\n${stripQuoted(mail.text)}`);
  return untrustedTarget(fresh, trust);
}
