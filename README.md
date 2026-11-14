# ReTren

Infrastructure foundation: Next.js 16 + Supabase + Vercel, DEV environment only.

- Workflow, branching and rules: [CLAUDE.md](CLAUDE.md)
- Run all CI/CD locally: [docs/LOCAL_CI.md](docs/LOCAL_CI.md)
- New here (people and AI agents): [docs/ONBOARDING.md](docs/ONBOARDING.md). CI/CD and infrastructure changes need approval from Nestor Gomez Artiles.
- Product architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). How the three of us split
  the work and stay in sync: [docs/TEAM_WORKFLOW.md](docs/TEAM_WORKFLOW.md).
- On a Mac: also [docs/ONBOARDING_MAC.md](docs/ONBOARDING_MAC.md) (Homebrew bash, Node 22, Colima instead of Docker Desktop).
- CI/CD: [.github/workflows/ci.yml](.github/workflows/ci.yml) — PRs run lint/typecheck/test/build;
  a push to `develop` migrates Supabase DEV and deploys Vercel DEV (Preview target).

```bash
nvm use && pnpm install && pnpm dev
pnpm ci:local:full   # whole CI/CD locally (local Supabase + localhost), see docs/LOCAL_CI.md
```

## Attribution

`templates/formulario_ue_es.pdf` is the official Spanish reimbursement and compensation request
form (Commission Implementing Regulation (EU) 2024/949), published by the European Commission.
© European Union. Reused under the Commission's reuse policy (Decision 2011/833/EU), which requires
acknowledging the source. The file is kept unmodified; the app fills a copy at runtime.
