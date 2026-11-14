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
echo "GitHub: ${login:-?} → domain $role"

wake=(); [ "$(uname -s)" = Darwin ] && wake=(caffeinate -dimsu)

if [ -n "$(git status --porcelain)" ]; then
  echo "You have uncommitted changes. Commit or stash them first: agents start from a clean develop." >&2
  [ -n "${DRY_RUN:-}" ] || exit 1
else
  git checkout -q develop && git pull -q --ff-only
fi

if [ -n "${DRY_RUN:-}" ]; then bash scripts/preflight.sh "$role" || true
else bash scripts/preflight.sh "$role" --gate || { echo "Not READY: fix every ✗ above, then run pnpm empezar again." >&2; exit 1; }; fi

if [ "$role" = B ]; then
  if [ -n "${DRY_RUN:-}" ]; then exec env DRY_RUN=1 bash scripts/agents/run-codex-lanes.sh; fi
  exec "${wake[@]}" bash scripts/agents/run-codex-lanes.sh
fi

plan="$( [ "$role" = A ] && echo "A-intake" || echo "C-claims")"
name="$( [ "$role" = A ] && echo "A Intake" || echo "C Claims engine")"
review=""
[ "$role" = C ] && review=" Before marking each PR ready, have Codex review the diff with the Codex plugin (codex:rescue, read-only review) and fix every real defect it reports, re-running pnpm test:all."
prompt="Empezar. You are the orchestrator for domain ${name} of ReTren, running unattended for hours. Read CLAUDE.md, docs/ARCHITECTURE.md, docs/TEAM_WORKFLOW.md, docs/plans/README.md and docs/plans/${plan}.md. First create or reuse the GitHub issue 'Tracker: ${name}' with one checkbox per task of your plan. Then follow docs/plans/README.md §5 until every task in your plan is merged: use the Agent tool with isolation \"worktree\" for each task, at most 3 at a time and one per lane, giving each subagent the subagent prompt from README §7 filled in with its task. Never start a task whose dependency isn't merged unless its mock exists. Tick tasks in the tracker as they merge. Stop only for README §6, by commenting on the tracker mentioning the owner, and keep going with every unblocked task.${review}"

if [ -n "${DRY_RUN:-}" ]; then
  echo "DRY_RUN: ${wake[*]} claude --permission-mode bypassPermissions <kickoff prompt for $name>"
  echo "--- kickoff prompt ---"; echo "$prompt"; exit 0
fi
echo "Starting Claude Code for $name. Tip: type /remote-control in the session to follow it from your phone."
exec "${wake[@]}" claude --permission-mode bypassPermissions "$prompt"
