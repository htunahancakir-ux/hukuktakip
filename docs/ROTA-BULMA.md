# Pazarlama → Rota Bulma

Pazarlama sayfasındaki **⌖ Rota Bulma** düğmesi, Google Haritalar'daki firmaları bulur: ile,
ilçeye, sektöre ya da **haritada çizilen bir bölgeye** göre. Bulunan firmalar alt süzgeçlerle
ve haritada çizilen bölgeyle azaltılır, seçilenlerden Google Haritalar rotası oluşturulur ve
rota WhatsApp'tan göndermeye hazırlanır.

Erişim, Pazarlama sayfasıyla aynıdır: CEO, yönetici ve birimi "Pazarlama" olan aktif personel.
Salt okunur hesaplar (CEO hariç) arama yapamaz.

Firma listesi için üç kaynak vardır; kullanıcı aramada hazır olanlardan seçer:

1. **Google Places API** — büronun kendi Google anahtarı. Resmî ve en güvenilir kaynak, anında
   sonuç; Google Cloud hesabı ister.
2. **Harita tarama (gosom)** — açık kaynak `gosom/google-maps-scraper` (MIT, ücretsiz) sizin
   bilgisayarınızda/sunucunuzda çalışır. Sonuçlar birkaç dakika sürer.
3. **Hazır harita servisi (abonelik)** — platformun (satıcı firmanın) Google hesabı. Büro hiçbir
   anahtar girmez; aramalar aylık bir hakla sınırlıdır.

## İki satış biçimi

Rota Bulma bürolara iki ayrı ürün olarak satılır; biri ya da ikisi birden alınabilir:

| Ürün (katalog kodu) | Büro ne yapar | Arama hangi hesapla yapılır |
| --- | --- | --- |
| **Pazarlama ve rota** (`marketing-routes`) — modül | Ayarlar → Entegrasyonlar → Google Haritalar'a **kendi API anahtarını** (ve/veya tarama sunucusunu) girer | Büronun kendi Google hesabı; Google ücreti büroya aittir |
| **Rota Bulma harita servisi** (`marketing-routes-service`) — aylık abonelik | Hiçbir kurulum yapmaz | **Platformun** Google hesabı; ücret platforma aittir, büro başına aylık arama hakkı vardır |

- İkisinden biri satılmışsa Rota Bulma açılır; ikisi de satılmamışsa düğme görünmez ve
  `/api/marketing/*` 403 döner.
- Yalnızca aboneliği olan büro kendi anahtarını giremez ve kullanamaz (403); Ayarlar'daki
  Google Haritalar sayfasında yalnızca **sektör listesini** düzenler.
- İkisini birden alan büroda kaynak listesinde üçü de görünür; büronun Ayarlar'da seçtiği
  varsayılan kaynak geçerlidir.
- Fiyatları operatör konsolda belirler; kodda fiyat yoktur. Mevcut (kök alandaki) büro her
  ikisine de sahiptir. Ayrıntı: `docs/SAAS.md` → "Harita servisi".

## Kurulum: Google Places API (CEO)

1. Google Cloud Console'da bir proje açın ve faturalandırmayı etkinleştirin.
2. **Places API (New)** hizmetini etkinleştirin.
3. Bir API anahtarı oluşturun ve anahtarı yalnızca Places API (New) ile sınırlayın.
4. Kotalar bölümünde günlük istek sınırı koyun.
5. Uygulamada **Ayarlar → Entegrasyonlar → Google Haritalar** bölümüne anahtarı girin,
   **Anahtarı Test Et** ile doğrulayıp kaydedin. Sektör listesi de buradan düzenlenir
   (her satıra `Görünen ad | Google'da aranacak ifade`).

Sunucuda `MAPS_ENCRYPTION_KEY` (64 onaltılık karakter) tanımlı olmalıdır; yoksa
`BACKUP_ENCRYPTION_KEY` kullanılır. Anahtar AES-256-GCM ile şifrelenir, tarayıcıya hiç
gönderilmez ve yedeklere alınmaz. Yedekten dönüşte anahtar yeniden girilir.

## Kurulum: Harita tarama (gosom)

**Uyarı:** Google Haritalar'ı taramak Google'ın kullanım koşullarına aykırıdır; yoğun kullanımda
Google IP'yi engelleyebilir veya araç sayfa değişikliğiyle bozulabilir. Şahıs firmalarının
telefonları kişisel veridir (KVKK). Kaynak bu riskler bilinerek açılmalıdır.

1. Docker'ı kurun ve tarama sunucusunu başlatın:

   ```
   docker run -d --name gmaps -p 127.0.0.1:8080:8080 -v gmapsdata:/gmapsdata \
     -e DISABLE_TELEMETRY=1 gosom/google-maps-scraper -data-folder /gmapsdata
   ```

   `DISABLE_TELEMETRY=1` aracın varsayılan olarak açık telemetrisini kapatır.
