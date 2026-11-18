# Sürüm Notları

## 2.7.4 — 18 Kasım 2026

### Geri bildirim sekmesi her şeyin üstünde

- **Neden altta kalıyordu:** Ekranın sağındaki **Geri bildirim** sekmesi sabit bir katmandı. Açık bir pencerenin (borçlu, föy, arama penceresi vb.) ya da bazı sabit çubukların ve bildirimlerin altında kalıyordu. Pencere açıkken sayfanın geri kalanı tıklanamaz olduğu için sekme görünse bile tıklanamıyordu. Pencerede yaşanan sorun bu yüzden ekran görüntüsüyle bildirilemiyordu.
- **Şimdi:** Sekme tarayıcının üst katmanında duruyor ve sonradan açılan her pencerenin ve bildirimin üstüne yeniden çıkıyor. Bir pencere açıldığında sekme o pencerenin içine geçiyor, böylece tıklanabiliyor. Pencere kapanınca sayfaya dönüyor. Üst üste açılan pencerelerde en üsttekine geçiyor. Pencere içeriği yeniden çizilse, penceredeki düğmeler kapatılsa ya da arama "Sonlandırılıyor…" durumunda kilitlense de sekme kullanılabilir kalıyor.
- **Sekmeye tıklamak pencereyi kapatmıyor:** Pencerenin dışına tıklayınca pencereyi kapatan kural sekmeye tıklamayı da "dışarı tıklama" sayıyordu. Açık borçlu kartında sekmeye tıklamak kartı kapatıyor, bildirim penceresi de açılmıyordu. Sekme artık bu kuralın dışında: bildirilen pencere açık kalıyor, geri bildirim penceresi onun üstünde açılıyor.
- **Ekran görüntüsü açık pencereyi de gösteriyor:** Önceden açık pencere bildirim görüntüsünde çıkmıyor, yalnızca arkadaki sayfa görünüyordu. Artık pencere ekrandaki yerinde, arkasındaki karartmayla birlikte görüntüye giriyor.

### Testler

- Tanıtım sayfası testi, 2.7.2'de eklenen KODix bağlantısını kabul ediyor: siteden dışarı çıkan tek bağlantı bu. Bağlantının yeni sekmede, `noopener noreferrer` ile açılması da denetleniyor. Dış kaynak (betik, görsel, stil) yüklenmemesi kuralı aynen geçerli.
- Kendi sunucu yönlendirme testi, iki yanıtın `Date` başlığı saniye sınırına denk geldiğinde boşuna başarısız oluyordu; karşılaştırma artık bu başlığı içermiyor.

## 2.7.1 — 17 Kasım 2026

### Telefon: "Sonlandırılıyor…"da takılan arama

- **Neden takılıyordu:** Verimor arama başlatma isteğine zamanında yanıt vermediğinde (16 Kasım 15:08) aramanın Verimor çağrı kimliği hiç oluşmadı. Kimliği olmayan arama ne sorgulanabiliyor ne de sonlandırılabiliyordu; pencere kilitli kalıyor, sunucu her eşitlemede 409 dönüyordu. Bu kayıt açık kaldığı sürece aynı kullanıcı yeni arama da başlatamıyordu (kullanıcı başına tek açık giden arama).
- **Otomatik kapanış:** Verimor'dan 5 dakika içinde çağrı kimliği gelmeyen giden aramayı bekçi işi kendiliğinden kapatır; nota "Santral bu arama için çağrı kimliği vermedi; kayıt otomatik kapatıldı." yazılır.
- **Kilit kalkar:** Sayfa açıldığında böyle bir arama "Sonlandırılıyor…" gösteriyorsa ilk kontrolde kilit kalkar, durum açıklanır ve **Kaydı kapat** seçeneği çıkar.
- **Zorla kapat:** Herhangi bir arama 20 saniyeden uzun "Sonlandırılıyor…" durumunda kalırsa hem arama penceresinde hem üstteki arama çubuğunda **Zorla kapat** düğmesi çıkar. Onaydan sonra sunucu, Verimor'da hâlâ açıksa çağrıyı kapatmayı dener ve kaydı her durumda kapatır; Verimor yanıt vermezse nedeni nota yazılır.

## 2.7.0 — 16 Kasım 2026

### Tanıtım sayfası ve Google (SEO)

