#!/usr/bin/env bash
# scripts/local-ci.sh — rehearse .github/workflows/ci.yml on this machine,
# against a throwaway local Supabase and localhost. Nothing remote is touched.
#
#   scripts/local-ci.sh           # verify job only (lint, format, types, tests, build, audit)
#   scripts/local-ci.sh --full    # verify + migrations + e2e + migrate_dev + deploy_dev, all local:
#                                 #   local Supabase (Docker) ← migrations
#                                 #   database (pgTAP), integration and e2e (Playwright) tests
#                                 #   build with local Supabase env → next start on localhost
#                                 #   smoke check /api/health + Supabase REST
#   scripts/local-ci.sh --full --keep   # same, but leave local Supabase running
#
# --full takes the machine-wide local-Supabase lock (docs/TEAM_WORKFLOW.md §3) and
# waits while another run holds it: every worktree shares one local Supabase.
#
# See docs/LOCAL_CI.md.
set -euo pipefail
cd "$(dirname "$0")/.."

# Clean environment like a GitHub runner, so local secrets can't leak in.
if [ -z "${LOCAL_CI_CLEAN:-}" ]; then
  # TMPDIR is kept because the lock lives there (same path as scripts/test-all.sh).
  exec env -i LOCAL_CI_CLEAN=1 CI=true HOME="$HOME" USER="${USER:-}" PATH="$PATH" APP_PORT="${APP_PORT:-3100}" \
    LANG="${LANG:-C.UTF-8}" TERM="${TERM:-dumb}" \
    ${TMPDIR:+TMPDIR="$TMPDIR"} ${E2E_PORT:+E2E_PORT="$E2E_PORT"} \
    ${RETREN_SUPABASE_LOCK_HELD:+RETREN_SUPABASE_LOCK_HELD="$RETREN_SUPABASE_LOCK_HELD"} \
    bash "$PWD/scripts/local-ci.sh" "$@"
fi

full=0; keep=0
for arg in "$@"; do
  case "$arg" in
    --full) full=1 ;;
    --keep) keep=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

