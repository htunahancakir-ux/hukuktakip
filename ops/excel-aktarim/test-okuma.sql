-- Okuma yetkisi denemesi: han_excel_aktarim büronun kayıtlarını okuyabilmeli; başka büroyu,
-- gizli bölümleri okuyamamalı; hiçbir kaydı değiştirememeli, silememeli.
--
-- han_excel_aktarim olarak çalıştırılır. Yalnızca okur; yine de tek işlemde çalışır ve geri
-- alınır. Kayıt değeri yazdırmaz. Her satır TAMAM ya da HATA ile başlar.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET client_min_messages = notice;
BEGIN;

DO $test$
DECLARE
  tamam integer := 0;
  hata integer := 0;
  adet bigint;
  sutunlar text;
  kod text;
  ileti text;
  deneme record;
BEGIN
  -- 1. Kayıt tabloları okunabiliyor ve yalnızca mevcut büronun satırları görünüyor.
  FOR deneme IN
    SELECT unnest(ARRAY[
      'clients', 'documents', 'financial_events', 'ledger_entries', 'accounts', 'personnel', 'attachments',
      'conversations', 'messages', 'reminders', 'cases', 'document_balances', 'document_sequences',
      'document_archives', 'operation_archives', 'collection_notices', 'workflow_notices', 'work_orders',
      'staff_breaks', 'daily_bonuses'
    ]) AS ad
  LOOP
    BEGIN
      EXECUTE format('SELECT count(*) FROM han_data.%I WHERE tenant_id <> %L', deneme.ad, '00000000-0000-0000-0000-000000000001') INTO adet;
      IF adet = 0 THEN
        tamam := tamam + 1; RAISE NOTICE 'TAMAM  okunuyor, başka büronun satırı görünmüyor: %', deneme.ad;
      ELSE
        hata := hata + 1; RAISE NOTICE 'HATA   başka büronun % satırı görünüyor: %', adet, deneme.ad;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS kod = RETURNED_SQLSTATE, ileti = MESSAGE_TEXT;
      hata := hata + 1; RAISE NOTICE 'HATA   okunamadı (% %): %', kod, left(ileti, 70), deneme.ad;
    END;
  END LOOP;

  SELECT count(*) INTO adet FROM han_data.clients;
  IF adet > 0 THEN tamam := tamam + 1; RAISE NOTICE 'TAMAM  müvekkil kayıtları görünüyor';
  ELSE hata := hata + 1; RAISE NOTICE 'HATA   müvekkil kaydı görünmüyor'; END IF;
  SELECT count(*) INTO adet FROM han_data.documents d JOIN han_data.clients c ON c.id = d.client_id WHERE d.active;
  IF adet > 0 THEN tamam := tamam + 1; RAISE NOTICE 'TAMAM  föyler müvekkilleriyle birlikte sorgulanabiliyor';
  ELSE hata := hata + 1; RAISE NOTICE 'HATA   föy - müvekkil sorgusu boş döndü'; END IF;

  -- 2. Kullanıcı listesi şifre bilgisi olmadan okunuyor.
  SELECT count(*), (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(to_jsonb((SELECT k2 FROM han_excel.kullanicilar k2 LIMIT 1))) k)
    INTO adet, sutunlar FROM han_excel.kullanicilar;
  IF adet > 0 AND sutunlar !~* '(^|,)(hash|salt|sifre|parola|password)(,|$)' THEN
    tamam := tamam + 1; RAISE NOTICE 'TAMAM  kullanıcı listesi okunuyor; şifre bilgisi sütunu yok (%)', sutunlar;
  ELSE
    hata := hata + 1; RAISE NOTICE 'HATA   kullanıcı listesi beklenen gibi değil (% satır; %)', adet, sutunlar;
  END IF;

  -- 3. Gizli bölümler ve her türlü değiştirme kapalı.
  FOR deneme IN
    SELECT * FROM (VALUES
      ('ayar kaydını okuma (şifre özetleri, entegrasyon anahtarları)', 'SELECT body FROM han_data.metadata'),
      ('ayar kaydından kullanıcı şifre özetini okuma', $q$SELECT body -> 'users' FROM han_data.metadata$q$),
      ('depo durumunu okuma', 'SELECT mode FROM han_data.control'),
      ('işlem günlüğünü okuma', 'SELECT count(*) FROM han_private.han_audit'),
      ('oturumları okuma', 'SELECT count(*) FROM han_private.han_sessions'),
      ('eski durum kopyasını okuma', 'SELECT payload FROM han_private.han_state'),
      ('telefon santrali ayarlarını okuma', 'SELECT count(*) FROM han_private.voip_config'),
      ('büro listesini okuma', 'SELECT count(*) FROM han_saas.tenants'),
      ('platform ayarlarını okuma', 'SELECT count(*) FROM han_saas.platform_settings'),
      ('veritabanı kullanıcılarının şifre özetini okuma', 'SELECT rolpassword FROM pg_authid'),
      ('müvekkil değiştirme', $q$UPDATE han_data.clients SET body = body || '{"name": "x"}'$q$),
      ('müvekkil silme', 'DELETE FROM han_data.clients'),
      ('müvekkil arşivleme', 'UPDATE han_data.clients SET active = false'),
      ('föy değiştirme', $q$UPDATE han_data.documents SET body = body || '{"debtor": "x"}'$q$),
      ('föy silme', 'DELETE FROM han_data.documents'),
      ('föy tablosuna doğrudan ekleme', $q$INSERT INTO han_data.documents (tenant_id, id, body, ordinal) VALUES ('00000000-0000-0000-0000-000000000001', 'x', '{}', 1)$q$),
      ('tahsilat değiştirme', $q$UPDATE han_data.financial_events SET body = '{}'$q$),
      ('tahsilat silme', 'DELETE FROM han_data.financial_events'),
      ('tahsilat ekleme', $q$INSERT INTO han_data.financial_events (tenant_id, id, body, ordinal) VALUES ('00000000-0000-0000-0000-000000000001', 'x', '{}', 1)$q$),
      ('muhasebe kaydı silme', 'DELETE FROM han_data.ledger_entries'),
      ('personel kaydı değiştirme', $q$UPDATE han_data.personnel SET body = '{}'$q$),
      ('ek dosya silme', 'DELETE FROM han_data.attachments'),
      ('mesaj silme', 'DELETE FROM han_data.messages'),
      ('föy bakiyelerini silme', 'DELETE FROM han_data.document_balances'),
      ('föy numarası sayacını değiştirme', 'UPDATE han_data.document_sequences SET last_value = 0'),
      ('tablo boşaltma', 'TRUNCATE han_data.clients'),
      ('tablo silme', 'DROP TABLE han_data.clients'),
      ('kullanıcı listesini değiştirme', $q$UPDATE han_excel.kullanicilar SET rol = 'ceo'$q$),
      ('satır kilitleme (FOR UPDATE)', 'SELECT id FROM han_data.documents LIMIT 1 FOR UPDATE')
    ) AS t(ad, komut)
  LOOP
    BEGIN
      EXECUTE deneme.komut;
      hata := hata + 1; RAISE NOTICE 'HATA   reddedilmeliydi ama çalıştı: %', deneme.ad;
    EXCEPTION WHEN insufficient_privilege THEN
      tamam := tamam + 1; RAISE NOTICE 'TAMAM  reddedildi: %', deneme.ad;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS kod = RETURNED_SQLSTATE, ileti = MESSAGE_TEXT;
      -- 55000: the view cannot be written to at all.
      IF kod = '55000' THEN
        tamam := tamam + 1; RAISE NOTICE 'TAMAM  reddedildi (%): %', kod, deneme.ad;
      ELSE
        hata := hata + 1; RAISE NOTICE 'HATA   beklenmeyen yanıt (% %): %', kod, left(ileti, 80), deneme.ad;
      END IF;
    END;
  END LOOP;

  RAISE NOTICE 'OZET   % deneme geçti, % deneme başarısız', tamam, hata;
END
$test$;

ROLLBACK;