- **www.hanhukuktakip.com artık Hukuk Takip Platformu'nun tanıtım sayfasını gösterir** (özellikler, modüller, güvenlik, fiyatlandırma ilkesi, sık sorulanlar). Sayfa tek dosyadır, betik ve dış kaynak yüklemez; başlık, açıklama, canonical, Open Graph / sosyal medya görseli ve schema.org yapılandırılmış verisi (Organization, WebSite, SoftwareApplication) içerir. Hiçbir büronun adı geçmez.
- **Mevcut büronun personeli için değişen bir şey yok:** oturumu açık olan kullanıcı `/` adresinde doğrudan uygulamayı görür. Giriş ekranı ayrıca **/giris** adresindedir; tanıtım sayfasındaki "Giriş yap" düğmeleri oraya gider. Oturumu kapanan kullanıcı kök adreste tanıtım sayfasını görür.
- **robots.txt ve sitemap.xml:** genel adreste site haritasını gösterir, `/api/` taranmaz. Büro adresleri (`<büro>.hanhukuktakip.com`), yönetim konsolu ve bütün uygulama ekranları `X-Robots-Tag: noindex, nofollow` ile Google dizininin dışında tutulur.
- İletişim bölümü sunucu ayarından gelir: `HAN_SITE_CONTACT_EMAIL` ve/veya `HAN_SITE_CONTACT_PHONE` tanımlanınca sayfada "Büronuz için demo isteyin" bölümü çıkar; tanımlı değilse "Demo isteyin" düğmeleri giriş ekranına gider. Ayrıntılar docs/SAAS.md "Tanıtım sayfası ve arama motorları" bölümünde.

### Telefon: Verimor yanıt vermediğinde anlaşılır uyarı

- Verimor arama isteğine zamanında yanıt vermediğinde ekranda İngilizce `Unexpected token '<', "<!DOCTYPE"… is not valid JSON` hatası çıkıyordu (16 Kasım 15:08). Uygulama doğru Türkçe uyarıyı gönderiyordu, ama dış hizmet hatalarında kullanılan 502/504 kodlu cevapları Cloudflare kendi HTML sayfasıyla değiştiriyordu.
- Kendi sunucumuz artık bu hataları **424** koduyla gönderiyor; Cloudflare bu cevaba dokunmuyor. Böylece kullanıcı "Verimor yanıtı alınamadı. Arama başladıysa tekrar başlatmayın; çağrı durumunu kontrol edin." uyarısını görüyor. Bu değişiklik telefonla sınırlı değil; SMS, yapay zekâ, harita ve ödeme hatalarının mesajları da artık ekrana ulaşıyor.
- Telefon ekranı, beklenmeyen bir cevapla karşılaşırsa da Türkçe uyarı gösteriyor: arama başlatılırken "Sunucudan yanıt alınamadı (HTTP …). Arama başlamış olabilir; tekrar aramadan önce son aramaları kontrol edin."

## 2.6.1 — 15 Kasım 2026

### Müvekkiller: kısa üst bölüm ve süzgeç satırı

- Müvekkiller ekranının üstü kısaldı: başlık, tek satırlık süzgeç ve tek satırlık özet şeridi. Özet kartları küçültüldü (başlık ve değer); liste artık ekranın üst yarısında başlıyor.
- **Süzgeç satırı:** arama kutusu ad, kimlik / vergi numarası **ve telefonla** arar (telefon nasıl yazılırsa yazılsın: `0532 111`, `(532) 111`, `+90 532 111`; ek telefonlar dahil). Yanında **İl** ve **İlçe** seçimleri var: il seçilince ilçe listesi o ilin ilçeleriyle dolar ve liste seçildikçe süzülür. **Temizle** hepsini sıfırlar.
- İl ve ilçe karşılaştırması büyük / küçük harfe bakmaz (`İSTANBUL` ile `İstanbul` aynıdır). Süzgeç sayfalar arasında gezinirken korunur; sayfalama süzgeçle birlikte çalışır.

## 2.6.0 — 15 Kasım 2026

### Şifremi unuttum: SMS, e-posta, WhatsApp ve "Yöneticiden iste"

