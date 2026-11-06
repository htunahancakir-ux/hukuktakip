# Şifreli yedekleme

Yönetici, uygulamadaki **Ayarlar → Yedekleme** bölümünden otomatik yedeklemeyi açar ve günlük, 7 günlük veya 30 günlük aralığı seçer. **Şimdi Yedekle** düğmesi aralık beklemeden kopya alır. Durum ekranında son başarılı R2 ve yerel kopyanın zamanı ayrı gösterilir.

## Yapılandırma

Cloudflare R2'de `hanhukuktakip` adlı özel bir kova ve yalnızca bu kovaya erişen **Object Read & Write** Account API Token kullanılır. Uygulamanın sunucu ortamında şu değerler gerekir:

| Değişken | İçerik |
| --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare hesap kimliği |
| `R2_BUCKET_NAME` | `hanhukuktakip` |
| `R2_ACCESS_KEY_ID` | R2 tokenının S3 Access Key ID değeri |
| `R2_SECRET_ACCESS_KEY` | R2 tokenının S3 Secret Access Key değeri |
| `BACKUP_ENCRYPTION_KEY` | 32 baytlık anahtarın 64 karakterli hex gösterimi |
| `CRON_SECRET` | Yalnızca Vercel üretim ortamında gereken rastgele zamanlayıcı anahtarı |

Gizli değerleri GitHub'a koymayın. Yerel sunucu `.env.local` dosyasını okuyabilir; bu dosya Git tarafından dışlanır. Vercel'de değişkenleri yalnızca sunucu tarafı production ortamına ekleyin. Tarayıcıya anahtar gönderilmez.

Yedek, uygulama durumunun tamamını (kullanıcı parola hashleri ve evrak ekleri dahil) gzip ile sıkıştırır ve AES-256-GCM ile şifreler. Yerel sunucu aynı dosyayı `work/backups/` klasörüne yazar; Vercel'de kalıcı dosya sistemi olmadığı için kopya R2'ye gider. Nesne adı `hanhukuk/` öneki altındadır. R2 yükleme başarısız olursa Ayarlar'da son başarılı yedek tarihi ilerlemez.

Vercel Cron her gün **03.00 UTC / 06.00 Türkiye saati** için yapılandırılmıştır. Seçilen aralık dolmadıysa o gün işlem atlanır. Yerel sunucu 15 dakikada bir aralığı denetler. İlk otomatik yedek, etkinleştirmeden sonraki ilk kontrolde alınır; istenirse hemen manuel yedek alınabilir.

## Bilgisayara indirme ve geri yükleme

1. CEO hesabıyla giriş yapın. **Ayarlar → Yedekleme → Yedek Dosyaları** bölümünde ayı ve istediğiniz yedeği seçip **İndir (.hnb)** düğmesine basın. Tarihler Türkiye saatiyle görünür; ay filtresi dosyanın UTC tarihine göre çalışır.
2. İndirilen `.hnb` dosyası şifrelidir. Aynı `BACKUP_ENCRYPTION_KEY` değerini güvenli ortamda bulundurun. Anahtar kaybolursa yedek açılamaz.
3. Proje klasöründe terminali açın ve aşağıdaki komutta indirilen dosyanın yolunu kullanın. İstendiğinde yedekte kayıtlı, etkin CEO hesabının kullanıcı adını ve yedek tarihindeki şifresini girin. Şifre terminalde görünmez.

```powershell
npm run backup:restore -- "C:\Users\Kullanici\Downloads\YEDEK.hnb" --local "work/kurtarma/hanhukuk-state.json"
```

`--local` komutu mevcut bir veritabanı bağlantısı tanımlı olsa bile yeni bir yerel dosyaya yazar. Hedef dosya zaten varsa işlem durur. Bir kurtarma ortamında PostgreSQL'e aktarmak için `--local` seçeneğini çıkarıp `DATABASE_URL` değerini boş hedefe yönlendirin; hedefte uygulama kaydı varsa işlem yine durur. Önce ayrı ortamda yedeği doğrulayın.

Yeni canlı ve yerel yedekler R2'de ayrı klasörlerde tutulur. Bu sürümden önceki son kayıtlı kopya listede görünür; kaynak bilgisi bulunmayan daha eski kopyalara Cloudflare R2 panelinden erişilebilir.

R2 saklama süresi bu sürümde otomatik silinmez; yaşam döngüsü kuralı ihtiyaca göre ayrıca yapılandırılmalıdır. Supabase'in kendi veritabanı yedekleri ek bir koruma sağlar, ancak Storage API nesnelerini kapsamaz.

Resmî belgeler: [Cloudflare R2 S3 bağlantısı](https://developers.cloudflare.com/r2/get-started/s3/), [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs), [Supabase yedekleri](https://supabase.com/docs/guides/platform/backups).
