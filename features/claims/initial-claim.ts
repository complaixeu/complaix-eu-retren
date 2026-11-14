// sendInitialClaim (docs/plans/C-claims.md C3, ARCHITECTURE §4–§5): the first mail of a case to
// the operator, with the EU form, the mandate and the ticket. The outbox row, its attachments and
// the move waiting_period → sent are written in one transaction (claims_send_initial_claim,
// migration *_claims_outbound.sql); then the sender (./send-queued.ts) delivers it.
// Internal to domain C.
import { buildEuForm, buildMandate, renderTemplate } from "@/features/documents";
import { getOperatorConfig } from "@/features/rules";
import { systemClock } from "@/shared/clock";
import {
  EligibilityResult,
  EuFormData,
  IntakeSubmission,
  MandateData,
  OperatorId,
  type CaseStatus,
  type OperatorPublicConfig,
} from "@/shared/contracts";
import type { Json } from "@/shared/supabase";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import {
  checkMockText,
  INITIAL_CLAIM_SEND_LIMIT,
  initialClaimRefusal,
  newMessageId,
  subjectWithRef,
  type InitialClaimRefusal,
} from "./outbound";
import {
  assertSendConfig,
  queueForTeam,
  sendingDomain,
  sendQueued,
  TEAM_QUEUE_EVENT,
  type OutboundDeps,
  type SendQueuedResult,
} from "./send-queued";
import { RECHECK_MS } from "./timers";
import { provider } from "@/shared/providers";
import { DOCUMENTS_BUCKET, TICKET_BUCKET } from "./buckets";

export { DOCUMENTS_BUCKET, TICKET_BUCKET, TEAM_QUEUE_EVENT };
/** The first timer stage (C7, d12): when the tick next looks at a sent case. */
export const FIRST_FOLLOW_UP_DAYS = 12;

const DAY_MS = 86_400_000;

export type SendInitialClaimResult =
  | { ok: true; messageId: string; delivery: SendQueuedResult }
  | { ok: false; reason: InitialClaimRefusal };

/** Refusals a person has to act on: they go to the team queue (once per case and reason). */
const TEAM_QUEUE_REASONS: readonly InitialClaimRefusal[] = [
  "operator_inactive",
  "operator_has_no_email_channel",
  "ticket_missing",
];

/** Sender of mail to the operators. Placeholder domain until the real one exists (Nestor). */
export function claimsFrom(env: Record<string, string | undefined> = process.env): string {
  // With gmail the sender is the Retren mailbox itself (Gmail rewrites any other From).
  if (provider("MAIL_PROVIDER", env) === "gmail" && env.SMTP_USER?.trim()) {
    return env.SMTP_USER.trim();
  }
  return `reclamaciones@${sendingDomain(env)}`;
}

const MADRID_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The EU form's fields from the case (ARCHITECTURE "Mapeo del formulario"). */
export function euFormData(
  submission: IntakeSubmission,
  eligibility: EligibilityResult,
  operator: OperatorPublicConfig,
  now: Date,
): EuFormData {
  const { ticket, answers, consent } = submission;
  const name = `${ticket.firstName} ${ticket.lastName}`;
  return EuFormData.parse({
    ...(answers.previousClaim.made && {
      previousClaim: {
        date: answers.previousClaim.date,
        recipient: answers.previousClaim.recipient,
        means: answers.previousClaim.means,
      },
    }),
    operatorName: operator.displayName,
    scheduled: {
      date: ticket.travelDate,
      origin: ticket.origin,
      destination: ticket.destination,
      departureTime: ticket.scheduledDeparture,
      arrivalTime: ticket.scheduledArrival,
      ...(ticket.trainNumber && { trainNumber: ticket.trainNumber }),
      ticketRef: ticket.ticketNumber ?? ticket.bookingRef,
      ...(ticket.price && { price: ticket.price }),
    },
    actual: { arrivalDate: answers.actualArrival.date, arrivalTime: answers.actualArrival.time },
    delayMinutes: Math.max(0, eligibility.delayMinutes),
    passenger: { firstName: ticket.firstName, lastName: ticket.lastName },
    bookingEmail: answers.email,
    paymentPreference: answers.paymentPreference,
    gdprAccepted: consent.gdprAccepted,
    // Sent by email: the place is "online", not a city we would be making up.
    request: { date: MADRID_DATE.format(now), place: "En línea" },
    representedName: name,
  });
}

export function mandateData(
  submission: IntakeSubmission,
  publicRef: string,
  operator: OperatorPublicConfig,
): MandateData {
  const { ticket, answers, consent } = submission;
  return MandateData.parse({
    caseRef: publicRef,
    passengerName: `${ticket.firstName} ${ticket.lastName}`,
    documentType: answers.documentType,
    documentNumber: answers.documentNumber,
    operatorName: operator.displayName,
    trip: {
      date: ticket.travelDate,
      origin: ticket.origin,
      destination: ticket.destination,
      ticketRef: ticket.ticketNumber ?? ticket.bookingRef,
    },
    acceptedAt: consent.acceptedAt,
    consentTextVersion: consent.textVersion,
  });
}

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
};

function ticketFile(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return {
    filename: `billete${ext && CONTENT_TYPES[ext] ? `.${ext}` : ""}`,
    contentType: CONTENT_TYPES[ext] ?? "application/octet-stream",
  };
}

/**
 * Sends the initial claim of a case, or refuses it. Runs only from waiting_period, once
 * earliest_send_at has passed, below the send cap, and only to an active operator with a
 * verified email address; an inactive operator (Renfe, Ouigo) is never sent automatically and
 * goes to the team queue. The claim counts towards the cap when it is queued.
 */
