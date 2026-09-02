#!/usr/bin/env bash
set -e
# Simple one-click: runs backend (8000) + frontend (5173)
# Usage:  chmod +x start.sh; ./start.sh   (or: bash start.sh)
# Stop:   Ctrl+C

cd "$(dirname "$0")"

# pick venv python if present (Windows Git Bash: .venv/Scripts/python.exe, Linux/macOS: .venv/bin/python)
if [ -f ".venv/Scripts/python.exe" ]; then
  PY=".venv/Scripts/python.exe"
elif [ -f ".venv/bin/python" ]; then
  PY=".venv/bin/python"
else
  PY="python"
fi

echo "[bookify] starting backend on http://127.0.0.1:8000 ..."
# --app-dir backend lets us run from repo root
"$PY" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir backend &
BACK_PID=$!

echo "[bookify] starting frontend on http://127.0.0.1:5173 ..."
(cd frontend && npm run dev -- --host 127.0.0.1 --port 5173) &
FRONT_PID=$!

# cleanup on Ctrl+C
trap 'echo ""; echo "[bookify] stopping..."; kill $BACK_PID $FRONT_PID 2>/dev/null; wait 2>/dev/null; exit 0' INT TERM

echo ""
echo "[bookify] both servers running:"
echo "  backend  http://127.0.0.1:8000  (docs at /docs)"
echo "  frontend http://127.0.0.1:5173"
echo "  Press Ctrl+C to stop."
echo ""

wait
