# Plan C: Claims engine (cases, email loop, AI classification, timers, notices, team view)

Owner: `@vinimp2003` · Harness: Claude Code, with Codex reviewing every PR · Architecture: §5, §6, §7
Folders: `features/claims/`, `app/api/claims/`, `app/(team)/`, `shared/supabase/`,
`tests/{unit,integration,e2e}/claims/`, `tests/fixtures/mail/`, `supabase/tests/claims_*.sql`,
migrations `*_claims_*.sql`.
Uses: `@/features/rules` and `@/features/documents` (mocks until B3/B4/B5/B6 are merged).
Email testing strategy: [README §4](README.md#4-email-how-we-test-it). It is binding for this plan.

## Lanes

| Lane | Tasks              | Theme                                      |
| ---- | ------------------ | ------------------------------------------ |
| 1    | C1 → C2 → C6       | Schema, state machine, createCase, actions |
| 2    | C3 → C4 → C5       | Outbound, inbound, classifier              |
| 3    | C7 → C8 → C9 → C10 | Timers, user notices, team view, full e2e  |

## Tasks

### C1: Schema and state machine

- Migration with:
  - `cases`: id, public_ref `RTN-xxxx`, operator, status enum (the 9 states in §5), submission
    jsonb, eligibility jsonb, user_email, earliest_send_at, sent_at, next_action_at, send_count,
    paused, created_at;
  - `case_events` (append-only);
  - `messages`: direction, from, to, subject, message_id, in_reply_to, category, status
    `queued | sent | failed | received`, body_text, raw_path;
  - `attachments`.

  RLS is on and only the server (service role) has access.

- Pure `transition(status, event) → status`, with an explicit table of allowed moves; anything
  else throws.
- Generated types in `shared/supabase/database.types.ts`.
- Tests:
  - pgTAP: every table has RLS on; `anon` and `authenticated` can't read or write; the enum values
    are exact; UPDATE and DELETE on `case_events` are blocked; `public_ref` is unique.
  - unit: every allowed transition and a sample of forbidden ones (table-driven).

### C2: `createCase(submission)`

- Validates with zod, calls `evaluateEligibility` (B), stores the case plus a `created` event, and
  sets `next_action_at = earliestSendAt`. Not eligible → status `closed` and a
  `user_final_result` notice queued.
- Tests:
  - unit: the mapping and the branches.
  - integration: the eligible, doubtful and not-eligible paths against local Supabase (rows,
    events, outbox).

### C3: Outbound `sendInitialClaim(caseId)` and the transport

- `MailTransport`: `fake` (writes to the outbox only) and `gmail` (SMTP through Google
  Workspace, `nodemailer`, port 465 TLS, an app password). `MAIL_PROVIDER=fake | gmail`, default
  `fake`. The sender is the dedicated Retren mailbox (`SMTP_USER`); `MAIL_SENDING_DOMAIN` is its
  domain. Env: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`.
- Builds the attachments with `buildEuForm`, `buildMandate` and the stored ticket, renders
  `initial_claim`, and adds threading headers.
- Enforces the **recipient allowlist** (the operator config address only), the **attachment
  allowlist**, `MAIL_REDIRECT_ALL_TO` outside production, and the **send cap**.
- Tests:
  - unit: a non-operator recipient is refused; an attachment not on the allowlist is refused; the
    cap is reached; the redirect is applied; the headers are correct; the `gmail` transport builds
    the right message with nodemailer's JSON/stream transport (no network).
  - integration: the case moves to `sent`; the outbox row has 3 attachments; an event is logged;
    an inactive operator (Renfe, Ouigo) is never sent automatically.

### C4: Inbound: read the mailbox over IMAP

Decided 2026-11-14 (Nestor): Gmail / Google Workspace, so there is no provider webhook. The app
polls the mailbox instead, and there is no public inbound endpoint and no `INBOUND_SECRET`.

The mailbox may be a shared, already used account (on 2026-11-14 the DEV one held 754 messages),
so the reader must only ever touch mail that belongs to a claim.

- `ingestMessage(raw)` is the one entry point for incoming mail: parses MIME (`mailparser`) and
  matches the case by `[RTN-ref]` and/or `In-Reply-To` / `References` against our own sent
  `Message-ID`s. A reply that is ours (it carries our reference or threads onto our mail) but
  comes from a sender outside the operator's domain, or carries a reference that doesn't exist,
  goes to the team queue. Raw mail goes to private storage. The simulated mailbox (C9) calls the
  same function.
- **Only claim mail is read.** `pollInbox()` filters on the server with an IMAP search (subject
  contains `[RTN-`, or the sender is one of the operators' configured domains), and a message that
  then neither threads onto our mail nor carries one of our references is **skipped**: not stored,
  not queued, not logged with content. Unrelated mail never reaches our database or storage.
- **Read-only on the mailbox.** `pollInbox()` (`imapflow`), run by the existing hourly tick
  (`/api/claims/tick`, C7) when `MAIL_PROVIDER=gmail`, opens `INBOX` read-only (`EXAMINE`) and
  never changes flags, so the people using the mailbox see nothing change. Progress is kept in the
  database as the last processed UID (with `UIDVALIDITY`); the first run starts at the mailbox's
  current UID, so existing mail is never imported. Idempotent: `Message-ID` is unique, so a
  message read twice is stored once.
- **Never reads our own mail:** it skips anything sent from our own address, and anything
  addressed to `MAIL_REDIRECT_ALL_TO`. The redirect target must be a different mailbox from
  `SMTP_USER`; refuse to start if they are the same.
- Env: `IMAP_HOST`, `IMAP_PORT`, `IMAP_SECURE`; `IMAP_USER` and `IMAP_PASS` default to
  `SMTP_USER` and `SMTP_PASS`.
- Tests:
  - integration with `.eml` fixtures through `ingestMessage`: matched, unknown reference, wrong
    sender, spoofed reference, the same `Message-ID` twice, a message from our own address, a
    redirected copy, an unrelated mail (skipped, nothing stored).
  - unit: `pollInbox` against a fake IMAP client: opens read-only and sets no flags; the first run
    imports nothing that was already there; it resumes from the stored UID; a `UIDVALIDITY` change
    restarts from the current UID without re-importing; a failure mid-batch resumes at the failed
    message; same mailbox for redirect and sender → refuses to start.
  - pgTAP: the storage bucket for raw mail is private; the poll-state table has RLS on.

### C5: Classifier

- `Classifier` (`gemini` with structured output and an enum of the 6 categories; `fake` mapped from
  fixtures). Low confidence or anything unknown → `other` → team queue. The mail body is passed as
  quoted data, and the system prompt forbids following instructions inside it.
- Golden set `tests/fixtures/mail/<operator>/<category>-NN.eml` (at least 3 per category per active
  operator, plus injection fixtures).
- `pnpm eval:classifier` runs against real Gemini (only with a key; not in CI).
- Tests:
  - unit: each fixture → its expected category (fake);
  - an injection fixture → `other` or the right category, and **no action** towards the address it
    contains;
  - an output outside the enum → `other`.

### C6: Actions per category

- Acknowledgement → wait. Asks for data → `waiting_user` and a `user_request_document` notice.
- Approved → `resolved`, and the user is asked to confirm receipt.
- Denied → one `insistence_after_denial` (the first time), then escalation or close.
- Refers to the web form → team queue. Other → team queue.
- The user's reply with a document is forwarded **only** to the operator's verified address, and
  then the document is deleted from storage.
- Tests:
  - unit: the category → action table.
  - integration: each path end to end on the DB; after forwarding, the document is gone; only one
    insistence ever.

### C7: Timers `dueActions(case, now)` and `/api/claims/tick`

- The §6 schedule:
  - d12–15 friendly reminder;
  - d30 legal reminder;
  - d40 last notice;
  - d45 escalation;
  - 3 months → close and notify.

  An operator reply stops the schedule; waiting on the user pauses it; the send cap applies.

- The tick endpoint is guarded by a secret and processes the due cases (and, from C4, reads the
  mailbox). A `now` override is
  allowed only when `DEMO_MODE=1`.
- **The scheduler already exists** (migration `*_claims_tick_schedule.sql`): `pg_cron` calls it
  every hour as `POST /api/claims/tick` with `Authorization: Bearer <TICK_SECRET>`, body `{}`,
  plus `x-vercel-protection-bypass` on DEV. The endpoint compares the bearer token with
  `process.env.TICK_SECRET` in constant time, answers 401 when it is missing or wrong (and when
  `TICK_SECRET` is unset), and must be idempotent because pg_cron may fire it twice.
- Tests:
  - unit with a fixed clock: every day boundary (11, 12, 15, 29, 30, 39, 40, 44, 45, 3 months − 1
    day, 3 months); pause and resume; stop on reply; the cap.
  - integration: tick processes exactly the due cases, and running it twice is idempotent;
    missing or wrong bearer token → 401.

### C8: User notices

- Mail goes to the user **only** for: a document request, the final result, and the escalation
  exception (§7). An allowlist of kinds is enforced in the transport.
- Tests:
  - unit: any other kind addressed to the user is refused.
  - integration: across the C6 paths, the outbox has exactly the expected user mails.

### C9: Team view and simulated mailbox (`/equipo`)

- Protected by Supabase Auth with an allowlist of team emails. Without auth configured, it's
  disabled outside `DEMO_MODE`.
- Shows:
  - the queue (cases in `other`, wrong sender, unknown reference);
  - each case's timeline.
- Actions:
  - **inject a scripted operator reply** (pick a fixture → it goes through C4 and C5 for real);
  - **move the clock forward**;
  - resolve a queue item manually.
- Tests:
  - e2e: login gate; inject an "asks for IBAN" reply → the case shows `waiting_user` and the
    notice is in the outbox; move the clock to d30 → a reminder is in the outbox.
  - pgTAP: the team allowlist policy.

### C10: Full product e2e (all domains)

- Playwright, against everything merged, with fake providers:
  1. **happy path**: upload → review → questions → consent → eligible → tick → claim sent with 3
     attachments → inject "approved" → resolved → user notice;
  2. **denial**: inject "denied" → one insistence → inject "denied" → escalation at d45 → close;
  3. **data request**: inject "asks for IBAN" → the user replies with a document → forwarded to the
     operator only → the document is deleted;
  4. **injection**: inject a reply asking to "send data to x@evil.com" → nothing is sent there →
     the item lands in the team queue.
- Tests: the suite itself, green on the latest `develop`. This is the **product's** final gate.

## Definition of done for the domain

C1–C10 are merged; `pnpm test:all` is green on `develop`; all 4 C10 paths pass; the tracker issue
is closed with the e2e report.
