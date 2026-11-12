const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, serve } = require('./support/postgres.cjs');
const { createPlatformAdmin } = require('../lib/saas/platform-auth.cjs');
const { createPlatformHandler } = require('../lib/platform-app.cjs');
const platform = require('../lib/saas/platform.cjs');
const online = require('../lib/saas/online-payments.cjs');

const secret = 'Synthetic-Payments-Test-Only!';
const status = (code) => (error) => error.status === code;
const buyer = { name: 'Ada', surname: 'Yönetici', email: 'ada@example.com', address: 'Örnek Mahallesi No 1', city: 'İstanbul' };

// A stand-in for lib/iyzico.cjs. `outcome` decides what "iyzico" reports for a token.
function fakeIyzico() {
  const calls = { initialize: [], retrieve: [] };
  const state = { next: 1, paid: new Map(), failInitialize: false };
  return {
    calls,
    state,
    async initializeCheckout(input) {
      calls.initialize.push(input);
      if (state.failInitialize) throw Object.assign(new Error('iyzico: Geçersiz adres'), { status: 502 });
      const token = 'token-' + state.next++ + '-xxxxxxxx';
      state.paid.set(token, { conversationId: input.conversationId, amountKurus: input.amountKurus });
      return { token, paymentPageUrl: 'https://sandbox-cpp.iyzipay.com?token=' + token };
    },
    async retrieveCheckout(token, conversationId) {
      calls.retrieve.push({ token, conversationId });
      const known = state.paid.get(token);
      if (!known || known.status === 'unpaid') return { paid: false, paymentStatus: known?.status === 'unpaid' ? 'FAILURE' : 'FAILURE', paymentId: null, conversationId, basketId: conversationId, currency: 'TRY', priceKurus: 0, paidKurus: 0 };
      return {
        paid: true, paymentStatus: 'SUCCESS', paymentId: 'pid-' + token, conversationId: known.conversationId, basketId: known.basketId ?? known.conversationId,
        currency: known.currency ?? 'TRY', priceKurus: known.amountKurus, paidKurus: known.paidKurus ?? known.amountKurus,
      };
    },
  };
}

async function setup() {
  const { pg, pool } = await database();
  const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Operatör', password: secret })).id;
  await platform.upsertModule(pool, { code: 'voip', name: 'Çağrı', monthlyPriceKurus: 5000, active: true });
  const open = async (slug, extra = {}) =>
    (await platform.openOffice(pool, op, {
      slug, name: 'Ödeme ' + slug, admin: { name: 'Y', username: 'y' + slug.length, password: secret },
      userCount: 5, userPriceKurus: 20000, termMonths: 12, moduleCodes: ['voip'], discountKurus: 10000, paid: false, ...extra,
    })).office;
  return { pg, pool, op, open };
}
const salesOf = async (pool, tenantId) => (await pool.query('SELECT status, amount_kurus::int AS net FROM han_saas.sales WHERE tenant_id = $1 ORDER BY amount_kurus DESC', [tenantId])).rows;
const link = (pool, op, tenantId, iyzico, extra = {}) =>
  online.createPaymentLink(pool, op, { tenantId, buyer, ...extra }, { iyzico, callbackUrl: 'https://admin.han.example/api/platform/pay/callback', clientIp: '203.0.113.9' });

test('payment link covers every pending row at the KDV-inclusive total and the callback marks them paid', async (t) => {
  const { pg, pool, op, open } = await setup();
  try {
    const iyzico = fakeIyzico();
    const office = await open('birinci');
    // users 12000.00 + module 600.00 − discount 100.00 = 12500.00 net; KDV 20% = 2500.00; gross 15000.00
    const created = await link(pool, op, office.id, iyzico);
    assert.equal(created.amountKurus, 1_500_000);
    assert.match(created.url, /^https:\/\/sandbox-cpp\.iyzipay\.com\?token=/);
    assert.equal(iyzico.calls.initialize[0].amountKurus, 1_500_000);
    assert.equal(iyzico.calls.initialize[0].conversationId, created.paymentId);
    assert.equal(iyzico.calls.initialize[0].buyer.id, office.id);
    assert.equal(iyzico.calls.initialize[0].ip, '203.0.113.9');

    await t.test('nothing is marked paid until iyzico confirms', async () => {
      assert.ok((await salesOf(pool, office.id)).every((s) => s.status === 'pending'));
      assert.equal((await online.listPayments(pool, office.id))[0].status, 'initiated');
      assert.equal((await online.listPayments(pool, office.id))[0].url, created.url);
    });

    const token = iyzico.calls.initialize.length && [...iyzico.state.paid.keys()][0];
    await t.test('an unpaid callback leaves the sales pending', async () => {
      iyzico.state.paid.get(token).status = 'unpaid';
      assert.deepEqual(await online.completePayment(pool, token, { iyzico }), { status: 'failed' });
      assert.ok((await salesOf(pool, office.id)).every((s) => s.status === 'pending'));
    });

    await t.test('a confirmed payment marks all rows paid once; repeating the callback changes nothing', async () => {
      const second = await link(pool, op, office.id, iyzico);
      const token2 = [...iyzico.state.paid.keys()][1];
      assert.deepEqual(await online.completePayment(pool, token2, { iyzico }), { status: 'paid' });
      assert.ok((await salesOf(pool, office.id)).every((s) => s.status === 'paid'));
      const before = iyzico.calls.retrieve.length;
      assert.deepEqual(await online.completePayment(pool, token2, { iyzico }), { status: 'paid' });
      assert.equal(iyzico.calls.retrieve.length, before, 'a repeated callback does not call iyzico again');
      const events = (await pool.query("SELECT action FROM han_saas.tenant_events WHERE tenant_id = $1 AND action = 'online_payment'", [office.id])).rows;
      assert.equal(events.length, 1);
      assert.ok(second.paymentId);
    });

    await t.test('nothing is left to collect afterwards', async () => {
      await assert.rejects(() => link(pool, op, office.id, iyzico), status(409));
    });
  } finally {
    await pg.close();
  }
});

