# SaaS geliştirme dalı

Dal: `feat/saas-multi-tenant`.

Hedef: ortak uygulama ve ortak PostgreSQL üzerinde her hukuk bürosunun kullanıcı,
dosya, finans, belge ve yedeklerine yalnızca kendi yetkileriyle erişmesi.

## Bu aşamada hazır olanlar

- `han_saas.tenants`: benzersiz büro kodu ve büro yaşam döngüsü.
- `han_saas.memberships`: büro bazında owner/admin/member/viewer üyelikleri.
  Bu roller mevcut ceo/admin/personel rollerine henüz bağlanmadı.
- `han_saas.subscriptions`: deneme/abonelik, erişim bitişi ve satın alınan kullanıcı sayısı (`seat_limit` sütunu).
- `lib/saas/tenants.cjs`: büro, sahip üyeliği ve deneme aboneliğinin tek transaction
  içinde oluşturulması; üyelik, büro durumu ve abonelik süresi kontrolü.
- Yeni bürolar `provisioning` durumunda kalır. Otomatik etkinleştirme yoktur.
- Sentetik PostgreSQL testleri: `npm run test:saas`.
- `han_private` çalışma tabloları ve tüm `han_data` tablolarında tenant anahtarı,
  bileşik birincil/benzersiz/yabancı anahtarlar ve RLS politikaları eklendi.
- `createStore(pool, { tenantId })` her sorguyu `han_tenant_runtime` rolü ve
  transaction kapsamındaki tenant bilgisiyle çalıştırır. Tenant belirtilmezse
  uyumluluk için yalnızca `existing-office` bürosu kullanılır.
- İki bürolu testlerde aynı kullanıcı adı/kimlikler, oturum çerezi, yazma, audit,
  yedek, bakım ve numara sayaçları birbirinden ayrılır. Tenant değiştirerek yazma
  ve başka büroya yabancı anahtar bağlantısı kurma reddedilir.
- Yeni büroların R2 yedek yolu `hanhukuk/tenants/<tenant-id>/...` olur;
  başka büroların veya eski tek büro yedeklerinin indirilmesi reddedilir.

- **Büro çözümleme (alt alan adı):** `HAN_TENANT_BASE_DOMAIN` tanımlıysa `api/index.js`
  büroyu yalnızca `Host` başlığından çözer (`lib/saas/tenant-resolver.cjs`,
  `tenant-router.cjs`). `<kod>.<alan-adı>` yalnızca `enabled` büro ve süresi dolmamış
  `trialing/active` abonelikle açılır; aksi hâlde 403, geçersiz/iç içe host 404 döner.
  Kök alan adı mevcut büroyu (`existing-office`) olduğu gibi servis eder; bu büroya alt
  alandan erişilemez. Değişken tanımsızsa davranış eskisi gibi tek büroludur.
  `X-Forwarded-Host` ve benzeri istemci başlıkları yok sayılır. Her büro kendi
  `appOrigin` (`https://<kod>.<alan-adı>`) değeriyle ayrı bir handler alır; oturum çerezi
  Domain içermediğinden alt alana özeldir. Askıya alma/abonelik bitişi en geç 30 sn
  içinde (önbellek) etkili olur. Platform tarafında wildcard alan adı (`*.alan-adı`)
  ve TLS gerekir; bu dalda canlıya alınmadı.

**Fiyatlandırma modeli:** kullanıcı başına ücret. Büro kaç kullanıcı isterse o kadarını satın alır;
sabit paket kademesi yoktur. `seat_limit` (1–10000) büronun satın aldığı kullanıcı sayısıdır ve
her büroda ayrı değişir. 14 günlük deneme ve 3 kullanıcı yalnızca geliştirme varsayımıdır; fiyat
veya satış taahhüdü değildir. `plan_code` (`trial/starter/professional`) bu modelde gereksizleşebilir;
ödeme akışı tasarlanırken yeniden değerlendirilecek.

### Büro kaydı ve davet (servis katmanı)

HTTP uçları henüz yok; bunlar sunucunun doğruladığı kimlikle çağrılacak iç servislerdir.

- `provisionOffice` (`lib/saas/tenants.cjs`): tek transaction'da büro, deneme aboneliği, boş
  çalışma alanı, ilk yönetici (`ceo` hesabı + `owner` üyeliği). Büro `provisioning` kalır;
  etkinleştirme ayrı ve bilinçli bir adımdır. Bulutta `/api/setup` kapalı olduğundan ilk
  yönetici bu servisle oluşur.
- `lib/saas/invitations.cjs`: `createInvitation` (yalnızca büronun aktif owner/admin üyesi,
  yalnızca `enabled` ve aboneliği geçerli büro), `revokeInvitation`, `listInvitations`,
  `acceptInvitation`. Ham token bir kez döner, veritabanında yalnızca SHA-256 özeti tutulur.
  Davetler tek kullanımlık ve süreli (varsayılan 72 saat); bilinmeyen/iptal/süresi dolmuş
  davetler aynı hatayı verir. Davet `ceo` rolü veremez.
- `acceptInvitation` hesabı, üyeliği ve davetin tüketilmesini tek transaction'da yapar.
  **Kullanıcı sayısı sınırı abonelik satırı kilitliyken uygulanır**; eşzamanlı iki kabul
  sınırı aşamaz. Kullanıcı adı çakışması veya zayıf şifre daveti harcamaz.
- Davet e-postayla gönderilmez; bağlantıyı iletmek çağıranın işidir.

Bilinen sınırlar: (1) Kayıt deposu `active` olan bürolarda hesaplar han_state yerine kayıt
deposunda yaşar; bu kipte kullanıcı ekleme açık hatayla reddedilir (409). Yeni bürolar eski
(state) kipte başlar. (2) Sınır `memberships.status='active'` sayısına bakar; uygulama
içinde bir hesabı pasife almak henüz üyeliği iptal etmez, yani ayrılan kullanıcı kullanıcı
hakkını boşaltmaz. Hesap yaşam döngüsü ile üyelik eşitlenmeli (madde 2).
`ownerUserId` / `userId` yalnızca sunucunun doğruladığı kimlikten alınmalıdır.
Servisler genel kullanıma açık HTTP uçları değildir.

### Süper yönetici (platform) konsolu

Platform (satıcı firma) adı **Hukuk Takip Platformu**; konsolun adı **Hukuk Takip Platformu Yönetim**.
Bu ad konsol başlığında, iki aşamalı doğrulama uygulamasında, SMS deneme mesajında ve iyzico
ödeme açıklamasında görünür.

