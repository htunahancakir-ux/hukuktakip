-- Excel aktarımı: düz sütunlu iki "tablo" (görünüm). kur.sql'den SONRA, süper kullanıcıyla
-- çalıştırılır; tekrar çalıştırmak zararsızdır:
--   runuser -u postgres -- psql -d hanhukuk -X -q -v ON_ERROR_STOP=1 -f tablolar.sql
--
-- han_excel_aktarim bu iki görünüme sıradan INSERT yazar:
--   INSERT INTO han_excel.muvekkil (unvan, vergi_kimlik_no, telefon, kaynak_dosya, kaynak_satir) VALUES (...);
--   INSERT INTO han_excel.foy (muvekkil_vergi_kimlik_no, borclu, evrak_turu, tutar, kaynak_dosya, kaynak_satir) VALUES (...);
-- Her satır, kur.sql'deki han_excel.muvekkil_ekle / han_excel.foy_ekle işlevinden geçer; yani
-- bütün kurallar (müvekkil bağlantısı, kimlik çakışması, föy numarası, günlük, tekrar aktarım)
-- aynen uygulanır. Kullanıcının yetkisi: girdi sütunlarına INSERT; yalnızca kimlik, föy
-- numarası, durum ve kaynak sütunlarını SELECT (kendi aktardığı satırlar için). UPDATE ve DELETE
-- yoktur; ad, kimlik numarası, telefon, adres gibi sütunlar geri OKUNAMAZ.

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP VIEW IF EXISTS han_excel.muvekkil;
DROP VIEW IF EXISTS han_excel.foy;

