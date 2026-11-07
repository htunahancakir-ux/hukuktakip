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

## SQL Injection incelemesi — 7 Kasım 2026

`b248b59` tabanındaki HTTP girdilerinden SQL çağrılarına kadar yapılan kod incelemesinde kullanıcı tarafından erişilebilir, doğrulanmış bir SQLi açığı bulunmadı. Bu sonuç bütün güvenlik kategorileri için garanti veya canlı penetrasyon testi anlamına gelmez.

| Girdi / akış | Veritabanına aktarım | Sonuç |
| --- | --- | --- |
| Kullanıcı adı | `security-store.cjs`: `username = $1`; değer ayrı parametre dizisinde | SQL metnine eklenmiyor. |
| Oturum çerezi, IP ve hesap kimliği | Oturum/IP özeti ve kimlikler `$1`, `$2` parametrelerinde | Kullanıcı metni SQL sözdizimi olmuyor. |
| Audit kişi, tarih, kategori, işlem ve cursor filtreleri | `auditQuery` doğrulaması; sabit SQL parçaları ve ayrı values dizisi | Dinamik WHERE yalnız geliştiricinin sabit parçalarından kuruluyor. LIMIT sabit `PAGE_SIZE` değeridir. |
| Form, not, ayar ve toplu kayıtlar | JSON serileştirme ardından `payload = $1::jsonb` | JSON alan adları dahil içerik veri olarak saklanıyor. |
| Pilot evrak/kişi araması, kimlik, sayfa sınırı ve mali komutlar | Ayrı parametreler; aramada `plainto_tsquery`, sınırda tamsayı kontrolü | Arama veya kimlik metni sorgu komutuna dönüşmüyor. |
| Migration SQL | Yalnız yerel, sürümlenen SQL dosyaları; HTTP gövdesinden SQL alınmıyor | Yönetim komutu; kullanıcı girdisini SQL olarak çalıştıran bir HTTP ucu bulunmadı. SQL içindeki dinamik tablo adları `%I` ile kaçışlanıyor. |

Pilot aktarımın eski `insert` yardımcısı tablo adını ve `Object.keys(row)` sonucunu doğrudan SQL'e ekliyordu. Tüm çağrılar modül içindeki sabit tablo adları ve elle tanımlanmış alanlarla yapıldığından mevcut bir uzak saldırı yolu tespit edilmedi. Ancak ileride istek gövdesinin doğrudan bu yardımcıya geçirilmesi SQLi riski doğurabilirdi.

Ek koruma olarak [insert.cjs](../lib/records/insert.cjs) eklendi. Yalnız tanımlı tablo ve o tabloya ait sütun adları kabul edilir; bilinmeyen adlar sorgu çalıştırılmadan reddedilir. Değerler `$1`, `$2`, … parametreleriyle iletilir. [Aktarım modülü](../lib/records/import.cjs) bu yardımcıyı kullanır. Bu değişiklik hâlen pilot modüldedir; canlı HTTP sorgularının güvenli parametre bağlama davranışı değiştirilmedi.