Satış operasyonu için `admin.<alan-adı>` ana bilgisayarında çalışan ayrı bir konsol:
`outputs/icrapro/platform.html|css|js`, API `lib/platform-app.cjs`, iş mantığı
`lib/saas/platform.cjs`, kimlik `lib/saas/platform-auth.cjs`. `admin` zaten ayrılmış bir
büro kodudur; çözücü bu host'u büro yerine konsola yönlendirir. Konsol ofis oturumlarıyla
hiçbir şey paylaşmaz: ayrı hesaplar, ayrı çerez (`han_platform`, host-only, 8 saat),
ayrı origin kontrolü ve hız sınırı (IP başına ve hesap başına 15 dakikada 8 deneme).

- **İlk operatör** yalnızca sunucudan oluşturulur, herkese açık kurulum ucu yoktur:
  `PLATFORM_ADMIN_PASSWORD='…' npm run platform:admin -- create <kullanıcı> "<Ad Soyad>"`
  (şifre en az 12 karakter, ortam değişkeninden okunur).
- **Satışla büro açma** (`openOffice`): büro, ilk yönetici, satın alınan kullanıcı sayısı,
  kullanıcı başı aylık fiyat, süre (1–36 ay), ek modüller, indirim ve tahsilat durumu tek
  transaction'da yazılır; büro hemen `enabled` olur. Satış defteri kalemlere ayrılır
  (yeni büro / modül / indirim). **Tüm tutarlar sunucuda hesaplanır**; arayüzdeki tutar
  yalnızca önizlemedir. Tutarlar tam sayı kuruştur (TRY).
- **Kullanıcı sayısı** (`changeUsers`): artış kalan süreye oranlı faturalanır (operatör
  tutarı değiştirebilir); azaltma kullanılan hesap sayısının altına inemez ve otomatik iade
  üretmez. Davet kabulündeki sınır bu değeri kullanır.
- **Ek modüller:** katalog operatör tarafından yönetilir. **Hiçbir modül varsayılan olarak
  fiyatlı veya satışta değildir**; tohum kayıtları (`voip`, `whatsapp`, `ai-assistant`,
  `marketing-routes`, `marketing-routes-service`) kapalı ve fiyatsız gelir. Fiyat satış anında büroya kilitlenir;
  katalog fiyatı sonra değişse de mevcut bürolar anlaştıkları fiyatta kalır.
- **Yenileme** (`renewOffice`), **tahsilat** (`markSalePaid`), **iptal** (`voidSale`, kayıt
  silinmez, gerekçe zorunlu), **iade** (`recordRefund`, büronun tahsil edilen toplamını
  aşamaz). Gelir, satış `paid` olduğunda tanınır (nakit esaslı); bekleyenler alacak sayılır.
- **Firmayı pasife alma** (`setOfficeStatus`): `enabled ⇄ suspended`, `closed` kalıcıdır.
  Pasif/kapalı büro, host çözücünün önbelleği (en çok 30 sn) dolunca hiçbir isteği
  karşılamaz; veri silinmez. Gerekçe zorunludur. Etkinleştirme geçerli abonelik ister.
  **Kök alan adındaki mevcut büro pasife alınamaz** (409): o büro durum kontrolü olmadan
  servis edilir.
- **Dashboard:** aktif büro, satılan/kullanılan kullanıcı, aylık yinelenen gelir (yalnızca
  ödemeli, süresi dolmamış, aktif bürolar), bu ay/geçen ay tahsilat, bekleyen alacak,
  12 aylık tahsilat grafiği, gelir türleri, modül bazında gelir, yakında bitenler/dolanlar
  ve kullanıcı limiti dolu bürolar. Rakamlar satış defterinden türetilir ve testlerle
  defter toplamıyla doğrulanır.
- Her operatör işlemi `han_saas.tenant_events` tablosuna işlenir (kim, ne, ne zaman).
- Sayfa `Content-Security-Policy` (inline script/stil yok) ve `X-Frame-Options: DENY` ile
  sunulur (`vercel.json`); arayüz yalnızca `textContent` ile çizer.

Bilinen sınırlar: (1) Satış kataloğundaki beş modül (`voip`, `ai-assistant`, `whatsapp`,
`marketing-routes`, `marketing-routes-service`) özellik kapısına bağlıdır (aşağıya bakın); katalogda sonradan eklenen başka
bir modül, kapıya bağlanana kadar yalnızca kayıt altına alınır ve konsolda "özellik kapısı yok"
diye işaretlenir. (2) Satışı iptal etmek verilen hizmeti (kullanıcı, modül, süre) geri almaz.
(3) Konsol yerel geliştirme sunucusunda (`npm start`) çalışmaz; `HAN_TENANT_BASE_DOMAIN` ve
`admin.` alt alanı gerekir. Yerelde görmek için `npm run platform:preview`. (4) Destek kaydı
yalnızca bir operatöre "üstlen" ile atanır; başka operatöre atama yoktur.

#### Konsolu canlıda açma (sırayla)

Konsol, çok bürolu yönlendirme açılınca çalışır. Mevcut büro `www.<alan-adı>` ve kök alan
adında değişmeden kalır.

1. **Geçişler:** main klasöründe `npm run db:migrate` (bekleyen geçiş varsa uygular).
2. **Operatör hesabı:** main klasöründe, şifre en az 12 karakter:
   `$env:PLATFORM_ADMIN_PASSWORD='…'; npm run platform:admin -- create <kullanıcı> "<Ad Soyad>"`
   (PowerShell). Şifre veritabanında yalnızca özet olarak durur; kimse geri okuyamaz.
3. **Vercel → proje → Settings → Domains:** `admin.<alan-adı>` eklenir. DNS'te `*.<alan-adı>`
   zaten Vercel'e bakıyorsa ek kayıt gerekmez. Her yeni büro için `<kod>.<alan-adı>` de buradan
   eklenir (joker alan adı Vercel ad sunucuları ister).
4. **Vercel → Settings → Environment Variables (Production):**
   `HAN_TENANT_BASE_DOMAIN=<alan-adı>` (ör. `hanhukuktakip.com`, `www.` ve `https://` olmadan).
   İsteğe bağlı: `PLATFORM_ENCRYPTION_KEY` (64 onaltılık karakter; yoksa `AI_ENCRYPTION_KEY` ya
   da `BACKUP_ENCRYPTION_KEY` kullanılır). Değişkenler yeni yayında geçerli olur: **Redeploy**.
5. **Doğrulama:** `https://admin.<alan-adı>` giriş ekranını açar; `https://www.<alan-adı>` eskisi
   gibi çalışır; `https://admin.<alan-adı>/api/platform/session` 200 döner.

