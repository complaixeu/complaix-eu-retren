#!/usr/bin/env bash
# scripts/local-ci.sh — run the same checks as the `verify` job in
# .github/workflows/ci.yml before pushing.
set -euo pipefail
cd "$(dirname "$0")/.."

# Clean environment like a GitHub runner, so local secrets can't leak in.
if [ -z "${LOCAL_CI_CLEAN:-}" ]; then
  exec env -i LOCAL_CI_CLEAN=1 CI=true HOME="$HOME" USER="${USER:-}" PATH="$PATH" \
    LANG="${LANG:-C.UTF-8}" TERM="${TERM:-dumb}" bash "$PWD/scripts/local-ci.sh" "$@"
fi

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }

# Next reads .env*.local; CI has none. Park them for the run.
parked=()
restore() { for f in "${parked[@]}"; do mv -f "$f.parked" "$f"; done; }
trap restore EXIT
for f in .env.local .env.development.local .env.production.local .env.test.local; do
  if [ -e "$f" ]; then mv "$f" "$f.parked"; parked+=("$f"); fi
done

step "Install (frozen lockfile)";  pnpm install --frozen-lockfile
step "Lint";                       pnpm lint
step "Format check";               pnpm format:check
step "Typecheck";                  pnpm typecheck
step "Unit tests";                 pnpm test
step "Build (CI env)"
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder-anon-key \
NEXT_PUBLIC_APP_URL=http://localhost:3000 \
  pnpm build
step "Audit (prod, high+, non-blocking)"
pnpm audit --prod --audit-level=high || echo "audit reported issues (non-blocking)"
step "All green"