- **E-posta ile şifre yenileme.** Kodlar platformun Brevo hesabından, **noreply@hanhukuktakip.com** adresinden ve **her büronun kendi adıyla** gider. Konsoldaki hesap açılana kadar sunucunun mevcut Brevo (SMTP) ayarı aynı işi görür; geçişte kesinti olmaz. 8 haneli, 15 dakika geçerli şifre yenileme kodu **yalnızca doğrulanmış adrese** gider. Adresini doğrulamamış kullanıcıya e-posta gitmez; ekran öteki yolları ve "Yöneticiden iste"yi sunar.
- **Büronun kendi SMS ve WhatsApp'ı canlı testten sonra açılır.** Ayarlar → SMS / WhatsApp içindeki **Şifre kurtarma canlı testi** ile CEO gerçek bir test mesajı gönderir; alıcı SMS'teki kodu ayar ekranına girince ya da WhatsApp bağlantısını açıp **Testi doğrula**'ya basınca kanal "Şifremi unuttum"da açılır. Gönderici, kimlik bilgisi veya şablon değişirse test yenilenir. Test mesajı büronun kendi adını taşır. Test edilmemiş kanal Şifre Yenileme ekranında **Canlı test bekliyor** olarak görünür.
- **İlk tercih büronun.** Ayarlar → Entegrasyonlar → **Şifre Yenileme** (yalnızca CEO): SMS, e-posta ve WhatsApp'tan hangisinin önce deneneceği seçilir. Kurulu olmayan yöntem seçilemez. Seçim yapılmamışsa eski sıra geçerlidir: WhatsApp, SMS, e-posta.
- **"SMS gelmedi mi?"** Kod ekranında 30 saniye sonra bu bağlantı açılır. Kullanıcı kodu yeniden isteyebilir, büroda açık olan öteki yolu seçebilir (ör. **E-posta ile gönder**) ya da **Yöneticiden iste** diyebilir.
- **Yöneticiden iste (son çare).** Telefonu ya da e-postası kayıtlı değilse veya kod ulaşmıyorsa kullanıcı, isteğe bağlı bir notla büro yöneticilerinden yeni şifre ister. Talep yöneticilere mesaj ve açılır bildirim olarak düşer. Kullanıcı Yönetimi ekranının üstünde **Bekleyen şifre talepleri** listesi görünür. Yönetici kimliği doğruladıktan sonra yeni şifreyi belirler (**Şifre üret** düğmesi okunması kolay 12 karakter üretir) ve kendisi iletir ya da kayıtlı cep telefonuna SMS / e-posta adresine gönderir. Şifre değişince talep kapanır. CEO'nun talebi yalnızca öteki CEO'lara gider.
- Giriş adı olarak artık kullanıcı adı, kayıtlı cep telefonu, WhatsApp numarası ya da **doğrulanmış** e-posta adresi yazılabilir. Doğrulanmamış adres hesabı bulmak için kullanılmaz.
- Hiçbir yöntem kurulu değilse ekran hata vermez; doğrudan "Yöneticiden iste" adımına geçer.
- Yanıtlar hesabın var olup olmadığını yine belli etmez. Kodlar yalnızca özetiyle saklanır, yedeğe girmez, 5 yanlış denemede geçersiz olur. Hesap başına sınırlar: şifre yenileme kodu günde 3, doğrulama kodu günde 5, yönetici talebi günde 3 (açık talep varken yenisi açılmaz).

### Personel e-posta doğrulaması

- Doğrulanmış adreslerin yanında Kullanıcı Yönetimi'nde ve Hesabım'da yeşil **✓ Doğrulandı**, öbürlerinde turuncu **Doğrulanmadı** işareti görünür. Adres değişince doğrulama düşer.
- Hesabım → İletişim bilgilerim ve kullanıcı iletişim penceresinde **Doğrulama kodu gönder** ve kod alanı var. Kod 24 saat geçerlidir. Kullanıcı kendi adresini doğrularken kodla birlikte **mevcut şifresini** de girer (açık kalmış bir oturum tek başına yeni bir adresi kurtarma adresi yapamasın diye). Yönetici, personelin okuduğu kodu kendisi girebilir; personelin şifresi sorulmaz.
- İlk e-posta kurtarma sürümünde doğrulanmış adresler doğrulanmış kalır; yeniden doğrulama gerekmez.
- E-posta gönderimi açıkken adresi doğrulanmamış kullanıcı, uygulamanın üstündeki şeritte adresini doğrulamaya çağrılır.
- Ayarlar → Entegrasyonlar → Şifre Yenileme'de kaç hesabın doğrulandığı görünür. **Doğrulanmamış adreslere doğrulama kodu gönder** düğmesiyle hepsine kod gider; son 24 saatte kod gitmiş hesaplar atlanır.

### Yönetim konsolu: E-posta (Brevo)

- Konsol → Yönetim → **E-posta (Brevo) — platform hesabı**: API anahtarı (mühürlü saklanır, geri gösterilmez), gönderen adresi (varsayılan noreply@hanhukuktakip.com), varsayılan gönderen adı ve "açık" anahtarı. **Bağlantıyı test et**, kalan krediyi ve gönderen alan adının Brevo'da doğrulanıp doğrulanmadığını gösterir. **Deneme e-postası** kısa bir e-posta gönderir.
- Her gönderim maskeli adresle kayda geçer, e-posta metni saklanmaz. Konsol aylık ve günlük sayıyı, hataları ve son 50 gönderimi gösterir. Bir büro günde en fazla 60 e-posta tetikleyebilir.
- Yeni veritabanı geçişi: `20261114120000_platform_email` (`han_saas.email_log`).

### Düzeltme

- Platform SMS'iyle, sonucu beklenen gönderimlerde (yöneticinin SMS ile gönderdiği şifre) hata sessizce yutuluyordu. Artık sonuç ekrana yazılıyor.

## 2.5.0 — 14 Kasım 2026

### Yönetim konsolu: harita servisinde büro başına kota ve kullanım dökümü

