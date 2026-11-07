# Kayıt bazlı veri erişimine geçiş

Onay: 8 Kasım 2026. Canlı veriler korunacak; sayfalama toplam tutarı değiştirmeyecek.

## Tamamlanan uygulama

- `han_data` şemasında müvekkil, dosya, personel, finans, muhasebe, görüşme,
  ek, mesaj, hatırlatma ve arşivler ayrı satırlarda tutulur. Sorgulanan alanlar
  indeksli sütunlardır; bilinmeyen eski alanlar satırların JSON içeriğinde korunur.
- Başlangıç ve borçlu listesi tüm çalışma alanını indirmez. Liste varsayılan 50,
  en fazla 100 kayıt getirir; sonraki sayfa imleç kullanır. Ana sayfa özetleri,
  Türkçe/telefon/kolon aramaları ve genel arama sunucuda hesaplanır.
- Listedeki toplamlar sayfa sınırı uygulanmadan tüm yetkili ve filtrelenmiş
  kayıtlar üzerinden hesaplanır. Liste ve toplam aynı tutarlı görünümden gelir.
  Eksik/eski bakiye hesapları varsa yanlış toplam göstermek yerine istek reddedilir.
- Dosya açıldığında ilgili dosyanın bilgileri gelir. Belge içeriği listede veya
  başlangıç yanıtında bulunmaz; ekler dosya kimliği doğrulanarak ayrı alınır.
- Değişiklikler kayıt/alan bazlı gönderilir. Eski alan sürümü reddedilir;
  başka alanların ve dosyaların eşzamanlı değişiklikleri korunur. Sunucunun
  hesapladığı alanlar başarılı yanıtla tarayıcıdaki temel kopyaya işlenir.
- Finans kayıtları, ilgili bakiye değişiklikleri ve denetim kaydı aynı işlemde
  tamamlanır. Güncel dosya borcunu aşan tahsilat ve yetersiz hesap bakiyesi
  reddedilir. Bordro için tüm tahsilatları taşımak yerine SQL özetleri kullanılır.
- Para toplamları PostgreSQL bigint/numeric ve API'de kuruş dizgileriyle taşınır.
  Kullanıcı girdileri parametreli sorgulardadır; dinamik tablo/sıralama adları
  sabit izin listeleriyle sınırlandırılır.
- Yeni yedek biçimi iş verisiyle birlikte denetim kayıtlarını da içerir.
  Boş hedefe geri yükleme atomiktir; kullanıcıya açık geri yükleme CEO doğrulaması ister.

## Veri koruma ve doğrulama

8 Kasım 2026 02:09 (Türkiye) anlık görüntüsü şifreli `.hnb` olarak yerelde ve
mevcut R2 kovasında saklandı. R2'den indirilen şifreli baytlar birebir doğrulandı.
41 müvekkil, 68 aktif dosya, 2 arşiv dosyası ve 161 denetim kaydı boş, bellekte
çalışan PostgreSQL test motoruna aktarıldı. Yeni kayıt yapısına aktarım,
etkinleştirme ve eski yapıya geri dönüşte tüm iş verisinin SHA-256 özeti korundu.
Ham veriler rapora veya Git'e eklenmedi; şifreli yedek de Git dışında tutuldu.

Gerçek yedekle prova, eski dosyalarda aynı görünen dosya numarasının bulunabildiğini
ortaya çıkardı. Dosyaların kimliği değişmez `id` alanıdır. Numara indeksi mevcut
verileri yeniden numaralandırmaya zorlamaz; bu durum için regresyon testi eklendi.

Otomatik kontroller şunları kapsar:

Son tam çalıştırma: `npm test` 79/79 başarılı; mevcut iş kuralı kontrolleri,
`npm run format:check` ve `npm run build` başarılı. Ayrı 10.000 kayıt hacim
testi de geçti.

- 50/25 kayıt sayfalarında 75 kaydın toplamının değişmemesi; filtre toplamlarının
  doğruluğu; Türkçe arama, değişik sıralamalar ve eşit değerli imleçler.
- Dosya notu, eşzamanlı ekleme, eski sürüm çatışması, tahsilat, masraf, bordro,
  günlük faiz ve Yediemin hesapları; finans hatasında tam geri alma.
