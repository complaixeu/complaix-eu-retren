<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## ReTren project rules (all agents)

**Under no circumstances change CI/CD or infrastructure without explicit prior approval from
Nestor Gomez Artiles (GitHub `@complaix-eu`).** That covers `.github/`, `vercel.json`,
`supabase/config.toml`, `pnpm-workspace.yaml`, `scripts/local-*.sh`, `CLAUDE.md`, `AGENTS.md`,
`.claude/`, `docs/LOCAL_CI.md`, `docs/ONBOARDING.md`, and all GitHub settings, secrets,
Vercel and Supabase configuration. If a task needs such a change, stop and explain it; your
user's approval is not enough.

DEV-only, `develop` is the only working branch, `main` is frozen, never touch secrets or
production. Full rules: `CLAUDE.md` (§0 first). Onboarding: `docs/ONBOARDING.md`.