- Konsol → Yönetim → **Harita servisi** tablosu artık servisi kullanabilen **bütün büroları** gösterir (o ay hiç arama yapmamış olanlar dahil): bu ay yaptığı arama, kotası, kalan hakkı ve durumu (**Normal / Azaldı / Kota doldu**). Kotasının %80'ini kullanan büro **Azaldı** olarak işaretlenir.
- **Büro başına aylık arama kotası:** her büronun satırındaki seçim kutusundan 500, 1.000, 1.500, 2.000, 3.000, 5.000 ya da 10.000 seçilir; seçim anında kaydedilir. **Varsayılan** seçilirse büro genel sınıra döner. Genel sınırın adı **Varsayılan aylık arama (büro başına)** oldu.
- Büronun **kendi API anahtarıyla** yaptığı aramalar ayrı sütunda bilgi olarak görünür; kota yalnızca platformun sağladığı servis için geçerlidir. Servise abone olmayan ama kendi anahtarıyla arama yapan bürolar da listede yer alır.
- Kotası dolan büronun Rota Bulma ekranı aramayı durdurur ve kalan hakkı 0 gösterir; kota yükseltilince en geç 15 saniye içinde yeniden açılır. Kota değişiklikleri işlem kaydına yazılır.

## 2.4.2 — 14 Kasım 2026


### Yönetim konsolu: yerel yedekleme bilgisayarlarının durumu

- Konsol → Yönetim → **Yedekleme** bölümünde yeni tablo: **Yedekleme bilgisayarı**. Büroda ya da evde duran, her gün R2 kovasını, site kodunu ve veritabanı dökümlerini kendi diskine çeken her bilgisayarın son yerel yedeği, dosya sayısı, boyutu ve durumu (Güncel / Eski / Hata) görünür. 36 saatten uzun süredir yedek almayan bilgisayar **Eski** olarak işaretlenir.
- Tablo yalnızca sunucuda `HAN_LOCAL_BACKUP_DIR` ayarlıysa görünür; bilgisayarlar sonucu sunucuya kendileri bildirir.

### Konsoldan açılan yeni büro (düzeltmeler)

- Konsoldan açılan yeni büronun adresi her istekte **Sunucu hazır değil** (503) diyordu. Yeni büronun çalışma alanı tek belge olarak oluşturuluyor, kayıtların tablolarda tutulduğu kurulumda (`HAN_RECORD_STORE=1`) ise tablolara aktarılıp etkinleştirilmiyordu. Büro açılırken bu adım artık kendiliğinden yapılıyor.
- Büronun kendi adresindeki **giriş ekranı**, sayfa başlığı ve üst şerit artık **büronun adını** gösteriyor (önceden her büroda HAN (PATAN) HUKUK yazıyordu). Mevcut büroda değişiklik yok.
- **Makbuz ve ibraname her büronun kendi yazısıyla çıkar.** Ayarlar → Firma Bilgileri'nde iki yeni alan: **Makbuzda “Tahsil Eden” Yazısı** ve **İbraname İmzası**. Önceden bütün bürolarda mevcut büronun adı ve imzası sabit yazıyordu. Mevcut büro bugüne kadarki yazıyı kullanmaya devam eder; yeni büroda alanlar büronun adıyla dolu gelir ve değiştirilebilir. Makbuzu basan personel de bu iki yazıyı görür (vergi numarası gibi diğer firma bilgilerini görmez).
- Uygulamanın kendi yazdığı metinler de büroya göre çıkar: **personel gizlilik sözleşmesi taslağı** (veri sorumlusu, bildirim yapılacak kişi, uygulama adresi), **deneme SMS'i**, **zamanlanmış hatırlatma mesajı** ve **web telefon penceresinin başlığı**. Büro, Firma Bilgileri'ne girdiği adla; girmediyse konsoldaki adıyla anılır. Mevcut büronun metinleri değişmedi; yayımlanmış sözleşmeler olduğu gibi kalır.
- WhatsApp ile gönderilen PDF'lerin (teslim tutanağı, tahsilat makbuzu, ibraname) başlığı, büro Firma Bilgileri'ni henüz doldurmadıysa da büronun kendi adını taşır.
- Rota Bulma'daki aylık arama sayacının yazısı netleştirildi: sayı başta yazıyor (“Bu ay 5 arama yapıldı (Google Places API)”); önceki “Google Places API 5” ifadesi sayı olarak anlaşılmıyordu. Birden fazla kaynak varsa toplam ve kaynak dökümü birlikte gösterilir.
- Ayarlar → Uygulama Tercihleri'ndeki evrak ön eki alanının denetim kalıbı tarayıcıda geçersiz sayılıyordu (konsolda uyarı); düzeltildi.

## 2.4.1 — 14 Kasım 2026

### Kendi sunucumuzda konsol ve büro adresleri

- Site Vercel'den kendi sunucumuza taşındıktan sonra `admin.<alan>` konsolu açılmıyor, giriş **İstek kaynağı doğrulanamadı** diyordu. Sunucunun başlatma dosyası (`outputs/icrapro/server.cjs`) yalnızca mevcut büroyu çalıştırıyordu; artık Vercel girişiyle aynı kurulumu kullanıyor (konsol, alt alan adlarındaki bürolar, modül kapıları, kullanıcı sınırı, destek, harita servisi, toplu yedek).
- Sunucu veritabanıyla çalışırken canlı kipte çalışır: büro yedekleri yeniden `production/` klasörüne yazılır (taşınmadan sonraki günlerde `local/` klasörüne yazılmıştı).
- Sunucunun kendi içinden (127.0.0.1) çağrılan zamanlanmış işler mevcut büro için çalışmaya devam eder.

