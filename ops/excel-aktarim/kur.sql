-- Excel aktarımı için sınırlı veritabanı erişimi (kurulum).
--
-- Büro veritabanında, süper kullanıcıyla (postgres) çalıştırılır; tekrar çalıştırmak zararsızdır:
--   runuser -u postgres -- psql -d hanhukuk -X -v ON_ERROR_STOP=1 -f kur.sql
--
-- Ne kurar:
--   han_excel_aktarim  Giriş yapan kullanıcı. Hiçbir role üye değildir, hiçbir tabloya doğrudan
--                      erişemez; yalnızca han_excel şemasındaki üç işlevi çağırabilir.
--   han_excel_yazici   Giriş YAPAMAYAN rol. İşlevler onun adına çalışır (SECURITY DEFINER). Yetkisi
--                      yalnızca: mevcut büronun müvekkil ve föy satırlarını okumak ve yenisini
--                      eklemek, föy numarası sayacını ilerletmek, işlem günlüğüne "oluşturma"
--                      satırı eklemek. UPDATE/DELETE yetkisi (sayaç dışında) yoktur; satır
--                      güvenliği (RLS) onu tek büroya bağlar.
--   han_excel.durum(), han_excel.muvekkil_ekle(), han_excel.foy_ekle()
--
-- Kurallar uygulamadakilerle aynıdır (lib/record-store/intake.cjs, clients.cjs,
-- folio-numbers.cjs, lib/audit.cjs): müvekkil bağlantısı, TC/vergi numarası çakışması, föy
-- numarası sayacı, işlem günlüğü. Ek olarak aynı Excel satırının ikinci kez aktarılması ve aynı
-- içerikli föyün yeniden açılması reddedilir.
--
-- Şifre burada verilmez: kullanıcı şifresiz oluşturulur (giriş yapamaz); şifre sunucuda
-- ayrıca, yalnızca SCRAM özeti gönderilerek atanır (bkz. README.md).
--
-- Kaldırma: kaldir.sql

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'han_excel_yazici') THEN
    CREATE ROLE han_excel_yazici NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'han_excel_aktarim') THEN
    CREATE ROLE han_excel_aktarim LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      CONNECTION LIMIT 3;
  END IF;
END
$roles$;
-- Neither role may ever be a member of another role, or have members.
DO $members$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT g.rolname AS grp, m.rolname AS mem
    FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
    WHERE m.rolname IN ('han_excel_aktarim', 'han_excel_yazici') OR g.rolname IN ('han_excel_aktarim', 'han_excel_yazici')
  LOOP
    EXECUTE format('REVOKE %I FROM %I', r.grp, r.mem);
  END LOOP;
END
$members$;
ALTER ROLE han_excel_aktarim NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
ALTER ROLE han_excel_yazici NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
-- A forgotten open transaction must not hold the folio counter against the application.
ALTER ROLE han_excel_aktarim SET statement_timeout = '30s';
ALTER ROLE han_excel_aktarim SET lock_timeout = '5s';
ALTER ROLE han_excel_aktarim SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE han_excel_aktarim SET search_path = han_excel;

CREATE SCHEMA IF NOT EXISTS han_excel;
REVOKE ALL ON SCHEMA han_excel FROM PUBLIC;
GRANT USAGE ON SCHEMA han_excel TO han_excel_aktarim, han_excel_yazici;

-- What the functions' owner may touch, and nothing else.
GRANT USAGE ON SCHEMA han_data, han_private TO han_excel_yazici;
GRANT SELECT, INSERT ON han_data.clients, han_data.documents TO han_excel_yazici;
GRANT SELECT, INSERT, UPDATE ON han_data.document_sequences TO han_excel_yazici;
GRANT INSERT ON han_private.han_audit TO han_excel_yazici;

DROP POLICY IF EXISTS excel_aktarim_oku ON han_data.clients;
DROP POLICY IF EXISTS excel_aktarim_ekle ON han_data.clients;
DROP POLICY IF EXISTS excel_aktarim_oku ON han_data.documents;
DROP POLICY IF EXISTS excel_aktarim_ekle ON han_data.documents;
DROP POLICY IF EXISTS excel_aktarim_oku ON han_data.document_sequences;
DROP POLICY IF EXISTS excel_aktarim_ekle ON han_data.document_sequences;
DROP POLICY IF EXISTS excel_aktarim_ilerlet ON han_data.document_sequences;
DROP POLICY IF EXISTS excel_aktarim_ekle ON han_private.han_audit;

-- Only the existing office (the one on www.<alan>), by its fixed identifier.
CREATE POLICY excel_aktarim_oku ON han_data.clients FOR SELECT TO han_excel_yazici
  USING (tenant_id = '00000000-0000-0000-0000-000000000001'::uuid);
CREATE POLICY excel_aktarim_ekle ON han_data.clients FOR INSERT TO han_excel_yazici
  WITH CHECK (tenant_id = '00000000-0000-0000-0000-000000000001'::uuid AND active);
CREATE POLICY excel_aktarim_oku ON han_data.documents FOR SELECT TO han_excel_yazici
  USING (tenant_id = '00000000-0000-0000-0000-000000000001'::uuid);
CREATE POLICY excel_aktarim_ekle ON han_data.documents FOR INSERT TO han_excel_yazici
  WITH CHECK (tenant_id = '00000000-0000-0000-0000-000000000001'::uuid AND active);