APP_PORT="${APP_PORT:-3100}"   # 3000 is often taken on the shared VPS
step() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# Next reads .env*.local; CI has none. Park them for the run.
parked=(); supabase_up=0; app_pid=""
lock="${TMPDIR:-/tmp}/retren-supabase.lock"; own_lock=0
cleanup() {
  # The app runs in its own process group (set -m): kill the whole group, or
  # next-server survives pnpm and keeps the port open after the run.
  if [ -n "$app_pid" ]; then kill -- "-$app_pid" 2>/dev/null || kill "$app_pid" 2>/dev/null || true; fi
  if [ "$supabase_up" = 1 ] && [ "$keep" = 0 ]; then
    pnpm exec supabase stop --no-backup >/dev/null 2>&1 || true
  fi
  # Only remove the lock if it is still ours (another run may have reclaimed it as stale).
  if [ "$own_lock" = 1 ] && [ "$(cat "$lock/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$lock"; fi
  for f in ${parked[@]+"${parked[@]}"}; do mv -f "$f.parked" "$f"; done
}
trap cleanup EXIT
for f in .env.local .env.development.local .env.production.local .env.test.local; do
  if [ -e "$f" ]; then mv "$f" "$f.parked"; parked+=("$f"); fi
done

# Same Node major as CI and Vercel (package.json engines / .nvmrc). pnpm's
# engineStrict skips this check when the lockfile is already up to date.
want="$(tr -dc '0-9' < .nvmrc)"
have="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo none)"
[ "$have" = "$want" ] || fail "Node $want.x required (CI uses it); this shell has Node ${have}. Run: nvm use"

# ── job: verify ─────────────────────────────────────────────────────────────
step "[verify] Install (frozen lockfile)"; pnpm install --frozen-lockfile
step "[verify] Lint";                      pnpm lint
step "[verify] Format check";              pnpm format:check
step "[verify] Typecheck";                 pnpm typecheck
step "[verify] Unit tests";                pnpm test
step "[verify] Build (placeholder env, same as CI)"
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder-anon-key \
NEXT_PUBLIC_APP_URL=http://localhost:3000 \
  pnpm build
step "[security-audit] pnpm audit (prod, high+, non-blocking)"
pnpm audit --prod --audit-level=high || echo "audit reported issues (non-blocking, as in CI)"

if [ "$full" = 0 ]; then step "verify green (run with --full for migrate + deploy rehearsal)"; exit 0; fi

# ── machine-wide local-Supabase lock (docs/TEAM_WORKFLOW.md §3) ─────────────
# Every worktree on a machine shares ONE local Supabase, and this run stops and
# restarts it. Same lock directory and rules as scripts/test-all.sh.
is_ancestor() { # is PID $1 this process or one of its ancestors?
  local pid=$$
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    if [ "$pid" = "$1" ]; then return 0; fi
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  done
  return 1
}
take_lock() {
  if [ -n "${RETREN_SUPABASE_LOCK_HELD:-}" ]; then return 0; fi
  local holder
  until mkdir "$lock" 2>/dev/null; do
    holder="$(cat "$lock/pid" 2>/dev/null || true)"
    # A caller that wrapped this run in the lock by hand (the old TEAM_WORKFLOW snippet).
    if [ -n "$holder" ] && is_ancestor "$holder"; then
      echo "The local-Supabase lock is already held by this run's caller (pid $holder)."
      return 0
    fi
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      echo "Removing stale local-Supabase lock (pid $holder is gone)."
      rm -rf "$lock"; continue
    fi
    # A lock without a PID older than 2 minutes: its owner died between mkdir and writing the PID.
    if [ -z "$holder" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +2 2>/dev/null)" ]; then
      echo "Removing stale local-Supabase lock (no PID for over 2 minutes)."
      rm -rf "$lock"; continue
    fi
    echo "Local Supabase is busy (lock held by pid ${holder:-?}); waiting…"
    sleep 20
  done
  echo $$ >"$lock/pid"
  own_lock=1
  export RETREN_SUPABASE_LOCK_HELD=1
}

# ── job: migrate_dev (local Supabase instead of DEV) ───────────────────────
docker info >/dev/null 2>&1 || fail "Docker is not usable by $(whoami). See docs/LOCAL_CI.md → Prerequisites."
command -v jq >/dev/null || fail "jq is required"

step "[migrations] New migrations are newer than everything on origin/develop"
if git rev-parse --verify -q origin/develop >/dev/null; then
  bash scripts/check-migration-order.sh origin/develop
else
  echo "origin/develop not found locally (run: git fetch origin); skipping the order check"
fi

step "[migrate_dev] Take the local-Supabase lock (waits if another run holds it)"
take_lock

step "[migrate_dev] Start throwaway local Supabase (applies every migration from empty)"
pnpm exec supabase stop --no-backup >/dev/null 2>&1 || true
bash scripts/supabase-local.sh start   # bound to 127.0.0.1 only
supabase_up=1

step "[migrate_dev] supabase db push (same command as CI, local target)"
pnpm exec supabase db push --yes

status="$(pnpm exec supabase status -o json)"
api_url="$(jq -r '.API_URL // empty' <<<"$status")"
anon_key="$(jq -r '.ANON_KEY // .PUBLISHABLE_KEY // empty' <<<"$status")"
service_key="$(jq -r '.SERVICE_ROLE_KEY // .SECRET_KEY // empty' <<<"$status")"
[ -n "$api_url" ] && [ -n "$anon_key" ] && [ -n "$service_key" ] \
  || fail "supabase status did not report API_URL / anon key / service role key"
echo "Local Supabase API: $api_url (keys not printed)"

# ── jobs: migrations + e2e (database, integration and interface tests) ─────
# Before the deploy rehearsal: test:e2e builds and serves its own copy of the app
# on 127.0.0.1:${E2E_PORT:-3200}, and must not rebuild .next under a running server.
step "[migrations] Database tests (pgTAP)"
pnpm test:db
step "[migrations] Integration tests (local Supabase, fake providers)"
pnpm test:integration
step "[e2e] Playwright Chromium (downloaded once; system libraries: docs/LOCAL_CI.md)"
pnpm exec playwright install chromium
step "[e2e] Interface tests (Playwright, production build on 127.0.0.1, fake providers)"
pnpm test:e2e

# ── job: deploy_dev (localhost instead of Vercel) ──────────────────────────
step "[deploy_dev] Build with the local Supabase env (stands in for vercel build)"
NEXT_PUBLIC_SUPABASE_URL="$api_url" \
NEXT_PUBLIC_SUPABASE_ANON_KEY="$anon_key" \
SUPABASE_SERVICE_ROLE_KEY="$service_key" \
NEXT_PUBLIC_APP_URL="http://localhost:$APP_PORT" \
  pnpm build

step "[deploy_dev] Start app on http://localhost:$APP_PORT (stands in for vercel deploy)"
# Refuse a busy port: otherwise the smoke check could hit some other server.
if curl -s -o /dev/null "http://127.0.0.1:$APP_PORT/" 2>/dev/null; then
  fail "Port $APP_PORT is already in use. Stop that process or set APP_PORT=<free port>."
fi
# Bound to 127.0.0.1 only (never all interfaces on a shared VPS). `set -m` gives
# the background job its own process group (portable; macOS has no setsid).
set -m
NEXT_PUBLIC_SUPABASE_URL="$api_url" \
NEXT_PUBLIC_SUPABASE_ANON_KEY="$anon_key" \
SUPABASE_SERVICE_ROLE_KEY="$service_key" \
NEXT_PUBLIC_APP_URL="http://localhost:$APP_PORT" \
  pnpm start -p "$APP_PORT" -H 127.0.0.1 >"${TMPDIR:-/tmp}/retren-local-ci-app.log" 2>&1 &
app_pid=$!
set +m

step "[deploy_dev] Smoke check /api/health (same loop as CI)"
status_code=000
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  status_code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$APP_PORT/api/health" || true)
  echo "Attempt $attempt: $status_code"
  [ "$status_code" = 200 ] && break
  sleep 3
done
[ "$status_code" = 200 ] || fail "/api/health returned $status_code (log: ${TMPDIR:-/tmp}/retren-local-ci-app.log)"

step "[deploy_dev] Supabase REST reachable with the anon key"
rest_code=$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $anon_key" "$api_url/rest/v1/" || true)
echo "REST: $rest_code"
[ "$rest_code" = 200 ] || fail "Supabase REST returned $rest_code"

step "All green: verify + migrate (local) + deploy (localhost)"
if [ "$keep" = 1 ]; then echo "Local Supabase left running. Stop it with: pnpm db:stop"; fi
