const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, serve } = require('./support/postgres.cjs');
const { createPlatformAdmin } = require('../lib/saas/platform-auth.cjs');
const { createPlatformHandler } = require('../lib/platform-app.cjs');
const platform = require('../lib/saas/platform.cjs');
const finance = require('../lib/saas/finance.cjs');

const secret = 'Synthetic-Finance-Test-Only';
const status = (code) => (error) => error.status === code;

test('KDV on sales: per-row rounding, month totals, refunds and rates', async (t) => {
  const { pg, pool } = await database();
  try {
    const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Operatör', password: secret + '!' })).id;
    await platform.upsertModule(pool, { code: 'voip', name: 'Çağrı', monthlyPriceKurus: 5000, active: true });
    const open = (extra) =>
      platform.openOffice(pool, op, {
        slug: 'kdv-buro', name: 'KDV Büro', admin: { name: 'Y', username: 'y', password: secret },
        userCount: 5, userPriceKurus: 20000, termMonths: 12, moduleCodes: ['voip'], discountKurus: 10000, paid: true, ...extra,
      });

    await t.test('vatOf rounds half away from zero in integer kuruş', () => {
      assert.equal(platform.vatOf(1005, 20), 201);
      assert.equal(platform.vatOf(5, 10), 1, '0.5 rounds up');
      assert.equal(platform.vatOf(-5, 10), -1, 'a refund reverses the KDV exactly');
      assert.equal(platform.vatOf(4, 10), 0);
      assert.equal(platform.vatOf(100_000_000_000, 20), 20_000_000_000);
    });

    let tenantId;
    await t.test('a sale defaults to 20% KDV and the response carries the KDV', async () => {
      const sale = await open();
      tenantId = sale.office.id;
      // users 5*200*12 = 12000.00, module 50*12 = 600.00, discount -100.00
      assert.equal(sale.payableKurus, 1_250_000);
      assert.equal(sale.vatRatePercent, 20);
      assert.equal(sale.vatKurus, 240_000 + 12_000 - 2_000 + 0, 'KDV of 12000.00 + 600.00 − 100.00 at 20%');
      const rows = (await pool.query('SELECT kind, vat_rate FROM han_saas.sales WHERE tenant_id = $1', [tenantId])).rows;
      assert.ok(rows.every((r) => r.vat_rate === 20));
    });

    await t.test('the month report totals collected KDV, keeps pending apart and ignores voided rows', async () => {
      const pendingRenewal = await platform.renewOffice(pool, op, { tenantId, termMonths: 1, paid: false, vatRatePercent: 10 });
      const refund = await platform.recordRefund(pool, op, { tenantId, amountKurus: 5, description: 'Kuruş iadesi', vatRatePercent: 10 });
      assert.ok(refund.saleId);
      const voided = await platform.renewOffice(pool, op, { tenantId, termMonths: 1, paid: true });
      await platform.voidSale(pool, op, { saleId: voided.saleId, reason: 'Yanlış kayıt' });
      const report = await finance.salesReport(pool, {});
      assert.match(report.month, /^\d{4}-\d{2}$/);
      const net = report.sales.filter((s) => s.status === 'paid').reduce((sum, s) => sum + s.amountKurus, 0);
      const vat = report.sales.filter((s) => s.status === 'paid').reduce((sum, s) => sum + s.vatKurus, 0);
      assert.equal(report.collected.netKurus, net);
      assert.equal(report.collected.vatKurus, vat, 'month KDV is the sum of per-row KDV');
      assert.equal(report.collected.grossKurus, net + vat);
      assert.equal(report.sales.find((s) => s.id === refund.saleId).vatKurus, -1);
      assert.equal(report.sales.find((s) => s.id === voided.saleId).status, 'void');
      assert.equal(report.pending.count, 1);
      assert.equal(report.pending.netKurus, pendingRenewal.totalKurus - 0, 'pending renewal is totalled separately');
      assert.deepEqual(report.byRate.map((r) => r.ratePercent), [10, 20]);
      assert.equal(report.byRate.reduce((sum, r) => sum + r.netKurus, 0), net);
      const sale = report.sales.find((s) => s.kind === 'new_office');
      assert.equal(sale.grossKurus, sale.amountKurus + sale.vatKurus);
    });

    await t.test('a different month is empty and the month is validated', async () => {
      const empty = await finance.salesReport(pool, { month: '2019-01' });
      assert.deepEqual([empty.sales.length, empty.collected.count, empty.pending.count], [0, 0, 0]);
      for (const bad of ['2026-13', '26-01', '2026-1', 'x', 5]) await assert.rejects(() => finance.salesReport(pool, { month: bad }), status(400), String(bad));
    });

    await t.test('the KDV rate is bounded', async () => {
      for (const bad of [-1, 101, 20.5, '20']) await assert.rejects(() => platform.recordRefund(pool, op, { tenantId, amountKurus: 1, description: 'x y z', vatRatePercent: bad }), status(400), String(bad));
      const exempt = await platform.renewOffice(pool, op, { tenantId, termMonths: 1, paid: true, vatRatePercent: 0 });
      assert.equal(exempt.vatKurus, 0);
    });
  } finally {
    await pg.close();
  }
});

