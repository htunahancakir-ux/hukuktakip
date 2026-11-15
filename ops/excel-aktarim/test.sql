-- Excel aktarımı kullanıcısının yetki ve kural denemesi.
--
-- han_excel_aktarim olarak çalıştırılır. Her şey tek işlem içinde yapılır ve sonunda GERİ ALINIR:
-- hiçbir müvekkil, föy, sayaç ya da günlük satırı kalıcı olmaz. Deneme kayıtları uydurmadır.
-- (psql'e -v incele=1 verilirse işlem açık bırakılır; çağıran satırlara bakıp kendisi geri alır.)
-- Çıktıdaki her satır TAMAM ya da HATA ile başlar; son satır özeti verir.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET client_min_messages = notice;
BEGIN;

DO $test$
DECLARE
  tamam integer := 0;
  hata integer := 0;
  sonuc jsonb;
  m1 jsonb;
  f1 jsonb;
  f2 jsonb;
  kod text;
  ileti text;
  -- Synthetic numbers that no real person or company has.
  k_muvekkil CONSTANT text := '99999999990';
  k_borclu CONSTANT text := '99999999981';
  dosya CONSTANT jsonb := '{"file": "YETKI-DENEMESI.xlsx", "sheet": "Deneme", "sha256": "00000000000000000000000000000000000000000000000000000000deadbeef"}';
  deneme record;
BEGIN
  IF session_user <> 'han_excel_aktarim' AND current_user <> 'han_excel_aktarim' THEN
    RAISE EXCEPTION 'Bu deneme han_excel_aktarim kullanıcısıyla çalıştırılmalı (şu an: %).', current_user;
  END IF;

  -- 1. Doğrudan erişim ve yetki yükseltme denemeleri: hepsi reddedilmeli.
  FOR deneme IN
    SELECT * FROM (VALUES
      ('müvekkil tablosuna doğrudan ekleme', $q$INSERT INTO han_data.clients (tenant_id, id, body, ordinal) VALUES ('00000000-0000-0000-0000-000000000001', 'x', '{}', 1)$q$),
      ('mevcut müvekkili değiştirme', $q$UPDATE han_data.clients SET body = body || '{"name": "x"}'$q$),
      ('mevcut müvekkili silme', 'DELETE FROM han_data.clients'),
      ('mevcut müvekkili arşivleme', 'UPDATE han_data.clients SET active = false'),
      ('föy tablosuna doğrudan ekleme', $q$INSERT INTO han_data.documents (tenant_id, id, body, ordinal) VALUES ('00000000-0000-0000-0000-000000000001', 'x', '{}', 1)$q$),
      ('mevcut föyü değiştirme', $q$UPDATE han_data.documents SET body = body || '{"debtor": "x"}'$q$),
      ('mevcut föyü silme', 'DELETE FROM han_data.documents'),
      ('mevcut föyü arşivleme', 'UPDATE han_data.documents SET active = false'),
      ('föy numarası sayacını değiştirme', 'UPDATE han_data.document_sequences SET last_value = 0'),
      ('tahsilat kayıtlarını silme', 'DELETE FROM han_data.financial_events'),
      ('tahsilat kayıtlarını değiştirme', $q$UPDATE han_data.financial_events SET body = '{}'$q$),
      ('personel kayıtlarını değiştirme', $q$UPDATE han_data.personnel SET body = '{}'$q$),
      ('föy tablosunu boşaltma', 'TRUNCATE han_data.documents'),
      ('depo durumunu okuma', 'SELECT mode FROM han_data.control'),
      ('tahsilat / finans kayıtlarına yazma', $q$INSERT INTO han_data.financial_events (tenant_id, id, body, ordinal) VALUES ('00000000-0000-0000-0000-000000000001', 'x', '{}', 1)$q$),
      ('muhasebe kayıtlarına yazma', $q$INSERT INTO han_data.ledger_entries (tenant_id, id, body, ordinal) VALUES ('00000000-0000-0000-0000-000000000001', 'x', '{}', 1)$q$),
      ('kullanıcı ve ayar kaydını okuma', 'SELECT body FROM han_data.metadata'),
      ('kullanıcı ve ayar kaydını değiştirme', $q$UPDATE han_data.metadata SET body = '{}'$q$),
      ('işlem günlüğünü okuma', 'SELECT count(*) FROM han_private.han_audit'),
      ('işlem günlüğüne doğrudan yazma', $q$INSERT INTO han_private.han_audit (tenant_id, category, action, area) VALUES ('00000000-0000-0000-0000-000000000001', 'changes', 'create', 'Evraklar')$q$),
      ('işlem günlüğünü silme', 'DELETE FROM han_private.han_audit'),
      ('oturum tablosunu okuma', 'SELECT count(*) FROM han_private.han_sessions'),
      ('büro listesini okuma', 'SELECT count(*) FROM han_saas.tenants'),
      ('platform ayarlarını okuma', 'SELECT count(*) FROM han_saas.platform_settings'),
      ('uygulama rolüne geçme', 'SET ROLE hanhukuk'),
      ('büro çalışma rolüne geçme', 'SET ROLE han_tenant_runtime'),
      ('işlev sahibi role geçme', 'SET ROLE han_excel_yazici'),
      ('süper kullanıcıya geçme', 'SET ROLE postgres'),
      ('yardımcı işlevi doğrudan çağırma', $q$SELECT han_excel._metin('{"a": "b"}', 'a', 5)$q$),
      ('ekleme işlevini değiştirme', $q$CREATE OR REPLACE FUNCTION han_excel.durum() RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb'$q$),
      ('kendi şemasında tablo açma', 'CREATE TABLE han_excel.deneme (a integer)'),
      ('veri şemasında tablo açma', 'CREATE TABLE han_data.deneme (a integer)'),
      ('yeni şema açma', 'CREATE SCHEMA deneme_sema'),
      ('yeni rol açma', 'CREATE ROLE deneme_rol'),
      ('sunucudan dosya okuma', $q$SELECT pg_read_file('/etc/passwd')$q$),
      ('uygulama rolünün şifresini okuma', 'SELECT rolpassword FROM pg_authid')
    ) AS t(ad, komut)
  LOOP
    BEGIN
      EXECUTE deneme.komut;
      hata := hata + 1;
      RAISE NOTICE 'HATA   reddedilmeliydi ama çalıştı: %', deneme.ad;
    EXCEPTION WHEN insufficient_privilege THEN
      tamam := tamam + 1;
      RAISE NOTICE 'TAMAM  reddedildi: %', deneme.ad;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS kod = RETURNED_SQLSTATE, ileti = MESSAGE_TEXT;
      hata := hata + 1;
      RAISE NOTICE 'HATA   beklenmeyen yanıt (% %): %', kod, left(ileti, 80), deneme.ad;
    END;
  END LOOP;

  -- 2. Bağlantı denemesi.
  sonuc := han_excel.durum();
  IF sonuc ->> 'ok' = 'true' THEN
    tamam := tamam + 1; RAISE NOTICE 'TAMAM  durum() yanıt verdi (kullanıcı %)', sonuc ->> 'kullanici';
  ELSE
    hata := hata + 1; RAISE NOTICE 'HATA   durum() beklenen yanıtı vermedi';
  END IF;

  -- 3. Ekleme ve kurallar. Başka büroyu göstermeye çalışmak hiçbir şeyi değiştirmez.
  PERFORM set_config('han.tenant_id', '11111111-1111-1111-1111-111111111111', true);

  sonuc := han_excel.muvekkil_ekle(
    jsonb_build_object('tradeName', 'YETKİ DENEMESİ TİCARET A.Ş.', 'identity', '9999999999', 'phone', '5321112233'),
    dosya || '{"row": 1}', true);
  IF sonuc ->> 'durum' = 'kontrol_tamam' THEN
    tamam := tamam + 1; RAISE NOTICE 'TAMAM  yalnızca kontrol: müvekkil denetlendi, kayıt açılmadı';
  ELSE
    hata := hata + 1; RAISE NOTICE 'HATA   yalnızca kontrol beklenen yanıtı vermedi: %', sonuc;
  END IF;

  m1 := han_excel.muvekkil_ekle(
    jsonb_build_object('fullName', '  yetki   denemesi kisi ', 'identity', k_muvekkil, 'phone', '905321112233',
      'email', 'deneme@example.test', 'city', 'İstanbul', 'clientCategory', 'Mağaza'),
    dosya || '{"row": 2}');
  IF m1 ->> 'durum' = 'eklendi' AND m1 ->> 'type' = 'Şahıs' AND m1 ->> 'name' = 'yetki denemesi kisi' THEN
    tamam := tamam + 1; RAISE NOTICE 'TAMAM  yeni müvekkil eklendi (tür kimlik numarasından: %)', m1 ->> 'type';
  ELSE
    hata := hata + 1; RAISE NOTICE 'HATA   müvekkil eklenemedi: %', m1;
  END IF;

  sonuc := han_excel.muvekkil_ekle(jsonb_build_object('fullName', 'Başka Ad', 'identity', '99999999972'), dosya || '{"row": 2}');
  IF sonuc ->> 'durum' = 'tekrar' AND sonuc ->> 'id' = m1 ->> 'id' THEN
    tamam := tamam + 1; RAISE NOTICE 'TAMAM  aynı Excel satırı ikinci kez müvekkil açmadı';
  ELSE
    hata := hata + 1; RAISE NOTICE 'HATA   tekrar aktarım denetimi çalışmadı: %', sonuc;
  END IF;

  -- Each refusal below must come back with the stated error class.
  FOR deneme IN
    SELECT * FROM (VALUES
      ('aynı kimlik numarasıyla ikinci müvekkil', 'HX409', 'm',
        jsonb_build_object('fullName', 'Başka Kişi', 'identity', k_muvekkil), 3),
      ('kimlik numarası olmadan aynı adla müvekkil', 'HX409', 'm',
        jsonb_build_object('type', 'Şahıs', 'fullName', 'YETKİ DENEMESİ KİSİ'), 4),
      ('türü ve kimlik numarası olmayan müvekkil', 'HX400', 'm', jsonb_build_object('fullName', 'Türsüz Kayıt'), 9),
      ('adı olmayan müvekkil', 'HX400', 'm', jsonb_build_object('identity', '99999999964'), 5),
      ('geçersiz kimlik numarası', 'HX400', 'm', jsonb_build_object('fullName', 'Ad', 'identity', '12345'), 6),
      ('desteklenmeyen müvekkil alanı', 'HX400', 'm', jsonb_build_object('fullName', 'Ad', 'active', false), 7),
      ('geçersiz IBAN', 'HX400', 'm', jsonb_build_object('fullName', 'Ad Soyad Deneme', 'iban', 'TR000000000000000000000000'), 8),
      ('olmayan müvekkile föy', 'HX404', 'f',
        jsonb_build_object('clientIdentity', '99999999956', 'debtor', 'Borçlu', 'docType', 'Senet', 'amount', 100), 10),
      ('müvekkil gösterilmeden föy', 'HX400', 'f', jsonb_build_object('debtor', 'Borçlu', 'docType', 'Senet', 'amount', 100), 11),
      ('borçlusu olmayan föy', 'HX400', 'f', jsonb_build_object('clientIdentity', k_muvekkil, 'docType', 'Senet', 'amount', 100), 12),
      ('geçersiz evrak türü', 'HX400', 'f', jsonb_build_object('clientIdentity', k_muvekkil, 'debtor', 'B', 'docType', 'Yediemin Park Ücreti', 'amount', 100), 13),
      ('tutarı olmayan föy', 'HX400', 'f', jsonb_build_object('clientIdentity', k_muvekkil, 'debtor', 'B', 'docType', 'Senet'), 14),
      ('virgüllü tutar', 'HX400', 'f', jsonb_build_object('clientIdentity', k_muvekkil, 'debtor', 'B', 'docType', 'Senet', 'amount', '1.250,50'), 15),
      ('tutarları birbirini tutmayan föy', 'HX400', 'f', jsonb_build_object('clientIdentity', k_muvekkil, 'debtor', 'B', 'docType', 'Senet', 'amount', 100, 'originalAmount', 500, 'preTrackingPayment', 50), 16),
      ('geçersiz vade tarihi', 'HX400', 'f', jsonb_build_object('clientIdentity', k_muvekkil, 'debtor', 'B', 'docType', 'Senet', 'amount', 100, 'due', '2026-02-30'), 17),
      ('ileri tarihli takip', 'HX400', 'f', jsonb_build_object('clientIdentity', k_muvekkil, 'debtor', 'B', 'docType', 'Senet', 'amount', 100, 'trackingDate', '2099-01-01'), 18),
      ('borçluya müvekkilin kimlik numarası', 'HX409', 'f', jsonb_build_object('clientIdentity', k_muvekkil, 'debtor', 'B', 'docType', 'Senet', 'amount', 100, 'identity', k_muvekkil), 19),
      ('föy numarasını elle verme', 'HX400', 'f', jsonb_build_object('clientIdentity', k_muvekkil, 'debtor', 'B', 'docType', 'Senet', 'amount', 100, 'number', '1'), 20),
      ('föy durumunu elle verme', 'HX400', 'f', jsonb_build_object('clientIdentity', k_muvekkil, 'debtor', 'B', 'docType', 'Senet', 'amount', 100, 'status', 'İnfaz'), 21),
      ('kaynak satırı olmayan çağrı', 'HX400', 'f', jsonb_build_object('clientIdentity', k_muvekkil, 'debtor', 'B', 'docType', 'Senet', 'amount', 100), NULL)
    ) AS t(ad, beklenen, tur, kayit, satir)
  LOOP
    BEGIN
      IF deneme.tur = 'm' THEN
        sonuc := han_excel.muvekkil_ekle(deneme.kayit, dosya || jsonb_build_object('row', deneme.satir));
      ELSE
        sonuc := han_excel.foy_ekle(deneme.kayit, CASE WHEN deneme.satir IS NULL THEN dosya ELSE dosya || jsonb_build_object('row', deneme.satir) END);
      END IF;
      hata := hata + 1;
      RAISE NOTICE 'HATA   reddedilmeliydi ama kabul edildi: % -> %', deneme.ad, sonuc;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS kod = RETURNED_SQLSTATE, ileti = MESSAGE_TEXT;
      IF kod = deneme.beklenen THEN
        tamam := tamam + 1; RAISE NOTICE 'TAMAM  reddedildi (%): %', kod, deneme.ad;
      ELSE
        hata := hata + 1; RAISE NOTICE 'HATA   beklenen % yerine % (%): %', deneme.beklenen, kod, left(ileti, 90), deneme.ad;
      END IF;
    END;
  END LOOP;

  f1 := han_excel.foy_ekle(
    jsonb_build_object('clientIdentity', k_muvekkil, 'debtor', 'deneme borclu bir', 'identity', k_borclu, 'docType', 'Senet',
      'originalAmount', 1500.50, 'preTrackingPayment', 250, 'due', '2026-03-15', 'serial', 'A-1', 'phone1', '0532 111 22 33',
      'additionalPhones', jsonb_build_array('5321112244'), 'trackingDate', '2026-06-01'),
    dosya || '{"row": 30}');
  IF f1 ->> 'durum' = 'eklendi' AND f1 ->> 'number' ~ '^[0-9]+$' AND f1 ->> 'client' = m1 ->> 'id' AND f1 ->> 'status' = 'Derdest' THEN
    tamam := tamam + 1; RAISE NOTICE 'TAMAM  yeni föy eklendi, müvekkile bağlandı, numarasını sayaçtan aldı';
  ELSE
    hata := hata + 1; RAISE NOTICE 'HATA   föy eklenemedi: %', f1;
  END IF;

  f2 := han_excel.foy_ekle(
    jsonb_build_object('client', m1 ->> 'id', 'debtor', 'DENEME BORCLU BİR', 'identity', k_borclu, 'docType', 'Senet',
      'amount', 900, 'due', '2026-04-15', 'enforcementFileNumber', '2026/1 E.'),
    dosya || '{"row": 31}');
  IF f2 ->> 'durum' = 'eklendi' AND (f2 ->> 'number')::bigint = (f1 ->> 'number')::bigint + 1 AND f2 ->> 'status' = 'İcra' THEN
    tamam := tamam + 1; RAISE NOTICE 'TAMAM  aynı borçluya ikinci föy açıldı; numara bir arttı; icra numarası durumu İcra yaptı';
  ELSE
    hata := hata + 1; RAISE NOTICE 'HATA   ikinci föy beklenen gibi eklenmedi: %', f2;
  END IF;

  sonuc := han_excel.foy_ekle(jsonb_build_object('client', m1 ->> 'id', 'debtor', 'x', 'docType', 'Fatura', 'amount', 1), dosya || '{"row": 30}');
  IF sonuc ->> 'durum' = 'tekrar' AND sonuc ->> 'id' = f1 ->> 'id' AND sonuc ->> 'number' = f1 ->> 'number' THEN
    tamam := tamam + 1; RAISE NOTICE 'TAMAM  aynı Excel satırı ikinci kez föy açmadı';
  ELSE
    hata := hata + 1; RAISE NOTICE 'HATA   föyde tekrar aktarım denetimi çalışmadı: %', sonuc;
  END IF;

  FOR deneme IN
    SELECT * FROM (VALUES
      ('aynı kimlik numarasıyla başka adlı borçlu', 'HX409',
        jsonb_build_object('client', m1 ->> 'id', 'debtor', 'Bambaşka Biri', 'identity', k_borclu, 'docType', 'Senet', 'amount', 10), 40),
      ('başka dosyadan aynı içerikli föy', 'HX409',
        jsonb_build_object('client', m1 ->> 'id', 'debtor', 'Deneme  Borclu Bir', 'docType', 'Senet', 'amount', '1250.50', 'due', '2026-03-15', 'serial', 'A-1'), 41),
      ('borçlunun kimlik numarasıyla müvekkil', 'HX409', NULL, 42)
    ) AS t(ad, beklenen, kayit, satir)
  LOOP
    BEGIN
      IF deneme.kayit IS NULL THEN
        sonuc := han_excel.muvekkil_ekle(jsonb_build_object('fullName', 'Borçlu Olan Kişi', 'identity', k_borclu), dosya || jsonb_build_object('row', deneme.satir));
      ELSE
        sonuc := han_excel.foy_ekle(deneme.kayit, '{"file": "BASKA-DOSYA.xlsx", "sheet": "S"}'::jsonb || jsonb_build_object('row', deneme.satir));
      END IF;
      hata := hata + 1;
      RAISE NOTICE 'HATA   reddedilmeliydi ama kabul edildi: % -> %', deneme.ad, sonuc;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS kod = RETURNED_SQLSTATE, ileti = MESSAGE_TEXT;
      IF kod = deneme.beklenen THEN
        tamam := tamam + 1; RAISE NOTICE 'TAMAM  reddedildi (%): %', kod, deneme.ad;
      ELSE
        hata := hata + 1; RAISE NOTICE 'HATA   beklenen % yerine % (%): %', deneme.beklenen, kod, left(ileti, 90), deneme.ad;
      END IF;
    END;
  END LOOP;

  -- Eklenen kayıt da sonradan değiştirilemez ya da silinemez.
  BEGIN
    EXECUTE format('DELETE FROM han_data.documents WHERE id = %L', f1 ->> 'id');
    hata := hata + 1; RAISE NOTICE 'HATA   kendi eklediği föyü silebildi';
  EXCEPTION WHEN insufficient_privilege THEN
    tamam := tamam + 1; RAISE NOTICE 'TAMAM  reddedildi: kendi eklediği föyü silme';
  END;

  RAISE NOTICE 'OZET   % deneme geçti, % deneme başarısız', tamam, hata;
  -- Passed on to the caller, who may inspect the rows before the rollback.
  PERFORM set_config('han_excel.deneme', jsonb_build_object('tamam', tamam, 'hata', hata, 'muvekkil', m1 ->> 'id', 'foy1', f1 ->> 'id', 'foy2', f2 ->> 'id')::text, true);
END
$test$;

SELECT 'SONUC ' || current_setting('han_excel.deneme', true);
\if :{?incele}
\else
ROLLBACK;
\endif
