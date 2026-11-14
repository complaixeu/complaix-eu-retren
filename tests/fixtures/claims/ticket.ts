// A neutral placeholder "ticket" for tests (docs/plans/README.md §3): a 1×1 grey PNG. Its content
// never matters, only that a stored file exists for the case.
export const TICKET_PLACEHOLDER_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
