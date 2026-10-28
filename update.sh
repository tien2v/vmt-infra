#!/usr/bin/env bash
# Cap nhat cau hinh web tu GitHub va nap lai (khong mat du lieu).
# Chay: bash update.sh  (quyen root)
set -euo pipefail
REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/tien2v/vmt-infra/main}"
cd /opt/vmt

get(){ curl -fsSL "$REPO_RAW/$1" -o "$1.tmp" && mv "$1.tmp" "$1"; }
get Caddyfile
get docker-compose.yml
get www/index.html

docker compose --env-file .env up -d
docker compose exec -T web caddy validate --config /etc/caddy/Caddyfile
docker compose exec -T web caddy reload --config /etc/caddy/Caddyfile
docker compose ps
echo "XONG cap nhat."
