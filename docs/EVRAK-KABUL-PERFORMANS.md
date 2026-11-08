# Evrak Kabul — 8 Kasım 2026

Evrak listesi 50 kayıtlık cursor sayfalarıyla açılır. Müvekkil araması en fazla 50 eşleşme döndürür; seçilmiş kişi ilk sayfada olmasa da korunur. Adet ve tutar, ekrandaki 50 satırdan değil, aynı filtreye uyan bütün kayıtlardan hesaplanır.

Yeni evrak numarası `han_data.document_sequences` üzerinden kayıtla aynı transaction içinde atanır. Aktif ve arşiv evrakları ile eski ayrılmış numaralar başlangıç değerine dahildir. Mevcut numaralar değiştirilmez; tarihsel mükerrer numaralar silinmez. İçe aktarma/geri yükleme trigger'ları sayacı ilerletir. Serialization/deadlock hatası yalnız tamamen geri alınmış işlem için sınırlı yeniden deneme yapar; kullanıcı düzenleme çakışması 409 döner.

Evrak düzenleme tek kayıt ve ilişkili geçmişi yükler; kaydetme yalnız değişen alanları gönderir. SQL kimlik kontrolleri sayfa dışındaki kayıtları da kapsar. Finansal hareketi olan dosyanın tutar/vade koruması sürer. Liste, müvekkil seçimi ve teslim grubu için gelen kısa yanıtlar düzenlenebilir kayıt önbelleğine karıştırılmaz.

Teslim grubu kimlikleri yenilemede korunur; tutanak için gerekli alanlar en fazla 100 evraklık isteklerle alınır. Ek evrak formunda ortak alanlar zorunlu alan kontrolünden önce aktarılır. Aynı kimlikle ilişkili dosyalar sayfalı sorgulanır; zincir işlemi yalnız iki dosyayı yükler.

## Doğrulama

- `npm test`: 84/84 test ve mevcut iş kuralı kontrolleri geçti.
- `npm run format:check` ve `npm run build` başarılı.
- `npm run test:record-scale`: 10.000 müvekkil + 10.000 evrak; 50 evraklık yanıt 19.881 bayt, toplamlar bütün kayıtları kapsıyor. Yerel PGlite ölçümüdür, üretim kapasitesi garantisi değildir.
- Ayrı sentetik tarayıcı ortamında yeni kayıt, ikinci evrak, numaralandırma, zincir, düzenleme, yenileme sonrası teslim grubu ve tutanak doğrulandı.
- Yayın öncesi R2 yedeği: 8 Kasım 2026 03:16 (Türkiye); 41 müvekkil, 68 aktif evrak ve 189 audit satırı ayrı boş veritabanında doğrulandı.
- Eklemeli `20261107235838_intake_document_numbers.sql` geçişinden sonra müvekkil, evrak, arşiv, finans hareketi, muhasebe, görüşme ve ek tablolarının içerik özetleri aynı kaldı. 41 müvekkil, 68 aktif / 2 arşiv evrak ve 124 finans hareketi korundu.

Bu aşama Evrak Kabul akışını kapsar. Raporlar, muhasebe ve diğer uyumluluk ekranlarının tamamı henüz sayfalı repository akışına taşınmış değildir. Tek dosyanın düzenleme bağlamı hâlâ o dosyanın ilişkili geçmişini yükler.
