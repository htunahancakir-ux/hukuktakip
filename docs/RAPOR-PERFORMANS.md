# Raporlar — 8 Kasım 2026

Rapor merkezi artık tüm çalışma alanını, ekleri ve düzenleme verilerini tarayıcıya yüklemez. Rapor türüne özel parametreli SQL sorguları, 50 satırlık cursor sayfaları ve aynı repeatable-read snapshot içinde tüm seçimin adet/tutar toplamlarını döndürür. Para toplamları kuruş cinsinden metin olarak taşınır; büyük toplamlar tarayıcıda BigInt ile biçimlenir.

Excel, tahsilat/gider/kâr, evrak, müvekkil borçlu bilgisi/ödemeleri, hesap hareketleri, görüşmeler, taksitler, indirimler, kefiller, müvekkil kayıtları ve personel raporları bu akışı kullanır. Müvekkil listesi sayfalıdır; filtre seçenekleri aramayla yüklenir. İNS raporu SQL ile personel bazında özetlenir. Aylık bordro, mevcut dönem kaydını asenkron ve dar veri kapsamıyla okur. Eski yerel dosya modu korunur.

Tahsilat kârında kapanış öncesi ödemeler dönem dışında olsa bile hesaba katılır; iadeler, park komisyonu, transferlerin iki yönü, hariç tutulan hareketler, eski müvekkil ödeme tutarları ve kısmi taksit dağılımı korunur. Liste projeksiyonları düzenlenebilir kayıt önbelleğine eklenmez. Rapor içinden dosya açılırken yalnız seçilen dosya yüklenir.

CSV ve yazdırma tek snapshot üzerinde tüm filtre sonucunu kapsar. Veritabanı cursor'ı 500 satırlık parçalarla okunur ve iptal/hata durumunda bağlantı bırakılır. Vercel'in yanıt boyutu sınırı nedeniyle canlı çıktılar 4 MiB ile sınırlandırılır: sınır aşılırsa eksik dosya verilmez, kullanıcıdan filtreyi daraltması istenir. Çok büyük arşiv çıktıları için ileride ayrı arka plan işi ve nesne depolama akışı gerekir.

## Doğrulama

- Tam test paketi 86/86 geçti; son eklenen büyük çıktı sınırı testi ve rapor kontrolleri ayrıca 3/3 geçti (toplam 87 test).
- Biçim kontrolü ve üretim derlemesi başarılı.
- 10.000 müvekkil + 10.000 evrak sentetik PGlite denemesi: 50 satırlık rapor yanıtı 18.530 bayt, CSV 10.000 kayıt / 1.626.821 bayt. İki rapor sayfası ve tüm CSV toplam yaklaşık 5,94 saniye; eşzamanlı diğer testlerin de çalıştığı yerel ölçümdür, üretim kapasitesi garantisi değildir.
- Tarayıcıda sayfa geçişi, tüm kayıtların toplamı, ilk sayfa dışındaki müvekkil filtresi, 123 kayıtlık CSV indirme, İNS, müvekkil listesi ve aylık bordro kontrol edildi.
- Canlı verilerde salt okunur eski/yeni sonuç karşılaştırması: 12 rapor türünün tüm satırları eşleşti (124 tahsilat, 68 evrak, 33 taksit, 35 indirim, 3 kefil, 2 görüşme, 41 müvekkil, 14 personel dahil).
- 8 Kasım 2026 03:58 Türkiye saati R2 yedeği ayrı boş veritabanına geri yüklenerek doğrulandı.
- `20261108003603_report_queries.sql` yalnız özel şemaya tarih yardımcı fonksiyonu ve üç indeks ekler. İş verilerinin geçiş öncesi/sonrası içerik özetleri aynı kaldı. Yeni fonksiyon PUBLIC erişimine kapalıdır.

Genel toplamlar SQL tarafında ilgili kayıtların tamamı üzerinde hesaplanır; bütün dönemleri kapsayan çok büyük raporlarda tarama maliyeti sürer. Bu aşama raporlardır; muhasebenin işlem ekranı, mesajlar ve hatırlatmalar henüz uyumluluk yüklemesinden ayrılmamıştır.
