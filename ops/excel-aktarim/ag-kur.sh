#!/bin/bash
# Excel aktarımı kullanıcısının bağlantı yolunu kurar (sunucuda root olarak):
#
#   bash ag-kur.sh /yol/tunel_anahtari.pub
#
# 1. pg_hba.conf: han_excel_aktarim yalnızca hanhukuk veritabanına, yalnızca sunucunun içinden
#    (127.0.0.1) ve yalnızca SSL ile girebilir; başka her yol reddedilir. PostgreSQL dışarıya
#    açılmaz (listen_addresses = localhost olarak kalır, güvenlik duvarında 5432 yoktur).
# 2. `hanexcel` sistem kullanıcısı: kabuğu yoktur; verilen anahtar yalnızca 127.0.0.1:5432'ye
#    tünel açabilir (komut çalıştıramaz, dosya aktaramaz, başka yere yönlendiremez).
# Tekrar çalıştırmak zararsızdır; anahtar dosyası verilirse yetkili anahtar onunla değiştirilir.
set -euo pipefail
ANAHTAR="${1:-}"
HBA="$(runuser -u postgres -- psql -X -At -c 'show hba_file')"

if grep -q 'han_excel_aktarim' "$HBA"; then
  echo "pg_hba: satırlar zaten var"
else
  cp -p "$HBA" "$HBA.han-excel-oncesi"
  awk '
    /^host[[:space:]]+all[[:space:]]+all[[:space:]]+127\.0\.0\.1\/32/ && !eklendi {
      print "# Excel aktarimi (ops/excel-aktarim): yalnizca hanhukuk veritabani, yalnizca sunucunun"
      print "# icinden (SSH tuneli) ve yalnizca SSL ile. Bu satirlar genel kurallardan once gelmelidir."
      print "hostssl hanhukuk        han_excel_aktarim 127.0.0.1/32          scram-sha-256"
      print "hostssl hanhukuk        han_excel_aktarim ::1/128               scram-sha-256"
      print "host    all             han_excel_aktarim all                   reject"
      eklendi = 1
    }
    { print }
    END { if (!eklendi) exit 3 }
  ' "$HBA.han-excel-oncesi" > "$HBA.yeni"
  chown --reference="$HBA" "$HBA.yeni"; chmod --reference="$HBA" "$HBA.yeni"
  mv "$HBA.yeni" "$HBA"
  HATALI="$(runuser -u postgres -- psql -X -At -c 'select count(*) from pg_hba_file_rules where error is not null')"
  if [ "$HATALI" != "0" ]; then
    cp -p "$HBA.han-excel-oncesi" "$HBA"
    echo "pg_hba: yeni dosya hatalı bulundu, eski dosya geri konuldu"; exit 1
  fi
  runuser -u postgres -- psql -X -At -c 'select pg_reload_conf()' >/dev/null
  echo "pg_hba: satırlar eklendi ve yeniden yüklendi (bağlantılar kesilmedi)"
fi

if ! id hanexcel >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/hanexcel --shell /usr/sbin/nologin hanexcel
  echo "tünel kullanıcısı oluşturuldu: hanexcel"
fi
install -d -m 700 -o hanexcel -g hanexcel /var/lib/hanexcel/.ssh
if [ -n "$ANAHTAR" ]; then
  ACIK="$(awk '{print $1" "$2}' "$ANAHTAR")"
  case "$ACIK" in ssh-ed25519\ AAAA*) ;; *) echo "Geçerli bir ed25519 açık anahtarı verin."; exit 1 ;; esac
  printf 'restrict,port-forwarding,permitopen="127.0.0.1:5432",command="/bin/false" %s han-excel-tunel\n' "$ACIK" \
    > /var/lib/hanexcel/.ssh/authorized_keys
  chown hanexcel:hanexcel /var/lib/hanexcel/.ssh/authorized_keys
  chmod 600 /var/lib/hanexcel/.ssh/authorized_keys
  echo "tünel anahtarı yetkilendirildi (yalnızca 127.0.0.1:5432'ye yönlendirme)"
fi
