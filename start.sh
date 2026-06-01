#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Reap anything still listening on our ports from a previous run. Without
# this a stray uvicorn from yesterday silently shadows the fresh start —
# the new processes can't bind so they die, while the old ones keep
# serving requests with a now-expired SF token.
for port in 8000 5173; do
  pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "↻ Killing stale process on :$port ($pids)"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
done

# Verify there's an sf CLI session at all — the backend will re-read it
# itself on every request, but a missing session is worth flagging now
# so the user doesn't stare at an empty dashboard.
if ! sf org display --json >/dev/null 2>&1; then
  echo "❌ No active sf CLI session. Run: sf org login web"
  exit 1
fi

# Backend (reads sf token live via sf_session module — no env snapshot).
( source backend/.venv/bin/activate && uvicorn backend.main:app --port 8000 --reload ) &
BACKEND_PID=$!

# Frontend (bun, not npm)
( cd frontend && bun run dev ) &
FRONTEND_PID=$!

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT INT TERM

echo "✅ WiDash läuft auf http://localhost:5173"

# Browser nach kurzem Warten öffnen (gibt dem Backend Zeit hochzufahren).
sleep 2 && open "http://localhost:5173" &

wait