2. **Uygulama bu bilgisayarda çalışıyorsa** adres olarak `http://127.0.0.1:8080` girin.
3. **Uygulama bulutta (Vercel) çalışıyorsa** bulut sizin bilgisayarınıza erişemez: tarama
   sunucusunu bir alan adıyla HTTPS ve parola koruması (Caddy/Nginx) arkasında yayınlayın,
   adresi `https://…` olarak, parolayı **Erişim anahtarı** alanına `Basic …` biçiminde girin.
   gosom'un kendi kimlik doğrulaması yoktur; korumasız olarak internete açmayın.
4. **Ayarlar → Entegrasyonlar → Google Haritalar** → "2. Harita tarama" bölümünde adresi girip
   **Tarama Sunucusunu Test Et**, sonra kaydedin. Varsayılan kaynağı da buradan seçin.

Tarama kapsamı: Hızlı (yaklaşık 5 dk sınır), Normal (10 dk), Geniş (20 dk). Ekran 10 saniyede
bir durumu sorar; sayfadan ayrılıp dönülürse bekleme kaldığı yerden sürer. Taramayla bulunan
rotalar, Google anahtarı olmadan açılabilmesi için firma adı/adres/telefon/konum kopyasıyla
saklanır. Uygulama bu uç noktaları IP başına 15 dakikada 20 tarama ve 300 durum sorgusuyla sınırlar.

## Kurulum: Harita görünümü (isteğe bağlı)

Ekrandaki harita hiçbir kurulum olmadan **OpenStreetMap** ile çalışır. Google haritası için
Ayarlar → Entegrasyonlar → Google Haritalar → "3. Harita görünümü" bölümüne bir **harita
anahtarı** girilir:

- Bu, Places API anahtarından **ayrı** bir anahtardır ve tarayıcıya gönderilir. Google Cloud'da
  yalnızca **Maps JavaScript API** ile ve sitenizin adresiyle (HTTP yönlendiren) sınırlayın.
  Places anahtarının aynısı kabul edilmez.
- Google kullanım koşulları, Places API'den gelen firmaların Google dışı bir haritada
  gösterilmesini yasaklar. Bu yüzden OpenStreetMap haritasında yalnızca **harita taramasıyla**
  bulunan firmalar nokta olarak görünür; Google'dan gelen firmalar için harita anahtarı gerekir.
  Bölge çizme, bölgeyle arama ve bölgeyle süzme her iki haritada da çalışır.
- Google anahtarı reddederse ekran kendiliğinden OpenStreetMap'e döner.
- Abone bürolarda harita anahtarı platformdan gelir (konsolda girilmişse).

## Kullanım

1. **Yer seçin.** Yalnızca **il** seçmek yeterlidir; isterseniz ilçe, mahalle, cadde, sokak
   ekleyin. İl yerine **haritada bölge çizerek** de arayabilirsiniz. Sektör isteğe bağlıdır:
   "Tüm sektörler" seçiliyken her tür firma aranır. Hiçbir alan tek başına zorunlu değildir;
   gereken tek şey bir il ya da çizilmiş bir bölgedir.
2. **Haritada bölge çizme.** **✎ Bölge çiz**'e basın, haritada basılı tutup aramak istediğiniz
   alanın çevresini dolaşın; bırakınca bölge kapanır (telefonda parmakla). **▭ Görünen alanı
   seç** ekrandaki harita alanını bölge yapar, **✕ Bölgeyi sil** kaldırır, Esc çizimden çıkar.
   Bölge seçiliyken **Bul** yalnızca o bölgede arar.
3. **Bul** 20 firma getirir, **Daha fazla getir** ile bir aramada en çok 60 firmaya çıkılır
   (Google sınırı). Yalnızca il ile arandığında sonuçlar ilin tümünden gelir.
4. **Bulunan firmaları azaltma.** Hiçbiri ek ücret doğurmaz:
   - Süzgeçler: telefon / cep telefonu, ziyaret durumu (daha önce gidilmeyenler, planlananlar,
     gidilenler, tekrar gidilecekler), mevcut konuma uzaklık, şu an açık, kapanmış işletmeler,
     Google puanı, yorum sayısı, web sitesi, **ilçe** (bulunan firmaların ilçeleri, sayılarıyla),
     ad/adres araması, **adında geçmesin** (ör. `avm, şube`) ve sıralama.
   - **Haritada bölge:** arama sonrasında çizilen bölge listeyi o bölgedeki firmalara indirir.
   - **Yalnızca görünenleri tut** süzgeçlere ve bölgeye uymayanları listeden kalıcı olarak
     çıkarır; satırdaki **✕** tek bir firmayı çıkarır; **Süzgeçleri sıfırla** ilk hâle döner.
   - Haritadaki noktaya tıklamak o firmayı seçer; satırın üzerine gelince noktası belirginleşir.
     Nokta renkleri: mavi yeni, turuncu planlandı, yeşil gidildi, kırmızı ilgilenmiyor.
5. Satırları veya **görünenlerin tümünü** seçip **Rota Oluştur**'a basın. Sıra en kısa yola
   göre hesaplanır, elle değiştirilebilir.