test('expense ledger, profit summary and the KDV to pay', async (t) => {
  const { pg, pool } = await database();
  try {
    const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Operatör', password: secret + '!' })).id;
    const office = (
      await platform.openOffice(pool, op, {
        slug: 'maliyet-buro', name: 'Maliyet Büro', admin: { name: 'Y', username: 'y', password: secret },
        userCount: 1, userPriceKurus: 100000, termMonths: 1, moduleCodes: [], paid: true,
      })
    ).office;
    const today = (await pool.query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Istanbul')::date::text AS d")).rows[0].d;
    const expense = (extra) => ({ spentOn: today, category: 'advertising', description: 'Reklam', amountKurus: 50_000, ...extra });

    let adId;
    await t.test('an expense is recorded KDV-exclusive with its own rate and optional office', async () => {
      const ad = await finance.addExpense(pool, op, expense({ vendor: 'Google Ads', invoiceNo: 'A-1' }));
      await finance.addExpense(pool, op, expense({ category: 'server', description: 'Sunucu', amountKurus: 10_000 }));
      await finance.addExpense(pool, op, expense({ category: 'ai', description: 'Yapay zekâ kullanımı', amountKurus: 20_000, vatRatePercent: 0, tenantId: office.id }));
      const report = await finance.expensesReport(pool, {});
      assert.equal(report.total.netKurus, 80_000);
      assert.equal(report.total.vatKurus, 10_000 + 2_000 + 0);
      assert.equal(report.total.grossKurus, 92_000);
      assert.deepEqual(report.byCategory.map((c) => c.category), ['advertising', 'ai', 'server']);
      assert.equal(report.expenses.find((e) => e.category === 'ai').tenantName, 'Maliyet Büro');
      adId = ad.id;
    });

    await t.test('voiding removes it from totals but keeps the row', async () => {
      await finance.voidExpense(pool, op, { expenseId: adId, reason: 'Çift kayıt' });
      await assert.rejects(() => finance.voidExpense(pool, op, { expenseId: adId, reason: 'Çift kayıt' }), status(409));
      const after = await finance.expensesReport(pool, {});
      assert.equal(after.total.netKurus, 30_000);
      assert.equal(after.expenses.find((e) => e.id === adId).status, 'void');
      await finance.addExpense(pool, op, expense());
    });

    await t.test('the summary joins income, cost, profit, KDV to pay and cost per new office', async () => {
      const summary = await finance.financeSummary(pool);
      assert.equal(summary.months.length, 12);
      const current = summary.months[11];
      // sale: 1 user × 1000.00 × 1 month, 20% KDV
      assert.equal(current.salesNetKurus, 100_000);
      assert.equal(current.salesVatKurus, 20_000);
      assert.equal(current.salesGrossKurus, 120_000);
      assert.equal(current.costNetKurus, 80_000, 'advertising 500 + server 100 + AI 200');
      assert.equal(current.costVatKurus, 10_000 + 2_000);
      assert.equal(current.profitKurus, 20_000);
      assert.equal(current.vatPayableKurus, 20_000 - 12_000, 'KDV collected minus deductible KDV');
      assert.equal(current.acquisitionKurus, 50_000);
      assert.equal(current.newOffices, 1);
      assert.equal(current.costPerNewOfficeKurus, 50_000);
      assert.equal(summary.months[0].costPerNewOfficeKurus, null, 'no offices sold, no per-office cost');
      assert.equal(summary.totals.profitKurus, 20_000);
    });

    await t.test('validation', async () => {
      const bad = (extra) => finance.addExpense(pool, op, expense(extra));
      await assert.rejects(() => bad({ category: 'food' }), status(400));
      await assert.rejects(() => bad({ amountKurus: 0 }), status(400));
      await assert.rejects(() => bad({ amountKurus: 10.5 }), status(400));
      await assert.rejects(() => bad({ amountKurus: -5 }), status(400));
      await assert.rejects(() => bad({ description: 'x' }), status(400));
      await assert.rejects(() => bad({ spentOn: '2026-02-30' }), status(400));
      await assert.rejects(() => bad({ spentOn: 'yesterday' }), status(400));
      await assert.rejects(() => bad({ spentOn: '2099-01-01' }), status(400), 'future dates');
      await assert.rejects(() => bad({ vatRatePercent: 150 }), status(400));
      await assert.rejects(() => bad({ tenantId: '11111111-1111-4111-8111-111111111111' }), status(404));
      await assert.rejects(() => bad({ tenantId: 'nope' }), status(404));
      await assert.rejects(() => finance.voidExpense(pool, op, { expenseId: 'nope', reason: 'xxx' }), status(404));
    });
  } finally {
    await pg.close();
  }
});

test('finance over HTTP: month parameter and session operator', async () => {
  const { pg, pool } = await database();
  const server = await serve(createPlatformHandler({ pool, secureCookies: false }));
  try {
    await createPlatformAdmin(pool, { username: 'root', name: 'Operatör', password: secret + '!' });
    const call = async (path, { method = 'GET', body, cookie } = {}) => {
      const response = await fetch(server.url + '/api/platform/' + path, {
        method,
        headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-Han-Request': '1' } : {}), ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: await response.json(), setCookie: response.headers.get('set-cookie') };
    };
    for (const path of ['finance', 'sales', 'expenses']) assert.equal((await call(path)).status, 401, path);
    const cookie = (await call('login', { method: 'POST', body: { username: 'root', password: secret + '!' } })).setCookie.split(';')[0];
    assert.equal((await call('sales?month=2026-13', { cookie })).status, 400);
    assert.equal((await call('sales?month=2026-01', { cookie })).json.month, '2026-01');
    assert.equal((await call('expenses', { method: 'POST', cookie, body: { spentOn: '2026-01-05', category: 'server', description: 'Sunucu', amountKurus: 1000 } })).status, 200);
    assert.equal((await call('expenses?month=2026-01', { cookie })).json.total.netKurus, 1000);
    assert.equal((await call('finance', { cookie })).json.months.length, 12);
  } finally {
    await server.close();
    await pg.close();
  }
});
