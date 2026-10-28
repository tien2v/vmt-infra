#!/usr/bin/env bash
# VMT Console - cai dat may chu lan dau (Ubuntu 24.04)
# Chay bang: bash setup.sh   (voi quyen root)
# Script nay KHONG chua mat khau hay khoa bi mat. Mat khau database duoc tao ngau nhien ngay tren may chu.
set -euo pipefail

REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/tien2v/vmt-infra/main}"
APP_DIR=/opt/vmt
export DEBIAN_FRONTEND=noninteractive

log(){ echo; echo "==> $*"; }

[ "$(id -u)" = "0" ] || { echo "Can chay voi quyen root"; exit 1; }

log "1/6 Cai Docker"
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

log "2/6 Tao swap 2GB (du phong khi het RAM)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "3/6 Tao thu muc ung dung $APP_DIR"
mkdir -p "$APP_DIR"/{www,backups,caddy_data,caddy_config,pgdata}
cd "$APP_DIR"

if [ ! -f .env ]; then
  PGPASS=$(openssl rand -hex 24)
  cat > .env <<EOF
POSTGRES_USER=vmt
POSTGRES_DB=vmt
POSTGRES_PASSWORD=${PGPASS}
EOF
  chmod 600 .env
fi

log "4/6 Tai file cau hinh"
fetch(){ # fetch <file>
  if [ -n "$REPO_RAW" ]; then curl -fsSL "$REPO_RAW/$1" -o "$1.tmp" && mv "$1.tmp" "$1"; fi
}
fetch docker-compose.yml
fetch Caddyfile
[ -n "$REPO_RAW" ] && curl -fsSL "$REPO_RAW/www/index.html" -o www/index.html || true

log "5/6 Chay dich vu (web + database)"
docker compose --env-file .env up -d
sleep 5
docker compose ps

log "6/6 Sao luu database hang ngay luc 02:30, giu 14 ngay"
cat > /usr/local/bin/vmt-backup <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/vmt
. ./.env
f="backups/vmt-$(date +%F-%H%M).sql.gz"
docker compose exec -T db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$f"
find backups -name 'vmt-*.sql.gz' -mtime +14 -delete
EOF
chmod 700 /usr/local/bin/vmt-backup
echo '30 2 * * * root /usr/local/bin/vmt-backup >> /var/log/vmt-backup.log 2>&1' > /etc/cron.d/vmt-backup
chmod 644 /etc/cron.d/vmt-backup

IP=$(curl -fsS --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')
echo
echo "XONG. Mo trinh duyet vao: http://$IP"
