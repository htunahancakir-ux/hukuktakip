-- Bütün kayıt tablolarının ve işlem günlüğünün özetini (satır sayısı + içerik özeti) çıkarır.
-- Süper kullanıcıyla, denemeden önce ve sonra çalıştırılır; iki özet aynıysa mevcut kayıtların
-- hiçbiri değişmemiş, silinmemiş, eklenmemiş demektir. Deneme satırları ve föy numarası sayacı
-- (yalnızca mevcut büronun GLOBAL sayacı) özetin dışındadır. Hiçbir kayıt değeri yazdırılmaz.
--
-- Önce: SELECT set_config('han_excel.ozet_hedef', 'once' | 'sonra', false);
DO $ozet$
DECLARE
  hedef text := current_setting('han_excel.ozet_hedef');
  tablo record;
  parca text;
  sonuc jsonb := '{}'::jsonb;
  sinir bigint;
BEGIN
  FOR tablo IN
    SELECT n.nspname AS sema, c.relname AS ad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'han_data' AND c.relkind = 'r' ORDER BY 2
  LOOP
    EXECUTE format(
      'SELECT count(*) || '':'' || coalesce(md5(string_agg(md5(x::text), '''' ORDER BY md5(x::text))), '''') FROM %I.%I x WHERE %s',
      tablo.sema, tablo.ad,
      CASE
        WHEN tablo.ad IN ('clients', 'documents')
          THEN $f$coalesce(x.body -> 'sourceImport' ->> 'file', '') NOT IN ('YETKI-DENEMESI.xlsx', 'BASKA-DOSYA.xlsx')$f$
        WHEN tablo.ad = 'document_sequences'
          THEN $f$NOT (x.tenant_id = '00000000-0000-0000-0000-000000000001' AND x.prefix = 'GLOBAL')$f$
        ELSE 'true'
      END
    ) INTO parca;
    sonuc := sonuc || jsonb_build_object(tablo.ad, parca);
  END LOOP;
  -- The audit log up to the last entry that existed before the trial.
  IF hedef = 'once' THEN
    PERFORM set_config('han_excel.gunluk_siniri', coalesce((SELECT max(id) FROM han_private.han_audit), 0)::text, false);
  END IF;
  sinir := current_setting('han_excel.gunluk_siniri')::bigint;
  SELECT count(*) || ':' || coalesce(md5(string_agg(md5(a::text), '' ORDER BY a.id)), '') INTO parca
  FROM han_private.han_audit a WHERE a.id <= sinir;
  sonuc := sonuc || jsonb_build_object('han_audit', parca);
  PERFORM set_config('han_excel.ozet_' || hedef, sonuc::text, false);
END
$ozet$;
