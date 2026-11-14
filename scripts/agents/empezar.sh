#!/usr/bin/env bash
# scripts/agents/empezar.sh — `pnpm empezar`: the only command each developer types.
# Works out your domain from your GitHub login, runs the full preflight (with the test gate), and
# starts your harness with your domain's kickoff prompt, kept awake by caffeinate on macOS.
#
#   pnpm empezar            # domain from your GitHub login (TEAM_WORKFLOW §1)
#   pnpm empezar C          # force a domain
#   DRY_RUN=1 pnpm empezar  # show what would start, start nothing
set -euo pipefail
cd "$(dirname "$0")/../.."

login="$(gh api user --jq .login 2>/dev/null || true)"
role="${1:-}"
if [ -z "$role" ]; then
  case "$login" in
    complaix-eu) role=A ;;
    micah-earl)  role=B ;;
    vinimp2003)  role=C ;;
    *) echo "Can't tell your domain from GitHub login '${login:-none}'. Run: pnpm empezar <A|B|C>" >&2; exit 2 ;;
  esac
fi
case "$role" in A|B|C) ;; *) echo "usage: pnpm empezar [A|B|C]" >&2; exit 2 ;; esac
if [ -n "${EMPEZAR_SYNCED:-}" ]; then echo "GitHub: ${login:-?} → domain $role"; fi

wake=(); [ "$(uname -s)" = Darwin ] && wake=(caffeinate -dimsu)

# Sync first, then re-run this script from the freshly pulled file: bash reads a script as it
# goes, so switching branches under a running script would mix two versions of it.
if [ -z "${EMPEZAR_SYNCED:-}" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "You have uncommitted changes. Commit or stash them first: agents start from a clean develop." >&2
    [ -n "${DRY_RUN:-}" ] || exit 1
  elif [ -z "${DRY_RUN:-}" ]; then
    git checkout -q develop && git pull -q --ff-only
  fi
  exec env EMPEZAR_SYNCED=1 bash scripts/agents/empezar.sh "$role"
fi

if [ -n "${DRY_RUN:-}" ]; then bash scripts/preflight.sh "$role" || true
else bash scripts/preflight.sh "$role" --gate || { echo "Not READY: fix every ✗ above, then run pnpm empezar again." >&2; exit 1; }; fi

if [ "$role" = B ]; then
  if [ -n "${DRY_RUN:-}" ]; then exec env DRY_RUN=1 bash scripts/agents/run-codex-lanes.sh; fi
  exec "${wake[@]}" bash scripts/agents/run-codex-lanes.sh
fi

name="$( [ "$role" = A ] && echo "A (Intake)" || echo "C (Claims engine)")"
# The orchestrator's instructions live in .claude/agents/retren-orchestrator.md (Nestor's); this
# only tells it the domain and to start.
prompt="Domain ${name}. Empezar: run your domain's plan unattended until every task is merged."
if [ -n "${DRY_RUN:-}" ]; then
  echo "DRY_RUN: ${wake[*]} claude --agent retren-orchestrator --permission-mode bypassPermissions \"$prompt\""
  exit 0
fi
echo "Starting Claude Code for $name. Tip: type /remote-control in the session to follow it from your phone."
exec "${wake[@]}" claude --agent retren-orchestrator --permission-mode bypassPermissions "$prompt"