## 2.4.0 — 14 Kasım 2026

### Yönetim konsolu: tüm büroların ve yönetimin yedeği

- Konsol → Yönetim'de yeni **Yedekleme** bölümü. **Şimdi tümünü yedekle** düğmesi, alt alan adlarındaki bürolar dahil **bütün büroları** ve **yönetim verisini** (bürolar, abonelikler, satışlar, giderler, destek kayıtları, operatör hesapları) tek seferde yedekler.
- Her büronun yedeği kendi klasörüne şifreli yazılır; büro yöneticisi aynı dosyayı kendi Ayarlar → Yedekleme ekranında görür ve indirebilir.
- **Her sabah 06:00'da otomatik** yedekleme tek onay kutusuyla açılır (varsayılan kapalı). Böylece kendi otomatik yedeğini açmamış bürolar da her gün yedeklenir.
- Tabloda her büronun son yedek zamanı, boyutu ve durumu (Yedekli / Eski / Hiç alınmadı / Hata) görünür.
- Konsoldan yalnızca yönetim yedeği indirilebilir; büro dosyaları konsola verilmez. SMS şifresi ve harita anahtarı gibi sağlayıcı bilgileri yedeğe girmez.

### Düzeltme

- Ayarlar → Entegrasyonlar → **SMS** sekmesi açılmıyordu (`smsSettingsPage is not defined`). Sayfanın dosyası 11 Kasım'daki bir birleştirmede yüklenen dosyalar listesinden düşmüştü; geri eklendi.

### Teknik notlar

- Veritabanı geçişi yok. Yedek deposu (R2) ve `BACKUP_ENCRYPTION_KEY` zaten ayarlıdır.
- Yönetim yedeği için hazır geri yükleme komutu yoktur (bkz. docs/SAAS.md → Yedekleme).

## 2.3.0 — 13 Kasım 2026

### Rota Bulma: harita, bölge çizimi ve esnek arama

- **Harita:** Pazarlama → Rota Bulma'da arama formunun yanında harita açılır. **✎ Bölge çiz** ile haritada basılı tutup sürükleyerek aranacak bölgenin çevresi çizilir (telefonda parmakla); **▭ Görünen alanı seç** ekrandaki alanı bölge yapar. Bölge seçiliyken "Bul" yalnızca o bölgede arar.
- **Zorunlu alanlar kalktı:** artık yalnızca **il** seçmek ya da haritada **bölge çizmek** yeterlidir. Sektör ("Tüm sektörler"), ilçe, mahalle, cadde ve sokak isteğe bağlıdır. Önceki sürümde bu alanların tümü, gizli "Aranacak sektör" kutusu dahil, zorunlu tutuluyordu; düzeltildi.
- **Bulunan firmaları azaltma:** yeni **İlçe** süzgeci (bulunan firmaların ilçeleri, sayılarıyla), **Adında geçmesin** (ör. `avm, şube`), haritada çizilen bölgeyle süzme, **Yalnızca görünenleri tut** (uymayanları listeden çıkarır), satırdaki **✕** ile tek firmayı çıkarma ve **Süzgeçleri sıfırla**.
- Firmalar haritada nokta olarak görünür (renk ziyaret durumunu gösterir); noktaya tıklamak firmayı seçer.
- Harita kurulum gerektirmez (OpenStreetMap). Ayarlar → Entegrasyonlar → Google Haritalar → "Harita görünümü" bölümüne ayrı bir **harita anahtarı** girilirse Google haritası kullanılır. Google koşulları gereği Google'dan gelen firmalar yalnızca Google haritasında nokta olarak gösterilir.

### Rota Bulma iki ürün olarak satılabilir

- **Pazarlama ve rota (modül):** büro Ayarlar'a kendi API anahtarını girer.
- **Rota Bulma harita servisi (aylık abonelik):** büro hiçbir anahtar girmez; aramalar platformun harita servisiyle yapılır ve büro başına aylık arama hakkıyla sınırlıdır.
- Konsol → Yönetim'de yeni **Harita servisi** bölümü: platformun Google anahtarı, aylık sınırlar ve her büronun o ayki kullanımı. Kârlılık raporuna harita kullanımı ve birim maliyeti eklendi.

### Giriş ekranı

- "Yazıları Düzenle" penceresindeki önizleme büyütüldü: ekranın elverdiği kadar büyük gösterilir (1440 × 900 ekranda yaklaşık üçte bir daha büyük, geniş ekranlarda giriş ekranındaki gerçek boyutunda). Kaydet, Vazgeç ve Varsayılan Yazılara Dön düğmeleri sağ panele taşındı; küçük ekranlarda yalnızca ayar alanı kayar, düğmeler hep görünür.

### Teknik notlar