Bu değişken açıldıktan sonra uygulama yalnızca `<alan-adı>`, `www.`, `admin.` ve kayıtlı büro
adreslerinde yanıt verir; `*.vercel.app` adresleri 404 döner. Tek istisna Vercel'in kendi
adresinden çağırdığı zamanlanmış işlerdir (`/api/backups/cron`, `/api/personnel-ledger/cron`):
bunlar mevcut büro için çalışmaya devam eder (`lib/saas/tenant-resolver.cjs`). Geri almak için
değişken silinip yeniden yayınlanır; veri değişmez.

#### Modül kapıları (telefon, yapay zekâ, WhatsApp ve pazarlama ayrı satılır)

Bir büro **modülsüz satılabilir**: `moduleCodes: []` ile açılan büroda telefon, yapay zekâ,
WhatsApp ve pazarlama/rota kapalıdır; modül sonradan konsoldan satılınca (`addModule`) açılır, çıkarılınca kapanır.
Değişiklik en geç 15 sn içinde (`createModuleGate` önbelleği) uygulanır.

- **Sunucu:** `lib/saas/module-gate.cjs`. Kapalı modülün istekleri `403` alır:
  `/api/voip/*` (webhook ve cron dahil), `/api/ai/*`, `/api/documents/conversation-report`,
  `/api/whatsapp/*` ve `/api/marketing/*` (harita araması ve rota planı; potansiyel müvekkil
  listesi `/api/marketing-prospects` bu modülün parçası değildir, temel kayıttır).
  WhatsApp kapalıyken uygulamanın başka yerlerinden doğan WhatsApp gönderimleri
  (mesaj/iş emri/hatırlatma) sessizce gönderilmez ve zamanlanmış hatırlatma işi atlanır;
  yalnızca **şifre sıfırlama bağlantısı** kapıdan etkilenmez (hesap kurtarma ücretli mesajlaşma
  özelliği sayılmaz; yine de WhatsApp ayarı modül olmadan yapılamadığı için modülsüz büroda
  bağlantı gönderilemez; o büroda "Şifremi unuttum" platform SMS'i ile çalışır (aşağıya bakın).
  Kontrol büro oturumundan önce yapılır, yani kapalı modül için oturumsuz istek de 403 olur.
  Kontrol kontrol düzlemine **sorulamazsa reddeder** (503); özellik hiçbir zaman "sorulamadığı
  için" açılmaz.
- **Mevcut büro** (kök alan adı, eski müşteri) tüm özellikleri korur.
- **Arayüz:** `/api/modules` bayrakları döner. Kapalı modülde "Numara ara" düğmesi, görüşme
  kayıtları, borçlu ekranındaki arama, VoIP/Yapay Zekâ/WhatsApp/Google Haritalar entegrasyon
  sekmeleri, VoIP yetkilendirme sekmesi, "WhatsApp'tan da gönder" kutuları, evrak WhatsApp
  düğmeleri, "Rota Bulma" ve otomatik görüşme özeti gizlenir. Bu yalnızca görünümdür; asıl
  zorlama sunucudadır.
- `GATED_MODULES` listesi tek yerde (`module-gate.cjs`); yeni bir modülü kapıya bağlamak için
  oraya eklenir ve ilgili yol `lib/application.cjs` içindeki `moduleForPath`'e yazılır.
- **Rota Bulma iki ürünle açılır:** `marketing-routes` (modül, büro kendi anahtarını girer)
  veya `marketing-routes-service` (aylık abonelik, platformun harita servisi). `/api/marketing/*`
  ikisinden biri satılmışsa açıktır; hangi kaynağın kullanılabileceği ürüne göre ayrıca
  denetlenir (aşağıdaki "Harita servisi" bölümü).

#### Harita servisi (Rota Bulma aboneliği)

Migration: `20261113130000_maps_service.sql` (yeni tablo yok; katalog satırı ve `usage_daily`
ölçüleri). Kod: `lib/saas/platform-maps.cjs`.

Rota Bulma bürolara iki biçimde satılır:

| Ürün | Katalog kodu | Büro tarafı | Maliyet |
| --- | --- | --- | --- |
| Modül | `marketing-routes` | Ayarlar'a **kendi** Google Places anahtarını / tarama sunucusunu girer | Google ücreti büroya aittir |
| Aylık abonelik | `marketing-routes-service` | Kurulum yok; kaynak olarak "Hazır harita servisi" görünür | Her arama **platformun** Google hesabından ücretlenir |

- **Konsol → Yönetim → Harita servisi:** Google Places API anahtarı (şifreli saklanır, hiçbir
  büroya ve tarayıcıya gönderilmez), isteğe bağlı **harita anahtarı** (tarayıcı anahtarı; abone
  büroların ekranında Google haritasını açar, Places anahtarının aynısı olamaz), aç/kapa ve iki
  sınır: **büro başına aylık arama** (varsayılan 300) ve **büro başına aylık rota yenileme**
  (firma sayısı, varsayılan 3000). "Anahtarı test et" ücretsiz bir kimlik aramasıdır. Şifreleme
  `PLATFORM_ENCRYPTION_KEY` ile yapılır.
- **Sayaç:** platform anahtarıyla yapılan her "Bul" ve "Daha fazla getir" bir aramadır;
  kayıtlı bir rotayı açmak durak sayısı kadar "firma yenileme"dir. İstek başarıyla bittikten
  sonra `han_saas.usage_daily` tablosuna (`maps_searches`, `maps_details`) büro ve gün bazında
  yazılır. Hak, İstanbul saatine göre ay başında sıfırlanır.
- **Hak dolunca** büro 429 ve "Bu ayki arama hakkınız doldu" mesajını alır; istek Google'a
  gitmez. Servis kapalıysa ya da kontrol düzlemine sorulamıyorsa servis "hazır değil" sayılır;
  hiçbir zaman denetimsiz istek atılmaz. Sayaç yazılamazsa arama yine tamamlanır (ölçüm
  aramayı bozmaz), bu yüzden sınır eşzamanlı isteklerde birkaç arama aşılabilir.
- **Yalnızca aboneliği olan büro** kendi anahtarını giremez ve kullanamaz (403); Ayarlar'daki
  Google Haritalar sayfasında yalnızca sektör listesini düzenler. İki ürünü birden alan büroda
  her iki kaynak da seçilebilir.
- **Kârlılık:** birim maliyetlere "Harita servisi: bir arama" ve "rota yenilemede bir firma"
  eklendi; tahmini maliyet büro satırında ve `marketing-routes-service` ürününde görünür.
- **Mevcut büro** (kök alan adı) her iki ürüne de sahiptir; konsolda servis açılırsa orada da
  "Hazır harita servisi" kaynağı görünür ve aynı sınır uygulanır.

Bilinen sınırlar: (a) Servis yalnızca Google Places API ile çalışır; platform tarafında harita
tarama (gosom) kaynağı yoktur. (b) Sınırlar tüm bürolar için ortaktır, büroya özel sınır yoktur.
(c) Aylık hak paket satın alarak artırılamaz; sınır konsoldan yükseltilir. (d) Google haritası
(harita anahtarı) gerçek bir Google anahtarıyla denenmedi; yalnızca taklit kütüphaneyle test
edildi. (e) Google koşulları Places sonuçlarının Google dışı haritada gösterilmesini yasaklar:
harita anahtarı girilmezse abone bürolar firmaları haritada nokta olarak göremez (bölge çizimi ve
süzme çalışır). Ücretli hizmette harita anahtarının girilmesi önerilir.

#### Yedekleme (tüm bürolar ve yönetim)

Her büro kendi yedeğini Ayarlar → Yedekleme'den alır (`lib/backup-service.cjs`). Konsol bunun
üstüne **toplu yedek** ekler (`lib/saas/platform-backup.cjs`, Konsol → Yönetim → Yedekleme):

- **Şimdi tümünü yedekle:** önce yönetim verisi, sonra her büro sırayla yedeklenir (en eski
  yedeği olan büro önce). Büro yedeği, büronun kendi aldığı dosyayla aynıdır ve kendi
  klasörüne yazılır (`hanhukuk/production/` mevcut büro, `hanhukuk/tenants/<büro>/production/`
  diğerleri); büro yöneticisi dosyayı kendi ekranında görür. Büro verisi her zaman büronun
  kendi satır güvenliği (RLS) bağlantısıyla okunur.
- **Yönetim yedeği:** `han_saas` şemasındaki bütün tablolar tek şifreli dosyada
  (`hanhukuk/platform/production/`). Yeni eklenen tablo kendiliğinden yedeğe girer. Girmeyenler:
  oturumlar, giriş denemesi sayaçları, tek kullanımlık destek kodları ve ayarlardaki mühürlü
  sağlayıcı bilgileri (SMS şifresi, harita anahtarı). Dosya biçimi büro yedeğiyle aynıdır
  (`BACKUP_ENCRYPTION_KEY` ile AES-256-GCM); içinde her tablo satır listesi olarak durur.
- **Otomatik:** onay kutusu açılırsa Vercel'in her gün 03:00 UTC'de (06:00 TSİ) çağırdığı
  `/api/backups/cron` isteği, mevcut büronun yedeğinden sonra toplu yedeği de başlatır. Son 12
  saatte yedeği alınmış büro atlanır. Varsayılan kapalıdır.
- **Süre sınırı:** bir çalıştırma en çok ~90 sn (otomatikte ~70 sn) büro yedekler; kalan
  bürolar "sırada" görünür ve bir sonraki çalıştırmada önce onlar alınır.
- **İndirme:** konsoldan yalnızca yönetim yedeği indirilebilir; büro dosyaları konsola
  verilmez (anahtar başka bir klasörü gösteriyorsa depo sorulmadan 404 döner). Çalıştırma,
  otomatik ayarı ve indirme işlemleri operatör işlem kaydına yazılır.

Bilinen sınırlar: (a) Yönetim yedeği için hazır bir geri yükleme komutu yoktur; dosya
`decryptState` ile açılır ve tablolar `jsonb_populate_recordset` ile yüklenir (elle, bir kez
yapılacak iş). `npm run backup:restore` yalnızca mevcut büronun yedeğini geri yükler; diğer
bürolar için büro seçimi henüz yoktur. (b) Büro sayısı
arttıkça tek istekte hepsi yetişmeyebilir; bu durumda düğmeye yeniden basılır ya da ayrı bir
zamanlanmış iş eklenir. (c) Büronun giriş ekranı görseli (`office_branding`) büro yedeğinde
değildir.

#### Satışlarda KDV

Satış defterindeki tutarlar **KDV hariçtir**. KDV oranı her satış kaydında saklanır (formda
varsayılan %20, satış başına değiştirilebilir; yasal oran değişirse eski kayıtlar etkilenmez).
KDV satır başına `round(tutar × oran / 100)` ile hesaplanır (yarım değerler sıfırdan uzağa;
iade, eşit satışın KDV'sini birebir geri alır). Satışlar sekmesi ay seçer; her satırda
KDV hariç / oran / KDV / KDV dahil, altta **ay sonu toplamı** (KDV hariç, KDV, KDV dahil),
bekleyenlerin ayrı toplamı ve KDV oranına göre döküm gösterir. Tahsil edilenler **tahsilat
tarihinin** ayına yazılır; fatura tarihine göre beyan için faturalama entegrasyonu gerekir.

#### Giderler ve kârlılık

`han_saas.expenses`: reklam, pazarlama, sunucu, yapay zekâ kullanımı, telefon, yazılım,
personel, diğer. Tutar KDV hariç, oran gider başına (indirilecek KDV). Gider isteğe bağlı
olarak tek bir büroya bağlanabilir (örn. o büronun yapay zekâ kullanımı); büro detayında
"gider / net katkı" görünür. Silinmez, iptal edilir. **Finans** sekmesi son 12 ayı gösterir:
satış (KDV hariç), hesaplanan KDV, gider, indirilecek KDV, kâr, **ödenecek KDV** ve yeni büro
başına reklam-pazarlama maliyeti. Döviz faturaları TL karşılığıyla girilir. Bu bir mali
müşavirlik hesabı değildir.

#### Destek kayıtları

`han_saas.support_tickets` / `support_messages` (yalnızca kontrol düzlemi; büro erişemez).
Operatör telefon/WhatsApp/e-postayla gelen talebi kaydeder, müşteriye yanıt yazar, iç not alır,
müşteri mesajını kaydeder, öncelik/durum/üstlenme değiştirir. Her durum, öncelik ve atama
değişikliği "sistem" satırı olarak kayda işlenir. İlk yanıt hedefi öncelikten gelir (acil 4,
yüksek 8, normal 24, düşük 72 saat); ilk yanıt verilmeden süre aşılırsa kayıt "gecikmiş"
sayılır. Müşteri mesajı kapalı olmayan kaydı yeniden açar; kapalı kayda mesaj eklenmez.
Talep metnine müvekkil/dosya bilgisi yazılmaması arayüzde hatırlatılır.

**Büro tarafı:** Ayarlar → **Destek** sekmesinde büronun CEO'su ve yöneticileri kayıt açar,
operatör yanıtlarını okur, yanıt yazar (`lib/saas/office-support.cjs`, `/api/support`). Büro
yalnızca kendi kayıtlarını görür; iç notlar, sistem satırları ve operatörlerin adları büroya
gösterilmez (yanıtlar "Destek ekibi"nden gelir). Büro öncelik olarak en fazla "yüksek" seçebilir
("acil"i operatör belirler), aynı anda en fazla 25 açık kaydı ve kayıt başına 200 mesajı olabilir.
Büronun yanıtı çözülmüş kaydı yeniden açar; kapatılmış kayda yazılamaz. Kayıtlar konsolda
"portal" kanalıyla görünür. Büro tabloya erişmez: sunucu kontrol düzlemi bağlantısıyla yazar ve
her sorguyu hizmet verdiği büroyla sınırlar.

#### Operatör güvenliği (iki aşamalı doğrulama, operatör yönetimi)

Konsolun **Yönetim** sekmesi: kendi hesabın (şifre değiştirme, iki aşamalı doğrulama),
operatör listesi ve hesap işlem kayıtları (`lib/saas/platform-account.cjs`, `totp.cjs`).

- **İki aşamalı doğrulama (TOTP, RFC 6238)** her authenticator uygulamasıyla çalışır (SHA-1,
  6 hane, 30 sn, ±1 pencere). Kurulum: uygulamaya "anahtar gir" ile gizli anahtar eklenir,
  üretilen kod doğrulanınca etkinleşir ve **8 tek kullanımlık kurtarma kodu** bir kez gösterilir
  (veritabanında yalnızca özetleri). Giriş şifreden sonra kod ister; aynı 30 sn penceresi iki
  kez kabul edilmez (son adım saklanır), kurtarma kodu bir kez geçer. QR kodu yoktur (kitaplık
  bağımlılığı eklenmedi); anahtar elle girilir.
- Gizli anahtar AES-256-GCM ile mühürlenir; anahtar `PLATFORM_ENCRYPTION_KEY` (64 hex),
  yoksa `AI_ENCRYPTION_KEY` / `BACKUP_ENCRYPTION_KEY`. Sunucuda anahtar yoksa kurulum 412 ile
  reddedilir, gizli anahtar okunabilir saklanmaz.
- **Ne zaman zorunlu:** varsayılan olarak platform SMS'i (Yönetim → SMS) kurulup açılana kadar
  isteğe bağlıdır; SMS açıldığında (en geç 15 sn içinde) zorunlu olur. `PLATFORM_REQUIRE_TOTP=1`
  her zaman zorunlu, `=0` hiçbir zaman zorunlu değil yapar. Zorunluyken iki aşamalı doğrulaması
  olmayan operatör yalnızca "Hesabım" sayfasına erişir (kurmak için); kurana kadar konsolun başka
  hiçbir ucu açılmaz ve kapatılamaz.
- Kapatmak için şifre + güncel kod gerekir. Şifre değişince diğer tüm oturumlar kapanır.
- Operatörler birbirini ekleyebilir, pasife alabilir, şifresini ve iki aşamalı doğrulamasını
  sıfırlayabilir (hedefin oturumları kapanır). Kimse kendi hesabını pasife alamaz; kendi şifresini
  ve iki aşamalı doğrulamasını "Hesabım"dan yönetir. Her işlem `han_saas.platform_audit` kaydına yazılır.
  Sınır: tüm operatörler eşit yetkilidir (rol ayrımı yok).

#### Platform SMS (Verimor) ve şifre kurtarma

Satıcı firmanın kendi Verimor SMS hesabı konsolda **Yönetim → SMS (Verimor)** bölümünden
ayarlanır (`lib/verimor-sms.cjs`, `lib/saas/platform-sms.cjs`): hesap numarası (kullanıcı adı),
API şifresi (AES-256-GCM ile mühürlü, `PLATFORM_ENCRYPTION_KEY`; geri gösterilmez), SMS başlığı
ve "açık" anahtarı. "Bağlantıyı test et" kalan krediyi ve tanımlı başlıkları getirir; "Deneme SMS"
kısa bir mesaj gönderir. Her gönderim `han_saas.sms_log` tablosuna **maskeli numarayla** yazılır
(mesaj metni saklanmaz); konsol aylık SMS/kredi sayısını ve son gönderimleri gösterir. Bir büro
günde en fazla 30 SMS tetikleyebilir.

**Şifremi unuttum:** Büro kendi WhatsApp entegrasyonunu (şifre şablonuyla) kurmuşsa bağlantı
WhatsApp'tan gider. Kurmamışsa ve platform SMS'i açıksa, hesabın kayıtlı cep telefonuna (personel
kaydı veya hesap iletişim bilgisi) **8 haneli, 15 dakika geçerli, tek kullanımlık geçici şifre**
SMS ile gider (`lib/sms-recovery.cjs`). Ekran doğrudan "SMS ile giriş" adımına geçer: geçici şifre
ve yeni şifre girilir, şifre kaydedilir ve kullanıcı yeni şifresiyle otomatik giriş yapar.
- Yanıt, hesabın var olup olmadığını hiçbir zaman belli etmez.
- Kod yalnızca özetiyle saklanır; 5 yanlış denemede, kullanıldığında veya şifre değiştiğinde
  geçersiz olur. Hesap başına günde 3, 7 günde 6, 30 günde 12 talep; IP başına sınır ayrıca var.
- Geçici şifre **normal giriş formunda** değil "Şifremi unuttum → SMS ile giriş" ekranında
  kullanılır: bulutta giriş isteği yalnızca hesap dizinini görür ve iş verisine yazamaz, tek
  kullanımlık kodu orada tüketmek güvenli değildir.
- SMS, işlem veritabanına yazıldıktan sonra gönderilir; tekrar denenen bir işlem iki kod göndermez.

**Konsoldan yönetici şifresi sıfırlama:** Büro detayında **Yönetici şifresi**: büronun CEO/yönetici
hesapları (maskeli telefonla) listelenir. İki yöntem: (1) kayıtlı cep telefonuna SMS ile geçici
şifre (kişi "Şifremi unuttum → SMS ile geçici şifre aldım" ekranından yeni şifresini belirler;
günlük sınıra takılmaz ama sayılır); (2) konsolda **bir kez gösterilen** 12 karakterlik geçici
şifre (hesabın açık oturumları kapanır; kişi girişten sonra şifresini ayarlardan değiştirmeli —
zorunlu değiştirme yok). Her sıfırlama büro işlem geçmişine yazılır, geçici şifre yazılmaz.
Kayıt deposu etkin bürolarda konsoldan sıfırlama yapılamaz (409).

**Canlıdan önce:** Verimor API'si yalnızca **izinli IP adreslerinden** gelen istekleri kabul eder.
Vercel sunucusuz fonksiyonların çıkış IP'si sabit değildir; sabit çıkış IP'si (ör. Vercel Static IPs /
Secure Compute ya da sabit IP'li bir aracı) olmadan test "IP izni" hatası verir. Gerçek Verimor
hesabıyla uçtan uca deneme yapılmadı; istek biçimi Verimor'un SMS API v2 belgesinden alındı.

#### Kullanıcı sayısı sınırı

Fiyat kullanıcı başına olduğu için satın alınan sayı uygulamada **uygulanır**
(`lib/saas/seat-gate.cjs`, `lib/seat-limit.cjs`): ayarlardan veya personel kaydından yeni
hesap eklemek ya da pasif bir hesabı açmak, aktif hesap sayısını satın alınandan fazla
yapacaksa 409 ile reddedilir. Yalnızca artış engellenir: planı küçülen büro mevcut
kullanıcılarını düzenleyebilir ve pasife alabilir. Mevcut büro (kök alan adı) sınırsızdır.
Sınır sorulamazsa hesap eklenmez (503). Konsoldaki "kullanıcı" sayısı artık büronun kendi
uygulamasında oluşturduğu hesapları da sayar (üyelik sayısı ile uygulama hesaplarının büyüğü).
Kayıt deposu `active` olan bürolarda hesaplar başka yerde yaşadığı için bu sayım bir üst
sınır tahminidir.

#### Online ödeme (iyzico)

İki ayrı kullanım vardır ve iki ayrı iyzico hesabı kullanır:

1. **Platform satışlarının tahsili** (sizin hesabınız). Ortam değişkenleri:
   `IYZICO_API_KEY`, `IYZICO_SECRET_KEY`, `IYZICO_BASE_URL` (`sandbox` varsayılan, `live`).
   Tanımsızsa konsolda "Online ödeme linki" düğmesi görünmez. Büro detayında düğme, bürounun
   bekleyen satışlarının **KDV dahil** toplamı için iyzico Checkout Form oluşturur. Müşteri
   iyzico sayfasında öder; tarayıcı `/api/platform/pay/callback` adresine döner. Sunucu sonucu
   iyzico'dan token ile **kendisi okur**, yanıt imzasını (`lib/iyzico.cjs`) ve tutar, para
   birimi, sipariş/sepet numarasını doğrular; ancak o zaman satış satırlarını "tahsil edildi"
   yapar. Tutar tutmuyorsa veya satırlar bu arada değişmişse ödeme **"inceleme gerekli"**ye
   alınır, defter değiştirilmez. Aynı callback'in tekrarı defteri bir kez işler. Yeni link
   oluşturulunca eskisi "yenilendi" olur; eski linkle ödeme gelirse inceleme kaydı düşer.
   `han_saas.online_payments` tablosu ve `tenant_events` ödeme izini tutar.
2. **Büroların kendi müşterilerinden tahsilatı** (her büronun kendi hesabı):
   Ayarlar → Entegrasyonlar → **iyzico Ödeme** (yalnızca CEO). API anahtarı ve gizli anahtar
   AES-256-GCM ile şifreli saklanır (`IYZICO_ENCRYPTION_KEY`, yoksa `AI_ENCRYPTION_KEY` /
   `BACKUP_ENCRYPTION_KEY`), tarayıcıya geri gösterilmez ve yedek dosyalarına yazılmaz.
   "Anahtarları test et" ve belirlenen tutar için paylaşılabilir **iyzico ödeme linki**
   oluşturma vardır. Para doğrudan büronun iyzico hesabına geçer.

Doğrulama durumu: imzalama (IYZWSv2), Checkout Form uçları ve yanıt imzası kuralları iyzico
dokümanından alındı ve sahte iyzico ile test edildi (`tests/iyzico.test.cjs`,
`tests/platform-payments.test.cjs`, `tests/iyzico-settings.test.cjs`). **Gerçek iyzico
sandbox hesabıyla uçtan uca deneme henüz yapılmadı**; canlıya almadan önce yapılmalı.
Bilinen sınırlar: (a) Büroların oluşturduğu ödeme linkleri için tahsilat otomatik
eşleştirilmez; büro sonucu iyzico panelinden izler, uygulamadaki muhasebe/borçlu kayıtlarına
otomatik yansımaz. (b) iyzico, alıcı için kimlik numarası ister; boş bırakılırsa belgelerdeki
deneme değeri gönderilir. Canlı ödemede gerçek TC/vergi numarası girilmelidir. (c) iyzico Link
API'si ürün görseli ister; 1×1 şeffaf bir görsel gönderilir ve hesapta "ödeme linki" yetkisi
açık olmalıdır. (d) Abonelik otomatik yenileme/tekrarlayan tahsilat yok; her ödeme bir link.
(e) Platform tarafında iade iyzico üzerinden yapılmaz; iade defterde kaydedilir ve iyzico
panelinden ayrıca yapılmalıdır.

Migration mevcut migration çalıştırıcısıyla uygulanabilir (`npm run db:migrate`).
Bu geliştirme sırasında canlı veritabanına uygulanmadı. Önce ayrı test ortamında
denenmeli; dal için üretimden ayrı veritabanı ve deployment kullanılmalıdır.

### Ürünler, kampanyalar, duyurular, satış hunisi ve kârlılık

Migration'lar: `20261112090000_product_catalog.sql`, `20261112100000_campaigns.sql`,
`20261112110000_announcements_and_pipeline.sql`, `20261112120000_usage_and_profit.sql`.
Hepsi yalnızca kontrol düzlemindedir (`han_saas`, RLS açık, çalışma rolüne yetki yok).

**Ürünler** (`lib/saas/platform.cjs`)
- Türler:
  - Aylık modül: bir özellik kapısını açar.
  - Kullanım paketi: tek seferlik, örneğin 1000 SMS.
  - Hizmet: tek seferlik, örneğin kurulum.
- Durumlar: Taslak → Yakında (duyurulur, satılmaz) → Satışta → Satıştan kalktı. Her ürünün özellik maddeleri ve deneme süresi vardır.
- Paket ve hizmetler büroya `sellProduct` ile satılır.
- Satılmış bir ürünün türü değiştirilemez.
- Konsol yeni bir yazılım özelliği açmaz: yeni bir özellik ancak kodda yazılıp `module-gate.cjs` kapısına bağlanınca çalışır.

**Ücretsiz deneme**
- `startTrial` modülü `trial_until` tarihine kadar açar; süre dolunca kapı kendiliğinden kapanır.
- Her büro her modülü bir kez dener.
- "Modül ekle" denemeyi ücretliye çevirir.

**Kampanya ve kupon** (`lib/saas/campaigns.cjs`)
- İndirim yüzde ya da tutar olabilir. Tutar aylık ürünlerde aylık, tek seferlik ürünlerde birim başınadır.
- Süre: ilk ay, ilk 3 ay ya da tüm süre.
- Kapsam: seçilen ürünler. `users` kullanıcı lisansı demektir; boş liste tüm ürünlerdir.
- Hedef kitle: herkes, yeni bürolar, ürünü almamışlar, denemedekiler ya da seçili bürolar.
- Tarih aralığı, kupon kodu ve kullanım sınırı verilebilir.
- İndirim sunucuda hesaplanır ve satış defterine `campaign_id` taşıyan `adjustment` satırları olarak yazılır.
- Her büro bir kampanyayı bir kez kullanır. Kullanım sınırı eşzamanlı satışlarda da aşılamaz.
- Kullanılmış bir kampanyanın indirim koşulları değiştirilemez.

**Duyurular** (`lib/saas/announcements.cjs`, büro tarafı `lib/saas/office-catalog.cjs`)
- Türler: yeni ürün, kampanya, fiyat değişikliği ya da planlı bakım.
- Büro ana sayfasında aynı anda en fazla bir kart görünür.
- Satış kartları yalnızca CEO ve yöneticilere gider; personel yalnızca bakım duyurusunu görür.
- "Kapat" denen kart o kişiye bir daha gösterilmez.
- "İlgileniyorum", satış hunisine bir fırsat açar.
- Konsol her duyuru için şu sayıları gösterir: kaç büroya ve kaç kişiye gösterildiği, kaç kez tıklandığı, kapatıldığı ve "İlgileniyorum" dendiği.

**Büro tarafı "Modüller" sayfası** (Ayarlar, yalnızca CEO ve yönetici)
- Abonelik ve kullanıcı hakkı.
- Büronun modülleri ve denemeleri.
- Satılabilir ürünler ve geçerli kampanyaları.
- "Talep et" düğmesi. Aynı ürün için açık bir talep varsa yenisi açılmaz.
- Kök alandaki mevcut büroda bu sayfa ve duyurular yoktur.

**Satış hunisi** (`lib/saas/pipeline.cjs`)
- İki tür fırsat vardır: yeni büro ve mevcut büroya ek satış.
- Aşamalar: yeni → görüşüldü → demo → teklif → kazanıldı / kaybedildi. Kaybedildi için neden yazmak zorunludur.
- Notlar, sorumlu, sonraki adım tarihi ve "bugün aranacaklar" listesi vardır.
- Dönüşüm oranı son 12 ayın kazanılan / (kazanılan + kaybedilen) oranıdır.
- `openOffice`, `addModule` ya da `sellProduct` çağrısına `prospectId` verilirse fırsat aynı işlemde kazanıldı olarak kapanır.

**Kullanım maliyeti ve kârlılık** (`lib/saas/usage-meter.cjs`, `lib/saas/profit.cjs`)
- **Yapay zekâ kullanımı:** büro ve gün bazında `usage_daily` tablosuna yazılır. İstek veritabanına kaydedildikten sonra sayılır, böylece yeniden denenen bir istek iki kez sayılmaz.
- **SMS ve telefon:** SMS `sms_log` tablosundan, telefon dakikası `han_private.voip_calls` tablosundan okunur.
- **Harita servisi:** Rota Bulma aboneliğinin aramaları ve rota yenilemeleri `usage_daily` tablosundan okunur (`maps_searches`, `maps_details`).
- **Birim maliyetler** konsolda girilir: 1 milyon girdi ve çıktı tokenı, SMS parçası, telefon dakikası, harita servisinde bir arama ve bir firma yenileme.
- **Kullanım maliyeti bir tahmindir.** Yalnızca büro ve ürün kârını paylaştırmak için kullanılır. Aylık kâr/zarar yalnızca girilen gerçek giderlerle hesaplanır; böylece aynı maliyet iki kez sayılmaz.
- **Ürün kârı:** ürünün satışları, yenilemelerdeki payı (`sales.breakdown`) ve kampanya indirimleri; eksi ürüne bağlı giderler ve tahmini kullanım maliyeti.
- **Büro kârı:** tahsil edilen gelir − büroya bağlı giderler − tahmini kullanım maliyeti. Zarar edenler üstte listelenir.
- **Göstergeler:** aylık yinelenen gelir, büro başına ortalama gelir, ürün yaygınlığı, bu ay yenilemesi gelenler, süresi dolan, pasif ve kapalı bürolar ve kayıp oranı.
- **Tekrarlayan giderler:** bir kez girilir. Ayın seçilen gününde (1–28) her aya bir gider satırı yazılır; geriye en fazla 24 ay gidilir ve aynı ay iki kez yazılmaz.

**Bilinen sınırlar**
- Kullanım paketleri şimdilik yalnızca gelir kaydıdır. Paket bitince yapay zekâyı ya da SMS'i durduran bir limit yoktur.
- VoIP konuşma çözümlemesinin yapay zekâ kullanımı sayılmıyor.
- Büronun kendi WhatsApp ve Verimor maliyeti platform gideri sayılmaz.
- Büro tarafından iyzico ile kendi kendine satın alma yok; "Talep et" satış ekibine düşer.
- Bürolara SMS veya e-postayla kampanya gönderimi yok; o iş İYS kaydı gerektirir.

### Süreli uzaktan destek erişimi

Migration: `20261112140000_support_access.sql`. Kod: `lib/saas/support-access.cjs`, `outputs/icrapro/access-support-account.cjs`.

**İzin**
- Büronun CEO'su ya da yöneticisi bir destek talebine erişim izni ekler: 15, 30 ya da 60 dk.
- Varsayılan olarak destek ekibi yalnızca görüntüler. "Değişiklik yapabilsin" işaretlenirse düzenleme de açılır. Silme hiçbir zaman açılmaz.
- Personel talep açabilir ve yalnızca kendi taleplerini görür; erişim izni veremez.
- Bir büroda aynı anda tek açık izin olur; yeni izin öncekinin yerine geçer.
- Hiç bağlanılmayan izin 24 saatte düşer.

**Destek hesabı**
- Destek ekibi büroda gizli bir hesapla çalışır: `platform-support`, "Hukuk Takip Platformu Destek", yönetici rolünde.
- Salt okunurluğu izne göre ayarlanır. Şifresi kimse tarafından bilinmez, `/api/login` bu hesabı reddeder.
- Kullanıcı listesinde görünmez, satın alınan kullanıcı sayısına girmez, çalışan sözleşmesi istemez.
- Böylece oturum, yetki, salt okunurluk ve işlem kayıtları mevcut kodla değişmeden çalışır. Büro işlem kayıtlarında işlemler "Hukuk Takip Platformu Destek" adıyla görünür.

**Bağlanma**
- Konsolda "Büroya bağlan" iki dakika geçerli, tek kullanımlık bir kod üretir ve `https://<büro>.<alan>/api/support-access/enter?code=…` adresini yeni sekmede açar.
- Kodun yalnızca özeti saklanır. Başka büronun alanında çalışmaz.
- Bu adres destek hesabına bir oturum açar. Oturumun bitişi iznin bitiş saatidir; süre ilk girişte başlar ve süre dolunca oturum kendiliğinden geçersiz olur.
- "Büroya bağlan" için operatörün iki aşamalı doğrulaması açık olmalıdır. Bu, genel ayardan bağımsızdır, çünkü bağlantı müvekkil ve borçlu verisini açar.

**Süre**
- Operatör süreyi bir kez 15 dk uzatabilir: son 5 dakikada ya da süre bittikten sonraki 30 dk içinde.
- Daha fazlası için büroya ek süre talebi gönderir (15/30/60 dk ve not). Büroda CEO, yönetici ya da izni veren kişi onaylar veya reddeder.
- Onaylanınca aynı oturum yeniden geçerli olur.

**Büronun gördükleri**
- Üstte bir şerit: "bağlantı bekleniyor", "şu an bağlı · kalan süre" ya da "ek süre talebi". Şeritte "Erişimi sonlandır" düğmesi vardır; destek ekibi anında dışarıda kalır.
- Destek "Sorun çözüldü, test edin" yazınca talebi açan kişi bunu şeritte görür. "Çözüldü" ya da "Hâlâ sorun var" diye yanıt verebilir.

**Kayıt:** Her adım talep akışına sistem satırı olarak, konsolun `tenant_events` ve `platform_audit` kayıtlarına da yazılır.

**Sınırlar**
- Destek hesabı yönetici rolündedir; CEO'ya özel ayarları göremez ve telefonla arama yapamaz.
- Büro işlem kayıtlarında operatörün kendi adı değil, ekip adı görünür. Hangi operatörün bağlandığı konsol kayıtlarında görünür.
- Konsol önizlemesinde büro uygulaması olmadığı için bağlantı adresi açılmaz. Uçtan uca deneme gerçek bir büro alt alanı gerektirir.

### Veri izolasyonu geçişi

`20261108093130_tenant_data_isolation.sql` bir bakım aralığında, yazıcılar durmuşken
ve yeni sunucu koduyla birlikte uygulanmalıdır. Eski sunucu sürümüne yalnızca kodu
geri alarak dönülmez: SQL conflict anahtarları değişmiştir. Önce yedek ve ayrı bir
veritabanında geçiş provası gerekir. Otomatik canlı migration çalıştırılmaz.

Mevcut veriler `00000000-0000-0000-0000-000000000001` kimlikli `existing-office`
bürosuna atanır; başka büroya kopyalanmaz. Mevcut payload ve bilinmeyen alanlar
korunur. Migration yönetici yetkisi gerektirir; migration rolüne çalışma rolünü
kullanma yetkisi verir. Başka sunucu bağlantı rolü kullanılacaksa bu role de
`han_tenant_runtime` üyeliği verilmelidir. Rol kurulamıyorsa işlem geri alınır.

`createTenantPool` yalnızca sunucunun doğruladığı tenant kimliğiyle kullanılabilir.
Sorgulara tarayıcının gönderdiği tenant kimliği doğrudan bağlanmaz. Yönetim/migration
bağlantısı güçlüdür; sorgular çalışmadan önce transaction içinde kısıtlı role geçilir.
Veritabanına doğrudan yönetici erişimi bu uygulama sınırının dışındadır.

Deneysel `database/next/han_core` deposu SaaS çalışma rolüne açılmaz; bu alternatif
depo ilk büro ile sınırlıdır. Önceden kurulmuş deneysel şemadan çalışma tablolarına
yabancı anahtar varsa tenant migration açıklayıcı hatayla durur. Bu kurulum için
ayrı geçiş planı gerekir; bağımlılıklar CASCADE ile silinmez.

## Satışa çıkmadan önce tamamlanacak uygulama işleri

1. **Veri izolasyonu — uygulandı, canlıya alınmadı:** `han_private` ve `han_data`
   tenant anahtarlarına ve RLS çalışma rolüne geçti. Gerçek Supabase üzerinde ayrı
   bir test ortamında bağlantı/rol ve ölçek kabulü hâlâ yapılmalı.
2. **Kimlik ve oturum — kısmen:** alt alan adından büro çözümleme ve büro başına
   handler/origin hazır (yukarıya bakın). Kalan: mevcut kullanıcıları doğrulanmış
   kimliklere bağla; üyelik tablosuna yabancı anahtar ekle; üyeliği her istekte doğrula.
   Tarayıcının gönderdiği tenant id tek başına yetki sağlamaz.
3. **Veritabanı savunması — uygulandı:** sunucu sorguları owner/bypassrls olmayan
   `han_tenant_runtime` rolünde, transaction kapsamındaki tenant bilgisiyle çalışır.
   Eksik tenant bağlamı bu rol altında hiçbir büro kaydını göstermez.
4. **Tüm veri yolları:** dosya ve ekler, rapor/dışa aktarma, arama, audit, yedekleme,
   geri yükleme, WhatsApp ve zamanlanmış işleri tenant kapsamına al. Global süreç
   değişkenleri ve tarayıcı storage anahtarlarını da büro değişimine göre düzenle.
5. **Ürün akışları — kısmen:** büro kaydı/ilk yönetici (platform konsolu), kullanıcı
   sayısı sınırı (uygulama içinde uygulanır), operatör yönetimi ve iki aşamalı doğrulama,
   dört modülün özellik kapısı ve büro tarafında destek talebi hazır. Kalan: davet
   oluşturma/kabul için HTTP uçları ve ekranlar (büro hesabı uygulama içinden doğrudan
   ekleyebildiği için acil değil), büro yöneticisinin kendi kullanıcı hakkını ayarlarda
   görmesi, hesap pasife alma/silme ile üyelik eşitlemesi, abonelik bitişi için otomatik
   hatırlatma (e-posta altyapısı gerekir).
6. **Ticari akış — kısmen:** iyzico ile online tahsilat (platform linki + büro ayarı),
   KDV, gider ve destek kaydı hazır. Kalan: gerçek sandbox kabulü, tekrarlayan abonelik/otomatik
   yenileme, tahsilat başarısızlığı akışı, iyzico üzerinden iade, e-fatura/faturalama entegrasyonu
   ve büro müşterileri için tahsilatın uygulamadaki borçlu/muhasebe kayıtlarına eşlenmesi.
7. **Yayın kabulü:** iki büroyla uçtan uca veri sızıntısı testleri, yedekten dönüş,
   izleme ve destek akışı; sözleşme, gizlilik ve veri saklama metinlerinin incelemesi.

Depo artık tenant bazında sınırlandırılmıştır; mevcut HTTP giriş noktası ilk büroyu
kullanmaya devam eder. Alan adı/büro seçimi, üyelik doğrulaması ve kayıt/davet akışı
henüz bağlanmadı. Kullanıcıya açık çok bürolu SaaS ve ödeme akışı tamamlanmadan
satışa hazır kabul edilmez.
