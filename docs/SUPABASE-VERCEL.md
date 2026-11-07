# Han Hukuk: Supabase PostgreSQL + Vercel

## Bu aşamada yapılanlar

Mevcut iş verileri PostgreSQL JSONB içinde korunur. İlk performans aşamasında GET okumaları ortak yazma kilidinden ayrılmıştır; oturumlar, giriş deneme sayaçları ve bildirim okuma modeli ayrı tablolardadır. İş verisi değişiklikleri hâlâ `han_private.han_state` üzerinde transaction kullanır. Yeni kayıt bazlı model `database/next` altında pilottur ve otomatik migration kapsamına dahil değildir.

Kullanıcılar, salt ve parola hashleri değişmeden aktarılır. Supabase Auth kullanılmaz. Oturumlar yalnızca token hashleriyle ve giriş denemeleri süreli kayıtlarla PostgreSQL'de tutulur. Web üzerinden yönetici kurulumu bulut sürümünde kapalıdır. Veritabanı boşsa veya yapılandırma eksikse API 503 döndürür.

## Supabase

1. Ayrı bir test Supabase projesi oluşturun. Canlı kayıtları ilk test için kullanmayın.
2. Connect > Transaction pooler bağlantısını alın (6543). Bu, Vercel'in `DATABASE_URL` değeridir. Parolayı URL içinde gerektiği şekilde kodlayın.
3. Migration ve import işlemleri için Connect > Session pooler (5432) kullanın. CLI ortamında bunu `DATABASE_URL` olarak tanımlayın.
4. Bağlantılar TLS sertifikası doğrulanarak yapılır. Gerekiyorsa Supabase CA sertifikasını `DATABASE_CA_CERT` ortam değişkenine koyun; doğrulamayı kapatmayın.
5. `han_private` şemasını Data API'ye açmayın. Şema PUBLIC erişimine kapalıdır; tabloda RLS açıktır ve tarayıcı erişim politikası yoktur. Bu uygulama Data API kullanmadığı için Supabase Data API kapatılabilir. Backend veritabanı sahibi bağlantısıyla çalışır; anon/publishable/service-role API anahtarları gerekmez.

## Yerel doğrulama ve aktarım

Node.js 24 ve npm ile:

```sh
npm ci
npm test
npm run build
npm run db:migrate
npm run db:import -- "YEDEK_KLASORU/work/hanhukuk-state.json"
npm run db:verify -- "YEDEK_KLASORU/work/hanhukuk-state.json"
```

Bağlantı bilgisini git tarafından dışlanan `.env.local` dosyasına veya terminal ortamına koyun; komut argümanına/sohbete yapıştırmayın. Import mevcut verinin üzerine yazmaz. Verify tüm JSON içeriğini karşılaştırır; uygulama kullanılmaya başlamadan çalıştırın. Aktarım sırasında eski uygulamada kayıt girişini durdurun, güncel yedeği alın; ilk yedekten sonra değişen kayıtları unutmayın. Yedekteki veriler ve parola hashleri GitHub/Vercel kaynak paketine dahil edilmez.

## Vercel

- GitHub deposu: `htunahancakir-ux/hukuktakip`; yayın dalı: `main`.
- Framework preset: Other. Root directory: depo kökü. Node.js: 24.x.
- Build command: `npm run build`. Output directory: `public`.
- Sunucu tarafı environment: `DATABASE_URL` (transaction pooler), `APP_ORIGIN` (tam HTTPS origin, son slash yok).
- Örnek origin: `https://PROJE.vercel.app`. Preview ve Production için ayrı veritabanı ve uygun origin kullanın.
- Değişkenlerden sonra yeniden deploy edin. Eksik ayarla proje gerçek kayıtlara erişemez.
- Önce test deployment: giriş, çıkış, yetkiler, iki tarayıcıdan çakışan kayıt, tahsilat ve rapor toplamlarını kontrol edin. Sonra canlı veritabanını aktarın, doğrulayın ve production'a geçin.

## Canlı öncesi kalan sınırlar

- Vercel fonksiyonlarının gövde limiti nedeniyle bu uygulama API istek/yanıtlarını 4 MiB ile sınırlar. Büyük dosyalar ve büyüyen toplu liste yanıtları için özel Supabase Storage yüklemesi, yetkili indirme ve sayfalama sonraki aşamadır. Bu tamamlanmadan büyük evraklı üretim kullanımı açılmamalıdır.
- Bulutta bakım işi bildirim yoklamasından arka planda tetiklenir ve veritabanında en fazla dakikada bir sahiplenilir. Kullanıcı yokken zamanında işlem gerekiyorsa kimlik doğrulamalı cron ayrı kurulmalıdır.
- JSONB geçişi ayrıntılı finansal SQL tablolarının yerine geçmez. Toplu veri PUT işlemlerinde ETag/If-Match eski verinin üzerine yazılmasını reddeder; kullanıcı çakışmada sayfayı yeniler.
- Yedekleme, geri yükleme denemesi, erişim yetkileri incelemesi ve gerçek Supabase üzerinde entegrasyon testi tamamlanmadan canlı kabulü verilmemelidir.
- Yerel PGlite testleri gerçek PostgreSQL motoruyla sorguları sınar; Supabase ağ/TLS/pooler bağlantısını veya ayrı PostgreSQL bağlantılarındaki kilit davranışını doğrulamaz.

Resmî kaynaklar:
- https://supabase.com/docs/guides/database/connecting-to-postgres
- https://supabase.com/docs/guides/api/securing-your-api
- https://vercel.com/docs/functions/limitations
