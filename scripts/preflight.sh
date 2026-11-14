#!/usr/bin/env bash
# scripts/preflight.sh <A|B|C> — checks that this machine can run its domain's agents unattended
# for hours (docs/plans/PREFLIGHT.md). Read-only except for `--gate`, which also runs `pnpm test:all`.
#
#   pnpm preflight C          # quick checks (~10 s)
#   pnpm preflight C --gate   # plus the full test gate (a few minutes)
set -uo pipefail
cd "$(dirname "$0")/.."

role="${1:-}"; gate=0; [ "${2:-}" = "--gate" ] && gate=1
case "$role" in A|B|C) ;; *) echo "usage: pnpm preflight <A|B|C> [--gate]" >&2; exit 2 ;; esac

fails=0; warns=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n      → %s\n' "$1" "$2"; fails=$((fails+1)); }
warn() { printf '  \033[33m!\033[0m %s\n      → %s\n' "$1" "$2"; warns=$((warns+1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }
mac=0; [ "$(uname -s)" = Darwin ] && mac=1

section "Toolchain"
node_v="$(node -v 2>/dev/null || true)"
[[ "$node_v" == v22.* ]] && ok "Node $node_v" || bad "Node is ${node_v:-missing}, need 22.x" "fnm use --install-if-missing (reads .nvmrc)"
pnpm_v="$(pnpm -v 2>/dev/null || true)"
[[ "$pnpm_v" == 12.* ]] && ok "pnpm $pnpm_v" || bad "pnpm is ${pnpm_v:-missing}, need 12.x" "corepack enable"
bash_major="$(bash -c 'echo ${BASH_VERSINFO[0]}')"
[ "$bash_major" -ge 4 ] && ok "bash $bash_major.x first in PATH" || bad "bash in PATH is $bash_major.x" "brew install bash, then a new terminal (ONBOARDING_MAC.md)"
for t in git jq curl gh; do command -v "$t" >/dev/null && ok "$t" || bad "$t missing" "brew install $t (or apt-get)"; done
[ -d node_modules ] && ok "dependencies installed" || bad "node_modules missing" "pnpm install"
if ls "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/Library/Caches/ms-playwright}"/chromium* >/dev/null 2>&1 \
  || ls "$HOME/.cache/ms-playwright"/chromium* >/dev/null 2>&1; then ok "Playwright Chromium installed"
else bad "Playwright Chromium not installed" "pnpm exec playwright install chromium"; fi

section "Harness"
if [ "$role" = B ]; then
  command -v codex >/dev/null && ok "codex $(codex --version 2>/dev/null | awk '{print $NF}')" || bad "codex missing" "install the Codex CLI"
  grep -Eqs '^\s*network_access\s*=\s*true' ~/.codex/config.toml \
    && ok "Codex workspace-write sandbox has network (pnpm, gh)" \
    || bad "Codex sandbox has no network" "add [sandbox_workspace_write] network_access = true to ~/.codex/config.toml"
else
  command -v claude >/dev/null && ok "claude $(claude --version 2>/dev/null | awk '{print $1}')" || bad "claude missing" "install Claude Code"
  if [ "$role" = C ]; then
    command -v codex >/dev/null && ok "codex (for PR review)" || warn "codex missing" "C reviews every PR with Codex: install it and the Codex plugin"
  fi
fi

section "GitHub"
if gh auth status >/dev/null 2>&1; then
  ok "gh logged in as $(gh api user --jq .login 2>/dev/null)"
  perm="$(gh repo view --json viewerPermission --jq .viewerPermission 2>/dev/null)"
  [[ "$perm" == WRITE || "$perm" == MAINTAIN || "$perm" == ADMIN ]] && ok "repo permission: $perm" || bad "repo permission: ${perm:-none}" "ask Nestor for Write (ONBOARDING §2)"
  # The agents' token must not be able to administer the repo (ONBOARDING §6). Reading branch
  # protection needs admin, and it is read-only, so it is a safe probe.
  if gh api "repos/{owner}/{repo}/branches/develop/protection" >/dev/null 2>&1; then
    bad "this GitHub token has ADMIN capability" "run agents with the narrow fine-grained token: GH_TOKEN=<token> pnpm empezar (ONBOARDING §6)"
  else ok "token has no admin capability"; fi
else bad "gh not logged in" "gh auth login (your own account)"; fi

section "Repository"
git fetch -q origin 2>/dev/null || bad "git fetch failed" "check network / auth"
[ -z "$(git status --porcelain)" ] && ok "working tree clean" || bad "uncommitted changes" "commit or stash before starting agents"
behind="$(git rev-list --count HEAD..origin/develop 2>/dev/null || echo '?')"
[ "$behind" = 0 ] && ok "up to date with origin/develop" || bad "$behind commits behind origin/develop" "git checkout develop && git pull"
git log origin/develop --oneline --grep='\[P0\]' | grep -q . && ok "Phase 0 is on develop" || bad "Phase 0 ([P0]) is not on develop yet" "wait for it to merge"
plan="docs/plans/$( [ "$role" = A ] && echo A-intake || { [ "$role" = B ] && echo B-rules-docs || echo C-claims; } ).md"
[ -f "$plan" ] && ok "plan $plan" || bad "$plan missing" "git pull"
if grep -q "_person ${role}_" docs/TEAM_WORKFLOW.md 2>/dev/null; then
  warn "owner of domain $role not named in TEAM_WORKFLOW §1" "write your name + GitHub handle there (a 1-line PR), so stops can @mention you"
fi

section "Docker and local Supabase"
if docker info >/dev/null 2>&1; then
  ok "Docker usable (context: $(docker context show 2>/dev/null))"
  if [ "$mac" = 1 ] && [ "$(docker context show)" != colima ]; then
    bad "Docker context is $(docker context show), not colima" "colima start (Docker Desktop fails the 127.0.0.1 guard: ONBOARDING_MAC.md)"
  fi
  if [ "$mac" = 1 ]; then
    mem="$(colima list -j 2>/dev/null | jq -r 'select(.name=="default") | .memory' 2>/dev/null)"
    [ -n "$mem" ] && [ "$mem" -ge 6000000000 ] 2>/dev/null && ok "Colima memory $((mem/1024/1024/1024)) GiB" \
      || warn "Colima memory under 6 GiB (or unknown)" "colima stop && colima start --memory 6"
  fi
else bad "Docker not usable" "$( [ $mac = 1 ] && echo 'colima start' || echo 'see LOCAL_CI.md prerequisites')"; fi
lock="${TMPDIR:-/tmp}/retren-supabase.lock"
if [ -d "$lock" ]; then
  holder="$(cat "$lock/pid" 2>/dev/null)"
  kill -0 "${holder:-0}" 2>/dev/null && warn "local-Supabase lock held by pid $holder" "another run is in progress; fine if it's yours" \
    || bad "stale local-Supabase lock (pid ${holder:-?} gone)" "rm -rf \"$lock\""
else ok "local-Supabase lock free"; fi

section "Unattended run"
free_gb="$(df -Pk . | awk 'NR==2 {print int($4/1024/1024)}')"
[ "$free_gb" -ge 15 ] && ok "disk: ${free_gb} GiB free" || bad "disk: only ${free_gb} GiB free" "free at least 15 GiB (worktrees, builds, Docker images)"
if [ "$mac" = 1 ]; then
  pmset -g batt 2>/dev/null | grep -q "AC Power" && ok "on AC power" || bad "running on battery" "plug the Mac in"
  pgrep -x caffeinate >/dev/null && ok "caffeinate running (no sleep)" \
    || warn "nothing prevents sleep yet" "start the agents inside caffeinate (PREFLIGHT.md → Start); keep the lid open, or clamshell with power + display"
fi

if [ "$gate" = 1 ]; then
  section "Test gate"
  if pnpm test:all >"${TMPDIR:-/tmp}/retren-preflight-gate.log" 2>&1; then ok "pnpm test:all is green"
  else bad "pnpm test:all failed" "see ${TMPDIR:-/tmp}/retren-preflight-gate.log"; fi
fi

printf '\n'
if [ "$fails" = 0 ]; then
  printf '\033[1;32mREADY for domain %s\033[0m (%s warning(s)). Next: docs/plans/PREFLIGHT.md → "Start".\n' "$role" "$warns"
else
  printf '\033[1;31mNOT READY: %s problem(s)\033[0m. Fix every ✗ and run it again.\n' "$fails"; exit 1
fi
