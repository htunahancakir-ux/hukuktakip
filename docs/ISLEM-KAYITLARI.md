# İşlem Kayıtları ve kod düzeni

CEO ve Admin, **Ayarlar → İşlem Kayıtları** veya **Kullanıcı Yönetimi → İşlem Kayıtları** üzerinden aynı kayıtları görür. Kayıt işlemleri, başarılı girişler, açıkça yapılan çıkışlar ve hatalı girişler ayrı sekmelerdedir. Tarih ve saatler Türkiye saatinde gösterilir. Kayıtlar bu sürümden itibaren oluşur; tarayıcıyı kapatmak bir çıkış işlemi sayılmaz.

İşlem kaydı; hesabı, zamanı, bölümü, işlem türünü ve varsa kayıt referansı ile değişen alanların adını içerir. Alan değerleri, evrak içeriği, oturum anahtarları ve parolalar loga yazılmaz. Başarısız girişlerde, denenen kullanıcı adı mevcut bir hesaba aitse o hesap gösterilir. Yönetici yedek indirdiğinde dosya ve hesap kaydedilir.

Canlıda kayıt değişiklikleri ve bunlara ait log aynı PostgreSQL işlemi içinde yazılır. Audit tablosu uygulamanın özel şemasındadır ve uygulama yedeklerinden ayrıdır. Yerel dosya modunda log, durum dosyasının yanındaki `audit-events.jsonl` dosyasına eklenir. Şema kurulumu için `npm run db:migrate` kullanılır.

Sunucu giriş noktası `lib/application.cjs`, oturum ve veri kuralları `outputs/icrapro/access-server.cjs`, uçlar ise `access-accounts.cjs`, `access-documents.cjs`, `access-workflow.cjs`, `access-communications.cjs`, `access-personnel.cjs` ve `access-data.cjs` dosyalarındadır. Tarayıcı modüllerinin yükleme sırası `outputs/icrapro/workspace-assets.js` dosyasındadır. Derleme ve yerel sunucu bu listeyi kullanır.

`npm test` yetki, oturum, arama, kayıt, yedekleme ve geri yükleme senaryolarını çalıştırır. `npm run format:check` ayrılan modüllerin biçimini denetler.
