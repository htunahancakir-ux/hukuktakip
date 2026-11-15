#!/bin/bash
# Excel aktarımı kullanıcısına internetten doğrudan bağlantı açar (sunucuda root olarak):
#
#   bash disari-ac.sh
#
# PostgreSQL'i dış arayüzde dinletir ve güvenlik duvarında 5432'yi açar, ama dışarıdan YALNIZCA
# han_excel_aktarim, yalnızca hanhukuk veritabanına, yalnızca SSL ve şifreyle girebilir. Uygulamanın
# kendi rolü (hanhukuk) ve postgres dışarıdan şifre sorulmadan reddedilir.
#
# - pg_hba.conf: han_excel_aktarim için `hostssl hanhukuk ... all`; ardından o rol için `reject`;
#   dosyanın sonunda sunucu dışından gelen her şey için `reject`.
# - listen_addresses = '*' (PostgreSQL birkaç saniyeliğine yeniden başlar).
# - authentication_timeout = 15s: şifresini vermeyen bağlantı yer tutmasın.
# - ufw limit 5432/tcp: bir adres 30 saniyede 6'dan fazla bağlantı açarsa geçici olarak engellenir.
# - Artık gerekmeyen SSH tünel kullanıcısı (hanexcel) kaldırılır.
# Geri almak için: disari-kapat.sh
set -euo pipefail
P() { runuser -u postgres -- psql -X -At -v ON_ERROR_STOP=1 "$@"; }
HBA="$(P -c 'show hba_file')"

if grep -Eq '^hostssl[[:space:]]+hanhukuk[[:space:]]+han_excel_aktarim[[:space:]]+all[[:space:]]' "$HBA"; then
  echo "pg_hba: dış bağlantı satırı zaten var"
else
  cp -p "$HBA" "$HBA.han-excel-disari-oncesi"
  awk '
    /^#.*Excel aktarimi/ || /^# icinden \(SSH tuneli\)/ { next }
    /^hostssl[[:space:]]+hanhukuk[[:space:]]+han_excel_aktarim[[:space:]]/ { next }
    /^host[[:space:]]+all[[:space:]]+han_excel_aktarim[[:space:]]+all[[:space:]]+reject/ { next }
    /^host[[:space:]]+all[[:space:]]+all[[:space:]]+127\.0\.0\.1\/32/ && !eklendi {
      print "# Excel aktarimi (ops/excel-aktarim): bu rol her yerden, yalnizca hanhukuk veritabanina ve"
      print "# yalnizca SSL ile girebilir. Bu satirlar genel kurallardan once gelmelidir."
      print "hostssl hanhukuk        han_excel_aktarim all                   scram-sha-256"
      print "host    all             han_excel_aktarim all                   reject"
      eklendi = 1
    }
    /^# Sunucu disindan gelen/ || /^host[[:space:]]+all[[:space:]]+all[[:space:]]+(0\.0\.0\.0\/0|::\/0)[[:space:]]+reject/ { next }
    { print }
    END {
      if (!eklendi) exit 3
      print "# Sunucu disindan gelen baska her baglanti (uygulama rolu ve postgres dahil) reddedilir."
      print "host    all             all             0.0.0.0/0               reject"
      print "host    all             all             ::/0                    reject"
    }
  ' "$HBA.han-excel-disari-oncesi" > "$HBA.yeni"
  chown --reference="$HBA" "$HBA.yeni"; chmod --reference="$HBA" "$HBA.yeni"
  mv "$HBA.yeni" "$HBA"
  if [ "$(P -c 'select count(*) from pg_hba_file_rules where error is not null')" != "0" ]; then
    cp -p "$HBA.han-excel-disari-oncesi" "$HBA"
    echo "pg_hba: yeni dosya hatalı bulundu, eski dosya geri konuldu"; exit 1
  fi
  echo "pg_hba: dış bağlantı satırları yazıldı"
fi

P -c "ALTER SYSTEM SET authentication_timeout = '15s'" >/dev/null
if [ "$(P -c 'show listen_addresses')" = "*" ]; then
  P -c 'select pg_reload_conf()' >/dev/null
  echo "PostgreSQL zaten dış arayüzde dinliyor; ayarlar yeniden yüklendi"
else
  P -c "ALTER SYSTEM SET listen_addresses = '*'" >/dev/null
  BASLANGIC=$(date +%s%N)
  systemctl restart postgresql@17-main
  for _ in $(seq 1 40); do
    if runuser -u postgres -- pg_isready -q; then break; fi
    sleep 0.25
  done
  echo "PostgreSQL yeniden başladı ($(( ($(date +%s%N) - BASLANGIC) / 1000000 )) ms); dinlenen: $(P -c 'show listen_addresses')"
fi

ufw limit 5432/tcp comment 'PostgreSQL: yalnizca han_excel_aktarim (pg_hba)' >/dev/null
echo "güvenlik duvarı: $(ufw status | grep -c '5432/tcp') kural (5432, hız sınırlı)"

if id hanexcel >/dev/null 2>&1; then
  pkill -u hanexcel 2>/dev/null || true
  userdel --remove hanexcel 2>/dev/null && echo "tünel kullanıcısı kaldırıldı"
fi
