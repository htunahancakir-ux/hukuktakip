# VoIP ve şifreli görüşme arşivi

## Uygulama akışı

- Ayarlar → Entegrasyonlar → VoIP / Telefon: CEO, Verimor API anahtarını, santral kimliğini, dış numarayı ve kullanıcı dahililerini yönetir. Diğer sağlayıcılar `lib/voip.cjs` içindeki adapter sözleşmesine eklenir; bu sürümde Verimor uygulanmıştır.
- Ayarlar → Yetkilendirme: CEO/yönetici, personelin yalnızca güncel sorumluluğundaki dosyaları dinlemesine izin verebilir veya izni kaldırabilir. Atama her istekte yeniden kontrol edilir. Personel doğrudan kayıt URL'sini çağırarak izni aşamaz. İndirme CEO/yöneticiye ayrılmıştır.
- Borçlu Föyü → Ara: her numaranın son arama tarihi, arayan personeli, süresi, teknik durumu ve görüşme sonucu birlikte görünür. Aynı numara farklı föylerde bulunursa arama geçmişi eşleştirilir; ayrı numaralar aynı kişi varsayılmaz.
- Aktif çağrıda not yazılabilen görüşme paneli ve kırmızı Aramayı Sonlandır düğmesi bulunur. Not 800 ms yazma molasında sunucuya taslak olarak kaydedilir; durum sorguları metin alanını yeniden oluşturmaz. Küçült arayüz işlemidir; santralden teyit alınmadan çağrı sonlanmış sayılmaz. Teyitten sonra aynı panelde sonuç seçenekleri ve Tamam açılır. Meşgul/Ulaşılamadı santral sonucuna göre önceden seçilir; personel değerlendirmeleri teknik durumdan ayrıdır. Tekrar Aranacak için gelecek tarih/saatli arama planı, Ödeme Sözü Alındı için tarih/tutar/açıklamalı ödeme sözü gerekir. Sonuç/not düzeltmesi borçlu föyünün arama geçmişinden yapılır.
- Görüşme Kayıtları: CEO/yönetici, müvekkil/föy/borçlu/numara/personelle arama yapar; tarih, çağrı durumu ve görüşme sonucu filtreleri ve 50 kayıtlık sayfalar kullanılır. Bu ekran görüntüleme/dinleme içindir; sonuç düzenlemesi içermez. Ses yalnızca Dinle'ye basıldığında yüklenir. Yetkili personele Dinle kendi dosyasının geçmişinde görünür.

## Canlıya almadan önce

1. `npm ci`, `npm run db:migrate`, `npm run build` çalıştırılır. `003-voip.sql` ayrı çağrı/config/yetki tablolarını ve indekslerini oluşturur. Üretim Supabase veritabanına bu migration uygulandı; yeni ortamlarda ayrıca çalıştırılmalıdır.
2. `VOIP_ENCRYPTION_KEY` 32 baytlık rastgele anahtarın 64 haneli hex karşılığıdır. Yoksa mevcut `AI_ENCRYPTION_KEY`, sonra `BACKUP_ENCRYPTION_KEY` kullanılır; ayrı HKDF bağlamları API anahtarı ve ses şifrelemesini ayırır. Anahtarı güvenli bir yerde ayrıca yedekleyin ve arşivin ömrü boyunca koruyun. Eski kayıtlar yeniden şifrelenmeden anahtar değiştirilmemelidir.
3. Bulutta `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` tamamlanır. Kova özel olmalı; `gorusme-kayitlari/` altında 5 yıldan önce silen bir yaşam döngüsü kuralı olmamalıdır. Bulutta geçici diske kayıt düşülmez. Yerel kullanımda şifreli dosyalar `work/voip/gorusme-kayitlari/` altında tutulur.
4. Üretimde `VOIP_CRON_SECRET` tanımlanır; aynı değer Supabase Vault'ta `hanhukuk_voip_cron`, uygulamanın HTTPS kökü `hanhukuk_voip_origin` adıyla tutulur. `supabase/cron/voip-workers.sql` iki görevi dakikada bir çalıştırır. Arşiv işi en fazla iki kayıt, transkripsiyon işi en fazla üç kısa iş/parça işler. HTTP kimlik doğrulama `Authorization: Bearer …` kullanır; görev anahtarı tarayıcıya gönderilmez. Mevcut `CRON_SECRET` yedekleme için korunur ve uyumlu alternatif zamanlayıcılar için geçerlidir. Tarayıcının veya kişisel bilgisayarın açık kalmasına dayanılmaz; Vercel yapılandırmasında yalnızca günlük yedekleme görevi bulunur.
5. Verimor'da dahililerin görüşme kaydı açılır, web telefonu kullanılacaksa her dahiliye personel hesabı atanır. CEO bağlantı ekranını doldurur. Üretilen gizli URL, Verimor CRM entegrasyonunda çalma/cevaplama/kapanma bildirimlerine tanımlanır; santral `domain_id` değeri eşleşmelidir.
6. Gerçek hesapta bir gelen webhook, iki tarafın sesinin bulunduğu örnek kayıt, tarayıcı mikrofonu/web telefonu ve arama/sonlandırma akışı test edilir. Henüz gerçek Verimor hesabıyla doğrulama yapılmadı. Önizleme yalnızca sentetik verileri ve sahte santral yanıtlarını kullanır.