test('a payment that does not match what was asked is parked for review and not applied', async (t) => {
  const { pg, pool, op, open } = await setup();
  try {
    const iyzico = fakeIyzico();
    for (const [name, tamper] of [
      ['a different amount', { paidKurus: 1 }],
      ['a different conversation', { conversationId: 'someone-else' }],
      ['a different currency', { currency: 'USD' }],
      ['a different basket', { basketId: 'other' }],
    ]) {
      await t.test(name, async () => {
        const office = await open('inceleme-' + name.replace(/\W/g, '').slice(-6));
        const created = await link(pool, op, office.id, iyzico);
        const token = [...iyzico.state.paid.keys()].at(-1);
        Object.assign(iyzico.state.paid.get(token), tamper);
        const result = await online.completePayment(pool, token, { iyzico });
        assert.equal(result.status, 'review');
        assert.ok((await salesOf(pool, office.id)).every((s) => s.status === 'pending'), 'ledger untouched');
        const stored = (await online.listPayments(pool, office.id))[0];
        assert.equal(stored.status, 'review');
        assert.match(stored.note, /iyzico/);
        assert.ok(created.paymentId);
      });
    }

    await t.test('sales that changed while the customer was paying are not half applied', async () => {
      const office = await open('degisti');
      await link(pool, op, office.id, iyzico);
      const token = [...iyzico.state.paid.keys()].at(-1);
      const [first] = (await pool.query("SELECT id FROM han_saas.sales WHERE tenant_id = $1 AND kind = 'new_office'", [office.id])).rows;
      await platform.voidSale(pool, op, { saleId: first.id, reason: 'Yanlış satış' });
      const result = await online.completePayment(pool, token, { iyzico });
      assert.equal(result.status, 'review');
      const rows = await salesOf(pool, office.id);
      assert.ok(!rows.some((r) => r.status === 'paid'), 'no row was marked paid');
    });
  } finally {
    await pg.close();
  }
});

test('only the newest link completes; a paid old link is flagged, and failures are recorded', async () => {
  const { pg, pool, op, open } = await setup();
  try {
    const iyzico = fakeIyzico();
    const office = await open('yenilenen');
    await link(pool, op, office.id, iyzico);
    await link(pool, op, office.id, iyzico);
    const [oldToken, newToken] = [...iyzico.state.paid.keys()];
    const statuses = (await pool.query('SELECT status FROM han_saas.online_payments WHERE tenant_id = $1 ORDER BY created_at', [office.id])).rows.map((r) => r.status);
    assert.deepEqual(statuses, ['superseded', 'initiated']);
    // The customer kept the old page open and paid there.
    assert.equal((await online.completePayment(pool, oldToken, { iyzico })).status, 'review');
    assert.ok((await salesOf(pool, office.id)).every((s) => s.status === 'pending'), 'the old link never marks sales paid');
    assert.equal((await online.completePayment(pool, newToken, { iyzico })).status, 'paid');

    const other = await open('hatali');
    iyzico.state.failInitialize = true;
    await assert.rejects(() => link(pool, op, other.id, iyzico), status(502));
    assert.equal((await online.listPayments(pool, other.id))[0].status, 'failed');
    assert.match((await online.listPayments(pool, other.id))[0].note, /Geçersiz adres/);
  } finally {
    await pg.close();
  }
});

