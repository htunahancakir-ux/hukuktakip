# Muhasebe hareket listesi — 8 Kasım 2026

Kasa/banka hareketleri `/api/records/accounting` üzerinden 50 satırlık sayfalarla yüklenir. Tarih, hesap, işlem türü, kullanıcı, gider kalemi ve metin filtreleri sunucuda uygulanır. Tarih/oluşturulma zamanı/kimlik imleci aynı tarihli satırları atlamaz; filtre değişince ilk sayfaya dönülür.

Hesap bakiyeleri tüm geçmişi, giriş/çıkış/net toplamları filtreye uyan bütün hareketleri kapsar. Sayfa, toplamlar ve bakiyeler aynı salt okunur repeatable-read işleminde hesaplanır. Para toplamları metin olarak taşınır ve BigInt ile gösterilir. Hareket, rapor ve bakiye sorguları ortak SQL tanımı kullanır; transferin iki yönü ve excludedFinanceIds aynı şekilde uygulanır. Eski nakit işlem doğrulaması da hariç tutulan hareketleri bakiyeye eklemez.

Liste yalnız CEO/yöneticiye açıktır. Personelin izinli para giriş/çıkış ekranı korunur. Liste projeksiyonları düzenleme önbelleğine yazılmaz; yalnız hesap yapılandırması yenilenir. Geç gelen yanıtlar başka ekranın veya yeni filtrenin üzerine yazamaz. Kullanıcı filtresi en fazla 200 ad önerir; öneride olmayan tam ad da yazılabilir.

Doğrulama: 89 test, biçim kontrolü ve üretim derlemesi geçti. Gerçek PostgreSQL uyumlu PGlite testlerinde filtreler, transferler, hariç tutma, eşit tarihler, SQL girdileri, yetkiler, XSS ve tam toplamlar kontrol edildi. Canlı veriler salt okunur işlemle karşılaştırıldı: 124 hareket ve 7 hesap birebir eşleşti. Yerel tarayıcıda 123 satır, sayfa değişimi, ödeme ekranına geçiş ve geri dönüş doğrulandı. 10.000 sentetik hareket denemesinde 50 satır 10.441 bayt; iki sayfa yaklaşık 207 ms. Bu yerel ölçüm üretim kapasitesi garantisi değildir.

Şema veya iş verisi değişikliği yoktur. Müvekkil ödeme listesi ve ödeme kaydı sonraki aşamada dar kapsamlı sorgulara taşınmıştır; ayrıntılar [Müvekkil ödeme performans notunda](MUVEKKIL-ODEME-PERFORMANS.md). Genel kasa/banka hareketi yazma işlemleri, mesajlar ve hatırlatmalar sonraki aşamalardandır. Toplamların SQL tarama maliyeti veri büyüdükçe ayrıca izlenmelidir.
