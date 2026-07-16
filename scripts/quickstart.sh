#!/usr/bin/env bash
# Non-interactive, no-domain deploy for the Telegram booking bot + dashboard.
# Installs Docker if needed, writes .env from environment variables (generating
# the secrets), and starts the app on this server's public IP over plain HTTP.
#
# Usage (on a fresh Ubuntu/Debian server, as root):
#
#   REALM_USERNAME=9556208 REALM_PASSWORD=your-pin \
#   TELEGRAM_BOT_TOKEN=123456:ABC... \
#   bash scripts/quickstart.sh
#
# Optional env: TELEGRAM_ALLOWED_CHAT_IDS, REALM_OTP_SENDER,
#               HIGHLEVEL_API_TOKEN, HIGHLEVEL_LOCATION_ID, ADMIN_PASSWORD, TZ
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf "\n\033[1;32m==> %s\033[0m\n" "$*"; }

if [ "$(id -u)" -ne 0 ]; then echo "Run as root (or with sudo)."; exit 1; fi

say "Installing Docker (if needed)"
command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh

say "Detecting this server's public IP"
IP="${SERVER_IP:-}"
[ -z "$IP" ] && IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
[ -z "$IP" ] && IP="$(curl -fsS --max-time 5 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 2>/dev/null || true)"
[ -z "$IP" ] && IP="localhost"
echo "Public IP: $IP"

say "Writing .env"
[ -f .env ] || cp .env.example .env
gen() { openssl rand -hex 24; }
setenv() { # setenv KEY VALUE
  local key="$1" val="$2"
  if grep -q "^${key}=" .env; then
    # Use a non-/ delimiter so tokens with slashes are safe.
    python3 - "$key" "$val" <<'PY' 2>/dev/null || sed -i "s|^${key}=.*|${key}=${val}|" .env
import sys, re, io
key, val = sys.argv[1], sys.argv[2]
with open(".env") as f: lines = f.readlines()
with open(".env", "w") as f:
    for line in lines:
        f.write(f"{key}={val}\n" if line.startswith(key + "=") else line)
PY
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}

# Secrets (generated once; keep existing if re-run and already non-placeholder).
grep -qE '^POSTGRES_PASSWORD=(change-me)?$' .env && setenv POSTGRES_PASSWORD "$(gen)" || true
grep -q '^POSTGRES_PASSWORD=' .env || setenv POSTGRES_PASSWORD "$(gen)"
grep -qE '^APPROVAL_TOKEN_SECRET=(change-me)?$' .env && setenv APPROVAL_TOKEN_SECRET "$(gen)" || true
grep -q '^APPROVAL_TOKEN_SECRET=' .env || setenv APPROVAL_TOKEN_SECRET "$(gen)"
if grep -qE '^ADMIN_PASSWORD=(change-me)?$' .env || ! grep -q '^ADMIN_PASSWORD=' .env; then
  setenv ADMIN_PASSWORD "${ADMIN_PASSWORD:-$(gen)}"
fi

setenv DOMAIN "$IP"
setenv APP_BASE_URL "http://$IP"
setenv TZ "${TZ:-America/Toronto}"

# Booking + Telegram config from the environment.
[ -n "${REALM_USERNAME:-}" ] && setenv REALM_USERNAME "$REALM_USERNAME"
[ -n "${REALM_PASSWORD:-}" ] && setenv REALM_PASSWORD "$REALM_PASSWORD"
[ -n "${TELEGRAM_BOT_TOKEN:-}" ] && setenv TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"
[ -n "${TELEGRAM_ALLOWED_CHAT_IDS:-}" ] && setenv TELEGRAM_ALLOWED_CHAT_IDS "$TELEGRAM_ALLOWED_CHAT_IDS"
[ -n "${REALM_OTP_SENDER:-}" ] && setenv REALM_OTP_SENDER "$REALM_OTP_SENDER"
[ -n "${HIGHLEVEL_API_TOKEN:-}" ] && setenv HIGHLEVEL_API_TOKEN "$HIGHLEVEL_API_TOKEN"
[ -n "${HIGHLEVEL_LOCATION_ID:-}" ] && setenv HIGHLEVEL_LOCATION_ID "$HIGHLEVEL_LOCATION_ID"

say "Building and starting (first build pulls Chromium — a few minutes)"
docker compose -f docker-compose.notls.yml up -d --build

say "Waiting for health check"
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost/healthz" >/dev/null 2>&1; then echo "App is healthy."; break; fi
  sleep 3
done

ADMIN_USER_V="$(grep '^ADMIN_USER=' .env | head -1 | cut -d= -f2-)"
ADMIN_PASS_V="$(grep '^ADMIN_PASSWORD=' .env | head -1 | cut -d= -f2-)"
cat <<EOF

==================================================================
  Deployed.

  Dashboard:   http://$IP/admin
  Login:       ${ADMIN_USER_V:-ray} / ${ADMIN_PASS_V}

  Telegram:    message your bot  /whoami  to get your chat ID, then:
                 cd $(pwd) && nano .env    # set TELEGRAM_ALLOWED_CHAT_IDS=<that id>
                 docker compose -f docker-compose.notls.yml up -d
               then message it, e.g.  "16 Curry Cres tomorrow 5pm"

  Sign into PropTx once (saves the booking session):
    docker compose -f docker-compose.notls.yml exec app npm run booking:login

  Logs:        docker compose -f docker-compose.notls.yml logs -f app
  Update:      git pull && docker compose -f docker-compose.notls.yml up -d --build
==================================================================
EOF
