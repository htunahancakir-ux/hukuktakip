# UYAP ve Banka Entegrasyonu Yol Haritası

Bu belge bir plandır; burada anlatılanların hiçbiri henüz uygulanmadı. Amaç, iki entegrasyonun hangi sırayla, hangi ön koşullarla ve hangi mevcut yapı taşlarıyla kurulacağını kararlaştırmaktır.

Her iki entegrasyon için öneri aynıdır: önce **dosyadan içe aktarma** (kullanıcının indirdiği dosyayı yüklemesi), sonra **canlı bağlantı**. İlk adım dış bağımlılık ve lisans gerektirmez, veri modelini oturtur ve ikinci adımın eşleştirme mantığını aynen kullanır.

## Bugünkü durum

| Konu | Hazır | Eksik |
| --- | --- | --- |
| UYAP | Dosyada icra dairesi ve icra dosya numarası; ilam için mahkeme, esas no, karar tarihi; Derdest → İcra geçişi ve geçmişi | Takip türü alanı, safahat (dosya olayları) kaydı, UYAP dosyası okuyucu, canlı bağlantı |
| Banka | Banka hesabı ve IBAN kaydı; yinelenmeyen kasa hareketi kaydı (`/api/cash-entry`); hesap bazında hareket ve bakiye | Harekette dekont / dış referans alanı, ekstre içe aktarma, mutabakat ekranı, banka bağlantısı |
| Ortak altyapı | Büro başına şifreli kimlik bilgisi (`lib/iyzico-settings.cjs` kalıbı), ayar sekmesi, modül kapısı (`lib/saas/module-gate.cjs`), ürün kataloğu, işlem kayıtları | Bürolar arasında dolaşan zamanlanmış iş, kuyruk, Excel / XML okuma kütüphanesi |

`outputs/icrapro/workflow.js` içindeki eski "İcra / UYAP Bilgileri" ekranı uygulamaya yüklenmiyor; yeni çalışma ona dayanmamalı.

## Ortak ön koşullar

1. **Zamanlanmış işlerin büro kapsamına alınması.** Bugünkü zamanlanmış işler tek adrese istek atıyor ve yalnız ilk büroyu görüyor (`docs/SAAS.md`, kalan işler). Otomatik veri çekme, her büro için ayrı çalışan bir iş gerektirir. Canlı bağlantı adımlarının ikisi de buna bağlıdır; içe aktarma adımları bağlı değildir.
2. **Çalışma sınırları.** Tek sunucu işlevi, 120 saniye süre, 4 MiB istek gövdesi, kuyruk yok. Büyük dosyalar parça parça yüklenmeli, çekme işleri küçük partilerle ve kaldığı yerden devam ederek çalışmalı (VoIP arşiv işi örnek alınabilir).
3. **Dosya okuma kütüphanesi.** Depoda Excel, XML veya ZIP okuyan kütüphane yok. Seçilecek kütüphane sunucuda çalışmalı ve yüklenen dosyayı güvenilmeyen girdi olarak işlemeli (boyut sınırı, makro ve dış bağlantı yok).
4. **KVKK.** İçe aktarılan veriler kişisel veri içerir. Yüklenen ham dosya saklanmamalı ya da şifreli ve süreli saklanmalı; içe aktarma işlemi işlem kayıtlarına yazılmalı; ekranda maskeleme kuralları (`privacy-mask.js`) yeni alanlara da uygulanmalı.

## UYAP

### 1. adım: dosyadan içe aktarma

Kullanıcı, UYAP Avukat Portal'dan indirdiği dosya listesini veya safahat dökümünü uygulamaya yükler.

- **Veri modeli:** dosyaya `takip türü` alanı; dosyaya bağlı `safahat` kayıtları (tarih, işlem, açıklama, kaynak dosya, içe aktarma kimliği). Safahat ayrı tabloda tutulmalı, dosya gövdesine gömülmemeli.
- **Eşleştirme:** icra dairesi + icra dosya numarası ile. Eşleşmeyen satırlar için "dosyayı seç" veya "atla"; hiçbir satır kendiliğinden yeni dosya açmamalı.
- **Tekrar yükleme:** aynı safahat satırı ikinci kez yüklenirse yinelenmemeli (dosya + tarih + işlem özeti üzerinden).
- **Ekran:** yükleme, önizleme (eşleşen / eşleşmeyen / zaten kayıtlı), onay. Föyde "Safahat" sekmesi.
- **Yetki:** içe aktarma yönetici işi; safahatı görme dosyayı görebilen herkese açık.
- **Önce yapılacak:** Avukat Portal'ın bugün hangi dökümleri hangi biçimde (Excel, UDF, PDF) verdiği büroda gerçek bir hesapla doğrulanmalı; okuyucu buna göre yazılır.

### 2. adım: canlı bağlantı