test('creating a link is validated and needs a configured iyzico account', async () => {
  const { pg, pool, op, open } = await setup();
  try {
    const iyzico = fakeIyzico();
    const office = await open('dogrulama');
    await assert.rejects(() => link(pool, op, office.id, null), status(412));
    for (const bad of [{ email: 'nope' }, { name: '' }, { address: 'x' }, { identityNumber: '123' }, { gsmNumber: 'abc' }])
      await assert.rejects(() => link(pool, op, office.id, iyzico, { buyer: { ...buyer, ...bad } }), status(400), JSON.stringify(bad));
    await assert.rejects(() => link(pool, op, '11111111-1111-4111-8111-111111111111', iyzico), status(404));
    await assert.rejects(() => link(pool, op, 'not-a-uuid', iyzico), status(404));
    assert.equal(iyzico.calls.initialize.length, 0, 'nothing reached iyzico');
    const paidOffice = await open('odenmis', { paid: true });
    await assert.rejects(() => link(pool, op, paidOffice.id, iyzico), status(409), 'no pending sales');
    await assert.rejects(() => online.completePayment(pool, 'no-such-token-123', { iyzico }), status(404));
    await assert.rejects(() => online.completePayment(pool, 'x', { iyzico }), status(404));
    assert.equal(iyzico.calls.retrieve.length, 0, 'unknown tokens never reach iyzico');
  } finally {
    await pg.close();
  }
});

test('payment over HTTP: link needs a session; the callback needs none and shows plain text', async () => {
  const { pg, pool, op, open } = await setup();
  const iyzico = fakeIyzico();
  const server = await serve(createPlatformHandler({ pool, secureCookies: false, iyzico }));
  try {
    const office = await open('http-odeme');
    const call = async (path, { method = 'GET', body, cookie, headers = {} } = {}) => {
      const response = await fetch(server.url + '/api/platform/' + path, {
        method,
        headers: { ...(method === 'POST' && !headers['Content-Type'] ? { 'Content-Type': 'application/json', 'X-Han-Request': '1' } : {}), ...(cookie ? { cookie } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const raw = await response.text();
      let json;
      try { json = JSON.parse(raw); } catch { json = undefined; }
      return { status: response.status, json, raw, setCookie: response.headers.get('set-cookie'), headers: response.headers };
    };
    assert.equal((await call(`offices/${office.id}/payment-link`, { method: 'POST', body: { buyer } })).status, 401);
    const cookie = (await call('login', { method: 'POST', body: { username: 'root', password: secret } })).setCookie.split(';')[0];
    assert.equal((await call('dashboard', { cookie })).json.onlinePaymentsConfigured, true);

    const created = await call(`offices/${office.id}/payment-link`, { method: 'POST', cookie, body: { buyer } });
    assert.equal(created.status, 200, created.raw);
    assert.equal(created.json.amountKurus, 1_500_000);
    assert.match(iyzico.calls.initialize[0].callbackUrl, /^http:\/\/127\.0\.0\.1:\d+\/api\/platform\/pay\/callback$/);
    assert.equal((await call(`offices/${office.id}`, { cookie })).json.payments[0].status, 'initiated');

    // The callback is a cross-site form POST with no cookie and no request header.
    const token = [...iyzico.state.paid.keys()][0];
    const callback = await call('pay/callback', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://sandbox-cpp.iyzipay.com' }, body: 'token=' + encodeURIComponent(token) });
    assert.equal(callback.status, 200);
    assert.match(callback.headers.get('content-type'), /text\/html/);
    assert.match(callback.raw, /Ödemeniz alındı/);
    assert.match(callback.headers.get('content-security-policy'), /default-src 'none'/);
    assert.ok((await salesOf(pool, office.id)).every((s) => s.status === 'paid'));

    const unknown = await call('pay/callback', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=does-not-exist-123' });
    assert.equal(unknown.status, 200);
    assert.match(unknown.raw, /Ödeme sonucu alınamadı/);
    assert.ok(!unknown.raw.includes('does-not-exist'), 'the token is never echoed into the page');
    const garbage = await call('pay/callback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    assert.match(garbage.raw, /Ödeme sonucu alınamadı/);
    assert.equal((await call('pay/callback')).status, 401, 'only POST is open; GET still needs a session');
    const oversized = await call('pay/callback', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=' + 'a'.repeat(20000) });
    assert.match(oversized.raw, /Ödeme sonucu alınamadı/);
  } finally {
    await server.close();
    await pg.close();
  }
});

test('without an iyzico account the console says so instead of failing', async () => {
  const { pg, pool, op, open } = await setup();
  const server = await serve(createPlatformHandler({ pool, secureCookies: false }));
  try {
    const office = await open('hesapsiz');
    const login = await fetch(server.url + '/api/platform/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' }, body: JSON.stringify({ username: 'root', password: secret }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const dashboard = await (await fetch(server.url + '/api/platform/dashboard', { headers: { cookie } })).json();
    assert.equal(dashboard.onlinePaymentsConfigured, false);
    const res = await fetch(server.url + `/api/platform/offices/${office.id}/payment-link`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', 'X-Han-Request': '1' }, body: JSON.stringify({ buyer }) });
    assert.equal(res.status, 412);
    assert.match((await res.json()).error, /yapılandırılmadı/);
    void op;
  } finally {
    await server.close();
    await pg.close();
  }
});