- Yeni geçiş: `20261113130000_maps_service.sql` (katalogda yeni ürün, kullanım sayacı ölçüleri). Canlıda `npm run db:migrate` gerekir; yeni ürün taslak ve fiyatsız gelir, operatör fiyatlayıp satışa açar.
- Harita kütüphanesi (Leaflet) depoya eklendi; harita karoları `tile.openstreetmap.org` adresinden gelir.

## 2.2.0 — 13 Kasım 2026

### Büroya özel giriş ekranı

Ayarlar → Firma Bilgileri'nin altındaki **Giriş Ekranı** kutusundan giriş sayfasının sol tarafı büroya göre düzenlenir. Kutudaki küçük önizleme, görseli yazılarıyla birlikte gösterir.

- **Görsel:** "Görsel Seç" ile JPG, PNG veya WebP bir görsel yüklenir. Büyük fotoğraflar yüklenirken kendiliğinden küçültülür. "Varsayılan Görsele Dön" terazi görselini geri getirir.
- **Yazılar:** "Yazıları Düzenle" giriş ekranının ölçekli bir kopyasını açar.
  - Yazı tutup sürüklenerek taşınır; seçili yazı ok tuşlarıyla da kayar.
  - Köşedeki tutamaçla, "Boyut" çubuğuyla ya da + / − tuşlarıyla büyütülüp küçültülür.
  - Metin, biçim (Marka (logolu), Başlık, Metin, Etiket), renk (Beyaz, Altın, Gri) ve kalınlık yan panelden değiştirilir.
  - En fazla 12 yazı eklenebilir; "Yazıyı Sil" ya da Delete tuşu yazıyı kaldırır.
  - Değişiklikler "Kaydet" ile giriş ekranına geçer. Pencere kaydedilmeden kapanırsa değişiklikler kaybolmaz, yeniden açınca geri gelir. "Varsayılan Yazılara Dön" bugünkü yazıları geri getirir.
- Yalnızca CEO ve yöneticiler değiştirebilir; her değişiklik işlem kayıtlarına yazılır. Her büronun görseli ve yazıları ayrıdır.
- Telefonda giriş ekranının sol tarafı gösterilmediği için bu yazılar bilgisayar ekranında görünür. Sağdaki form başlığı ve alttaki büro adı değişmez.

### Teknik notlar

- Görsel ve yazılar yeni `han_private.office_branding` tablosunda, büro anahtarı (`tenant_id`) ve erişim kuralı (RLS) ile tutulur. Canlıda `npm run db:migrate` gerekir. Geçiş uygulanmadan önce giriş ekranı varsayılan görsel ve yazılarla çalışır.

## 2.1.0 — 13 Kasım 2026

### Yenilikler

- **İnternet bağlantısı uyarısı:** bilgisayarın bağlantısı kesilince ekranın üstünde "İnternet bağlantısı yok" uyarısı çıkar. Bağlantı gelene kadar kayıt yapılamaz; arka plandaki yenilemeler bekler, bağlantı gelince kendiliğinden devam eder. Sunucuya ulaşılamayan her durumda aynı, anlaşılır mesaj gösterilir.
- **Sabit pencereler:** bir seçim yeni alanlar açıp kapatsa da pencere yerinde ve aynı boyutta kalır, zıplamaz. Daha fazla yer gereken pencere bir kez aşağı doğru büyür, sonra o boyutta kalır.
- **Excel'e aktarma:** yeni "Excel'e Aktar" düğmeleri:
  - Personel Kayıtları ile Maaş ve Prim Toplamları;
  - Personel Cari Hesabı;
  - Kasa ve Banka hareketleri: ekrandaki sayfa değil, seçili hesap ve süzgeçlere uyan tüm hareketler aktarılır.

  Dosya Excel'de doğrudan açılır; Türkçe karakterler ve tutarlar düzgün görünür.

### KVKK

- **Tümünü göster:** yan yana iki maskeli değer açıldıktan sonra üçüncüsünde "Tümünü göster" önerilir.
  - Bu seçim ekrandan ekrana açık kalır.
  - "Gizle" denince, uygulamadan çıkınca ya da 15 dakika işlem yapılmayınca veriler yeniden maskelenir.
- "Tümünü göster" ve personel/maaş Excel dökümü, veri açılmadan önce işlem kayıtlarına yazılır. Kayıt yazılamazsa veri açılmaz. Tek bir değeri tıklayıp 30 saniyeliğine açmak kayda yazılmaz.

### Muhasebe

- **Gecikmiş ödeme uyarıları** artık kullanıcının kendi dosyalarıyla sınırlı değil, büronun tüm dosyalarını kapsar (muhasebe yetkisi olanlar için).
- Borçlu tahsilatında dosya seçim listesi açık dosyalarla dolu açılır; yazdıkça daralır.
- Kasa/banka giriş-çıkış formlarında seçime göre açılan alanlar diğer alanları kaydırmaz.
- Taksit ve ödeme sözü hesabı hatırlatmalarda, otomatik iş akışında ve muhasebe uyarılarında artık tek ve aynı kurala göre yapılır.

### Çıkar çatışması

