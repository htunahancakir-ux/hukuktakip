# WhatsApp Business kurulumu

1. [Meta WhatsApp Cloud API kurulumundan](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api) işletme numarasını ekleyin. **Phone number ID** ve mesaj gönderebilen erişim anahtarı gerekir. Erişim anahtarını sohbete veya GitHub'a yazmayın.
2. WhatsApp Manager'da aşağıdaki yapıda şablonları oluşturup Meta onayını bekleyin. Şablon adlarını ve dil kodunu CEO hesabıyla **Ayarlar → WhatsApp Business** ekranına girin. Boş bırakılan şablonun gönderimi kapalı kalır.
3. **Kullanıcı Yönetimi → WhatsApp ve Şifre Bağlantısı** üzerinden her hesabın doğrulanmış telefonunu ve WhatsApp gönderim onayını kaydedin. Şifre bağlantıları yalnızca bu kayıtlı numaraya gönderilir.

| Şablon | Metin gövdesindeki değişkenler | Ek bileşen |
| --- | --- | --- |
| Şifre bağlantısı | Günlük, 7 günlük, 30 günlük kalan hak | İlk düğme dinamik URL: `https://www.hanhukuktakip.com/#sifre={{1}}` |
| Mesaj | Gönderen, konu, metin önizlemesi | — |
| İş emri / hatırlatma | Gönderen, iş başlığı, son tarih | — |
| PDF / evrak | Evrak referansı veya dosya adı | Belge başlığı |
| Fotoğraf | Evrak referansı veya dosya adı | Görsel başlığı |

Meta, gönderimi başlatan şablonları kendi kurallarına göre değerlendirir. Şifre bağlantısı için dinamik URL düğmesine sahip şablonun onaylanması gerekir. Canlı etkinleştirmeden önce Meta'nın test numarasıyla şablonların aynı sayıda ve sırada değişken kabul ettiğini doğrulayın.

Şifremi Unuttum ekranı telefon veya kullanıcı adı kabul eder. Yanıt, hesabın varlığını açığa çıkarmaz. Bağlantı 15 dakika geçerlidir ve tek kullanımlıktır. Son 24 saatte 1, son 7 günde 3 ve son 30 günde 8 bağlantı talebi yapılabilir. Mesajda talep sonrasındaki kalan haklar yer alır. Şifre değiştiğinde önceki oturumlar kapatılır.

WhatsApp seçimi, mesaj ve iş emri ekranlarında varsayılan olarak açıktır. Gönderen seçimi kaldırabilir. Uygulama içi işlem, WhatsApp sonucu ayrı gösterilerek kaydedilir. Meta'nın gönderimi kabul etmesi, mesajın okunduğunu göstermez. Tutanak, makbuz, PDF ve fotoğraf gönderiminde alıcının numarası ve onayı istenir.

**Hatırlatmalar** menüsünde Türkiye saatiyle bir gün ve saat belirleyip kendinize bildirim kurabilirsiniz. WhatsApp seçimi için aynı iş emri/hatırlatma şablonu ve hesabınızda onaylı numara gerekir. Mesajda saat ve uygulama bağlantısı bulunur; dosya bilgileri ve not uygulamada kalır. Canlı zamanlayıcı, uygulama yayınlandıktan sonra Supabase'de [zamanlayıcı SQL dosyası](../scripts/supabase-reminder-scheduler.sql) ile etkinleştirilir. Yerel geliştirme sunucusunda otomatik WhatsApp gönderimi varsayılan olarak kapalıdır; ayrı test hesabıyla denemek için `HANHUKUK_LOCAL_REMINDER_DELIVERY=1` ayarlanabilir.

Meta anahtarı sunucuda şifrelenir. İstenirse `WHATSAPP_ENCRYPTION_KEY` ile ayrı bir 32 baytlık anahtar tanımlanabilir. Yoksa mevcut yedekleme anahtarından WhatsApp için ayrı bir anahtar türetilir. Entegrasyon ayarları ve geçici şifre bağlantıları uygulama yedeğine dahil edilmez.
