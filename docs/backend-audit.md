# Han Hukuk backend denetimi ve çözüm raporu

7 Kasım 2026 · Geliştirme/test sonucu · Yayın durumu GitHub ve Vercel kayıtlarından izlenir

## Kısa sonuç

**Onaylanan ilk performans aşaması uygulandı.** Oturum ve bildirim sorguları büyük iş kaydından ayrıldı, salt okumalardaki kilit/yazma kaldırıldı, değişmeyen kayıtların tekrar yazılması önlendi. Şifre hesaplaması Node ana iş parçacığını bloke etmeyecek hale getirildi. İşlem, oturum, doğrulama ve bildirim sorumlulukları ayrı modüllere çıkarıldı.

**Denetim ve yük testleri canlı iş verilerine yazmadan yapıldı.** Canlı Supabase üzerinde yalnız şema ve danışman çıktıları okundu. Geliştirme ve yük testleri yerel, sentetik verilerle yapıldı. Yayın, kullanıcının ayrıca verdiği push ve canlıya alma talimatıyla yürütülür.

Yeni normalleştirilmiş şema, kayıpsız içe aktarma modülü ve kayıt bazlı backend ayrıca hazırlandı ve test edildi. Bu paket **ikinci aşamanın pilotudur**. Eski arayüzün bütün veri akışları henüz bu pakete taşınmadı. Mevcut arayüzün 4 MiB liste sınırının kalktığı veya sistemin milyarlarca kayda hazır olduğu iddia edilmiyor.

## Ölçülen sonuç

Aynı 800 sentetik evrak, 400 müvekkil, 3.200 görüşme ve 1.600 finans hareketi kullanıldı. PGlite tek bağlantılı yerel PostgreSQL motorudur. Ölçümler canlı ortamın kapasite garantisi değildir.

| İşlem | Önce | Sonra |
| --- | ---: | ---: |
| Liste, 20 eşzamanlı istek, p95 | 10.393 ms | 1.916 ms |
| Oturum, 20 eşzamanlı istek, p95 | 6.330 ms | 48 ms |
| Ayarı okuyup kaydetme, p95 | 722 ms | 178 ms |

Son liste ölçümünde 40 isteğin tamamı 200 döndü. Önceki yeni kod koşusunda liste p95 2.938 ms idi; yerel ölçüm değişkenliği vardır. Eski arama tam veri taradığı için aynı testte p95 yaklaşık 701 ms oldu; arama için iyileşme iddiası yok.

Yeni kayıt bazlı pilotta 4 MiB'ı aşan **2.000 evraklık** kaynak başarıyla taşındı. 50 kayıtlık yanıt 32 KiB'dan, tek not güncelleme yanıtı 1 KiB'dan küçük kaldı. Bu test sayfalama ve atomik kaydı doğrular, milyonluk yük testi değildir.

## 1. Tespitler

### DRY

| Bulgu | Neden sorun | Çözüm / durum |
| --- | --- | --- |
| Oturum çerezi, cihaz türü ve giriş deneme anahtarları farklı yerlerde hesaplanıyordu. | Kural değişikliği bir uçta uygulanıp diğerinde unutulabilir. | Ortak [oturum politikası](../lib/session-policy.cjs) ve [hız sınırı](../lib/rate-policy.cjs) uygulandı. |
| Kimliği doğrulamak için aynı API yürütücüsü tekrar tekrar kuruluyordu. | Cookie, audit, gövde sınırı ve sözleşme kontrolü ayrışabilir. | [Ortak yürütücü](../lib/access-executor.cjs) kullanılıyor. |
| Dört farklı bildirim zamanlayıcısı benzer kontroller yapıyordu. | Gereksiz ağ/SQL yükü ve üst üste istekler oluşuyordu. | Tek uç ve görünür sekmede yaklaşık 15 saniyelik, çakışmayan ve hatada yavaşlayan yoklama uygulandı. |
| Tarih, yetki ve finans toplamı hesapları eski modüllerde tekrar ediyor. | Aynı kaydın farklı ekranlarda farklı değerlendirilmesi riski var. | Ortak tarih ve kayıt doğrulama modülleri çıkarıldı. Eski rol/finans hesaplarının tamamını dönüştürme işi ikinci aşamadaki ekran geçişiyle birlikte yapılmalı. |

