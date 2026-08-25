#!/bin/sh
# Starts the API server and the Ink CLI together with one command (`npm run dev`).
# - Waits for /health before launching the CLI so it can load models right away.
# - Ctrl+C or the exit of either process stops both.
set -e

PORT="${PORT:-3000}"
BASE_URL="${1:-http://localhost:$PORT}"
HEALTH_URL="$BASE_URL/health"
TIMEOUT=30
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI_DIR="$ROOT_DIR/cli"

cleanup() {
  kill "$SERVER_PID" "$CLI_PID" 2>/dev/null || true
  wait "$SERVER_PID" "$CLI_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# Start the NestJS dev server in the background.
npm run --prefix "$ROOT_DIR" start:dev &
SERVER_PID=$!

# Wait for it to be reachable before launching the CLI.
ELAPSED=0
while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
  echo "Server did not become healthy at $HEALTH_URL within ${TIMEOUT}s" >&2
  exit 1
fi

# Start the Ink CLI, forwarding the base URL as a positional argument.
npx tsx --tsconfig "$CLI_DIR/tsconfig.json" "$CLI_DIR/src/cli.tsx" "$BASE_URL" &
CLI_PID=$!

wait
