const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto'),
  fs = require('node:fs'),
  vm = require('node:vm');
const { parsers } = require('prettier/plugins/babel');
const { fixture, database, serve } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { recognizedCollectionRevenue } = require('../outputs/icrapro/profit-rules.js');
test('Browser settlement uses received money only on Infaz; principal edits cannot change the client share', () => {
  const ctx = {
    financeCents: (v) => Math.round(Number(v || 0) * 100),
    accounting: { entries: [] },
    money: String,
    docFinance: () => ({ principal: 100000, received: 80000, remaining: 0 }),
  };
  vm.createContext(ctx);
  const source = fs.readFileSync('outputs/icrapro/finance-operations.js', 'utf8');
  for (const node of parsers.babel.parse(source).program.body)
    if (
      node.type === 'FunctionDeclaration' &&
      [
        'isParkingDocument',
        'validParkingRate',
        'parkingCommission',
        'parkingCommissionMarkup',
        'clientPayoutTotals',
      ].includes(node.id.name)
    )
      vm.runInContext(source.slice(node.start, node.end), ctx);
  const d = { id: 'd', docType: 'Yediemin Park Ücreti', status: 'İnfaz', parkingCommissionRate: 20 };
  assert.equal(ctx.clientPayoutTotals(d).entitlement, 64000);
  assert(ctx.parkingCommissionMarkup(d, ctx.docFinance()).includes('<b>640</b>'));
  ctx.docFinance = () => ({ principal: 200000, received: 80000, remaining: 0 });
  assert.equal(ctx.clientPayoutTotals(d).entitlement, 64000);
  ctx.accounting.entries.push({ type: 'clientPayout', documentId: 'd', amount: 10000 });
  assert.equal(ctx.clientPayoutTotals(d).remaining, 54000);
  for (const status of ['Derdest', 'Bekleme', 'İade']) {
    d.status = status;
    assert.equal(ctx.clientPayoutTotals(d).entitlement, 0);
    assert.equal(ctx.clientPayoutTotals(d).eligible, false);
  }
  const events = [
    { id: 'a', type: 'payment', documentId: 'd', amount: 20000 },
    { id: 'b', type: 'payment', documentId: 'd', amount: 60000, closes: true, parkingCommissionRate: 20 },
  ];
  d.status = 'İnfaz';
  assert.equal(
    events.reduce((s, e) => s + recognizedCollectionRevenue(e, events, d), 0),
    16000,
  );
  d.status = 'Derdest';
  assert.equal(
    events.reduce((s, e) => s + recognizedCollectionRevenue(e, events, d), 0),
    0,
  );
});
test('Real SQL reports, dashboard and payment command agree on discounted and over-collected parking settlements', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const s = fixture();
    s.data['icrapro-v1'].clients = [{ id: 'c', name: 'Müvekkil' }];
    s.data['icrapro-v1'].docs = [
      { id: 'low', amount: 1000, debtDiscountCents: 20000, status: 'İnfaz' },
      { id: 'over', amount: 1000, status: 'İnfaz' },
      { id: 'partial', amount: 1000, status: 'Derdest' },
      { id: 'returned', amount: 1000, status: 'İade' },
      { id: 'plain', amount: 1000, status: 'İnfaz', docType: 'Senet' },
    ].map((d) => ({
      docType: 'Yediemin Park Ücreti',
      parkingCommissionRate: 20,
      client: 'c',
      closedDate: '2026-11-12',
      number: d.id,
      debtor: 'Örnek',
      ...d,
    }));
    s.data['hanhukuk-finance-v1'] = [
      ['low', 20000, '2026-10-10', false],
      ['low', 60000, '2026-11-12', true],
      ['over', 150000, '2026-11-12', true],
      ['partial', 40000, '2026-11-12', true],
      ['returned', 4000, '2026-11-12', true],
      ['plain', 150000, '2026-11-12', true],
    ].map(([documentId, amount, date, closes], i) => ({
      id: 'p' + i,
      type: 'payment',
      documentId,
      amount,
      date,
      closes,
      accountId: 'cash',
      principalAtCollection: 100000,
      ...(documentId === 'plain' ? {} : { parkingCommissionRate: 20 }),
    }));
    s.data['hanhukuk-accounting-v1'] = { accounts: [{ id: 'cash', name: 'Kasa' }], entries: [] };
    await importState(pool, s);
    await importRecords(pool);
    await activateRecords(pool);
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,'test-ceo','desktop',$2)",
      [crypto.createHash('sha256').update(token).digest('hex'), Date.now() + 600000],
    );
    const headers = {
        cookie: 'han_session=' + token,
        'X-Han-Request': '1',
        'Content-Type': 'application/json',
      },
      req = { headers };
    const { payoutPage } = require('../lib/record-store/client-payouts.cjs');
    const page = await payoutPage(pool, req);
    assert.deepEqual(Object.fromEntries(page.items.map((d) => [d.id, d.entitlement])), {
      low: '64000',
      over: '120000',
      plain: '100000',
    });
    const { dashboard } = require('../lib/record-store/dashboard.cjs');
    const board = await dashboard(pool, req, { period: 'month', date: '2026-11-12' });
    assert.equal(
      board.buckets.reduce((s, b) => s + Number(b.revenue), 0),
      96000,
    );
    const { revenueCTE } = require('../lib/record-store/report-sql.cjs');
    const profits = await pool.query(
      'WITH ' +
        revenueCTE +
        ' SELECT document_id,sum(revenue)::text AS total FROM revenues GROUP BY document_id',
    );
    assert.deepEqual(Object.fromEntries(profits.rows.map((r) => [r.document_id, r.total])), {
      low: '16000',
      over: '30000',
      partial: '0',
      returned: '0',
      plain: '50000',
    });
    server = await serve(
      require('../lib/application.cjs').createApplication({ store: createStore(pool, { records: true }) }),
    );
    const pay = async (id, amount) => {
      const r = await fetch(server.url + '/api/client-payout', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id,
          documentId: 'low',
          clientId: 'c',
          accountId: 'cash',
          amount,
          date: '2026-11-12',
          note: 'Örnek ödeme',
        }),
      });
      return { status: r.status, data: await r.json() };
    };
    assert.equal((await pay('too-much', 64001)).status, 400);
    const ok = await pay('exact', 64000);
    assert.equal(ok.status, 200, JSON.stringify(ok));
    assert.equal((await pay('extra', 1)).status, 400);
    const entries = (
      await pool.query("SELECT amount_cents FROM han_data.ledger_entries WHERE kind='clientPayout'")
    ).rows;
    assert.equal(entries.length, 1);
    assert.equal(String(entries[0].amount_cents), '64000');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM han_data.financial_events')).rows[0].n, 6);
  } finally {
    await server?.close();
    await pg.close();
  }
});
