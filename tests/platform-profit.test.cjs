const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database } = require('./support/postgres.cjs');
const { createPlatformAdmin } = require('../lib/saas/platform-auth.cjs');
const { createUsageMeter } = require('../lib/saas/usage-meter.cjs');
const platform = require('../lib/saas/platform.cjs');
const finance = require('../lib/saas/finance.cjs');
const profit = require('../lib/saas/profit.cjs');

const secret = 'Synthetic-Platform-Profit-Test!';

function istanbulToday(offsetMonths = 0) {
  const now = new Date(Date.now() + 3 * 3600000);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1));
  return d.toISOString().slice(0, 10);
}

test('profit per office and per product adds up to the ledger; usage cost uses the unit costs', async () => {
  const { pg, pool } = await database();
  try {
    const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Op', password: secret })).id;
    await platform.upsertModule(pool, { code: 'voip', name: 'Çağrı', monthlyPriceKurus: 50000, status: 'selling' }, op);
    await platform.upsertModule(pool, { code: 'ai-assistant', name: 'Yapay zekâ', monthlyPriceKurus: 80000, status: 'selling' }, op);
    await platform.upsertModule(pool, { code: 'setup', name: 'Kurulum', kind: 'service', monthlyPriceKurus: 100000, status: 'selling' }, op);
    const open = (slug, input) =>
      platform.openOffice(pool, op, {
        slug,
        name: slug.toUpperCase(),
        admin: { name: 'Y', username: slug, password: secret },
        termMonths: 12,
        userPriceKurus: 1000,
        ...input,
      });
    const a = (await open('buro-a', { userCount: 2, moduleCodes: ['voip'], paid: true })).office.id;
    const b = (await open('buro-b', { userCount: 1, termMonths: 1, paid: false })).office.id; // pending: no revenue
    // A renewal is one ledger row, split per product by its breakdown.
    await platform.renewOffice(pool, op, { tenantId: a, termMonths: 1, paid: true });
    await platform.sellProduct(pool, op, { tenantId: a, code: 'setup', paid: true });
    const { rows: renewal } = await pool.query("SELECT breakdown FROM han_saas.sales WHERE kind = 'renewal'");
    assert.deepEqual(renewal[0].breakdown, [{ code: 'users', amount: 2000 }, { code: 'voip', amount: 50000 }]);

    const today = istanbulToday();
    await finance.addExpense(pool, op, { spentOn: today, category: 'telephony', description: 'Santral', amountKurus: 30000, moduleCode: 'voip' });
    await finance.addExpense(pool, op, { spentOn: today, category: 'other', description: 'A özel', amountKurus: 5000, tenantId: a });
    await finance.addExpense(pool, op, { spentOn: today, category: 'server', description: 'Sunucu', amountKurus: 7000 });
    await assert.rejects(
      finance.addExpense(pool, op, { spentOn: today, category: 'other', description: 'x yok', amountKurus: 1, moduleCode: 'nope' }),
      (e) => e.status === 404,
    );

    await profit.saveUnitCosts(pool, op, { aiInputPerMillionKurus: 1000, aiOutputPerMillionKurus: 2000, smsSegmentKurus: 10, voipMinuteKurus: 20 });
    await assert.rejects(profit.saveUnitCosts(pool, op, { smsSegmentKurus: -1 }), (e) => e.status === 400);
    const meter = createUsageMeter(pool, { tenantId: a });
    await meter.recordAi({ inputTokens: 300000, outputTokens: 100000 });
    await meter.recordAi({ inputTokens: 200000, outputTokens: 150000 });
    await meter.recordAi({ inputTokens: 0, outputTokens: 0 }); // nothing used: nothing counted
    await pool.query(
      "INSERT INTO han_saas.sms_log(tenant_id, purpose, dest_masked, status, segments) VALUES ($1, 'password_recovery', '9053*****67', 'sent', 3), ($1, 'password_recovery', '9053*****67', 'failed', 0)",
      [a],
    );
    await pool.query(
      `INSERT INTO han_private.voip_calls(id, document_id, phone, user_id, request_id, created_at, status, body, search_text, tenant_id)
       VALUES ('c1', 'd1', '905321234567', 'u1', 'r1', CURRENT_TIMESTAMP, 'completed', '{"duration": 61}', '', $1),
              ('c2', 'd1', '905321234567', 'u1', 'r2', CURRENT_TIMESTAMP, 'completed', '{"duration": 30}', '', $1)`,
      [a],
    );

    const report = await profit.profitReport(pool);
    const officeA = report.offices.find((o) => o.tenantId === a);
    const officeB = report.offices.find((o) => o.tenantId === b);
    const revenueA = 2 * 1000 * 12 + 50000 * 12 + 52000 + 100000;
    assert.equal(officeA.revenueKurus, revenueA);
    assert.equal(officeA.expenseKurus, 5000);
    assert.deepEqual(officeA.usage, { aiRequests: 2, aiInputTokens: 500000, aiOutputTokens: 250000, smsSegments: 3, voipMinutes: 3 });
    assert.deepEqual(officeA.usageCost, { ai: 1000, sms: 30, voip: 60 });
    assert.equal(officeA.profitKurus, revenueA - 5000 - 1090);
    assert.equal(officeB.revenueKurus, 0, 'pending sales are not revenue');

    const byCode = Object.fromEntries(report.products.map((p) => [p.code, p]));
    assert.equal(byCode.users.revenueKurus, 24000 + 2000);
    assert.equal(byCode.voip.revenueKurus, 600000 + 50000);
    assert.equal(byCode.voip.expenseKurus, 30000);
    assert.equal(byCode.voip.usageCostKurus, 60);
    assert.equal(byCode['ai-assistant'].usageCostKurus, 1000);
    assert.equal(byCode['ai-assistant'].profitKurus, -1000);
    assert.equal(byCode.setup.revenueKurus, 100000);
    // Product and office revenue both reconcile with the collected ledger.
    const { rows: paid } = await pool.query("SELECT sum(amount_kurus)::int AS total FROM han_saas.sales WHERE status = 'paid'");
    assert.equal(report.totals.revenueKurus, paid[0].total);
    assert.equal(report.offices.reduce((s, o) => s + o.revenueKurus, 0), paid[0].total);
    assert.equal(report.totals.smsUsageCostKurus, 30);
    assert.equal(report.offices[0].profitKurus <= report.offices.at(-1).profitKurus, true, 'loss-makers first');

    assert.equal(report.indicators.activeOffices, 2);
    assert.equal(report.indicators.mrrKurus, 2 * 1000 + 50000 + 1 * 1000);
    assert.equal(report.indicators.arpuKurus, Math.round((2 * 1000 + 50000 + 1000) / 2));
    const reach = Object.fromEntries(report.indicators.reach.map((r) => [r.code, [r.offices, r.percent]]));
    assert.deepEqual(reach, { voip: [1, 50], 'ai-assistant': [0, 0] });
    await assert.rejects(profit.profitReport(pool, { from: '2026-13' }), (e) => e.status === 400);
  } finally {
    await pg.close();
  }
});