### SOLID

| Bulgu | Neden sorun | Çözüm / durum |
| --- | --- | --- |
| `createAccess` kimlik, dosya düzenleme, bordro, otomasyon, dosya sistemi ve HTTP işlerini bir arada yapıyordu. | Bir modüldeki değişiklik beklenmeyen başka kayıtları etkileyebiliyor. | Şifre, oturum, transaction, bildirim özeti ve kayıt doğrulaması ayrı modüllere alındı. |
| `persist` her yazmada bütün evrakları ve finans listesini tekrar dolaşıyordu. | Belge sayısı × finans hareketi sayısı düzeyinde tarama maliyeti oluşuyordu. | Önceki evraklar ve evrağa bağlı hareketler için Map indeksleri oluşturuldu. Aynı yazma içinde tekrar tekrar tam liste aranmıyor. |
| GET oturum/liste istekleri iş akışı ve bordro hesaplarını tetikliyordu. | Okuma isteği veri değiştirebiliyor ve kullanıcı ortak kilidi bekliyordu. | Okuma yolu salt okunur. İş akışı ayrı, veritabanında tekil olarak sahiplenilen bakım işine taşındı. |
| Sıkı bağlı uygulama durumu değişik veri deposuna geçişi zorlaştırıyor. | Depolama ayrışınca tüm domain davranışı aynı anda değişmek zorunda kalıyor. | Yeni pilotta bağlantı havuzu, transaction ve dış mesaj göndericisi bağımlılık olarak veriliyor. |

### ACID ve veri güvenilirliği

