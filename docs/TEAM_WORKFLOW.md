# Team workflow: three people, many agents

Three developers work on `develop` at the same time, each with several AI agents (Claude Code,
Codex). This page covers how the work is split so that we rarely touch the same files, and how we
keep in sync so the conflicts that do happen stay small. Product and domain details:
[ARCHITECTURE.md](ARCHITECTURE.md). Rules, access and protected areas: [ONBOARDING.md](ONBOARDING.md)
and `CLAUDE.md`/`AGENTS.md`; they always win over this page.

## 1. The split: three domains, one owner each

We split by **domain** (a slice that goes from screen to database), not by layer. A layer split
(frontend / backend / DB) means every feature touches all three people.

| Domain               | Owner                   | Architecture sections                                    | Owns (folders)                                                                                                | Owns (data)                                     |
| -------------------- | ----------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **A. Intake**        | `@complaix-eu` (Nestor) | §1 user form, §2 ticket reading, consent evidence        | `app/(intake)/`, `features/intake/`, `app/layout.tsx`, `app/globals.css`, `shared/ui/`, `tests/unit/intake/`  | ticket storage bucket, `consents` table         |
| **B. Rules & docs**  | `@micah-earl`           | §3 operator config + eligibility, §4 documents, PDF map  | `features/rules/`, `features/documents/`, `templates/`, `tests/unit/rules/`, `tests/unit/documents/`          | none: pure functions, no DB, no network         |
| **C. Claims engine** | `@vinimp2003`           | §5 email loop, §6 timers and escalation, §7 user notices | `features/claims/`, `app/api/claims/`, `app/(team)/` (review queue), `shared/supabase/`, `tests/unit/claims/` | `cases`, `case_events`, `messages`, attachments |
| Shared (everyone)    | all three               | contracts between domains                                | `shared/contracts/`                                                                                           | -                                               |

Owners and harnesses: **A → `@complaix-eu`** (Claude Code). **B → `@micah-earl`** (Codex: the
domain is deterministic, fully specified and test-driven). **C → `@vinimp2003`** (Claude Code
with Codex reviewing every PR: the most cross-cutting domain, with the AI-containment rules of
§5). Agents @mention these handles on their tracker issue when they stop. Only GitHub handles
go here, never emails: the repo is public.

### How the domains talk to each other

```
A. Intake ──createCase(submission)──▶ C. Claims engine ──evaluateEligibility / buildEuForm /
                                                          buildMandate / renderTemplate──▶ B. Rules & docs
```

- Dependencies only go **A → C → B**. B depends on nothing, C never imports A, and nobody imports
  back towards A.
- A domain is used **only through its public entry point** `features/<domain>/index.ts`. Never
  import another domain's internal files.
- Every public function has a **mock** next to it (`features/<domain>/mock.ts`). Until the real
  thing is merged, the other domains build against the mock, so nobody waits for anybody.

### Parallel lanes inside each domain (one agent per lane)

| Domain | Lane 1                                                     | Lane 2                                                                                    | Lane 3                                                                       |
| ------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A      | Upload + OCR (Vision) + extraction (Gemini), server side   | Review screen + minimal questions (UI)                                                    | Mandate/GDPR acceptance + `consents` evidence (time, text version, IP, trip) |
| B      | Operator configs (Iryo, Renfe, Ouigo) + eligibility engine | EU form filler: 47-field map, per-checkbox "on" value (`/Sê`, `/Yes`…), `NeedAppearances` | Mandate PDF + email template texts per operator                              |
| C      | `cases` schema, state machine, `createCase` API            | Mail adapter (simulated mailbox for the demo) + classifier into the closed categories     | Timers/escalation, user notifications, team review queue                     |

Two agents of the same person never work in the same lane at the same time. If two tasks need the
same file, run them one after the other.

## 2. Phase 0: contracts and skeleton (one short PR, before splitting)

Person C opens it, and the other two review the contracts **the same day**. Nobody starts their
domain's real code until it is merged (half a day at most). Contents:

- Folders `features/{intake,rules,documents,claims}/` with `index.ts` and `mock.ts` stubs, plus
  `shared/contracts/`, `shared/supabase/` and `shared/ui/`.
- `shared/contracts/` types, kept small:
  - `OperatorId`
  - `TicketData` (every field optional: "the AI fills nothing the user didn't give")
  - `UserAnswers`
  - `IntakeSubmission`
  - `EligibilityInput` / `EligibilityResult` (`eligible | not_eligible | doubtful` + reason + tier)
  - `CaseStatus` (the 9 states in §5)
  - `ReplyCategory` (the 6 closed categories in §5)
  - `EuFormData`
- An ESLint `no-restricted-imports` rule that forbids importing another domain's internals (only
  `@/features/<domain>` is allowed). That turns the boundary rule into a CI failure instead of a
  promise.
- The decisions from section 6 that need Nestor, at least raised with him.

## 3. Several agents per person: one worktree per agent

Each agent gets **its own git worktree on its own branch**. Never run two agents in the same folder
or on the same branch.

```bash
git fetch origin
git worktree add ../retren-<lane> -b feat/<domain>-<task> origin/develop
cd ../retren-<lane> && pnpm install          # fast: pnpm's store is shared
APP_PORT=3101 pnpm dev -p 3101               # a different port per worktree (3101, 3102, …)
# when its PR is merged:
cd - && git worktree remove ../retren-<lane>
```

Branch names: `feat/intake-review-screen`, `feat/rules-iryo`, `fix/claims-timer-pause`… (domain
first, so everyone can see who owns what).

### ⚠️ One local Supabase per machine

