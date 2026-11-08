# SaaS geliştirme dalı

Dal: `feat/saas-multi-tenant`.

Hedef: ortak uygulama ve ortak PostgreSQL üzerinde her hukuk bürosunun kullanıcı,
dosya, finans, belge ve yedeklerine yalnızca kendi yetkileriyle erişmesi.

## Bu aşamada hazır olanlar

- `han_saas.tenants`: benzersiz büro kodu ve büro yaşam döngüsü.
- `han_saas.memberships`: büro bazında owner/admin/member/viewer üyelikleri.
  Bu roller mevcut ceo/admin/personel rollerine henüz bağlanmadı.
- `han_saas.subscriptions`: deneme/paket, erişim bitişi ve koltuk limiti metadatası.
- `lib/saas/tenants.cjs`: büro, sahip üyeliği ve deneme aboneliğinin tek transaction
  içinde oluşturulması; üyelik, büro durumu ve abonelik süresi kontrolü.
- Yeni bürolar `provisioning` durumunda kalır. Otomatik etkinleştirme yoktur.
- Sentetik PostgreSQL testleri: `npm run test:saas`.

14 günlük deneme ve 3 koltuk geliştirme varsayımıdır; fiyat veya satış taahhüdü değildir.
Koltuk limiti bu aşamada yalnızca saklanır; davet/üye ekleme akışında uygulanacaktır.
`ownerUserId` / `userId` yalnızca sunucunun doğruladığı kimlikten alınmalıdır.
Servisler genel kullanıma açık HTTP uçları değildir.

Migration mevcut migration çalıştırıcısıyla uygulanabilir (`npm run db:migrate`).
Bu geliştirme sırasında canlı veritabanına uygulanmadı. Önce ayrı test ortamında
denenmeli; dal için üretimden ayrı veritabanı ve deployment kullanılmalıdır.

## Satışa çıkmadan önce tamamlanacak uygulama işleri

1. **Veri izolasyonu:** `han_private` durum/oturum/denetim tabloları ve tüm `han_data`
   tablolarına tenant kapsamı ekle. Tekil `id=1` varsayımlarını kaldır; anahtarları ve
   yabancı anahtarları `(tenant_id, id)` olarak düzenle. Mevcut verileri yalnızca
   tanımlanmış ilk büroya kontrollü taşı. Tenant dışı sorguları reddet.
2. **Kimlik ve oturum:** mevcut kullanıcıları doğrulanmış kimliklere bağla; üyelik
   tablosuna yabancı anahtar ekle. Aktif büroyu oturuma bağla, üyeliği her istekte
   doğrula. Tarayıcının gönderdiği tenant id tek başına yetki sağlamaz.
3. **Veritabanı savunması:** uygulama bağlantısını owner/bypassrls olmayan bir role
   geçir; transaction kapsamındaki tenant bilgisiyle RLS politikalarını tanımla.
   Mevcut özel şema/RLS ayarları tek başına büro izolasyonu sağlamaz.
4. **Tüm veri yolları:** dosya ve ekler, rapor/dışa aktarma, arama, audit, yedekleme,
   geri yükleme, WhatsApp ve zamanlanmış işleri tenant kapsamına al. Global süreç
   değişkenleri ve tarayıcı storage anahtarlarını da büro değişimine göre düzenle.
5. **Ürün akışları:** büro kaydı, ilk yönetici, kullanıcı daveti, büro seçimi, platform
   yöneticisi ekranı; koltuk ve paket sınırlarını transaction içinde uygula.
6. **Ticari akış:** ödeme sağlayıcısı seçimi, imzalı ve tekrara dayanıklı webhook,
   abonelik yenileme/iptal, tahsilat başarısızlığı ve faturalama entegrasyonu.
7. **Yayın kabulü:** iki büroyla uçtan uca veri sızıntısı testleri, yedekten dönüş,
   izleme ve destek akışı; sözleşme, gizlilik ve veri saklama metinlerinin incelemesi.

Mevcut çalışma zamanı hâlâ tek büroludur. `requireTenantAccess` bir yetki kontrolüdür;
eski SQL sorgularını tenant bazında filtrelemez. Bu temel üzerinde birden çok gerçek
büroyu aynı çalışma zamanına bağlamak henüz desteklenmez.
