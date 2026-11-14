# Onboarding: humans and their AI agents

ReTren is **DEV-only**: one Supabase DEV project, Vercel Preview deployments, `develop` as the
only working branch. There is no production. Owner and sole approver for CI/CD and
infrastructure: **Nestor Gomez Artiles** (GitHub `@complaix-eu`).

## 1. Who has what

| Role                         | Who                   | Can                                                                                                  |
| ---------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| Admin                        | Nestor Gomez Artiles  | Repo settings, branch protection, secrets, environments, Vercel, Supabase, approving protected areas |
| Developer (GitHub **Write**) | Team `retren` members | Branches, PRs into `develop`, reviewing each other's PRs, merging once approved + green, CI logs     |
| Outside contributor          | Anyone (public repo)  | Fork + PR; their CI runs only after a maintainer approves it, never with secrets                     |

Developers **do not** get, and never need: Vercel access, Supabase DB password or tokens, GitHub
secrets, admin rights. CI migrates and deploys DEV for everyone when a PR is merged into `develop`.

## 2. Getting access

1. Ask Nestor to add your GitHub username to the `complaixeu` org team **`retren`** (Write on this repo).
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
gh pr merge --squash --delete-branch           # when approved + check green → DEV deploys
```

Every PR into `develop` needs **one approving review** from another person and a green
`Lint, typecheck, test, build` check. PRs touching protected areas (section 5) need the approval
of **Nestor Gomez Artiles** specifically; GitHub requests it automatically. A new push dismisses
earlier approvals. Agents never approve PRs.

Never push to `develop` or `main` directly (both are protected). `main` is frozen for now.

## 5. Protected areas: Nestor's approval required

Nobody, human or agent, changes CI/CD or infrastructure without **prior approval from Nestor Gomez
Artiles**. GitHub enforces this: a PR touching any path in [`.github/CODEOWNERS`](../.github/CODEOWNERS)
cannot merge without his review.

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
2. **Claude Code is also hard-limited** by `.claude/settings.json` (committed): it must ask before
   editing protected files and is blocked from secrets, Vercel/Supabase remote commands, admin
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

Paste this into your agent once when you start:

> You work in ReTren (DEV-only). Follow CLAUDE.md / AGENTS.md. Never change CI/CD or
> infrastructure (the protected areas in docs/ONBOARDING.md §5) under any circumstances without
> explicit approval from Nestor Gomez Artiles. If a task needs such a change, stop and tell me
> what you would change and why. Never touch secrets, Vercel, Supabase remote, `main`, or
> production. Run `pnpm ci:local:full` before every push and open PRs as drafts against `develop`.
