# User-reply fixtures (C10)

Fictional replies from the case user to our `user_request_document` notice. The e2e helper
(`tests/e2e/claims/full-helpers.ts`) rewrites the `[RTN-T200]` reference and the threading
headers (`Message-ID`, `In-Reply-To`, `References`) onto a seeded case, then feeds the mail to
the real inbound path (`ingestMessage`).

- `document-01.eml`: one attachment, `documento-prueba.pdf`, a blank one-page placeholder PDF
  (72×72 pt, no text). Its content never matters, only that the user sent one allowed file.

The sender is the placeholder address of `tests/fixtures/claims/submission.ts`. No real people,
documents or bank details.
