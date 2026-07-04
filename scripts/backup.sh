#!/usr/bin/env bash
# Nightly pg_dump; keeps the newest 14 backups. Installed to cron by bootstrap.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
STAMP=$(date +%Y%m%d-%H%M%S)
docker compose exec -T db pg_dump -U postgres realtor | gzip > "backups/realtor-${STAMP}.sql.gz"
ls -1t backups/realtor-*.sql.gz | tail -n +15 | xargs -r rm --
echo "backup ok: backups/realtor-${STAMP}.sql.gz"
