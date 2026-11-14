#!/usr/bin/env bash
# scripts/supabase-local.sh — start/stop the local Supabase bound to 127.0.0.1 only.
#
# Supabase runs its containers on its own Docker network, and Docker publishes
# their ports on 0.0.0.0 and :: by default, which means anyone on the internet on
# a server with a public IP. Docker's daemon "ip" setting does not cover custom
# networks, so we create one whose host binding is 127.0.0.1 and start Supabase on it.
#
#   scripts/supabase-local.sh start [extra supabase start flags]
#   scripts/supabase-local.sh stop
set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK=retren_local
EXCLUDE="studio,imgproxy,edge-runtime,logflare,vector,supavisor,postgres-meta,realtime,mailpit"

case "${1:-}" in
  start)
    shift
    docker network inspect "$NETWORK" >/dev/null 2>&1 \
      || docker network create -o com.docker.network.bridge.host_binding_ipv4=127.0.0.1 "$NETWORK" >/dev/null
    pnpm exec supabase start --network-id "$NETWORK" -x "$EXCLUDE" "$@"
    # Refuse to keep running if anything is published beyond localhost.
    exposed="$(docker ps --filter "network=$NETWORK" --format '{{.Ports}}' | tr ',' '\n' | grep -E '0\.0\.0\.0:|\[::\]:|:::' || true)"
    if [ -n "$exposed" ]; then
      pnpm exec supabase stop --no-backup >/dev/null 2>&1 || true
      echo "✗ Local Supabase published ports beyond 127.0.0.1; stopped it:" >&2
      echo "$exposed" >&2
      exit 1
    fi
    ;;
  stop)
    pnpm exec supabase stop --no-backup
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 2
    ;;
esac
