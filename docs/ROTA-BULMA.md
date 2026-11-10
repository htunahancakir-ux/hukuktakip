# Pazarlama → Rota Bulma

Pazarlama sayfasındaki **⌖ Rota Bulma** düğmesi, Google Haritalar'daki firmaları sektör ve
adrese göre bulur, alt süzgeçlerle daraltır, seçilen firmalardan Google Haritalar rotası
oluşturur ve rotayı WhatsApp'tan göndermeye hazırlar.

Erişim, Pazarlama sayfasıyla aynıdır: CEO, yönetici ve birimi "Pazarlama" olan aktif personel.
Salt okunur hesaplar (CEO hariç) arama yapamaz.

Firma listesi için iki kaynak vardır; CEO birini veya ikisini açar, kullanıcı aramada seçer:

1. **Google Places API** — resmî ve en güvenilir kaynak, anında sonuç; Google Cloud hesabı ister.
2. **Harita tarama (gosom)** — açık kaynak `gosom/google-maps-scraper` (MIT, ücretsiz) sizin
   bilgisayarınızda/sunucunuzda çalışır. Sonuçlar birkaç dakika sürer.

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

## Kullanım

1. Sektör, il ve ilçe seçin; isterseniz mahalle, cadde ve sokak yazın. **Bul** 20 firma getirir,
   **Daha fazla getir** ile bir aramada en çok 60 firmaya çıkılır (Google sınırı).
2. Alt süzgeçler ek ücret doğurmaz: telefon / cep telefonu, ziyaret durumu (daha önce
   gidilmeyenler, planlananlar, gidilenler, tekrar gidilecekler), mevcut konuma uzaklık,
   şu an açık, yalnızca seçilen ilçe, kapanmış işletmeler, Google puanı, yorum sayısı,
   web sitesi, ad/adres araması ve sıralama.
3. Satırları veya **görünenlerin tümünü** seçip **Rota Oluştur**'a basın. Sıra en kısa yola
   göre hesaplanır, elle değiştirilebilir.
4. **Google Haritalar'da Aç**, **WhatsApp'a Gönder** veya **Rotayı Kopyala**. WhatsApp mesajı
   kullanıcının kayıtlı WhatsApp/personel telefonuna hazırlanır; numara yoksa kişi seçilir.
5. **Rotalarım** sekmesinde kayıtlı rota açılır; her durakta **Yol tarifi** ve
   **Ziyareti Kaydet** bulunur. Ziyaret, Potansiyel Müvekkil kaydı olarak düşer
   (Ziyaret Sonucu: Görüşüldü / Yetkili yoktu / İlgilenmiyor / Tekrar gidilecek).

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
oluşturan kişi tutulur. Büro başına en yeni 300 rota saklanır; daha eski rotalar listeden
düşer, bağlı ziyaret kayıtları korunur. Arama sonuçları yalnızca tarayıcı sayfasında kalır.
Kullanıcının kaydettiği ziyaret, Potansiyel Müvekkil kaydı olarak saklanır.

## Teknik notlar

- Arama, rota yenileme ve anahtar testi Google çağrısı sırasında veritabanı işlemi
  tutmaz: bulutta salt okunur istek yolundan geçer (`lib/application.cjs`).
- Kod: `outputs/icrapro/access-marketing.cjs` (uç noktalar), `lib/marketing-routes.cjs`,
  `lib/google-places.cjs`, `lib/maps-settings.cjs`, `outputs/icrapro/workspace-marketing.js`
  (ekran), `outputs/icrapro/workspace-marketing-route.js` (sıra, bağlantı, süzgeç).
- Testler: `tests/marketing-route.test.cjs`.
