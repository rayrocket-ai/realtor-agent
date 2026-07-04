#!/usr/bin/env bash
# Pull the latest code and redeploy. Migrations run automatically on boot.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
docker compose up -d --build
docker compose ps