Mevcut PostgreSQL yolu tamamen transaction dışı değildir. Eski tek-satır tasarımının başarılı değişiklikleri ve audit kaydı zaten aynı transaction içindeydi. Sorunlar bunun sınırlarında ve farklı HTTP istekleri arasında bulunuyor. PostgreSQL transaction tamamlanmadan başarı yanıtı gönderilmemesi korunmuştur. [PostgreSQL transaction açıklaması](https://www.postgresql.org/docs/current/tutorial-transactions.html)

| Bulgu | Neden sorun | Çözüm / durum |
| --- | --- | --- |
| Route içinde değişiklik yapıldıktan sonra hata yakalanıp 4xx/5xx yanıtına çevrilebiliyordu. | Dış transaction, callback hata fırlatmadığı için daha önceki değişikliği commit edebilirdi. | Hatalı iş komutları rollback edilir. Başarısız girişlerin hız sayacı ve audit kaydı bilinçli olarak ayrı tutulur. |
| Tarayıcı finans hareketi ve evrak bilgisini birden çok istekle kaydediyor. | Bağlantı kesilirse ilk istek başarılı, sonraki başarısız olabilir. | Pilotta tahsilat, kalan borç/İnfaz durumu, audit ve işlem anahtarı tek transaction içinde. Eski arayüzün bu komuta geçirilmesi gerekli. |
| İstek tekrarında finans hareketini tekilleştiren komut kaydı yoktu. | Yanıt kaybolup kullanıcı tekrar gönderirse mükerrer işlem oluşabilir. | Pilot komutları hesap + idempotency anahtarı + istek özetiyle korunuyor. Aynı anahtar/farklı içerik 409 verir. |
| WhatsApp işi yanıt nesnesinde bellekte bekliyor. | Veritabanı commit sonrası süreç durursa iş gönderilmeden kaybolabilir. | Pilotta mesaj ve kalıcı gönderim kuyruğu aynı transaction içinde. İşçi gönderimi transaction dışında yapar. Sonucu belirsiz gönderimi otomatik tekrarlamaz. |
| Yedek dış depoya yazıldıktan sonra durum kaydı güncelleniyor. | PostgreSQL ve R2 tek ACID transaction olamaz. Başarılı yüklemenin durum kaydı yazılamayabilir. | Mevcut şifreli yedek/geri yükleme testleri korundu. Ölçekli yeni şema için ayrı tutarlı yedek/geri yükleme ve nesne uzlaştırma tasarımı hâlâ gerekli. |
| Cihaz oturum kuralı yalnız kodla uygulanıyordu. | Aynı anda farklı sunuculardan giriş yarışı oluşabilir. | Hesap satırı kilidi ve `UNIQUE(account_id, device_type)` eklendi. Eski oturumlar geçişte yeniden giriş gerektirir. |

### Veritabanı normalizasyonu

| Bulgu | Neden sorun | Çözüm / durum |
| --- | --- | --- |
| Kullanıcılar, evraklar, müvekkiller, finans, mesajlar ve geçmişler tek JSON kaydında. | Ortak yazma kilidi, büyük nesne taşıma, FK/UNIQUE/CHECK eksikliği. | İlk aşamada oturumlar ve giriş denemeleri ayrı satırlar. İkinci aşama SQL'inde taraf, müvekkil, evrak, görüşme, finans, hesap, mesaj/alıcı, iş emri, hatırlatma ve sözleşme tabloları var. |
| Ad, kişi ve ilişki bilgileri çok yerde kopyalanıyor. | İsim/bağlantı güncellemesi tutarsız kalabilir. | Yeni modelde ortak taraf tablosu ve yabancı anahtarlar var. Tarihsel imzalayan/alıcı adı anlık delil olarak gerektiğinde ayrıca korunuyor; her kopya hata sayılmadı. |
| Bazı tutarlar TL ondalık, diğerleri kuruş tamsayı. | Yanlış çarpan/yuvarlama ve hatalı bakiye riski. | Pilotta parasal kolonlar kuruş olarak bigint. JS güvenli tamsayı sınırı ve pozitiflik kontrol ediliyor; toplamlar BigInt ile hesaplanıyor. |
| PDF/fotoğraf base64 verileri evrak nesnesinde. | Liste boyutu, bellek ve yedek maliyetini büyütüyor. | Pilot aktarımda ekler ayrı tabloya çıkarılır; listeler ek içeriğini almaz. Nesne deposuna taşıma için object_key alanı var, canlı R2 taşıması yapılmadı. |
| Geçişte eski alanları kaybetme riski. | Bilinmeyen alanları atan yeni model veri kaybına yol açabilir. | Kaynağın tüm JSON'u ve SHA-256 özeti değiştirilemeyen kontrol kaydında korunur. Tanınmayan alanlar extras/ayarlar içinde tutulur. Hatalı ilişki veya mükerrer ID'de aktarım bütünüyle durur. |

### İndeksleme ve performans

| Bulgu | Neden sorun | Çözüm / durum |
| --- | --- | --- |
| Okuma için `SELECT ... FOR UPDATE` ve her istekte JSON UPDATE. | Oturum kontrolü bile diğer kullanıcıları bekletiyordu. | GET için ortak kilit/yazma kaldırıldı. Oturum ve bildirim özeti ana kaydı okumuyor. |
| Arama tüm JSON'u Node'a alıp filtreliyor. | Evrak sayısıyla CPU, bellek ve aktarım artıyor. | Pilotta PostgreSQL tsvector + GIN ve kayıt/sahip indeksleri; eski global arama henüz bu akışa bağlı değil. |
| Tüm liste tek seferde alınıp gönderiliyor. | 4 MiB uygulama sınırı; bütün liste ETag'i ilgisiz iki evrakı çatıştırıyor. | Pilotta cursor sayfalama ve evrak başına revision. Farklı evrak güncellemeleri birlikte başarılı, aynı evrakın eski sürümü 409. |
| Oturum, alıcı, evrak, hesap, vade sorguları için gerçek kolon yoktu. | JSON'a indeks eklemek Node tarafındaki tam taramayı çözmez. | Yeni SQL'de FK taraflarına B-tree, aramaya GIN, açık/bekleyen kayıtlara kısmi indeksler eklendi. |
| Yerel performans sonucu canlı kapasite gibi yorumlanabilir. | PGlite gerçek çok bağlantılı Supabase/Vercel ağ ve kaynak koşullarını taklit etmez. | Ölçüm sınırı açıkça belirtildi. Milyon/milyar sertifikasyonu için gerçek PostgreSQL hazırlık ortamı gerekli. |

Supabase performans danışmanı canlı şema için uyarı üretmedi. Bu, tek JSON modelinin ölçeklenebilir olduğunu göstermez. Güvenlik danışmanındaki iki `RLS enabled, no policy` kaydı özel şemadaki tablolara aitti. Uygulama özel sunucu bağlantısı kullanıyor; bunları gidermek için tablolara herkese açık politika eklenmedi. [Danışman açıklaması](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)

Ek bulgu olarak eski toplu veri okumasındaki erken dönüş, aşağıdaki alan maskelemesini devre dışı bırakıyor. Bordro/rapor uçları da aynı rol politikasını uygulamıyor. Yeni pilotta personel dosyası sahiplik ve finans yetkisi kontrol ediliyor. **Eski uçlardaki mevcut erişim kapsamı bu performans değişikliğiyle sessizce değiştirilmedi**; arayüz geçişinde açık bir rol matrisiyle kapatılmalı. İlgili kaynaklar [readKey](../outputs/icrapro/access-server.cjs:167) ve [personel raporları](../outputs/icrapro/access-personnel.cjs:22).

## 2. Yazılan kod

| Kullanım | Dosyalar |
| --- | --- |
| İlk aşama uygulama entegrasyonu | [application](../lib/application.cjs), [postgres-store](../lib/postgres-store.cjs), [access-executor](../lib/access-executor.cjs) |
| Transaction ve oturum | [db-transaction](../lib/db-transaction.cjs), [security-store](../lib/security-store.cjs), [password-policy](../lib/password-policy.cjs) |
| Tek bildirim yolu ve doğrulama | [notification-summary](../lib/notification-summary.cjs), [state-invariants](../lib/state-invariants.cjs), [tarayıcı yoklaması](../outputs/icrapro/workspace-notifications.js) |
| İkinci aşama kayıt backend'i | [repository](../lib/records/repository.cjs), [kayıpsız aktarım](../lib/records/import.cjs), [kalıcı gönderim işçisi](../lib/records/outbox.cjs) |

Pilot repository müvekkil/evrak sayfaları, evrak notu güncelleme, normal dosya tahsilatı, hesap transferi ve mesaj kuyruğunu içerir. Bütün eski iş akışlarının birebir karşılığı olduğu iddia edilmiyor. Yediemin tahsilatı özel komisyon kuralları nedeniyle pilot genel tahsilat yolunda reddedilir; mevcut doğrulanmış iş kuralının yeni işleme ayrıca taşınması gerekir.

## 3. SQL dosyaları

- [İlk aşama geçişi](../supabase/migrations/20261107005300_separate_sessions_and_reads.sql) — mevcut payload ve audit kayıtlarını silmeden oturum, hız sayacı, bildirim okuma modeli ve bakım işi tablolarını ekler. İçe aktarma/geri yükleme/normal yazmalar türetilmiş modelleri aynı transaction içinde günceller.
- [İkinci aşama normalleştirilmiş şema](../database/next/20261107010408_normalized_record_backend.sql) — kolonlar, FK, CHECK, UNIQUE, indeksler, append-only finans/sözleşme koruması ve kalıcı outbox. İlk aşama `db:migrate` komutu bu dosyayı uygulamaz.
- [Geçiş ve kontrol yönergesi](../database/next/README.md).

Yeni şema özel şemadadır, RLS açıktır, PUBLIC erişimi kapalıdır. Kullanıcı oturumu ve işlem yetkisi sunucuda denetlenir. Geniş yetkili `SECURITY DEFINER` RPC eklenmedi.

## Test ve güvenli yayın sınırı

25 otomatik test ve mevcut iş kuralı kontrolleri geçti. Testler eski verinin ve audit'in korunmasını, şifreli yedek round-trip'ini, hatada rollback'i, oturum devrini, hız sınırlarını, sözleşme akışını, mali toplamı, idempotency'yi ve 2.000 evrak sayfalamasını kapsıyor.

`npm run db:rehearse` yalnız bellek içindeki sentetik veritabanını kullanır. `.env.local` yüklemez ve Supabase'e yazmaz.

**İlk aşama bile SQL geçişi ve uyumlu kod birlikte yayımlanmadan canlıda etkin değildir.** İkinci aşama için arayüzün yeni komutlara geçirilmesi, mevcut özel hesaplama kurallarının taşınması, tüm yeni tabloları kapsayan yedek/geri yükleme ve gerçek çok bağlantılı yük testi tamamlanmalıdır. Hazırlanan pilotun eski arayüzle aynı anda yazmaya açılması güvenli değildir.
