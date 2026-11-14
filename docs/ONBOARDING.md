# Onboarding: humans and their AI agents

ReTren is **DEV-only**: one Supabase DEV project, Vercel Preview deployments, `develop` as the
only working branch. There is no production. Owner and sole approver for CI/CD and
infrastructure: **Nestor Gomez Artiles** (GitHub `@complaix-eu`).

## 1. Who has what

| Role                         | Who                   | Can                                                                                                  |
| ---------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| Admin                        | Nestor Gomez Artiles  | Repo settings, branch protection, secrets, environments, Vercel, Supabase, approving protected areas |
| Developer (GitHub **Write**) | Outside collaborators | Branches, PRs into `develop`, merging into `develop` once checks are green, reading CI logs          |
| Outside contributor          | Anyone (public repo)  | Fork + PR; their CI runs only after a maintainer approves it, never with secrets                     |

Developers **do not** get, and never need: Vercel access, Supabase DB password or tokens, GitHub
secrets, admin rights. CI migrates and deploys DEV for everyone when a PR is merged into `develop`.

## 2. Getting access

1. Ask Nestor to add your GitHub username as an **outside collaborator** with **Write** on this repo
   (repo Settings → Collaborators and teams → Add people). Not as an org member or team: on the
   org's paid GitHub Team plan that would cost a seat, while outside collaborators on a public repo are free.
2. Optional, read-only DB dashboard: ask Nestor for an invite to the Supabase org **Retren** as
   Developer/Read-only.
3. The DEV site is behind Vercel Authentication; work against localhost (section 4).

## 3. Day one

```bash
git clone git@github.com:complaixeu/complaix-eu-retren.git && cd complaix-eu-retren
nvm install && nvm use                              # Node 22 (.nvmrc)
npm install -g corepack@latest && corepack enable   # pnpm 12
sudo usermod -aG docker "$USER"                     # Docker without sudo; log in again
pnpm install
pnpm ci:local:full                                  # must end with "All green"
gh auth login                                       # your own account (see section 6)
```

Details and troubleshooting: [LOCAL_CI.md](LOCAL_CI.md).

## 4. Daily workflow

```bash
git checkout develop && git pull
git checkout -b feat/short-name                # feat/, fix/, chore/, docs/, test/
# code; dev against local Supabase: pnpm db:start && pnpm db:env && pnpm dev -p 3100
pnpm ci:local:full                             # green before every push
git push -u origin feat/short-name
gh pr create --draft --base develop            # drafts run no CI
gh pr ready                                    # once, when finished
gh pr merge --squash --delete-branch           # when the check is green → DEV deploys
```

Never push to `develop` or `main` directly (both are protected). `main` is frozen for now.

## 5. Protected areas: Nestor's approval required

Nobody, human or agent, changes CI/CD or infrastructure without **prior approval from Nestor Gomez
Artiles**, given **before** the change is made. Reviews are not required to merge, so this is a
rule everyone follows rather than a GitHub block: a PR touching any path in
[`.github/CODEOWNERS`](../.github/CODEOWNERS) automatically requests his review so he sees it.

Protected:

- In the repo: `.github/` (workflows, CODEOWNERS, Dependabot, PR template), `vercel.json`,
  `supabase/config.toml`, `pnpm-workspace.yaml`, `scripts/local-ci.sh`, `scripts/local-env.sh`,
  `CLAUDE.md`, `AGENTS.md`, `.claude/`, `docs/LOCAL_CI.md`, this file.
- Outside the repo: GitHub settings, branch protection, environments and secrets; the Vercel
  project (settings, env vars, domains, protection, deployments); the Supabase project and org
  (settings, keys, billing, add-ons); anything that creates cost or a production deployment.

To propose a change: open an issue or a draft PR describing it, tag Nestor, and wait for his
explicit "approved". Normal app code, tests and new migrations are **not** protected; they follow
the daily workflow.

## 6. Onboarding your AI agent (Claude Code, Codex, Cursor, …)

1. **Its rules come from the repo.** Claude Code reads `CLAUDE.md`; Codex/Cursor and others read
   `AGENTS.md`. Both say: no CI/CD or infrastructure changes without Nestor's approval. Don't
   override or remove them in your local agent config.
2. **Claude Code is also hard-limited** by `.claude/settings.json` (committed): it is blocked
   from secrets, Vercel/Supabase remote commands, admin
   merges and pushes to `main`/`develop`. Do not add `allow` rules that undo this in
   `.claude/settings.local.json`.
3. **Give it your own, narrow GitHub login**, never a shared token. A fine-grained PAT with
   resource owner `complaixeu`, only repository `complaix-eu-retren`, and permissions:
   Contents read/write, Pull requests read/write, Actions read, Metadata read.
   No Administration, Secrets, Environments or Workflows permission.