- İsim eşleştirmesi genişletildi: çok kelimeli isimlerde iki kelimesi tutan kayıtlar da aday sayılır; silinmiş (arşivdeki) dosya ve müvekkiller de taranır. Aday sayısı çok fazlaysa ekran listenin eksik olabileceğini söyler.

### Düzeltmeler

- Hiç arama yapılmamış bir büroda borçlu föyü açılınca görülen "Sunucu hazır değil" hatası giderildi; görüşme geçmişi boş liste olarak gelir.

## 2.0.0 — 13 Kasım 2026

Bu sürümle uygulama tek büroluk bir programdan **Hukuk Takip Platformu**'na dönüştü. Han Hukuk için adres, kullanıcılar, şifreler ve tüm kayıtlar aynı kaldı; aşağıdaki yenilikler 1.3.0'dan bu yana eklenenlerdir.

### Öne çıkanlar

- **Platform altyapısı:** her büronun verisi veritabanında birbirinden ayrı tutulur. Han Hukuk "mevcut büro" olarak bugünkü adresinden çalışmaya devam eder.
- **İnternet telefonu (Verimor):** föyden arama, gelen aramalar, şifreli ses arşivi ve görüşmeleri yazıya dökme.
- **KVKK ve güvenlik:** kişisel veriler ekranda maskeli görünür; yeni taraflarda çıkar çatışması kontrolü yapılır; silme yetkisi yalnızca CEO'dadır.
- **Personel cari hesabı:** aylık hakediş, prim ve maaş ödemeleri tek yerde.
- **Yeni ekran düzeni:** pencereler ekrana sığar, önemli düğmeler sayfa kayarken görünür kalır, işlem sonuçları sağ üstte bildirim kartı olarak çıkar.

### Güvenlik ve KVKK

- **Ekran maskeleme:** TC/vergi numarası, telefon, IBAN, e-posta ve adres ekranda maskeli gösterilir. Kaydı görme yetkisi olan kullanıcı değere tıklayarak 30 saniyeliğine açar. Ekrandaki verilerin tümünü birden açmak işlem kayıtlarına yazılır. Kayıtlı veriler ve formlar değişmez.
- **Çıkar çatışması kontrolü:** yeni bir müvekkil, borçlu veya kefil yazılırken başka bir dosyada geçip geçmediği gösterilir. Karşı tarafta eşleşme varsa (örneğin müvekkil başka dosyada borçluysa) kayıt, yazılı gerekçe girilmeden tamamlanmaz; gerekçe işlem kayıtlarına yazılır.
- **Silme yetkisi:** kayıt silme yalnızca CEO'dadır (teknik destek hesabı da CEO rolündedir). Silinen kayıtların kopyası arşivde korunur.
  - Personel mesajları mesaj ayrıntısından veya İşlem Silme'den silinebilir.
  - Görüşme Kayıtları'ndaki bir arama; kaydı, yazıya dökümü ve ses dosyasıyla birlikte **kalıcı** olarak silinir. Süren arama silinemez.
- **Salt okunur hesaplar** hiçbir kaydı değiştiremez. **Mola** başlayınca personelin oturumları kilitlenir, dönüşte şifre istenir.
- **Şifre kurtarma:** önce WhatsApp; kurulu değilse büronun kendi SMS hesabı (Ayarlar → Entegrasyonlar → SMS); o da yoksa platformun SMS hizmeti geçici şifre gönderir.

### Telefon (VoIP / Verimor)

- Borçlu föyünden ve bağımsız arama; arama sürerken her ekranda görünen arama çubuğu ve tek tuşla kapatma.
- Web telefonu öncesi mikrofon ve bağlantı kontrolü; sorun varsa adım adım ne yapılacağı gösterilir.
- **Gelen aramalar:** personelin web telefonunda çalar, numara bir föydeyse önce dosya sorumlusuna veya son arayana yönlendirilir ve görüşme o föye bağlanır.
- Görüşme sonucu penceresi; ulaşılamayan ve meşgul aramalar kendiliğinden kaydedilir.
- **Görüşme Kayıtları:** arama geçmişi, şifreli ses arşivi, dinleme yetkisi ve toplu yazıya dökme.
- Dahililer ve kayıt dinleme yetkileri Ayarlar → Entegrasyonlar → VoIP altında.
- Ara panelinden eklenen numara borçlunun boş Tel-1 / Tel-2 alanına, bunlar doluysa Tel-3, Tel-4… olarak eklenir. Daha önce eklenmiş numaralar da bu sıraya taşındı.

### Borçlu, föy ve evrak kabul

