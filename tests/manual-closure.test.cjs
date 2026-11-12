const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { businessDate } = require('../lib/business-time.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');
test('Manual closure enforces principal floor through both the command and status edits; fees close without cash creation', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const s = fixture(),
      today = businessDate();
    s.users.push(
      { ...s.users[0], id: 'manager', username: 'manager', role: 'admin' },
      { ...s.users[0], id: 'staff', username: 'staff', role: 'staff', permissions: ['documents'] },
    );
    s.data['icrapro-v1'].clients = [{ id: 'c', name: 'Müvekkil' }];
    const amounts = {
      below: 99999,
      equal: 100000,
      above: 110000,
      'generic-below': 90000,
      'generic-above': 110000,
    };
    s.data['icrapro-v1'].docs = Object.keys(amounts).map((id) => ({
      id,
      number: 'S-' + id,
      client: 'c',
      debtor: 'Borçlu',
      amount: 1000,
      docType: 'Senet',
      financeInterest: 100,
      financeFee: 100,
      financeTermsManual: true,
      status: 'Derdest',
    }));
    s.data['hanhukuk-accounting-v1'].accounts = [{ id: 'cash', name: 'Kasa' }];
    s.data['hanhukuk-finance-v1'] = Object.entries(amounts).map(([id, amount]) => ({
      id: 'p-' + id,
      documentId: id,
      type: 'payment',
      date: today,
      amount,
      accountId: 'cash',
      principalAtCollection: 100000,
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
    const close = async (documentId, headers = manager, extra = {}) => {
      const r = await fetch(server.url + '/api/documents/manual-close', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          documentId,
          expectedPrincipal: 100000,
          expectedReceived: amounts[documentId],
          ...extra,
        }),
      });
      return { status: r.status, body: await r.json() };
    };
    assert.equal((await close('equal', staff)).status, 403);
    assert.equal((await close('below')).status, 400);
    assert.equal((await close('equal', manager, { expectedReceived: 99999 })).status, 409);
    let result = await close('equal');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.record.status, 'İnfaz');
    assert.equal(result.body.record.debtDiscountCents, 20000);
    assert.equal(result.body.record.manualClosure.waived, 20000);
    assert.equal((await close('equal')).status, 200);
    result = await close('above');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.record.debtDiscountCents, 10000);
    const generic = async (id) => {
      const before = (await store.readState()).data['icrapro-v1'],
        after = structuredClone(before);
      after.docs.find((d) => d.id === id).status = 'İnfaz';
      const r = await fetch(server.url + '/api/data/patch?key=icrapro-v1', {
        method: 'PUT',
        headers: manager,
        body: JSON.stringify(diff('icrapro-v1', before, after)),
      });
      return { status: r.status, body: await r.json() };
    };
    assert.equal((await generic('generic-below')).status, 400);
    result = await generic('generic-above');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const saved = await store.readState();
    const equal = saved.data['icrapro-v1'].docs.find((d) => d.id === 'equal');
    assert.equal(equal.discountHistory.length, 1);
    assert.equal(saved.data['icrapro-v1'].docs.find((d) => d.id === 'generic-below').status, 'Derdest');
    assert.equal(saved.data['icrapro-v1'].docs.find((d) => d.id === 'generic-above').status, 'İnfaz');
    assert.deepEqual(
      saved.data['hanhukuk-finance-v1'].map((e) => [e.id, e.amount, e.date, e.accountId]),
      s.data['hanhukuk-finance-v1'].map((e) => [e.id, e.amount, e.date, e.accountId]),
    );
    assert.equal(saved.data['hanhukuk-accounting-v1'].entries.length, 0);
    const { balance } = require('../lib/record-store/balances.cjs');
    assert.equal(balance(equal, saved.data['hanhukuk-finance-v1']).remaining_cents, '0');
    const totals = await require('../lib/record-store/dashboard.cjs').dashboard(
      pool,
      { headers: manager },
      { period: 'day', date: today },
    );
    assert.equal(totals.buckets[0].revenue, '20000');
  } finally {
    await server?.close();
    await pg.close();
  }
});
