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

14 günlük deneme ve 3 koltuk geliştirme varsayımıdır; fiyat veya satış taahhüdü değildir.
Koltuk limiti bu aşamada yalnızca saklanır; davet/üye ekleme akışında uygulanacaktır.
`ownerUserId` / `userId` yalnızca sunucunun doğruladığı kimlikten alınmalıdır.
Servisler genel kullanıma açık HTTP uçları değildir.

Migration mevcut migration çalıştırıcısıyla uygulanabilir (`npm run db:migrate`).
Bu geliştirme sırasında canlı veritabanına uygulanmadı. Önce ayrı test ortamında
denenmeli; dal için üretimden ayrı veritabanı ve deployment kullanılmalıdır.

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
2. **Kimlik ve oturum:** mevcut kullanıcıları doğrulanmış kimliklere bağla; üyelik
   tablosuna yabancı anahtar ekle. Aktif büroyu oturuma bağla, üyeliği her istekte
   doğrula. Tarayıcının gönderdiği tenant id tek başına yetki sağlamaz.
3. **Veritabanı savunması — uygulandı:** sunucu sorguları owner/bypassrls olmayan
   `han_tenant_runtime` rolünde, transaction kapsamındaki tenant bilgisiyle çalışır.
   Eksik tenant bağlamı bu rol altında hiçbir büro kaydını göstermez.
4. **Tüm veri yolları:** dosya ve ekler, rapor/dışa aktarma, arama, audit, yedekleme,
   geri yükleme, WhatsApp ve zamanlanmış işleri tenant kapsamına al. Global süreç
   değişkenleri ve tarayıcı storage anahtarlarını da büro değişimine göre düzenle.
5. **Ürün akışları:** büro kaydı, ilk yönetici, kullanıcı daveti, büro seçimi, platform
   yöneticisi ekranı; koltuk ve paket sınırlarını transaction içinde uygula.
6. **Ticari akış:** ödeme sağlayıcısı seçimi, imzalı ve tekrara dayanıklı webhook,
   abonelik yenileme/iptal, tahsilat başarısızlığı ve faturalama entegrasyonu.
7. **Yayın kabulü:** iki büroyla uçtan uca veri sızıntısı testleri, yedekten dönüş,
   izleme ve destek akışı; sözleşme, gizlilik ve veri saklama metinlerinin incelemesi.

Depo artık tenant bazında sınırlandırılmıştır; mevcut HTTP giriş noktası ilk büroyu
kullanmaya devam eder. Alan adı/büro seçimi, üyelik doğrulaması ve kayıt/davet akışı
henüz bağlanmadı. Kullanıcıya açık çok bürolu SaaS ve ödeme akışı tamamlanmadan
satışa hazır kabul edilmez.
