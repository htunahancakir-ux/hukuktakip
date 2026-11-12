const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database } = require('./support/postgres.cjs');
const { createPlatformAdmin } = require('../lib/saas/platform-auth.cjs');
const platform = require('../lib/saas/platform.cjs');
const { createTenantResolver } = require('../lib/saas/tenant-resolver.cjs');
const { createInvitation, acceptInvitation } = require('../lib/saas/invitations.cjs');

const status = (code) => (error) => error.status === code;
const secret = 'Synthetic-Platform-Test-Only';
const BASE = 'han.example.com';

test('platform console: sales, modules, status and revenue', async (t) => {
  const { pg, pool } = await database();
  try {
    const admin = await createPlatformAdmin(pool, { username: 'Root', name: 'Platform Yöneticisi', password: secret + '!' });
    const op = admin.id;
    await platform.upsertModule(pool, { code: 'voip', name: 'Çağrı merkezi', monthlyPriceKurus: 5000, active: true });
    await platform.upsertModule(pool, { code: 'whatsapp', name: 'WhatsApp', monthlyPriceKurus: 3000, active: true });
    const input = (extra = {}) => ({
      slug: 'office-one',
      name: 'Birinci Büro',
      admin: { name: 'Ada', username: 'ada', password: secret },
      userCount: 5,
      userPriceKurus: 20000,
      termMonths: 12,
      moduleCodes: ['voip'],
      discountKurus: 10000,
      paid: false,
      ...extra,
    });
    const ledger = async (tenantId) =>
      (
        await pool.query(
          `SELECT kind, amount_kurus::int AS amount, status FROM han_saas.sales WHERE tenant_id = $1 ORDER BY amount_kurus DESC`,
          [tenantId],
        )
      ).rows;
    const resolver = () => createTenantResolver(pool, { baseDomain: BASE, cacheMs: 0 });
    const resolve = (slug) => resolver().resolve({ headers: { host: `${slug}.${BASE}` } });
    let one;

    await t.test('module catalog: pricing is required to sell, and nothing is priced by default', async () => {
      await assert.rejects(
        platform.upsertModule(pool, { code: 'ai-assistant', name: 'AI', monthlyPriceKurus: 0, active: true }),
        status(400),
      );
      const seeded = (await platform.listModules(pool)).find((m) => m.code === 'marketing-routes');
      assert.deepEqual([seeded.active, seeded.monthlyPriceKurus], [false, 0]);
    });

    await t.test('opening an office as a sale computes totals on the server and writes the ledger', async () => {
      const result = await platform.openOffice(pool, op, input());
      one = result.office;
      // 5 users x 200.00 x 12 = 12,000.00 + voip 50.00 x 12 = 600.00, minus 100.00
      assert.equal(result.totalKurus, 1_200_000 + 60_000);
      assert.equal(result.payableKurus, 1_260_000 - 10_000);
      assert.equal(one.status, 'enabled');
      assert.deepEqual(await ledger(one.id), [
        { kind: 'new_office', amount: 1_200_000, status: 'pending' },
        { kind: 'module', amount: 60_000, status: 'pending' },
        { kind: 'adjustment', amount: -10_000, status: 'pending' },
      ]);
      const sub = (await pool.query('SELECT * FROM han_saas.subscriptions WHERE tenant_id = $1', [one.id])).rows[0];
      assert.deepEqual(
        [sub.status, sub.plan_code, sub.seat_limit, Number(sub.user_price_kurus)],
        ['active', 'paid', 5, 20000],
      );
      assert.equal((await resolve('office-one')).tenantId, one.id);
    });

    await t.test('a failed or invalid sale leaves nothing behind', async () => {
      const count = async () =>
        (await pool.query('SELECT (SELECT count(*) FROM han_saas.tenants)::int t, (SELECT count(*) FROM han_saas.sales)::int s')).rows[0];
      const before = await count();
      for (const [bad, code] of [
        [{ slug: 'office-two', moduleCodes: ['marketing-routes'] }, 400],
        [{ slug: 'office-two', moduleCodes: ['nope'] }, 400],
        [{ slug: 'office-two', discountKurus: 99_999_999 }, 400],
        [{ slug: 'office-two', userPriceKurus: 199.5 }, 400],
        [{ slug: 'office-two', userCount: 0 }, 400],
        [{ slug: 'office-two', termMonths: 37 }, 400],
        [{ slug: 'office-two', userPriceKurus: -1 }, 400],
        [{ slug: 'office-two', userPriceKurus: '200' }, 400],
        [{ slug: 'office-one' }, 409],
      ])
        await assert.rejects(platform.openOffice(pool, op, input(bad)), status(code), JSON.stringify(bad));
      assert.deepEqual(await count(), before);
    });

    await t.test('users: increases are prorated, decreases respect existing users', async () => {
      const up = await platform.changeUsers(pool, op, { tenantId: one.id, userCount: 8 });
      // 3 extra users for ~12 months at 200.00: between 11.9 and 12.2 months.
      assert.ok(up.chargeKurus > 3 * 20000 * 11.9 && up.chargeKurus < 3 * 20000 * 12.2, String(up.chargeKurus));
      const overridden = await platform.changeUsers(pool, op, { tenantId: one.id, userCount: 9, chargeKurus: 1234, paid: true });
      assert.equal(overridden.chargeKurus, 1234);
      await assert.rejects(platform.changeUsers(pool, op, { tenantId: one.id, userCount: 0 }), status(400));
      // The office has its 1 owner account; cannot go below that, can go to exactly that.
      const invite = await createInvitation(pool, { tenantId: one.id, invitedBy: one.adminUserId, role: 'staff' });
      await acceptInvitation(pool, { token: invite.token, name: 'İki', username: 'iki', password: secret });
      await platform.changeUsers(pool, op, { tenantId: one.id, userCount: 2 });
      await assert.rejects(platform.changeUsers(pool, op, { tenantId: one.id, userCount: 1 }), status(409));
      const price = await platform.changeUsers(pool, op, { tenantId: one.id, userCount: 2, userPriceKurus: 15000 });
      assert.equal(price.chargeKurus, 0);
      await platform.changeUsers(pool, op, { tenantId: one.id, userCount: 5, userPriceKurus: 20000, chargeKurus: 0 });
      // The limit set by the sale is what invitations enforce.
      const full = await createInvitation(pool, { tenantId: one.id, invitedBy: one.adminUserId, role: 'staff' });
      for (const username of ['u3', 'u4', 'u5']) {
        const i = await createInvitation(pool, { tenantId: one.id, invitedBy: one.adminUserId, role: 'staff' });
        await acceptInvitation(pool, { token: i.token, name: username, username, password: secret });
      }
      await assert.rejects(
        acceptInvitation(pool, { token: full.token, name: 'Fazla', username: 'fazla', password: secret }),
        status(409),
      );
    });

    await t.test('modules: add, duplicate, inactive, remove and re-add', async () => {
      await platform.upsertModule(pool, { code: 'ai-assistant', name: 'AI', monthlyPriceKurus: 9000, active: false });
      await assert.rejects(platform.addModule(pool, op, { tenantId: one.id, moduleCode: 'ai-assistant' }), status(400));
      await assert.rejects(platform.addModule(pool, op, { tenantId: one.id, moduleCode: 'voip' }), status(409));
      const added = await platform.addModule(pool, op, { tenantId: one.id, moduleCode: 'whatsapp' });
      assert.ok(added.chargeKurus > 3000 * 11.9 && added.chargeKurus < 3000 * 12.2);
      // A later catalog price change does not alter what the office already agreed to.
      await platform.upsertModule(pool, { code: 'whatsapp', name: 'WhatsApp', monthlyPriceKurus: 7000, active: true });
      const locked = (await platform.officeDetail(pool, { tenantId: one.id })).modules.find((m) => m.code === 'whatsapp');
      assert.equal(locked.priceKurus, 3000);
      await platform.removeModule(pool, op, { tenantId: one.id, moduleCode: 'whatsapp' });
      await assert.rejects(platform.removeModule(pool, op, { tenantId: one.id, moduleCode: 'whatsapp' }), status(404));
      const again = await platform.addModule(pool, op, { tenantId: one.id, moduleCode: 'whatsapp', chargeKurus: 0 });
      assert.equal(again.priceKurus, 7000);
      await platform.removeModule(pool, op, { tenantId: one.id, moduleCode: 'whatsapp' });
    });

    await t.test('renewal extends from the later date and bills agreed prices', async () => {
      const before = (await pool.query('SELECT access_until FROM han_saas.subscriptions WHERE tenant_id = $1', [one.id])).rows[0];
      const renewed = await platform.renewOffice(pool, op, { tenantId: one.id, termMonths: 6, discountKurus: 5000, paid: true });
      // 5 users x 200.00 x 6 + voip 50.00 x 6
      assert.equal(renewed.totalKurus, 5 * 20000 * 6 + 5000 * 6);
      const after = (await pool.query('SELECT access_until FROM han_saas.subscriptions WHERE tenant_id = $1', [one.id])).rows[0];
      const days = (new Date(after.access_until) - new Date(before.access_until)) / 86400000;
      assert.ok(days > 180 && days < 186, String(days));
      await assert.rejects(platform.renewOffice(pool, op, { tenantId: one.id, termMonths: 6, discountKurus: 99_999_999_999 }), status(400));
      await assert.rejects(platform.renewOffice(pool, op, { tenantId: 'x', termMonths: 6 }), status(404));
    });

    await t.test('ledger: pay, void, refund and their limits', async () => {
      const pending = (await pool.query("SELECT id FROM han_saas.sales WHERE tenant_id = $1 AND kind = 'new_office'", [one.id])).rows[0].id;
      await platform.markSalePaid(pool, op, { saleId: pending, invoiceNo: 'FTR-001' });
      await assert.rejects(platform.markSalePaid(pool, op, { saleId: pending }), status(409));
      await assert.rejects(platform.voidSale(pool, op, { saleId: pending, reason: 'x' }), status(400));
      const sale = (await pool.query("SELECT id FROM han_saas.sales WHERE tenant_id = $1 AND kind = 'module' AND status = 'pending'", [one.id])).rows[0];
      await platform.voidSale(pool, op, { saleId: sale.id, reason: 'Hatalı giriş' });
      await assert.rejects(platform.markSalePaid(pool, op, { saleId: sale.id }), status(409));
      const row = (await pool.query('SELECT status, paid_at, void_reason FROM han_saas.sales WHERE id = $1', [sale.id])).rows[0];
      assert.deepEqual([row.status, row.paid_at, row.void_reason], ['void', null, 'Hatalı giriş']);
      await assert.rejects(platform.recordRefund(pool, op, { tenantId: one.id, amountKurus: 99_999_999_999, description: 'çok' }), status(409));
      await platform.recordRefund(pool, op, { tenantId: one.id, amountKurus: 50_000, description: 'Kısmi iade' });
      await assert.rejects(platform.recordRefund(pool, op, { tenantId: one.id, amountKurus: 0, description: 'sıfır' }), status(400));
      // Direct database writes cannot bypass the sign rules either.
      await assert.rejects(
        pool.query(`INSERT INTO han_saas.sales(id, tenant_id, kind, description, amount_kurus, created_by)
          VALUES (gen_random_uuid(), $1, 'refund', 'x', 100, $2)`, [one.id, op]),
        (e) => e.code === '23514',
      );
    });

    await t.test('taking an office offline is immediate, reversible and audited', async () => {
      await assert.rejects(platform.setOfficeStatus(pool, op, { tenantId: one.id, status: 'suspended' }), status(400));
      await platform.setOfficeStatus(pool, op, { tenantId: one.id, status: 'suspended', reason: 'Ödeme gecikmesi' });
      await assert.rejects(resolve('office-one'), status(403));
      await assert.rejects(platform.setOfficeStatus(pool, op, { tenantId: one.id, status: 'suspended', reason: 'tekrar' }), status(409));
      // Sales still work on a suspended office (e.g. the payment that reactivates it).
      await platform.renewOffice(pool, op, { tenantId: one.id, termMonths: 1, paid: true });
      await platform.setOfficeStatus(pool, op, { tenantId: one.id, status: 'enabled' });
      assert.equal((await resolve('office-one')).tenantId, one.id);
      await assert.rejects(
        platform.setOfficeStatus(pool, op, { tenantId: '00000000-0000-0000-0000-000000000001', status: 'suspended', reason: 'deneme' }),
        status(409),
      );
      const events = (await platform.officeDetail(pool, { tenantId: one.id })).events.map((e) => e.action);
      assert.ok(['status_suspended', 'status_enabled', 'office_opened'].every((a) => events.includes(a)));
    });

    await t.test('an expired subscription cannot be re-enabled, and closing is final', async () => {
      const two = (await platform.openOffice(pool, op, input({ slug: 'office-two', name: 'İkinci', admin: { name: 'B', username: 'bora', password: secret }, moduleCodes: [], discountKurus: 0, paid: true }))).office;
      await platform.setOfficeStatus(pool, op, { tenantId: two.id, status: 'suspended', reason: 'Test' });
      await pool.query("UPDATE han_saas.subscriptions SET access_until = CURRENT_TIMESTAMP - interval '1 day' WHERE tenant_id = $1", [two.id]);
      await assert.rejects(platform.setOfficeStatus(pool, op, { tenantId: two.id, status: 'enabled' }), status(409));
      await platform.renewOffice(pool, op, { tenantId: two.id, termMonths: 1, paid: true });
      await platform.setOfficeStatus(pool, op, { tenantId: two.id, status: 'enabled' });
      await platform.setOfficeStatus(pool, op, { tenantId: two.id, status: 'closed', reason: 'Sözleşme sona erdi' });
      await assert.rejects(platform.setOfficeStatus(pool, op, { tenantId: two.id, status: 'enabled' }), status(409));
      await assert.rejects(platform.renewOffice(pool, op, { tenantId: two.id, termMonths: 1 }), status(409));
      await assert.rejects(resolve('office-two'), status(403));
    });

    await t.test('dashboard totals agree with the ledger', async () => {
      const d = await platform.dashboard(pool);
      const paid = (await pool.query("SELECT sum(amount_kurus)::int AS n FROM han_saas.sales WHERE status = 'paid'")).rows[0].n;
      const pending = (await pool.query("SELECT sum(amount_kurus)::int AS n FROM han_saas.sales WHERE status = 'pending'")).rows[0].n;
      assert.equal(d.revenue.paidKurus, paid);
      assert.equal(d.revenue.pendingKurus, pending);
      assert.equal(d.revenue.months.length, 12);
      assert.equal(d.revenue.months.reduce((s, m) => s + m.kurus, 0), paid, 'all sales fall in the last 12 months');
      assert.equal(d.revenue.thisMonthKurus, paid);
      assert.equal(d.revenue.byKind.reduce((s, k) => s + k.kurus, 0), paid);
      assert.deepEqual(
        [d.offices.total, d.offices.enabled, d.offices.closed, d.offices.provisioning],
        [3, 1, 1, 1], // office-one, office-two (closed), and the legacy office (provisioning)
      );
      // MRR counts only enabled, active, unexpired offices: office-one = 5 users x 200.00 + voip 50.00.
      assert.equal(d.revenue.mrrKurus, 5 * 20000 + 5000);
      assert.equal(d.users.sold, 5);
      assert.equal(d.users.used, 5);
      assert.equal(d.attention.fullSeats, 1);
      const legacy = d.officeList.find((o) => o.legacy);
      assert.deepEqual([legacy.subscription, legacy.monthlyKurus], [null, 0]);
      const voip = d.modules.find((m) => m.code === 'voip');
      assert.deepEqual([voip.offices, voip.monthlyKurus], [1, 5000]);
      assert.ok(d.pendingSales.every((s) => s.amountKurus !== 0));
      assert.equal(d.pendingSales.reduce((s, x) => s + x.amountKurus, 0), pending);
    });
  } finally {
    await pg.close();
  }
});
