#!/usr/bin/env bash
# Rebuilds Amber, stops the previous server on $PORT (SIGINT, then SIGTERM if
# it will not stop), and starts a fresh server detached from this terminal.
export NVM_INC=/home/thomas/.config/nvm/versions/node/v25.8.2/include/node
export NVM_DIR=/home/thomas/.config/nvm
export NVM_CD_FLAGS=""
export PATH=/home/thomas/.config/nvm/versions/node/v25.8.2/bin:$PATH
export NVM_BIN=/home/thomas/.config/nvm/versions/node/v25.8.2/bin

PORT="${PORT:-3000}"
LOG="${AMBER_LOG:-$HOME/.amber/server.log}"

listener_pid() {
  ss -tlnp "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]\+' | head -1 | cut -d= -f2
}

port_busy() {
  ss -tln "sport = :$PORT" 2>/dev/null | grep -q ":$PORT"
}

wait_for_port_free() { # $1 = seconds to wait
  local attempt
  for attempt in $(seq 1 $(( $1 * 2 ))); do
    port_busy || return 0
    sleep 0.5
  done
  return 1
}

# Build first: a failed build must not take the running server down.
npm run build || { echo "run.sh: build failed, keeping the current server" >&2; exit 1; }

old_pid="$(listener_pid)"
if [ -n "$old_pid" ]; then
  echo "run.sh: stopping previous server on port $PORT (pid $old_pid)"
  kill -INT "$old_pid" 2>/dev/null
  if ! wait_for_port_free 10; then
    term_pid="$(listener_pid)"
    echo "run.sh: still listening, sending SIGTERM${term_pid:+ to pid $term_pid}"
    [ -n "$term_pid" ] && kill -TERM "$term_pid" 2>/dev/null
    wait_for_port_free 10 || echo "run.sh: warning: port $PORT is still busy" >&2
  fi
else
  echo "run.sh: no previous server on port $PORT"
fi

# setsid puts the server in its own session so it survives even when the
# shell that ran this script (for example a terminal hosted by the old
# server) is torn down with the previous run.
echo "run.sh: starting server on 0.0.0.0:$PORT (log: $LOG)"
HOST=0.0.0.0 setsid nohup npm run start >"$LOG" 2>&1 </dev/null &
disown
