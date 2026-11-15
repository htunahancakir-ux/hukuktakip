# Excel aktarımı için sınırlı veritabanı erişimi

Mevcut büroya (`00000000-0000-0000-0000-000000000001`) Excel'den **yeni müvekkil ve yeni
borçlu/föy** eklemek için, uygulamanın dışında kullanılan dar yetkili bir PostgreSQL erişimi.
Uygulamanın kendisi bu dosyaları kullanmaz; geçişlerin (`supabase/migrations`) parçası değildir
ve canlı sunucuya elle kurulmuştur (2026-11-15).

## Parçalar

| Parça | Ne |
|---|---|
| `han_excel_aktarim` | Giriş yapan rol. Hiçbir role üye değil, hiçbir tabloda yetkisi yok; yalnızca `han_excel.durum()`, `han_excel.muvekkil_ekle()`, `han_excel.foy_ekle()` işlevlerini çağırabilir. En fazla 3 bağlantı, 30 sn ifade süresi, 15 sn boşta açık işlem süresi. |
| `han_excel_yazici` | Giriş yapamayan rol; işlevlerin sahibi (`SECURITY DEFINER`). Yetkisi: `clients` ve `documents` üzerinde SELECT + INSERT, `document_sequences` üzerinde SELECT + INSERT + UPDATE, `han_audit` üzerinde INSERT. Satır güvenliği kuralları (`excel_aktarim_*`) onu tek büroya ve etkin satır eklemeye bağlar. |
| `han_excel` şeması | Üç açık işlev ve yardımcıları (`_metin`, `_tutar`, `_kaynak`, …). |
| `han_excel.muvekkil`, `han_excel.foy` | Düz sütunlu iki görünüm (`tablolar.sql`). Aktarımı yapan araç bunlara sıradan `INSERT` yazar; her satır `INSTEAD OF INSERT` tetikleyicisiyle `muvekkil_ekle` / `foy_ekle` işlevinden geçer, yani kurallar aynıdır. Kullanıcının yetkisi sütun düzeyindedir: girdi sütunlarına INSERT; yalnızca `id`, `foy_no`, `durum`, `muvekkil_id`, `kaynak_*`, `eklenme` sütunlarına SELECT. Görünümler yalnızca bu aktarımın eklediği satırları gösterir. UPDATE / DELETE yoktur. Gerçek tablolara doğrudan INSERT bilerek verilmedi: kayıt gövdesi, föy sayacı ve çakışma denetimi uygulamanın kurallarına bağlıdır. |
| Dış bağlantı (`disari-ac.sh`) | 2026-11-15'te kullanıcının kararıyla açıldı: aktarımı başka bir bilgisayardaki araç yapıyor. `listen_addresses = '*'`, güvenlik duvarında `5432/tcp` hız sınırlı (`ufw limit`), `authentication_timeout = 15s`. |
| `pg_hba.conf` | `hostssl hanhukuk han_excel_aktarim all scram-sha-256`; ardından bu rol için `reject`; dosyanın sonunda sunucu dışından gelen her bağlantı için `reject`. Dışarıdan yalnızca bu rol, yalnızca `hanhukuk` veritabanına, yalnızca SSL ile girer; `hanhukuk` ve `postgres` rolleri şifre sorulmadan reddedilir. |

## Uygulamayla aynı tutulan kurallar

İşlevler aşağıdaki kodun yaptığını SQL'de yapar. **Bu dosyalar değişirse `kur.sql` de gözden
geçirilmelidir:**

- `lib/record-store/folio-numbers.cjs` (`nextFolioNumber`): `GLOBAL` sayacından sıradaki numara.
- `lib/record-store/intake.cjs` (`validateIntake`): müvekkil bağlantısı, evrak türü, borçlu adı,
  tutar, borçlunun TC / vergi numarası çakışması.
- `lib/record-store/clients.cjs` (`assertClientIdentities`): müvekkilin TC / vergi numarası çakışması.
- `lib/audit.cjs` (`dataEvents`): `changes / create / Müvekkiller | Evraklar`, `record_ref` = kayıt kimliği.
- `outputs/icrapro/phone-format.js` (`formatPhoneNumber`), `lib/state-invariants.cjs` (icra dosya
  numarası olan föyün durumu `İcra`).
- Kayıt gövdesinin alanları, uygulamanın evrak kabul ve müvekkil ekranlarının yazdığı alanlardır;
  türetilmiş sütunlar (`name`, `number`, `status`, `search_text`, …) gövdeden kendiliğinden oluşur.

Uygulamada olmayan ek korumalar: aynı Excel satırının (`sourceImport`: dosya özeti ya da adı +
sayfa + satır) ikinci kez kayıt açmaması; aynı müvekkil, borçlu, tür, tutar, vade ve evrak
numarasıyla föyün yeniden açılmaması; kimlik numarası olmayan müvekkilin aynı adla açılmaması.

Kapsam dışı: Yediemin Park Ücreti, çok kalemli alacak (`receivables`), kefil, ek dosya, sorumlu
ataması. Otomatik yasal faiz / harç, föy uygulamada ilk yazıldığında hesaplanır
(`applyAutomaticLegalCharges`).

## Dosyalar

