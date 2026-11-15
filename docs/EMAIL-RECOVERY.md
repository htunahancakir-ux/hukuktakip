# Şifre yenileme: e-posta, SMS, WhatsApp ve canlı kanal testi

Bu belge "Şifremi unuttum" akışının kurallarını özetler. Platform tarafındaki Brevo hesabı,
büronun ilk tercihi ve "Yöneticiden iste" için ayrıca `docs/SAAS.md` içindeki **Platform
e-postası** bölümüne bakın.

## E-postayı kim gönderir

İki gönderici vardır; uygulama sırayla dener (`lib/application.cjs` → `emailSender`):

1. **Platformun Brevo hesabı** (konsol → Yönetim → E-posta, `lib/saas/platform-email.cjs`). Açıksa
   her zaman bu kullanılır; gönderimler konsolda kayda geçer ve büro başına günlük sınır uygulanır.
2. **Sunucunun kendi SMTP ayarı** (`lib/recovery-email.cjs`). Sunucunun gizli ortam dosyasında
   `BREVO_SMTP_LOGIN`, `BREVO_SMTP_KEY` ve doğrulanmış gönderici adresi `BREVO_FROM_EMAIL`
   tanımlıysa, platform hesabı açık değilken bu kullanılır. Bağlantı `smtp-relay.brevo.com:587`
   üzerinden zorunlu STARTTLS ile kurulur. Anahtar Git'e, yedeklere veya tarayıcıya girmez.

İkisi de yoksa e-posta yolu hiçbir ekranda sunulmaz. Her iki göndericide de e-posta **büronun
kendi adıyla** gider; adres platformun gönderen adresidir.

## Adres doğrulama

Şifre yenileme kodu yalnızca **doğrulanmış** adrese gider. Bir adresi kaydetmek (Hesabım'da ya
da personel kaydında) onu doğrulamaz; adres değişirse doğrulama düşer.

- **Kullanıcı kendisi:** Hesabım → İletişim bilgilerim bölümünde **Doğrulama kodu gönder**'e
  basar, e-postadaki 6 haneli kodu **mevcut şifresiyle birlikte** girer. Şifre, açık kalmış bir
  oturumun tek başına yeni bir adresi kurtarma adresi yapamaması içindir.
- **Yönetici:** Kullanıcı Yönetimi'nde personelin iletişim penceresinden kodu gönderir ve
  personelin okuduğu kodu girer; personelin şifresi sorulmaz (yönetici o hesabın şifresini zaten
  belirleyebilir). CEO hesabını yalnızca CEO yönetir.
- Doğrulama kodu 24 saat geçerlidir, giriş ekranında hiçbir işe yaramaz.
- İlk e-posta kurtarma sürümünde doğrulanan adresler (`recoveryEmail`) doğrulanmış sayılmaya
  devam eder.

## Giriş ekranı

**Şifremi unuttum** ekranında kullanıcı adı, kayıtlı cep telefonu veya doğrulanmış e-posta adresi
yazılır. Büronun açık yollarından ilki denenir; kod gelmezse 30 saniye sonra öteki yollar ve
**Yöneticiden iste** sunulur. E-posta kodu 8 hanelidir, 15 dakika geçerlidir, tek kullanımlıktır
ve beş yanlış denemede kapanır. Hesap başına sınır: günde 3, haftada 6, ayda 12. Var olmayan,
adresi doğrulanmamış veya sınırı dolmuş hesaplar aynı yanıtı alır. Kodlar yalnızca tuzlu özet
olarak saklanır ve yedeklere girmez. Başarılı yenileme mevcut oturumları kapatır.

Gönderim, veritabanı işlemi tamamlandıktan sonra başlar. Hata kaydı kod, adres veya anahtar
içermez.

## SMS ve WhatsApp: canlı test

Büronun **kendi** SMS hesabı ve WhatsApp entegrasyonu, ayarlar kaydedildi diye şifre yenilemede
kullanılmaz. Ayarlar → SMS / WhatsApp içindeki **Şifre kurtarma canlı testi** ile CEO, kayıtlı
ve etkin ayarlarla gerçek bir test mesajı gönderir:

- **SMS:** alıcı gelen 8 haneli kodu ayar ekranına girer.
- **WhatsApp:** alıcı şifre bağlantısı şablonuyla gelen bağlantıyı açar ve **Testi doğrula**'ya
  basar. Hiçbir hesabın şifresi değişmez.

Alıcı teslimi doğrulayınca kanal "Şifremi unuttum" ekranında ve Entegrasyonlar → Şifre Yenileme
bölümünde açılır. Bakiye/bağlantı testi ya da sağlayıcının mesajı kabul etmesi kanalı açmaz.
SMS ve WhatsApp ayrı doğrulanır. Gönderici, kimlik bilgisi veya şifre şablonu değişirse doğrulama
düşer ve yeniden test gerekir. Test kodları/bağlantıları 15 dakika geçerli ve tek kullanımlıdır;
SMS beş yanlış denemede kapanır; kanal başına günde en fazla üç test başlatılabilir. Bekleyen
test özetleri yedeklere girmez; geri yükleme sonrasında testler yenilenir.

Büronun kendi SMS'i açık değilken (ya da henüz test edilmemişken) platformun SMS hizmeti
kullanılabiliyorsa SMS kodu oradan gider. Yöneticinin "Yöneticiden iste" talebine karşılık
SMS ile gönderdiği şifrede sonuç ekranda görüldüğü için canlı test şartı aranmaz.

## Doğrulama

`node --wasm-num-compilation-tasks=1 --liftoff-only --no-wasm-tier-up --test --test-concurrency=1 tests/email-recovery.test.cjs tests/recovery-channels.test.cjs tests/platform-email.test.cjs tests/account-contact.test.cjs tests/sms-recovery-ui.test.cjs tests/sms.test.cjs tests/platform-sms.test.cjs`
