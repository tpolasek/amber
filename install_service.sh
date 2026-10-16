#!/usr/bin/env bash
# Installs Amber as a systemd user service that runs as the calling user
# (never root). Renders amber.service with absolute paths and installs it to
# ~/.config/systemd/user/amber.service.
#
# After installing:
#   systemctl --user restart amber   # what /reload does
#   journalctl --user -t amber -f    # server logs
set -euo pipefail

UNIT_NAME="amber.service"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT_NAME"
PORT="${PORT:-3000}"

if [ "$(id -u)" -eq 0 ]; then
  echo "install_service.sh: refusing to run as root — amber runs as your own user." >&2
  exit 1
fi

command -v systemctl >/dev/null 2>&1 || {
  echo "install_service.sh: systemctl not found; systemd is required." >&2
  exit 1
}
systemctl --user show-environment >/dev/null 2>&1 || {
  echo "install_service.sh: no systemd user session available (log in locally or via ssh with a user manager)." >&2
  exit 1
}

NODE_BIN="$(command -v node)" || {
  echo "install_service.sh: node not found on PATH." >&2
  exit 1
}
NODE_BIN="$(readlink -f "$NODE_BIN")"

# Drop npm's ephemeral node_modules/.bin entries and duplicates from PATH; the
# service gets a stable PATH while keeping the user's custom bin dirs.
SERVICE_PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v 'node_modules' | awk '!seen[$0]++' | paste -sd: -)"
[ -n "$SERVICE_PATH" ] || SERVICE_PATH="$PATH"

[ -f "$REPO_ROOT/dist/src/server.js" ] || {
  echo "install_service.sh: $REPO_ROOT/dist/src/server.js not found — run 'npm run build' first." >&2
  exit 1
}

listener_pid() {
  if command -v ss >/dev/null 2>&1; then
    ss -tlnp "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]\+' | head -1 | cut -d= -f2
  else
    lsof -tiTCP:"$PORT" -sTCP:LISTEN -nP 2>/dev/null | head -1
  fi
}

port_busy() { [ -n "$(listener_pid)" ]; }

wait_for_port_free() { # $1 = seconds to wait
  local attempt
  for attempt in $(seq 1 $(( $1 * 2 ))); do
    port_busy || return 0
    sleep 0.5
  done
  return 1
}

# A server started by run.sh would keep the service from binding.
old_pid="$(listener_pid)"
if [ -n "$old_pid" ]; then
  echo "install_service.sh: port $PORT is held by pid $old_pid (likely a run.sh server)"
  if [ ! -t 0 ]; then
    echo "install_service.sh: non-interactive, not killing it — stop it and re-run." >&2
    exit 1
  fi
  read -r -p "stop it now so the service can take over? [y/N] " answer
  case "$answer" in
    y|Y) ;;
    *) echo "install_service.sh: aborting; stop the process on port $PORT and re-run." >&2; exit 1 ;;
  esac
  kill -INT "$old_pid" 2>/dev/null || true
  if ! wait_for_port_free 10; then
    term_pid="$(listener_pid)"
    echo "install_service.sh: still listening, sending SIGTERM${term_pid:+ to pid $term_pid}" >&2
    [ -n "$term_pid" ] && kill -TERM "$term_pid" 2>/dev/null || true
    wait_for_port_free 10 || { echo "install_service.sh: port $PORT is still busy." >&2; exit 1; }
  fi
fi

mkdir -p "$UNIT_DIR"
sed \
  -e "s|@PROJECT_DIR@|$REPO_ROOT|g" \
  -e "s|@NODE_BIN@|$NODE_BIN|g" \
  -e "s|@PORT@|$PORT|g" \
  -e "s|@PATH@|$SERVICE_PATH|g" \
  "$REPO_ROOT/$UNIT_NAME" > "$UNIT_FILE"
chmod 644 "$UNIT_FILE"

systemctl --user daemon-reload
systemctl --user enable "$UNIT_NAME"
if systemctl --user is-active --quiet "$UNIT_NAME"; then
  systemctl --user restart "$UNIT_NAME" # already running: pick up the re-rendered unit
else
  systemctl --user start "$UNIT_NAME"
fi

# Survive logout / run before first login. May need admin rights; not fatal.
loginctl enable-linger "$(id -un)" 2>/dev/null ||
  echo "install_service.sh: note: could not enable lingering — the service stops when you log out." >&2

echo "install_service.sh: installed $UNIT_FILE (user: $(id -un), port $PORT)"
systemctl --user status "$UNIT_NAME" --no-pager || true
