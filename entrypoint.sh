#!/bin/sh
set -eu

# Bookify entrypoint — starts FastAPI (uvicorn) on 127.0.0.1:8000 and then
# runs nginx in foreground to serve the SPA + proxy /api.
# Data lives in the named volume mounted at /app/data.

echo "[entrypoint] starting — $(date -Is)"

# Ensure data directories exist (volume may be empty on first run).
mkdir -p /app/data/chroma /app/data/uploads

# Ensure config.toml exists — ship a default if the user didn't mount one.
if [ ! -f /app/config.toml ]; then
  if [ -f /app/config.toml.example ]; then
    echo "[entrypoint] config.toml not found — copying example"
    cp /app/config.toml.example /app/config.toml
  else
    echo "[entrypoint] WARNING: /app/config.toml not found and no example to copy"
  fi
fi

# Hint if no LLM key is configured.
if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[entrypoint] WARNING: no OPENROUTER_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY set — LLM features will fail until you set one in .env"
fi

# Start FastAPI in background. Use 0.0.0.0:8000 but nginx proxies to 127.0.0.1:8000
# so the backend is not directly exposed outside the container.
echo "[entrypoint] launching uvicorn …"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --proxy-headers &
UVICORN_PID=$!

# Wait briefly for the backend to bind so the first request doesn't 502.
echo "[entrypoint] waiting for backend to be ready …"
for i in $(seq 1 30); do
  if wget -qO- http://127.0.0.1:8000/health >/dev/null 2>&1; then
    echo "[entrypoint] backend ready after ${i}s"
    break
  fi
  sleep 1
  if ! kill -0 "$UVICORN_PID" 2>/dev/null; then
    echo "[entrypoint] ERROR: uvicorn exited early — check logs above"
    exit 1
  fi
done

# Handle shutdown cleanly — forward SIGTERM to uvicorn, then nginx handles its own.
trap 'echo "[entrypoint] shutting down …"; kill "$UVICORN_PID" 2>/dev/null || true; nginx -s quit 2>/dev/null || true; wait "$UVICORN_PID" 2>/dev/null || true; exit 0' TERM INT

echo "[entrypoint] starting nginx on :80 …"
exec nginx -g "daemon off;"
