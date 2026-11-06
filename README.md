# Han Hukuk 1.2 — Supabase / Vercel hazırlığı

6 Kasım 2026 tarihli Han Hukuk uygulaması. Node.js 24, sade JavaScript arayüzü ve Supabase PostgreSQL kullanır.

Kurulum: npm ci. Test: npm test. Derleme: npm run build. Yerel başlatma: npm start.

Yerel adres: http://127.0.0.1:4317/. DATABASE_URL yokken yerel sunucu work/hanhukuk-state.json dosyasını kullanır. Vercel API'sinde PostgreSQL zorunludur; bağlantı veya veri aktarımı eksikse 503 döndürür.

Supabase kurulumu, ortam değişkenleri, kayıt aktarımı ve Vercel ayarları: [kurulum kılavuzu](docs/SUPABASE-VERCEL.md).

İlk geçiş mevcut kayıtları özel şemadaki JSONB alanlarında korur; ilişkisel tablolara ayrıştırma sonraki aşamadır. Oturumlar kalıcıdır, değişiklikler transaction içinde kaydedilir, eski veri üzerine yazma reddedilir.

Canlı kayıtlar, parola hashleri, .env, ZIP ve EXE dosyaları depoya dahil edilmez. Testler sentetik verilerle çalışır.

Bu dal canlıya geçiş hazırlığıdır. Gerçek Supabase bağlantı testi, belge depolama/sayfalama, zamanlanmış işler ve canlı kabul testleri tamamlanmadan üretim sürümü olarak kullanılmamalıdır.
