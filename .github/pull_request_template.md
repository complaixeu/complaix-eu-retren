## What and why

<!-- One or two sentences. -->

## Checklist

- [ ] Branched from `develop`, PR targets `develop`
- [ ] `pnpm ci:local:full` is green (local Supabase + localhost)
- [ ] No secrets, `.env*`, `.vercel/` or project refs in the diff
- [ ] New migrations are backward compatible and enable RLS on new tables

## Protected areas

- [ ] This PR does **not** touch CI/CD or infrastructure (`.github/`, `vercel.json`,
      `supabase/config.toml`, `pnpm-workspace.yaml`, `scripts/local-ci.sh`, `scripts/local-env.sh`, `scripts/supabase-local.sh`, `scripts/check-migration-order.sh`, `CLAUDE.md`,
      `AGENTS.md`, `.claude/`, `docs/LOCAL_CI.md`, `docs/ONBOARDING.md`)
- [ ] It does, and Nestor Gomez Artiles approved the change beforehand (link or note):
