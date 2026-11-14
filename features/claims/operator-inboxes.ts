// MAIL_OPERATOR_INBOXES: per-operator test inboxes on DEV (docs/plans/README.md §4.8, C3). Pure: no
// DB, no clock, no network. Internal to domain C.
//
// Outside production, operator mail goes to the operator's mapped inbox instead of
// MAIL_REDIRECT_ALL_TO, and a mail from that inbox counts as the operator's, for that operator only
// and only with an aligned DKIM pass for the inbox's own domain (./outbound.ts, ./inbound.ts). The
// value is `operatorId:email` pairs, comma separated. Errors name the variable and the entry
// number, never an address (the logs are public).
import { z } from "zod";
import { OperatorId, type OperatorPublicConfig } from "@/shared/contracts";

type Env = Record<string, string | undefined>;

/** Operator id to the mailbox that stands in for its real address. */
export type OperatorInboxes = ReadonlyMap<OperatorId, string>;

const VAR = "MAIL_OPERATOR_INBOXES";

/**
 * The per-operator test inboxes from MAIL_OPERATOR_INBOXES. Empty when the variable is unset, and
 * always empty in production (RETREN_ENV=production is the only switch, as for the redirect).
 * Throws on a malformed value: an unknown operator id, a bad address, an operator or a mailbox
 * listed twice, or a mailbox equal to SMTP_USER or IMAP_USER (our own mailboxes never are).
 */
export function operatorInboxes(env: Env = process.env): OperatorInboxes {
  // The same rule as isProduction (./outbound.ts): not imported, to keep this module leaf-level.
  if (env.RETREN_ENV === "production") return new Map();
  const raw = env[VAR];
  const out = new Map<OperatorId, string>();
  if (!raw?.trim()) return out;

  // The mailboxes we send from and read: a tester inbox must never be one of them.
  const ownMailboxes = [env.SMTP_USER, env.IMAP_USER]
    .map((a) => a?.trim().toLowerCase())
    .filter((a): a is string => !!a);
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  entries.forEach((entry, i) => {
    const where = `${VAR} entry ${i + 1}`;
    const colon = entry.indexOf(":");
    if (colon <= 0) throw new Error(`${where} must be operatorId:email`);

    const id = OperatorId.safeParse(entry.slice(0, colon).trim().toLowerCase());
    if (!id.success) throw new Error(`${where} names an unknown operator id`);
    if (out.has(id.data)) throw new Error(`${where} lists an operator twice`);

    const address = entry
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    if (!z.email().safeParse(address).success) throw new Error(`${where} is not an email address`);
    if (ownMailboxes.includes(address)) {
      throw new Error(`${where} must differ from SMTP_USER and IMAP_USER`);
    }
    if ([...out.values()].includes(address)) {
      throw new Error(`${where} uses a mailbox already given to another operator`);
    }
    out.set(id.data, address);
  });
  return out;
}

/**
 * The operator as this environment may mail it: the one rule every claims path that checks the
 * channel or `active` uses. Outside production, an operator with a mapped test inbox counts as
 * active with an email channel to that inbox, whatever features/rules says (a web form, or
 * inactive). Production and unmapped operators come back unchanged (the same object).
 */
export function effectiveOperator(
  operator: OperatorPublicConfig,
  env: Env = process.env,
): OperatorPublicConfig {
  const inbox = operatorInboxes(env).get(operator.id);
  if (!inbox) return operator;
  return { ...operator, active: true, channel: { type: "email", address: inbox } };
}
