const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { businessDate } = require('../lib/business-time.cjs');
const { normalize } = require('../outputs/icrapro/receivable-rules.js');
const { recognizedCollectionRevenue } = require('../outputs/icrapro/profit-rules.js');
test('Manager adjusts multiple closed files without changing collections; profit, balances and payouts reconcile', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const s = fixture(),
      today = businessDate();
    s.users.push(
      { ...s.users[0], id: 'manager', username: 'manager', name: 'Yönetici', role: 'admin' },
      { ...s.users[0], id: 'staff', username: 'staff', role: 'staff', permissions: ['documents'] },
    );
    s.data['icrapro-v1'].clients = [{ id: 'c', name: 'Müvekkil' }];
    const common = {
      client: 'c',
      debtor: 'Borçlu',
      status: 'İnfaz',
      closedDate: today,
      amount: 1000,
      originalAmount: 1100,
      preTrackingPayment: 100,
      financeInterest: 100,
      financeFee: 100,
      financeTermsManual: true,
      clientPaidAmount: 200,
    };
    s.data['icrapro-v1'].docs = [
      { ...common, id: 'one', number: 'S-1', docType: 'Senet', fileData: 'private-test-attachment' },
      {
        ...common,
        id: 'multi',
        number: 'D-2',
        docType: 'Diğer',
        receivables: normalize([
          { id: 'n', docType: 'Senet', amount: 600, preTrackingPayment: 100, due: today },
          { id: 'f', docType: 'Fatura', amount: 500, due: today },
        ]),
      },
    ];
    s.data['hanhukuk-accounting-v1'].accounts = [{ id: 'cash', name: 'Kasa' }];
    s.data['hanhukuk-finance-v1'] = ['one', 'multi'].map((id) => ({
      id: 'pay-' + id,
      documentId: id,
      type: 'payment',
      date: today,
      amount: 120000,
      principalAtCollection: 100000,
      closes: true,
      closedAmount: 120000,
      accountId: 'cash',
    }));
    await importState(pool, s);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store }));
    const login = async (username) => {
      const r = await fetch(server.url + '/api/login', {
        method: 'POST',
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(r.status, 200, await r.text());
      return {
        cookie: r.headers.get('set-cookie').split(';')[0],
        'X-Han-Request': '1',
        'Content-Type': 'application/json',
      };
    };
    const manager = await login('manager'),
      staff = await login('staff');
    const post = async (value, headers = manager) => {
      const r = await fetch(server.url + '/api/documents/principal', {
        method: 'POST',
        headers,
        body: JSON.stringify(value),
      });
      return { status: r.status, body: await r.json() };
    };
    const change = { documentId: 'one', expectedPrincipal: 100000, amount: 80000 };
    assert.equal((await post(change, staff)).status, 403);
    assert.equal((await post({ ...change, amount: -1 })).status, 400);
    assert.equal((await post({ ...change, amount: 10000 })).status, 400);
    assert.equal((await post({ ...change, expectedPrincipal: 90000 })).status, 409);
    let result = await post(change);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.record.amount, 800);
    assert.equal(result.body.record.originalAmount, 900);
    assert.equal(result.body.record.status, 'İnfaz');
    assert.equal(result.body.record.fileData, undefined);
    let saved = await store.readState();
    assert.deepEqual(saved.data['hanhukuk-finance-v1'], s.data['hanhukuk-finance-v1']);
    assert.equal(
      recognizedCollectionRevenue(
        saved.data['hanhukuk-finance-v1'][0],
        saved.data['hanhukuk-finance-v1'],
        saved.data['icrapro-v1'].docs[0],
      ),
      40000,
    );
    assert.equal((await post(change)).status, 409);
    const multi = {
      documentId: 'multi',
      expectedPrincipal: 100000,
      items: [
        { id: 'n', expectedAmount: 50000, amount: 40000 },
        { id: 'f', expectedAmount: 50000, amount: 50000 },
      ],
    };
    result = await post(multi);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.record.amount, 900);
    assert.equal(result.body.record.originalAmount, 1000);
    assert.equal(result.body.record.receivables[0].amount, 500);
    assert.equal(result.body.record.status, 'İnfaz');
    assert.equal((await post({ ...multi, expectedPrincipal: 90000 })).status, 409);
    const dashboard = await require('../lib/record-store/dashboard.cjs').dashboard(
      pool,
      { headers: manager },
      { period: 'day', date: today },
    );
    assert.equal(dashboard.buckets[0].revenue, '70000');
    const { source } = require('../lib/record-store/report-sql.cjs');
    const { cte } = source('excel');
    const revenue = await pool.query('WITH ' + cte + ' SELECT sum(revenue)::text AS total FROM revenues');
    assert.equal(revenue.rows[0].total, '70000');
    result = await post({ documentId: 'one', expectedPrincipal: 80000, amount: 150000 });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.record.status, 'Derdest');
    assert(result.body.removedFields.includes('closedDate'));
    saved = await store.readState();
    assert.deepEqual(saved.data['hanhukuk-finance-v1'], s.data['hanhukuk-finance-v1']);
    assert.equal(saved.data['icrapro-v1'].docs[0].principalAdjustmentHistory.length, 2);
    const reopened = await require('../lib/record-store/dashboard.cjs').dashboard(
      pool,
      { headers: manager },
      { period: 'day', date: today },
    );
    assert.equal(reopened.buckets[0].revenue, '30000');
    const { balance } = require('../lib/record-store/balances.cjs');
    assert.equal(
      balance(saved.data['icrapro-v1'].docs[0], saved.data['hanhukuk-finance-v1']).remaining_cents,
      '50000',
    );
  } finally {
    await server?.close();
    await pg.close();
  }
});
test('Principal editor submits an optimistic update and refreshes the same file, including closed files', () => {
  const dom = new JSDOM('<div></div>', { runScripts: 'dangerously' });
  try {
    const w = dom.window;
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    w.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    const record = {
        id: 'one',
        number: 'S-1',
        debtor: 'Borçlu',
        docType: 'Senet',
        amount: 1000,
        status: 'İnfaz',
      },
      calls = [];
    Object.assign(w, {
      structuredClone,
      hanAuth: { role: 'admin' },
      db: { docs: [record] },
      financeCents: (v) => Math.round(Number(v || 0) * 100),
      money: String,
      esc: String,
      field: (label, name, type, value) =>
        `<label>${label}<input name="${name}" type="${type}" value="${value}"></label>`,
      authApi: (path, method, payload) => {
        calls.push({ path, method, payload });
        return { record: { amount: 800, originalAmount: 800, status: 'İnfaz' } };
      },
      toast() {},
    });
    w.eval(fs.readFileSync('outputs/icrapro/finance-operations.js', 'utf8'));
    w.financialOperations = () => {};
    w.editDocumentPrincipal('one');
    const form = w.document.querySelector('#principalDialog form');
    form.elements.principal.value = '800';
    form.dispatchEvent(new w.Event('submit', { cancelable: true }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.expectedPrincipal, 100000);
    assert.equal(calls[0].payload.amount, 80000);
    assert.equal(record.amount, 800);
    assert.equal(w.document.querySelector('#principalDialog').open, false);
  } finally {
    dom.window.close();
  }
});
