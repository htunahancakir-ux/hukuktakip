# hanhukuk 1.1.1

Türkçe hukuk bürosu, evrak kabul, borçlu, tahsilat, muhasebe ve personel takip uygulaması.

## Çalıştırma

Node.js 24 veya daha yeni bir sürüm kurulu olmalıdır. Harici paket bağımlılığı yoktur.

```sh
node outputs/icrapro/server.cjs
```

Tarayıcıda http://127.0.0.1:4317/ adresini açın. İlk çalıştırmada CEO hesabınızı oluşturun.

Uygulama yalnızca yerel bilgisayara bağlıdır. Diğer bilgisayarlardan erişim için ayrıca güvenli ağ ve sunucu yapılandırması gerekir.

## Veriler

Kayıtlar `work/hanhukuk-state.json` dosyasında saklanır. `HANHUKUK_STATE_FILE` ortam değişkeniyle başka bir yer seçilebilir; `HANHUKUK_PORT` varsayılan 4317 portunu değiştirir.

Bu depo canlı kayıt, kullanıcı parolası, yüklenmiş belge veya veri yedeği içermez. Veri dosyasını düzenli olarak ayrıca yedekleyin. İlk kurulum boş başlar.

## Kapsam

- Müvekkil, personel, çoklu telefon/adres ve belge kaydı
- Senet, çek, sözleşme, cari ekstre, ilam, fatura ve yediemin evrakları
- Sekmeli borçlu föyü, dosya zinciri, PDF/fotoğraf önizlemeleri
- Tahsilat, masraf, taksitlendirme, ödeme sözü ve arama hatırlatmaları
- Kasa/banka hareketleri, müvekkil ödemeleri, makbuz ve ibraname çıktıları
- Günlük/aylık/yıllık raporlar ve personel prim hesapları
- CEO, yönetici ve personel hesapları; sunucuda yetki kontrolleri
- Aylık maaş/prim dönem arşivi

Hukuki hesaplama oranları ve tarife sürümü `outputs/icrapro/legal-charges.cjs` ile arayüzdeki hesaplama bölümünde tanımlıdır. Yeni mevzuat/tarife yayımlandığında güncellenmelidir. UYAP veya bankaya gerçek işlem göndermez.

## Kontroller

```sh
node tests/run.cjs
```

Testler hesaplama kurallarını ve kaynak dosyalarının JavaScript sözdizimini kontrol eder; canlı verilere dokunmaz.
