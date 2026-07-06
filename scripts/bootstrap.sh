#!/usr/bin/env bash
# One-command setup for a fresh Hetzner (Ubuntu/Debian) server.
#
#   ssh root@YOUR_SERVER_IP
#   apt-get update && apt-get install -y git
#   git clone https://github.com/rayrocket-ai/realtor-agent.git /opt/realtor-agent
#   cd /opt/realtor-agent && bash scripts/bootstrap.sh
#
set -euo pipefail

APP_DIR="/opt/realtor-agent"
cd "$(dirname "$0")/.."

say() { printf "\n\033[1;32m==> %s\033[0m\n" "$*"; }
ask() { local v; read -r -p "$1: " v; echo "$v"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (or with sudo)."; exit 1
fi

say "Installing Docker + firewall"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
apt-get install -y ufw >/dev/null 2>&1 || true
ufw allow 22/tcp >/dev/null || true
ufw allow 80/tcp >/dev/null || true
ufw allow 443/tcp >/dev/null || true
ufw --force enable >/dev/null || true

say "Configuring .env"
if [ ! -f .env ]; then
  cp .env.example .env
fi

gen() { openssl rand -hex 24; }
set_env() { # set_env KEY VALUE  (only if currently empty/placeholder)
  local key="$1" val="$2"
  if grep -qE "^${key}=(change-me)?$" .env || ! grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${val}|" .env 2>/dev/null || echo "${key}=${val}" >> .env
  fi
}

set_env POSTGRES_PASSWORD "$(gen)"
set_env ADMIN_PASSWORD "$(gen)"
set_env APPROVAL_TOKEN_SECRET "$(gen)"

current() { grep "^$1=" .env | head -1 | cut -d= -f2-; }

if [ -z "$(current DOMAIN)" ] || [ "$(current DOMAIN)" = "agent.example.com" ]; then
  DOMAIN=$(ask "Your domain (DNS A record must already point at this server, e.g. agent.yourdomain.com)")
  sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" .env
  sed -i "s|^APP_BASE_URL=.*|APP_BASE_URL=https://${DOMAIN}|" .env
fi
[ -z "$(current ANTHROPIC_API_KEY)" ] && sed -i "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$(ask "Anthropic API key (console.anthropic.com)")|" .env
[ -z "$(current GOOGLE_CLIENT_ID)" ] && sed -i "s|^GOOGLE_CLIENT_ID=.*|GOOGLE_CLIENT_ID=$(ask "Google OAuth client ID")|" .env
[ -z "$(current GOOGLE_CLIENT_SECRET)" ] && sed -i "s|^GOOGLE_CLIENT_SECRET=.*|GOOGLE_CLIENT_SECRET=$(ask "Google OAuth client secret")|" .env
[ -z "$(current BOOSEND_API_KEY)" ] && sed -i "s|^BOOSEND_API_KEY=.*|BOOSEND_API_KEY=$(ask "Boosend API key (enter to skip)")|" .env
[ -z "$(current BOOSEND_WEBHOOK_SECRET)" ] && set_env BOOSEND_WEBHOOK_SECRET "$(gen)"
[ -z "$(current TELEGRAM_WEBHOOK_SECRET)" ] && set_env TELEGRAM_WEBHOOK_SECRET "$(gen)"

if [ -z "$(current GOOGLE_REFRESH_TOKEN)" ]; then
  say "Google authorization (one-time)"
  docker compose build app
  docker compose run --rm app npx tsx src/cli/google-auth.ts || true
  TOKEN=$(ask "Paste the GOOGLE_REFRESH_TOKEN value printed above")
  [ -n "$TOKEN" ] && sed -i "s|^GOOGLE_REFRESH_TOKEN=.*|GOOGLE_REFRESH_TOKEN=${TOKEN}|" .env
fi

say "Starting services"
docker compose up -d --build

say "Waiting for health check"
DOMAIN=$(current DOMAIN)
for i in $(seq 1 30); do
  if docker compose exec -T app wget -qO- http://localhost:3000/healthz >/dev/null 2>&1; then
    echo "App is healthy."
    break
  fi
  sleep 2
done

say "Installing nightly database backup (03:30, keeps 14)"
CRON_LINE="30 3 * * * ${APP_DIR}/scripts/backup.sh >> /var/log/realtor-agent-backup.log 2>&1"
( crontab -l 2>/dev/null | grep -v backup.sh ; echo "$CRON_LINE" ) | crontab -

say "Done!"
cat <<EOF

  Dashboard:        https://${DOMAIN}/admin
  Login:            $(current ADMIN_USER) / $(current ADMIN_PASSWORD)
  Health check:     https://${DOMAIN}/healthz

  Boosend webhook:  https://${DOMAIN}/webhooks/boosend
                    (set this URL + secret "$(current BOOSEND_WEBHOOK_SECRET)" in Boosend's webhook settings)

  Gmail intake:     GMAIL_MODE=label — create a Gmail label called "$(current GMAIL_LABEL)"
                    and apply it to any thread the AI should handle.
                    Switch to GMAIL_MODE=all in .env to auto-handle all inbound lead email.

  Update later:     cd ${APP_DIR} && bash scripts/deploy.sh
EOF
