const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto'),
  fs = require('node:fs');
const { JSDOM } = require('jsdom'),
  { parsers } = require('prettier/plugins/babel');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');
const { recognizedCollectionRevenue } = require('../outputs/icrapro/profit-rules.js');
test('Browser accepts parking payments above remaining and additional payments after closure', () => {
  for (const closed of [false, true]) {
    const dom = new JSDOM('<dialog id="modal"></dialog>', {
        url: 'http://localhost',
        runScripts: 'dangerously',
      }),
      w = dom.window;
    try {
      const d = {
        id: 'd',
        number: 'Y-1',
        docType: 'Yediemin Park Ücreti',
        parkingCommissionRate: 20,
        amount: 1000,
        status: closed ? 'İnfaz' : 'Derdest',
        ...(closed ? { closedDate: '2026-10-02' } : {}),
      };
      const events = closed
        ? [
            {
              id: 'prior',
              documentId: 'd',
              type: 'payment',
              amount: 100000,
              date: '2026-10-02',
              closes: true,
              parkingCommissionRate: 20,
            },
          ]
        : [];
      const notices = [];
      Object.assign(w, {
        $: (q) => w.document.querySelector(q),
        esc: (v) => String(v ?? ''),
        money: String,
        financeCents: (v) => Math.round(Number(v) * 100),
        hanAuth: { role: 'staff' },
        db: { docs: [d], clients: [] },
        accounting: { accounts: [{ id: 'cash', name: 'Kasa' }] },
        financeEvents: events,
        recognizedCollectionRevenue,
        activeOperator: () => ({ id: 'p', name: 'Personel' }),
        accountBalance: () => 1000000,
        stats() {},
        toast: (m) => notices.push(m),
      });
      w.eval(fs.readFileSync('outputs/icrapro/finance-operations.js', 'utf8'));
      const source = fs.readFileSync('outputs/icrapro/form-inputs.js', 'utf8'),
        node = parsers.babel
          .parse(source)
          .program.body.find((n) => n.type === 'FunctionDeclaration' && n.id.name === 'field');
      w.eval(source.slice(node.start, node.end));
      Object.assign(w, {
        docFinance: () => ({
          principal: 100000,
          received: closed ? 100000 : 0,
          remaining: closed ? 0 : 100000,
          expenses: 0,
          target: 100000,
        }),
        collectionAccountField: () =>
          '<label><select name="accountId"><option value="cash">Kasa</option></select></label>',
        setupFinanceOperationTabs() {},
        bindFinanceHistory() {},
        financeHistoryMarkup: () => '',
        authApi: () => ({ balance: 0 }),
        saveDocumentFinance() {},
      });
      w.HTMLDialogElement.prototype.showModal = function () {
        this.open = true;
      };
      w.financialOperations('d');
      const form = w.document.getElementById('financeEntry');
      for (const [key, value] of Object.entries({
        amount: '2500',
        date: w.businessDate(),
        accountId: 'cash',
        note: 'Örnek tahsilat',
      }))
        form.elements[key].value = value;
      w.financialOperations = () => {};
      form.onsubmit({ preventDefault() {}, target: form });
      assert.equal(events.length, closed ? 2 : 1, notices.join('; '));
      const last = events.at(-1);
      assert.equal(last.amount, 250000);
      assert.equal(last.closes, !closed);
      assert.equal(last.parkingPostClosure, closed);
      assert.equal(last.revenuePart, 50000);
      assert.equal(d.status, 'İnfaz');
      if (closed) assert.equal(d.closedDate, '2026-10-02');
    } finally {
      dom.window.close();
    }
  }
});
test('API accepts uncapped parking collections, preserves first closure, pays actual client share and keeps period profit stable', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-12T10:00:00Z') });
  const { pg, pool } = await database();
  let server;
  try {
    const s = fixture();
    s.data['icrapro-v1'].clients = [{ id: 'c', name: 'Müvekkil' }];
    s.data['icrapro-v1'].docs = [
      {
        id: 'y',
        client: 'c',
        number: 'Y-1',
        debtor: 'Borçlu',
        amount: 1000,
        docType: 'Yediemin Park Ücreti',
        parkingCommissionRate: 20,
        parkingEntry: '2026-01-01',
        status: 'Derdest',
      },
      {
        id: 's',
        client: 'c',
        number: 'S-1',
        debtor: 'Diğer Borçlu',
        amount: 1000,
        docType: 'Senet',
        status: 'Derdest',
        financeTermsManual: true,
        financeInterest: 0,
        financeFee: 0,
      },
    ];
    s.data['hanhukuk-accounting-v1'] = { accounts: [{ id: 'cash', name: 'Kasa' }], entries: [] };
    s.data['hanhukuk-finance-v1'] = [
      {
        id: 'partial',
        documentId: 'y',
        type: 'payment',
        amount: 40000,
        date: '2026-10-01',
        accountId: 'cash',
      },
    ];
    await importState(pool, s);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(require('../lib/application.cjs').createApplication({ store }));
    const login = await fetch(server.url + '/api/login', {
      method: 'POST',
      headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test', password }),
    });
    assert.equal(login.status, 200);
    const headers = {
        cookie: login.headers.get('set-cookie').split(';')[0],
        'X-Han-Request': '1',
        'Content-Type': 'application/json',
      },
      req = { headers };
    const collect = async (id, documentId, amount, date) => {
      const e = {
        id,
        documentId,
        type: 'payment',
        amount,
        date,
        accountId: 'cash',
        note: 'Örnek',
        turnoverStaffId: 'turnover:bonus',
        closes: true,
        closedAmount: 999999,
        parkingPostClosure: false,
        revenuePart: 999999,
      };
      const r = await fetch(server.url + '/api/data/patch?key=hanhukuk-finance-v1', {
        method: 'PUT',
        headers,
        body: JSON.stringify(diff('hanhukuk-finance-v1', [], [e])),
      });
      return { status: r.status, body: await r.json() };
    };
    const first = await collect('close', 'y', 100000, '2026-10-02');
    assert.equal(first.status, 200, JSON.stringify(first));
    let saved = await store.readState(),
      doc = saved.data['icrapro-v1'].docs.find((d) => d.id === 'y'),
      event = saved.data['hanhukuk-finance-v1'].find((e) => e.id === 'close');
    assert.equal(doc.status, 'İnfaz');
    assert.equal(doc.closedDate, '2026-10-02');
    assert.equal(event.closes, true);
    assert.equal(event.closedAmount, 100000);
    assert.equal(event.parkingPostClosure, false);
    assert.equal(event.revenuePart, 28000);
    const pay = async (id, amount, date) => {
      const r = await fetch(server.url + '/api/client-payout', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id,
          documentId: 'y',
          clientId: 'c',
          accountId: 'cash',
          amount,
          date,
          note: 'Ödeme',
        }),
      });
      return { status: r.status, body: await r.json() };
    };
    assert.equal((await pay('paid-first', 112000, '2026-10-02')).status, 200);
    const extra = await collect('extra', 'y', 60000, '2026-11-12');
    assert.equal(extra.status, 200, JSON.stringify(extra));
    saved = await store.readState();
    doc = saved.data['icrapro-v1'].docs.find((d) => d.id === 'y');
    event = saved.data['hanhukuk-finance-v1'].find((e) => e.id === 'extra');
    assert.equal(doc.closedDate, '2026-10-02');
    assert.equal(event.parkingPostClosure, true);
    assert.equal(event.closes, false);
    assert.equal(event.closedAmount, 0);
    assert.equal(event.revenuePart, 12000);
    assert.equal(saved.data['hanhukuk-finance-v1'].filter((e) => e.documentId === 'y' && e.closes).length, 1);
    const all = saved.data['hanhukuk-finance-v1'];
    assert.equal(
      all.reduce((sum, e) => sum + recognizedCollectionRevenue(e, all, doc), 0),
      40000,
    );
    const { dashboard } = require('../lib/record-store/dashboard.cjs');
    const month = async (date) => (await dashboard(pool, req, { period: 'month', date })).buckets;
    const october = await month('2026-10-01'),
      november = await month('2026-11-01');
    assert.equal(
      october.reduce((sum, b) => sum + Number(b.revenue), 0),
      28000,
    );
    assert.equal(
      november.reduce((sum, b) => sum + Number(b.revenue), 0),
      12000,
    );
    assert.equal(
      november.reduce((sum, b) => sum + Number(b.closedCount), 0),
      0,
    );
    const { revenueCTE } = require('../lib/record-store/report-sql.cjs');
    const rows = (await pool.query('WITH ' + revenueCTE + ' SELECT id,revenue::text FROM revenues')).rows;
    assert.equal(rows.find((r) => r.id === 'close').revenue, '28000');
    assert.equal(rows.find((r) => r.id === 'extra').revenue, '12000');
    const detail = await require('../lib/record-store/client-payouts.cjs').payoutDetail(pool, req, 'y');
    assert.equal(detail.totals.entitlement, '160000');
    assert.equal(detail.totals.paid, '112000');
    assert.equal(detail.totals.remaining, '48000');
    assert.equal((await pay('too-much', 48001, '2026-11-12')).status, 400);
    assert.equal((await pay('paid-rest', 48000, '2026-11-12')).status, 200);
    assert.equal((await collect('standard-over', 's', 100001, '2026-11-12')).status, 409);
    assert.equal(
      (await store.readState()).data['hanhukuk-finance-v1'].some((e) => e.id === 'standard-over'),
      false,
    );
  } finally {
    await server?.close();
    await pg.close();
  }
});
