# Sürüm Notları

## Sıradaki sürüm — henüz yayınlanmadı

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
