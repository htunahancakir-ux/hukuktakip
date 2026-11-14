// Local preview of the platform (super admin) console. Not for production.
// Uses an in-memory PostgreSQL (PGlite): nothing is written to any real database,
// and all data disappears when the process stops. iyzico is simulated: the payment link
// dialog works, but the link is not a real payment page and nothing can be collected.
//
//   npm run platform:preview
//   -> http://127.0.0.1:4310   user: demo   password: Demo-Operator-123
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { database } = require('../tests/support/postgres.cjs');
const { createPlatformAdmin } = require('../lib/saas/platform-auth.cjs');
const { createPlatformHandler } = require('../lib/platform-app.cjs');
const platform = require('../lib/saas/platform.cjs');
const support = require('../lib/saas/support.cjs');
const finance = require('../lib/saas/finance.cjs');
const campaigns = require('../lib/saas/campaigns.cjs');
const announcements = require('../lib/saas/announcements.cjs');
const pipeline = require('../lib/saas/pipeline.cjs');
const profit = require('../lib/saas/profit.cjs');
const platformMaps = require('../lib/saas/platform-maps.cjs');
const { createOfficeCatalog } = require('../lib/saas/office-catalog.cjs');
const { createUsageMeter } = require('../lib/saas/usage-meter.cjs');
const { createOfficeSupport } = require('../lib/saas/office-support.cjs');
const { createSupportAccess } = require('../lib/saas/support-access.cjs');

// Two-factor setup seals its secret with a server key; the preview makes a throwaway one.
process.env.PLATFORM_ENCRYPTION_KEY ||= require('node:crypto').randomBytes(32).toString('hex');

const PORT = Number(process.env.PORT) || 4310;
const root = path.join(__dirname, '../outputs/icrapro');
const OPERATOR = { username: 'demo', name: 'Demo Operatör', password: 'Demo-Operator-123' };
const ASSETS = { '/platform.css': 'text/css; charset=utf-8', '/platform.js': 'text/javascript; charset=utf-8' };

