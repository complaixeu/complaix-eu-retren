#!/usr/bin/env bash
# scripts/local-ci.sh — rehearse .github/workflows/ci.yml on this machine,
# against a throwaway local Supabase and localhost. Nothing remote is touched.
#
#   scripts/local-ci.sh           # verify job only (lint, format, types, tests, build, audit)
#   scripts/local-ci.sh --full    # verify + migrate_dev + deploy_dev, all local:
#                                 #   local Supabase (Docker) ← migrations
#                                 #   build with local Supabase env → next start on localhost
#                                 #   smoke check /api/health + Supabase REST
#   scripts/local-ci.sh --full --keep   # same, but leave local Supabase running
#
# See docs/LOCAL_CI.md.
set -euo pipefail
cd "$(dirname "$0")/.."

# Clean environment like a GitHub runner, so local secrets can't leak in.
if [ -z "${LOCAL_CI_CLEAN:-}" ]; then
  exec env -i LOCAL_CI_CLEAN=1 CI=true HOME="$HOME" USER="${USER:-}" PATH="$PATH" \
    LANG="${LANG:-C.UTF-8}" TERM="${TERM:-dumb}" bash "$PWD/scripts/local-ci.sh" "$@"
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
cleanup() {
  [ -n "$app_pid" ] && kill "$app_pid" 2>/dev/null || true
  if [ "$supabase_up" = 1 ] && [ "$keep" = 0 ]; then
    pnpm exec supabase stop --no-backup >/dev/null 2>&1 || true
  fi
  for f in "${parked[@]}"; do mv -f "$f.parked" "$f"; done
}
trap cleanup EXIT
for f in .env.local .env.development.local .env.production.local .env.test.local; do
  if [ -e "$f" ]; then mv "$f" "$f.parked"; parked+=("$f"); fi
done

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

# ── job: migrate_dev (local Supabase instead of DEV) ───────────────────────
docker info >/dev/null 2>&1 || fail "Docker is not usable by $(whoami). See docs/LOCAL_CI.md → Prerequisites."
command -v jq >/dev/null || fail "jq is required"

step "[migrate_dev] Start throwaway local Supabase (applies every migration from empty)"
pnpm exec supabase stop --no-backup >/dev/null 2>&1 || true
pnpm exec supabase start -x studio,imgproxy,edge-runtime,logflare,vector,supavisor,postgres-meta,realtime,mailpit
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

# ── job: deploy_dev (localhost instead of Vercel) ──────────────────────────
step "[deploy_dev] Build with the local Supabase env (stands in for vercel build)"
NEXT_PUBLIC_SUPABASE_URL="$api_url" \
NEXT_PUBLIC_SUPABASE_ANON_KEY="$anon_key" \
SUPABASE_SERVICE_ROLE_KEY="$service_key" \
NEXT_PUBLIC_APP_URL="http://localhost:$APP_PORT" \
  pnpm build

step "[deploy_dev] Start app on http://localhost:$APP_PORT (stands in for vercel deploy)"
NEXT_PUBLIC_SUPABASE_URL="$api_url" \
NEXT_PUBLIC_SUPABASE_ANON_KEY="$anon_key" \
SUPABASE_SERVICE_ROLE_KEY="$service_key" \
NEXT_PUBLIC_APP_URL="http://localhost:$APP_PORT" \
  pnpm start -p "$APP_PORT" >"${TMPDIR:-/tmp}/retren-local-ci-app.log" 2>&1 &
app_pid=$!

step "[deploy_dev] Smoke check /api/health (same loop as CI)"
status_code=000
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  status_code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$APP_PORT/api/health" || echo 000)
  echo "Attempt $attempt: $status_code"
  [ "$status_code" = 200 ] && break
  sleep 3
done
[ "$status_code" = 200 ] || fail "/api/health returned $status_code (log: ${TMPDIR:-/tmp}/retren-local-ci-app.log)"

step "[deploy_dev] Supabase REST reachable with the anon key"
rest_code=$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $anon_key" "$api_url/rest/v1/" || echo 000)
echo "REST: $rest_code"
[ "$rest_code" = 200 ] || fail "Supabase REST returned $rest_code"

step "All green: verify + migrate (local) + deploy (localhost)"
[ "$keep" = 1 ] && echo "Local Supabase left running. Stop it with: pnpm db:stop"
