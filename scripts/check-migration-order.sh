#!/usr/bin/env bash
# scripts/check-migration-order.sh <base-ref>
# Fails if a migration added since <base-ref> (usually develop) is badly named or
# is not newer than every migration already in <base-ref>. DEV applies migrations
# in timestamp order and refuses one older than the last it applied, so this
# moves that failure from `Apply DB migrations (dev)` to the PR.
set -euo pipefail
cd "$(dirname "$0")/.."

base="${1:?usage: scripts/check-migration-order.sh <base-ref>}"
dir="supabase/migrations"
pattern='^[0-9]{14}_[A-Za-z0-9_-]+\.sql$'

latest="$(git ls-tree --name-only "$base" "$dir/" 2>/dev/null | sed 's#.*/##' | grep -E "$pattern" | sort | tail -1 | cut -c1-14 || true)"
added="$(git diff --name-only --diff-filter=A "$base" HEAD -- "$dir" | sed 's#.*/##' | grep -v '^\.gitkeep$' || true)"

if [ -z "$added" ]; then
  echo "No new migrations."
  exit 0
fi

status=0
seen=""
for f in $added; do
  if ! grep -Eq "$pattern" <<<"$f"; then
    echo "::error::$dir/$f: name must be <14-digit timestamp>_<name>.sql (use: pnpm db:new <name>)"
    status=1; continue
  fi
  ts="${f:0:14}"
  bad=0
  if [ -n "$latest" ] && [[ ! "$ts" > "$latest" ]]; then
    echo "::error::$dir/$f is not newer than the latest migration on the base ($latest). Rename it to a new timestamp: git mv $dir/$f $dir/\$(date -u +%Y%m%d%H%M%S)_${f:15}"
    bad=1
  fi
  if grep -qx "$ts" <<<"$seen"; then
    echo "::error::$dir/$f: two new migrations share the timestamp $ts"
    bad=1
  fi
  seen="$seen"$'\n'"$ts"
  if [ "$bad" = 1 ]; then status=1; else echo "ok: $f (latest on base: ${latest:-none})"; fi
done
exit "$status"
