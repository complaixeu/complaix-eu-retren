/**
 * How long a draft lives from its upload. The ticket photo is personal data, so an unfinished
 * claim does not wait around: after a day the user starts again.
 */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
