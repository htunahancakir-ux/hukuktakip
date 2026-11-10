# Pazarlama → Rota Bulma

Pazarlama sayfasındaki **⌖ Rota Bulma** düğmesi, Google Haritalar'daki firmaları sektör ve
adrese göre bulur, alt süzgeçlerle daraltır, seçilen firmalardan Google Haritalar rotası
oluşturur ve rotayı WhatsApp'tan göndermeye hazırlar.

Erişim, Pazarlama sayfasıyla aynıdır: CEO, yönetici ve birimi "Pazarlama" olan aktif personel.
Salt okunur hesaplar ücretli arama yapamaz.

## Kurulum (CEO)

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