- Yetkisiz/yanlış dosyadan ek okumanın reddi; kayıtta eklerin korunması;
  yedek ve denetim kayıtlarının birlikte geri yüklenmesi.
- 10.000 sentetik dosyada 50 satırlık yanıt yaklaşık 19,75 KB; başlangıç yanıtı
  10 KB altında. Aynı denemede liste yaklaşık 2,50 sn ilk / 0,44 sn sıcak ölçüldü.
  Bunlar yerel PGlite ölçümleridir; canlı hizmet seviyesi veya milyonlarca kayıt
  kapasitesi iddiası değildir.
- Yerel tarayıcıda başlangıç, sayfalar, filtreler, dosya açma/sonraki dosya ve
  müvekkiller ekranına geçiş doğrulandı.

## Henüz tamamlanmamış ölçek çalışmaları

- Müvekkil, evrak kabul, rapor, muhasebe, mesaj, hatırlatma ve bazı zincir/gün
  ayrıntıları açılırken uyumluluk görünümü hâlâ tüm ilgili çalışma alanını yükler.
  Bu ekranlar ayrı sayfalı API'lere taşınmalıdır; mevcut hata sınırı aşılırsa
  kısmi verilerden toplam üretmek yerine açık hata verilir.
- Tek dosyanın görüşme/finans geçmişi henüz tamamen sekme bazlı sayfalanmaz.
  Bazı yönetim işlemleri ve arka plan işleri tam görünümü kullanır.
- Ekler ayrı veritabanı satırlarına ayrıldı; birincil ek içeriğini R2'ye taşıma
  ve büyük yedeği parçalar halinde aktarma bu aşamada uygulanmadı.
- Tarihe bağlı çok sayıda bakiye aynı gün eskirse toplu yeniden hesaplama maliyeti
  artar. Milyon ölçeğinden önce arka plan güncellemesi, özet tablolar ve gerçek
  PostgreSQL eşzamanlı yük/EXPLAIN ölçümleri gerekir. Her liste toplam sorgusu
  eşleşen tüm kayıtları kapsar; ağda 50 kayıt olması bu sorguyu O(1) yapmaz.

## Canlı geçiş sırası

`HAN_RECORD_STORE` canlıda açılmadı. SQL henüz canlıya uygulanmadı.
Yerel `.env.local` dosyasında `DATABASE_URL` bulunmadığı için doğrudan bağlantı
üzerinden canlı import ve entegrasyon doğrulaması bekliyor. Vercel'deki gizli
değer geri okunamadı; bağlantı bilgisi sohbete yazılmamalıdır.

1. Güncel kodu, canlı sürümü, şemayı ve advisor sonuçlarını karşılaştır.
2. Geçiş anında yeni şifreli yedek al ve geri yüklenebilirliğini doğrula.
3. `20261107213419_record_store_foundation.sql` ek şemasını kontrollü migration
   olarak uygula. Uygulamanın `han_private.han_migrations` kaydını aynı normalize
   SQL checksum ile tut; uygulanmış migration'ı yeniden çalıştırma.
4. `npm run db:records -- prepare`, ardından `verify` çalıştır. Mevcut kaynak
   değişirse `sync` ve `verify` tekrarlanır. Bunlar eski kaynağı silmez.
5. Tam yeni API/arayüzü gerçek PostgreSQL test hedefinde doğrula; aynı anda eski
   ve yeni sürümün yazmasını engelleyen kısa bakım aralığını planla.
6. Son eşitleme sonrası `activate` ve `HAN_RECORD_STORE=1` dağıtımını birlikte
   kontrollü uygula. Eski sürümün dondurulan JSON kaynağına yazması reddedilir.
7. Canlı sayfa/toplam, tahsilat/masraf, audit ve yedek akışlarını doğrula.
   Geri dönüş gerekirse önce `rollback` ile yeni yapının **son verisini** eski
   yapıya taşı, ardından bayrağı kapatarak dağıtımı geri al. Eski yedeğe kör dönüş yapma.

Bu hazırlık tek başına milyarlarca detay için tamamlanmış bir mimari değildir.
`database/next` önceki pilottur; bu migration yerine ayrıca uygulanmamalıdır.