All worktrees share **one** local Supabase (`project_id = "retren"`), and both the test gate and
`pnpm ci:local:full` stop and restart it. Two agents doing that at once kill each other's database,
so there is one machine-wide lock, `${TMPDIR:-/tmp}/retren-supabase.lock` (a directory holding
the owner's PID).

- **`pnpm test:all` takes the lock itself.** It waits while someone else holds it and removes a
  stale lock whose PID is gone. Never wrap it in the snippet below: that would deadlock.
- **Everything else that uses local Supabase** (`pnpm ci:local:full`, `db:start`, `db:reset`, a dev
  server against the local DB) is wrapped in the same lock. Until it's built into
  `scripts/local-ci.sh` (#17), use:

```bash
lock="${TMPDIR:-/tmp}/retren-supabase.lock"
until mkdir "$lock" 2>/dev/null; do echo "local Supabase busy, waiting…"; sleep 30; done
echo $$ >"$lock/pid"
pnpm ci:local:full; rc=$?
rm -rf "$lock"; (exit $rc)
```

- Never delete a lock whose PID is still alive (`kill -0 "$(cat "$lock/pid")"` succeeds).
- While iterating, `pnpm test` (unit) and `pnpm ci:local` need no Docker and no lock.
- Domain B rarely needs the database at all.

## 4. Staying in sync: pull often so conflicts don't snowball

**Bring `develop` into your branch:**

1. At the start of every session and every new task.
2. Before every push.
3. Whenever a teammate's PR has merged.
4. At least **every 2 hours** while working.

```bash
git fetch origin
git merge origin/develop          # merge, never rebase: no force-push is ever needed
# if pnpm-lock.yaml changed:            pnpm install
# if supabase/migrations/ changed:      pnpm db:reset (under the lock), or just pnpm test:all
```

Conflicts: [ONBOARDING.md §7](ONBOARDING.md#7-conflicts). For `pnpm-lock.yaml`, take `develop`'s
version and run `pnpm install`. For anything in another person's domain, ask that person.

**Keep PRs small and short-lived:**

- One lane task per PR, ideally under ~400 changed lines.
- Open → merged within a day, two at most. Long-lived branches are what cause the big conflicts.
- Draft while working, `gh pr ready` once, then `gh pr merge` (no flags: the queue squash-merges and the branch is deleted automatically), which puts
  it in the **merge queue**. The queue re-runs the checks on top of the latest `develop` plus the
  PRs ahead of it, so two PRs that clash together are stopped before DEV.
- If Codex (or another agent) reviews your changes, do it before `gh pr ready`.

## 5. Shared hot spots: fixed rules

| File / area                                           | Rule                                                                                                                                                                                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/contracts/`                                   | Own small PR, mention the other two, merge fast. Additive changes only (new optional fields). Renaming or removing something needs both others to agree.                                                                                                    |
| `package.json`, `pnpm-lock.yaml`                      | Add a dependency in its own small PR (or as the very first commit of a lane) and say so in the team chat. Never hand-merge the lockfile.                                                                                                                    |
| `supabase/migrations/`                                | Name each file after its domain: `pnpm db:new claims_create_cases`. Change only your domain's tables, keep one migration in flight per domain, and use a fresh timestamp right before merging (CI's migration-order check enforces it). RLS on every table. |
| `shared/supabase/database.types.ts`                   | Generated, owned by C. Never hand-merge: regenerate with `pnpm exec supabase gen types typescript --local > shared/supabase/database.types.ts`.                                                                                                             |
| `app/layout.tsx`, `app/globals.css`, `shared/ui/`     | Owned by A. Others ask for changes, or open a tiny PR and mention A.                                                                                                                                                                                        |
| `.env.example`                                        | The domain that needs a new variable adds it, with a placeholder value only. Real values go in Vercel/GitHub, which is Nestor's (section 6).                                                                                                                |
| Protected areas (`.github/`, scripts, `CLAUDE.md`, …) | Nobody, without Nestor's prior approval. See ONBOARDING.md §5.                                                                                                                                                                                              |

## 6. Needs Nestor: ask early, don't block on it

These touch protected areas or cost money, so raise them during Phase 0:

- **API keys** for Google Cloud Vision and Gemini, and the **Retren mailbox** credentials, in the
  Vercel Preview env and GitHub. Until they exist, everything runs on mocks. CI never calls external
  APIs, and tests mock Vision, Gemini and mail.
- **The scheduler for the timers (§6).** Vercel Cron (`vercel.json`, protected) or Supabase
  `pg_cron`. Write the timers as a pure function `dueActions(case, now)` plus one trigger endpoint,
  so the scheduler can be decided late. For the demo, a "move the clock forward" action in the team
  view stands in for days passing.
- **An email provider for real sending.** For the demo, use the simulated mailbox with scripted
  operator replies (architecture "Pendiente").
- **A lock in `scripts/local-ci.sh`** so the manual lock in section 3 is no longer needed.

## 7. Prompt for every agent session

Paste this at the start of each agent (Claude Code or Codex), filling in the brackets:

> You work in ReTren (DEV-only). Follow CLAUDE.md / AGENTS.md, docs/TEAM_WORKFLOW.md and
> docs/ARCHITECTURE.md. Your domain is **[A Intake / B Rules & docs / C Claims engine]**, lane
> **[n]**. Edit only that domain's folders (TEAM_WORKFLOW §1). Use other domains only through
> `features/<domain>/index.ts` or their mocks. If you need a change in `shared/contracts/`,
> another domain, `package.json` or a protected area, stop and tell me. Work in your own worktree
> and branch. Run `git fetch origin && git merge origin/develop` when you start, before every push
> and at least every 2 hours. `pnpm test:all` takes the local-Supabase lock itself; wrap anything else that
> uses local Supabase. Run `pnpm ci:local:full` before pushing. Open PRs as drafts against
> `develop`, small and single-purpose.

## 8. Daily rhythm

A 10–15 minute check-in each day:

- What merged since yesterday.
- What each lane is doing next.
- Any change coming to `shared/contracts/`.
- Who has a migration in flight.
- Anything waiting on Nestor.

Update the owner names in section 1 when people change domains.

## 9. Autonomous execution

Each domain has a task-by-task plan with the tests every step must pass, and the kickoff prompts
that let each harness spawn its own subagents: [plans/README.md](plans/README.md). Before leaving
the agents running, every person does [plans/PREFLIGHT.md](plans/PREFLIGHT.md).