CREATE POLICY excel_aktarim_oku ON han_data.document_sequences FOR SELECT TO han_excel_yazici
  USING (tenant_id = '00000000-0000-0000-0000-000000000001'::uuid);
CREATE POLICY excel_aktarim_ekle ON han_data.document_sequences FOR INSERT TO han_excel_yazici
  WITH CHECK (tenant_id = '00000000-0000-0000-0000-000000000001'::uuid);
CREATE POLICY excel_aktarim_ilerlet ON han_data.document_sequences FOR UPDATE TO han_excel_yazici
  USING (tenant_id = '00000000-0000-0000-0000-000000000001'::uuid)
  WITH CHECK (tenant_id = '00000000-0000-0000-0000-000000000001'::uuid);
CREATE POLICY excel_aktarim_ekle ON han_private.han_audit FOR INSERT TO han_excel_yazici
  WITH CHECK (
    tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
    AND category = 'changes' AND action = 'create' AND area IN ('Müvekkiller', 'Evraklar')
  );

-- ---------------------------------------------------------------------------------------------
-- Yardımcılar (kullanıcıya açık değil)
-- ---------------------------------------------------------------------------------------------

-- HX400 geçersiz girdi, HX404 müvekkil bulunamadı, HX409 çakışma / tekrar.
CREATE OR REPLACE FUNCTION han_excel._hata(kod text, mesaj text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION '%', mesaj USING ERRCODE = kod;
END
$fn$;

-- A text field: missing or null is '', white space collapsed, length limited.
CREATE OR REPLACE FUNCTION han_excel._metin(kayit jsonb, alan text, azami integer) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  deger jsonb := kayit -> alan;
  sonuc text;
BEGIN
  IF deger IS NULL OR jsonb_typeof(deger) = 'null' THEN
    RETURN '';
  END IF;
  IF jsonb_typeof(deger) NOT IN ('string', 'number') THEN
    PERFORM han_excel._hata('HX400', format('"%s" alanı metin olmalı.', alan));
  END IF;
  sonuc := btrim(regexp_replace(kayit ->> alan, '[[:space:]]+', ' ', 'g'));
  IF sonuc ~ '[[:cntrl:]]' THEN
    PERFORM han_excel._hata('HX400', format('"%s" alanında geçersiz karakter var.', alan));
  END IF;
  IF length(sonuc) > azami THEN
    PERFORM han_excel._hata('HX400', format('"%s" alanı en fazla %s karakter olabilir.', alan, azami));
  END IF;
  RETURN sonuc;
END
$fn$;

-- A date field: '' or a real calendar day written YYYY-MM-DD.
CREATE OR REPLACE FUNCTION han_excel._tarih(kayit jsonb, alan text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  sonuc text := han_excel._metin(kayit, alan, 10);
  gecerli boolean := false;
BEGIN
  IF sonuc = '' THEN
    RETURN '';
  END IF;
  IF sonuc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    BEGIN
      gecerli := to_char(sonuc::date, 'YYYY-MM-DD') = sonuc AND sonuc >= '1950-01-01' AND sonuc <= '2100-12-31';
    EXCEPTION WHEN OTHERS THEN
      gecerli := false;
    END;
  END IF;
  IF NOT gecerli THEN
    PERFORM han_excel._hata('HX400', format('"%s" alanı YYYY-AA-GG biçiminde geçerli bir tarih olmalı.', alan));
  END IF;
  RETURN sonuc;
END
$fn$;

-- A money field in lira: a JSON number or a string like 12500.75 (dot as the decimal mark).
CREATE OR REPLACE FUNCTION han_excel._tutar(kayit jsonb, alan text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  deger jsonb := kayit -> alan;
  yazi text;
  sonuc numeric;
BEGIN
  IF deger IS NULL OR jsonb_typeof(deger) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(deger) NOT IN ('string', 'number') THEN
    PERFORM han_excel._hata('HX400', format('"%s" alanı sayı olmalı.', alan));
  END IF;
  yazi := btrim(kayit ->> alan);
  IF yazi = '' THEN
    RETURN NULL;
  END IF;
  IF yazi !~ '^[0-9]{1,12}(\.[0-9]{1,2})?$' THEN
    PERFORM han_excel._hata(
      'HX400',
      format('"%s" alanı 12500 ya da 12500.75 gibi yazılmalı (binlik ayraç yok, kuruş için nokta).', alan)
    );
  END IF;
  sonuc := yazi::numeric;
  RETURN sonuc;
END
$fn$;

-- The application's phone format (outputs/icrapro/phone-format.js): 0 (5xx) xxx xx xx.
CREATE OR REPLACE FUNCTION han_excel._telefon(deger text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  rakam text := regexp_replace(coalesce(deger, ''), '[^0-9]', '', 'g');
BEGIN
  IF btrim(coalesce(deger, '')) = '' THEN
    RETURN '';
  END IF;
  IF length(rakam) = 12 AND left(rakam, 2) = '90' THEN
    rakam := substr(rakam, 3);
  END IF;
  IF length(rakam) = 11 AND left(rakam, 1) = '0' THEN
    rakam := substr(rakam, 2);
  END IF;
  IF length(rakam) <> 10 THEN
    RETURN btrim(deger);
  END IF;
  RETURN '0 (' || substr(rakam, 1, 3) || ') ' || substr(rakam, 4, 3) || ' ' || substr(rakam, 7, 2) || ' ' || substr(rakam, 9, 2);
END
$fn$;

-- A list of up to ten extra phone numbers.
CREATE OR REPLACE FUNCTION han_excel._telefonlar(kayit jsonb, alan text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  deger jsonb := kayit -> alan;
  sonuc jsonb := '[]'::jsonb;
  oge jsonb;
  numara text;
BEGIN
  IF deger IS NULL OR jsonb_typeof(deger) = 'null' THEN
    RETURN sonuc;
  END IF;
  IF jsonb_typeof(deger) <> 'array' OR jsonb_array_length(deger) > 10 THEN
    PERFORM han_excel._hata('HX400', format('"%s" alanı en fazla 10 telefonluk bir liste olmalı.', alan));
  END IF;
  FOR oge IN SELECT value FROM jsonb_array_elements(deger) LOOP
    IF jsonb_typeof(oge) NOT IN ('string', 'number') THEN
      PERFORM han_excel._hata('HX400', format('"%s" listesindeki her öğe telefon numarası olmalı.', alan));
    END IF;
    numara := han_excel._telefon(left(oge #>> '{}', 60));
    IF numara <> '' THEN
      sonuc := sonuc || to_jsonb(left(numara, 40));
    END IF;
  END LOOP;
  RETURN sonuc;
END
$fn$;

-- TC kimlik / vergi numarası: '' ya da 10-11 rakam (boşluklar atılır).
CREATE OR REPLACE FUNCTION han_excel._kimlik(kayit jsonb, alan text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  sonuc text := regexp_replace(han_excel._metin(kayit, alan, 40), '[[:space:]]', '', 'g');
BEGIN
  IF sonuc <> '' AND sonuc !~ '^[0-9]{10,11}$' THEN
    PERFORM han_excel._hata('HX400', format('"%s" alanı 10 haneli vergi ya da 11 haneli TC kimlik numarası olmalı.', alan));
  END IF;
  RETURN sonuc;
END
$fn$;

-- How the application compares person and company names (trimmed, single spaces, Turkish upper case).
CREATE OR REPLACE FUNCTION han_excel._ad_anahtari(deger text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT upper(translate(regexp_replace(btrim(coalesce(deger, '')), '[[:space:]]+', ' ', 'g'), 'iı', 'İI'));
$fn$;

CREATE OR REPLACE FUNCTION han_excel._iban_gecerli(deger text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  dizi text;
  sayi text := '';
  harf text;
BEGIN
  IF deger !~ '^TR[0-9]{24}$' THEN
    RETURN false;
  END IF;
  dizi := substr(deger, 5) || left(deger, 4);
  FOR i IN 1..length(dizi) LOOP
    harf := substr(dizi, i, 1);
    sayi := sayi || CASE WHEN harf ~ '[0-9]' THEN harf ELSE (ascii(harf) - 55)::text END;
  END LOOP;
  RETURN mod(sayi::numeric, 97) = 1;
END
$fn$;

-- Where a row came from: {"file": "...xlsx", "sheet": "Sayfa1", "row": 12, "sha256": "<64 hex>"}.
CREATE OR REPLACE FUNCTION han_excel._kaynak(kaynak jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  dosya text;
  sayfa text;
  satir text;
  ozet text;
  alan text;
BEGIN
  IF kaynak IS NULL OR jsonb_typeof(kaynak) <> 'object' THEN
    PERFORM han_excel._hata('HX400', 'Kaynak bilgisi gerekli: {"file": "dosya.xlsx", "sheet": "Sayfa1", "row": 2, "sha256": "..."}');
  END IF;
  FOR alan IN SELECT jsonb_object_keys(kaynak) LOOP
    IF alan NOT IN ('file', 'sheet', 'row', 'sha256') THEN
      PERFORM han_excel._hata('HX400', format('Kaynak bilgisinde desteklenmeyen alan: %s', alan));
    END IF;
  END LOOP;
  dosya := han_excel._metin(kaynak, 'file', 200);
  sayfa := han_excel._metin(kaynak, 'sheet', 100);
  satir := han_excel._metin(kaynak, 'row', 9);
  ozet := lower(han_excel._metin(kaynak, 'sha256', 64));
  IF dosya = '' THEN
    PERFORM han_excel._hata('HX400', 'Kaynak dosya adı ("file") gerekli.');
  END IF;
  IF satir !~ '^[1-9][0-9]{0,6}$' THEN
    PERFORM han_excel._hata('HX400', 'Kaynak satır numarası ("row") 1 ve üzeri bir tam sayı olmalı.');
  END IF;
  IF ozet <> '' AND ozet !~ '^[0-9a-f]{64}$' THEN
    PERFORM han_excel._hata('HX400', 'Kaynak dosya özeti ("sha256") 64 haneli onaltılık değer olmalı.');
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'file', dosya,
    'sheet', sayfa,
    'row', satir::integer,
    'sha256', nullif(ozet, ''),
    'importedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ));
END
$fn$;

-- The same Excel row: same sheet and row of the same file. Files are told apart by their
-- content digest when both sides carry one, otherwise by name.
CREATE OR REPLACE FUNCTION han_excel._ayni_kaynak(eski jsonb, yeni jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT coalesce(
    jsonb_typeof(eski) = 'object'
    AND coalesce(eski ->> 'sheet', '') = coalesce(yeni ->> 'sheet', '')
    AND eski ->> 'row' = yeni ->> 'row'
    AND CASE
      WHEN eski ? 'sha256' AND yeni ? 'sha256' THEN lower(eski ->> 'sha256') = lower(yeni ->> 'sha256')
      ELSE lower(coalesce(eski ->> 'file', '')) = lower(coalesce(yeni ->> 'file', ''))
    END,
    false
  );
$fn$;

-- ---------------------------------------------------------------------------------------------
-- Kullanıcıya açık işlevler
-- ---------------------------------------------------------------------------------------------

-- Bağlantı denemesi: hiçbir kayda dokunmaz, hiçbir kayıt göstermez.
CREATE OR REPLACE FUNCTION han_excel.durum() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object(
    'ok', true,
    'kullanici', session_user,
    'veritabani', current_database(),
    'surum', 1,
    'sunucu_saati', to_char(clock_timestamp() AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI'),
    'islevler', jsonb_build_array('han_excel.muvekkil_ekle(kayit, kaynak, sadece_kontrol)', 'han_excel.foy_ekle(kayit, kaynak, sadece_kontrol)')
  );
$fn$;

-- Yeni müvekkil. `sadece_kontrol` doğruysa bütün denetimler yapılır ama kayıt açılmaz.
CREATE OR REPLACE FUNCTION han_excel.muvekkil_ekle(kayit jsonb, kaynak jsonb, sadece_kontrol boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  buro CONSTANT uuid := '00000000-0000-0000-0000-000000000001';
  izinli CONSTANT text[] := ARRAY[
    'type', 'name', 'fullName', 'tradeName', 'identity', 'taxOffice', 'mersisNumber', 'phone', 'email',
    'address', 'city', 'district', 'clientCategory', 'reference', 'notes', 'iban', 'bankName', 'bankBranch',
    'accountHolder', 'additionalPhones'
  ];
  alan text;
  iz jsonb;
  mevcut text;
  tur text;
  tam_ad text;
  unvan text;
  ad text;
  kimlik text;
  eposta text;
  iban text;
  kategori text;
  yeni_id text;
  govde jsonb;
BEGIN
  IF kayit IS NULL OR jsonb_typeof(kayit) <> 'object' THEN
    PERFORM han_excel._hata('HX400', 'Müvekkil bilgisi bir JSON nesnesi olmalı.');
  END IF;
  FOR alan IN SELECT jsonb_object_keys(kayit) LOOP
    IF NOT alan = ANY (izinli) THEN
      PERFORM han_excel._hata('HX400', format('Müvekkilde desteklenmeyen alan: %s', alan));
    END IF;
  END LOOP;
  iz := han_excel._kaynak(kaynak);
  -- One import call at a time, so two calls cannot pass the same check together.
  PERFORM pg_advisory_xact_lock(hashtextextended('han_excel:' || buro::text, 0));

  SELECT c.id INTO mevcut FROM han_data.clients c
  WHERE c.tenant_id = buro AND han_excel._ayni_kaynak(c.body -> 'sourceImport', iz) LIMIT 1;
  IF mevcut IS NOT NULL THEN
    RETURN jsonb_build_object('durum', 'tekrar', 'id', mevcut, 'mesaj', 'Bu Excel satırı daha önce aktarılmış; yeni müvekkil açılmadı.');
  END IF;

  kimlik := han_excel._kimlik(kayit, 'identity');
  tur := han_excel._metin(kayit, 'type', 10);
  IF tur = '' THEN
    tur := CASE length(kimlik) WHEN 11 THEN 'Şahıs' WHEN 10 THEN 'Şirket' ELSE '' END;
  END IF;
  IF tur NOT IN ('Şahıs', 'Şirket') THEN
    PERFORM han_excel._hata('HX400', 'Müvekkil türü ("type") Şahıs ya da Şirket olmalı.');
  END IF;
  tam_ad := han_excel._metin(kayit, 'fullName', 200);
  unvan := han_excel._metin(kayit, 'tradeName', 200);
  IF tam_ad = '' AND unvan = '' THEN
    -- "name" alone is accepted and placed where the application expects it.
    IF tur = 'Şahıs' THEN tam_ad := han_excel._metin(kayit, 'name', 200);
    ELSE unvan := han_excel._metin(kayit, 'name', 200);
    END IF;
  END IF;
  ad := CASE WHEN tur = 'Şahıs' THEN coalesce(nullif(tam_ad, ''), unvan) ELSE coalesce(nullif(unvan, ''), tam_ad) END;
  IF ad = '' THEN
    PERFORM han_excel._hata('HX400', 'Ticari unvan ("tradeName") veya ad soyad ("fullName") gerekli.');
  END IF;
  eposta := han_excel._metin(kayit, 'email', 254);
  IF eposta <> '' AND eposta !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    PERFORM han_excel._hata('HX400', 'Geçerli bir e-posta adresi girin.');
  END IF;
  iban := upper(regexp_replace(han_excel._metin(kayit, 'iban', 60), '[^a-zA-Z0-9]', '', 'g'));
  IF iban <> '' AND NOT han_excel._iban_gecerli(iban) THEN
    PERFORM han_excel._hata('HX400', 'Geçerli bir Türkiye IBAN numarası girin.');
  END IF;
  kategori := coalesce(nullif(han_excel._metin(kayit, 'clientCategory', 60), ''), 'Diğer');

  -- The application's rule (lib/record-store/clients.cjs): a TC / tax number belongs to one
  -- client, and never to a client and a debtor at once.
  IF kimlik <> '' AND (
    EXISTS (
      SELECT 1 FROM han_data.clients c WHERE c.tenant_id = buro AND c.active
        AND regexp_replace(coalesce(c.body ->> 'identity', ''), '[[:space:]]', '', 'g') = kimlik
    ) OR EXISTS (
      SELECT 1 FROM han_data.documents d WHERE d.tenant_id = buro AND d.active
        AND regexp_replace(coalesce(d.body ->> 'identity', ''), '[[:space:]]', '', 'g') = kimlik
    )
  ) THEN
    PERFORM han_excel._hata('HX409', 'Bu TC kimlik / vergi numarası başka bir müvekkil veya borçluda kayıtlı. Kayıt yapılamadı.');
  END IF;
  -- Without a number the name is the only identity: the same name is not opened twice.
  IF kimlik = '' AND EXISTS (
    SELECT 1 FROM han_data.clients c WHERE c.tenant_id = buro AND c.active
      AND han_excel._ad_anahtari(ad) IN (
        han_excel._ad_anahtari(c.name), han_excel._ad_anahtari(c.body ->> 'fullName'), han_excel._ad_anahtari(c.body ->> 'tradeName')
      )
  ) THEN
    PERFORM han_excel._hata('HX409', 'Aynı adla kayıtlı bir müvekkil var ve kimlik / vergi numarası verilmedi. Kayıt yapılamadı.');
  END IF;

  IF sadece_kontrol THEN
    RETURN jsonb_build_object('durum', 'kontrol_tamam', 'name', ad, 'type', tur);
  END IF;

  yeni_id := gen_random_uuid()::text;
  govde := jsonb_build_object(
    'id', yeni_id,
    'type', tur,
    'name', ad,
    'fullName', tam_ad,
    'tradeName', unvan,
    'identity', kimlik,
    'taxOffice', han_excel._metin(kayit, 'taxOffice', 120),
    'mersisNumber', han_excel._metin(kayit, 'mersisNumber', 40),
    'phone', left(han_excel._telefon(han_excel._metin(kayit, 'phone', 40)), 40),
    'email', eposta,
    'address', han_excel._metin(kayit, 'address', 500),
    'city', han_excel._metin(kayit, 'city', 60),
    'district', han_excel._metin(kayit, 'district', 60),
    'clientCategory', kategori,
    'reference', han_excel._metin(kayit, 'reference', 200),
    'notes', han_excel._metin(kayit, 'notes', 2000),
    'iban', iban,
    'bankName', han_excel._metin(kayit, 'bankName', 120),
    'bankBranch', han_excel._metin(kayit, 'bankBranch', 120),
    'accountHolder', han_excel._metin(kayit, 'accountHolder', 200)
  ) || jsonb_build_object(
    'additionalPhones', han_excel._telefonlar(kayit, 'additionalPhones'),
    'additionalAddresses', '[]'::jsonb,
    'additionalBankAccounts', '[]'::jsonb,
    'phoneSources', '{}'::jsonb,
    'attachments', '[]'::jsonb,
    'documentStaff', '',
    'collectionStaff', '',
    'recordedBy', '',
    'recordedByName', 'Excel Aktarımı',
    'createdAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'sourceImport', iz
  );

  INSERT INTO han_data.clients (tenant_id, id, body, ordinal, active)
  VALUES (buro, yeni_id, govde, (extract(epoch FROM clock_timestamp()) * 1000)::bigint, true);
  INSERT INTO han_private.han_audit (tenant_id, category, action, area, actor_id, actor_name, actor_username, record_ref, fields)
  VALUES (buro, 'changes', 'create', 'Müvekkiller', NULL, 'Excel Aktarımı', session_user, yeni_id, '{}');

  RETURN jsonb_build_object('durum', 'eklendi', 'id', yeni_id, 'name', ad, 'type', tur);
END
$fn$;

-- Yeni borçlu / föy. Müvekkil `client` (kayıt kimliği), `clientIdentity` (TC / vergi no) ya da
-- `clientName` (tam ad) ile gösterilir; tam olarak bir etkin müvekkile denk gelmelidir.
CREATE OR REPLACE FUNCTION han_excel.foy_ekle(kayit jsonb, kaynak jsonb, sadece_kontrol boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  buro CONSTANT uuid := '00000000-0000-0000-0000-000000000001';
  turler CONSTANT text[] := ARRAY['Senet', 'Çek', 'Sözleşme', 'Cari Ekstre', 'İlam', 'Fatura', 'Diğer'];
  izinli CONSTANT text[] := ARRAY[
    'client', 'clientIdentity', 'clientName', 'clientParty', 'debtor', 'debtorType', 'identity', 'taxOffice',
    'officeIdentity', 'phone1', 'phone2', 'referencePhone1', 'referencePhone2', 'officePhone1', 'officePhone2',
    'additionalPhones', 'city', 'district', 'address', 'address2', 'address2City', 'address2District',
    'officeAddress3', 'officeAddress3City', 'officeAddress3District', 'docType', 'amount', 'originalAmount',
    'preTrackingPayment', 'due', 'issued', 'trackingDate', 'serial', 'enforcementOffice', 'enforcementFileNumber',
    'icramatikFolioNumber', 'originalDocument', 'deliveredBy', 'receivedBy', 'notes', 'bank', 'branch', 'account',
    'contractSubject', 'court', 'courtFile', 'decisionDate', 'invoiceSubject', 'otherDocumentDescription'
  ];
  bugun CONSTANT text := to_char(clock_timestamp() AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD');
  alan text;
  iz jsonb;
  mevcut text;
  gosterim integer;
  muvekkil_id text;
  muvekkil_adi text;
  eslesen integer;
  aranan text;
  borclu text;
  borclu_turu text;
  kimlik text;
  buro_kimlik text;
  evrak_turu text;
  tutar numeric;
  asil numeric;
  on_odeme numeric;
  vade text;
  takip text;
  seri text;
  icra_no text;
  asil_evrak text;
  durum text;
  numara text;
  yeni_id text;
  govde jsonb;
BEGIN
  IF kayit IS NULL OR jsonb_typeof(kayit) <> 'object' THEN
    PERFORM han_excel._hata('HX400', 'Föy bilgisi bir JSON nesnesi olmalı.');
  END IF;
  FOR alan IN SELECT jsonb_object_keys(kayit) LOOP
    IF NOT alan = ANY (izinli) THEN
      PERFORM han_excel._hata('HX400', format('Föyde desteklenmeyen alan: %s', alan));
    END IF;
  END LOOP;
  iz := han_excel._kaynak(kaynak);
  PERFORM pg_advisory_xact_lock(hashtextextended('han_excel:' || buro::text, 0));

  SELECT d.id INTO mevcut FROM han_data.documents d
  WHERE d.tenant_id = buro AND han_excel._ayni_kaynak(d.body -> 'sourceImport', iz) LIMIT 1;
  IF mevcut IS NOT NULL THEN
    RETURN jsonb_build_object(
      'durum', 'tekrar', 'id', mevcut,
      'number', (SELECT d.number FROM han_data.documents d WHERE d.tenant_id = buro AND d.id = mevcut),
      'mesaj', 'Bu Excel satırı daha önce aktarılmış; yeni föy açılmadı.'
    );
  END IF;

  -- The client: exactly one way of naming it, and exactly one active client behind it.
  gosterim := (han_excel._metin(kayit, 'client', 80) <> '')::integer
    + (han_excel._metin(kayit, 'clientIdentity', 40) <> '')::integer
    + (han_excel._metin(kayit, 'clientName', 200) <> '')::integer;
  IF gosterim <> 1 THEN
    PERFORM han_excel._hata('HX400', 'Müvekkili "client" (kayıt kimliği), "clientIdentity" (TC / vergi no) ya da "clientName" alanlarından yalnızca biriyle gösterin.');
  END IF;
  IF han_excel._metin(kayit, 'client', 80) <> '' THEN
    aranan := han_excel._metin(kayit, 'client', 80);
    SELECT count(*), min(c.id), min(c.name) INTO eslesen, muvekkil_id, muvekkil_adi
    FROM han_data.clients c WHERE c.tenant_id = buro AND c.active AND c.id = aranan;
  ELSIF han_excel._metin(kayit, 'clientIdentity', 40) <> '' THEN
    aranan := han_excel._kimlik(kayit, 'clientIdentity');
    SELECT count(*), min(c.id), min(c.name) INTO eslesen, muvekkil_id, muvekkil_adi
    FROM han_data.clients c WHERE c.tenant_id = buro AND c.active
      AND regexp_replace(coalesce(c.body ->> 'identity', ''), '[[:space:]]', '', 'g') = aranan;
  ELSE
    aranan := han_excel._ad_anahtari(han_excel._metin(kayit, 'clientName', 200));
    SELECT count(*), min(c.id), min(c.name) INTO eslesen, muvekkil_id, muvekkil_adi
    FROM han_data.clients c WHERE c.tenant_id = buro AND c.active
      AND aranan IN (
        han_excel._ad_anahtari(c.name), han_excel._ad_anahtari(c.body ->> 'fullName'), han_excel._ad_anahtari(c.body ->> 'tradeName')
      );
  END IF;
  IF eslesen = 0 THEN
    PERFORM han_excel._hata('HX404', 'Geçerli bir müvekkil seçin: bu bilgiyle kayıtlı etkin müvekkil yok.');
  ELSIF eslesen > 1 THEN
    PERFORM han_excel._hata('HX409', 'Bu bilgi birden fazla müvekkille eşleşiyor; müvekkili TC / vergi numarası ya da kayıt kimliğiyle gösterin.');
  END IF;

  borclu := han_excel._metin(kayit, 'debtor', 200);
  evrak_turu := han_excel._metin(kayit, 'docType', 30);
  IF borclu = '' OR NOT evrak_turu = ANY (turler) THEN
    PERFORM han_excel._hata('HX400', 'Evrak türü ve borçlu adı gerekli. Evrak türü: Senet, Çek, Sözleşme, Cari Ekstre, İlam, Fatura, Diğer.');
  END IF;
  borclu_turu := han_excel._metin(kayit, 'debtorType', 10);
  IF borclu_turu NOT IN ('', 'Şahıs', 'Şirket') THEN
    PERFORM han_excel._hata('HX400', 'Borçlu türü ("debtorType") Şahıs ya da Şirket olmalı.');
  END IF;
  kimlik := han_excel._kimlik(kayit, 'identity');
  buro_kimlik := han_excel._kimlik(kayit, 'officeIdentity');

  -- Amounts in lira. "amount" is what is followed up: the face value less what was paid before.
  tutar := han_excel._tutar(kayit, 'amount');
  asil := han_excel._tutar(kayit, 'originalAmount');
  on_odeme := coalesce(han_excel._tutar(kayit, 'preTrackingPayment'), 0);
  IF tutar IS NULL AND asil IS NOT NULL THEN
    tutar := asil - on_odeme;
  END IF;
  IF tutar IS NULL OR tutar < 0 THEN
    PERFORM han_excel._hata('HX400', 'Geçerli evrak tutarı girin ("amount").');
  END IF;
  asil := coalesce(asil, tutar + on_odeme);
  IF asil - on_odeme <> tutar THEN
    PERFORM han_excel._hata('HX400', 'Tutar ("amount"), evrak tutarından ("originalAmount") takip öncesi ödeme ("preTrackingPayment") düşülünce kalan olmalı.');
  END IF;

  vade := han_excel._tarih(kayit, 'due');
  takip := coalesce(nullif(han_excel._tarih(kayit, 'trackingDate'), ''), bugun);
  IF takip > bugun THEN
    PERFORM han_excel._hata('HX400', 'Takip tarihi ("trackingDate") bugünden ileri olamaz.');
  END IF;
  seri := han_excel._metin(kayit, 'serial', 80);
  icra_no := han_excel._metin(kayit, 'enforcementFileNumber', 60);
  asil_evrak := coalesce(nullif(han_excel._metin(kayit, 'originalDocument', 20), ''), 'Firmada');
  IF asil_evrak NOT IN ('Alındı', 'Firmada') THEN
    PERFORM han_excel._hata('HX400', 'Evrak aslı ("originalDocument") Alındı ya da Firmada olmalı.');
  END IF;
  durum := CASE WHEN icra_no <> '' THEN 'İcra' ELSE 'Derdest' END;

  -- The application's rule (lib/record-store/intake.cjs): a debtor's TC / tax number may not
  -- be a client's, nor another debtor's under a different name.
  IF kimlik <> '' AND (
    EXISTS (
      SELECT 1 FROM han_data.clients c WHERE c.tenant_id = buro AND c.active
        AND regexp_replace(coalesce(c.body ->> 'identity', ''), '[[:space:]]', '', 'g') = kimlik
    ) OR EXISTS (
      SELECT 1 FROM han_data.documents d WHERE d.tenant_id = buro AND d.active
        AND regexp_replace(coalesce(d.body ->> 'identity', ''), '[[:space:]]', '', 'g') = kimlik
        AND han_excel._ad_anahtari(d.body ->> 'debtor') <> han_excel._ad_anahtari(borclu)
    )
  ) THEN
    PERFORM han_excel._hata('HX409', 'Bu TC kimlik / vergi numarası başka bir müvekkil veya borçluda kayıtlı. Kayıt yapılamadı.');
  END IF;
  -- The same file is not opened twice, whichever spreadsheet it comes from.
  SELECT d.number INTO mevcut FROM han_data.documents d
  WHERE d.tenant_id = buro AND d.active AND d.client_id = muvekkil_id AND d.kind = evrak_turu
    AND han_excel._ad_anahtari(d.body ->> 'debtor') = han_excel._ad_anahtari(borclu)
    AND coalesce(d.body ->> 'due', '') = vade
    AND coalesce(d.body ->> 'serial', '') = seri
    AND CASE WHEN coalesce(d.body ->> 'amount', '') ~ '^[0-9]+(\.[0-9]+)?$'
          THEN round((d.body ->> 'amount')::numeric * 100) = round(tutar * 100) ELSE false END
  LIMIT 1;
  IF mevcut IS NOT NULL THEN
    PERFORM han_excel._hata('HX409', format('Aynı müvekkil, borçlu, evrak türü, tutar, vade ve evrak numarasıyla kayıtlı bir föy var (föy no %s). Kayıt yapılamadı.', mevcut));
  END IF;

  IF sadece_kontrol THEN
    RETURN jsonb_build_object('durum', 'kontrol_tamam', 'client', muvekkil_id, 'clientName', muvekkil_adi, 'debtor', borclu, 'status', durum);
  END IF;

  -- The next folio number, exactly as the application takes it (lib/record-store/folio-numbers.cjs).
  INSERT INTO han_data.document_sequences (tenant_id, prefix, last_value)
  SELECT buro, 'GLOBAL', greatest(
    coalesce(
      (SELECT s.last_value FROM han_data.document_sequences s WHERE s.tenant_id = buro AND s.prefix = 'GLOBAL'),
      (SELECT max(s.last_value) FROM han_data.document_sequences s WHERE s.tenant_id = buro),
      0
    ),
    coalesce(
      (SELECT max(substring(d.number FROM '([0-9]+)$')::bigint) FROM han_data.documents d WHERE d.tenant_id = buro AND d.number ~ '[0-9]+$'),
      0
    )
  ) + 1
  ON CONFLICT (tenant_id, prefix) DO UPDATE
    SET last_value = greatest(han_data.document_sequences.last_value, EXCLUDED.last_value - 1) + 1
  RETURNING last_value::text INTO numara;

  yeni_id := gen_random_uuid()::text;
  govde := jsonb_build_object(
    'id', yeni_id,
    'number', numara,
    'client', muvekkil_id,
    'clientParty', han_excel._metin(kayit, 'clientParty', 200),
    'debtor', borclu,
    'debtorType', borclu_turu,
    'identity', kimlik,
    'taxOffice', han_excel._metin(kayit, 'taxOffice', 120),
    'officeIdentity', buro_kimlik,
    'phone1', left(han_excel._telefon(han_excel._metin(kayit, 'phone1', 40)), 40),
    'phone2', left(han_excel._telefon(han_excel._metin(kayit, 'phone2', 40)), 40),
    'referencePhone1', left(han_excel._telefon(han_excel._metin(kayit, 'referencePhone1', 40)), 40),
    'referencePhone2', left(han_excel._telefon(han_excel._metin(kayit, 'referencePhone2', 40)), 40),
    'officePhone1', left(han_excel._telefon(han_excel._metin(kayit, 'officePhone1', 40)), 40),
    'officePhone2', left(han_excel._telefon(han_excel._metin(kayit, 'officePhone2', 40)), 40),
    'additionalPhones', han_excel._telefonlar(kayit, 'additionalPhones'),
    'additionalAddresses', '[]'::jsonb,
    'city', han_excel._metin(kayit, 'city', 60),
    'district', han_excel._metin(kayit, 'district', 60),
    'address', han_excel._metin(kayit, 'address', 500),
    'address2', han_excel._metin(kayit, 'address2', 500),
    'address2City', han_excel._metin(kayit, 'address2City', 60),
    'address2District', han_excel._metin(kayit, 'address2District', 60),
    'officeAddress3', han_excel._metin(kayit, 'officeAddress3', 500),
    'officeAddress3City', han_excel._metin(kayit, 'officeAddress3City', 60),
    'officeAddress3District', han_excel._metin(kayit, 'officeAddress3District', 60)
  ) || jsonb_build_object(
    'docType', evrak_turu,
    'amount', to_jsonb(trim_scale(tutar)),
    'originalAmount', to_jsonb(trim_scale(asil)),
    'preTrackingPayment', to_jsonb(trim_scale(on_odeme)),
    'due', vade,
    'issued', han_excel._tarih(kayit, 'issued'),
    'serial', seri,
    'status', durum,
    'enforcementOffice', han_excel._metin(kayit, 'enforcementOffice', 120),
    'enforcementFileNumber', icra_no,
    'icramatikFolioNumber', han_excel._metin(kayit, 'icramatikFolioNumber', 60),
    'originalDocument', asil_evrak,
    'deliveredBy', han_excel._metin(kayit, 'deliveredBy', 120),
    'receivedBy', han_excel._metin(kayit, 'receivedBy', 120),
    'receivedById', '',
    'recordedBy', '',
    'recordedByName', 'Excel Aktarımı',
    'notes', han_excel._metin(kayit, 'notes', 2000),
    'bank', han_excel._metin(kayit, 'bank', 120),
    'branch', han_excel._metin(kayit, 'branch', 120),
    'account', han_excel._metin(kayit, 'account', 60),
    'contractSubject', han_excel._metin(kayit, 'contractSubject', 300),
    'court', han_excel._metin(kayit, 'court', 200),
    'courtFile', han_excel._metin(kayit, 'courtFile', 80),
    'decisionDate', han_excel._tarih(kayit, 'decisionDate'),
    'invoiceSubject', han_excel._metin(kayit, 'invoiceSubject', 300),
    'otherDocumentDescription', han_excel._metin(kayit, 'otherDocumentDescription', 300)
  ) || jsonb_build_object(
    'guarantors', '[]'::jsonb,
    'attachments', '[]'::jsonb,
    'conversations', '[]'::jsonb,
    'tapuDetails', '',
    'vehicleDetails', '',
    'sgkDetails', '',
    'created', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'trackingDate', takip,
    'sourceImport', iz
  );

  INSERT INTO han_data.documents (tenant_id, id, body, ordinal, active)
  VALUES (buro, yeni_id, govde, (extract(epoch FROM clock_timestamp()) * 1000)::bigint, true);
  INSERT INTO han_private.han_audit (tenant_id, category, action, area, actor_id, actor_name, actor_username, record_ref, fields)
  VALUES (buro, 'changes', 'create', 'Evraklar', NULL, 'Excel Aktarımı', session_user, yeni_id, '{}');

  RETURN jsonb_build_object(
    'durum', 'eklendi', 'id', yeni_id, 'number', numara, 'client', muvekkil_id, 'clientName', muvekkil_adi, 'status', durum
  );
END
$fn$;

-- Ownership and who may call what.
DO $own$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS imza, p.proname
    FROM pg_proc p WHERE p.pronamespace = 'han_excel'::regnamespace
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO han_excel_yazici', f.imza);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.imza);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM han_excel_aktarim', f.imza);
    IF f.proname IN ('durum', 'muvekkil_ekle', 'foy_ekle') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO han_excel_aktarim', f.imza);
    END IF;
  END LOOP;
END
$own$;

COMMENT ON SCHEMA han_excel IS 'Excel aktarımı için sınırlı ekleme işlevleri (ops/excel-aktarim). Kaldırmak için kaldir.sql.';

COMMIT;
