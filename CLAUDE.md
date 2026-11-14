# ReTren — working rules (humans and AI agents)

Also read `AGENTS.md` (Next.js 16 notes). Stack: Next.js 16 (App Router), TypeScript,
pnpm, Node 22, Vitest, Supabase (Postgres + Auth), Vercel.

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
- AI agents may merge their own PR into `develop` only when every required check is green.
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
