const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database } = require('./support/postgres.cjs');
const { createPlatformAdmin } = require('../lib/saas/platform-auth.cjs');
const { createOfficeCatalog } = require('../lib/saas/office-catalog.cjs');
const { LEGACY_TENANT_ID } = require('../lib/saas/tenant-pool.cjs');
const platform = require('../lib/saas/platform.cjs');
const campaigns = require('../lib/saas/campaigns.cjs');
const announcements = require('../lib/saas/announcements.cjs');
const pipeline = require('../lib/saas/pipeline.cjs');

const secret = 'Synthetic-Office-Catalog-Test!';
const ceo = { id: 'u-ceo', name: 'Ceo Avukat', role: 'ceo' };
const admin = { id: 'u-admin', name: 'Yönetici', role: 'admin' };
const staff = { id: 'u-staff', name: 'Personel', role: 'staff' };
const DAY = 86400000;
const soon = () => new Date(Date.now() + 30 * DAY).toISOString();

async function setup(pool) {
  const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Ayşe Operatör', password: secret })).id;
  await platform.upsertModule(pool, { code: 'voip', name: 'Çağrı merkezi', monthlyPriceKurus: 50000, status: 'selling', trialDays: 14, features: ['Web telefon', 'Kayıt'] }, op);
  await platform.upsertModule(pool, { code: 'ai-assistant', name: 'Yapay zekâ', monthlyPriceKurus: 80000, status: 'soon' }, op);
  await platform.upsertModule(pool, { code: 'sms-1000', name: 'SMS paketi', kind: 'usage_pack', monthlyPriceKurus: 20000, status: 'selling', packQuantity: 1000, packUnit: 'SMS' }, op);
  await platform.upsertModule(pool, { code: 'hidden', name: 'Taslak ürün', monthlyPriceKurus: 1000, status: 'draft' }, op);
  const open = async (slug, moduleCodes = []) =>
    (
      await platform.openOffice(pool, op, {
        slug,
        name: slug.toUpperCase() + ' Hukuk',
        admin: { name: 'Y', username: slug, password: secret },
        userCount: 3,
        userPriceKurus: 1000,
        termMonths: 12,
        moduleCodes,
        paid: true,
      })
    ).office.id;
  return { op, a: await open('buro-a'), b: await open('buro-b', ['voip']) };
}

