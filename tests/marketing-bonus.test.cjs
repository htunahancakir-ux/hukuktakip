const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateMarketingBonus } = require('../outputs/icrapro/marketing-bonus.cjs');
const { stampMarketingInputs } = require('../lib/marketing-inputs.cjs');
const { syncPayrollPeriods } = require('../outputs/icrapro/payroll-periods.cjs');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { refreshPayroll } = require('../lib/record-store/payroll.cjs');
const ledger = require('../lib/personnel-ledger.cjs');
function sample(count = 0) {
  const s = fixture();
  s.data['icrapro-personnel-v1'] = ['a', 'b', 'c'].map((id) => ({
    id,
    name: id,
    active: true,
    department: 'Pazarlama',
    officialSalary: 40000,
    unofficialSalary: 1000,
  }));
  s.data['icrapro-v1'].clients = [
    {
      id: 'firm',
      name: 'Firma <img onerror=alert(1)>',
      createdAt: '2026-11-01T08:00:00.000Z',
      documentStaff: 'a',
    },
  ];
  s.data['icrapro-v1'].docs = Array.from({ length: count }, (_, i) => doc('d' + i));
  return s;
}
function doc(id, extra = {}) {
  return {
    id,
    number: 'F-' + id,
    docType: 'Senet',
    debtor: 'Örnek',
    client: 'firm',
    receivedById: 'a',
    amount: 1000,
    created: '2026-11-01T08:00:00Z',
    trackingDate: '2026-11-01',
    status: 'Derdest',
    due: '2026-10-01',
    ...extra,
  };
}
function payment(id, documentId, amount, extra = {}) {
  return { id, documentId, type: 'payment', amount, date: '2026-11-10', collectionStaffId: 'c', ...extra };
}
test('Document rate reprices all documents above 200; exact office and new-firm thresholds apply monthly', () => {
  for (const [count, expected] of [
    [0, 0],
    [199, 1990000],
    [200, 2000000],
    [201, 3015000],
  ]) {
    const row = calculateMarketingBonus(sample(count), '2026-11')[0];
    assert.equal(row.documentBonus, expected);
  }
  const s = sample(100);
  s.data['hanhukuk-finance-v1'] = [payment('office', 'unassigned', 1000000000)];
  let row = calculateMarketingBonus(s, '2026-11')[0];
  assert.equal(row.officeTargetBonus, 750000);
  assert.equal(row.newFirmBonus, 250000);
  assert.equal(row.total, 2000000);
  s.data['icrapro-v1'].docs.pop();
  assert.equal(calculateMarketingBonus(s, '2026-11')[0].officeTargetBonus, 0);
  s.data['icrapro-v1'].docs.push(doc('one-more'));
  s.data['hanhukuk-finance-v1'][0].amount--;
  assert.equal(calculateMarketingBonus(s, '2026-11')[0].officeTargetBonus, 0);
  s.data['icrapro-v1'].docs = s.data['icrapro-v1'].docs.slice(0, 9);
  assert.equal(calculateMarketingBonus(s, '2026-11')[0].newFirmBonus, 0);
  s.data['icrapro-v1'].docs.push(doc('tenth'));
  assert.equal(calculateMarketingBonus(s, '2026-11')[0].newFirmBonus, 250000);
  s.data['icrapro-v1'].docs[0].receivedById = 'non-marketing-receiver';
  assert.equal(calculateMarketingBonus(s, '2026-11')[0].newFirmBonus, 250000);
  assert.equal(calculateMarketingBonus(s, '2026-11')[0].documentCount, 9);
  assert.equal(calculateMarketingBonus(s, '2026-12')[0].total, 0);
  s.data['icrapro-v1'].clients[0].createdAt = '2026-10-31T22:00:00Z';
  assert.equal(calculateMarketingBonus(s, '2026-11')[0].newFirmBonus, 250000);
  s.data['icrapro-v1'].clients[0].createdAt = '2026-10-01T12:00:00Z';
  assert.equal(calculateMarketingBonus(s, '2026-11')[0].newFirmBonus, 0);
});
test('Parking uses monthly gross collections from historic documents and receiver ownership; ties share ranks', () => {
  const s = sample();
  s.data['icrapro-v1'].docs = ['a', 'b', 'c'].map((id) =>
    doc(id, { docType: 'Yediemin Park Ücreti', receivedById: id, trackingDate: '2026-01-01' }),
  );
  s.data['hanhukuk-finance-v1'] = [
    payment('pa', 'a', 200000000),
    payment('pb', 'b', 100000000),
    payment('pc', 'c', 99999999),
    payment('old', 'c', 999999999, { date: '2026-10-31' }),
    payment('future', 'c', 999999999, { date: '2026-11-30' }),
    { id: 'expense', documentId: 'c', type: 'expense', date: '2026-11-10', amount: 999999999 },
  ];
  let rows = calculateMarketingBonus(s, '2026-11', '2026-11-11');
  assert.deepEqual(
    rows.map((r) => r.parkingBonus),
    [1500000, 750000, 0],
  );
  assert.deepEqual(
    rows.map((r) => r.documentCount),
    [0, 0, 0],
  );
  s.data['hanhukuk-finance-v1'][1].amount = 200000000;
  rows = calculateMarketingBonus(s, '2026-11', '2026-11-11');
  assert.deepEqual(
    rows.map((r) => r.parkingBonus),
    [1500000, 1500000, 0],
  );
  assert.deepEqual(
    rows.map((r) => r.parkingRank),
    [1, 1, null],
  );
  s.data['hanhukuk-finance-v1'][0].amount = 99999999;
  s.data['hanhukuk-finance-v1'][1].amount = 99999999;
  assert(calculateMarketingBonus(s, '2026-11', '2026-11-11').every((r) => r.parkingBonus === 0));
});
test('Mixed folios count individual documents by registration month and split monthly collections by principal', () => {
  const s = sample();
  s.data['icrapro-v1'].docs = [
    doc('mixed', {
      receivables: [
        { id: 'old', docType: 'Senet', amount: 1000, registeredOn: '2026-10-01' },
        { id: 'parking', docType: 'Yediemin Park Ücreti', amount: 3000, registeredOn: '2026-11-01' },
        { id: 'future', docType: 'Fatura', amount: 0, registeredOn: '2026-12-01' },
      ],
    }),
  ];
  s.data['hanhukuk-finance-v1'] = [payment('p1', 'mixed', 100000000), payment('p2', 'mixed', 100000000)];
  const row = calculateMarketingBonus(s, '2026-11')[0];
  assert.equal(row.documentCount, 1);
  assert.equal(row.parkingCollected, 150000000);
  assert.equal(row.parkingBonus, 1500000);
  // Rounding is applied once per monthly folio total, not once per payment.
  s.data['hanhukuk-finance-v1'] = [payment('p1', 'mixed', 1), payment('p2', 'mixed', 1)];
  assert.equal(calculateMarketingBonus(s, '2026-11')[0].parkingCollected, 2);
  s.data['icrapro-v1'].docs[0].receivedById = '';
  s.data['icrapro-v1'].docs[0].receivedBy = 'a';
  assert.equal(calculateMarketingBonus(s, '2026-11')[0].documentCount, 1);
});
test('Server preserves existing acquisition dates, stamps newly appended claims, and prevents backdating clients', () => {
  const before = sample();
  before.data['icrapro-v1'].docs = [
    doc('old', {
      trackingDate: '2026-10-01',
      receivables: [
        { id: 'old-item', docType: 'Senet', amount: 100, due: '2026-01-01', registeredOn: '2026-10-01' },
      ],
    }),
  ];
  const next = structuredClone(before);
  next.data['icrapro-v1'].clients[0].createdAt = '2026-12-01';
  const items = next.data['icrapro-v1'].docs[0].receivables;
  items[0].registeredOn = '2026-11-01';
  items.push({ id: 'new', docType: 'Fatura', amount: 100, due: '2026-01-01', registeredOn: '2026-10-01' });
  next.data['icrapro-v1'].clients.push({ id: 'new', createdAt: '2020-01-01' });
  stampMarketingInputs(before, next, '2026-11-11', '2026-11-11T10:00:00Z');
  assert.equal(items[0].registeredOn, '2026-10-01');
  assert.equal(items[1].registeredOn, '2026-11-11');
  assert.equal(next.data['icrapro-v1'].clients[0].createdAt, before.data['icrapro-v1'].clients[0].createdAt);
  assert.equal(next.data['icrapro-v1'].clients[1].createdAt, '2026-11-11T10:00:00Z');
  assert.equal(
    require('../outputs/icrapro/receivable-rules.js').normalize(items)[1].registeredOn,
    '2026-11-11',
  );
});
test('SQL payroll, HTTP bonus report and current account agree; recalculation is idempotent and closed months stay fixed', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 11, 9) });
  const { pg, pool } = await database();
  let server;
  try {
    const s = sample(201);
    s.data['icrapro-v1'].clients[0].createdAt = '2026-10-31T22:00:00Z';
    s.data['icrapro-personnel-v1'][1].name = 'IŞIK İNCE';
    s.data['icrapro-v1'].docs.push(
      doc('parking', {
        docType: 'Yediemin Park Ücreti',
        amount: 2000000,
        trackingDate: '2025-01-01',
        receivedById: '',
        receivedBy: 'ışık ince',
      }),
    );
    s.data['icrapro-v1'].docs.push(
      doc('mixed-sql', {
        receivedById: 'c',
        docType: 'Diğer',
        amount: 4000,
        receivables: [
          { id: 'note', docType: 'Senet', amount: 1000, registeredOn: '2026-10-01', due: '2026-01-01' },
          { id: 'park-item', docType: 'Yediemin Park Ücreti', amount: 3000, registeredOn: '2026-11-01' },
        ],
      }),
    );
    s.data['hanhukuk-finance-v1'] = [
      payment('park', 'parking', 100000000),
      payment('office', 'd0', 860000000),
      payment('mixed-payment', 'mixed-sql', 40000000),
    ];
    const expected = calculateMarketingBonus(s, '2026-11', '2026-11-11');
    s.users.push({
      ...s.users[0],
      id: 'marketer',
      username: 'marketer',
      role: 'staff',
      staffId: 'a',
      permissions: [],
    });
    await importState(pool, s);
    await importRecords(pool);
    await activateRecords(pool);
    let periods = await refreshPayroll(pool, '2026-11-11');
    assert.deepEqual(
      periods['2026-11'].rows.map((r) => r.bonus2Details),
      expected,
    );
    const {
      rows: [meta],
    } = await pool.query('SELECT body FROM han_data.metadata WHERE id=1');
    const ledgerState = { ...meta.body, data: { ...s.data } };
    assert.equal(ledger.details(ledgerState, 'a', '2026-11-11').currentEarned, 4100000 + expected[0].total);
    const accrualCount = meta.body.personnelLedger.accruals.length;
    await refreshPayroll(pool, '2026-11-11');
    const {
      rows: [again],
    } = await pool.query('SELECT body FROM han_data.metadata WHERE id=1');
    assert.equal(again.body.personnelLedger.accruals.length, accrualCount);
    assert.equal(again.body.marketingPayrollInputs, undefined);
    // The authenticated HTTP flow uses the same real SQL projections.
    server = await serve(
      require('../lib/application.cjs').createApplication({ store: createStore(pool, { records: true }) }),
    );
    const login = await fetch(server.url + '/api/login', {
      method: 'POST',
      headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test', password }),
    });
    assert.equal(login.status, 200, await login.text());
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'X-Han-Request': '1' };
    const response = await fetch(server.url + '/api/bonus2?month=2026-11', { headers });
    const report = await response.json();
    assert.equal(response.status, 200, JSON.stringify(report));
    assert.deepEqual(report.rows, expected);
    assert.equal((await fetch(server.url + '/api/bonus2?month=bad', { headers })).status, 400);
    assert.equal((await fetch(server.url + '/api/bonus2')).status, 401);
    const staffLogin = await fetch(server.url + '/api/login', {
      method: 'POST',
      headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'marketer', password }),
    });
    assert.equal(staffLogin.status, 200, await staffLogin.text());
    const ownResponse = await fetch(server.url + '/api/bonus2?month=2026-11', {
      headers: { cookie: staffLogin.headers.get('set-cookie').split(';')[0], 'X-Han-Request': '1' },
    });
    const own = await ownResponse.json();
    assert.equal(ownResponse.status, 200, JSON.stringify(own));
    assert.equal(own.rows, undefined);
    assert.equal(own.total, expected[0].total);
    const { JSDOM } = require('jsdom');
    const fs = require('node:fs');
    const dom = new JSDOM('<div id="personnelView"></div>', { runScripts: 'dangerously', url: server.url });
    try {
      Object.assign(dom.window, {
        $: (q) => dom.window.document.querySelector(q),
        esc: (v) =>
          String(v ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('"', '&quot;'),
        money: (v) => Number(v).toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' }),
        businessDate: () => '2026-11-11',
        authApi: () => report,
      });
      dom.window.eval(
        fs.readFileSync('outputs/icrapro/personnel.js', 'utf8') +
          "\npayrollSubTab='marketing'; personnelCompensationPage(); requiredObserver.disconnect();",
      );
      assert(dom.window.document.querySelector('[data-marketing-bonus]'));
      assert(dom.window.document.body.textContent.includes('30.150'));
      assert.equal(dom.window.document.querySelectorAll('img').length, 0);
      assert.equal(dom.window.document.querySelectorAll('tbody tr').length, 3);
    } finally {
      dom.window.close();
    }
    await pool.query("UPDATE han_data.documents SET active=false WHERE id='d200'");
    const adjusted = await refreshPayroll(pool, '2026-11-11');
    assert.equal(adjusted['2026-11'].rows[0].bonus2Details.documentBonus, 2000000);
    const {
      rows: [adjustment],
    } = await pool.query('SELECT body FROM han_data.metadata WHERE id=1');
    const adjustedState = { ...adjustment.body, data: { ...s.data } };
    assert.equal(ledger.details(adjustedState, 'a', '2026-11-11').currentEarned, 7100000);
    const closed = await refreshPayroll(pool, '2026-12-01');
    const frozen = structuredClone(closed['2026-11']);
    await pool.query(
      "UPDATE han_data.financial_events SET body=jsonb_set(body,'{amount}',to_jsonb(amount_cents+1)) WHERE id='park'",
    );
    periods = await refreshPayroll(pool, '2026-12-02');
    assert.deepEqual(periods['2026-11'], frozen);
  } finally {
    await server?.close();
    await pg.close();
  }
});
