#!/bin/bash
# Veritabanını yeniden internete kapatır (sunucuda root olarak):
#
#   bash disari-kapat.sh
#
# Güvenlik duvarındaki 5432 kuralını siler, pg_hba.conf'tan dış bağlantı satırlarını kaldırır,
# PostgreSQL'i yalnızca sunucunun içinde dinler hale getirir (birkaç saniyelik yeniden başlatma).
# han_excel_aktarim rolü ve işlevler yerinde kalır; tamamen kaldırmak için kaldir.sql.
set -euo pipefail
P() { runuser -u postgres -- psql -X -At -v ON_ERROR_STOP=1 "$@"; }
HBA="$(P -c 'show hba_file')"

ufw --force delete limit 5432/tcp >/dev/null 2>&1 || true
echo "güvenlik duvarı: $(ufw status | grep -c '5432/tcp') kural (5432)"

cp -p "$HBA" "$HBA.han-excel-kapatma-oncesi"
awk '
  /^#.*Excel aktarimi/ || /^# yalnizca SSL ile girebilir/ || /^# Sunucu disindan gelen/ { next }
  /^hostssl[[:space:]]+hanhukuk[[:space:]]+han_excel_aktarim[[:space:]]/ { next }
  /^host[[:space:]]+all[[:space:]]+han_excel_aktarim[[:space:]]+all[[:space:]]+reject/ { next }
  /^host[[:space:]]+all[[:space:]]+all[[:space:]]+(0\.0\.0\.0\/0|::\/0)[[:space:]]+reject/ { next }
  { print }
' "$HBA.han-excel-kapatma-oncesi" > "$HBA.yeni"
chown --reference="$HBA" "$HBA.yeni"; chmod --reference="$HBA" "$HBA.yeni"
mv "$HBA.yeni" "$HBA"
if [ "$(P -c 'select count(*) from pg_hba_file_rules where error is not null')" != "0" ]; then
  cp -p "$HBA.han-excel-kapatma-oncesi" "$HBA"
  echo "pg_hba: yeni dosya hatalı bulundu, eski dosya geri konuldu"; exit 1
fi
P -c 'ALTER SYSTEM RESET listen_addresses' >/dev/null
P -c 'ALTER SYSTEM RESET authentication_timeout' >/dev/null
systemctl restart postgresql@17-main
for _ in $(seq 1 40); do
  if runuser -u postgres -- pg_isready -q; then break; fi
  sleep 0.25
done
echo "PostgreSQL yalnızca sunucunun içinde dinliyor: $(P -c 'show listen_addresses')"
