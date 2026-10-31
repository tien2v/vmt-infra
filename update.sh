#!/usr/bin/env bash
# Cap nhat VMT Console tu GitHub va chay lai (khong mat du lieu).
# Chay tren may chu (root):
#   curl --location -o u github.com/tien2v/vmt-infra/raw/main/update.sh
#   bash u
set -euo pipefail
cd /opt/vmt

echo "==> 1/4 Tai ban moi tu GitHub"
rm -rf /tmp/vmt-src && mkdir -p /tmp/vmt-src
curl -fsSL https://codeload.github.com/tien2v/vmt-infra/tar.gz/refs/heads/main | tar -xz -C /tmp/vmt-src --strip-components=1
cp /tmp/vmt-src/Caddyfile /tmp/vmt-src/docker-compose.yml /tmp/vmt-src/khach.caddy .
mkdir -p www && cp /tmp/vmt-src/www/*.html www/
rm -rf app.new && cp -r /tmp/vmt-src/app app.new

# Giao dien (template Lineone mua ban quyen) duoc ma hoa tren GitHub -> giai nen bang ma luu o .uikey
if [ ! -s .uikey ]; then
  [ -t 0 ] || { echo "Thieu /opt/vmt/.uikey"; exit 1; }
  read -r -p "Nhap ma giao dien (20 chu thuong, anh co trong tin nhan cua Claude): " UIKEY
  printf '%s' "$UIKEY" > .uikey && chmod 600 .uikey
fi
if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in app.new/ui.tar.gz.enc -pass file:.uikey | tar -xz -C app.new; then
  rm -f .uikey
  echo "MA GIAO DIEN SAI. Chay lai: bash u"
  exit 1
fi
rm -f app.new/ui.tar.gz.enc
# Danh sach tai khoan nhan vien khai san (ten + email) cung ma hoa bang .uikey; loi thi bo qua, khong chan cap nhat
if [ -f app.new/staff.json.enc ]; then
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in app.new/staff.json.enc -pass file:.uikey -out app.new/staff.json 2>/dev/null || { rm -f app.new/staff.json; echo "Khong giai ma duoc staff.json.enc (bo qua)"; }
  rm -f app.new/staff.json.enc
fi
# Ghi phien ban de /healthz bao (Claude kiem tra da cap nhat chua)
printf '%s' "${VMT_SHA:-$(curl -fsS --max-time 20 -H 'Accept: application/vnd.github.sha' https://api.github.com/repos/tien2v/vmt-infra/commits/main || echo unknown)}" > app.new/VERSION
rm -rf app && mv app.new app

# Giao dien trang khach (template Veylix mua ban quyen), ma rieng .khkey. Thieu ma khi tu cap nhat -> bo qua, giu ban cu.
if [ -d /tmp/vmt-src/khach ]; then
  if [ ! -s .khkey ] && [ -t 0 ]; then
    read -r -p "Nhap ma giao dien KHACH (20 chu thuong, anh co trong tin nhan cua Claude): " KHKEY
    printf '%s' "$KHKEY" > .khkey && chmod 600 .khkey
  fi
  if [ -s .khkey ]; then
    rm -rf khach.new && cp -r /tmp/vmt-src/khach khach.new && mkdir -p khach.new/public
    if openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in khach.new/ui.tar.gz.enc -pass file:.khkey | tar -xz -C khach.new/public; then
      rm -f khach.new/ui.tar.gz.enc
      cp app/VERSION khach.new/VERSION 2>/dev/null || true
      rm -rf khach && mv khach.new khach
      mkdir -p khachdata && chown 1000:1000 khachdata && chmod 700 khachdata
      echo "Giao dien khach: OK"
    else
      rm -f .khkey; rm -rf khach.new; echo "MA GIAO DIEN KHACH SAI (bo qua phan khach). Chay lai: bash u"
    fi
  else
    echo "Chua co ma giao dien khach: bo qua phan khach"
  fi
fi
mkdir -p appdata && chown 1000:1000 appdata && chmod 700 appdata

echo "==> 2/4 Kiem tra cau hinh web"
docker compose run -T --rm --no-deps web caddy validate --config /etc/caddy/Caddyfile

echo "==> 3/4 Dung lai app va chay"
docker compose --env-file .env up -d --build --remove-orphans
# File cau hinh Caddy duoc thay bang file moi -> khoi dong lai web de doc
docker compose restart web

echo "==> 4/4 Doi app san sang"
ok=0
for i in $(seq 1 30); do
  if docker compose exec -T app wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
docker compose ps
if [ "$ok" != "1" ]; then echo "APP CHUA CHAY. Xem loi: docker compose logs --tail 50 app"; exit 1; fi
kok=0
for i in $(seq 1 30); do
  if docker compose exec -T khach wget -qO- http://127.0.0.1:3001/healthz >/dev/null 2>&1; then kok=1; break; fi
  sleep 2
done
[ "$kok" = "1" ] && echo "Trang khach: OK" || echo "CANH BAO: trang khach chua chay (docker compose logs --tail 50 khach)"

if [ -f appdata/admin-password.txt ]; then
  echo
  echo "=============================================="
  echo " TAI KHOAN QUAN TRI (chi hien 1 lan, chup lai):"
  cat appdata/admin-password.txt
  echo "=============================================="
  rm -f appdata/admin-password.txt
fi
echo
cp app/VERSION .deployed 2>/dev/null || true
# Tinh trang de Claude xem tu xa (khong chua bi mat)
printf 'version=%s\nkhach_key=%s\nkhach_ok=%s\ntime=%s\n' "$(cat app/VERSION 2>/dev/null)" "$([ -s .khkey ] && echo co || echo chua)" "${kok:-0}" "$(date '+%F %T')" > www/deploy-status.txt
if [ -f khachdata/test-account.txt ]; then
  echo "=============================================="
  echo " TAI KHOAN KHACH TEST app.vominhthien.com:"
  cat khachdata/test-account.txt
  echo "=============================================="
fi
echo "XONG. Mo trinh duyet: https://saas.7zone.net"
