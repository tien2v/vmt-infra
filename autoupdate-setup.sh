#!/usr/bin/env bash
# Cai che do tu cap nhat: cu 3 phut may chu kiem tra GitHub, co ban moi thi tu chay update.sh.
# Chay 1 lan (root): bash autoupdate-setup.sh
set -euo pipefail
[ -s /opt/vmt/.uikey ] || { echo "Chua co /opt/vmt/.uikey: chay update.sh 1 lan truoc"; exit 1; }

cat > /usr/local/bin/vmt-autoupdate <<'EOS'
#!/usr/bin/env bash
# Tu cap nhat VMT Console khi GitHub co commit moi tren main
set -uo pipefail
exec 9>/var/lock/vmt-autoupdate.lock
flock -n 9 || exit 0
cd /opt/vmt
SHA=$(curl -fsS --max-time 20 -H 'Accept: application/vnd.github.sha' https://api.github.com/repos/tien2v/vmt-infra/commits/main || true)
[ ${#SHA} -eq 40 ] || exit 0
[ "$SHA" = "$(cat .deployed 2>/dev/null)" ] && exit 0
echo "=== $(date '+%F %T') cap nhat len $SHA"
curl -fsSL --max-time 60 -o /opt/vmt/u.sh https://raw.githubusercontent.com/tien2v/vmt-infra/$SHA/update.sh || exit 0
if VMT_SHA="$SHA" bash /opt/vmt/u.sh </dev/null; then
  echo "$SHA" > .deployed
  echo "=== OK"
else
  echo "=== LOI (giu ban cu neu build hong)"
  echo "$SHA" > .failed
fi
EOS
chmod 700 /usr/local/bin/vmt-autoupdate
echo '*/3 * * * * root /usr/local/bin/vmt-autoupdate >> /var/log/vmt-autoupdate.log 2>&1' > /etc/cron.d/vmt-autoupdate
chmod 644 /etc/cron.d/vmt-autoupdate
cat > /etc/logrotate.d/vmt-autoupdate <<'EOS'
/var/log/vmt-autoupdate.log { weekly rotate 4 compress missingok notifempty }
EOS
echo "Chay thu lan dau..."
/usr/local/bin/vmt-autoupdate 2>&1 | tail -5
echo "XONG. May chu tu cap nhat moi 3 phut. Nhat ky: /var/log/vmt-autoupdate.log"