6. **Google Haritalar'da Aç**, **WhatsApp'a Gönder** veya **Rotayı Kopyala**. WhatsApp mesajı
   kullanıcının kayıtlı WhatsApp/personel telefonuna hazırlanır; numara yoksa kişi seçilir.
7. **Rotalarım** sekmesinde kayıtlı rota açılır; her durakta **Yol tarifi** ve
   **Ziyareti Kaydet** bulunur. Ziyaret, Potansiyel Müvekkil kaydı olarak düşer
   (Ziyaret Sonucu: Görüşüldü / Yetkili yoktu / İlgilenmiyor / Tekrar gidilecek). İlçesiz ya da
   yalnızca bölgeyle aranmış bir rotada il ve ilçe firmanın adresinden doldurulur, düzeltilebilir.

Bir firma, Google yer kimliği, telefon numarası veya aynı ilçedeki firma adı bir Potansiyel
Müvekkil kaydıyla eşleşirse "Gidildi" sayılır. Kayıtlı bir rotada olup ziyaret kaydı
olmayanlar "Planlandı" görünür. Yöneticiler kimin gittiğini görür; personel başka personelin
adını görmez.

## Google sınırları ve maliyet

- Telefon, puan ve açık/kapalı bilgisi "Text Search Enterprise" tarifesindedir: ayda 1.000
  istek ücretsiz, sonrası Google'ın güncel fiyatıyla. Bir "Bul" veya "Daha fazla getir" bir
  istektir.
- Kayıtlı rota açılırken firma adları "Place Details Pro" ile yeniden alınır (ayda 5.000 ücretsiz).
- Anahtar testi ücretsiz kimlik-yalnız aramadır.
- Uygulama, IP başına 15 dakikada 40 arama, 30 rota yenileme ve 10 anahtar testi ile sınırlar.
- Google tek bağlantıda 9 ara durağa (telefon tarayıcısında 3) izin verir; uzun rotalar
  bölümlere ayrılır, her bölüm bir öncekinin son durağından başlar.

## Saklanan veri

Google Haritalar koşulları gereği firma adı, adresi ve koordinatı saklanmaz. Kayıtlı rotada
yalnızca Google yer kimlikleri, arama ölçütleri, başlangıç türü (cihaz konumu saklanmaz) ve
oluşturan kişi tutulur. Haritada çizilen bölge (kullanıcının kendi çizimi) rotayla birlikte
saklanır. Büro başına en yeni 300 rota saklanır; daha eski rotalar listeden
düşer, bağlı ziyaret kayıtları korunur. Arama sonuçları yalnızca tarayıcı sayfasında kalır.
Kullanıcının kaydettiği ziyaret, Potansiyel Müvekkil kaydı olarak saklanır.

## Teknik notlar

- Arama, rota yenileme ve anahtar testi Google çağrısı sırasında veritabanı işlemi
  tutmaz: bulutta salt okunur istek yolundan geçer (`lib/application.cjs`).
- Kod: `outputs/icrapro/access-marketing.cjs` (uç noktalar), `lib/marketing-routes.cjs`,
  `lib/google-places.cjs`, `lib/maps-settings.cjs`, `lib/saas/platform-maps.cjs` (abonelik
  servisi), `outputs/icrapro/workspace-marketing.js` (ekran),
  `outputs/icrapro/workspace-marketing-map.js` (harita ve çizim katmanı),
  `outputs/icrapro/workspace-marketing-route.js` (sıra, bağlantı, süzgeç, bölge hesabı).
- **Bölge:** en çok 60 köşeli bir çokgendir (`[enlem, boylam]`, yaklaşık 1 m'ye yuvarlanır),
  her kenarı en az 100 m olmalıdır. Serbest çizim ekranda sadeleştirilir. Google'a bölgenin
  dikdörtgeni `locationRestriction` olarak, tarama sunucusuna merkez + yakınlaştırma + yarıçap
  olarak gider; dikdörtgenin içinde ama çizimin dışında kalan firmalar sunucuda elenir.
- **Harita:** Leaflet 1.9.4 (BSD-2-Clause) `outputs/icrapro/leaflet.js` olarak depoda durur ve
  Rota Bulma açılınca yüklenir. Altlık OpenStreetMap karolarıdır (`tile.openstreetmap.org`,
  anahtarsız; yoğun ticari kullanımda ücretli bir karo sağlayıcısına geçilmelidir). Çizim ve
  nokta katmanı altlıktan bağımsız tek bir SVG'dir; Google altlığı yalnızca harita anahtarı
  varken yüklenir.
- **Zorunlu alanlar:** uygulama her formda `data-optional` taşımayan alanı zorunlu kılar
  (`personnel.js`). Arama formundaki isteğe bağlı alanlar bu yüzden `data-optional="true"`
  taşır; gizli "Aranacak sektör" kutusu seçilmediğinde devre dışıdır.
- Testler: `tests/marketing-route.test.cjs`, `tests/marketing-scraper.test.cjs`,
  `tests/marketing-map.test.cjs`, `tests/platform-maps.test.cjs`.
