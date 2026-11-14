# Plan B: Rules & documents (pure functions, no DB, no network)

Owner: `@micah-earl` · Harness: Codex · Architecture: §3 (configs, rules), §4 (documents), "Mapeo del
formulario"
Folders: `features/rules/`, `features/documents/`, `templates/`, `tests/unit/{rules,documents}/`,
`tests/fixtures/{rules,documents}/`.
Uses nothing from other domains. Everything is a pure function, so the tests here are unit tests,
and they must be exhaustive.

## Lanes

| Lane | Tasks        | Theme                            |
| ---- | ------------ | -------------------------------- |
| 1    | B1 → B2 → B3 | Operator configs and eligibility |
| 2    | B4           | EU form filler                   |
| 3    | B5 → B6 → B7 | Mandate, email templates, API    |

## Tasks

### B1: Operator config schema and versioning

- zod schema `OperatorConfig`:
  - `id`, `version`, `validFrom`, `sourceUrls[]`, `consultedAt`;
  - `channel` (`email | web_form | postal`, address) and `active` (false while the channel is
    unconfirmed);
  - `responseDays`, `minWait`, `deadline`, `tiers[]`, `exclusions`, `payment`, `templates`.
- `getOperatorConfig(id, onDate)` returns the version valid on that date.
- Tests:
  - unit: the schema rejects incomplete configs; the version is picked by date (before, exactly on
    and after `validFrom`).

### B2: Configs for Iryo, Renfe and Ouigo

- Values exactly as in the ARCHITECTURE §3 table, with `consultedAt: 2026-11-13` and the source
  URLs. Only Iryo is `active: true`; Renfe and Ouigo are `active: false` (demo: simulated).
- Tests:
  - unit: each config passes the schema;
  - a snapshot of the key values against the table (a change has to be deliberate);
  - inactive operators are flagged.

### B3: Eligibility engine `evaluateEligibility(input) → EligibilityResult`

- Output: `status` (`eligible | not_eligible | doubtful`), `reason`, `tier` (percentage, payment
  form), `earliestSendAt`, `deadline`, `appliedRules[]`.
- Tests: unit, table-driven, every row named. All must pass:
  - **Iryo**:
    - 59 min → not eligible;
    - 60 exactly → doubtful (it is still sent);
    - 61 → 50%;
    - 90 → 50%;
    - 91 → 100%;
    - voucher first, money only if asked;
    - intermediary or Casa Iryo → voucher only.
  - **Renfe**:
    - 59 → not eligible;
    - 60 → 50%;
    - 90 → 50%;
    - 91 → 100%;
    - Adif limit: bought on or after 2026-01-31 → not eligible; before → eligible; purchase date
      unknown → the rule isn't applied.
  - **Ouigo**:
    - 29 → not eligible;
    - 30–59 → 50% non-refundable voucher;
    - 60–89 → 50% refundable voucher;
    - ≥ 90 → 100% refundable voucher.
  - **Minimum wait**:
    - Iryo: 48 h after the trip;
    - Renfe: 24 h after arrival;
    - Ouigo: 7 days.

    Before it, the case is eligible with an `earliestSendAt` in the future.

  - **Deadline**: 3 months from the trip. One day after → not eligible.
  - **Force majeure**: still sent, with a reason noting "decide la empresa".
  - **Arrival before scheduled time**, or a negative delay → not eligible.
  - **Timezones**: Europe/Madrid, including a trip across the DST change.
  - Property test (fast-check): the tier never decreases as the delay grows.

### B4: EU form filler `buildEuForm(data: EuFormData) → Uint8Array`

- pdf-lib on `templates/formulario_ue_es.pdf`. The field names are taken from the mapping table
  (constants, never by position).
- Fill rules:
  - Only "Retraso" and "Indemnización" are checked.
  - The tier checkbox follows the delay: 60–119 or ≥ 120. Under 60, none.
  - GDPR "Sí" only if accepted.
  - Signature `Retren, en representación de <nombre>`.
  - Address, phone, IBAN, SWIFT, holder and extra info stay **blank** unless they are explicitly
    present in the data.
- Each checkbox's "on" value is read from its appearance dictionary (`/Sê` for GDPR yes, `/No`,
  `/Yes`), never assumed. `NeedAppearances` is set.
- Tests:
  - unit: fill, re-open with pdf-lib and assert every one of the 47 fields (value or blank);
  - checkbox states are exactly the "on" value read from the template;
  - the tier boundaries 59, 60, 119 and 120;
  - the template's SHA-256 is unchanged (it's never modified in place);
  - the output is a valid PDF that opens and has `NeedAppearances`;
  - fixtures contain only synthetic data, and no filled PDF is ever written to the repo.

### B5: Mandate PDF `buildMandate(data) → Uint8Array`

- Generated with pdf-lib, from a versioned text marked "borrador pendiente de revisión jurídica".
- Allowed: present the claim, insist, escalate. Forbidden: accept different conditions, collect
  money. Also: duration and revocation. It includes the case data, the date and the consent
  version.
- Tests:
  - unit: the extracted text contains every required clause and the case data;
  - missing data → throws;
  - the version is stamped.

### B6: Email templates `renderTemplate(kind, operatorId, vars) → { subject, text }`

- Kinds:
  - `initial_claim`;
  - `reminder_d12`, `reminder_d30`, `last_notice_d40`;
  - `escalation_d45`;
  - `insistence_after_denial`;
  - one reply per `ReplyCategory`;
  - user notices: `user_request_document`, `user_final_result`.
- Rules:
  - The subject always contains `[RTN-<ref>]`.
  - The body is 3–4 lines in the operator's style and includes the document number.
  - The signature is "Retren, en representación de <nombre>".
  - Each reminder cites the previous send dates and the legal basis.
  - A missing variable throws (never renders "undefined").
- Tests:
  - unit: a snapshot per kind × operator;
  - a missing variable throws;
  - the subject reference is always present;
  - the reminders are all different from each other and cite the earlier dates;
  - nothing in a template suggests acting as a person.

### B7: Public API and mock parity

- `features/rules/index.ts` (`getOperatorConfig`, `evaluateEligibility`) and
  `features/documents/index.ts` (`buildEuForm`, `buildMandate`, `renderTemplate`), with `mock.ts`
  kept in sync.
- Tests:
  - unit: the mock-parity test (same exports and types);
  - the mock returns schema-valid outputs.

## Definition of done for the domain

B1–B7 are merged; `pnpm test:all` is green on `develop`; coverage of `features/rules` and
`features/documents` is ≥ 95% of lines; the tracker issue is closed.
