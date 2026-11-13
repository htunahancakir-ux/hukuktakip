const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, serve } = require('./support/postgres.cjs');
const { createPlatformAdmin } = require('../lib/saas/platform-auth.cjs');
const { createPlatformHandler } = require('../lib/platform-app.cjs');
const { createModuleGate } = require('../lib/saas/module-gate.cjs');
const platform = require('../lib/saas/platform.cjs');
const campaigns = require('../lib/saas/campaigns.cjs');

const status = (code) => (error) => error.status === code;
const secret = 'Synthetic-Campaign-Test-Only';
const DAY = 86400000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

test('campaigns and coupons: discounts, limits, audiences, reporting and trials', async (t) => {
  const { pg, pool } = await database();
  try {
    const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Operatör', password: secret + '!' })).id;
    const product = (extra) => platform.upsertModule(pool, { name: 'Ürün', monthlyPriceKurus: 1000, ...extra }, op);
    await product({ code: 'voip', name: 'Çağrı merkezi', monthlyPriceKurus: 5000, status: 'selling', trialDays: 14 });
    await product({ code: 'whatsapp', name: 'WhatsApp', monthlyPriceKurus: 3000, status: 'selling' });
    await product({ code: 'kurulum', name: 'Kurulum', kind: 'service', monthlyPriceKurus: 100000, status: 'selling' });
    await product({ code: 'sms-pack', name: 'SMS paketi', kind: 'usage_pack', packQuantity: 1000, packUnit: 'SMS', monthlyPriceKurus: 25000, status: 'selling' });

    let n = 0;
    const camp = (extra = {}) =>
      campaigns
        .upsertCampaign(pool, op, {
          name: 'Kampanya ' + ++n,
          discountType: 'percent',
          discountValue: 10,
          startsAt: iso(-60_000),
          endsAt: iso(30 * DAY),
          ...extra,
        })
        .then((r) => r.id);
    const office = async (extra = {}) => {
      const slug = 'ofis-' + ++n;
      return platform.openOffice(pool, op, {
        slug,
        name: 'Büro ' + slug,
        admin: { name: 'Ada', username: 'u' + slug.replace(/-/g, ''), password: secret },
        userCount: 5,
        userPriceKurus: 20000,
        termMonths: 12,
        moduleCodes: ['voip'],
        paid: false,
        ...extra,
      });
    };
    const rows = async (tenantId) =>
      (
        await pool.query(
          `SELECT kind, module_code, amount_kurus::int AS amount, campaign_id, status FROM han_saas.sales
           WHERE tenant_id = $1 ORDER BY created_at, amount_kurus DESC`,
          [tenantId],
        )
      ).rows;
    const net = async (tenantId) =>
      Number((await pool.query("SELECT coalesce(sum(amount_kurus), 0)::text AS n FROM han_saas.sales WHERE tenant_id = $1 AND status <> 'void'", [tenantId])).rows[0].n);
    const vat = async (tenantId) =>
      Number((await pool.query("SELECT coalesce(sum(round(amount_kurus::numeric * vat_rate / 100)), 0)::text AS n FROM han_saas.sales WHERE tenant_id = $1 AND status <> 'void'", [tenantId])).rows[0].n);
    const campRow = async (id) => (await pool.query('SELECT * FROM han_saas.campaigns WHERE id = $1', [id])).rows[0];
    const redemptions = async (id) => (await pool.query('SELECT * FROM han_saas.campaign_redemptions WHERE campaign_id = $1', [id])).rows;
    const counts = async () =>
      (await pool.query('SELECT (SELECT count(*) FROM han_saas.tenants)::int t, (SELECT count(*) FROM han_saas.sales)::int s, (SELECT count(*) FROM han_saas.campaign_redemptions)::int r')).rows[0];
    const adjustments = async (tenantId, campaignId) =>
      (await rows(tenantId)).filter((r) => r.kind === 'adjustment' && r.campaign_id === campaignId);

    await t.test('percent discount on a new office: per-line adjustment rows, consistent totals and VAT', async () => {
      const id = await camp({ discountValue: 10 });
      const r = await office({ campaignId: id });
      // users 5 x 200.00 x 12 = 12,000.00; voip 50.00 x 12 = 600.00; 10% off both
      assert.equal(r.totalKurus, 1_260_000);
      assert.equal(r.campaignDiscountKurus, 126_000);
      assert.equal(r.payableKurus, 1_134_000);
      assert.equal(await net(r.office.id), r.payableKurus);
      assert.equal(r.vatKurus, await vat(r.office.id));
      assert.equal(r.vatKurus, 226_800);
      const ledger = await rows(r.office.id);
      assert.deepEqual(
        ledger.map((x) => [x.kind, x.module_code, x.amount, x.campaign_id === id]),
        [
          ['new_office', null, 1_200_000, true],
          ['module', 'voip', 60_000, true],
          ['adjustment', null, -120_000, true],
          ['adjustment', 'voip', -6_000, true],
        ],
      );
      assert.deepEqual([(await campRow(id)).used_count], [1]);
      const red = await redemptions(id);
      assert.deepEqual([red.length, red[0].tenant_id, Number(red[0].discount_kurus), red[0].created_by], [1, r.office.id, 126_000, op]);
      const events = (await pool.query("SELECT detail FROM han_saas.tenant_events WHERE tenant_id = $1 AND action = 'office_opened'", [r.office.id])).rows;
      assert.equal(events[0].detail.campaign, id);
    });

    await t.test('amount and percent rules: product filter, first month, first 3 months, whole term, caps', async () => {
      // first_month 50% on the user licence only: 1,000.00 x 50% x 1 month
      let id = await camp({ discountValue: 50, applies: 'first_month', productCodes: ['users'] });
      let r = await office({ campaignId: id });
      assert.equal(r.campaignDiscountKurus, 50_000);
      assert.deepEqual((await adjustments(r.office.id, id)).map((x) => [x.module_code, x.amount]), [[null, -50_000]]);

      // first_3_months 25.00 per month on users and voip: 3 x 25.00 each
      id = await camp({ discountType: 'amount', discountValue: 2500, applies: 'first_3_months', productCodes: ['users', 'voip'] });
      r = await office({ campaignId: id });
      assert.equal(r.campaignDiscountKurus, 7_500 + 7_500);
      assert.deepEqual((await adjustments(r.office.id, id)).map((x) => [x.module_code, x.amount]).sort(), [[null, -7_500], ['voip', -7_500]].sort());

      // amount is capped by the monthly price, whole term: voip 50.00 x 12 = the whole line
      id = await camp({ discountType: 'amount', discountValue: 1_000_000, productCodes: ['voip'] });
      r = await office({ campaignId: id });
      assert.equal(r.campaignDiscountKurus, 60_000);
      assert.equal(await net(r.office.id), 1_200_000);

      // 100% of everything, whole term: free, but never negative
      id = await camp({ discountValue: 100 });
      r = await office({ campaignId: id });
      assert.deepEqual([r.campaignDiscountKurus, r.payableKurus, r.vatKurus], [1_260_000, 0, 0]);
      assert.equal(await net(r.office.id), 0);

      // a term shorter than the campaign window: first_3_months on a 2-month term is only 2 months
      id = await camp({ discountType: 'amount', discountValue: 1000, applies: 'first_3_months', productCodes: ['users'] });
      r = await office({ campaignId: id, termMonths: 2 });
      assert.equal(r.campaignDiscountKurus, 2_000);

      // empty product list = everything, including a module not on the first office
      id = await camp({ discountValue: 10, applies: 'first_month' });
      r = await office({ campaignId: id, moduleCodes: ['voip', 'whatsapp'] });
      assert.equal(r.campaignDiscountKurus, 10_000 + 500 + 300);
    });

    await t.test('a manual discount adds to the campaign, but together they cannot exceed the total', async () => {
      const id = await camp({ discountValue: 10 });
      const r = await office({ campaignId: id, discountKurus: 10_000 });
      assert.equal(r.payableKurus, 1_260_000 - 126_000 - 10_000);
      assert.equal(await net(r.office.id), r.payableKurus);
      assert.equal(r.vatKurus, await vat(r.office.id));

      const id2 = await camp({ discountValue: 10 });
      const before = await counts();
      await assert.rejects(office({ campaignId: id2, discountKurus: 1_200_000 }), status(400));
      assert.deepEqual(await counts(), before, 'no office, sale or redemption was left behind');
      assert.equal((await campRow(id2)).used_count, 0);
    });

    await t.test('addModule: prorated charge, discount rows, first-month and prorated whole-term discounts', async () => {
      const o = (await office({ moduleCodes: [], paid: true })).office;
      let id = await camp({ discountValue: 20, applies: 'first_month', productCodes: ['voip'] });
      const added = await platform.addModule(pool, op, { tenantId: o.id, moduleCode: 'voip', campaignId: id });
      assert.ok(added.chargeKurus > 5000 * 11.9 && added.chargeKurus < 5000 * 12.2, String(added.chargeKurus));
      assert.equal(added.campaignDiscountKurus, 1000, '20% of one 50.00 month');
      const ledger = await rows(o.id);
      const module = ledger.find((x) => x.kind === 'module');
      assert.deepEqual([module.module_code, module.amount, module.campaign_id], ['voip', added.chargeKurus, id]);
      assert.deepEqual((await adjustments(o.id, id)).map((x) => [x.module_code, x.amount]), [['voip', -1000]]);
      assert.equal(await net(o.id), 1_200_000 + added.chargeKurus - 1000);
      assert.equal(added.vatKurus, (await vat(o.id)) - 240_000);
      assert.equal((await campRow(id)).used_count, 1);

      // whole term, percent: about 30% of the prorated charge
      const p = (await office({ moduleCodes: [], paid: true })).office;
      id = await camp({ discountValue: 30, productCodes: ['whatsapp'] });
      const wa = await platform.addModule(pool, op, { tenantId: p.id, moduleCode: 'whatsapp', campaignId: id });
      assert.ok(Math.abs(wa.campaignDiscountKurus - wa.chargeKurus * 0.3) <= 1, `${wa.campaignDiscountKurus} vs ${wa.chargeKurus}`);

      // amount per month x remaining months (about 12), capped by the line
      const q = (await office({ moduleCodes: [], paid: true })).office;
      id = await camp({ discountType: 'amount', discountValue: 1000, productCodes: ['voip'] });
      const va = await platform.addModule(pool, op, { tenantId: q.id, moduleCode: 'voip', campaignId: id });
      assert.ok(va.campaignDiscountKurus > 1000 * 11.9 && va.campaignDiscountKurus < 12_200, String(va.campaignDiscountKurus));
      assert.equal(await net(q.id), 1_200_000 + va.chargeKurus - va.campaignDiscountKurus);
    });

    await t.test('addModule: an override of 0, or a campaign for other products, is a 400 and changes nothing', async () => {
      const o = (await office({ moduleCodes: [], paid: true })).office;
      const id = await camp({ productCodes: ['voip'] });
      const before = await counts();
      await assert.rejects(platform.addModule(pool, op, { tenantId: o.id, moduleCode: 'voip', chargeKurus: 0, campaignId: id }), status(400));
      const other = await camp({ productCodes: ['whatsapp'] });
      await assert.rejects(platform.addModule(pool, op, { tenantId: o.id, moduleCode: 'voip', campaignId: other }), status(400));
      assert.deepEqual(await counts(), before);
      assert.equal((await pool.query('SELECT count(*)::int n FROM han_saas.tenant_modules WHERE tenant_id = $1', [o.id])).rows[0].n, 0, 'the module was not added');
      assert.equal((await campRow(id)).used_count + (await campRow(other)).used_count, 0);
    });

    await t.test('renewOffice: discount on the renewal total, consistent with the ledger', async () => {
      const o = (await office({ paid: true })).office;
      const id = await camp({ discountValue: 10, productCodes: ['users'] });
      const before = await net(o.id);
      const r = await platform.renewOffice(pool, op, { tenantId: o.id, termMonths: 6, campaignId: id });
      // 5 x 200.00 x 6 = 6,000.00 + voip 50.00 x 6 = 300.00
      assert.equal(r.totalKurus, 630_000);
      assert.equal(r.campaignDiscountKurus, 60_000);
      assert.equal(r.payableKurus, 570_000);
      assert.equal(await net(o.id), before + r.payableKurus);
      const ledger = await rows(o.id);
      const renewal = ledger.find((x) => x.kind === 'renewal');
      assert.deepEqual([renewal.amount, renewal.campaign_id], [630_000, id]);
      assert.deepEqual((await adjustments(o.id, id)).map((x) => [x.module_code, x.amount]), [[null, -60_000]]);
      assert.equal(r.vatKurus, (await vat(o.id)) - 240_000 - 12_000);

      // manual discount plus campaign above the total is refused, and the campaign is not spent
      const id2 = await camp({ discountValue: 10 });
      const o2 = (await office({ paid: true })).office;
      const sales = (await counts()).s;
      await assert.rejects(platform.renewOffice(pool, op, { tenantId: o2.id, termMonths: 1, campaignId: id2, discountKurus: 105_000 }), status(400));
      assert.equal((await counts()).s, sales);
      assert.equal((await campRow(id2)).used_count, 0);
      // and a second renewal with the same campaign: one use per office
      await assert.rejects(platform.renewOffice(pool, op, { tenantId: o.id, termMonths: 1, campaignId: id }), status(409));
    });

    await t.test('sellProduct: percent and amount discounts on one-off products', async () => {
      const o = (await office({ paid: true })).office;
      let id = await camp({ discountValue: 25, productCodes: ['kurulum'] });
      let sold = await platform.sellProduct(pool, op, { tenantId: o.id, code: 'kurulum', quantity: 2, campaignId: id });
      assert.deepEqual([sold.amountKurus, sold.campaignDiscountKurus, sold.payableKurus], [200_000, 50_000, 150_000]);
      assert.equal(sold.vatKurus, 40_000 - 10_000);
      const ledger = await rows(o.id);
      const base = ledger.find((x) => x.kind === 'service');
      assert.deepEqual([base.module_code, base.amount, base.campaign_id], ['kurulum', 200_000, id]);
      assert.deepEqual((await adjustments(o.id, id)).map((x) => [x.module_code, x.amount]), [['kurulum', -50_000]]);

      // amount per unit x quantity (all products), capped by the sale amount
      id = await camp({ discountType: 'amount', discountValue: 15_000 });
      sold = await platform.sellProduct(pool, op, { tenantId: o.id, code: 'sms-pack', quantity: 3, campaignId: id });
      assert.deepEqual([sold.amountKurus, sold.campaignDiscountKurus], [75_000, 45_000]);
      const pack = (await rows(o.id)).find((x) => x.kind === 'usage_pack');
      assert.deepEqual([pack.module_code, pack.campaign_id], ['sms-pack', id]);
      const o2 = (await office({ paid: true })).office;
      id = await camp({ discountType: 'amount', discountValue: 15_000 });
      sold = await platform.sellProduct(pool, op, { tenantId: o2.id, code: 'sms-pack', quantity: 3, chargeKurus: 20_000, campaignId: id });
      assert.deepEqual([sold.amountKurus, sold.campaignDiscountKurus, sold.payableKurus, sold.vatKurus], [20_000, 20_000, 0, 0], 'capped by the overridden amount');
      assert.equal(await net(o2.id), 1_200_000 + 60_000 - 0, 'only the opening sales remain after a full discount');
    });

    await t.test('coupon codes are case-insensitive and found by code instead of id', async () => {
      const id = await camp({ couponCode: ' yaz-kampanya ', discountValue: 10, productCodes: ['kurulum'] });
      assert.equal((await campRow(id)).coupon_code, 'YAZ-KAMPANYA');
      const o = (await office({ paid: true })).office;
      const sold = await platform.sellProduct(pool, op, { tenantId: o.id, code: 'kurulum', couponCode: 'yaz-Kampanya' });
      assert.equal(sold.campaignDiscountKurus, 10_000);
      const o2 = (await office({ paid: true })).office;
      assert.equal((await platform.sellProduct(pool, op, { tenantId: o2.id, code: 'kurulum', couponCode: 'YAZ-KAMPANYA' })).campaignDiscountKurus, 10_000);
      assert.equal((await campRow(id)).used_count, 2);
      for (const bad of ['NOPE-CODE', '!!', 'ab'])
        await assert.rejects(platform.sellProduct(pool, op, { tenantId: o.id, code: 'kurulum', couponCode: bad }), status(404), bad);
      // a coupon works when opening an office too
      const c2 = await camp({ couponCode: 'ACELE25', discountValue: 25, productCodes: ['users'] });
      const r = await office({ couponCode: 'acele25' });
      assert.equal(r.campaignDiscountKurus, 300_000);
      assert.equal((await campRow(c2)).used_count, 1);
      assert.equal((await campaigns.listCampaigns(pool)).find((c) => c.id === id).couponCode, 'YAZ-KAMPANYA');
    });

    await t.test('coupon codes with the letter i are case-insensitive too (no Turkish dotted I)', async () => {
      const id = await camp({ couponCode: 'Kasim20', discountValue: 10, productCodes: ['kurulum'] });
      assert.equal((await campRow(id)).coupon_code, 'KASIM20');
      const o = (await office({ paid: true })).office;
      const sold = await platform.sellProduct(pool, op, { tenantId: o.id, code: 'kurulum', couponCode: 'kasim20' });
      assert.equal(sold.campaignDiscountKurus, 10_000);
      assert.equal((await campRow(id)).used_count, 1);
      await assert.rejects(camp({ couponCode: 'kasim20' }), status(409));
    });

    await t.test('lifecycle: not started, expired, paused, ended are refused; reactivation works', async () => {
      const o = (await office({ paid: true })).office;
      const sell = (id) => platform.sellProduct(pool, op, { tenantId: o.id, code: 'kurulum', campaignId: id });
      const future = await camp({ startsAt: iso(DAY), endsAt: iso(2 * DAY) });
      const expired = await camp({ startsAt: iso(-2 * DAY), endsAt: iso(-DAY) });
      const paused = await camp({});
      const ended = await camp({});
      for (const id of [future, expired, paused, ended]) assert.equal((await campRow(id)).used_count, 0);
      await campaigns.setCampaignStatus(pool, op, { id: paused, status: 'paused' });
      await campaigns.setCampaignStatus(pool, op, { id: ended, status: 'ended' });
      const before = await counts();
      for (const id of [future, expired, paused, ended]) await assert.rejects(sell(id), status(409), id);
      assert.deepEqual(await counts(), before);
      // the same through the coupon route
      await camp({ couponCode: 'GELECEK1', startsAt: iso(DAY), endsAt: iso(2 * DAY) });
      await assert.rejects(platform.sellProduct(pool, op, { tenantId: o.id, code: 'kurulum', couponCode: 'gelecek1' }), status(409));
      // an expired campaign by edit: end date moved into the past while it is still unused
      const wasLive = await camp({});
      await pool.query("UPDATE han_saas.campaigns SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 minute' WHERE id = $1", [wasLive]);
      await assert.rejects(sell(wasLive), status(409));
      // reactivate
      await campaigns.setCampaignStatus(pool, op, { id: paused, status: 'active' });
      assert.equal((await sell(paused)).campaignDiscountKurus, 10_000);
      // bad status updates
      await assert.rejects(campaigns.setCampaignStatus(pool, op, { id: paused, status: 'deleted' }), status(400));
      await assert.rejects(campaigns.setCampaignStatus(pool, op, { id: '44444444-4444-4444-8444-444444444444', status: 'paused' }), status(404));
      await assert.rejects(campaigns.setCampaignStatus(pool, op, { id: 'x', status: 'paused' }), status(404));
      await assert.rejects(sell('not-a-uuid'), status(404));
      await assert.rejects(sell('55555555-5555-4555-8555-555555555555'), status(404));
    });

    await t.test('max_uses: enforced, counted, and not lowerable below the use so far', async () => {
      const id = await camp({ maxUses: 2 });
      const [a, b, c] = [(await office({ paid: true })).office, (await office({ paid: true })).office, (await office({ paid: true })).office];
      const sell = (o) => platform.sellProduct(pool, op, { tenantId: o.id, code: 'kurulum', campaignId: id });
      await sell(a);
      await sell(b);
      await assert.rejects(sell(c), status(409));
      assert.equal((await campRow(id)).used_count, 2);
      assert.equal((await redemptions(id)).length, 2);
      const listed = (await campaigns.listCampaigns(pool)).find((x) => x.id === id);
      assert.deepEqual([listed.usedCount, listed.maxUses], [2, 2]);
      await assert.rejects(campaigns.upsertCampaign(pool, op, { id, name: 'Kampanya', discountType: 'percent', discountValue: 10, endsAt: iso(DAY), maxUses: 1 }), status(400));
      await campaigns.upsertCampaign(pool, op, { id, name: 'Kampanya', discountType: 'percent', discountValue: 10, endsAt: iso(DAY), maxUses: 3 });
      await sell(c);
      assert.equal((await campRow(id)).used_count, 3);
    });

    await t.test('max_uses = 1 with two concurrent sales: exactly one succeeds', async () => {
      const id = await camp({ maxUses: 1 });
      const [a, b] = [(await office({ paid: true })).office, (await office({ paid: true })).office];
      const results = await Promise.allSettled(
        [a, b].map((o) => platform.sellProduct(pool, op, { tenantId: o.id, code: 'kurulum', campaignId: id })),
      );
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const failed = results.find((r) => r.status === 'rejected');
      assert.equal(failed.reason.status, 409);
      assert.equal((await campRow(id)).used_count, 1);
      assert.equal((await redemptions(id)).length, 1);
      const sold = (await pool.query('SELECT count(*)::int n FROM han_saas.sales WHERE campaign_id = $1', [id])).rows[0].n;
      assert.equal(sold, 2, 'one base row and one discount row, nothing from the loser');
    });

    await t.test('max_uses = 1 with two concurrent new offices: exactly one is opened', async () => {
      const id = await camp({ maxUses: 1 });
      const before = await counts();
      const results = await Promise.allSettled([office({ campaignId: id }), office({ campaignId: id })]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
      assert.equal((await counts()).t, before.t + 1);
      assert.equal((await campRow(id)).used_count, 1);
    });

    await t.test('one redemption per office and campaign; another office can still use it', async () => {
      const id = await camp({});
      const [a, b] = [(await office({ paid: true })).office, (await office({ paid: true })).office];
      await platform.sellProduct(pool, op, { tenantId: a.id, code: 'kurulum', campaignId: id });
      const before = await counts();
      await assert.rejects(platform.sellProduct(pool, op, { tenantId: a.id, code: 'kurulum', campaignId: id }), status(409));
      await assert.rejects(platform.renewOffice(pool, op, { tenantId: a.id, termMonths: 1, campaignId: id }), status(409));
      await assert.rejects(platform.addModule(pool, op, { tenantId: a.id, moduleCode: 'whatsapp', campaignId: id }), status(409));
      assert.deepEqual(await counts(), before);
      assert.equal((await pool.query("SELECT count(*)::int n FROM han_saas.tenant_modules WHERE tenant_id = $1 AND module_code = 'whatsapp'", [a.id])).rows[0].n, 0);
      await platform.sellProduct(pool, op, { tenantId: b.id, code: 'kurulum', campaignId: id });
      assert.equal((await campRow(id)).used_count, 2);
      // a plain sale to the same office, without the campaign, is unaffected
      await platform.sellProduct(pool, op, { tenantId: a.id, code: 'kurulum' });
    });

    await t.test('audience new_offices: only when opening an office', async () => {
      const id = await camp({ audience: 'new_offices' });
      const existing = (await office({ paid: true })).office;
      await assert.rejects(platform.sellProduct(pool, op, { tenantId: existing.id, code: 'kurulum', campaignId: id }), status(409));
      await assert.rejects(platform.renewOffice(pool, op, { tenantId: existing.id, termMonths: 1, campaignId: id }), status(409));
      await assert.rejects(platform.addModule(pool, op, { tenantId: existing.id, moduleCode: 'whatsapp', campaignId: id }), status(409));
      assert.equal((await campRow(id)).used_count, 0);
      const fresh = await office({ campaignId: id });
      assert.equal(fresh.campaignDiscountKurus, 126_000);
    });

    await t.test('audience selected: only the listed offices, never a new one', async () => {
      const [a, b] = [(await office({ paid: true })).office, (await office({ paid: true })).office];
      await assert.rejects(camp({ audience: 'selected' }), status(400));
      await assert.rejects(camp({ audience: 'selected', tenantIds: [] }), status(400));
      await assert.rejects(camp({ audience: 'selected', tenantIds: ['nope'] }), status(400));
      const id = await camp({ audience: 'selected', tenantIds: [a.id, a.id] });
      assert.deepEqual((await campRow(id)).tenant_ids, [a.id], 'deduplicated');
      await assert.rejects(platform.sellProduct(pool, op, { tenantId: b.id, code: 'kurulum', campaignId: id }), status(409));
      await assert.rejects(office({ campaignId: id }), status(409));
      assert.equal((await platform.sellProduct(pool, op, { tenantId: a.id, code: 'kurulum', campaignId: id })).campaignDiscountKurus, 10_000);
      // tenant ids are dropped for the other audiences
      const open = await camp({ audience: 'all', tenantIds: [a.id] });
      assert.deepEqual((await campRow(open)).tenant_ids, []);
    });

    await t.test('audience without_product: not for offices that already own the product', async () => {
      const owner = (await office({ paid: true })).office; // owns voip
      const lacking = (await office({ moduleCodes: [], paid: true })).office;
      // one-off products never count as owned; a module does
      const kurulum = await camp({ audience: 'without_product', productCodes: ['kurulum'] });
      assert.equal((await platform.sellProduct(pool, op, { tenantId: owner.id, code: 'kurulum', campaignId: kurulum })).campaignDiscountKurus, 10_000);
      const voip = await camp({ audience: 'without_product', productCodes: ['voip'], discountValue: 20, applies: 'first_month' });
      const quoted = await campaigns.quote(pool, { campaignId: voip, tenantId: lacking.id, lines: [{ code: 'voip', monthlyKurus: 5000, months: 12, amountKurus: 60_000 }] });
      assert.equal(quoted.discountKurus, 1000, 'an office without the module is eligible');
      await assert.rejects(
        campaigns.quote(pool, { campaignId: voip, tenantId: owner.id, lines: [{ code: 'voip', monthlyKurus: 5000, months: 12, amountKurus: 60_000 }] }),
        status(409),
      );
      // a new office has nothing yet
      assert.equal((await office({ campaignId: voip })).campaignDiscountKurus, 1000);
      assert.equal((await campRow(voip)).used_count, 1);
    });

    await t.test('audience without_product: addModule applies it to the office that is buying the module', async () => {
      const lacking = (await office({ moduleCodes: [], paid: true })).office;
      const id = await camp({ audience: 'without_product', productCodes: ['voip'], discountValue: 20, applies: 'first_month' });
      const added = await platform.addModule(pool, op, { tenantId: lacking.id, moduleCode: 'voip', campaignId: id });
      assert.equal(added.campaignDiscountKurus, 1000);
    });

    await t.test('audience trialing: only for offices testing the product', async () => {
      const testing = (await office({ moduleCodes: [], paid: true })).office;
      const idle = (await office({ moduleCodes: [], paid: true })).office;
      await platform.startTrial(pool, op, { tenantId: testing.id, moduleCode: 'voip' });
      const id = await camp({ audience: 'trialing', productCodes: ['voip'], discountValue: 20, applies: 'first_month' });
      const lines = [{ code: 'voip', monthlyKurus: 5000, months: 12, amountKurus: 60_000 }];
      assert.equal((await campaigns.quote(pool, { campaignId: id, tenantId: testing.id, lines })).discountKurus, 1000);
      await assert.rejects(campaigns.quote(pool, { campaignId: id, tenantId: idle.id, lines }), status(409));
      await assert.rejects(platform.addModule(pool, op, { tenantId: idle.id, moduleCode: 'voip', campaignId: id }), status(409));
      assert.equal((await pool.query("SELECT count(*)::int n FROM han_saas.tenant_modules WHERE tenant_id = $1", [idle.id])).rows[0].n, 0);
    });

    await t.test('audience trialing: buying the module during the trial gets the campaign', async () => {
      const testing = (await office({ moduleCodes: [], paid: true })).office;
      await platform.startTrial(pool, op, { tenantId: testing.id, moduleCode: 'voip' });
      const id = await camp({ audience: 'trialing', productCodes: ['voip'], discountValue: 20, applies: 'first_month' });
      const added = await platform.addModule(pool, op, { tenantId: testing.id, moduleCode: 'voip', campaignId: id });
      assert.equal(added.campaignDiscountKurus, 1000);
      assert.equal((await redemptions(id)).length, 1);
    });

    await t.test('a campaign that does not apply to any product of the sale is a 400 and is not spent', async () => {
      const id = await camp({ productCodes: ['whatsapp'] });
      const before = await counts();
      await assert.rejects(office({ campaignId: id }), status(400));
      await assert.rejects(office({ campaignId: id, moduleCodes: [] }), status(400));
      const o = (await office({ paid: true })).office;
      const sales = (await counts()).s;
      await assert.rejects(platform.sellProduct(pool, op, { tenantId: o.id, code: 'kurulum', campaignId: id }), status(400));
      await assert.rejects(platform.renewOffice(pool, op, { tenantId: o.id, termMonths: 1, campaignId: id }), status(400));
      assert.equal((await counts()).s, sales);
      assert.equal(before.t + 1, (await counts()).t);
      assert.equal((await campRow(id)).used_count, 0);
      // zero-amount sale: nothing to discount
      const free = await camp({});
      await assert.rejects(platform.sellProduct(pool, op, { tenantId: o.id, code: 'kurulum', chargeKurus: 0, campaignId: free }), status(400));
      assert.equal((await campRow(free)).used_count, 0);
    });

    await t.test('editing a used campaign: terms are locked (409), name, end, limit and coupon can change', async () => {
      const id = await camp({ discountValue: 10, productCodes: ['kurulum', 'sms-pack'], couponCode: 'KILIT10' });
      const unused = { id, name: 'Kampanya', discountType: 'percent', discountValue: 15, productCodes: ['kurulum'], endsAt: iso(5 * DAY) };
      await campaigns.upsertCampaign(pool, op, unused); // unused: any change is fine
      assert.equal(Number((await campRow(id)).discount_value), 15);
      const o = (await office({ paid: true })).office;
      await platform.sellProduct(pool, op, { tenantId: o.id, code: 'kurulum', campaignId: id });
      const same = { ...unused, name: 'Yeni ad', endsAt: iso(9 * DAY), maxUses: 50, couponCode: 'ocak-kod', startsAt: iso(-DAY) };
      await campaigns.upsertCampaign(pool, op, same);
      const after = await campRow(id);
      assert.deepEqual([after.name, after.coupon_code, after.max_uses, after.used_count], ['Yeni ad', 'OCAK-KOD', 50, 1]);
      for (const change of [
        { discountValue: 16 },
        { discountType: 'amount', discountValue: 15 },
        { applies: 'first_month' },
        { productCodes: ['kurulum', 'sms-pack'] },
        { productCodes: [] },
      ])
        await assert.rejects(campaigns.upsertCampaign(pool, op, { ...same, ...change }), status(409), JSON.stringify(change));
      const kept = await campRow(id);
      assert.deepEqual([Number(kept.discount_value), kept.discount_type, kept.applies, kept.product_codes], [15, 'percent', 'whole_term', ['kurulum']]);
      await assert.rejects(campaigns.upsertCampaign(pool, op, { ...same, id: '66666666-6666-4666-8666-666666666666' }), status(404));
      await assert.rejects(campaigns.upsertCampaign(pool, op, { ...same, id: 'x' }), status(404));
    });

    await t.test('duplicate coupon codes are a 409 on create and on edit, whatever the letter case', async () => {
      await camp({ couponCode: 'DUPLO-ONE' });
      await assert.rejects(camp({ couponCode: 'DUPLO-ONE' }), status(409));
      await assert.rejects(camp({ couponCode: 'duplo-one' }), status(409));
      const other = await camp({ couponCode: 'DUPLO-TWO' });
      await assert.rejects(campaigns.upsertCampaign(pool, op, { id: other, name: 'Kampanya', discountType: 'percent', discountValue: 10, endsAt: iso(DAY), couponCode: 'duplo-one' }), status(409));
      assert.equal((await campRow(other)).coupon_code, 'DUPLO-TWO', 'the failed edit changed nothing');
      // keeping your own coupon on edit is fine; two campaigns can both have none
      await campaigns.upsertCampaign(pool, op, { id: other, name: 'Kampanya', discountType: 'percent', discountValue: 10, endsAt: iso(DAY), couponCode: 'DUPLO-TWO' });
      await camp({});
      await camp({});
    });

    await t.test('campaign input validation', async () => {
      const SAME = iso(DAY);
      const bad = [
        { name: 'A' },
        { name: 'x'.repeat(121) },
        { name: undefined },
        { discountType: 'free' },
        { discountValue: 0 },
        { discountValue: 101 },
        { discountValue: 10.5 },
        { discountValue: '10' },
        { discountType: 'amount', discountValue: 100_000_001 },
        { applies: 'forever' },
        { audience: 'vip' },
        { endsAt: undefined },
        { endsAt: 'yarın' },
        { startsAt: iso(2 * DAY), endsAt: iso(DAY) },
        { startsAt: SAME, endsAt: SAME },
        { couponCode: 'ab' },
        { couponCode: 'has space' },
        { couponCode: 'x'.repeat(31) },
        { maxUses: 0 },
        { maxUses: 100_001 },
        { maxUses: 1.5 },
        { productCodes: 'voip' },
        { productCodes: ['Voip'] },
        { productCodes: [5] },
        { productCodes: Array.from({ length: 51 }, (_, i) => 'p' + String(i).padStart(2, '0')) },
      ];
      const before = (await pool.query('SELECT count(*)::int n FROM han_saas.campaigns')).rows[0].n;
      for (const extra of bad) await assert.rejects(camp(extra), status(400), JSON.stringify(extra));
      assert.equal((await pool.query('SELECT count(*)::int n FROM han_saas.campaigns')).rows[0].n, before);
      // percent 100 and amount up to the limit are fine; products are deduplicated
      const id = await camp({ discountValue: 100, productCodes: ['voip', 'voip', 'users'], maxUses: null });
      assert.deepEqual((await campRow(id)).product_codes, ['voip', 'users']);
      await camp({ discountType: 'amount', discountValue: 100_000_000 });
    });

    await t.test('listCampaigns: used count, revenue, discount given, live flag; voided sales drop out', async () => {
      const id = await camp({ discountValue: 10, couponCode: 'RAPOR10' });
      const idle = await camp({});
      const r = await office({ campaignId: id });
      let c = (await campaigns.listCampaigns(pool)).find((x) => x.id === id);
      assert.deepEqual(
        [c.usedCount, c.revenueKurus, c.discountKurus, c.live, c.status, c.couponCode, c.name.startsWith('Kampanya')],
        [1, 1_260_000, 126_000, true, 'active', 'RAPOR10', true],
      );
      assert.equal(c.discountType, 'percent');
      assert.equal(c.discountValue, 10);
      const idleRow = (await campaigns.listCampaigns(pool)).find((x) => x.id === idle);
      assert.deepEqual([idleRow.usedCount, idleRow.revenueKurus, idleRow.discountKurus, idleRow.live], [0, 0, 0, true]);
      // newest campaign first
      const all = await campaigns.listCampaigns(pool);
      assert.ok(all.findIndex((x) => x.id === idle) < all.findIndex((x) => x.id === id));
      // voided rows are not counted
      const ledger = (await pool.query("SELECT id, kind, module_code FROM han_saas.sales WHERE tenant_id = $1 AND campaign_id = $2", [r.office.id, id])).rows;
      const voipDiscount = ledger.find((x) => x.kind === 'adjustment' && x.module_code === 'voip');
      const voipSale = ledger.find((x) => x.kind === 'module');
      await platform.voidSale(pool, op, { saleId: voipDiscount.id, reason: 'Hatalı giriş' });
      await platform.voidSale(pool, op, { saleId: voipSale.id, reason: 'Hatalı giriş' });
      c = (await campaigns.listCampaigns(pool)).find((x) => x.id === id);
      assert.deepEqual([c.revenueKurus, c.discountKurus, c.usedCount], [1_200_000, 120_000, 1]);
      // paused, ended or expired campaigns are not live
      await campaigns.setCampaignStatus(pool, op, { id, status: 'paused' });
      assert.equal((await campaigns.listCampaigns(pool)).find((x) => x.id === id).live, false);
      const gone = await camp({});
      await pool.query("UPDATE han_saas.campaigns SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' WHERE id = $1", [gone]);
      const goneRow = (await campaigns.listCampaigns(pool)).find((x) => x.id === gone);
      assert.deepEqual([goneRow.live, goneRow.status], [false, 'active']);
    });

    await t.test('quote: previews the discount without spending the campaign', async () => {
      const id = await camp({ discountValue: 10, applies: 'first_month', productCodes: ['users', 'kurulum'], couponCode: 'TEKLE10' });
      const lines = [
        { code: 'users', monthlyKurus: 100_000, months: 12, amountKurus: 1_200_000 },
        { code: 'voip', monthlyKurus: 5000, months: 12, amountKurus: 60_000 },
        { code: 'kurulum', oneOff: true, quantity: 2, amountKurus: 200_000 },
      ];
      const q = await campaigns.quote(pool, { campaignId: id, lines });
      assert.deepEqual(q.campaign.id, id);
      assert.deepEqual(q.lines.map((l) => [l.code, l.discountKurus]), [['users', 10_000], ['voip', 0], ['kurulum', 20_000]]);
      assert.equal(q.discountKurus, 30_000);
      const byCoupon = await campaigns.quote(pool, { couponCode: 'tekle10', lines });
      assert.equal(byCoupon.discountKurus, 30_000);
      assert.equal((await campRow(id)).used_count, 0);
      assert.equal((await redemptions(id)).length, 0);
      // same figures as the real sale
      const o = (await office({ moduleCodes: [], paid: true })).office;
      const sold = await platform.sellProduct(pool, op, { tenantId: o.id, code: 'kurulum', quantity: 2, campaignId: id });
      assert.equal(sold.campaignDiscountKurus, q.lines[2].discountKurus);
      // the quote refuses what the sale would refuse
      await assert.rejects(campaigns.quote(pool, { campaignId: id, tenantId: o.id, lines }), status(409), 'already used by this office');
      await campaigns.setCampaignStatus(pool, op, { id, status: 'paused' });
      await assert.rejects(campaigns.quote(pool, { campaignId: id, lines }), status(409));
      await assert.rejects(campaigns.quote(pool, { couponCode: 'NOPE-NOPE', lines }), status(404));
      // bad lines
      for (const badLines of [undefined, [], 'x', [{ code: 'Bad!', amountKurus: 1 }], [{ code: 'voip', amountKurus: -1 }], [{ code: 'voip', amountKurus: 1.5 }], Array.from({ length: 61 }, () => ({ code: 'voip', amountKurus: 1 }))])
        await assert.rejects(campaigns.quote(pool, { campaignId: id, lines: badLines }), status(400), JSON.stringify(badLines)?.slice(0, 40));
      // pure discountLines: never above the line, zero amounts untouched
      const pure = campaigns.discountLines(
        { discount_type: 'amount', discount_value: '999999', applies: 'whole_term', product_codes: [] },
        [{ code: 'voip', monthlyKurus: 5000, months: 2, amountKurus: 10_000 }, { code: 'x', oneOff: true, amountKurus: 0, quantity: 1 }],
      );
      assert.deepEqual(pure.map((l) => l.discountKurus), [10_000, 0]);
    });

    await t.test('trial: starts for the product trial days, the gate opens, one trial per office and module', async () => {
      const o = (await office({ moduleCodes: [], paid: true })).office;
      const gate = createModuleGate(pool, { tenantId: o.id, cacheMs: 0 });
      assert.equal(await gate.enabled('voip'), false);
      const started = await platform.startTrial(pool, op, { tenantId: o.id, moduleCode: 'voip' });
      assert.equal(started.days, 14);
      const left = (new Date(started.trialUntil) - Date.now()) / DAY;
      assert.ok(left > 13.9 && left < 14.1, String(left));
      const row = (await pool.query("SELECT status, trial_until, price_kurus::int p FROM han_saas.tenant_modules WHERE tenant_id = $1 AND module_code = 'voip'", [o.id])).rows[0];
      assert.deepEqual([row.status, row.p], ['trial', 5000]);
      assert.equal(await gate.enabled('voip'), true, 'a running trial switches the feature on');
      assert.deepEqual(await gate.all(), { voip: true, 'ai-assistant': false, whatsapp: false, 'marketing-routes': false, 'marketing-routes-service': false });
      assert.equal((await pool.query("SELECT count(*)::int n FROM han_saas.tenant_events WHERE tenant_id = $1 AND action = 'trial_started'", [o.id])).rows[0].n, 1);
      // no sale is booked for a free trial, and the product does not count it as a subscribed office
      assert.equal((await rows(o.id)).length, 1, 'only the opening sale');
      // a second trial of the same module is refused, also with another length
      await assert.rejects(platform.startTrial(pool, op, { tenantId: o.id, moduleCode: 'voip' }), status(409));
      await assert.rejects(platform.startTrial(pool, op, { tenantId: o.id, moduleCode: 'voip', days: 3 }), status(409));
    });

    await t.test('trial: custom length, bounds, product rules and unknown offices', async () => {
      const o = (await office({ moduleCodes: [], paid: true })).office;
      const short = await platform.startTrial(pool, op, { tenantId: o.id, moduleCode: 'whatsapp', days: 3 });
      assert.equal(short.days, 3);
      const p = (await office({ moduleCodes: [], paid: true })).office;
      // whatsapp has no default trial length, so one must be given
      await assert.rejects(platform.startTrial(pool, op, { tenantId: p.id, moduleCode: 'whatsapp' }), status(400));
      for (const days of [0, -1, 61, 1.5, '7'])
        await assert.rejects(platform.startTrial(pool, op, { tenantId: p.id, moduleCode: 'voip', days }), status(400), String(days));
      await platform.startTrial(pool, op, { tenantId: p.id, moduleCode: 'voip', days: 60 });
      await product({ code: 'soon-mod', status: 'soon', trialDays: 5 });
      await product({ code: 'draft-mod', status: 'draft', trialDays: 5 });
      await product({ code: 'old-mod', status: 'retired', trialDays: 5 });
      assert.equal((await platform.startTrial(pool, op, { tenantId: p.id, moduleCode: 'soon-mod' })).days, 5, 'an announced module can be tried');
      for (const moduleCode of ['draft-mod', 'old-mod', 'kurulum', 'sms-pack', 'nothing', 'Bad!', undefined])
        await assert.rejects(platform.startTrial(pool, op, { tenantId: p.id, moduleCode }), status(400), String(moduleCode));
      await assert.rejects(platform.startTrial(pool, op, { tenantId: 'x', moduleCode: 'voip' }), status(404));
      await assert.rejects(platform.startTrial(pool, op, { tenantId: '77777777-7777-4777-8777-777777777777', moduleCode: 'voip' }), status(404));
      // an already active module cannot be tried
      const owner = (await office({ paid: true })).office;
      await assert.rejects(platform.startTrial(pool, op, { tenantId: owner.id, moduleCode: 'voip' }), status(409));
    });

    await t.test('trial: when it expires the gate switches off and a new trial is still refused', async () => {
      const o = (await office({ moduleCodes: [], paid: true })).office;
      await platform.startTrial(pool, op, { tenantId: o.id, moduleCode: 'voip' });
      const gate = createModuleGate(pool, { tenantId: o.id, cacheMs: 0 });
      assert.equal(await gate.enabled('voip'), true);
      await pool.query("UPDATE han_saas.tenant_modules SET trial_until = now() - interval '1 minute' WHERE tenant_id = $1", [o.id]);
      assert.equal(await gate.enabled('voip'), false, 'an expired trial is off, with no sweeper needed');
      assert.deepEqual(Object.values(await gate.all()), [false, false, false, false, false]);
      await assert.rejects(platform.startTrial(pool, op, { tenantId: o.id, moduleCode: 'voip' }), status(409));
      // an expired trial can still be bought
      const added = await platform.addModule(pool, op, { tenantId: o.id, moduleCode: 'voip', paid: true });
      assert.ok(added.chargeKurus > 0);
      assert.equal(await gate.enabled('voip'), true);
    });

    await t.test('trial: addModule converts it to a paid module, removeModule ends it', async () => {
      const o = (await office({ moduleCodes: [], paid: true })).office;
      const gate = createModuleGate(pool, { tenantId: o.id, cacheMs: 0 });
      const state = async (code) =>
        (await pool.query('SELECT status, trial_until, removed_at, price_kurus::int p FROM han_saas.tenant_modules WHERE tenant_id = $1 AND module_code = $2', [o.id, code])).rows[0];
      await platform.startTrial(pool, op, { tenantId: o.id, moduleCode: 'voip' });
      const added = await platform.addModule(pool, op, { tenantId: o.id, moduleCode: 'voip' });
      assert.ok(added.chargeKurus > 0 && added.saleId);
      let s = await state('voip');
      assert.deepEqual([s.status, s.removed_at, s.p], ['active', null, 5000]);
      assert.notEqual(s.trial_until, null, 'the trial date is kept, so the trial cannot be repeated');
      assert.equal(await gate.enabled('voip'), true);
      await assert.rejects(platform.addModule(pool, op, { tenantId: o.id, moduleCode: 'voip' }), status(409));
      await assert.rejects(platform.startTrial(pool, op, { tenantId: o.id, moduleCode: 'voip' }), status(409));

      // removing a running trial ends it at once
      await platform.startTrial(pool, op, { tenantId: o.id, moduleCode: 'whatsapp', days: 10 });
      assert.equal(await gate.enabled('whatsapp'), true);
      await platform.removeModule(pool, op, { tenantId: o.id, moduleCode: 'whatsapp' });
      s = await state('whatsapp');
      assert.equal(s.status, 'removed');
      assert.notEqual(s.removed_at, null);
      assert.equal(await gate.enabled('whatsapp'), false);
      await assert.rejects(platform.removeModule(pool, op, { tenantId: o.id, moduleCode: 'whatsapp' }), status(404));
      await assert.rejects(platform.startTrial(pool, op, { tenantId: o.id, moduleCode: 'whatsapp', days: 5 }), status(409), 'an ended trial is spent');
      // after removal the module can still be bought
      assert.ok((await platform.addModule(pool, op, { tenantId: o.id, moduleCode: 'whatsapp' })).saleId);
      assert.equal(await gate.enabled('whatsapp'), true);
    });

    await t.test('the audit trail: campaign saves and status changes are recorded for the operator', async () => {
      const actions = (await pool.query("SELECT action, admin_id FROM han_saas.platform_audit WHERE action LIKE 'campaign.%'")).rows;
      assert.ok(actions.some((a) => a.action === 'campaign.create' && a.admin_id === op));
      assert.ok(actions.some((a) => a.action === 'campaign.save'));
      assert.ok(actions.some((a) => a.action === 'campaign.status'));
    });
  } finally {
    await pg.close();
  }
});

test('platform console HTTP: product, campaign, quote, trial and product-sale routes', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const password = 'Synthetic-Campaign-Http-Test!';
    const admin = await createPlatformAdmin(pool, { username: 'root', name: 'Operatör', password });
    server = await serve(createPlatformHandler({ pool, secureCookies: false }));
    const call = async (path, { method = 'GET', body, cookie } = {}) => {
      const response = await fetch(server.url + '/api/platform/' + path, {
        method,
        headers: {
          ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-Han-Request': '1' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: await response.json() };
    };
    const login = await fetch(server.url + '/api/platform/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
      body: JSON.stringify({ username: 'root', password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const ZERO = '00000000-0000-4000-8000-000000000000';

    // every new route needs an operator session
    for (const [path, method] of [
      ['campaigns', 'GET'],
      ['campaigns', 'POST'],
      ['campaigns/quote', 'POST'],
      [`campaigns/${ZERO}/status`, 'POST'],
      [`offices/${ZERO}/modules/trial`, 'POST'],
      [`offices/${ZERO}/products/sell`, 'POST'],
      ['modules', 'POST'],
      ['modules', 'GET'],
    ]) {
      const res = await call(path, { method, body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 401, `${method} ${path}`);
    }

    // catalog
    const saved = await call('modules', {
      method: 'POST',
      cookie,
      body: { code: 'kurulum', name: 'Kurulum', kind: 'service', monthlyPriceKurus: 100000, status: 'selling', features: ['Uzaktan'], sortOrder: 5 },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    await call('modules', { method: 'POST', cookie, body: { code: 'voip', name: 'Çağrı', monthlyPriceKurus: 5000, status: 'selling', trialDays: 7 } });
    const bad = await call('modules', { method: 'POST', cookie, body: { code: 'sms', name: 'SMS', kind: 'usage_pack', monthlyPriceKurus: 100, status: 'selling' } });
    assert.equal(bad.status, 400);
    assert.ok(typeof bad.json.error === 'string');
    const catalog = (await call('modules', { cookie })).json;
    assert.deepEqual(catalog.slice(0, 2).map((m) => [m.code, m.kind, m.status]), [['kurulum', 'service', 'selling'], ['voip', 'module', 'selling']]);
    assert.deepEqual(catalog[0].features, ['Uzaktan']);
    const audit = (await pool.query("SELECT admin_id FROM han_saas.platform_audit WHERE action = 'product.save'")).rows;
    assert.ok(audit.length >= 2 && audit.every((a) => a.admin_id === admin.id), 'saves are attributed to the session operator');

    // an office to sell to
    const sale = await call('offices', {
      method: 'POST',
      cookie,
      body: { slug: 'ofis-http', name: 'Http Bürosu', userCount: 2, userPriceKurus: 10000, termMonths: 1, moduleCodes: [], paid: true, admin: { name: 'Ada', username: 'ada', password } },
    });
    assert.equal(sale.status, 200, JSON.stringify(sale.json));
    const tenantId = sale.json.office.id;

    // campaigns
    const created = await call('campaigns', {
      method: 'POST',
      cookie,
      body: { name: 'HTTP kampanyası', discountType: 'percent', discountValue: 20, productCodes: ['kurulum'], couponCode: 'http20', endsAt: iso(10 * DAY), createdBy: 'forged' },
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const campaignId = created.json.id;
    assert.equal((await pool.query('SELECT created_by FROM han_saas.campaigns WHERE id = $1', [campaignId])).rows[0].created_by, admin.id);
    assert.equal((await call('campaigns', { method: 'POST', cookie, body: { name: 'Kopya', discountType: 'percent', discountValue: 5, couponCode: 'HTTP20', endsAt: iso(DAY) } })).status, 409);
    assert.equal((await call('campaigns', { method: 'POST', cookie, body: { name: 'K', discountType: 'percent', discountValue: 5, endsAt: iso(DAY) } })).status, 400);
    const listed = (await call('campaigns', { cookie })).json.campaigns;
    assert.deepEqual([listed.length, listed[0].id, listed[0].couponCode, listed[0].live, listed[0].usedCount], [1, campaignId, 'HTTP20', true, 0]);

    // quote: nothing is spent
    const quote = await call('campaigns/quote', {
      method: 'POST',
      cookie,
      body: { couponCode: 'http20', lines: [{ code: 'kurulum', oneOff: true, quantity: 1, amountKurus: 100000 }] },
    });
    assert.equal(quote.status, 200, JSON.stringify(quote.json));
    assert.equal(quote.json.discountKurus, 20_000);
    assert.equal((await call('campaigns/quote', { method: 'POST', cookie, body: { couponCode: 'YOK-YOK', lines: [{ code: 'kurulum', amountKurus: 1 }] } })).status, 404);
    assert.equal((await call('campaigns/quote', { method: 'POST', cookie, body: { campaignId, lines: [] } })).status, 400);
    assert.equal((await call('campaigns', { cookie })).json.campaigns[0].usedCount, 0);

    // trial
    const other = '22222222-2222-4222-8222-222222222222';
    const trial = await call(`offices/${tenantId}/modules/trial`, { method: 'POST', cookie, body: { moduleCode: 'voip', tenantId: other } });
    assert.equal(trial.status, 200, JSON.stringify(trial.json));
    assert.equal(trial.json.days, 7);
    assert.equal((await call(`offices/${tenantId}/modules/trial`, { method: 'POST', cookie, body: { moduleCode: 'voip' } })).status, 409);
    assert.equal((await call(`offices/${other}/modules/trial`, { method: 'POST', cookie, body: { moduleCode: 'voip' } })).status, 404);
    assert.equal((await pool.query('SELECT status FROM han_saas.tenant_modules WHERE tenant_id = $1', [tenantId])).rows[0].status, 'trial');

    // product sale with a coupon; the path decides the office
    const sold = await call(`offices/${tenantId}/products/sell`, {
      method: 'POST',
      cookie,
      body: { code: 'kurulum', quantity: 2, couponCode: 'Http20', tenantId: other, paid: true },
    });
    assert.equal(sold.status, 200, JSON.stringify(sold.json));
    assert.deepEqual([sold.json.amountKurus, sold.json.campaignDiscountKurus, sold.json.payableKurus], [200_000, 40_000, 160_000]);
    const ledger = (await pool.query("SELECT kind, amount_kurus::int a, created_by FROM han_saas.sales WHERE tenant_id = $1 AND campaign_id IS NOT NULL ORDER BY amount_kurus DESC", [tenantId])).rows;
    assert.deepEqual(ledger, [{ kind: 'service', a: 200_000, created_by: admin.id }, { kind: 'adjustment', a: -40_000, created_by: admin.id }]);
    assert.equal((await call(`offices/${tenantId}/products/sell`, { method: 'POST', cookie, body: { code: 'kurulum', couponCode: 'HTTP20' } })).status, 409, 'one use per office');
    assert.equal((await call(`offices/${tenantId}/products/sell`, { method: 'POST', cookie, body: { code: 'voip' } })).status, 400);

    // status
    const paused = await call(`campaigns/${campaignId}/status`, { method: 'POST', cookie, body: { status: 'paused' } });
    assert.deepEqual(paused.json, { id: campaignId, status: 'paused' });
    const after = (await call('campaigns', { cookie })).json.campaigns[0];
    assert.deepEqual([after.status, after.live, after.usedCount, after.revenueKurus, after.discountKurus], ['paused', false, 1, 200_000, 40_000]);
    assert.equal((await call(`campaigns/${campaignId}/status`, { method: 'POST', cookie, body: { status: 'bogus' } })).status, 400);
    assert.equal((await call(`campaigns/${other}/status`, { method: 'POST', cookie, body: { status: 'paused' } })).status, 404);
    assert.equal((await call('campaigns', { method: 'POST', cookie, body: { id: campaignId, name: 'HTTP kampanyası', discountType: 'percent', discountValue: 30, productCodes: ['kurulum'], endsAt: iso(10 * DAY) } })).status, 409, 'used campaign terms are locked');
    // other methods are still refused
    const put = await fetch(server.url + '/api/platform/campaigns', { method: 'PUT', headers: { cookie } });
    assert.equal(put.status, 405);
  } finally {
    if (server) await server.close();
    await pg.close();
  }
});