async function seed(pool, operatorId) {
  await platform.upsertModule(pool, { code: 'voip', name: 'Çağrı merkezi', monthlyPriceKurus: 50000, active: true });
  await platform.upsertModule(pool, { code: 'whatsapp', name: 'WhatsApp', monthlyPriceKurus: 30000, active: true });
  await platform.upsertModule(pool, { code: 'ai-assistant', name: 'Yapay zekâ asistanı', monthlyPriceKurus: 80000, active: true });
  const admin = (username) => ({ name: 'Demo Yönetici', username, password: 'Demo-Sifre-12345!' });
  await platform.openOffice(pool, operatorId, {
    slug: 'ornek-hukuk', name: 'Örnek Hukuk Bürosu', userCount: 5, userPriceKurus: 40000, termMonths: 12,
    moduleCodes: ['voip'], discountKurus: 0, paid: true, admin: admin('ornek'),
  });
  await platform.openOffice(pool, operatorId, {
    slug: 'deneme-avukatlik', name: 'Deneme Avukatlık', userCount: 3, userPriceKurus: 45000, termMonths: 6,
    moduleCodes: ['voip', 'whatsapp'], discountKurus: 50000, paid: false, admin: admin('deneme'),
  });
  await platform.openOffice(pool, operatorId, {
    slug: 'eski-musteri', name: 'Eski Müşteri Hukuk', userCount: 2, userPriceKurus: 35000, termMonths: 1,
    moduleCodes: [], discountKurus: 0, paid: true, admin: admin('eski'),
  });
  const offices = (await pool.query('SELECT id, slug FROM han_saas.tenants')).rows;
  const idOf = (slug) => offices.find((o) => o.slug === slug)?.id;
  const today = (await pool.query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Istanbul')::date::text AS d")).rows[0].d;
  const ticket = await support.openTicket(pool, operatorId, {
    tenantId: idOf('ornek-hukuk'), subject: 'Kullanıcılar giriş yapamıyor', category: 'technical', priority: 'urgent', channel: 'phone',
    contactName: 'Ayşe Hanım', contactInfo: '0532 000 00 00', body: 'Sabahtan beri iki kullanıcı şifreyi kabul etmiyor.',
  });
  await support.addMessage(pool, operatorId, { ticketId: ticket.id, kind: 'internal', body: 'Şifre politikası değişikliği olabilir, bakılacak.' });
  await support.openTicket(pool, operatorId, {
    tenantId: idOf('deneme-avukatlik'), subject: 'Fatura bilgisi güncellensin', category: 'billing', priority: 'normal', channel: 'email',
    contactName: 'Mehmet Bey', body: 'Fatura unvanı değişti, yenisi ekte.',
  });
  const answered = await support.openTicket(pool, operatorId, {
    tenantId: idOf('eski-musteri'), subject: 'Rapor nasıl indirilir?', category: 'how_to', priority: 'low', channel: 'whatsapp', body: 'Aylık raporu nereden indirebilirim?',
  });
  await support.addMessage(pool, operatorId, { ticketId: answered.id, kind: 'operator', body: 'Raporlar > Dışa aktar menüsünden indirebilirsiniz.' });
  for (const [category, description, vendor, amountKurus, vatRatePercent, tenantId] of [
    ['advertising', 'Google Ads kasım kampanyası', 'Google', 1_500_000, 20],
    ['marketing', 'Broşür ve baskı', 'Matbaa', 300_000, 20],
    ['server', 'Sunucu ve veritabanı', 'Vercel / Supabase', 450_000, 20],
    ['ai', 'Yapay zekâ kullanımı (örnek büro)', 'AI sağlayıcı', 120_000, 0, idOf('ornek-hukuk')],
    ['telephony', 'Santral hattı', 'Verimor', 200_000, 20],
  ])
    await finance.addExpense(pool, operatorId, { spentOn: today, category, description, vendor, amountKurus, vatRatePercent, tenantId });

  // Products, a campaign, an announcement, a trial, the pipeline and usage, so every new page
  // has something to show.
  await platform.upsertModule(pool, {
    code: 'ai-assistant', name: 'Yapay zekâ asistanı', monthlyPriceKurus: 80000, status: 'selling', trialDays: 14,
    description: 'Görüşme özeti, öneri ve rapor üretimi',
    features: ['Görüşme özetleri', 'Ödeme sözü önerileri', 'Aylık rapor yorumu'],
  }, operatorId);
  await platform.upsertModule(pool, {
    code: 'sms-1000', name: 'SMS paketi', kind: 'usage_pack', monthlyPriceKurus: 25000, status: 'selling',
    packQuantity: 1000, packUnit: 'SMS',
  }, operatorId);
  await platform.upsertModule(pool, { code: 'kurulum', name: 'Kurulum ve veri aktarımı', kind: 'service', monthlyPriceKurus: 500000, status: 'selling' }, operatorId);
  await platform.upsertModule(pool, { code: 'e-tebligat', name: 'e-Tebligat takibi', monthlyPriceKurus: 40000, status: 'soon' }, operatorId);
  const week = 7 * 86400000;
  const campaign = await campaigns.upsertCampaign(pool, operatorId, {
    name: 'Yapay zekâ lansmanı', productCodes: ['ai-assistant'], discountType: 'percent', discountValue: 25,
    applies: 'first_3_months', audience: 'without_product', endsAt: new Date(Date.now() + 4 * week).toISOString(), couponCode: 'YZ25',
  });
  const card = await announcements.upsertAnnouncement(pool, operatorId, {
    kind: 'campaign', title: 'Yapay zekâ asistanı ilk 3 ay %25 indirimli', body: 'Görüşmelerinizi otomatik özetleyin, ödeme sözlerini kaçırmayın.',
    productCode: 'ai-assistant', campaignId: campaign.id, audience: 'without_product', endsAt: new Date(Date.now() + 4 * week).toISOString(), priority: 80,
  });
  await announcements.setAnnouncementStatus(pool, operatorId, { id: card.id, status: 'published' });
  await platform.startTrial(pool, operatorId, { tenantId: idOf('deneme-avukatlik'), moduleCode: 'ai-assistant' });
  await platform.sellProduct(pool, operatorId, { tenantId: idOf('ornek-hukuk'), code: 'kurulum', paid: true });
  await pipeline.createProspect(pool, operatorId, {
    officeName: 'Deniz Hukuk', contactName: 'Av. Deniz Yılmaz', phone: '0532 000 00 01', city: 'İzmir', source: 'referral',
    expectedUsers: 6, productCodes: ['voip'], expectedMonthlyKurus: 290000, nextActionAt: new Date().toISOString(),
  });
  const demo = await pipeline.createProspect(pool, operatorId, {
    officeName: 'Kuzey Avukatlık', contactName: 'Av. Selin Kuzey', city: 'Ankara', source: 'advertising', expectedUsers: 3, expectedMonthlyKurus: 135000,
  });
  await pipeline.moveProspect(pool, operatorId, { id: demo.id, stage: 'demo' });
  const officeDesk = createOfficeCatalog(pool, { tenantId: idOf('ornek-hukuk') });
  await officeDesk.requestProduct({ name: 'Ayşe Hanım', role: 'ceo' }, { code: 'ai-assistant', note: 'Fiyat ve demo istiyoruz.' });
  await profit.saveUnitCosts(pool, operatorId, { aiInputPerMillionKurus: 9000, aiOutputPerMillionKurus: 45000, smsSegmentKurus: 15, voipMinuteKurus: 40, mapsSearchKurus: 150, mapsDetailKurus: 60 });
  await createUsageMeter(pool, { tenantId: idOf('deneme-avukatlik') }).recordAi({ inputTokens: 1_200_000, outputTokens: 300_000 });
  // Rota Bulma as a subscription: the product on sale, one subscribed office and its searches
  // this month. The key is made up (it only has Google's format); "Anahtarı test et" fails here.
  await platform.upsertModule(pool, { code: 'marketing-routes-service', name: 'Rota Bulma harita servisi', description: 'Firma araması platformun harita servisiyle çalışır; büro anahtar girmez', features: ['Kurulum ve API anahtarı gerekmez', 'Haritada bölge çizerek firma arama'], monthlyPriceKurus: 90000, status: 'selling' }, operatorId);
  await platform.addModule(pool, operatorId, { tenantId: idOf('ornek-hukuk'), moduleCode: 'marketing-routes-service', paid: true });
  await platformMaps.saveSettings(pool, operatorId, { apiKey: 'AIza' + 'P'.repeat(35), monthlySearches: 300, monthlyDetails: 3000, enabled: true });
  await platformMaps.createPlatformMaps(pool, { tenantId: idOf('ornek-hukuk') }).record({ searches: 42, details: 120 });
  // A ticket from an office with a 30-minute support access grant waiting for the team.
  const deskUser = { id: 'u-ceo', name: 'Mehmet Avukat', role: 'ceo' };
  const accessTicket = await createOfficeSupport(pool, { tenantId: idOf('deneme-avukatlik') }).open(deskUser, {
    subject: 'Tahsilat raporu yanlış toplam veriyor', body: 'Kasım raporunda toplam tutar föylerle tutmuyor. Bakabilir misiniz?', category: 'technical', priority: 'high',
  });
  await createSupportAccess(pool, { tenantId: idOf('deneme-avukatlik') }).grant(deskUser, { ticketId: accessTicket.id, minutes: 30, allowEdit: false });
  await profit.addRecurring(pool, operatorId, { category: 'software', description: 'E-posta ve ofis yazılımı', amountKurus: 90000, dayOfMonth: 1, startsOn: today.slice(0, 8) + '01' });
}

// Stands in for the real iyzico client so the payment-link dialog can be tried without keys.
function fakeIyzico() {
  return {
    async initializeCheckout({ conversationId }) {
      return { token: 'preview-' + conversationId.slice(0, 8) + '-token', paymentPageUrl: 'https://sandbox-cpp.iyzipay.com?token=preview-' + conversationId.slice(0, 8) };
    },
    async retrieveCheckout(token, conversationId) {
      return { paid: false, paymentStatus: 'FAILURE', paymentId: null, conversationId, basketId: conversationId, currency: 'TRY', priceKurus: 0, paidKurus: 0 };
    },
  };
}

// Yedekleme: an in-memory stand-in for object storage, so "Şimdi tümünü yedekle" and the
// file list work in the preview. Nothing leaves this computer.
function fakeStorage() {
  const { Readable } = require('node:stream');
  const { format } = require('../lib/backup-service.cjs');
  for (const name of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'CRON_SECRET'])
    process.env[name] ||= 'preview';
  process.env.BACKUP_ENCRYPTION_KEY ||= require('node:crypto').randomBytes(32).toString('hex');
  const files = new Map();
  return {
    upload: async (key, data) => void files.set(key, data),
    client: () => ({
      async send(command) {
        const { Prefix, Key } = command.input;
        if (Prefix !== undefined)
          return { Contents: [...files].filter(([key]) => key.startsWith(Prefix)).map(([key, data]) => ({ Key: key, Size: data.length })) };
        if (!files.has(Key)) throw Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } });
        return { Metadata: { format }, Body: Readable.from([files.get(Key)]) };
      },
      destroy() {},
    }),
  };
}

async function main() {
  const { pool } = await database();
  const operator = await createPlatformAdmin(pool, OPERATOR);
  await seed(pool, operator.id);
  const storage = fakeStorage();
  const api = createPlatformHandler({
    pool,
    secureCookies: false,
    iyzico: fakeIyzico(),
    backupUpload: storage.upload,
    backupR2Client: storage.client,
  });
  const version = String(Date.now());
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith('/api/platform')) return api(req, res);
    if (pathname === '/' || pathname === '/platform.html') {
      const html = fs.readFileSync(path.join(root, 'platform.html'), 'utf8').replaceAll('__ASSET_VERSION__', version);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      return res.end(html);
    }
    if (ASSETS[pathname]) {
      res.writeHead(200, { 'Content-Type': ASSETS[pathname], 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(root, pathname)));
    }
    res.writeHead(404).end('Not found');
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Hukuk Takip Platformu Yönetim önizlemesi: http://127.0.0.1:${PORT}`);
    console.log(`Kullanıcı: ${OPERATOR.username}   Şifre: ${OPERATOR.password}`);
    console.log('Veriler bellekte; işlem bitince silinir. Durdurmak için Ctrl+C.');
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
