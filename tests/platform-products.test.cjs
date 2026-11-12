const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database } = require('./support/postgres.cjs');
const { createPlatformAdmin } = require('../lib/saas/platform-auth.cjs');
const platform = require('../lib/saas/platform.cjs');

const status = (code) => (error) => error.status === code;
const secret = 'Synthetic-Products-Test-Only';

test('product catalog: kinds, statuses, validation, listing and one-off sales', async (t) => {
  const { pg, pool } = await database();
  try {
    const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Operatör', password: secret + '!' })).id;
    const save = (extra) => platform.upsertModule(pool, { name: 'Ürün', monthlyPriceKurus: 1000, ...extra }, op);
    const row = async (code) =>
      (await pool.query('SELECT * FROM han_saas.modules WHERE code = $1', [code])).rows[0];
    const office = async (slug = 'office-p', extra = {}) =>
      (
        await platform.openOffice(pool, op, {
          slug,
          name: 'Ürün Bürosu',
          admin: { name: 'Ada', username: slug.replace(/-/g, ''), password: secret },
          userCount: 2,
          userPriceKurus: 10000,
          termMonths: 1,
          moduleCodes: [],
          paid: true,
          ...extra,
        })
      ).office;

    await t.test('kinds and statuses are stored, and legacy active:true means selling', async () => {
      await save({ code: 'plain', active: true });
      let r = await row('plain');
      assert.deepEqual([r.kind, r.status, r.active, r.trial_days, r.pack_quantity, r.pack_unit], ['module', 'selling', true, 0, null, null]);
      await save({ code: 'plain', active: false });
      r = await row('plain');
      assert.deepEqual([r.status, r.active], ['draft', false], 'no status and no active: draft');
      for (const s of ['draft', 'soon', 'selling', 'retired']) {
        await save({ code: 'stat-' + s, status: s });
        r = await row('stat-' + s);
        assert.deepEqual([r.status, r.active], [s, s === 'selling']);
      }
      await save({ code: 'svc-setup', kind: 'service', status: 'soon' });
      assert.equal((await row('svc-setup')).kind, 'service');
      // status wins over the legacy flag
      await save({ code: 'both', status: 'retired', active: true });
      assert.deepEqual([(await row('both')).status, (await row('both')).active], ['retired', false]);
    });

    await t.test('validation rejects bad kind, status, price, text and codes', async () => {
      const bad = [
        { code: 'x1', kind: 'bundle' },
        { code: 'x1', status: 'live' },
        { code: 'x1', status: 'selling', monthlyPriceKurus: 0 },
        { code: 'x1', active: true, monthlyPriceKurus: 0 },
        { code: 'x1', monthlyPriceKurus: -1 },
        { code: 'x1', monthlyPriceKurus: 10.5 },
        { code: 'x1', monthlyPriceKurus: 100_000_001 },
        { code: 'X1' },
        { code: '1x' },
        { code: 'a' },
        { code: 'x1', name: 'A' },
        { code: 'x1', description: 'a'.repeat(501) },
        { code: 'x1', sortOrder: 1001 },
        { code: 'x1', sortOrder: -1 },
      ];
      for (const extra of bad) await assert.rejects(save(extra), status(400), JSON.stringify(extra));
      assert.equal(await row('x1'), undefined, 'nothing saved');
      // zero price is fine while not selling
      await save({ code: 'free-draft', monthlyPriceKurus: 0, status: 'draft' });
    });

    await t.test('usage packs need quantity and unit; other kinds ignore them', async () => {
      await assert.rejects(save({ code: 'sms-1000', kind: 'usage_pack' }), status(400));
      await assert.rejects(save({ code: 'sms-1000', kind: 'usage_pack', packQuantity: 1000 }), status(400));
      await assert.rejects(save({ code: 'sms-1000', kind: 'usage_pack', packUnit: 'SMS' }), status(400));
      await assert.rejects(save({ code: 'sms-1000', kind: 'usage_pack', packQuantity: 0, packUnit: 'SMS' }), status(400));
      await assert.rejects(save({ code: 'sms-1000', kind: 'usage_pack', packQuantity: 1.5, packUnit: 'SMS' }), status(400));
      await assert.rejects(save({ code: 'sms-1000', kind: 'usage_pack', packQuantity: 1000, packUnit: 'x'.repeat(31) }), status(400));
      await save({ code: 'sms-1000', name: '1000 SMS', kind: 'usage_pack', packQuantity: 1000, packUnit: ' SMS ', status: 'selling', monthlyPriceKurus: 25000 });
      const r = await row('sms-1000');
      assert.deepEqual([r.kind, r.pack_quantity, r.pack_unit, r.trial_days], ['usage_pack', 1000, 'SMS', 0]);
      // pack fields passed with another kind are dropped, not stored
      await save({ code: 'svc-stray', kind: 'service', packQuantity: 5, packUnit: 'adet' });
      const s = await row('svc-stray');
      assert.deepEqual([s.pack_quantity, s.pack_unit], [null, null]);
    });

    await t.test('trial days are for modules only (0-60)', async () => {
      await save({ code: 'trialable', trialDays: 14 });
      assert.equal((await row('trialable')).trial_days, 14);
      await save({ code: 'trialable', trialDays: 60 });
      await assert.rejects(save({ code: 'trialable', trialDays: 61 }), status(400));
      await assert.rejects(save({ code: 'trialable', trialDays: -1 }), status(400));
      await assert.rejects(save({ code: 'trialable', trialDays: 1.5 }), status(400));
      // other kinds silently store 0 (the database also forbids anything else)
      await save({ code: 'svc-trial', kind: 'service', trialDays: 14 });
      assert.equal((await row('svc-trial')).trial_days, 0);
      await save({ code: 'pack-trial', kind: 'usage_pack', packQuantity: 10, packUnit: 'adet', trialDays: 7 });
      assert.equal((await row('pack-trial')).trial_days, 0);
      await assert.rejects(
        pool.query("UPDATE han_saas.modules SET trial_days = 5 WHERE code = 'svc-trial'"),
        (e) => e.code === '23514',
      );
    });

    await t.test('features: at most 12 trimmed strings of at most 120 characters', async () => {
      await save({ code: 'featured', features: ['  Birinci  ', 'İkinci', 'x'.repeat(120)] });
      const f = (await row('featured')).features;
      assert.deepEqual(f.slice(0, 2), ['Birinci', 'İkinci']);
      assert.equal(f[2].length, 120);
      await save({ code: 'featured', features: Array.from({ length: 12 }, (_, i) => 'Özellik ' + i) });
      assert.equal((await row('featured')).features.length, 12);
      for (const features of [
        Array.from({ length: 13 }, (_, i) => 'f' + i),
        ['x'.repeat(121)],
        ['  '],
        [''],
        [5],
        'not a list',
        { 0: 'a' },
      ])
        await assert.rejects(save({ code: 'featured', features }), status(400), JSON.stringify(features).slice(0, 40));
      assert.equal((await row('featured')).features.length, 12, 'failed saves change nothing');
    });

    await t.test('listModules: ordered selling, soon, draft, retired, then sort order and name; carries every field', async () => {
      await pool.query('DELETE FROM han_saas.modules');
      await save({ code: 'r-old', name: 'Eski', status: 'retired' });
      await save({ code: 'd-two', name: 'Taslak B', status: 'draft', sortOrder: 5 });
      await save({ code: 'd-one', name: 'Taslak A', status: 'draft', sortOrder: 5 });
      await save({ code: 's-soon', name: 'Yakında', status: 'soon' });
      await save({ code: 's-b', name: 'Zeta', status: 'selling', sortOrder: 10 });
      await save({ code: 's-a', name: 'Alfa', status: 'selling', sortOrder: 10 });
      await save({ code: 's-first', name: 'Son harf', status: 'selling', sortOrder: 1 });
      await save({
        code: 'sms-pack', name: '500 SMS', kind: 'usage_pack', packQuantity: 500, packUnit: 'SMS', monthlyPriceKurus: 12000,
        status: 'selling', sortOrder: 50, features: ['Anında'], description: 'Paket',
      });
      await save({ code: 'voip', name: 'Çağrı', status: 'selling', sortOrder: 20, trialDays: 7, monthlyPriceKurus: 5000 });
      const list = await platform.listModules(pool);
      assert.deepEqual(
        list.map((m) => m.code),
        ['s-first', 's-a', 's-b', 'voip', 'sms-pack', 's-soon', 'd-one', 'd-two', 'r-old'],
      );
      const pack = list.find((m) => m.code === 'sms-pack');
      assert.deepEqual(pack, {
        code: 'sms-pack', name: '500 SMS', description: 'Paket', monthlyPriceKurus: 12000, active: true, kind: 'usage_pack',
        status: 'selling', features: ['Anında'], trialDays: 0, packQuantity: 500, packUnit: 'SMS', sortOrder: 50,
        offices: 0, monthlyKurus: 0, sold: 0, paidKurus: 0, gated: false,
      });
      const voip = list.find((m) => m.code === 'voip');
      assert.deepEqual([voip.gated, voip.trialDays, voip.kind, voip.packQuantity, voip.packUnit], [true, 7, 'module', null, null]);
    });

    let one;
    await t.test('listModules counts offices, monthly revenue, sales and paid amounts', async () => {
      one = await office('office-p', { moduleCodes: ['voip'], paid: true });
      const two = await office('office-q', { moduleCodes: ['voip'], paid: false });
      const voip = (await platform.listModules(pool)).find((m) => m.code === 'voip');
      assert.deepEqual([voip.offices, voip.monthlyKurus, voip.sold, voip.paidKurus], [2, 10000, 2, 5000]);
      await platform.removeModule(pool, op, { tenantId: two.id, moduleCode: 'voip' });
      const after = (await platform.listModules(pool)).find((m) => m.code === 'voip');
      assert.deepEqual([after.offices, after.monthlyKurus, after.sold], [1, 5000, 2], 'removal drops the monthly figure, not the sale');
    });

    await t.test('selling a service: price x quantity, ledger row kind/quantity/module_code, VAT and audit', async () => {
      await save({ code: 'kurulum', name: 'Kurulum', kind: 'service', status: 'selling', monthlyPriceKurus: 150000 });
      const one1 = await platform.sellProduct(pool, op, { tenantId: one.id, code: 'kurulum' });
      assert.deepEqual(
        [one1.quantity, one1.amountKurus, one1.payableKurus, one1.campaignDiscountKurus, one1.vatKurus],
        [1, 150000, 150000, 0, 30000],
      );
      const three = await platform.sellProduct(pool, op, { tenantId: one.id, code: 'kurulum', quantity: 3, invoiceNo: 'FTR-9', paid: true });
      assert.deepEqual([three.amountKurus, three.vatKurus], [450000, 90000]);
      const sale = (await pool.query('SELECT * FROM han_saas.sales WHERE id = $1', [three.saleId])).rows[0];
      assert.deepEqual(
        [sale.kind, sale.quantity, sale.module_code, Number(sale.amount_kurus), sale.status, sale.invoice_no, Number(sale.vat_rate), sale.created_by, sale.campaign_id],
        ['service', 3, 'kurulum', 450000, 'paid', 'FTR-9', 20, op, null],
      );
      assert.match(sale.description, /Kurulum × 3/);
      const pending = (await pool.query('SELECT status FROM han_saas.sales WHERE id = $1', [one1.saleId])).rows[0];
      assert.equal(pending.status, 'pending');
      // a different KDV rate is stored and used
      const reduced = await platform.sellProduct(pool, op, { tenantId: one.id, code: 'kurulum', vatRatePercent: 10 });
      assert.equal(reduced.vatKurus, 15000);
      assert.equal(Number((await pool.query('SELECT vat_rate FROM han_saas.sales WHERE id = $1', [reduced.saleId])).rows[0].vat_rate), 10);
      const events = (await pool.query("SELECT detail FROM han_saas.tenant_events WHERE tenant_id = $1 AND action = 'product_sold'", [one.id])).rows;
      assert.equal(events.length, 3);
    });

    await t.test('selling a usage pack stores kind, quantity and describes the pack', async () => {
      const sold = await platform.sellProduct(pool, op, { tenantId: one.id, code: 'sms-pack', quantity: 4 });
      assert.equal(sold.amountKurus, 48000);
      const sale = (await pool.query('SELECT * FROM han_saas.sales WHERE id = $1', [sold.saleId])).rows[0];
      assert.deepEqual([sale.kind, sale.quantity, sale.module_code, Number(sale.amount_kurus)], ['usage_pack', 4, 'sms-pack', 48000]);
      assert.match(sale.description, /4 × 500 SMS/);
      const list = (await platform.listModules(pool)).find((m) => m.code === 'sms-pack');
      assert.deepEqual([list.sold, list.paidKurus, list.offices], [1, 0, 0], 'one-off products never count as subscribed offices');
    });

    await t.test('operator override replaces the computed amount; bounds and quantity are checked', async () => {
      const free = await platform.sellProduct(pool, op, { tenantId: one.id, code: 'kurulum', quantity: 2, chargeKurus: 0 });
      assert.deepEqual([free.amountKurus, free.payableKurus, free.vatKurus], [0, 0, 0]);
      const special = await platform.sellProduct(pool, op, { tenantId: one.id, code: 'kurulum', quantity: 2, chargeKurus: 12345 });
      assert.equal(special.amountKurus, 12345);
      for (const bad of [{ chargeKurus: -1 }, { chargeKurus: 1.5 }, { chargeKurus: '100' }, { quantity: 0 }, { quantity: 10001 }, { quantity: 1.5 }, { quantity: '2' }])
        await assert.rejects(platform.sellProduct(pool, op, { tenantId: one.id, code: 'kurulum', ...bad }), status(400), JSON.stringify(bad));
      await platform.sellProduct(pool, op, { tenantId: one.id, code: 'kurulum', quantity: 10000, chargeKurus: 1 });
    });

    await t.test('products that are not for sale, unknown, or monthly modules cannot be sold as one-offs', async () => {
      await save({ code: 'svc-draft', kind: 'service', status: 'draft' });
      await save({ code: 'svc-soon', kind: 'service', status: 'soon' });
      await save({ code: 'svc-gone', kind: 'service', status: 'retired' });
      for (const code of ['svc-draft', 'svc-soon', 'svc-gone', 'nothing-here', 'voip', 's-a'])
        await assert.rejects(platform.sellProduct(pool, op, { tenantId: one.id, code }), status(400), code);
      await assert.rejects(platform.sellProduct(pool, op, { tenantId: 'x', code: 'kurulum' }), status(404));
      await assert.rejects(
        platform.sellProduct(pool, op, { tenantId: '33333333-3333-4333-8333-333333333333', code: 'kurulum' }),
        status(404),
      );
      await assert.rejects(platform.sellProduct(pool, op, { tenantId: one.id, code: 'Kurulum!' }), status(400));
      const count = (await pool.query("SELECT count(*)::int n FROM han_saas.sales WHERE module_code IN ('voip', 's-a', 'svc-draft')")).rows[0].n;
      assert.equal(count, 2, 'only the two original voip module sales exist');
    });

    await t.test('usage packs and services cannot be added as monthly modules or sold when opening an office', async () => {
      await assert.rejects(platform.addModule(pool, op, { tenantId: one.id, moduleCode: 'sms-pack' }), status(400));
      await assert.rejects(platform.addModule(pool, op, { tenantId: one.id, moduleCode: 'kurulum' }), status(400));
      await assert.rejects(platform.startTrial(pool, op, { tenantId: one.id, moduleCode: 'sms-pack', days: 3 }), status(400));
      const before = (await pool.query('SELECT (SELECT count(*) FROM han_saas.tenants)::int t, (SELECT count(*) FROM han_saas.sales)::int s')).rows[0];
      await assert.rejects(office('office-bad', { moduleCodes: ['sms-pack'] }), status(400));
      await assert.rejects(office('office-bad', { moduleCodes: ['voip', 'kurulum'] }), status(400));
      const after = (await pool.query('SELECT (SELECT count(*) FROM han_saas.tenants)::int t, (SELECT count(*) FROM han_saas.sales)::int s')).rows[0];
      assert.deepEqual(after, before);
      assert.equal((await pool.query("SELECT count(*)::int n FROM han_saas.tenant_modules WHERE module_code IN ('sms-pack', 'kurulum')")).rows[0].n, 0);
    });

    await t.test('modules that are only announced, drafts or retired are not sold either', async () => {
      await save({ code: 'm-soon', status: 'soon' });
      await save({ code: 'm-retired', status: 'retired' });
      for (const code of ['m-soon', 'm-retired', 'free-draft'])
        await assert.rejects(platform.addModule(pool, op, { tenantId: one.id, moduleCode: code }), status(400), code);
      await assert.rejects(office('office-bad', { moduleCodes: ['m-soon'] }), status(400));
    });

    await t.test('changing the kind of a sold product is refused; unsold products can change', async () => {
      // 'kurulum' (service) has sales, 'voip' (module) has sales and offices
      await assert.rejects(save({ code: 'kurulum', kind: 'module' }), status(409));
      await assert.rejects(save({ code: 'kurulum', kind: 'usage_pack', packQuantity: 1, packUnit: 'adet' }), status(409));
      await assert.rejects(save({ code: 'voip', kind: 'service' }), status(409));
      assert.equal((await row('kurulum')).kind, 'service');
      assert.equal((await row('voip')).kind, 'module');
      // same kind: price and name may change freely
      await save({ code: 'kurulum', name: 'Kurulum v2', kind: 'service', status: 'selling', monthlyPriceKurus: 200000 });
      assert.equal(Number((await row('kurulum')).monthly_price_kurus), 200000);
      // never sold: kind may change
      await save({ code: 'switcher', kind: 'service', status: 'draft' });
      await save({ code: 'switcher', kind: 'module', status: 'draft' });
      assert.equal((await row('switcher')).kind, 'module');
      // a module that only has an office row but no sale also counts as sold
      await save({ code: 'gift', status: 'selling' });
      await platform.addModule(pool, op, { tenantId: one.id, moduleCode: 'gift', chargeKurus: 0 });
      assert.equal((await pool.query("SELECT count(*)::int n FROM han_saas.sales WHERE module_code = 'gift'")).rows[0].n, 0);
      await assert.rejects(save({ code: 'gift', kind: 'service' }), status(409));
    });

    await t.test('the audit log records catalog saves with the operator, and none without an operator', async () => {
      const audit = async () =>
        (await pool.query("SELECT admin_id, action, target, detail FROM han_saas.platform_audit WHERE action = 'product.save' ORDER BY id")).rows;
      const before = (await audit()).length;
      await platform.upsertModule(pool, { code: 'audited', name: 'Denetimli', monthlyPriceKurus: 12345, status: 'soon' }, op);
      const rows = await audit();
      assert.equal(rows.length, before + 1);
      assert.deepEqual(rows.at(-1), { admin_id: op, action: 'product.save', target: 'audited', detail: 'Denetimli · soon · 123,45 TL' });
      await platform.upsertModule(pool, { code: 'no-admin', name: 'Sistem', monthlyPriceKurus: 100, status: 'draft' });
      assert.equal((await audit()).length, before + 1, 'seed-style call without an operator writes no audit row');
      // a rejected save writes nothing
      await assert.rejects(platform.upsertModule(pool, { code: 'audited', name: 'X', monthlyPriceKurus: -5 }, op), status(400));
      assert.equal((await audit()).length, before + 1);
    });
  } finally {
    await pg.close();
  }
});
