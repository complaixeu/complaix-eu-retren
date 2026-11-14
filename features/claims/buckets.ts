// Private storage buckets the outbound mail reads attachments from (C3). Internal to domain C.
// C6's user documents bucket is USER_DOCUMENTS_BUCKET in ./actions.

/** Domain A's private bucket for the original tickets (A1); `ticketPath` is a key inside it. */
export const TICKET_BUCKET = "tickets";
/** Private bucket for the documents Retren generates for a case (migration *_claims_outbound.sql). */
export const DOCUMENTS_BUCKET = "claim-documents";
