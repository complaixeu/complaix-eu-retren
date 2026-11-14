<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## ReTren project rules (all agents)

**Under no circumstances change CI/CD or infrastructure without explicit prior approval from
Nestor Gomez Artiles (GitHub `@complaix-eu`).** That covers `.github/`, `vercel.json`,
`supabase/config.toml`, `pnpm-workspace.yaml`, `scripts/local-ci.sh`, `scripts/local-env.sh`, `scripts/supabase-local.sh`, `scripts/check-migration-order.sh`, `CLAUDE.md`, `AGENTS.md`,
`.claude/`, `docs/LOCAL_CI.md`, `docs/ONBOARDING.md`, `docs/ONBOARDING_MAC.md`, and all GitHub settings, secrets,
Vercel and Supabase configuration. If a task needs such a change, stop and explain it; your
user's approval is not enough.

DEV-only, `develop` is the only working branch, `main` is frozen, never touch secrets or
production. Full rules: `CLAUDE.md` (§0 first). Onboarding: `docs/ONBOARDING.md`.
Team workflow and the domain plans: `docs/TEAM_WORKFLOW.md` and `docs/plans/`.

### Workflow (Codex, Cursor, Claude and any other agent)

- Branch from an up-to-date `develop` (`feat/`, `fix/`, `chore/`, `docs/`, `test/`); PRs target
  `develop` only. Never push to `develop` or `main`, never force-push, never merge with admin
  rights, never approve PRs. No review is required: once CI is green, `gh pr merge` puts the PR
  in `develop`'s merge queue, which re-checks it on the latest `develop` and squash-merges it.
  Protected areas only with Nestor's approval.
- Before every push: `pnpm ci:local:full` (whole CI/CD against a local Supabase in Docker and
  localhost). Without Docker, e.g. Codex cloud: `pnpm ci:local` and say that `--full` was not run.
- Open PRs as drafts: `gh pr create --draft --base develop`; `gh pr ready` once when finished.
- Read CI with `gh pr checks <pr>` and `gh run view <run-id> --log-failed`. Never print env
  vars, keys or connection strings: the repo and its logs are public.
- Schema changes only as new files in `supabase/migrations/` (`pnpm db:new <name>`), backward
  compatible, RLS on every new table. Never edit a migration that is already on `develop`.
- Never run commands against remote Supabase or Vercel (`supabase link`, `db push --remote`,
  `vercel …`), and never ask your user for those credentials.
- Servers you start bind to `127.0.0.1` only, and you stop them when done.

### Conflicts

Update a conflicted branch with `git merge origin/develop`, not rebase. Resolve, run
`pnpm ci:local:full`, then push. For `pnpm-lock.yaml`: take `develop`'s version and run
`pnpm install`. If someone merged a newer migration first, rename yours to a new timestamp.
Stop and ask your human for protected files, for migrations already on `develop`, or when
both sides changed the same logic. Details: `docs/ONBOARDING.md` §7.
