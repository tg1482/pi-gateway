#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   scripts/gateway-daemon.sh start|run|stop|restart|status|logs [lines]
#
# start  = spawn detached daemon (nohup)
# run    = foreground mode (for systemd ExecStart)

ACTION="${1:-status}"
LINES="${2:-120}"

APP_DIR="${PI_GATEWAY_APP_DIR:-/opt/pi-gateway}"
WORKSPACE="${PI_GATEWAY_WORKSPACE:-/root/.pi/agent/pi-gateway}"
RUN_DIR="$WORKSPACE/run"
LOG_FILE="${PI_GATEWAY_STDOUT_LOG:-/var/log/pi-gateway.log}"
PID_FILE="$RUN_DIR/daemon.pid.manual"

mkdir -p "$RUN_DIR"

load_env() {
  # Order matters: later files override earlier ones.
  local env_files=(
    "/opt/momster/.env"
    "$APP_DIR/.env"
    "$WORKSPACE/.env"
  )

  for f in "${env_files[@]}"; do
    if [[ -f "$f" ]]; then
      set -a
      # shellcheck disable=SC1090
      source "$f"
      set +a
    fi
  done

  # Optional model override
  if [[ -n "${PI_GATEWAY_DEFAULT_MODEL:-}" && -f "$WORKSPACE/config.json" ]]; then
    python3 - <<'PY'
import json, os
from pathlib import Path
p = Path(os.environ['WORKSPACE']) / 'config.json'
if p.exists():
    cfg = json.loads(p.read_text())
    if not cfg.get('defaultModel'):
        cfg['defaultModel'] = os.environ.get('PI_GATEWAY_DEFAULT_MODEL', '')
        p.write_text(json.dumps(cfg, indent=2) + '\n')
PY
  fi
}

is_running() {
  local pids
  pids=$(pgrep -f "node $APP_DIR/bin/pi-gateway-daemon.mjs --workspace $WORKSPACE" || true)
  [[ -n "$pids" ]]
}

start() {
  if is_running; then
    echo "pi-gateway already running"
    status
    return 0
  fi

  load_env

  cd "$APP_DIR"
  nohup node "$APP_DIR/bin/pi-gateway-daemon.mjs" --workspace "$WORKSPACE" >>"$LOG_FILE" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  sleep 1

  if ps -p "$pid" >/dev/null 2>&1; then
    echo "pi-gateway started (pid=$pid)"
  else
    echo "pi-gateway failed to start"
    tail -n 80 "$LOG_FILE" || true
    return 1
  fi
}

run() {
  load_env
  cd "$APP_DIR"
  exec node "$APP_DIR/bin/pi-gateway-daemon.mjs" --workspace "$WORKSPACE"
}

stop() {
  local pids
  pids=$(pgrep -f "node $APP_DIR/bin/pi-gateway-daemon.mjs --workspace $WORKSPACE" || true)
  if [[ -z "$pids" ]]; then
    echo "pi-gateway is not running"
    return 0
  fi

  while read -r pid; do
    [[ -n "$pid" ]] || continue
    kill "$pid" || true
  done <<< "$pids"

  sleep 1
  rm -f "$PID_FILE"
  echo "pi-gateway stopped"
}

status() {
  local pids
  pids=$(pgrep -af "node $APP_DIR/bin/pi-gateway-daemon.mjs --workspace $WORKSPACE" || true)
  if [[ -n "$pids" ]]; then
    echo "$pids"
  else
    echo "pi-gateway not running"
  fi

  if [[ -f "$WORKSPACE/run/status.json" ]]; then
    echo "--- status.json ---"
    cat "$WORKSPACE/run/status.json"
  fi
}

logs() {
  tail -n "$LINES" "$LOG_FILE"
}

case "$ACTION" in
  start) start ;;
  run) run ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  logs) logs ;;
  *)
    echo "Usage: $0 start|run|stop|restart|status|logs [lines]"
    exit 2
    ;;
esac