export async function sendInitialClaim(
  caseId: string,
  deps: OutboundDeps = {},
): Promise<SendInitialClaimResult> {
  const db = deps.db ?? createServiceClient();
  const env = deps.env ?? process.env;
  const now = (deps.clock ?? systemClock).now();
  const providerName = deps.providerName ?? provider("MAIL_PROVIDER", env);
  // A configuration that must never send (no redirect for a real provider) refuses before any write.
  assertSendConfig(providerName, env);

  const found = await db
    .from("cases")
    .select(
      "id, public_ref, operator, status, submission, eligibility, earliest_send_at, send_count",
    )
    .eq("id", caseId)
    .maybeSingle();
  if (found.error) throw found.error;
  if (!found.data) return { ok: false, reason: "case_not_found" };
  const c = found.data;
  const operator = getOperatorConfig(OperatorId.parse(c.operator));

  const refused = initialClaimRefusal(
    { status: c.status as CaseStatus, earliestSendAt: c.earliest_send_at, sendCount: c.send_count },
    operator,
    now,
  );
  if (refused) return refuse(db, caseId, now, refused);
  if (operator.channel.type !== "email")
    return refuse(db, caseId, now, "operator_has_no_email_channel");

  const submission = IntakeSubmission.parse(c.submission);
  const eligibility = EligibilityResult.parse(c.eligibility);
  const { ticket, answers } = submission;
  const passengerName = `${ticket.firstName} ${ticket.lastName}`;

  const rendered = renderTemplate("initial_claim", operator.id, {
    ref: c.public_ref,
    passengerName,
    operatorName: operator.displayName,
    travelDate: ticket.travelDate,
    origin: ticket.origin,
    destination: ticket.destination,
    ticketRef: ticket.ticketNumber ?? ticket.bookingRef,
    delayMinutes: String(eligibility.delayMinutes),
    documentType: answers.documentType,
    documentNumber: answers.documentNumber,
    paymentPreference: answers.paymentPreference,
  });
  if (!checkMockText(rendered, providerName).ok) return { ok: false, reason: "mock_text" };

  // The stored ticket (domain A's private bucket).
  const stored = await db.storage.from(TICKET_BUCKET).download(submission.ticketPath);
  if (stored.error || !stored.data) return refuse(db, caseId, now, "ticket_missing");
  const ticketBytes = stored.data.size;

  // The generated documents, in our private bucket. Overwritten on a retry, never public.
  const [euForm, mandate] = await Promise.all([
    buildEuForm(euFormData(submission, eligibility, operator, now)),
    buildMandate(mandateData(submission, c.public_ref, operator)),
  ]);
  const docs = [
    { kind: "eu_form", filename: "formulario_ue.pdf", bytes: euForm },
    { kind: "mandate", filename: "autorizacion_representacion.pdf", bytes: mandate },
  ] as const;
  for (const d of docs) {
    const up = await db.storage
      .from(DOCUMENTS_BUCKET)
      .upload(`${caseId}/${d.filename}`, d.bytes, { contentType: "application/pdf", upsert: true });
    if (up.error) throw up.error;
  }

  const t = ticketFile(submission.ticketPath);
  const attachments = [
    ...docs.map((d) => ({
      kind: d.kind,
      storage_path: `${DOCUMENTS_BUCKET}/${caseId}/${d.filename}`,
      filename: d.filename,
      content_type: "application/pdf",
      size_bytes: d.bytes.byteLength,
    })),
    {
      kind: "ticket",
      storage_path: `${TICKET_BUCKET}/${submission.ticketPath}`,
      filename: t.filename,
      content_type: t.contentType,
      size_bytes: ticketBytes,
    },
  ];

  const sent = await db.rpc("claims_send_initial_claim", {
    p_case_id: caseId,
    p_now: now.toISOString(),
    p_max_sends: INITIAL_CLAIM_SEND_LIMIT,
    p_next_action_at: new Date(now.getTime() + FIRST_FOLLOW_UP_DAYS * DAY_MS).toISOString(),
    p_message: {
      from: claimsFrom(env),
      to: operator.channel.address,
      subject: subjectWithRef(rendered.subject, c.public_ref),
      body_text: rendered.text,
      message_id: newMessageId(c.public_ref, sendingDomain(env)),
    },
    p_attachments: attachments as unknown as Json,
  });
  if (sent.error) throw sent.error;
  const out = sent.data as { ok: boolean; reason?: InitialClaimRefusal; message_id?: string };
  if (!out.ok) return { ok: false, reason: out.reason ?? "not_waiting_period" };

  const delivery = await sendQueued(out.message_id!, { ...deps, db, env, providerName });
  return { ok: true, messageId: out.message_id!, delivery };
}

async function refuse(
  db: ServiceClient,
  caseId: string,
  now: Date,
  reason: InitialClaimRefusal,
): Promise<SendInitialClaimResult> {
  if (TEAM_QUEUE_REASONS.includes(reason)) {
    // Once per case and reason (unique index, so two ticks at once can't write it twice).
    await queueForTeam(db, caseId, { reason, action: "initial_claim" });
    // A person has to act: look again in a day, not every hour.
    const later = await db
      .from("cases")
      .update({ next_action_at: new Date(now.getTime() + RECHECK_MS).toISOString() })
      .eq("id", caseId)
      .eq("status", "waiting_period");
    if (later.error) throw later.error;
  }
  return { ok: false, reason };
}