test('home-page card: targeting, managers only for sales cards, close and "İlgileniyorum" → pipeline', async () => {
  const { pg, pool } = await database();
  try {
    const { op, a, b } = await setup(pool);
    const deskA = createOfficeCatalog(pool, { tenantId: a });
    const deskB = createOfficeCatalog(pool, { tenantId: b });
    const { id: campaignId } = await campaigns.upsertCampaign(pool, op, {
      name: 'Kasım fırsatı',
      productCodes: ['voip'],
      discountType: 'percent',
      discountValue: 20,
      applies: 'first_3_months',
      endsAt: soon(),
      couponCode: 'kasim20',
    });
    const { id: promo } = await announcements.upsertAnnouncement(pool, op, {
      kind: 'campaign',
      title: 'Çağrı merkezinde %20',
      body: 'İlk 3 ay %20 indirim.',
      productCode: 'voip',
      campaignId,
      audience: 'without_product',
      endsAt: soon(),
      priority: 80,
    });
    const { id: maintenance } = await announcements.upsertAnnouncement(pool, op, {
      kind: 'maintenance',
      title: 'Planlı bakım',
      body: 'Pazar 02.00–03.00 arası kısa kesinti.',
      roles: 'everyone',
      dismissible: false,
      endsAt: soon(),
      priority: 10,
    });

    // Drafts are invisible.
    assert.equal((await deskA.news(ceo)).card, null);
    await announcements.setAnnouncementStatus(pool, op, { id: promo, status: 'published' });
    await announcements.setAnnouncementStatus(pool, op, { id: maintenance, status: 'published' });

    const card = (await deskA.news(ceo)).card;
    assert.equal(card.id, promo, 'highest priority first');
    assert.equal(card.product.code, 'voip');
    assert.equal(card.product.priceKurus, 50000);
    assert.deepEqual(
      { name: card.campaign.name, type: card.campaign.discountType, value: card.campaign.discountValue, coupon: card.campaign.couponCode },
      { name: 'Kasım fırsatı', type: 'percent', value: 20, coupon: 'KASIM20' },
    );
    // Staff never see sales cards; they get the maintenance notice, without prices.
    const staffCard = (await deskA.news(staff)).card;
    assert.equal(staffCard.id, maintenance);
    assert.equal(staffCard.product, null);
    assert.equal(staffCard.campaign, null);
    // Office B already has the phone module: the "without product" card is not for it.
    assert.equal((await deskB.news(ceo)).card.id, maintenance);
    // Staff cannot press "İlgileniyorum"; a non-dismissible card cannot be closed.
    await assert.rejects(deskA.mark(staff, promo, 'interest'), (e) => e.status === 403);
    await assert.rejects(deskA.mark(staff, maintenance, 'dismiss'), (e) => e.status === 409);
    // Another office cannot act on an announcement not meant for it... selected audience:
    const { id: onlyB } = await announcements.upsertAnnouncement(pool, op, {
      kind: 'new_product',
      title: 'Size özel',
      body: 'Yalnızca B bürosu için.',
      audience: 'selected',
      tenantIds: [b],
      endsAt: soon(),
    });
    await announcements.setAnnouncementStatus(pool, op, { id: onlyB, status: 'published' });
    await assert.rejects(deskA.mark(ceo, onlyB, 'click'), (e) => e.status === 404);

    await deskA.mark(ceo, promo, 'click');
    const interest = await deskA.mark(ceo, promo, 'interest');
    assert.deepEqual(interest, { requested: true, already: false });
    assert.deepEqual(await deskA.mark(admin, promo, 'interest'), { requested: true, already: true }, 'one open request per product');
    assert.equal((await deskA.news(ceo)).card.interested, true);

    const board = await pipeline.listProspects(pool);
    const lead = board.prospects.find((p) => p.tenantId === a);
    assert.equal(lead.kind, 'upsell');
    assert.equal(lead.source, 'announcement');
    assert.deepEqual(lead.productCodes, ['voip']);
    assert.equal(lead.expectedMonthlyKurus, 50000);
    assert.equal(lead.createdLabel, 'Ceo Avukat');
    assert.equal(board.byStage.new.count, 1);

    await deskA.mark(ceo, promo, 'dismiss');
    assert.equal((await deskA.news(ceo)).card.id, maintenance, 'closed card is gone for this person');
    assert.equal((await deskA.news(admin)).card.id, promo, 'but not for another manager');

    const stats = (await announcements.listAnnouncements(pool)).find((x) => x.id === promo).stats;
    assert.deepEqual(stats, { offices: 1, shown: 2, clicked: 1, dismissed: 1, interested: 2 });

    // Selling the module from the lead closes it as won.
    await platform.addModule(pool, op, { tenantId: a, moduleCode: 'voip', couponCode: 'KASIM20', prospectId: lead.id });
    const won = (await pipeline.prospectDetail(pool, lead.id)).prospect;
    assert.equal(won.stage, 'won');
    assert.equal(won.wonTenantId, a);
    await assert.rejects(
      platform.addModule(pool, op, { tenantId: b, moduleCode: 'ai-assistant', prospectId: lead.id }),
      (e) => e.status === 400 || e.status === 409,
    );

    // The legacy office on the root domain gets nothing.
    const legacy = createOfficeCatalog(pool, { tenantId: LEGACY_TENANT_ID });
    assert.equal((await legacy.news(ceo)).card, null);
    assert.equal((await legacy.catalog()).legacy, true);
  } finally {
    await pg.close();
  }
});

test('Modüller page: own modules, buyable products with campaign price, trials and "Talep et"', async () => {
  const { pg, pool } = await database();
  try {
    const { op, a, b } = await setup(pool);
    await campaigns.upsertCampaign(pool, op, {
      name: 'Paket indirimi',
      productCodes: ['sms-1000'],
      discountType: 'amount',
      discountValue: 5000,
      endsAt: soon(),
    });
    await campaigns.upsertCampaign(pool, op, {
      name: 'Yeni bürolara',
      discountType: 'percent',
      discountValue: 50,
      audience: 'new_offices',
      endsAt: soon(),
    });
    const deskA = createOfficeCatalog(pool, { tenantId: a });
    const deskB = createOfficeCatalog(pool, { tenantId: b });

    let page = await deskA.catalog();
    assert.equal(page.subscription.seatLimit, 3);
    assert.ok(page.subscription.used >= 1);
    assert.deepEqual(page.owned, []);
    assert.deepEqual(
      page.products.map((p) => [p.code, p.status]).sort(),
      [['ai-assistant', 'soon'], ['sms-1000', 'selling'], ['voip', 'selling']],
    );
    assert.ok(!page.products.some((p) => p.code === 'hidden'), 'drafts are not listed');
    const pack = page.products.find((p) => p.code === 'sms-1000');
    assert.equal(pack.campaign.name, 'Paket indirimi');
    assert.equal(page.products.find((p) => p.code === 'voip').campaign, null, '"new offices" campaign is not offered');

    // Office B owns voip: it is under "owned", not for sale again.
    const pageB = await deskB.catalog();
    assert.deepEqual(pageB.owned.map((o) => [o.code, o.status, o.priceKurus]), [['voip', 'active', 50000]]);
    assert.ok(!pageB.products.some((p) => p.code === 'voip'));
    await assert.rejects(deskB.requestProduct(ceo, { code: 'voip' }), (e) => e.status === 409);

    // A trial shows as owned with its end date, and the product stays buyable.
    await platform.startTrial(pool, op, { tenantId: a, moduleCode: 'voip' });
    page = await deskA.catalog();
    assert.equal(page.owned[0].status, 'trial');
    assert.ok(page.products.find((p) => p.code === 'voip').trialUntil);

    assert.deepEqual(await deskA.requestProduct(ceo, { code: 'ai-assistant', note: 'Fiyat bilgisi' }), { requested: true, already: false });
    assert.deepEqual(await deskA.requestProduct(admin, { code: 'ai-assistant' }), { requested: true, already: true });
    await assert.rejects(deskA.requestProduct(ceo, { code: 'hidden' }), (e) => e.status === 404);
    await assert.rejects(deskA.requestProduct(ceo, { code: 'nope' }), (e) => e.status === 404);
    assert.equal((await deskA.catalog()).products.find((p) => p.code === 'ai-assistant').requested, true);
    // Office B does not see A's request.
    assert.equal((await deskB.catalog()).products.find((p) => p.code === 'ai-assistant').requested, false);
  } finally {
    await pg.close();
  }
});