-- "0532 ...; 0216 ..." -> ["0532 ...", "0216 ..."]
CREATE OR REPLACE FUNCTION han_excel._liste(deger text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT CASE WHEN deger IS NULL THEN NULL ELSE coalesce(
    (SELECT jsonb_agg(btrim(parca)) FROM regexp_split_to_table(deger, '[;,\n]') AS parca WHERE btrim(parca) <> ''),
    '[]'::jsonb
  ) END;
$fn$;

-- Only what this import itself added is visible through the views.
CREATE VIEW han_excel.muvekkil AS
SELECT
  c.id,
  c.body ->> 'type' AS tur,
  c.body ->> 'tradeName' AS unvan,
  c.body ->> 'fullName' AS ad_soyad,
  c.body ->> 'identity' AS vergi_kimlik_no,
  c.body ->> 'taxOffice' AS vergi_dairesi,
  c.body ->> 'mersisNumber' AS mersis_no,
  c.body ->> 'phone' AS telefon,
  (SELECT string_agg(numara, '; ') FROM jsonb_array_elements_text(c.body -> 'additionalPhones') AS numara) AS ek_telefonlar,
  c.body ->> 'email' AS eposta,
  c.body ->> 'address' AS adres,
  c.body ->> 'city' AS il,
  c.body ->> 'district' AS ilce,
  c.body ->> 'clientCategory' AS kategori,
  c.body ->> 'reference' AS referans,
  c.body ->> 'notes' AS notlar,
  c.body ->> 'iban' AS iban,
  c.body ->> 'bankName' AS banka,
  c.body ->> 'bankBranch' AS banka_subesi,
  c.body ->> 'accountHolder' AS hesap_sahibi,
  c.body -> 'sourceImport' ->> 'file' AS kaynak_dosya,
  c.body -> 'sourceImport' ->> 'sheet' AS kaynak_sayfa,
  (c.body -> 'sourceImport' ->> 'row')::integer AS kaynak_satir,
  c.body -> 'sourceImport' ->> 'sha256' AS kaynak_sha256,
  false AS sadece_kontrol,
  c.body ->> 'createdAt' AS eklenme
FROM han_data.clients c
WHERE c.tenant_id = '00000000-0000-0000-0000-000000000001'::uuid AND c.active
  AND c.body ->> 'recordedByName' = 'Excel Aktarımı' AND jsonb_typeof(c.body -> 'sourceImport') = 'object';

CREATE VIEW han_excel.foy AS
SELECT
  d.id,
  d.number AS foy_no,
  d.status AS durum,
  d.client_id AS muvekkil_id,
  NULL::text AS muvekkil_vergi_kimlik_no,
  NULL::text AS muvekkil_adi,
  d.body ->> 'debtor' AS borclu,
  d.body ->> 'debtorType' AS borclu_turu,
  d.body ->> 'identity' AS borclu_kimlik_no,
  d.body ->> 'taxOffice' AS borclu_vergi_dairesi,
  d.body ->> 'officeIdentity' AS isyeri_kimlik_no,
  d.body ->> 'phone1' AS telefon1,
  d.body ->> 'phone2' AS telefon2,
  d.body ->> 'referencePhone1' AS referans_telefon1,
  d.body ->> 'referencePhone2' AS referans_telefon2,
  d.body ->> 'officePhone1' AS isyeri_telefon1,
  d.body ->> 'officePhone2' AS isyeri_telefon2,
  (SELECT string_agg(numara, '; ') FROM jsonb_array_elements_text(d.body -> 'additionalPhones') AS numara) AS ek_telefonlar,
  d.body ->> 'city' AS il,
  d.body ->> 'district' AS ilce,
  d.body ->> 'address' AS adres,
  d.body ->> 'address2' AS adres2,
  d.body ->> 'address2City' AS adres2_il,
  d.body ->> 'address2District' AS adres2_ilce,
  d.body ->> 'officeAddress3' AS isyeri_adresi,
  d.body ->> 'officeAddress3City' AS isyeri_il,
  d.body ->> 'officeAddress3District' AS isyeri_ilce,
  d.body ->> 'docType' AS evrak_turu,
  (d.body ->> 'amount')::numeric AS tutar,
  (d.body ->> 'originalAmount')::numeric AS evrak_tutari,
  (d.body ->> 'preTrackingPayment')::numeric AS takip_oncesi_odeme,
  nullif(d.body ->> 'due', '')::date AS vade,
  nullif(d.body ->> 'issued', '')::date AS duzenleme_tarihi,
  nullif(d.body ->> 'trackingDate', '')::date AS takip_tarihi,
  d.body ->> 'serial' AS evrak_no,
  d.body ->> 'clientParty' AS alacakli_taraf,
  d.body ->> 'enforcementOffice' AS icra_dairesi,
  d.body ->> 'enforcementFileNumber' AS icra_dosya_no,
  d.body ->> 'icramatikFolioNumber' AS icramatik_foy_no,
  d.body ->> 'originalDocument' AS evrak_asli,
  d.body ->> 'deliveredBy' AS teslim_eden,
  d.body ->> 'receivedBy' AS teslim_alan,
  d.body ->> 'notes' AS notlar,
  d.body ->> 'bank' AS banka,
  d.body ->> 'branch' AS sube,
  d.body ->> 'account' AS hesap,
  d.body ->> 'contractSubject' AS sozlesme_konusu,
  d.body ->> 'court' AS mahkeme,
  d.body ->> 'courtFile' AS mahkeme_dosya_no,
  nullif(d.body ->> 'decisionDate', '')::date AS karar_tarihi,
  d.body ->> 'invoiceSubject' AS fatura_konusu,
  d.body ->> 'otherDocumentDescription' AS diger_evrak_aciklamasi,
  d.body -> 'sourceImport' ->> 'file' AS kaynak_dosya,
  d.body -> 'sourceImport' ->> 'sheet' AS kaynak_sayfa,
  (d.body -> 'sourceImport' ->> 'row')::integer AS kaynak_satir,
  d.body -> 'sourceImport' ->> 'sha256' AS kaynak_sha256,
  false AS sadece_kontrol,
  d.body ->> 'created' AS eklenme
FROM han_data.documents d
WHERE d.tenant_id = '00000000-0000-0000-0000-000000000001'::uuid AND d.active
  AND d.body ->> 'recordedByName' = 'Excel Aktarımı' AND jsonb_typeof(d.body -> 'sourceImport') = 'object';

-- Each inserted row goes through the checked function. A row that was imported before, or a
-- check-only row, inserts nothing (INSERT 0 0) and says so in a notice.
CREATE OR REPLACE FUNCTION han_excel._muvekkil_satiri() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  sonuc jsonb;
BEGIN
  sonuc := han_excel.muvekkil_ekle(
    jsonb_strip_nulls(jsonb_build_object(
      'type', NEW.tur, 'tradeName', NEW.unvan, 'fullName', NEW.ad_soyad, 'identity', NEW.vergi_kimlik_no,
      'taxOffice', NEW.vergi_dairesi, 'mersisNumber', NEW.mersis_no, 'phone', NEW.telefon,
      'additionalPhones', han_excel._liste(NEW.ek_telefonlar), 'email', NEW.eposta, 'address', NEW.adres,
      'city', NEW.il, 'district', NEW.ilce, 'clientCategory', NEW.kategori, 'reference', NEW.referans,
      'notes', NEW.notlar, 'iban', NEW.iban, 'bankName', NEW.banka, 'bankBranch', NEW.banka_subesi,
      'accountHolder', NEW.hesap_sahibi
    )),
    jsonb_strip_nulls(jsonb_build_object(
      'file', NEW.kaynak_dosya, 'sheet', NEW.kaynak_sayfa, 'row', NEW.kaynak_satir, 'sha256', NEW.kaynak_sha256
    )),
    coalesce(NEW.sadece_kontrol, false)
  );
  IF sonuc ->> 'durum' = 'eklendi' THEN
    NEW.id := sonuc ->> 'id';
    NEW.tur := sonuc ->> 'type';
    NEW.sadece_kontrol := false;
    NEW.eklenme := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    RETURN NEW;
  END IF;
  RAISE NOTICE '% satır %: %', coalesce(NEW.kaynak_dosya, ''), NEW.kaynak_satir,
    CASE sonuc ->> 'durum' WHEN 'tekrar' THEN 'daha önce aktarılmış, yeni müvekkil açılmadı' ELSE 'kontrol tamam, kayıt açılmadı' END;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION han_excel._foy_satiri() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  sonuc jsonb;
BEGIN
  sonuc := han_excel.foy_ekle(
    jsonb_strip_nulls(jsonb_build_object(
      'client', NEW.muvekkil_id, 'clientIdentity', NEW.muvekkil_vergi_kimlik_no, 'clientName', NEW.muvekkil_adi,
      'debtor', NEW.borclu, 'debtorType', NEW.borclu_turu, 'identity', NEW.borclu_kimlik_no,
      'taxOffice', NEW.borclu_vergi_dairesi, 'officeIdentity', NEW.isyeri_kimlik_no,
      'phone1', NEW.telefon1, 'phone2', NEW.telefon2, 'referencePhone1', NEW.referans_telefon1,
      'referencePhone2', NEW.referans_telefon2, 'officePhone1', NEW.isyeri_telefon1, 'officePhone2', NEW.isyeri_telefon2,
      'additionalPhones', han_excel._liste(NEW.ek_telefonlar), 'city', NEW.il, 'district', NEW.ilce,
      'address', NEW.adres, 'address2', NEW.adres2, 'address2City', NEW.adres2_il, 'address2District', NEW.adres2_ilce,
      'officeAddress3', NEW.isyeri_adresi, 'officeAddress3City', NEW.isyeri_il, 'officeAddress3District', NEW.isyeri_ilce
    ) || jsonb_build_object(
      'docType', NEW.evrak_turu, 'amount', NEW.tutar, 'originalAmount', NEW.evrak_tutari,
      'preTrackingPayment', NEW.takip_oncesi_odeme, 'due', to_char(NEW.vade, 'YYYY-MM-DD'),
      'issued', to_char(NEW.duzenleme_tarihi, 'YYYY-MM-DD'), 'trackingDate', to_char(NEW.takip_tarihi, 'YYYY-MM-DD'),
      'serial', NEW.evrak_no, 'clientParty', NEW.alacakli_taraf, 'enforcementOffice', NEW.icra_dairesi,
      'enforcementFileNumber', NEW.icra_dosya_no, 'icramatikFolioNumber', NEW.icramatik_foy_no,
      'originalDocument', NEW.evrak_asli, 'deliveredBy', NEW.teslim_eden, 'receivedBy', NEW.teslim_alan,
      'notes', NEW.notlar, 'bank', NEW.banka, 'branch', NEW.sube, 'account', NEW.hesap,
      'contractSubject', NEW.sozlesme_konusu, 'court', NEW.mahkeme, 'courtFile', NEW.mahkeme_dosya_no,
      'decisionDate', to_char(NEW.karar_tarihi, 'YYYY-MM-DD'), 'invoiceSubject', NEW.fatura_konusu,
      'otherDocumentDescription', NEW.diger_evrak_aciklamasi
    )),
    jsonb_strip_nulls(jsonb_build_object(
      'file', NEW.kaynak_dosya, 'sheet', NEW.kaynak_sayfa, 'row', NEW.kaynak_satir, 'sha256', NEW.kaynak_sha256
    )),
    coalesce(NEW.sadece_kontrol, false)
  );
  IF sonuc ->> 'durum' = 'eklendi' THEN
    NEW.id := sonuc ->> 'id';
    NEW.foy_no := sonuc ->> 'number';
    NEW.durum := sonuc ->> 'status';
    NEW.muvekkil_id := sonuc ->> 'client';
    NEW.sadece_kontrol := false;
    NEW.eklenme := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    RETURN NEW;
  END IF;
  RAISE NOTICE '% satır %: %', coalesce(NEW.kaynak_dosya, ''), NEW.kaynak_satir,
    CASE sonuc ->> 'durum' WHEN 'tekrar' THEN format('daha önce aktarılmış (föy no %s), yeni föy açılmadı', sonuc ->> 'number') ELSE 'kontrol tamam, kayıt açılmadı' END;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER muvekkil_ekle INSTEAD OF INSERT ON han_excel.muvekkil
  FOR EACH ROW EXECUTE FUNCTION han_excel._muvekkil_satiri();
CREATE TRIGGER foy_ekle INSTEAD OF INSERT ON han_excel.foy
  FOR EACH ROW EXECUTE FUNCTION han_excel._foy_satiri();

ALTER VIEW han_excel.muvekkil OWNER TO han_excel_yazici;
ALTER VIEW han_excel.foy OWNER TO han_excel_yazici;
ALTER FUNCTION han_excel._liste(text) OWNER TO han_excel_yazici;
ALTER FUNCTION han_excel._muvekkil_satiri() OWNER TO han_excel_yazici;
ALTER FUNCTION han_excel._foy_satiri() OWNER TO han_excel_yazici;
REVOKE ALL ON FUNCTION han_excel._liste(text), han_excel._muvekkil_satiri(), han_excel._foy_satiri() FROM PUBLIC;
REVOKE ALL ON han_excel.muvekkil, han_excel.foy FROM PUBLIC, han_excel_aktarim;

-- Input columns may be written; only identifiers come back.
GRANT INSERT (
  tur, unvan, ad_soyad, vergi_kimlik_no, vergi_dairesi, mersis_no, telefon, ek_telefonlar, eposta, adres, il, ilce,
  kategori, referans, notlar, iban, banka, banka_subesi, hesap_sahibi,
  kaynak_dosya, kaynak_sayfa, kaynak_satir, kaynak_sha256, sadece_kontrol
) ON han_excel.muvekkil TO han_excel_aktarim;
GRANT SELECT (id, kaynak_dosya, kaynak_sayfa, kaynak_satir, eklenme) ON han_excel.muvekkil TO han_excel_aktarim;

GRANT INSERT (
  muvekkil_id, muvekkil_vergi_kimlik_no, muvekkil_adi, borclu, borclu_turu, borclu_kimlik_no, borclu_vergi_dairesi,
  isyeri_kimlik_no, telefon1, telefon2, referans_telefon1, referans_telefon2, isyeri_telefon1, isyeri_telefon2,
  ek_telefonlar, il, ilce, adres, adres2, adres2_il, adres2_ilce, isyeri_adresi, isyeri_il, isyeri_ilce,
  evrak_turu, tutar, evrak_tutari, takip_oncesi_odeme, vade, duzenleme_tarihi, takip_tarihi, evrak_no,
  alacakli_taraf, icra_dairesi, icra_dosya_no, icramatik_foy_no, evrak_asli, teslim_eden, teslim_alan, notlar,
  banka, sube, hesap, sozlesme_konusu, mahkeme, mahkeme_dosya_no, karar_tarihi, fatura_konusu,
  diger_evrak_aciklamasi, kaynak_dosya, kaynak_sayfa, kaynak_satir, kaynak_sha256, sadece_kontrol
) ON han_excel.foy TO han_excel_aktarim;
GRANT SELECT (id, foy_no, durum, muvekkil_id, kaynak_dosya, kaynak_sayfa, kaynak_satir, eklenme) ON han_excel.foy TO han_excel_aktarim;

COMMIT;
