# Onboarding on macOS

[ONBOARDING.md](ONBOARDING.md) is the source of truth for access, rules, the daily workflow and
conflicts. It was written on a Linux VPS. This page covers only what is different on a Mac. Every
step here was verified on macOS 26 (Apple Silicon) with `pnpm ci:local:full` ending in
"All green". It changes no rule: the protected areas and Nestor's approval still apply.

## Why a Mac needs extra steps

Three things break the Linux instructions on a stock Mac. Each one was hit for real:

| Problem on a stock Mac                                                                                                        | Symptom                                                                                                                     | Fix                                       |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `/bin/bash` is 3.2 (2007). The local CI script needs bash 4+.                                                                 | `pnpm ci:local` runs every step green, then fails: `local-ci.sh: line 37: parked[@]: unbound variable`, exit 1              | Homebrew bash (step 1)                    |
| Docker Desktop ignores the network option that keeps local Supabase on `127.0.0.1`, and publishes Postgres on all interfaces. | `✗ Local Supabase published ports beyond 127.0.0.1; stopped it: 0.0.0.0:54322->5432/tcp`. `db:start` and `--full` never run | Colima instead of Docker Desktop (step 3) |
| The default Node may not be 22. `engines` is not enforced, so Node 24/26 runs quietly while CI uses 22.                       | Nothing visible until something behaves differently from CI                                                                 | fnm or nvm with `.nvmrc` (step 2)         |

The Docker guard is right to stop: with Docker Desktop, a port published without an explicit IP
listens on `*` on your Mac (`lsof` shows `*:54322`), so any café or office Wi-Fi could reach local
Postgres with the CLI's default password. Do **not** work around it with a bare `supabase start`.

## 1. Command-line tools

Install [Homebrew](https://brew.sh) if you don't have it, then:

```bash
xcode-select --install          # git and compilers; skip if already installed
brew install bash jq gh fnm colima docker   # drop `docker` if Docker Desktop is installed (it ships the CLI)
```

Open a **new** terminal and check that the Homebrew bash comes first in `PATH`:

```bash
which bash        # must print /opt/homebrew/bin/bash (Intel Mac: /usr/local/bin/bash)
bash --version    # must be 5.x
```

You don't need to change your login shell. The `pnpm` scripts run `bash` from `PATH`, and that is
enough. If `which bash` still prints `/bin/bash`, add `eval "$(/opt/homebrew/bin/brew shellenv)"`
to `~/.zprofile` and open a new terminal.

## 2. Node 22 and pnpm 12

Use fnm (recommended; it reads `.nvmrc`) or nvm. Add this once to `~/.zshrc`:

```bash
eval "$(fnm env --use-on-cd)"   # switches to the repo's Node version whenever you cd into it
```

Then, in the repo:

```bash
fnm use --install-if-missing    # Node 22 from .nvmrc
node -v                         # v22.x
npm install -g corepack@latest && corepack enable   # pnpm 12 from package.json
pnpm -v                         # 12.x
```

Node 25 and later no longer ship corepack, which is one more reason to stay on 22. If you install
pnpm another way (`brew install pnpm`), make sure `pnpm -v` prints 12.x.

## 3. Docker: use Colima for this repo

[Colima](https://github.com/abiosoft/colima) (free, MIT) runs a real Linux Docker engine in a small
VM. That engine honours the `127.0.0.1` binding exactly like the VPS, and Colima forwards ports only
to `127.0.0.1` on your Mac. Docker Desktop can stay installed; you switch between the two with Docker
contexts.

```bash
colima start --cpu 4 --memory 6 --disk 40 --vm-type vz --mount-type virtiofs   # first time; later just: colima start
docker context show            # must print: colima
```

`colima start` switches the Docker context to `colima` for you. When you're done for the day:

```bash
pnpm db:stop                   # if you started local Supabase
colima stop                    # frees the VM's RAM
docker context use desktop-linux   # only if you also use Docker Desktop for other projects
```

You don't need `sudo usermod -aG docker` on a Mac. That step is Linux-only.

## 4. Day one, macOS version

```bash
git clone https://github.com/complaixeu/complaix-eu-retren.git && cd complaix-eu-retren
fnm use --install-if-missing
corepack enable
colima start
pnpm install
pnpm ci:local:full             # must end with "All green: verify + migrate (local) + deploy (localhost)"
gh auth login                  # your own account (ONBOARDING.md §6)
```

The first `--full` run downloads the Supabase images (a few minutes). Later runs take about a
minute.

## 5. Daily work

Same as [ONBOARDING.md §4](ONBOARDING.md#4-daily-workflow). On a Mac, add `colima start` first:

```bash
colima start
pnpm db:start && pnpm db:env && pnpm dev -p 3100   # http://localhost:3100
pnpm db:reset                                      # rebuild local DB from migrations + seed
pnpm ci:local:full                                 # green before every push
pnpm db:stop && colima stop
```

Always use `pnpm db:reset`, never a bare `supabase db reset`. The bare command recreates Postgres on
the CLI's default Docker network: other services can no longer reach it, the reset fails, and
Postgres ends up published on all interfaces. `pnpm db:reset` keeps it on the localhost-only
network. This happens on Linux too, not only on a Mac.

## 6. If you can't use Colima

If you really have to stay on Docker Desktop, `pnpm db:start` and `pnpm ci:local:full` stay
blocked by the guard. Run `pnpm ci:local` (verify only) before every push and write in the PR that
`--full` was not run, the same rule as for agents without Docker (AGENTS.md). Your migrations are
then untested until they reach DEV, so prefer Colima.

## 7. macOS troubleshooting

| Symptom                                                     | Fix                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `parked[@]: unbound variable` at the end of `pnpm ci:local` | Old bash: step 1, then a new terminal (`which bash` → `/opt/homebrew/bin/bash`)                                    |
| `Local Supabase published ports beyond 127.0.0.1`           | You're on Docker Desktop: `colima start`, check `docker context show` prints `colima`                              |
| `Docker is not usable by <user>`                            | Colima isn't running: `colima start`                                                                               |
| `command not found: corepack`                               | Node is 25+: `fnm use` in the repo (Node 22), or `npm install -g corepack@latest`                                  |
| `node -v` is not 22 inside the repo                         | Add `eval "$(fnm env --use-on-cd)"` to `~/.zshrc` and open a new terminal                                          |
| `/api/health returned 000`                                  | The app log is in `$TMPDIR`, not `/tmp`: `cat "$TMPDIR/retren-local-ci-app.log"`. Or try `APP_PORT=3200`           |
| `pnpm db:reset` fails with `ENOTFOUND supabase_db_retren`   | A bare `supabase db reset` was used: `pnpm db:stop`, `pnpm db:start`, then only `pnpm db:reset`                    |
| Port 54321/54322 in use                                     | A stack from Docker Desktop is still up: `docker context use desktop-linux && pnpm db:stop`, then back to `colima` |
| Colima VM out of space or memory                            | `colima stop && colima start --memory 8 --disk 60`                                                                 |