test('pipeline: create, move, note, lose with a reason, win by opening the office', async () => {
  const { pg, pool } = await database();
  try {
    const { op } = await setup(pool);
    await assert.rejects(pipeline.createProspect(pool, op, { officeName: 'x' }), (e) => e.status === 400);
    const { id } = await pipeline.createProspect(pool, op, {
      officeName: 'Deniz Hukuk',
      contactName: 'Av. Deniz',
      phone: '05321234567',
      city: 'İzmir',
      source: 'referral',
      expectedUsers: 5,
      productCodes: ['voip'],
      expectedMonthlyKurus: 55000,
      nextActionAt: new Date(Date.now() - 3600000).toISOString(),
    });
    let board = await pipeline.listProspects(pool);
    assert.equal(board.dueToday, 1);
    assert.equal(board.prospects[0].ownerAdminId, op, 'the creator owns it by default');

    await pipeline.moveProspect(pool, op, { id, stage: 'demo' });
    await assert.rejects(pipeline.moveProspect(pool, op, { id, stage: 'won' }), (e) => e.status === 400);
    await assert.rejects(pipeline.moveProspect(pool, op, { id, stage: 'lost' }), (e) => e.status === 400);
    await pipeline.addProspectNote(pool, op, { id, body: 'Demo yapıldı, teklif istiyor.' });
    const detail = await pipeline.prospectDetail(pool, id);
    assert.equal(detail.prospect.stage, 'demo');
    assert.deepEqual(detail.notes.map((n) => n.body), ['Demo yapıldı, teklif istiyor.', 'Aşama: Demo']);

    const opened = await platform.openOffice(pool, op, {
      slug: 'deniz',
      name: 'Deniz Hukuk',
      admin: { name: 'Deniz', username: 'deniz', password: secret },
      userCount: 5,
      userPriceKurus: 1000,
      termMonths: 12,
      moduleCodes: ['voip'],
      prospectId: id,
    });
    const won = (await pipeline.prospectDetail(pool, id)).prospect;
    assert.equal(won.stage, 'won');
    assert.equal(won.wonTenantId, opened.office.id);

    const { id: lost } = await pipeline.createProspect(pool, op, { officeName: 'Kayıp Hukuk' });
    await pipeline.moveProspect(pool, op, { id: lost, stage: 'lost', lostReason: 'Fiyat yüksek bulundu' });
    board = await pipeline.listProspects(pool);
    assert.equal(board.conversionPercent, 50);
    assert.equal(board.byStage.won.count, 1);
    assert.equal(board.byStage.lost.count, 1);
    // Search and filters.
    assert.deepEqual((await pipeline.listProspects(pool, { q: 'kayıp' })).prospects.map((p) => p.officeName), ['Kayıp Hukuk']);
    assert.deepEqual((await pipeline.listProspects(pool, { stage: 'won' })).prospects.map((p) => p.id), [id]);
    // A won prospect cannot be won again.
    await assert.rejects(
      platform.openOffice(pool, op, {
        slug: 'deniz-iki',
        name: 'Deniz 2',
        admin: { name: 'D', username: 'deniz2', password: secret },
        userCount: 1,
        userPriceKurus: 1000,
        termMonths: 1,
        prospectId: id,
      }),
      (e) => e.status === 409,
    );
  } finally {
    await pg.close();
  }
});
