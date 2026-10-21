#!/usr/bin/env bash
set -euo pipefail
ZORR_PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZORR_DOMAIN="${1:?Usage: deploy/install-vps.sh bot.example.com}"
if [[ ! "$ZORR_DOMAIN" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]]; then
  echo 'Invalid domain' >&2; exit 1
fi
ZORR_USER="$(id -un)"
ZORR_TMP="$(mktemp -d)"
trap 'rm -rf "$ZORR_TMP"' EXIT
test -f "$ZORR_PROJECT_DIR/data/catalog.json"
test -x "$ZORR_PROJECT_DIR/.venv/bin/python"
sed -e "s|__PROJECT__|$ZORR_PROJECT_DIR|g" -e "s|__USER__|$ZORR_USER|g" "$ZORR_PROJECT_DIR/deploy/zorr-mob-notifier.service.template" > "$ZORR_TMP/service"
sed "s|__DOMAIN__|$ZORR_DOMAIN|g" "$ZORR_PROJECT_DIR/deploy/nginx.conf.template" > "$ZORR_TMP/nginx"
sudo install -m 644 "$ZORR_TMP/service" /etc/systemd/system/zorr-mob-notifier.service
# Keep Certbot-managed TLS config intact on repeated installs.
if ! sudo test -f /etc/nginx/sites-available/zorr-mob-notifier; then
  sudo install -m 644 "$ZORR_TMP/nginx" /etc/nginx/sites-available/zorr-mob-notifier
fi
sudo ln -sfn /etc/nginx/sites-available/zorr-mob-notifier /etc/nginx/sites-enabled/zorr-mob-notifier
sudo systemctl daemon-reload
sudo systemctl enable --now zorr-mob-notifier.service
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx --non-interactive --agree-tos --redirect -d "$ZORR_DOMAIN"
curl --fail --silent --show-error --max-time 15 --resolve "$ZORR_DOMAIN:443:127.0.0.1" "https://$ZORR_DOMAIN/healthz"
