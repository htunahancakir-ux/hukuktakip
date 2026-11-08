# Müvekkil ödeme listesi ve ödeme kaydı — 8 Kasım 2026

Liste `/api/records/client-payouts` üzerinden 50 kayıtlık imleçli sayfalarla gelir. Sayfa ve filtreye uyan bütün dosyaların hak ediş/ödenen/kalan toplamları aynı repeatable-read işleminde hesaplanır. Toplamlar yalnız görünür 50 dosyayı kapsamaz. Raporlarla aynı hak ediş ve eski ödeme formülleri kullanılır; büyük toplamlar metin/BigInt ile taşınır. İnfaz, kapanmış borçlu bakiyesi ve pozitif müvekkil alacağı koşulları korunur. Dosya sırası sayısal tutulur; imleç filtreye bağlıdır.

Müvekkil araması en fazla 50 sonuç getirir. Ödeme formu `/api/records/client-payout?id=...` ile yalnız seçilen dosyanın özeti, müvekkilin ödeme bilgileri, hesap seçenekleri ve güncel bakiyeleri alır. Liste ve form projeksiyonları düzenlenebilir veri önbelleğine eklenmez. Filtreler, sayfa değişimi ve geç gelen yanıtlar birbirinin üzerine yazmaz.

Mevcut `/api/client-payout` işlemi CEO/yönetici yetkisi, oturum ve CSRF kontrolünü korur. Veritabanından yalnız seçilen dosya/müvekkil, o dosyanın mali hareketleri ve muhasebe kayıtları yüklenir. Hesap bakiyesi bütün hesap geçmişinden hesaplanır; istemcinin gönderdiği bakiye kullanılmaz. Dosya ve hesap satırları kilitlenir; işlem serializable düzeyinde çalışır. Yalnız geri alınmış serialization/deadlock hataları en fazla iki defa yeniden denenir.

Aynı istek kimliği ve içerikle tekrar gönderilen başarılı ödeme ikinci kez yazılmaz. Aynı kimliğin farklı ödeme için kullanımı reddedilir. Ödeme ve audit aynı işlemde tamamlanır; veritabanı hatasında ikisi de geri alınır. Yanıt yalnız commit sonrasında gönderilir. Ödeme sonrası bakiye yeniden denetlenir. Ön yüzde çift tıklama engellenir; ağ hatasından sonra form açık ve istek kimliği aynı kalır.

Doğrulama kapsamı: 123 sentetik dosyada 50+50+21 sayfalama, tüm kayıt toplamları, Türkçe/metin/tarih/tutar filtreleri, yetki reddi, SQL girdisi, XSS, kısmi/tam ödeme, fazla ödeme, yetersiz hesap bakiyesi, aynı istekle tekrar, çakışan HTTP istekleri, hata sonrası geri alma ve serialization yeniden denemesi. İlgisiz dosyaların gövdeleri/sürümleri ile 123 eki korundu. PGlite tek bağlantıyı sıralar; bu testler üretimde çok bağlantılı yük testi yerine geçmez.

Canlı verilerde salt okunur PostgreSQL karşılaştırması: 68 dosyanın 50 uygun ödeme kaydında eski ve yeni hak ediş/ödenen/kalan tutarları birebir eşleşti. Yerel tarayıcıda 123 dosya, ikinci sayfa, sabit genel toplam, seçilen ödeme formu ve kasa/bankaya dönüş kontrol edildi; konsol hatası görülmedi. Bu kontrolde canlı ödeme oluşturulmadı. Şema geçişi veya mevcut iş verisinde değişiklik gerekmedi.

Kalan sınır: genel kasa/banka hareketi yazma yolu hâlâ uyumluluk görünümünü kullanır. Liste toplamları ve güncel hesap bakiyeleri SQL üzerinden bütün ilgili geçmişi tarar; çok büyük hacimlerde artımlı özetler ve gerçek PostgreSQL yük testi ayrıca ele alınmalıdır.
