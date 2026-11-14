#!/usr/bin/env bash
# scripts/test-all.sh — the gate before every push (docs/plans/README.md §3):
# lint, format, types, unit, database (pgTAP), integration and e2e (Playwright), all against the
# local Supabase on 127.0.0.1 with fake providers. Nothing remote is touched.
#
# Every worktree on a machine shares ONE local Supabase, so this takes the machine-wide lock
# (docs/TEAM_WORKFLOW.md §3) and waits if another agent holds it.
#
#   pnpm test:all            # leaves local Supabase as it found it
#   KEEP=1 pnpm test:all     # leave it running afterwards
set -euo pipefail
cd "$(dirname "$0")/.."

lock="${TMPDIR:-/tmp}/retren-supabase.lock"
step() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }

if [ -z "${RETREN_SUPABASE_LOCK_HELD:-}" ]; then
  until mkdir "$lock" 2>/dev/null; do
    holder="$(cat "$lock/pid" 2>/dev/null || true)"
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
  export RETREN_SUPABASE_LOCK_HELD=1
  own_lock=1
else
  own_lock=0
fi

started=0
cleanup() {
  if [ "$started" = 1 ] && [ -z "${KEEP:-}" ]; then pnpm exec supabase stop --no-backup >/dev/null 2>&1 || true; fi
  # Only remove the lock if it is still ours (another run may have reclaimed it as stale).
  if [ "$own_lock" = 1 ] && [ "$(cat "$lock/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$lock"; fi
}
trap cleanup EXIT

step "Lint";        pnpm lint
step "Format";      pnpm format:check
step "Typecheck";   pnpm typecheck
step "Unit";        pnpm test

if ! pnpm exec supabase status >/dev/null 2>&1; then
  step "Start local Supabase (127.0.0.1 only)"
  pnpm db:start
  started=1
fi
step "Reset local DB from every migration + seed"; pnpm db:reset
step "Database (pgTAP)";                          pnpm test:db
step "Integration (local Supabase, fakes)";       pnpm test:integration
step "E2E (Playwright, fakes)";                   pnpm test:e2e

step "All tests green"
