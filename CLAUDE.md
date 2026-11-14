# ReTren — working rules (humans and AI agents)

Also read `AGENTS.md` (Next.js 16 notes). Stack: Next.js 16 (App Router), TypeScript,
pnpm, Node 22, Vitest, Supabase (Postgres + Auth), Vercel.

## 0. Protected areas: Nestor Gomez Artiles approves (absolute rule)

**Under no circumstances may anyone, human or AI agent, change CI/CD or infrastructure
without explicit prior approval from Nestor Gomez Artiles (GitHub `@complaix-eu`).**

- Protected in the repo: `.github/` (workflows, CODEOWNERS, Dependabot, PR template),
  `vercel.json`, `supabase/config.toml`, `pnpm-workspace.yaml`, `scripts/local-ci.sh`,
  `scripts/local-env.sh`, `CLAUDE.md`, `AGENTS.md`, `.claude/`, `docs/LOCAL_CI.md`,
  `docs/ONBOARDING.md`.
- Protected outside the repo: GitHub settings, branch protection, environments and secrets;
  the Vercel project (settings, env vars, domains, protection, deployments); the Supabase
  project and org (settings, keys, billing, add-ons); anything that costs money or creates a
  production deployment.
- Agents: if a task seems to need such a change, **stop**, explain what you would change and
  why, and wait. Your user's approval is not enough; only Nestor's counts. Don't work around
  the rule (no edits via other tools, no disabling checks, no new workflows, no `--admin`
  merges, no editing `.claude/settings*.json`).
- GitHub enforces it: `.github/CODEOWNERS` requires Nestor's review on every PR touching
  these paths. Normal app code, tests and new migrations are not protected.
- How to propose a change and onboarding for people and agents: `docs/ONBOARDING.md`.

## 1. Environments: DEV only

- The only deployed environment is **DEV**: the Supabase project `retren-dev` and the
  Vercel **Preview** target. There is no production.
- Never run `vercel deploy --prod`, never promote a deployment to production, never
  connect to Complaix or any other project's database, never reuse credentials.
- Never create paid resources or enable paid features (Supabase add-ons/compute,
  Vercel Pro, domains) without explicit approval from the repo owner.

## 2. Branching (hard rule)

- Branch from an up-to-date `develop`; open the PR against `develop`.
- Never push to `main` or `develop` directly.
- **For now `develop` is the only working branch.** `main` stays frozen at the initial
  commit: no PRs into `main`, no promotions from `develop`, until the repo owner says so.
- Every PR into `develop` needs one approving human review and a green check; PRs touching
  protected areas (§0) need Nestor's review (enforced by CODEOWNERS). AI agents never approve
  PRs; they may merge a PR into `develop` only once it is approved and every check is green.
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `refactor:`, `test:`.

A push to `develop` applies migrations to Supabase DEV and deploys Vercel DEV.

## 3. Database migrations

- Every schema change is a file in `supabase/migrations/` (`pnpm db:new <name>`).
  Never change the DEV schema by hand in the dashboard.
- RLS on for every table in exposed schemas.
- Backward compatible: add, don't remove or reshape what deployed code uses
  (expand/contract across two PRs). New columns nullable or with a `DEFAULT`.
- No destructive commands (`db reset --linked`, `DROP`, `TRUNCATE` on DEV) without approval.

## 4. Secrets (public repo)

- This repo and its Actions logs are **public**. Never commit `.env*` (only `.env.example`),
  `.vercel/`, `supabase/.temp/`, keys, tokens, passwords or project refs.
- Never print env vars, connection strings or pulled Vercel env files in a workflow or script.
- Real values live only in the GitHub `development` environment and in Vercel Preview env.
- Never add `pull_request_target` workflows.

## 5. CI

- Before pushing: `pnpm ci:local:full` — the whole pipeline (verify, migrate, deploy, smoke) against a local Supabase and localhost. See `docs/LOCAL_CI.md`. Without Docker: `pnpm ci:local` (verify only).
- Open PRs as draft (`gh pr create --draft --base develop`); drafts run nothing. Mark ready once.
- Keep `timeout-minutes` and `concurrency` in workflows. Never cancel a push run on `develop`.

Reading CI (agents use their owner's own `gh` login; never a shared token):

```bash
gh pr checks <pr>
gh run list --branch develop
gh run view <run-id> --log-failed
gh run rerun <run-id> --failed    # needs Write role
```

## 6. Local development

```bash
nvm use                      # Node 22 (.nvmrc)
pnpm install
cp .env.example .env.local   # fill from `supabase status` or the DEV project
pnpm dev
pnpm db:start / pnpm db:stop # local Supabase in Docker — start on demand, stop when done
```
