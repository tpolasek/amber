#!/usr/bin/env bash

set -euo pipefail

: "${ANTHROPIC_AUTH_TOKEN:?Export ANTHROPIC_AUTH_TOKEN before running this script}"

AMBER_RUN_DATA_DIR="$(mktemp -d /tmp/amber-api-run.XXXXXX)"
export DATA_DIR="$AMBER_RUN_DATA_DIR"
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-http://127.0.0.1:5001}"
export ANTHROPIC_MODEL="mimo-v2.5"
export API_TIMEOUT_MS="3000000"
export PORT="${PORT:-34817}"
export HOST="127.0.0.1"
AMBER_PROMPT="${AMBER_PROMPT:-4 + 4}"

AMBER_SERVER_PID=""
cleanup() {
  if [[ -n "$AMBER_SERVER_PID" ]] && kill -0 "$AMBER_SERVER_PID" 2>/dev/null; then
    kill "$AMBER_SERVER_PID"
    wait "$AMBER_SERVER_PID" 2>/dev/null || true
  fi
  case "$AMBER_RUN_DATA_DIR" in
    /tmp/amber-api-run.*) rm -rf -- "$AMBER_RUN_DATA_DIR" ;;
  esac
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

npm run build
node dist/src/server.js >"$AMBER_RUN_DATA_DIR/server.log" 2>&1 &
AMBER_SERVER_PID="$!"

ready=false
for ((attempt = 0; attempt < 100; attempt += 1)); do
  if curl --silent --fail "http://$HOST:$PORT/api/config" >/dev/null; then
    ready=true
    break
  fi
  if ! kill -0 "$AMBER_SERVER_PID" 2>/dev/null; then
    cat "$AMBER_RUN_DATA_DIR/server.log" >&2
    exit 1
  fi
  sleep 0.1
done

if [[ "$ready" != true ]]; then
  echo "Amber did not become ready at http://$HOST:$PORT" >&2
  cat "$AMBER_RUN_DATA_DIR/server.log" >&2
  exit 1
fi

request_body="$(node -e 'process.stdout.write(JSON.stringify({ prompt: process.argv[1], cwd: "/tmp" }))' "$AMBER_PROMPT")"
curl --fail-with-body "http://$HOST:$PORT/api/run" \
  --header "content-type: application/json" \
  --data "$request_body"
printf '\n'
