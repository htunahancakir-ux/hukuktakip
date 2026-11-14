# Brevo ile şifre kurtarma

Sunucunun gizli ortam dosyasında `BREVO_SMTP_LOGIN`, `BREVO_SMTP_KEY` ve doğrulanmış gönderici adresi `BREVO_FROM_EMAIL` tanımlanır. Anahtar Git'e, yedeklere veya tarayıcıya eklenmez. SMTP bağlantısı `smtp-relay.brevo.com:587` üzerinden zorunlu STARTTLS kullanır. İki kimlik bilgisi eksikse e-posta kurtarma kapalıdır.

Kullanıcı ilk kurulumda **Hesabım → İletişim bilgilerim** bölümünde e-posta adresini kaydeder. **Şifre kurtarma e-postası** bölümünde mevcut şifresiyle doğrulama kodu ister ve e-postadaki kodu girer. Personel iletişim kaydını değiştirmek tek başına kurtarma adresini doğrulamaz. Adres değişirse yeniden doğrulama gerekir.

Giriş ekranında **Şifremi unuttum → E-posta ile şifremi sıfırla** seçilir. E-posta adresi veya kullanıcı adıyla kod istenir. Kod 15 dakika geçerlidir, tek kullanımlıdır ve beş yanlış denemede kapanır. Hesap başına üç/gün, altı/hafta ve on iki/ay gönderim sınırı vardır. Var olmayan, doğrulanmamış veya sınırı dolmuş hesaplar aynı yanıtı alır. Kodlar yalnızca tuzlu özet olarak saklanır; e-posta/adres ve mevcut parola özetiyle bağlanır. Yeni kod, önceki kodu geçersiz kılar. Başarılı sıfırlama mevcut oturumları kapatır.

SMTP gönderimi veritabanı işlemi başarıyla tamamlandıktan sonra başlar. Hata kaydı kod, adres veya anahtar içermez. Kullanıcıya sağlayıcının teslim ettiğine ilişkin doğrulanmamış bir sonuç gösterilmez. E-posta kurtarma kodları yedeklerden çıkarılır. Mevcut SMS ve WhatsApp kurtarma yolları ayrı kalır.

Doğrulama: `node --wasm-num-compilation-tasks=1 --liftoff-only --no-wasm-tier-up --test --test-concurrency=1 tests/email-recovery.test.cjs tests/account-contact.test.cjs tests/sms-recovery-ui.test.cjs tests/sms.test.cjs tests/session-security.test.cjs`.
