#!/usr/bin/env bash
# The only command the GitHub Actions deploy key may run (forced command in
# /root/.ssh/authorized_keys). Installed by hand at /root/deploy-mp/entry.sh;
# copy it there again when this file changes. See README.md.
set -euo pipefail

APP_DIR="${APP_DIR:-/root/multiplayer}"
STATE_DIR="${STATE_DIR:-/root/deploy-mp}"
SERVICE="gms-multiplayer"
LOG="$STATE_DIR/releases.log"

if ! command -v node >/dev/null && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
fi

die() {
  echo "deploy: $*" >&2
  exit 1
}

healthy() {
  for _ in $(seq 1 20); do
    curl -sf "http://127.0.0.1:8093/api/mp/health" >/dev/null && return 0
    sleep 0.5
  done
  return 1
}

release() {
  local sha="$1"
  git -C "$APP_DIR" fetch -q origin
  git -C "$APP_DIR" checkout -q --detach "$sha"
  (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
  systemctl restart "$SERVICE"
}

read -r action sha _ <<<"${SSH_ORIGINAL_COMMAND:-status}"

case "$action" in
  status)
    echo "current: $(git -C "$APP_DIR" rev-parse HEAD)"
    systemctl is-active "$SERVICE" || true
    tail -n 5 "$LOG" 2>/dev/null || true
    ;;
  deploy)
    [[ "${sha:-}" =~ ^[0-9a-f]{40}$ ]] || die "expected: deploy <40-character sha>"
    mkdir -p "$STATE_DIR"
    previous="$(git -C "$APP_DIR" rev-parse HEAD)"
    [ -z "$(git -C "$APP_DIR" status --porcelain)" ] || die "local changes in $APP_DIR"
    release "$sha"
    if healthy; then
      echo "$(date -u +%FT%TZ) $sha ok" >>"$LOG"
      echo "deployed $sha"
    else
      echo "$(date -u +%FT%TZ) $sha failed" >>"$LOG"
      release "$previous"
      healthy || die "health check failed, and the previous release did not come back either"
      die "health check failed; restored $previous"
    fi
    ;;
  *)
    die "unknown action: $action"
    ;;
esac
