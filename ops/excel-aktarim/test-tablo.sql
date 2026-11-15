-- han_excel.muvekkil ve han_excel.foy görünümlerine sıradan INSERT denemesi.
--
-- han_excel_aktarim olarak çalıştırılır. Tek işlemde yapılır ve sonunda GERİ ALINIR; deneme
-- kayıtları uydurmadır. Her satır TAMAM ya da HATA ile başlar.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET client_min_messages = notice;
BEGIN;

DO $test$
DECLARE
  tamam integer := 0;
  hata integer := 0;
  adet integer;
  m_id text;
  f_id text;
  f_no text;
  f_durum text;
  no2 text;
  no3 text;
  kod text;
  ileti text;
  deneme record;
BEGIN
  -- 1. Sıradan INSERT: müvekkil.
  INSERT INTO han_excel.muvekkil (unvan, vergi_kimlik_no, vergi_dairesi, telefon, ek_telefonlar, eposta, adres, il, ilce, iban, kaynak_dosya, kaynak_sayfa, kaynak_satir)
  VALUES ('TABLO DENEMESI TICARET LTD. STI.', '9999999973', 'Deneme', '(532) 111 2233', '05321112244; 0216 555 44 33', 'tablo@example.test',
    'Deneme Mah. No: 1', 'İstanbul', 'Kadıköy', NULL, 'TABLO-DENEMESI.xlsx', 'Sayfa2', 2)
  RETURNING id INTO m_id;
  IF m_id ~ '^[0-9a-f-]{36}$' THEN
    tamam := tamam + 1; RAISE NOTICE 'TAMAM  INSERT ile müvekkil eklendi, kimliği geri döndü';
  ELSE
    hata := hata + 1; RAISE NOTICE 'HATA   müvekkil INSERT beklenen gibi değil';
  END IF;

  INSERT INTO han_excel.muvekkil (unvan, vergi_kimlik_no, kaynak_dosya, kaynak_sayfa, kaynak_satir)
  VALUES ('BASKA UNVAN', '9999999965', 'TABLO-DENEMESI.xlsx', 'Sayfa2', 2);
  GET DIAGNOSTICS adet = ROW_COUNT;
  IF adet = 0 THEN tamam := tamam + 1; RAISE NOTICE 'TAMAM  aynı Excel satırı ikinci kez müvekkil açmadı (0 satır)';
  ELSE hata := hata + 1; RAISE NOTICE 'HATA   tekrar satırı müvekkil açtı'; END IF;

  INSERT INTO han_excel.muvekkil (ad_soyad, vergi_kimlik_no, kaynak_dosya, kaynak_satir, sadece_kontrol)
  VALUES ('Kontrol Kisi', '99999999957', 'TABLO-DENEMESI.xlsx', 3, true);
  GET DIAGNOSTICS adet = ROW_COUNT;
  IF adet = 0 THEN tamam := tamam + 1; RAISE NOTICE 'TAMAM  sadece_kontrol = true kayıt açmadı (0 satır)';
  ELSE hata := hata + 1; RAISE NOTICE 'HATA   kontrol satırı kayıt açtı'; END IF;

  -- 2. Sıradan INSERT: föy (müvekkil vergi numarasıyla gösterilir).
  INSERT INTO han_excel.foy (muvekkil_vergi_kimlik_no, borclu, borclu_turu, borclu_kimlik_no, evrak_turu, evrak_tutari, takip_oncesi_odeme,
    vade, takip_tarihi, evrak_no, telefon1, ek_telefonlar, il, ilce, adres, kaynak_dosya, kaynak_sayfa, kaynak_satir)
  VALUES ('9999999973', 'TABLO BORCLU BIR', 'Şahıs', '99999999949', 'Senet', 15000, 2500.50,
    '2026-03-15', '2026-06-01', 'A-17', '0532 111 22 33', '5321112255', 'İstanbul', 'Üsküdar', 'Deneme Cad. No: 5', 'TABLO-DENEMESI.xlsx', 'Sayfa1', 2)
  RETURNING id, foy_no, durum INTO f_id, f_no, f_durum;
  IF f_no ~ '^[0-9]+$' AND f_durum = 'Derdest' THEN
    tamam := tamam + 1; RAISE NOTICE 'TAMAM  INSERT ile föy eklendi; föy numarası ve durumu geri döndü';
  ELSE
    hata := hata + 1; RAISE NOTICE 'HATA   föy INSERT beklenen gibi değil (% %)', f_no, f_durum;
  END IF;

  -- Birden çok satır tek INSERT ile.
  WITH eklenen AS (
    INSERT INTO han_excel.foy (muvekkil_id, borclu, evrak_turu, tutar, vade, icra_dosya_no, kaynak_dosya, kaynak_sayfa, kaynak_satir)
    VALUES (m_id, 'TABLO BORCLU IKI', 'Fatura', 900, '2026-04-15', NULL, 'TABLO-DENEMESI.xlsx', 'Sayfa1', 3),
           (m_id, 'TABLO BORCLU UC', 'Çek', 1200.75, '2026-05-15', '2026/7 E.', 'TABLO-DENEMESI.xlsx', 'Sayfa1', 4)
    RETURNING foy_no, kaynak_satir
  )
  SELECT max(foy_no) FILTER (WHERE kaynak_satir = 3), max(foy_no) FILTER (WHERE kaynak_satir = 4), count(*) INTO no2, no3, adet FROM eklenen;
  IF adet = 2 AND no2::bigint = f_no::bigint + 1 AND no3::bigint = f_no::bigint + 2 THEN
    tamam := tamam + 1; RAISE NOTICE 'TAMAM  tek INSERT ile iki föy eklendi; numaralar sırayla arttı';
  ELSE
    hata := hata + 1; RAISE NOTICE 'HATA   çok satırlı INSERT beklenen gibi değil (% % %)', adet, no2, no3;
  END IF;

  -- Bir satırı hatalı olan çok satırlı INSERT hiçbir satırı eklemez.
  BEGIN
    INSERT INTO han_excel.foy (muvekkil_id, borclu, evrak_turu, tutar, kaynak_dosya, kaynak_sayfa, kaynak_satir)
    VALUES (m_id, 'TABLO BORCLU DORT', 'Senet', 100, 'TABLO-DENEMESI.xlsx', 'Sayfa1', 5),
           (m_id, 'TABLO BORCLU BES', 'Olmayan Tür', 100, 'TABLO-DENEMESI.xlsx', 'Sayfa1', 6);
    hata := hata + 1; RAISE NOTICE 'HATA   hatalı satır kabul edildi';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS kod = RETURNED_SQLSTATE;
    IF kod = 'HX400' THEN tamam := tamam + 1; RAISE NOTICE 'TAMAM  reddedildi (HX400): bir satırı hatalı olan çok satırlı INSERT';
    ELSE hata := hata + 1; RAISE NOTICE 'HATA   beklenen HX400 yerine %', kod; END IF;
  END;

  SELECT count(*) INTO adet FROM han_excel.foy WHERE kaynak_dosya = 'TABLO-DENEMESI.xlsx';
  IF adet = 3 THEN tamam := tamam + 1; RAISE NOTICE 'TAMAM  yalnızca eklenen üç föy görünüyor (hatalı INSERT iz bırakmadı)';
  ELSE hata := hata + 1; RAISE NOTICE 'HATA   görünen föy sayısı % (3 olmalıydı)', adet; END IF;

  SELECT count(*) INTO adet FROM han_excel.muvekkil WHERE kaynak_dosya = 'TABLO-DENEMESI.xlsx' AND id = m_id;
  IF adet = 1 THEN tamam := tamam + 1; RAISE NOTICE 'TAMAM  eklenen müvekkil kimlik ve kaynak sütunlarıyla görünüyor; kontrol ve tekrar satırları iz bırakmadı';
  ELSE hata := hata + 1; RAISE NOTICE 'HATA   görünen müvekkil sayısı % (1 olmalıydı)', adet; END IF;

  -- 3. Kurallar görünümden de geçerli.
  FOR deneme IN
    SELECT * FROM (VALUES
      ('aynı vergi numarasıyla ikinci müvekkil', 'HX409',
        $q$INSERT INTO han_excel.muvekkil (unvan, vergi_kimlik_no, kaynak_dosya, kaynak_satir) VALUES ('BASKA SIRKET', '9999999973', 'TABLO-DENEMESI.xlsx', 10)$q$),
      ('adı olmayan müvekkil', 'HX400',
        $q$INSERT INTO han_excel.muvekkil (vergi_kimlik_no, kaynak_dosya, kaynak_satir) VALUES ('9999999940', 'TABLO-DENEMESI.xlsx', 11)$q$),
      ('kaynak satırı olmayan müvekkil', 'HX400',
        $q$INSERT INTO han_excel.muvekkil (unvan, vergi_kimlik_no) VALUES ('KAYNAKSIZ SIRKET', '9999999932')$q$),
      ('olmayan müvekkile föy', 'HX404',
        $q$INSERT INTO han_excel.foy (muvekkil_vergi_kimlik_no, borclu, evrak_turu, tutar, kaynak_dosya, kaynak_satir) VALUES ('9999999924', 'B', 'Senet', 1, 'TABLO-DENEMESI.xlsx', 12)$q$),
      ('müvekkilsiz föy', 'HX400',
        $q$INSERT INTO han_excel.foy (borclu, evrak_turu, tutar, kaynak_dosya, kaynak_satir) VALUES ('B', 'Senet', 1, 'TABLO-DENEMESI.xlsx', 13)$q$),
      ('aynı kimlik numarasıyla başka adlı borçlu', 'HX409',
        $q$INSERT INTO han_excel.foy (muvekkil_vergi_kimlik_no, borclu, borclu_kimlik_no, evrak_turu, tutar, kaynak_dosya, kaynak_satir) VALUES ('9999999973', 'BAMBASKA BIRI', '99999999949', 'Senet', 1, 'TABLO-DENEMESI.xlsx', 14)$q$),
      ('başka dosyadan aynı içerikli föy', 'HX409',
        $q$INSERT INTO han_excel.foy (muvekkil_vergi_kimlik_no, borclu, evrak_turu, tutar, vade, evrak_no, kaynak_dosya, kaynak_satir) VALUES ('9999999973', ' TABLO   BORCLU BIR ', 'Senet', 12499.50, '2026-03-15', 'A-17', 'BASKA-DOSYA.xlsx', 15)$q$),
      ('üç ondalıklı tutar', 'HX400',
        $q$INSERT INTO han_excel.foy (muvekkil_vergi_kimlik_no, borclu, evrak_turu, tutar, kaynak_dosya, kaynak_satir) VALUES ('9999999973', 'B', 'Senet', 10.125, 'TABLO-DENEMESI.xlsx', 16)$q$)
    ) AS t(ad, beklenen, komut)
  LOOP
    BEGIN
      EXECUTE deneme.komut;
      hata := hata + 1; RAISE NOTICE 'HATA   reddedilmeliydi ama kabul edildi: %', deneme.ad;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS kod = RETURNED_SQLSTATE, ileti = MESSAGE_TEXT;
      IF kod = deneme.beklenen THEN tamam := tamam + 1; RAISE NOTICE 'TAMAM  reddedildi (%): %', kod, deneme.ad;
      ELSE hata := hata + 1; RAISE NOTICE 'HATA   beklenen % yerine % (%): %', deneme.beklenen, kod, left(ileti, 90), deneme.ad; END IF;
    END;
  END LOOP;

  -- 4. Yetkiler: değiştirme, silme, kişisel sütunları okuma, sistem sütunlarını yazma yok.
  FOR deneme IN
    SELECT * FROM (VALUES
      ('eklediği föyü değiştirme', format('UPDATE han_excel.foy SET borclu = %L WHERE id = %L', 'x', f_id)),
      ('eklediği föyü silme', format('DELETE FROM han_excel.foy WHERE id = %L', f_id)),
      ('eklediği müvekkili değiştirme', format('UPDATE han_excel.muvekkil SET unvan = %L WHERE id = %L', 'x', m_id)),
      ('eklediği müvekkili silme', format('DELETE FROM han_excel.muvekkil WHERE id = %L', m_id)),
      ('föylerde borçlu adını okuma', 'SELECT borclu FROM han_excel.foy'),
      ('föylerde kimlik numarası, telefon ve adres okuma', 'SELECT borclu_kimlik_no, telefon1, adres FROM han_excel.foy'),
      ('föyleri bütün sütunlarıyla okuma', 'SELECT * FROM han_excel.foy'),
      ('müvekkil adını ve vergi numarasını okuma', 'SELECT unvan, vergi_kimlik_no FROM han_excel.muvekkil'),
      ('kimlik numarasıyla kayıt arama', $q$SELECT id FROM han_excel.muvekkil WHERE vergi_kimlik_no = '9999999973'$q$),
      ('föy numarasını elle yazma', $q$INSERT INTO han_excel.foy (foy_no, muvekkil_vergi_kimlik_no, borclu, evrak_turu, tutar, kaynak_dosya, kaynak_satir) VALUES ('1', '9999999973', 'B', 'Senet', 1, 'TABLO-DENEMESI.xlsx', 20)$q$),
      ('föy durumunu elle yazma', $q$INSERT INTO han_excel.foy (durum, muvekkil_vergi_kimlik_no, borclu, evrak_turu, tutar, kaynak_dosya, kaynak_satir) VALUES ('İnfaz', '9999999973', 'B', 'Senet', 1, 'TABLO-DENEMESI.xlsx', 21)$q$),
      ('kayıt kimliğini elle yazma', $q$INSERT INTO han_excel.muvekkil (id, unvan, kaynak_dosya, kaynak_satir) VALUES ('x', 'ELLE KIMLIK', 'TABLO-DENEMESI.xlsx', 22)$q$),
      ('görünümü boşaltma', 'TRUNCATE han_excel.foy'),
      ('asıl föy tablosuna doğrudan ekleme', $q$INSERT INTO han_data.documents (tenant_id, id, body, ordinal) VALUES ('00000000-0000-0000-0000-000000000001', 'x', '{}', 1)$q$)
    ) AS t(ad, komut)
  LOOP
    BEGIN
      EXECUTE deneme.komut;
      hata := hata + 1; RAISE NOTICE 'HATA   reddedilmeliydi ama çalıştı: %', deneme.ad;
    EXCEPTION WHEN insufficient_privilege THEN
      tamam := tamam + 1; RAISE NOTICE 'TAMAM  reddedildi: %', deneme.ad;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS kod = RETURNED_SQLSTATE, ileti = MESSAGE_TEXT;
      IF kod IN ('42809', '0A000') THEN
        tamam := tamam + 1; RAISE NOTICE 'TAMAM  reddedildi (%): %', kod, deneme.ad;
      ELSE
        hata := hata + 1; RAISE NOTICE 'HATA   beklenmeyen yanıt (% %): %', kod, left(ileti, 80), deneme.ad;
      END IF;
    END;
  END LOOP;

  RAISE NOTICE 'OZET   % deneme geçti, % deneme başarısız', tamam, hata;
  PERFORM set_config('han_excel.deneme_tablo', jsonb_build_object('tamam', tamam, 'hata', hata, 'muvekkil', m_id, 'foy', f_id, 'foy_no', f_no)::text, true);
END
$test$;

SELECT 'SONUC ' || current_setting('han_excel.deneme_tablo', true);
\if :{?incele}
\else
ROLLBACK;
\endif
