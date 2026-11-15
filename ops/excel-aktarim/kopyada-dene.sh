#!/bin/bash
# Excel aktarımı erişimini canlı veritabanının bir KOPYASINDA dener; canlıya dokunmaz.
#
#   bash kopyada-dene.sh /var/backups/hanhukuk/hanhukuk-YYYY-MM-DD-HHMM.dump
#
# Kopyayı (hanhukuk_excel_deneme) en son dökümden açar, kur.sql'i oraya kurar, test.sql'i
# han_excel_aktarim kimliğiyle çalıştırır, eklenen deneme satırlarının biçimini süper
# kullanıcıyla denetler, hepsini geri alır ve kopyayı siler. Kişisel veri yazdırmaz.
set -euo pipefail
DOKUM="${1:?döküm dosyası gerekli}"
KOPYA=hanhukuk_excel_deneme
DIZIN="$(cd "$(dirname "$0")" && pwd)"
P() { runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 "$@"; }

P -d postgres -q -c "DROP DATABASE IF EXISTS $KOPYA" -c "CREATE DATABASE $KOPYA TEMPLATE template0"
# The dump is restored with its own owners and policies; errors would stop the script.
# (The dump is readable by root only, so it is handed to pg_restore on standard input.)
runuser -u postgres -- pg_restore --no-comments -d "$KOPYA" < "$DOKUM" 2>/tmp/excel-restore.err || {
  echo "Geri yükleme uyarı verdi:"; grep -v "already exists" /tmp/excel-restore.err | head -5
}
rm -f /tmp/excel-restore.err
P -d "$KOPYA" -Atc "select 1 from han_data.clients limit 1" >/dev/null || { echo "Kopya açılamadı; işlem durdu."; P -d postgres -q -c "DROP DATABASE IF EXISTS $KOPYA"; exit 1; }
echo "kopya hazır: $(P -d "$KOPYA" -Atc "select count(*) from han_data.clients") müvekkil, $(P -d "$KOPYA" -Atc "select count(*) from han_data.documents") föy satırı"

P -d "$KOPYA" -q -f "$DIZIN/kur.sql"
P -d "$KOPYA" -q -f "$DIZIN/tablolar.sql"
P -d "$KOPYA" -q -f "$DIZIN/okuma.sql"
echo "kurulum tamam"

cat > /tmp/excel-kopya-test.sql <<SQL
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SELECT set_config('han_excel.ozet_hedef', 'once', false) IS NULL;
\i $DIZIN/ozet.sql
SET SESSION AUTHORIZATION han_excel_aktarim;
\set incele 1
\i $DIZIN/test.sql
RESET SESSION AUTHORIZATION;
SELECT set_config('han_excel.ozet_hedef', 'sonra', false) IS NULL;
\i $DIZIN/ozet.sql
\i $DIZIN/incele.sql
ROLLBACK;
SQL
chmod 644 /tmp/excel-kopya-test.sql
P -d "$KOPYA" -q -f /tmp/excel-kopya-test.sql 2>&1 | sed -e 's/^psql:[^ ]* NOTICE:  //' -e '/^$/d'
rm -f /tmp/excel-kopya-test.sql

# The plain INSERT views, in a transaction of their own (rolled back by the test itself).
cat > /tmp/excel-kopya-test.sql <<SQL
\set ON_ERROR_STOP on
SET SESSION AUTHORIZATION han_excel_aktarim;
\i $DIZIN/test-tablo.sql
\i $DIZIN/test-okuma.sql
SQL
chmod 644 /tmp/excel-kopya-test.sql
P -d "$KOPYA" -q -f /tmp/excel-kopya-test.sql 2>&1 | sed -e 's/^psql:[^ ]* NOTICE:  //' -e '/^$/d'
rm -f /tmp/excel-kopya-test.sql

echo "geri alma sonrası kopyada deneme kaydı: $(P -d "$KOPYA" -Atc "select count(*) from han_data.clients where body->'sourceImport'->>'file' IN ('YETKI-DENEMESI.xlsx','TABLO-DENEMESI.xlsx')") müvekkil, $(P -d "$KOPYA" -Atc "select count(*) from han_data.documents where body->'sourceImport'->>'file' IN ('YETKI-DENEMESI.xlsx','TABLO-DENEMESI.xlsx')") föy"
P -d postgres -q -c "DROP DATABASE $KOPYA"
echo "kopya silindi"
