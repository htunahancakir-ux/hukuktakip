# Brevo ile şifre kurtarma

Sunucunun gizli ortam dosyasında `BREVO_SMTP_LOGIN`, `BREVO_SMTP_KEY` ve doğrulanmış gönderici adresi `BREVO_FROM_EMAIL` tanımlanır. Anahtar Git'e, yedeklere veya tarayıcıya eklenmez. SMTP bağlantısı `smtp-relay.brevo.com:587` üzerinden zorunlu STARTTLS kullanır. İki kimlik bilgisi eksikse e-posta kurtarma kapalıdır.

Kullanıcı ilk kurulumda **Hesabım → İletişim bilgilerim** bölümünde e-posta adresini kaydeder. **Şifre kurtarma e-postası** bölümünde mevcut şifresiyle doğrulama kodu ister ve e-postadaki kodu girer. Personel iletişim kaydını değiştirmek tek başına kurtarma adresini doğrulamaz. Adres değişirse yeniden doğrulama gerekir.

Giriş ekranında **Şifremi unuttum → E-posta ile şifremi sıfırla** seçilir. E-posta adresi veya kullanıcı adıyla kod istenir. Kod 15 dakika geçerlidir, tek kullanımlıdır ve beş yanlış denemede kapanır. Hesap başına üç/gün, altı/hafta ve on iki/ay gönderim sınırı vardır. Var olmayan, doğrulanmamış veya sınırı dolmuş hesaplar aynı yanıtı alır. Kodlar yalnızca tuzlu özet olarak saklanır; e-posta/adres ve mevcut parola özetiyle bağlanır. Yeni kod, önceki kodu geçersiz kılar. Başarılı sıfırlama mevcut oturumları kapatır.

SMTP gönderimi veritabanı işlemi başarıyla tamamlandıktan sonra başlar. Hata kaydı kod, adres veya anahtar içermez. Kullanıcıya sağlayıcının teslim ettiğine ilişkin doğrulanmamış bir sonuç gösterilmez. E-posta kurtarma kodları yedeklerden çıkarılır. Mevcut SMS ve WhatsApp kurtarma yolları ayrı kalır.

## SMS / WhatsApp seçeneklerinin otomatik açılması

Giriş ekranı `/api/password-reset/channels` yanıtından yalnız doğrulanmış kanalları gösterir. Yeni veya test edilmemiş kanal gizlidir. Ayarlar → SMS / WhatsApp içindeki **Şifre kurtarma canlı testi** kayıtlı ve etkin ofis bağlantısıyla gerçek test gönderimini başlatır. SMS alıcısı gelen 8 haneli kodu ayarlara girer; WhatsApp alıcısı şifre bağlantısı şablonuyla gelen bağlantıyı açıp **Testi doğrula** düğmesine basar. Parola değiştirilmez. Bakiye/bağlantı testi veya sağlayıcının gönderimi kabul etmesi seçenekleri açmaz.

CEO'nun başlattığı testin alıcısı teslimi doğruladığında kanal sonraki Şifremi unuttum ekranında kendiliğinden görünür. SMS ve WhatsApp ayrı doğrulanır. Kanallar kendi kayıtlı ofis bağlantısını kullanır; platform SMS hesabının genel bağlantı testi bir ofisin kurtarma kanalı için kanıt sayılmaz. Gönderici, kimlik bilgileri veya şifre şablonu değişirse doğrulama iptal olur ve yeniden test gerekir. Test kodları/bağlantıları 15 dakika geçerli ve tek kullanımlıdır; SMS beş yanlış denemede kapanır. Kanal başına CEO günde en fazla üç test başlatabilir. Bekleyen test özetleri yedeklerden çıkarılır; geri yükleme sonrasında canlı testler yenilenir.

Doğrulama: `node --wasm-num-compilation-tasks=1 --liftoff-only --no-wasm-tier-up --test --test-concurrency=1 tests/email-recovery.test.cjs tests/account-contact.test.cjs tests/sms-recovery-ui.test.cjs tests/sms.test.cjs tests/session-security.test.cjs`.
