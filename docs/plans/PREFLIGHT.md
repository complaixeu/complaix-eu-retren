# Preflight: before you leave your agents running for hours

Go through this top to bottom before starting your domain. The goal is that once you walk away,
nothing can stall for a silly reason: a sleeping laptop, Docker down, a permission prompt nobody
answers, an expired login, a full disk. `pnpm preflight <A|B|C> --gate` checks most of it
automatically and must end with **READY**.

## 0. Once for the whole team (before anyone starts)

- [ ] Phase 0 (`[P0]`) is merged on `develop`.
- [ ] [TEAM_WORKFLOW.md §1](../TEAM_WORKFLOW.md) has each owner's **name and GitHub handle** for
      A, B and C (one small PR). Agents @mention you there when they stop, so you get a
      notification on your phone.
- [ ] Everyone has GitHub notifications on (GitHub mobile app or email) for this repo.
- [ ] The items waiting on Nestor (#17) don't block the start: everything runs on fakes until they
      exist.

## 1. Every person, on their own machine

- [ ] [ONBOARDING.md](../ONBOARDING.md) done (Mac: [ONBOARDING_MAC.md](../ONBOARDING_MAC.md)), and
      `pnpm ci:local:full` was green at least once.
- [ ] `git checkout develop && git pull && pnpm install`.
- [ ] `pnpm exec playwright install chromium` (once).
- [ ] Mac: `colima start` (6 GiB or more: `colima start --memory 6`), plugged in, lid open (or
      closed with power and an external display).
- [ ] At least 15 GiB of free disk: each worktree has its own `node_modules` and `.next`.
- [ ] **`pnpm preflight <your domain> --gate` says READY.** Fix every ✗ and run it again.
- [ ] Check your plan's usage limits (Claude / ChatGPT): a long run can hit them, and the agents
      then pause until the limit resets.

## 2. What each person also needs

### A: Intake (Claude Code)

- [ ] **A's owner is the repo admin.** The agents must **not** run with the admin login: give them
      the narrow fine-grained token from [ONBOARDING.md §6](../ONBOARDING.md) (Contents, Pull
      requests, Issues read/write, Actions read; no Administration, Secrets, Environments or
      Workflows), e.g. `GH_TOKEN=<that token> caffeinate -dimsu claude …`. Check it with
      the preflight, which fails if the token can read branch protection (that needs admin, and the
      check is read-only).

- [ ] Claude Code is logged in, and Remote Control works (`/remote-control`) so you can follow the
      run from your phone.
- [ ] Permissions for an unattended run: see section 3.

### B: Rules & docs (Codex)

- [ ] `~/.codex/config.toml` keeps the sandbox but allows network (pnpm and gh need it):

  ```toml
  approval_policy = "on-request"
  sandbox_mode    = "workspace-write"

  [sandbox_workspace_write]
  network_access = true
  ```

- [ ] `codex exec --help` lists `--approve-for-me` (it routes approvals to automatic review, so no
      prompt waits for you). Never use `--dangerously-bypass-approvals-and-sandbox`.
- [ ] Codex is logged in (`codex login status` or a short `codex exec "echo ok"` run).

### C: Claims engine (Claude Code + Codex review)

- [ ] Everything in A's list.
- [ ] The Codex plugin is ready inside Claude Code (`/codex:setup` reports OK), because every C PR
      is reviewed by Codex before it's marked ready.

## 3. Claude Code permissions for an unattended run

A permission prompt that nobody answers stalls the run for hours. On **your own machine, in this
repo only**, start Claude Code with permission prompts off:

```bash
caffeinate -dimsu claude --permission-mode bypassPermissions
```

The committed deny rules in `.claude/settings.json` are meant to keep blocking secrets, Vercel and
remote Supabase commands, admin merges and pushes to `develop`/`main`. **Check that before you
leave:**

- [ ] In the session, ask it to run `gh secret list`. It must be **refused** by a deny rule. If it
      runs, quit, and start instead with `--permission-mode acceptEdits` plus allow rules for
      `pnpm`, `git`, `gh pr` and `gh issue` in your **own** `~/.claude/settings.json` (never by
      editing `.claude/settings*.json` in the repo).

## 4. Start: one command

```bash
cd ~/path/to/complaix-eu-retren
pnpm empezar
```

That's all. `pnpm empezar`:

1. Works out your domain from your GitHub login: `complaix-eu` → A, `micah-earl` → B,
   `vinimp2003` → C. `pnpm empezar <A|B|C>` forces one.
2. Refuses to start if you have uncommitted changes. Otherwise it switches to `develop` and pulls.
3. Runs `pnpm preflight <domain> --gate`, and stops if it isn't READY.
4. Starts your harness inside `caffeinate`:
   - **A / C:** Claude Code with your domain's kickoff prompt already filled in. C's prompt adds the
     Codex review step.
   - **B:** `scripts/agents/run-codex-lanes.sh` (tracker issue, three Codex lanes).

`DRY_RUN=1 pnpm empezar` shows what it would start, without starting anything. On Claude Code,
type `/remote-control` once the session is up if you want to follow it from your phone.

A's owner (the repo admin) runs it with the narrow token: `GH_TOKEN=<token> pnpm empezar`. The
preflight refuses a token that can administer the repo.

Within a few minutes your **tracker issue** (`Tracker: <domain>`) appears on GitHub with one box per
task. If it doesn't, the run hasn't really started: look at the terminal before you leave.

## 5. While you're away

- **Progress:** your tracker issue. Boxes get ticked as PRs merge.
  `gh pr list --author @me --state all` shows the PRs.
- **When an agent stops** (plans/README.md §6), it comments on the tracker issue **@mentioning you**
  with the reason and what it needs, then carries on with any other task that isn't blocked.
- **From your phone:** Remote Control (Claude Code), or the GitHub app for the tracker issue and
  PRs.
- Don't push to your domain's branches by hand while the agents run. If you must change something,
  tell the orchestrator in the session.

## 6. When you're back

- [ ] Read the tracker issue: what merged, and what is waiting on you (@mentions).
- [ ] `git worktree list`: remove the worktrees of merged tasks
      (`git worktree remove ../retren-<lane>`). `git worktree prune` cleans up the rest.
- [ ] `pnpm db:stop`, `colima stop` and quit `caffeinate` if you're done for the day.

## 7. What can go wrong unattended, and what covers it

| Risk                                      | Covered by                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| The laptop sleeps                         | `caffeinate -dimsu`, AC power, lid open; preflight checks AC and caffeinate                    |
| A permission prompt waits forever         | Section 3 (Claude Code), `--approve-for-me` (Codex)                                            |
| Two agents kill each other's local DB     | `pnpm test:all` takes the machine-wide lock and recovers a stale one                           |
| Branches drift and conflicts snowball     | `git merge origin/develop` before every push and every 2 h (TEAM_WORKFLOW §4); the merge queue |
| A PR passes alone but breaks with another | Merge queue re-checks on the latest `develop` plus the PRs ahead of it                         |
| A task "looks done" without being tested  | Test-first gate, `pnpm test:all` before every push, CI on the PR and in the queue              |
| An agent touches another domain or CI     | ESLint boundaries (CI fails), CODEOWNERS, stop rules, deny rules                               |
| A real email reaches an operator          | Fakes by default, `MAIL_REDIRECT_ALL_TO` in DEV, operator allowlist (plans/README.md §4)       |
| Usage limits                              | The agents pause and resume; check your limits before starting                                 |
| Disk or memory fills up                   | Preflight checks 15 GiB free and Colima ≥ 6 GiB; remove merged worktrees                       |
