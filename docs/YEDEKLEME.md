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

## Geri yükleme

1. Cloudflare R2 panelinden istenen `.hnb` nesnesini indirin veya yerel `work/backups/` klasöründeki dosyayı seçin.
2. Aynı `BACKUP_ENCRYPTION_KEY` değerini güvenli ortamda bulundurun. Anahtar kaybolursa şifreli yedek çözülemez.
3. Boş bir hedefte `npm run backup:restore -- "YEDEK.hnb"` çalıştırın. `DATABASE_URL` varsa boş PostgreSQL `han_private.han_state` tablosuna aktarır; yoksa boş yerel durum dosyasına yazar. **Mevcut canlı verinin üzerine yazmaz.** Önce ayrı ortamda geri yükleme denemesi yapın.

R2 saklama süresi bu sürümde otomatik silinmez; yaşam döngüsü kuralı ihtiyaca göre ayrıca yapılandırılmalıdır. Supabase'in kendi veritabanı yedekleri ek bir koruma sağlar, ancak Storage API nesnelerini kapsamaz.

Resmî belgeler: [Cloudflare R2 S3 bağlantısı](https://developers.cloudflare.com/r2/get-started/s3/), [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs), [Supabase yedekleri](https://supabase.com/docs/guides/platform/backups).
