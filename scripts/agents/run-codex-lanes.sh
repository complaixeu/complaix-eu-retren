#!/usr/bin/env bash
# scripts/agents/run-codex-lanes.sh — start domain B's three Codex lanes unattended
# (docs/plans/README.md §7, PREFLIGHT.md §4). Run it from the main clone, inside caffeinate:
#
#   caffeinate -dimsu bash scripts/agents/run-codex-lanes.sh
#   DRY_RUN=1 bash scripts/agents/run-codex-lanes.sh     # print what it would do, change nothing
#
# Each lane gets its own worktree next to the repo (../retren-b<lane>) and its own log.
set -euo pipefail
cd "$(dirname "$0")/../.."

run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }

bash scripts/preflight.sh B || { echo "Preflight is not READY; fix it first." >&2; [ -n "${DRY_RUN:-}" ] || exit 1; }

# One tracker issue for the domain, created once, before the lanes start (no races between lanes).
title="Tracker: B Rules & docs"
tracker="$(gh issue list --state open --search "\"$title\" in:title" --json number --jq '.[0].number // empty')"
if [ -z "$tracker" ]; then
  body="Progress of domain B (owner: @micah-earl). One box per task in docs/plans/B-rules-docs.md; each lane ticks its own.

- [ ] B1 Operator config schema and versioning
- [ ] B2 Configs for Iryo, Renfe, Ouigo
- [ ] B3 Eligibility engine
- [ ] B4 EU form filler
- [ ] B5 Mandate PDF
- [ ] B6 Email templates
- [ ] B7 Public API and mock parity"
  if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: would create issue '$title'"; tracker=0
  else tracker="$(gh issue create --title "$title" --body "$body" | sed 's#.*/##')"; fi
fi
echo "Tracker issue: #$tracker"

git fetch -q origin
pids=()
for lane in 1 2 3; do
  wt="../retren-b$lane"
  if [ ! -d "$wt" ]; then
    run git worktree add "$wt" -b "feat/rules-lane$lane-$(date +%Y%m%d%H%M)" origin/develop
  fi
  [ -n "${DRY_RUN:-}" ] || (cd "$wt" && pnpm install --frozen-lockfile >/dev/null)
  prompt="You are lane $lane of domain B (Rules & docs) of ReTren, running unattended. Read AGENTS.md,
docs/ARCHITECTURE.md, docs/TEAM_WORKFLOW.md, docs/plans/README.md and docs/plans/B-rules-docs.md.
Do every task of lane $lane (see the Lanes table) in order. For each task: create a branch
feat/rules-<id>-<slug> from the latest origin/develop, follow docs/plans/README.md §5 step 4
(test-first, git merge origin/develop and check it, pnpm test:all, draft PR titled with the task
ID, gh pr ready, gh pr merge, wait until MERGED), then tick the task in issue #$tracker
(gh issue view/edit). Stop only for README §6: comment on issue #$tracker mentioning @micah-earl
with the reason, then continue with your next unblocked task."
  log="../retren-b$lane.log"
  if [ -n "${DRY_RUN:-}" ]; then
    echo "DRY_RUN: codex exec --approve-for-me -s workspace-write -C $wt <lane $lane prompt> -o ../retren-b$lane.last.md > $log"
  else
    codex exec --approve-for-me -s workspace-write -C "$wt" "$prompt" -o "../retren-b$lane.last.md" >"$log" 2>&1 &
    pids+=($!)
    echo "Lane $lane started (pid $!, log $log)"
  fi
done

[ -n "${DRY_RUN:-}" ] && exit 0
status=0
for pid in "${pids[@]}"; do wait "$pid" || status=1; done
echo "All lanes finished (status $status). Final messages: ../retren-b{1,2,3}.last.md"
exit $status