UYAP'a erişim avukatın e-imza, mobil imza veya e-Devlet oturumuyla yapılır. Üçüncü taraf uygulamalar için herkese açık bir servis bulunduğu bilinmiyor; bu doğrulanmadan tasarıma başlanmamalı.

- **Seçenek A, resmî entegrasyon:** Adalet Bakanlığı veya baro üzerinden sunulan bir kurumsal erişim varsa tercih edilir. Araştırılacak ilk konu budur.
- **Seçenek B, tarayıcı eklentisi:** avukatın kendi oturumunda, kendi bilgisayarında çalışan ve yalnız görüntülediği dosyaların bilgisini uygulamaya aktaran eklenti. Sunucu UYAP'a hiç bağlanmaz, e-imza sunucuya gelmez.
- **Yapılmayacak:** sunucudan avukat adına oturum açmak, e-imza veya şifre saklamak.
- **Karar öncesi:** UYAP kullanım koşulları ve baro görüşü alınmalı. Eklenti yolu teknik olarak mümkün olsa da izinsiz otomasyon hesabın kısıtlanmasına yol açabilir.

## Banka

### 1. adım: ekstre içe aktarma ve mutabakat

Kullanıcı bankadan indirdiği hesap ekstresini (Excel, CSV; mümkünse MT940) yükler.

- **Veri modeli:** kasa hareketine ve borçlu tahsilatına `dış referans` alanı (banka işlem numarası veya dekont no) ve ekstre satırları için ayrı kayıt (hesap, tarih, tutar, açıklama, karşı taraf, referans, durum: eşleşti / bekliyor / yok sayıldı).
- **Tekrar engelleme:** aynı hesap + referans ikinci kez içeri alınmaz. Referansı olmayan bankalar için hesap + tarih + tutar + açıklama özeti kullanılır.
- **Mutabakat ekranı:** her ekstre satırı için öneri:
  - var olan kasa hareketiyle eşleştir (aynı hesap, aynı tutar, yakın tarih),
  - borçlu tahsilatı olarak işle (açıklamadaki ad, TC veya dosya numarasından dosya önerisi; tahsilat dosyanın kendi formuyla kaydedilir),
  - yeni para girişi veya çıkışı olarak kaydet (gider kalemi seçilerek),
  - yok say.
- **Kural:** hiçbir satır onaysız kayda dönüşmez; bakiyeyi yalnız onaylanan kayıtlar değiştirir.
- **Muhasebe ekranı:** hesap şeridinde "eşleşmeyi bekleyen N satır" uyarısı.
- **Banka biçimleri:** her bankanın sütunları farklıdır. İlk sürümde büronun çalıştığı bankalar için hazır eşlemeler, diğerleri için "sütun eşle" adımı.

### 2. adım: otomatik hareket çekme

- **Yol A, açık bankacılık:** Türkiye'de hesap bilgisi hizmeti lisansa tabidir. Büronun kendisinin lisans alması gerçekçi değildir; lisanslı bir hizmet sağlayıcı üzerinden bağlanılır. Sağlayıcı seçimi, hangi bankaları kapsadığına, ücretine ve müşteri onayının (rıza) ne sıklıkla yenilendiğine göre yapılır.
- **Yol B, bankanın kurumsal servisi:** bazı bankalar kurumsal müşterilerine hesap hareketi servisi sunar. Banka başına ayrı sözleşme ve ayrı bağlantı gerekir; tek bankayla çalışan bürolar için daha ucuz olabilir.
- **Uygulama kalıbı:** büro başına şifreli kimlik bilgisi (iyzico ayarlarıyla aynı kalıp), ayar sekmesi ve "bağlantıyı sına", modül kapısı ve katalog kaydı (ücretli modül), büro kapsamlı zamanlanmış çekme işi. Çekilen satırlar 1. adımdaki ekstre satırı kaydına düşer; mutabakat ekranı değişmez.
- **Yapılmayacak:** bankaya talimat göndermek (ödeme başlatma). Bu ayrı lisans ve ayrı risk konusudur.

## Önerilen sıra

1. Banka ekstresi içe aktarma ve mutabakat. Günlük işi en çok kısaltan adım; dış bağımlılığı yok.
2. UYAP dosyadan içe aktarma: takip türü ve safahat.
3. Zamanlanmış işlerin büro kapsamına alınması.
4. Banka otomatik çekme (sağlayıcı seçildikten sonra).
5. UYAP canlı bağlantı (resmî yol doğrulandıktan sonra).

## Karar bekleyen konular

- Büronun çalıştığı bankalar ve ekstre biçimleri.
- Açık bankacılık sağlayıcısı mı, banka kurumsal servisi mi.
- UYAP için resmî bir entegrasyon yolunun bulunup bulunmadığı; yoksa eklenti yoluna girilip girilmeyeceği.
- İçe aktarılan ham dosyaların saklanıp saklanmayacağı ve süresi.
- Bu özelliklerin temel pakete mi, ücretli modüle mi gireceği.
