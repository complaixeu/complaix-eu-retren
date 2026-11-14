// Domain A, intake (owner: person A). Its output reaches other domains only through
// `createCase` (domain C), so it exports nothing to them; keep it that way (A → C → B).
//
// This is the server and cross-domain entry point: it re-exports server-only code, so never
// import it from a "use client" component. Client components get what they need as props from a
// server component (see app/(intake)/reclamar/layout.tsx), because ESLint forbids
// `@/features/intake/*` deep imports everywhere.

// Server-side only, for A1/A3 server code:
export { createOcr } from "./ocr";

// Server-side only: the draft of the claim in progress ([A1]). Later steps call `requireDraft()`
// at the top of their page (redirects to /reclamar/foto without a valid draft) and
// `updateCurrentDraft(patch)` / `mergeDraftData(id, patch)` from their server actions.
export {
  getCurrentDraft,
  requireDraft,
  startDraft,
  updateCurrentDraft,
  type DraftSessionDeps,
} from "./draft/session";
export {
  DRAFT_TTL_MS,
  INTAKE_DRAFT_STATUSES,
  TICKET_BUCKET,
  createDraft,
  deleteDraft,
  getDraft,
  mergeDraftData,
  ticketPreview,
  ticketVersion,
  type DraftDeps,
  type IntakeDraft,
  type IntakeDraftData,
  type IntakeDraftStatus,
  type IntakeDraftTicket,
  type TicketPreview,
} from "./draft/store";
export { DRAFT_COOKIE } from "./draft/cookie";

// Server-side only: the ticket upload check ([A1]).
export { readTicketUpload, type ReadTicketResult, type TicketUpload } from "./upload/read";
export {
  TICKET_MAX_BYTES,
  TICKET_TYPES,
  TICKET_UPLOAD_ERRORS,
  detectTicketType,
  ticketUploadRules,
  validateTicket,
  type TicketType,
  type TicketUploadError,
} from "./upload/rules";

// The step list, for intake's own pages in app/(intake)/ (server components):
export {
  INTAKE_STEPS,
  intakeStep,
  intakeStepFromPathname,
  intakeStepHref,
  intakeStepNeighbours,
  intakeStepperItems,
  type IntakeStep,
  type IntakeStepId,
  type IntakeStepperItem,
} from "./steps";

// Server-side only: the review step ([A4]). Reads `data.extraction` / `data.review` from the
// draft and stores the reviewed ticket as `data.review`.
export {
  REVIEW_FIELDS,
  REVIEW_REQUIRED_FIELDS,
  REVIEW_SECTIONS,
  reviewErrorMessage,
  reviewErrorMessages,
  reviewWarningMessage,
  REVIEW_WARNING_MESSAGES,
  LONG_TRIP_MINUTES,
  type ReviewErrorCode,
  type ReviewErrors,
  type ReviewField,
  type ReviewInputName,
  type ReviewSection,
  type ReviewWarningCode,
  type ReviewWarnings,
} from "./review/fields";
export { StoredReview, readReview, type ReviewStart } from "./review/read";
export { submitReview, type ReviewSubmitResult } from "./review/submit";
export {
  BOOKING_REF_CONFIRMED,
  parseReviewDate,
  parseReviewTime,
  reviewWarnings,
  validateReview,
  type ReviewValidation,
  type ReviewValues,
} from "./review/validate";

// Server-side only: the direct upload to Storage and the draft purge ([A1] follow-up). Kept in
// its own block so other tasks can add exports above without touching it.
export {
  beginTicketUpload,
  finishTicketUpload,
  type BeginTicketUploadResult,
  type FinishTicketUploadResult,
} from "./draft/session";
export { createDraftFromUpload, type DraftFromUploadResult } from "./draft/store";
export { purgeExpiredDrafts, type PurgeResult } from "./draft/purge";
export {
  UPLOAD_PREFIX,
  checkStoredTicket,
  declaredTicketError,
  uploadContentType,
  type DeclaredTicket,
} from "./upload/direct";

// Server-side only: the mandate and GDPR consent evidence ([A6]). A7 builds the submission's
// `consent` with `toConsentRef(await latestConsent(draft.id))`.
export {
  acceptConsent,
  readConsentChoices,
  type AcceptConsentResult,
  type ConsentChoices,
} from "./consent/accept";
export { clientIp, type HeaderReader } from "./consent/ip";
export {
  ClaimAnswers,
  TripSnapshot,
  buildTripSnapshot,
  tripSummary,
  type TripSnapshotResult,
} from "./consent/snapshot";
export {
  ConsentStoreError,
  insertConsent,
  latestConsent,
  toConsentRef,
  type ConsentDeps,
  type ConsentRecord,
} from "./consent/store";
export {
  CONSENT_CHOICES,
  CONSENT_DRAFT_NOTICE,
  CONSENT_TEXT_VERSION,
  MANDATE_TEXT,
  PRIVACY_NOTICE,
  type ConsentChoice,
  type MandateText,
  type PrivacyNotice,
} from "./consent/texts";
