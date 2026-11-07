# Geçiş ve prova

Bu klasör ikinci aşamanın pilot şemasını içerir. İlk aşama uygulama kodu bu şemaya yazmaz. Hazırlanan repository doğrudan testlerde kullanılır; eski arayüzü bütünüyle değiştiren bir sürüm değildir.

## Hemen çalıştırılabilen güvenli prova

Proje klasöründe `npm run db:rehearse` çalıştırılır. PGlite belleğinde yeni veritabanları oluşturulur. Gerçek DATABASE_URL kullanılmaz, .env.local yüklenmez, Supabase veya R2'ye bağlanılmaz. Prova bitince yalnız test veritabanları kapanır.

## İlk aşamanın yayın sırası

1. Güncel şifreli iş verisi yedeğinin alınabildiği ve boş hedefe açılabildiği doğrulanır. Audit tablosu ayrıca PostgreSQL yedeğine dahil edilir.
   Yayın sırasında `database/ops/20261107025018_release_checkpoint.sql` özel şemada payload ve audit kopyası alır. Bu aynı veritabanındaki geri dönüş noktasıdır; bağımsız R2 yedeğinin yerine geçmez.
2. Aynı şemaya sahip hazırlık veritabanında `migrate(pool)` çalıştırılır. Eski payload'ın tamamı, audit sayısı, JSON özeti ve kaynak revision karşılaştırılır.
3. Canlıya geçiş sırasında eski uygulamanın yazmaları kısa süreli durdurulur. İlk aşama SQL ve ona uygun kod birlikte yayımlanır. Uygulama açılışında otomatik DDL çalıştırılmaz.
4. Bir masaüstü + bir mobil giriş, ikinci aynı tür cihaz uyarısı, eski oturumun iptali, yanlış şifre sınırı, sözleşme kabulü, liste, bildirim ve yedek indirme doğrulanır.
5. Çalışan kullanıcı oturumları bir kez yeniden giriş gerektirir. İş kayıtları taşınmaz/silinmez.

Şema uygulanmadan yeni backend'in yayına alınması yeni tablo bulunamadı hatası üretir. Eski ve yeni oturum kodu aynı anda yazmaya açık tutulmamalıdır.

## İlk aşamada geri dönüş

Payload ve han_audit korunur; ek tabloları silmek gerekmez. Yazmaları durdurup oturumları iptal ederek eski uyumlu kod geri alınır. Eski han_state.sessions alanını olduğu gibi yeniden kullanmak, geçmişte iptal edilmiş oturumları canlandırabilir. Aşağıdaki SQL yalnız onaylanmış geri dönüş penceresinde uygulanır ve iş payload'ını değiştirmez.

```sql
BEGIN;
LOCK TABLE han_private.han_state IN EXCLUSIVE MODE;
UPDATE han_private.han_state
SET sessions = '{}'::jsonb,
    attempts = coalesce((
      SELECT jsonb_object_agg(key, jsonb_build_object('count', count, 'until', expires_at))
      FROM han_private.han_login_attempts
      WHERE expires_at > extract(epoch FROM clock_timestamp()) * 1000
    ), '{}'::jsonb)
WHERE id = 1;
DELETE FROM han_private.han_sessions;
COMMIT;
```

## Normalizasyon pilotu

Hazırlık veritabanında önce ilk aşama şeması bulunmalıdır. `20261107010408_normalized_record_backend.sql` tek transaction içinde uygulanır. Ardından `importNormalized(pool)` çağrılır. Bu işlem kaynak han_state satırını paylaşım kilidiyle okur; eski payload'ı değiştirmeden yeni kayıtları yazar.

- Tekrarlı aktarım UNIQUE nedeniyle reddedilir; mevcut hedefin üzerine yazılmaz.
- Kaynak tam JSON, revision ve SHA-256 kontrol kaydında saklanır.
- Hatalı FK, tutar, kimlik çakışması veya mükerrer ID bütün aktarımı geri alır. Hatalı satır atlanmaz veya otomatik silinmez.
- Para toplamı ve kayıt sayıları doğrulanır.
- Kaynakta tanınmayan alanlar korunur.
- Aynı kimliğe ait çelişen adlar otomatik birleştirilmez.
- PDF/fotoğraf içeriği ayrı ek tablosuna taşınır; obje depoya aktarılana kadar içerik bytea olarak korunur.

Bu içe aktarma mevcut veri hacminden geçiş içindir. Milyarlarca kayıt için tek JSON kontrol kaydı veya bellek içi içe aktarma kullanılmaz; bunun çok öncesinde normalleştirilmiş model ve artımlı yedekleme devreye girmelidir.

## SQL kontrol ve optimizasyon komutları

Bu sorgular yeni şemaya sahip hazırlık veritabanında çalıştırılabilir.

```sql
SELECT count(*) AS clients FROM han_core.clients;
SELECT count(*) AS documents FROM han_core.documents WHERE deleted_at IS NULL;
SELECT count(*) AS movements, sum(amount_cents) AS total_cents FROM han_core.financial_events;
SELECT source_revision, source_sha256, imported_at FROM han_core.migration_checkpoint;

ANALYZE han_core.documents;
ANALYZE han_core.parties;
ANALYZE han_core.financial_events;
ANALYZE han_core.ledger_entries;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, number, status
FROM han_core.documents
WHERE deleted_at IS NULL AND assigned_staff_id = 'HAZIRLIK_PERSONEL_ID' AND id > ''
ORDER BY id
LIMIT 51;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id
FROM han_core.parties
WHERE search_vector @@ plainto_tsquery('simple', 'HAZIRLIK ARAMA');
```

Küçük tablolarda PostgreSQL sıralı taramayı seçebilir. İndeks kararı canlıya benzer veri dağılımında değerlendirilir. Büyük tablolarda sonradan indeks eklenecekse `CREATE INDEX CONCURRENTLY` ayrı bir işlemde kullanılır; transaction içine konmaz. Bu SQL dosyası yeni/boş tablolar içindir ve normal CREATE INDEX kullanır.

## Pilotun yayına geçiş koşulları

Eski toplu PUT uçları ile yeni tablolar aynı anda bağımsız yazılamaz. Aksi halde iki ayrı doğru veri kaynağı oluşur. Arayüz çağrıları, rol matrisi, Yediemin ve diğer özel mali hesaplamalar, personel/bordro akışı ve raporlar kayıt bazlı servislere taşındıktan sonra tek bir yazma yolu açılmalıdır.

Mevcut R2 uygulama yedeği han_state payload'ını kapsar. Yeni han_core tablolarına yazmaya başlamadan önce tüm tabloları ve ekleri kapsayan tutarlı yedek/geri yükleme tamamlanmalıdır. Kontrollü ilk aktarımın checkpoint'i, sonraki yeni yazmaların yedeği yerine geçmez.

Outbox işçisi ağ hatasında sonucu `unknown` bırakır. Meta'nın mesajı alıp almadığı bilinmeden otomatik tekrar göndermez. İşlem dağıtık sistemde “tam olarak bir kez dış teslim” garantisi vermez. Enjekte edilen gönderici güncel hesap, telefon ve gönderim iznini yeniden denetlemelidir. Testlerde gerçek kişiye mesaj gönderilmez.
