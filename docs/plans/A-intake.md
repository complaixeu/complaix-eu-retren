# Plan A: Intake (ticket upload → review → questions → consent → case)

Owner: `@complaix-eu` (Nestor) · Harness: Claude Code · Architecture: §1, §2, legal "evidencia de la aceptación"
Folders: `app/(intake)/`, `features/intake/`, `shared/ui/`, `app/layout.tsx`, `app/globals.css`,
`tests/{unit,integration,e2e}/intake/`, `supabase/tests/intake_*.sql`, migrations `*_intake_*.sql`.
Uses: `@/features/claims` (`createCase`, mock until C2). Never imports B directly.

## Lanes

| Lane | Tasks        | Theme                                |
| ---- | ------------ | ------------------------------------ |
| 1    | A1 → A2 → A3 | Upload, OCR, extraction (server)     |
| 2    | A0 → A4 → A5 | Pages, review screen, questions (UI) |
| 3    | A6 → A7 → A8 | Consent evidence, submit, e2e        |

## Tasks

### A0: Flow skeleton and layout

- Routes `/` (landing with a "Reclamar" button) and `/reclamar/{foto,revision,preguntas,mandato,enviado}`.
  Step state lives in a server-side draft (A1 creates it), never only in the browser.
- `shared/ui/`: Button, Field, Stepper, Alert; accessible labels, Spanish texts.
- Tests:
  - e2e: landing → every step renders its heading; the stepper shows the current step; keyboard
    navigation works.
  - unit: Stepper logic.

### A1: Ticket upload and draft

- Private Storage bucket `tickets` (migration), and table `intake_drafts` (id, created_at,
  ticket_path, status, data jsonb, expires_at), RLS on, server-only access.
- Upload: jpg, png, heic or pdf, ≤ 10 MB, checked on the server; a draft is created.
- Tests:
  - unit: type and size validation.
  - pgTAP: the bucket is private; `anon` and `authenticated` can't read objects or
    `intake_drafts`; `expires_at` is required.
  - integration: upload a placeholder file → object stored and draft row created.
  - e2e: upload succeeds and shows a preview; a wrong type or oversize file shows an error.

### A2: OCR port

- `OcrProvider` with `vision` (Google Cloud Vision, server-only, key from
  `GOOGLE_CLOUD_VISION_API_KEY`) and `fake`
  (fixture text keyed by file hash). Returns `{ text, quality: 'ok' | 'unreadable' }`.
- Tests:
  - unit: the fake returns the fixtures; the adapter maps Vision's response shape (recorded JSON
    fixture, no network); empty or very short text → `unreadable`.

### A3: Extraction port and "never invent"

- `Extractor` with `gemini` (Flash-Lite, structured JSON output; check the model name; key from
  `GEMINI_API_KEY`, server-only) and `fake`.
  Output: `TicketData`, every field optional, plus `missing[]`.
- Post-check: any extracted value that doesn't appear (normalized) in the OCR text is dropped and
  goes into `missing`. This is the "AI fills nothing the user didn't give" rule.
- An unreadable photo asks for another one; the second failure goes to manual entry.
- Tests:
  - unit:
    - OCR-text fixtures for Iryo-, Renfe- and Ouigo-style layouts → expected fields;
    - a hallucinated field (value not in the text) is dropped;
    - the zod schema rejects bad dates and times;
    - the retry → manual decision.
  - integration: draft → OCR fake → extractor fake → `intake_drafts.data` updated.
  - e2e: unreadable fixture → "otra foto" → second failure → manual form.

### A4: Review screen

- Shows every extracted field as editable, highlights the missing ones, and requires the
  "localizador" to be confirmed explicitly (ARCHITECTURE §2: mandatory review).
- Tests:
  - unit: field validation (dates, times, arrival after departure).
  - e2e: edit a field → it's saved to the draft; the user can't continue without confirming the
    localizador; missing fields are asked for.

### A5: Minimal questions

- Always asked (ARCHITECTURE §1 table): document type and number (DNI, NIE or passport, with the
  DNI/NIE check letter validated), email, real arrival time, whether the trip was already claimed
  (and if so: date, recipient, means), money or voucher.
- Asked only if missing: the fields listed in §1. Never asked: address, phone, IBAN, SWIFT, holder,
  extra info, real departure time.
- Tests:
  - unit: the DNI/NIE check letter (valid and invalid vectors); the "asked only if missing"
    selection; the never-asked fields are never rendered.
  - e2e: the full questions step with both branches of "already claimed".

### A6: Mandate and GDPR consent evidence

- Shows the mandate text and privacy notice, versioned (`text_version`), marked "borrador pendiente
  de revisión jurídica".
- Table `consents` (id, draft_id, accepted_at, text_version, ip, trip_snapshot jsonb), insert-only.
- Tests:
  - pgTAP: RLS on, no client access; UPDATE and DELETE are blocked (trigger or policy);
    `text_version` and `accepted_at` are not null.
  - integration: accepting stores the IP from the request headers and the trip snapshot.
  - e2e: you can't continue without both checkboxes.

### A7: Submit → case

- Builds an `IntakeSubmission` (zod-validated) and calls `createCase` from `@/features/claims`
  (its mock until `[C2]` is merged, then the real one). Shows the result: eligible (with the
  earliest send date), not eligible (with the reason), or doubtful.
- Deletes the draft data that isn't needed after submit (data minimization).
- Tests:
  - unit: draft → submission mapping.
  - integration (with the real C2 once merged): a case row exists and the draft is cleaned up.
  - e2e: every result screen.

### A8: Intake e2e suite

- One Playwright spec per path: happy path, unreadable → manual, not eligible, doubtful.
- Accessibility: `@axe-core/playwright` finds no serious violations on every step.
- Tests: the suite itself, green on the latest `develop`. This is the domain's final gate.

## Definition of done for the domain

A1–A8 are merged; `pnpm test:all` is green on `develop`; the tracker issue is closed with the e2e
report summary.
