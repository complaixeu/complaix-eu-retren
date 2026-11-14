# ReTren

Infrastructure foundation: Next.js 16 + Supabase + Vercel, DEV environment only.

- Workflow, branching and rules: [CLAUDE.md](CLAUDE.md)
- Run all CI/CD locally: [docs/LOCAL_CI.md](docs/LOCAL_CI.md)
- CI/CD: [.github/workflows/ci.yml](.github/workflows/ci.yml) — PRs run lint/typecheck/test/build;
  a push to `develop` migrates Supabase DEV and deploys Vercel DEV (Preview target).

```bash
nvm use && pnpm install && pnpm dev
pnpm ci:local:full   # whole CI/CD locally (local Supabase + localhost), see docs/LOCAL_CI.md
```
