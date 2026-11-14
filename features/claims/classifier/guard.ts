/**
 * A deterministic tripwire run before any classifier: a reply that contains an address outside
 * the sender's domain, or text that reads like instructions to the system, goes straight to the
 * team queue (`other`). Operator mail is data, never orders (ARCHITECTURE §5, rule 5). False
 * positives only cost a human look, so the check errs on the side of flagging.
 */

const ADDRESS = /[a-z0-9._%+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

const INSTRUCTION_LIKE: RegExp[] = [
  /\bignor(e|a|en|ar)\b.{0,40}\b(instruc|indicac|previous|prior|above|anterior)/,
  /\b(olvid[ae]n?|disregard|forget)\b.{0,40}\b(instruc|indicac|rules|reglas)/,
  /\b(instrucciones|indicaciones) (anteriores|previas)\b/,
  /\b(previous|prior) instructions\b/,
  /\bclasifi(ca|que|quen|car)\b.{0,30}\bcomo\b/,
  /\bclassify\b.{0,30}\bas\b/,
  /^\s*(system|assistant|developer)\s*:/m,
  /\bsystem prompt\b/,
  /\bthe category is\b/,
  // Forwarding the case elsewhere. A plain "envíe los documentos" is an ordinary asks_for_data.
  /\b(reenvi[ea]n?|forward)\b.{0,30}\b(sus|los|the|all)\b.{0,20}\b(datos|data|case file|expediente|documentos)\b/,
  /\b(otra direccion|direccion externa|another (e-?mail )?address|external address)\b/,
];

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function senderDomain(from: string): string | undefined {
  const m = /@([^\s<>@]+?)>?\s*$/.exec(from.trim());
  return m?.[1].toLowerCase();
}

function inDomain(domain: string, trusted: string): boolean {
  return domain === trusted || domain.endsWith(`.${trusted}`);
}

export function looksLikeInjection(
  mail: { from: string; subject: string; text: string },
  options: { trustedDomains?: readonly string[] } = {},
): boolean {
  const text = normalize(`${mail.subject}\n${mail.text}`);
  if (INSTRUCTION_LIKE.some((re) => re.test(text))) return true;

  const own = senderDomain(mail.from);
  const trusted = [...(own ? [own] : []), ...(options.trustedDomains ?? [])].map((d) =>
    d.toLowerCase(),
  );
  for (const m of text.matchAll(ADDRESS)) {
    const domain = m[1].toLowerCase();
    if (!trusted.some((t) => inDomain(domain, t))) return true;
  }
  return false;
}