| Dosya | İş |
|---|---|
| `kur.sql` | Roller, yetkiler, satır güvenliği kuralları, işlevler. Tekrar çalıştırılabilir. |
| `tablolar.sql` | `han_excel.muvekkil` ve `han_excel.foy` görünümleri, tetikleyicileri ve sütun yetkileri. `kur.sql`'den sonra çalıştırılır; tekrar çalıştırılabilir. |
| `kaldir.sql` | Hepsini kaldırır (aktarılmış kayıtlar kalır). |
| `sifre-ata.cjs` | Rastgele şifre üretir, yalnızca root'un okuyabildiği dosyaya yazar, sunucuya yalnızca SCRAM özetini gönderir. |
| `disari-ac.sh` | Veritabanını yalnızca bu rol için internete açar (yukarıdaki dış bağlantı düzeni); tünel kullanıcısını kaldırır. |
| `disari-kapat.sh` | Dış bağlantıyı kapatır: güvenlik duvarı kuralı, `pg_hba.conf` satırları, `listen_addresses`. |
| `ag-kur.sh` | Kapalı düzen (şu an kullanılmıyor): PostgreSQL dışarıya kapalıyken yalnızca `127.0.0.1:5432`'ye SSH tüneli açabilen kabuksuz `hanexcel` kullanıcısı ve yerel `pg_hba.conf` satırları. Bu düzene dönmek için önce `disari-kapat.sh`, sonra `ag-kur.sh <açık anahtar>`. |
| `test.sql` | Yetki ve kural denemeleri; `han_excel_aktarim` olarak çalışır, tek işlemde, sonunda geri alınır. |
| `test-tablo.sql` | Görünümlere düz INSERT denemeleri (tek ve çok satırlı, kontrol kipi, tekrar, kurallar, sütun yetkileri); aynı şekilde geri alınır. |
| `ozet.sql`, `incele.sql` | Denemeden önce / sonra tablo özetleri ve eklenen deneme satırlarının biçim denetimi (süper kullanıcı). |
| `kopyada-dene.sh` | Son dökümden bir kopya veritabanı açar, kurar, dener, kopyayı siler. Canlıya dokunmaz. |
| `canlida-dene.sh` | Canlıda gerçek girişle (SSL, şifre) `test.sql`; önce / sonra özet karşılaştırması. Kalıcı değişiklik yapmaz. |

## Sunucuda

Dosyalar `/opt/han-excel-aktarim` altındadır; şifre `/root/han-excel-aktarim/sifre.txt`.

```bash
# Kopyada dene (canlıya dokunmaz)
bash /opt/han-excel-aktarim/kopyada-dene.sh /var/backups/hanhukuk/hanhukuk-<tarih>.dump
# Canlıya kur / güncelle
runuser -u postgres -- psql -d hanhukuk -X -q -v ON_ERROR_STOP=1 -f /opt/han-excel-aktarim/kur.sql
runuser -u postgres -- psql -d hanhukuk -X -q -v ON_ERROR_STOP=1 -f /opt/han-excel-aktarim/tablolar.sql
bash /opt/han-excel-aktarim/disari-ac.sh                                         # internete aç (PostgreSQL yeniden başlar)
node /opt/han-excel-aktarim/sifre-ata.cjs /root/han-excel-aktarim/sifre.txt      # şifreyi yeniler
# Canlıda dene (kalıcı değişiklik yok)
bash /opt/han-excel-aktarim/canlida-dene.sh /root/han-excel-aktarim/sifre.txt
```

Kaldırma:

```bash
bash /opt/han-excel-aktarim/disari-kapat.sh        # internete kapat (PostgreSQL yeniden başlar)
runuser -u postgres -- psql -d hanhukuk -X -q -v ON_ERROR_STOP=1 -f /opt/han-excel-aktarim/kaldir.sql
rm -rf /opt/han-excel-aktarim /root/han-excel-aktarim
```

Yalnızca internete kapatmak (rol ve işlevler kalsın) için ilk satır yeterlidir.

## Dikkat

- **5432 internete açıktır.** Koruma katmanları: `pg_hba.conf` (dışarıdan tek rol), SSL zorunluluğu,
  192 bitlik rastgele şifre (yalnızca SCRAM özeti saklı), rolün kendisinin dar yetkisi, güvenlik
  duvarında bağlantı hız sınırı. `pg_hba.conf`'a dışarıdan başka bir role izin veren satır
  eklemeyin; `host all all 0.0.0.0/0 reject` satırlarını silmeyin. Aktarım işi bittiğinde
  `disari-kapat.sh` ile kapatmak en güvenlisidir.
- İstemci aktarımı tek bağlantıdan yapmalıdır; aynı adresten 30 saniyede 6'dan fazla yeni
  bağlantı güvenlik duvarınca bir süre engellenir.

- Yedekten **başka bir sunucuya** geri yüklemede `han_excel_yazici` ve `han_excel_aktarim` rolleri
  yoksa `pg_restore` bu rollerin yetki ve kural satırlarında uyarı verir; veriler yine yüklenir.
  İstenirse önce roller (`kur.sql`'in başındaki `CREATE ROLE` bölümü) oluşturulur.
- Yeni bir tablo ya da zorunlu alan, föy / müvekkil kaydının parçası olursa bu işlevler onu
  doldurmaz; `kopyada-dene.sh` ile yeniden denenmelidir.
- İstemci her çağrıyı kendi işleminde göndermelidir: açık bırakılan işlem `GLOBAL` sayaç satırını
  kilitli tutar ve uygulamada yeni föy numarası almayı bekletir (15 sn sonra sunucu keser).