## Saklama, performans ve kurtarma

Ses dosyası uygulama veritabanına veya tarayıcı depolamasına yazılmaz. Veritabanında indeksli metadata; özel R2 kovasında rastgele çağrı kimliğiyle adlandırılmış AES-256-GCM şifreli nesne tutulur. Nonce her dosyada rastgeledir. Oynatma sırasında yetki yeniden kontrol edilir, GCM etiketi doğrulanır ve ses uygulamanın korumalı medya ucundan sunulur; kalıcı herkese açık bağlantı üretilmez. HTTP byte-range desteği vardır. Aktarım sırasında HTTPS kullanılır.

Kaynak MP3 yeniden kodlanmaz/sıkıştırılmaz; SHA-256 özeti, boyutu, arşivlenme zamanı ve 5 yıl sonraki `retainUntil` saklanır. İndirilen dosyanın adı müvekkil, föy, İstanbul tarih-saat, telefon, personel ve benzersiz çağrı kimliğini içerir. Nesne anahtarına kişisel bilgiler konulmaz. Otomatik silme yapılmaz; saklama süresinin sonunda silme politikası ayrıca uygulanmalıdır.

Webhook ses indirmesini beklemez. Arşiv işi veritabanında kalır; yarım kalmış bir iş iki dakika sonra yeniden alınabilir, başarısız indirmeler artan aralıklarla tekrar denenir. Kayıt gecikirse tamamlanmış çağrının CDR'ı da kontrol edilir. 24 saat sonra hâlâ kayıt yoksa manuel inceleme gerekir; diğer işler ilerlemeye devam eder. Yönetici Durumu Doğrula/Arşivlemeyi Yeniden Dene ile tekrar kontrol edebilir. Bu sürüm, uygulama üzerinden başlatılan çağrıları eşleştirir; santralden bağımsız başlatılan çağrıları otomatik içe aktarma kapsam dışındadır.

Arama rezervasyonu, sağlayıcı isteğinden önce ayrı transaction'da yazılır. Telefon ve kullanıcı için aktif çağrı benzersiz indeksleri ile istek kimliği tekrarı kontrolü bulunur. Sağlayıcı çağrısı transaction dışında yapılır ve otomatik tekrar aranmaz. Belirsiz ağ hatası yeniden aramayı engeller; santralden doğrulama gerekir.

Ayda 10.000 dakika, 60 ayda 600.000 dakikadır. Kaynağın gerçek bit hızına bağlı örnek kapasite: 32 kbit/sn için yaklaşık 144 GB, 64 kbit/sn için yaklaşık 288 GB (ondalık GB, yedek kopyalar hariç). Bu rakamlar Verimor kalite beyanı değildir. Gerçek dosyaların boyutuyla kapasite hesabı güncellenmelidir. Tek kayıt için 64 MiB sınırı ve işlem başına en fazla iki arşiv işi bellek kullanımını sınırlar. Daha büyük tekil görüşmeler için akış/multipart aktarımı genişletilmelidir.

