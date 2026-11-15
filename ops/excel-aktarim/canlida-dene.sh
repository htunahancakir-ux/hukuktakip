#!/bin/bash
# Excel aktarımı kullanıcısını CANLI veritabanında, gerçek girişle dener; hiçbir şey kalıcı olmaz.
#
#   bash canlida-dene.sh /root/han-excel-aktarim/sifre.txt
#
# 1. Süper kullanıcıyla bütün kayıt tablolarının özetini alır.
# 2. han_excel_aktarim olarak şifreyle, SSL üzerinden bağlanır ve test.sql'i çalıştırır. test.sql
#    her şeyi tek işlemde yapar ve sonunda geri alır (uydurma deneme kayıtları kalıcı olmaz).
# 3. Özeti yeniden alır; iki özet aynı olmalıdır.
# Arada bir kullanıcı uygulamada kayıt değiştirirse özetler farklı çıkar; o zaman yeniden çalıştırın.
set -euo pipefail
SIFRE_DOSYASI="${1:?şifre dosyası gerekli}"
DIZIN="$(cd "$(dirname "$0")" && pwd)"
VT=hanhukuk
P() { runuser -u postgres -- psql -X -q -At -v ON_ERROR_STOP=1 -d "$VT" "$@"; }
ozet() {
  P -c "SELECT set_config('han_excel.ozet_hedef', 'once', false) IS NULL" -f "$DIZIN/ozet.sql" \
    -c "SELECT md5(current_setting('han_excel.ozet_once')) || ' ' || (SELECT count(*) FROM jsonb_object_keys(current_setting('han_excel.ozet_once')::jsonb)) || ' ' || current_setting('han_excel.gunluk_siniri')" | tail -n 1
}

ONCE="$(ozet)"
echo "önce : özet ${ONCE%% *} ($(echo "$ONCE" | cut -d' ' -f2) tablo, günlükte son satır $(echo "$ONCE" | cut -d' ' -f3))"

# The password travels in a private file handed to psql, never on a command line.
GECICI="$(mktemp)"; chmod 600 "$GECICI"
trap 'rm -f "$GECICI"' EXIT
printf '127.0.0.1:5432:%s:han_excel_aktarim:%s\n' "$VT" "$(cat "$SIFRE_DOSYASI")" > "$GECICI"
echo "bağlantı: $(PGPASSFILE="$GECICI" psql -X -q -At "host=127.0.0.1 port=5432 dbname=$VT user=han_excel_aktarim sslmode=require" \
  -c "SELECT 'kullanıcı=' || session_user || ' ssl=' || (SELECT ssl::text || ' ' || version FROM pg_stat_ssl WHERE pid = pg_backend_pid())")"
PGPASSFILE="$GECICI" psql -X -q -v ON_ERROR_STOP=1 "host=127.0.0.1 port=5432 dbname=$VT user=han_excel_aktarim sslmode=require" \
  -f "$DIZIN/test.sql" 2>&1 | sed -e 's/^psql:[^ ]* NOTICE:  //' -e '/^$/d'
PGPASSFILE="$GECICI" psql -X -q -v ON_ERROR_STOP=1 "host=127.0.0.1 port=5432 dbname=$VT user=han_excel_aktarim sslmode=require"   -f "$DIZIN/test-tablo.sql" -f "$DIZIN/test-okuma.sql" 2>&1 | sed -e 's/^psql:[^ ]* NOTICE:  //' -e '/^$/d'

SONRA="$(ozet)"
echo "sonra: özet ${SONRA%% *}"
if [ "${ONCE%% *}" = "${SONRA%% *}" ]; then
  echo "TAMAM  canlı kayıtlar değişmedi: denemeden önceki ve sonraki özet aynı"
else
  echo "HATA   özetler farklı (arada uygulamada kayıt değişmiş olabilir; yeniden çalıştırın)"
fi
echo "kalan deneme kaydı: $(P -c "SELECT count(*) FROM han_data.clients WHERE body->'sourceImport'->>'file' IN ('YETKI-DENEMESI.xlsx','BASKA-DOSYA.xlsx','TABLO-DENEMESI.xlsx')") müvekkil, $(P -c "SELECT count(*) FROM han_data.documents WHERE body->'sourceImport'->>'file' IN ('YETKI-DENEMESI.xlsx','BASKA-DOSYA.xlsx','TABLO-DENEMESI.xlsx')") föy"
echo "sayaç: $(P -c "SELECT last_value FROM han_data.document_sequences WHERE tenant_id='00000000-0000-0000-0000-000000000001' AND prefix='GLOBAL'")"
