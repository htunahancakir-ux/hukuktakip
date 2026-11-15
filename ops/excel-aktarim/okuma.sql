-- Excel aktarımı kullanıcısına OKUMA yetkisi. kur.sql ve tablolar.sql'den SONRA, süper
-- kullanıcıyla çalıştırılır; tekrar çalıştırmak zararsızdır:
--   runuser -u postgres -- psql -d hanhukuk -X -q -v ON_ERROR_STOP=1 -f okuma.sql
--
-- han_excel_aktarim, mevcut büronun kayıt tablolarını (han_data.clients, documents,
-- financial_events, ...) SELECT ile okuyabilir. Satır güvenliği onu yine tek büroya bağlar;
-- UPDATE, DELETE ve doğrudan INSERT verilmez (ekleme yalnızca han_excel.muvekkil / foy üzerinden).
--
-- Okuma DIŞINDA kalanlar:
--   han_data.metadata  kullanıcıların şifre özetleri, entegrasyon anahtarları, kurtarma kodları
--   han_data.control   depo durumu
--   han_private.*      oturumlar, işlem günlüğü, eski durum kopyası, telefon ayarları
--   han_saas.*         platform (konsol) verisi, öteki bürolar
-- Kullanıcı listesi şifre bilgisi olmadan han_excel.kullanicilar görünümünden okunur.

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';

GRANT USAGE ON SCHEMA han_data TO han_excel_aktarim;

DO $okuma$
DECLARE
  tablo record;
BEGIN
  FOR tablo IN
    SELECT c.relname AS ad
    FROM pg_class c
    WHERE c.relnamespace = 'han_data'::regnamespace AND c.relkind = 'r'
      AND c.relname NOT IN ('metadata', 'control')
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
    ORDER BY 1
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS excel_aktarim_okuma ON han_data.%I', tablo.ad);
    EXECUTE format(
      'CREATE POLICY excel_aktarim_okuma ON han_data.%I FOR SELECT TO han_excel_aktarim USING (tenant_id = %L::uuid)',
      tablo.ad, '00000000-0000-0000-0000-000000000001'
    );
    EXECUTE format('REVOKE ALL ON han_data.%I FROM han_excel_aktarim', tablo.ad);
    EXECUTE format('GRANT SELECT ON han_data.%I TO han_excel_aktarim', tablo.ad);
  END LOOP;
END
$okuma$;
REVOKE ALL ON han_data.metadata, han_data.control FROM han_excel_aktarim;

-- The office's accounts without anything that signs a person in.
DROP VIEW IF EXISTS han_excel.kullanicilar;
CREATE VIEW han_excel.kullanicilar AS
SELECT
  u ->> 'id' AS id,
  u ->> 'name' AS ad,
  u ->> 'username' AS kullanici_adi,
  u ->> 'role' AS rol,
  coalesce((u ->> 'active')::boolean, true) AS etkin,
  u ->> 'staffId' AS personel_id,
  u ->> 'email' AS eposta,
  u ->> 'mobilePhone' AS cep_telefonu,
  u -> 'permissions' AS yetkiler,
  coalesce((u ->> 'readOnly')::boolean, false) AS salt_okunur
FROM han_data.metadata m, jsonb_array_elements(m.body -> 'users') AS u
WHERE m.tenant_id = '00000000-0000-0000-0000-000000000001'::uuid AND m.id = 1
  AND coalesce((u ->> 'platformSupport')::boolean, false) = false;
-- Owned by the tables' owner so that it, and not the caller, reads the settings record.
ALTER VIEW han_excel.kullanicilar OWNER TO hanhukuk;
REVOKE ALL ON han_excel.kullanicilar FROM PUBLIC, han_excel_aktarim;
GRANT SELECT ON han_excel.kullanicilar TO han_excel_aktarim;

-- What the import itself added, in plain columns.
REVOKE ALL ON han_excel.muvekkil, han_excel.foy FROM han_excel_aktarim;
GRANT SELECT ON han_excel.muvekkil, han_excel.foy TO han_excel_aktarim;
GRANT INSERT (
  tur, unvan, ad_soyad, vergi_kimlik_no, vergi_dairesi, mersis_no, telefon, ek_telefonlar, eposta, adres, il, ilce,
  kategori, referans, notlar, iban, banka, banka_subesi, hesap_sahibi,
  kaynak_dosya, kaynak_sayfa, kaynak_satir, kaynak_sha256, sadece_kontrol
) ON han_excel.muvekkil TO han_excel_aktarim;
GRANT INSERT (
  muvekkil_id, muvekkil_vergi_kimlik_no, muvekkil_adi, borclu, borclu_turu, borclu_kimlik_no, borclu_vergi_dairesi,
  isyeri_kimlik_no, telefon1, telefon2, referans_telefon1, referans_telefon2, isyeri_telefon1, isyeri_telefon2,
  ek_telefonlar, il, ilce, adres, adres2, adres2_il, adres2_ilce, isyeri_adresi, isyeri_il, isyeri_ilce,
  evrak_turu, tutar, evrak_tutari, takip_oncesi_odeme, vade, duzenleme_tarihi, takip_tarihi, evrak_no,
  alacakli_taraf, icra_dairesi, icra_dosya_no, icramatik_foy_no, evrak_asli, teslim_eden, teslim_alan, notlar,
  banka, sube, hesap, sozlesme_konusu, mahkeme, mahkeme_dosya_no, karar_tarihi, fatura_konusu,
  diger_evrak_aciklamasi, kaynak_dosya, kaynak_sayfa, kaynak_satir, kaynak_sha256, sadece_kontrol
) ON han_excel.foy TO han_excel_aktarim;

COMMIT;