SQLi için gerekli ayrım sorgu metni ile değerlerin ayrı gönderilmesidir. Tablo/sütun adları parametrelenemez; izin listesiyle kontrol edilir. [node-postgres sorgu belgesi](https://node-postgres.com/features/queries)

Supabase paylaşımlı transaction pooler ile uyum için node-postgres sorgularına `name` eklenmedi. Parametreler korunur; oturuma bağlı adlandırılmış prepared statement önbelleği etkinleştirilmez. [Supabase node-postgres bağlantı notu](https://supabase.com/kb/troubleshooting/disabling-prepared-statements-qL8lEL)

Üç yeni güvenlik testi eklendi: izin dışı SQL tanımlayıcılarının reddi; HTTP giriş/çerez/filtre/JSON kayıt akışı; pilot aktarım ve kayıt sorguları. İlgili toplam 7 test yerel sentetik PostgreSQL/PGlite üzerinde geçti. Girdilerde tırnak, SQL yorumu, boolean koşul ve ikinci SQL komutu denemeleri kullanıldı; oturum atlatılmadığı, kayıtların korunması ve metinlerin aynen saklanması doğrulandı. Canlı veritabanına saldırı girdisi gönderilmedi. Kontroller canlı veriler değiştirilmeden tamamlandı.

## XSS incelemesi ve düzeltmeleri — 7 Kasım 2026

İnceleme, uygulamanın sunduğu tarayıcı modüllerini, HTML şablonlarını, dosya bağlantılarını ve yazdırma çıktısını kapsadı. Mevcut `esc` çoğu metinde kullanılıyordu; aşağıdaki açık noktalar düzeltildi:

| Nokta | Risk | Düzeltme |
| --- | --- | --- |
| Seçili müvekkil özet kartı | Müvekkil adı doğrudan `innerHTML` içine giriyordu; kayıtlı zararlı HTML başka kullanıcıda çalışabilirdi. | Kart değerleri HTML çıkış kodlamasından geçirildi. |
| Teslim tutanağı ekleri | `fileData` / `photoData` kaçışsız `href` içine yerleştiriliyordu; tırnakla öznitelikten çıkılabiliyordu. | Adres biçimi ve MIME izin listesi; ardından öznitelik kodlaması. |
| Müvekkil ekleri ve mevcut evrak indirme linkleri | HTML kaçışlama, `javascript:` gibi aktif adresleri tek başına engellemiyordu. | Yalnız uygulamanın desteklediği PDF ve raster fotoğraf base64 data URL'leri; HTML/SVG, dış URL ve bozuk içerik reddedilir. |
| Kayıt kimlikleri ve tarih alanları | Bazı `data-*` / `value` alanları kaçışsızdı; `displayDate` bilinmeyen metni aynen döndürüyordu. | HTML'e çıkış noktasında kodlama; tarih biçimleme işlevinin düz metin davranışı korunur. |
| Rapor/yazdırma ve aydınlatma linki | Rapor tarihleri `srcdoc` içinde HTML olabiliyordu; linkte tarayıcı tarafı protokol kontrolü yoktu. | Rapor metinleri kodlanır; dış aydınlatma bağlantısı yalnız HTTPS kabul eder. |

Ortak [html-safety.js](../outputs/icrapro/html-safety.js), `& < > " '` karakterlerini HTML metni ve tırnaklı, çalıştırılabilir olmayan öznitelikler için kodlar. Düz metin DOM atamalarındaki `textContent` / `value` kullanımı korunur. Kullanıcı içeriği JavaScript olay özniteliğine aktarılmaz. Veritabanında içerik değiştirilmez veya topluca temizlenmez; geçersiz eski ekler kayıtta kalır fakat aktif bağlantı/önizleme oluşturmaz.

[XSS testleri](../tests/xss.test.cjs) gerçek üretim render fonksiyonlarını jsdom içinde çalıştırır. Pozitif kontrol, zafiyetli olay işleyicisinin test ortamında gerçekten çalışabildiğini doğrular. Yedi senaryo; metin/öznitelik kırma, dosya protokolleri, rapor `srcdoc`, sözleşme ve normal Türkçe/PDF/fotoğraf davranışını kapsar. Bu bir canlı saldırı testi veya tüm tarayıcılar için penetrasyon testi değildir.

Yaklaşım: [OWASP XSS Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html).

## Çerez, oturum ve CSRF incelemesi — 7 Kasım 2026

Üretim giriş çerezi zaten `HttpOnly; Secure; SameSite=Strict; Path=/` taşıyordu ve `Domain` içermiyordu. Oturum 32 rastgele bayttan üretiliyor, sunucuda yalnız SHA-256 özeti tutuluyor; çıkış/şifre değişimi sunucu oturumlarını geçersiz kılıyordu. Bu korumalar korundu.

- [session-policy.cjs](../lib/session-policy.cjs) artık giriş ve çerez silme için ortak üretici içerir. `HttpOnly`, `SameSite=Strict`, `Path=/` her zaman; `Secure` Vercel/HTTPS yapılandırmasında uygulanır. Yerel HTTP geliştirme çalışmaya devam eder. Çerez silme `Max-Age=0` ve geçmiş `Expires` ile aynı kapsam/bayrakları kullanır.
- Bozuk veya birden fazla `han_session` çerezi oturum olarak kabul edilmez. Mevcut çerez adı, masaüstü/mobil oturum politikası ve süreler değişmedi: normal oturum sunucuda 8 saat, beni hatırla 14 gün. Kullanıcılar bu değişiklik nedeniyle topluca çıkartılmaz.
- [request-security.cjs](../lib/request-security.cjs) bütün tarayıcı mutasyonları için ortak kontrol sağlar. `X-Han-Request: 1` zorunludur; yabancı/alt alan kaynakları `Origin`, `Referer` ve Fetch Metadata üzerinden reddedilir. HTTPS ortamında kaynak kanıtı tamamen eksik istekler de reddedilir. Yerel HTTP araçları özel başlığı kullanabilir.
- Üretim hedefi `APP_ORIGIN` içindeki HTTPS origin'dir; gelen `Host` / proxy başlıkları hedef olarak güvenilir sayılmaz. Kontrol, veritabanı okuması, kilit, hız sayacı ve iş verisi yazmasından önce yapılır. CORS ile üçüncü taraf kaynaklara yetki açılmaz. Cron uçları ayrı bearer secret doğrulamalarını korur.
- HTTPS cevaplarına `Strict-Transport-Security: max-age=31536000` eklendi. `no-store` ve `nosniff` korunur.

[Oturum testleri](../tests/session-security.test.cjs), çerezin scriptlerden gizlenmesini, HTTP/alt alan ayrımını, 45 reddedilen istek senaryosunda veritabanına hiç girilmemesini, geçerli kaynak alternatiflerini, şifre sonrası token yenilenmesini ve çıkışta iptali doğrular. Testlerde yalnız sentetik yerel veriler kullanılır.

`HttpOnly`, çerezin JavaScript ile okunmasını engeller; sayfada çalışabilen XSS kodunun kullanıcı adına istek yapmasını tek başına engellemez. Bu nedenle HTML çıkış kodlaması ayrıca uygulanmıştır. AJAX API için özel başlık ve sıkı kaynak/CORS denetimi [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) yaklaşımıdır; çerez kapsamı ve özet saklama [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) ile uyumludur.

Yayın öncesi doğrulama: GitHub main üzerindeki `941ee8b` değişiklikleriyle birleştirme sonrası `npm test` ile **59/59 test** ve mevcut iş kuralı kontrolleri geçti. `npm run build` ve `npm run format:check` başarılı. Bu güvenlik sürümü veritabanı geçişi gerektirmez; testler canlı veriler değiştirilmeden tamamlandı.
