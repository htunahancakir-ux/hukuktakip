-- test.sql'in (geri alınmadan önce) eklediği uydurma satırların biçimini süper kullanıcıyla
-- denetler: doğru büro, doğru sütunlar, günlük satırları, sayaç. Yalnızca deneme satırlarına bakar.
\pset tuples_only on
\pset format unaligned
WITH d AS (SELECT current_setting('han_excel.deneme')::jsonb AS j),
m AS (SELECT c.* FROM han_data.clients c, d WHERE c.id = d.j ->> 'muvekkil'),
f AS (SELECT x.* FROM han_data.documents x, d WHERE x.id IN (d.j ->> 'foy1', d.j ->> 'foy2')),
kontrol(ad, tamam) AS (
  SELECT 'müvekkil satırı mevcut büroda ve etkin', (SELECT count(*) = 1 AND bool_and(tenant_id = '00000000-0000-0000-0000-000000000001' AND active AND revision = 1) FROM m)
  UNION ALL SELECT 'müvekkil sütunları gövdeden türedi (ad, arama metni)', (SELECT bool_and(name = 'yetki denemesi kisi' AND search_text <> '') FROM m)
  UNION ALL SELECT 'müvekkil gövdesi uygulamanın alanlarını taşıyor', (SELECT bool_and(
      body ?& ARRAY['id', 'type', 'name', 'fullName', 'tradeName', 'identity', 'phone', 'email', 'address', 'city', 'district', 'clientCategory', 'iban',
        'additionalPhones', 'additionalAddresses', 'additionalBankAccounts', 'phoneSources', 'attachments', 'recordedBy', 'recordedByName', 'createdAt', 'sourceImport']
      AND body ->> 'phone' = '0 (532) 111 22 33' AND body ->> 'identity' = '99999999990'
      AND body ->> 'createdAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
      AND body -> 'sourceImport' ->> 'file' = 'YETKI-DENEMESI.xlsx' AND (body -> 'sourceImport' ->> 'row')::int = 2) FROM m)
  UNION ALL SELECT 'başka büroya müvekkil yazılmadı', (SELECT count(*) = 0 FROM han_data.clients WHERE body -> 'sourceImport' ->> 'file' = 'YETKI-DENEMESI.xlsx' AND tenant_id <> '00000000-0000-0000-0000-000000000001')
  UNION ALL SELECT 'kontrol kipi ve reddedilen çağrılar müvekkil bırakmadı', (SELECT count(*) = 1 FROM han_data.clients WHERE body -> 'sourceImport' ->> 'file' IN ('YETKI-DENEMESI.xlsx', 'BASKA-DOSYA.xlsx'))
  UNION ALL SELECT 'iki föy satırı mevcut büroda, etkin ve müvekkile bağlı', (SELECT count(*) = 2 AND bool_and(tenant_id = '00000000-0000-0000-0000-000000000001' AND active AND client_id = (SELECT id FROM m)) FROM f)
  UNION ALL SELECT 'föy sütunları gövdeden türedi (numara, tür, durum, vade, takip, telefonlar)', (SELECT bool_and(number = body ->> 'number' AND kind = 'Senet' AND status IN ('Derdest', 'İcra') AND due_on = body ->> 'due' AND tracking_on = body ->> 'trackingDate' AND search_text <> '') FROM f)
  UNION ALL SELECT 'ilk föyün tutarları ve telefonları doğru', (SELECT bool_and((body -> 'amount')::numeric = 1250.5 AND (body -> 'originalAmount')::numeric = 1500.5 AND (body -> 'preTrackingPayment')::numeric = 250
      AND jsonb_typeof(body -> 'amount') = 'number' AND body ->> 'phone1' = '0 (532) 111 22 33' AND body -> 'additionalPhones' = '["0 (532) 111 22 44"]'::jsonb
      AND body ->> 'trackingDate' = '2026-06-01' AND body ->> 'originalDocument' = 'Firmada' AND phone_values <> '{}') FROM f, d WHERE f.id = d.j ->> 'foy1')
  UNION ALL SELECT 'föy gövdesi uygulamanın alanlarını taşıyor', (SELECT bool_and(body ?& ARRAY['id', 'number', 'client', 'debtor', 'identity', 'docType', 'amount', 'due', 'status', 'created', 'trackingDate',
        'guarantors', 'attachments', 'conversations', 'additionalPhones', 'additionalAddresses', 'recordedByName', 'sourceImport']) FROM f)
  UNION ALL SELECT 'föy numaraları rakam ve o ana kadarki en büyük numaradan büyük', (SELECT bool_and(f.number ~ '^[0-9]+$' AND f.number::bigint > coalesce((SELECT max(o.number::bigint) FROM han_data.documents o WHERE o.tenant_id = f.tenant_id AND o.number ~ '^[0-9]+$' AND o.id NOT IN (SELECT id FROM f)), 0)) FROM f)
  UNION ALL SELECT 'sayaç son föy numarasında', (SELECT (SELECT last_value FROM han_data.document_sequences WHERE tenant_id = '00000000-0000-0000-0000-000000000001' AND prefix = 'GLOBAL') = max(number::bigint) FROM f)
  UNION ALL SELECT 'başka büronun sayacı ve föyleri değişmedi', (SELECT count(*) = 0 FROM han_data.documents WHERE body -> 'sourceImport' ->> 'file' = 'YETKI-DENEMESI.xlsx' AND tenant_id <> '00000000-0000-0000-0000-000000000001')
  UNION ALL SELECT 'işlem günlüğünde üç oluşturma satırı (1 müvekkil, 2 föy)', (SELECT count(*) = 3 AND count(*) FILTER (WHERE area = 'Müvekkiller') = 1 AND bool_and(category = 'changes' AND action = 'create' AND actor_name = 'Excel Aktarımı' AND tenant_id = '00000000-0000-0000-0000-000000000001')
      FROM han_private.han_audit a, d WHERE a.record_ref IN (d.j ->> 'muvekkil', d.j ->> 'foy1', d.j ->> 'foy2'))
  UNION ALL SELECT 'mevcut kayıtların hiçbiri değişmedi (' || (SELECT count(*) FROM jsonb_object_keys(current_setting('han_excel.ozet_once')::jsonb)) || ' tablonun önce / sonra özeti aynı)',
      current_setting('han_excel.ozet_once')::jsonb = current_setting('han_excel.ozet_sonra')::jsonb
)
SELECT CASE WHEN tamam THEN 'TAMAM  ' ELSE 'HATA   ' END || 'satır denetimi: ' || ad FROM kontrol;
