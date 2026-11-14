# Running the whole CI/CD locally

Every job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) can be rehearsed on your
machine against a **throwaway local Supabase (Docker)** and **localhost**, with no secrets and
nothing remote touched. Run it before every push; a branch should only reach GitHub once it is green here.

| CI job (GitHub)  | Local rehearsal (`scripts/local-ci.sh --full`)                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `verify`         | Same commands: install, lint, format check, typecheck, tests, build (placeholder env)                                                      |
| `security-audit` | `pnpm audit --prod --audit-level=high` (non-blocking)                                                                                      |
| `migrate_dev`    | `supabase start` builds an empty local DB from **every** migration, then the same `supabase db push` CI runs (local target instead of DEV) |
| `deploy_dev`     | Build with the local Supabase env, `next start` on `http://localhost:3100` instead of Vercel                                               |
| smoke check      | Same `/api/health` retry loop, plus Supabase REST reachable with the anon key                                                              |

The script runs in a clean environment (`env -i`) like a GitHub runner and temporarily parks your
`.env*.local` files, so local secrets can't change the result. Keys are never printed.

## Prerequisites (one-time)

1. **Node 22 and pnpm 12** — `nvm use` (reads `.nvmrc`), then enable pnpm:

   ```bash
   npm install -g corepack@latest && corepack enable   # or: npm i -g pnpm@12.3.4
   ```

   (Node 22.13's bundled corepack has an outdated signing key and fails with
   `Cannot find matching keyid`; updating corepack fixes it.)

2. **Docker usable without sudo** — only needed for `--full`:

   ```bash
   sudo usermod -aG docker "$USER"
   # log out and back in (or: newgrp docker), then check:
   docker info >/dev/null && echo "docker OK"
   ```

   Note: membership in the `docker` group is root-equivalent on that machine.

3. **jq and curl** — `sudo apt-get install -y jq curl` if missing.

Resources: the local stack (Postgres, Auth, REST, Storage, Kong) needs roughly 1.5–2.5 GB RAM
while running. It is started on demand and stopped at the end of the run, never left always-on.

**On a server with a public IP (like the shared VPS):** Docker publishes the local Supabase
ports (54321 API, 54322 Postgres with the CLI's default password) on **all interfaces**, and
Docker's port rules bypass `ufw`. Either block those ports in the hosting provider's firewall or
make Docker bind to localhost by default (`/etc/docker/daemon.json`: `{"ip": "127.0.0.1"}`, then
restart Docker; this affects every container on the machine, so the server admin decides). The app
itself is always started on `127.0.0.1`. To view it from your laptop, use an SSH tunnel
([ONBOARDING.md §8](ONBOARDING.md)).

## Commands

```bash
pnpm ci:local        # verify job only — fast, no Docker
pnpm ci:local:full   # verify + migrate + deploy + smoke, against local Supabase and localhost
scripts/local-ci.sh --full --keep   # same, but leave local Supabase running afterwards
APP_PORT=3200 pnpm ci:local:full    # if port 3100 is taken
```

Expected end of a green run:

```
==> All green: verify + migrate (local) + deploy (localhost)
```

## Day-to-day development against the local ("fake") Supabase

```bash
pnpm db:start        # start local Supabase (Docker), applies all migrations
pnpm db:env          # writes .env.local pointing the app at the local Supabase
pnpm dev -p 3100     # http://localhost:3100
pnpm db:stop         # stop it when you're done (frees RAM)
```

The local keys come from `supabase status`; they are the CLI's fixed local-development keys,
not DEV secrets. Studio is excluded from `db:start` to save memory; run `pnpm exec supabase start`
without `-x` if you want it.

## Writing and testing a migration locally

```bash
pnpm db:new add_example_table        # creates supabase/migrations/<timestamp>_add_example_table.sql
# edit the file (enable RLS on every new table)
pnpm db:reset                        # rebuild the local DB from all migrations + seed.sql
pnpm ci:local:full                   # prove the full pipeline is green before pushing
```

A migration that doesn't apply cleanly from an empty database fails `--full` locally — the same
way it would fail `migrate_dev` on DEV, but before anything reaches DEV.

## What is _not_ rehearsed locally

- **The Vercel platform itself** (`vercel pull/build/deploy`, aliases, Deployment Protection).
  `next build` + `next start` covers the app; the Vercel-specific steps only run in CI.
  To check that Vercel can build the project without deploying, after `vercel link`:
  `npx vercel@65.16.0 build` (uses Preview env from Vercel; never run `vercel deploy --prod`).
- **The remote DEV database.** Local runs never connect to Supabase DEV. CI is the only thing that
  pushes migrations there (push to `develop`).
- **GitHub Actions semantics** (environments, branch rules). To execute the workflow file itself
  you can use [`act`](https://github.com/nektos/act) (`act pull_request -j verify`); it is optional and
  heavier than `local-ci.sh`. Never give `act` real secrets.

## Troubleshooting

| Symptom                                 | Fix                                                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Docker is not usable by <user>`        | Prerequisite 2, then log in again                                                                                                                  |
| `Cannot find matching keyid` (corepack) | `npm install -g corepack@latest`                                                                                                                   |
| Port 54321/54322 already in use         | Another Supabase stack is running: `pnpm exec supabase stop --all` (check it isn't someone else's first) or change ports in `supabase/config.toml` |
| `/api/health returned 000`              | Port taken or app crashed: see `/tmp/retren-local-ci-app.log`, try `APP_PORT=3200`                                                                 |
| Format check fails                      | `pnpm format` and commit                                                                                                                           |
