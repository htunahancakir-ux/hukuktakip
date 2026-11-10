# Ortak masraf avansı

Muhasebe ekranındaki **Masraf Avansı Oluştur** işlemi, seçilen kasa veya bankadan para çıkarır ve tamamını işlem tarihinde **Masraf** gideri olarak kaydeder. Aynı tutar ortak avans havuzuna eklenir. **Avans Hareketleri** ekranında toplam giriş, dosyalara dağıtılan tutar ve kalan bakiye görülür.

Borçlu dosyasının Masraf sekmesinde kaynak olarak **Masraf Avansı (Ortak Havuz)** seçilebilir. **Masrafı Borca Ekle** dosyanın borcunu artırır; **Borca Eklemeden Kaydet** borcu değiştirmez. Her iki işlem havuz bakiyesini azaltır, ama yeni bir kasa hareketi veya ikinci bir gider oluşturmaz. Kaynak olarak normal bir kasa seçilirse eski işlem kuralları geçerlidir.

Her hareketin tarihi, açıklaması ve işlemi yapan kullanıcı saklanır. Havuz için yeterli bakiye olmayan veya işlem tarihindeki havuzu eksiye düşüren dağıtımlar reddedilir. İstek kimlikleri tekrarlandığında aynı işlem iki kez kaydedilmez. Silme panelindeki yetkili hesap, dağıtımı silerek havuza geri alabilir. Avans girişi, silindiğinde havuz geçmişini eksiye düşürecekse silinemez; önce ilgili dağıtımlar düzeltilmelidir. Silinen kayıtlar mevcut işlem arşivinde saklanır.

Veri, mevcut muhasebe hareketleri ve dosya finans hareketlerinde tutulur; yeni bir veritabanı tablosu gerekmez. Avans girişleri `expensePoolFunding`, dağıtımlar `expensePoolAllocation` işareti taşır. Sunucu genel kayıt düzenleme yolundan bu işaretli hareketlerin değiştirilmesini reddeder. Kayıt deposu işlemleri seri hale getirilebilir işlemlerle çalışır; eşzamanlı çakışmalar geri alınır ve gerektiğinde yeniden denenir.

## Faiz ve avukatlık ücreti

CEO ve yöneticiler, tahsilat alınmış olsa da infaz edilmemiş bir dosyada faiz ve avukatlık ücretini değiştirebilir. Personel ve infaz edilmiş dosyalar için değişiklik engellenir. Tahsilat varsa yeni toplam borç, alınmış tutardan yüksek kalmalıdır; böylece bir tutar değişikliği mevcut tahsilatı kapanış işlemi olarak geriye dönük değiştirmez. Otomatik yasal hesaplama ve yediemin belgeleri için mevcut kurallar ayrıca geçerlidir.
