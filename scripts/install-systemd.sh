#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${PI_GATEWAY_APP_DIR:-/opt/pi-gateway}"
SERVICE_NAME="pi-gateway"
UNIT_SRC="$APP_DIR/systemd/pi-gateway.service"
UNIT_DST="/etc/systemd/system/${SERVICE_NAME}.service"

if [[ ! -f "$UNIT_SRC" ]]; then
  echo "Missing unit file: $UNIT_SRC"
  exit 1
fi

cp "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo "Installed and restarted $SERVICE_NAME"
systemctl status "$SERVICE_NAME" --no-pager -n 40 || true