- Evrak kabul boş bir borçlu föyü olarak açılır; farklı alacak belgeleri tek föyde tutulabilir; föy numaraları sayısal ve tek sıradan verilir.
- **Föy kilidi:** bir föyü düzenleyen varken başka kullanıcılar aynı föyü görüntüleme modunda açar.
- Her telefon numarasının yanına "kime ait" (kaynak) bilgisi yazılabilir.
- Borçlu ve müvekkil kayıtlarına birden çok ek; dosya başına 10 MB'a kadar.
- Yetkili kullanıcılar için asıl alacak düzeltme ve manuel infaz.
- **Yediemin:** dosya altı ay bekletilip Derdest'e döner; tahsilat kalan alacakla sınırlı değildir; müvekkil payı ve kâr toplam tahsilattan hesaplanır.
- Teslim tutanakları müvekkile ve tarih aralığına göre süzülebilir.

### Müvekkiller

- Müvekkil başına üç banka hesabına kadar.
- Müvekkil hesap ekstresi (ödemeler, alt toplam, dosya durumu) Finansal İşlemler sekmesinde.
- Ad yazmaya başlayınca liste kendiliğinden süzülür.

### Muhasebe ve finans

- Kasa ve banka cari hesapları, yürüyen bakiye; hesap adına tıklayınca hareketler açılır.
- **Ortak masraf avansı:** kasa çıkışı bir kez gider sayılır, dosyalara dağıtılır.
- **Muhasebe uyarıları:** masraf avansı belirlenen uyarı eşiğinin altına düşünce ve vadesi geçmiş taksit veya ödeme sözü olunca Muhasebe ekranında uyarı çıkar.
- Gider raporu; müvekkil ödemelerinde kısmi ödeme ve süzme seçenekleri.
- Yöneticiler tüm ödeme sözlerini ve yaklaşanları görür.

### Personel

- **Personel cari hesabı:** aylık hakediş, maaş avansı, kapanmış ay ödemeleri ve cari hareketler.
- Pazarlama primi, Diğer personel Prim 2 ve INS hesapları; belirli yöneticiler için maaş/avans sınırı kaldırılabilir.
- Mola ve geç giriş raporları.
- Personel kaydı kendi penceresinde; fotoğraf ve PDF ekleri ayrı sekmede.

### Mesajlar ve hatırlatmalar

- WhatsApp ile gönderilen her mesajda alıcı bazında durum: gönderildi, gönderilemedi (Meta hata koduyla) veya neden gönderilmediği.
- WhatsApp gönderimi başarısız olursa hata kodu ve Türkçe açıklaması gösterilir.
- Tekrarlayan hatırlatmalar.
- **Geri bildirim:** ekranın sağ kenarındaki sekmeden, sayfanın ekran görüntüsüyle birlikte geri bildirim gönderilir.

### Pazarlama

- Potansiyel müvekkil ve ziyaret takibi; **Rota Bulma** ile haritadan firma bulma ve ziyaret rotası.

### Yapay zekâ

- Müvekkil raporları için görüşme geçmişi özetleri; sağlayıcı ve model ayarları, bağlantı testi; özel sağlayıcının model listesi kendiliğinden yüklenir.

### Platform (Hukuk Takip Platformu)

- **Ayarlar → Destek:** platform destek ekibine talep açma ve yanıtları okuma.
- **Süreli destek erişimi** (destek ekibinin 15 dk / 30 dk / 1 saat büroya bağlanması, üstte şerit, her an sonlandırma) yönetim konsoluyla birlikte açılacak.
- **Ayarlar → Entegrasyonlar → iyzico:** büronun kendi iyzico hesabıyla kartla ödeme almak için.
- Yönetim konsolu (admin.hanhukuktakip.com) ve yeni büroların kendi adresleri sonraki aşamada açılacak.

### Ekran düzeni

- Müvekkil, personel, borçlu düzenleme, tahsilat/masraf, İşlem Silme ve Potansiyel Müvekkil pencereleri ekrana sığacak şekilde yeniden düzenlendi; sekmeler arasında geçerken pencere boyutu değişmez.
- Sayfa aşağı kaydırılınca "Yeni Müvekkil", "Potansiyel Müvekkil Ekle" gibi ana düğmeler üstte kalır.
- İşlem sonuçları (kaydedildi, silindi, iptal edildi, hata) sağ üstte, açık pencerelerin de üstünde, renkli kartlar olarak gösterilir.
- Yedekleme günün seçilen saatlerinde veya haftanın seçilen gününde yapılabilir.

### Teknik notlar (yönetici için)

- 13 Kasım 2026'da canlı veritabanı büro bazlı yapıya geçirildi. Geçişten hemen önce R2'ye şifreli tam yedek alındı. Bu geçiş yalnızca kodu geri alarak geri alınamaz; geri dönüş yolu o yedektir.
- Bundan sonra veritabanına eklenecek her tablo büro anahtarı (`tenant_id`) ve erişim kuralı (RLS) ile eklenmelidir; ayrıntılar `docs/SAAS.md`'de.
- Yönetim konsolunu açmak için: süper yönetici hesabının oluşturulması, `admin.hanhukuktakip.com` alan adı ve `HAN_TENANT_BASE_DOMAIN` ortam değişkeni (`docs/SAAS.md`).
- UYAP ve banka entegrasyonu için plan: `docs/ENTEGRASYON-YOL-HARITASI.md` (henüz uygulanmadı).