4. **Never give it** Vercel tokens, Supabase tokens or passwords, or production credentials of
   any project.
5. **Reading CI** (all it needs):

   ```bash
   gh pr checks <pr>
   gh run list --branch develop
   gh run view <run-id> --log-failed
   ```

### Codex users

Codex has no committed permission file like `.claude/settings.json`, so its limits come from
`AGENTS.md`, branch protection and your narrow token. Set it
up like this:

- **Codex CLI / IDE:** it reads `AGENTS.md` automatically from the repo root. Keep it in a
  sandbox that asks before risky commands, in your own `~/.codex/config.toml`:

  ```toml
  approval_policy = "on-request"     # asks before commands outside the sandbox
  sandbox_mode    = "workspace-write" # may edit only this repo; no network unless you approve
  ```

  Never run it with `--dangerously-bypass-approvals-and-sandbox` (or "full access"/YOLO
  modes) in this repo.

- **Codex cloud (chatgpt.com/codex):** connecting it to GitHub installs the ChatGPT Codex
  Connector app on the `complaixeu` org. Only Nestor can approve that. If approved, it is
  limited to this repository. Give its environment **no secrets**: the setup script is just
  `pnpm install`, and it can run `pnpm ci:local` (no Docker there, so no `--full`). Its PRs go
  into `develop` like any other; it never merges them itself.

- Codex follows the same rule: if a task needs a protected change (§5), it must stop and say so.

Paste this into your agent once when you start:

> You work in ReTren (DEV-only). Follow CLAUDE.md / AGENTS.md. Never change CI/CD or
> infrastructure (the protected areas in docs/ONBOARDING.md §5) under any circumstances without
> explicit approval from Nestor Gomez Artiles. If a task needs such a change, stop and tell me
> what you would change and why. Never touch secrets, Vercel, Supabase remote, `main`, or
> production. Run `pnpm ci:local:full` before every push and open PRs as drafts against `develop`.

## 7. Conflicts

Several people and agents work on `develop` in parallel, so conflicts will happen. They are
normal and safe: nothing reaches DEV until a PR is merged, and a conflicted PR cannot be merged.

**Git conflicts (GitHub says "This branch has conflicts").** Update your branch by _merging_
`develop` into it, not rebasing, so no force-push is ever needed:

```bash
git fetch origin
git checkout feat/short-name
git merge origin/develop          # resolve the files Git lists, then:
git add <files> && git commit     # completes the merge
pnpm ci:local:full                # must be green again
git push                          # CI runs again; merge once it's green
```

The PR is squash-merged, so the merge commit doesn't show up in `develop`'s history.

| What conflicts                          | What to do                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| App code / tests                        | Resolve normally. If it isn't obvious whose version wins, ask the other PR's author.                                                        |
| `pnpm-lock.yaml`                        | Don't hand-edit it. Take `develop`'s version (`git checkout --theirs pnpm-lock.yaml`), run `pnpm install`, commit the regenerated lockfile. |
| `package.json`                          | Keep both sides' dependency changes, then regenerate the lockfile as above.                                                                 |
| **Migrations** (`supabase/migrations/`) | Two PRs can add migrations without a Git conflict and still clash. Rules below.                                                             |
| Protected files (§5)                    | Stop. Resolve together with Nestor before merging.                                                                                          |

**Migrations, the one that needs care.** DEV applies migrations in timestamp order and refuses a
migration older than the last one it already applied (`supabase db push`: "Found local migration
files to be inserted before the last migration on remote database"). So:

1. Before merging, check that your migration's timestamp is **newer than every migration on
   `develop`**. If someone merged a newer one first, rename yours:
   `git mv supabase/migrations/<old-ts>_name.sql supabase/migrations/$(date -u +%Y%m%d%H%M%S)_name.sql`.
2. Run `pnpm ci:local:full`: it rebuilds an empty database from **all** migrations, so two
   migrations that clash (same table, same column) fail here, not on DEV.
3. Never edit a migration that is already on `develop`. Fix forward with a new migration.
4. If `Apply DB migrations (dev)` fails after a merge, don't touch the DEV database by hand.
   Open a fix-forward PR and tell Nestor.

**Deploys never conflict.** Merges into `develop` deploy one at a time in merge order (the
`deploy-dev` concurrency group), and the last merge is what DEV runs.

**Agents** may resolve conflicts in app code, tests and the lockfile with the steps above. They
stop and ask for protected files, for migrations already on `develop`, and whenever both sides
changed the same logic.

## 8. Viewing a server that runs on a remote machine (the VPS)

Apps and local Supabase listen on `127.0.0.1` only. To open one from your laptop, forward the port
over SSH. Never publish it on `0.0.0.0`.

```bash
# on your laptop (macOS/Linux), keep it open:
ssh -N -L 3100:127.0.0.1:3100 <user>@<vps-ip>
# then browse http://localhost:3100
```
