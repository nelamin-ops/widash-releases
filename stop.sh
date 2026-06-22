#!/usr/bin/env bash
set -euo pipefail

# Kills whatever WiDash left running on the dev ports. Safe to run when
# nothing is up — silent if the ports are already free.
killed=0
for port in 8000 5173; do
  pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "↻ Killing process on :$port ($pids)"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
    killed=1
  fi
done

if [ "$killed" -eq 0 ]; then
  echo "✓ Nothing running on :8000 or :5173"
else
  echo "✅ WiDash stopped"
fi