Çağrı metadata'sı, bağlantı ayarları ve yetkiler mevcut şifreli uygulama yedeklerine dahildir. Ses nesneleri R2'de bağımsız saklanır; uygulama yedeği tek başına ses nesnelerinin yedeği değildir. Üretim kurulumu nesneler için ikinci bir şifreli kopya/yedek politikası da sağlamalıdır.

## Birleşik görüşme geçmişi ve AI transkripsiyonu

Telefon aramaları ile elle girilen görüşmeler borçlu föyünde tarih sırasıyla ve 50 kayıtlık sayfalarla birlikte görünür. Telefon sonuçlarının ortak görüşme tablosundaki karşılığı `voipCallId` ile ilişkilidir; düzenlemek ikinci bir görüşme oluşturmaz. PostgreSQL'de görüşme, tekrar arama planı, ses kaydının not/sonucu ve özet aynı transaction'da kaydedilir. Özet, elle girilen notları ve telefon görüşmesinin personel notunu/sonucunu birleştirir; aynı çağrıyı iki kez saymaz. AI transkripti personel notunu değiştirmez ve otomatik olarak bu özete katılmaz.

Yapay Zeka ayarlarında ses çözümleme modeli özet modelinden ayrıdır. Aynı sağlayıcı/kimlik bilgileri kullanılır. Gateway için güncel AI SDK 7 transkripsiyon API'si, OpenAI ve uyumlu özel sağlayıcılarda `/audio/transcriptions` kullanılır. Özel sağlayıcının bu ses uç noktasını desteklemesi gerekir; Gateway ses özelliğinin hesapta açık olması gerekir. Sağlayıcı/model hatası açıkça gösterilir; sahte veya yerel üretilmiş transkript kullanılmaz.

Görüşme Kayıtları'nda tek kayıt, seçilenler, uygulanmış filtreler veya tüm uygun ses kayıtları kuyruğa alınabilir. Tamamlanan kayıtlar yeniden işlenmez. Ses arşivlenmemişse işlem arşivi bekler. Kuyruk veritabanında kalır, üretimde Supabase zamanlayıcısı tarafından dakikada bir ve yerel sunucuda 30 saniyelik görevle sürdürülür. En fazla bir geçerli worker kiralaması vardır; kesilmiş/belirsiz sağlayıcı isteği otomatik tekrar ücretlendirilmez, hata olarak bırakılır ve kullanıcı yeniden denemeyi seçer. Kısmi tamamlanan parçalar aynı model/ayarlarla yeniden denemede korunur.

Ses sıkıştırılmaz veya yeniden kodlanmaz. 20 MiB üzerindeki MP3, kare sınırlarında kayıpsız olarak bölünür. Parça metinleri ve birleşik AI transkripti aynı AES-256-GCM nesne arşivinde ayrı rastgele kimliklerle saklanır; veritabanında sadece durum/model/ilerleme/nesne kimliği bulunur. Personel notu ve AI transkripti ayrı açılır. Transkript erişimi de her istekte güncel ses dinleme yetkisini kontrol eder. Ses dosyaları ve AI metin nesneleri için R2 yedek politikasının birlikte uygulanması gerekir.

## Hızlı erişim ve İnfaz

R2 kalıcı şifreli arşivdir. Yakın tarihli (son 30 gün) ve İnfaz olmamış dosyaların sesleri arşivleme sırasında ayrıca sunucunun şifreli geçici önbelleğine alınır. Önbellek 256 MiB/256 nesne ile sınırlıdır; en eski kullanılan kopyalar elenir ve 24 saatlik kullanılmayan kopyalar temizlenir. Bu katman kalıcı saklama garantisi değildir; sunucu yeniden başlasa dahi R2 asılları korunur. Tarayıcı listeyi açarken ses indirmez.

Dinleme isteğinde dosyanın güncel durumu okunur. İnfaz dosyasının önbellek kopyası kullanılmaz ve o sunucudaki kopya kaldırılır; ses şifreli R2 arşivinden istek üzerine yüklenir. Diğer sunucularda kalmış geçici kopyalar da durum denetimi nedeniyle sunulmaz ve önbellek temizliğiyle elenir. Arşiv sesleri Verimor'dan tekrar alınmasına veya sağlayıcının saklama süresine bağımlı değildir.