test('recurring expenses are written once per month and can be stopped', async () => {
  const { pg, pool } = await database();
  try {
    const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Op', password: secret })).id;
    await assert.rejects(
      profit.addRecurring(pool, op, { category: 'server', description: 'Sunucu', amountKurus: 100, dayOfMonth: 31, startsOn: istanbulToday() }),
      (e) => e.status === 400,
    );
    const { id } = await profit.addRecurring(pool, op, {
      category: 'server',
      description: 'Sunucu kirası',
      amountKurus: 250000,
      dayOfMonth: 1,
      startsOn: istanbulToday(-3),
    });
    const count = async () =>
      (await pool.query('SELECT count(*)::int AS n FROM han_saas.expenses WHERE recurring_id = $1', [id])).rows[0].n;
    assert.equal(await count(), 4, 'three past months and this month');
    await profit.postRecurringNow(pool);
    await profit.postRecurringNow(pool);
    assert.equal(await count(), 4, 'never twice for a month');
    const [listed] = await profit.listRecurring(pool);
    assert.equal(listed.lastPeriod, istanbulToday().slice(0, 7));
    await profit.stopRecurring(pool, op, { id });
    await assert.rejects(profit.stopRecurring(pool, op, { id }), (e) => e.status === 409);
    assert.equal((await profit.listRecurring(pool))[0].active, false);
    // The finance summary sees the recurring rows as ordinary expenses.
    const summary = await finance.financeSummary(pool);
    assert.equal(summary.totals.costNetKurus, 4 * 250000);
    const report = await finance.expensesReport(pool, {});
    assert.equal(report.expenses[0].recurring, true);
  } finally {
    await pg.close();
  }
});
