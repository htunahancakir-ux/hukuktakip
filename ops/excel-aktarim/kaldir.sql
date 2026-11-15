-- Excel aktarımı erişimini kaldırır. Büro veritabanında süper kullanıcıyla çalıştırılır:
--   runuser -u postgres -- psql -d hanhukuk -X -v ON_ERROR_STOP=1 -f kaldir.sql
-- Aktarılmış müvekkil ve föyler yerinde kalır; yalnızca erişim, işlevler ve roller gider.
-- Ardından pg_hba.conf içindeki han_excel_aktarim satırlarını silip PostgreSQL'i yeniden
-- yükleyin ve sunucudaki tünel kullanıcısını kaldırın (bkz. README.md).

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS excel_aktarim_oku ON han_data.clients;
DROP POLICY IF EXISTS excel_aktarim_ekle ON han_data.clients;
DROP POLICY IF EXISTS excel_aktarim_oku ON han_data.documents;
DROP POLICY IF EXISTS excel_aktarim_ekle ON han_data.documents;
DROP POLICY IF EXISTS excel_aktarim_oku ON han_data.document_sequences;
DROP POLICY IF EXISTS excel_aktarim_ekle ON han_data.document_sequences;
DROP POLICY IF EXISTS excel_aktarim_ilerlet ON han_data.document_sequences;
DROP POLICY IF EXISTS excel_aktarim_ekle ON han_private.han_audit;

DROP SCHEMA IF EXISTS han_excel CASCADE;

DO $drop$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['han_excel_aktarim', 'han_excel_yazici'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      -- Open sessions of the login role end here.
      PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = r;
      EXECUTE format('DROP OWNED BY %I', r);
    END IF;
  END LOOP;
END
$drop$;

COMMIT;

-- Roles are shared by every database of the server: drop them only once no other database
-- (for example a test copy) still refers to them.
DO $roles$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['han_excel_aktarim', 'han_excel_yazici'] LOOP
    BEGIN
      EXECUTE format('DROP ROLE IF EXISTS %I', r);
    EXCEPTION WHEN dependent_objects_still_exist THEN
      RAISE NOTICE 'Rol % başka bir veritabanında hâlâ kullanılıyor; orada da kaldir.sql çalıştırın.', r;
    END;
  END LOOP;
END
$roles$;
