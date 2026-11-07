const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');
test('Active record storage preserves existing HTTP commands, audit, auth and scoped edits', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    state.data['icrapro-v1'] = {
      clients: [{ id: 'c', name: 'Test' }],
      docs: [
        { id: 'a', number: 'A-1', client: 'c', debtor: 'Test A', amount: 100, notes: 'first' },
        { id: 'b', number: 'B-1', client: 'c', debtor: 'Test B', amount: 200, notes: 'second' },
      ],
    };
    state.payrollPeriods = { '2026-11': { marker: 'must survive partial edits' } };
    state.data['icrapro-v1'].docs[0].fileData = 'data:application/pdf;base64,JVBERi0x';
    state.data['icrapro-v1'].docs[0].fileName = 'test.pdf';
    state.data['hanhukuk-accounting-v1'].accounts = [{ id: 'cash', name: 'Kasa' }];
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store }));
    const login = await fetch(server.url + '/api/login', {
      method: 'POST',
      headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test', password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { 'X-Han-Request': '1', 'Content-Type': 'application/json', cookie };
    const initial = await (await fetch(server.url + '/api/records/bootstrap', { headers })).json();
    assert.equal(initial.summary.documents, '2');
    assert.equal(initial.summary.documentAmountCents, '30000');
    assert.deepEqual(initial.data['icrapro-v1'].docs, []);
    assert.deepEqual(initial.data['icrapro-v1'].clients, []);
    assert.deepEqual(initial.data['hanhukuk-finance-v1'], []);
    assert.equal(initial.data['hanhukuk-accounting-v1'].accounts.length, 1);
    const context = await (
      await fetch(server.url + '/api/records/document?id=a&section=context', { headers })
    ).json();
    assert.equal(context.record.fileData, undefined);
    assert.equal(context.attachments.length, 1);
    const attachment = await (
      await fetch(
        server.url +
          '/api/records/document?' +
          new URLSearchParams({ id: 'a', section: 'attachment', attachmentId: context.attachments[0].id }),
        { headers },
      )
    ).json();
    assert.equal(attachment.value, state.data['icrapro-v1'].docs[0].fileData);
    const crossDocument = await fetch(
      server.url +
        '/api/records/document?' +
        new URLSearchParams({ id: 'b', section: 'attachment', attachmentId: context.attachments[0].id }),
      { headers },
    );
    assert.equal(crossDocument.status, 404);
    const search = await (await fetch(server.url + '/api/search?q=Test%20A', { headers })).json();
    assert.equal(search.items.filter((item) => item.type === 'document').length, 1);
    const literalSearch = await (
      await fetch(server.url + '/api/records/search?kind=client&q=%25', { headers })
    ).json();
    assert.equal(literalSearch.items.length, 0);
    const get = await fetch(server.url + '/api/data?key=icrapro-v1', { headers }),
      before = await get.json(),
      after = structuredClone(before);
    after.docs[0].notes = 'only A changed';
    const response = await fetch(server.url + '/api/data/patch?key=icrapro-v1', {
      method: 'PUT',
      headers,
      body: JSON.stringify(diff('icrapro-v1', before, after)),
    });
    const responseBody = await response.json();
    assert.equal(response.status, 200, JSON.stringify(responseBody));
    assert.equal(responseBody.records[0].value.notes, 'only A changed');
    assert.equal(responseBody.records[0].value.fileData, undefined);
    assert(responseBody.records[0].preservedFields.includes('fileData'));
    const saved = await store.readState();
    assert.equal(saved.data['icrapro-v1'].docs[0].notes, 'only A changed');
    assert.equal(saved.data['icrapro-v1'].docs[0].fileData, state.data['icrapro-v1'].docs[0].fileData);
    assert.equal(saved.data['icrapro-v1'].docs[1].notes, 'second');
    assert.deepEqual(saved.payrollPeriods, state.payrollPeriods);
    assert(
      (await pool.query("SELECT count(*)::int AS n FROM han_private.han_audit WHERE category='changes'"))
        .rows[0].n > 0,
    );
    const page = await fetch(server.url + '/api/records/documents?limit=1', { headers });
    assert.equal(page.status, 200);
    const result = await page.json();
    assert.equal(result.items.length, 1);
    assert.equal(result.totals.count, '2');
    for (const [documentId, amount] of [
      ['a', 1200],
      ['b', 2800],
    ]) {
      // Two browsers both started with an empty finance list. Neither append
      // may erase the other's collection, and payroll uses all records.
      const payment = {
        id: 'pay-' + documentId,
        documentId,
        accountId: 'cash',
        type: 'payment',
        date: require('../lib/business-time.cjs').businessDate(),
        amount,
      };
      const added = await fetch(server.url + '/api/data/patch?key=hanhukuk-finance-v1', {
        method: 'PUT',
        headers,
        body: JSON.stringify(diff('hanhukuk-finance-v1', [], [payment])),
      });
      assert.equal(added.status, 200, await added.text());
    }
    const paid = await (await fetch(server.url + '/api/records/documents?limit=1', { headers })).json();
    assert.equal(paid.totals.receivedCents, '4000');
    assert.equal((await store.readState()).data['hanhukuk-finance-v1'].length, 2);
    const writeEvent = (event) =>
      fetch(server.url + '/api/data/patch?key=hanhukuk-finance-v1', {
        method: 'PUT',
        headers,
        body: JSON.stringify(diff('hanhukuk-finance-v1', [], [event])),
      });
    const cost = {
      id: 'cost',
      documentId: 'a',
      accountId: 'cash',
      type: 'costOnly',
      date: require('../lib/business-time.cjs').businessDate(),
      amount: 2000,
    };
    const allowedCost = await writeEvent(cost);
    assert.equal(allowedCost.status, 200);
    assert.equal((await allowedCost.json()).accountBalances.cash, '2000');
    const tooMuchCost = await writeEvent({ ...cost, id: 'overdraft', amount: 3000 });
    assert.equal(tooMuchCost.status, 409);
    const tooMuchPayment = await writeEvent({ ...cost, id: 'overpayment', type: 'payment', amount: 9500 });
    assert.equal(tooMuchPayment.status, 409);
    assert.equal((await store.readState()).data['hanhukuk-finance-v1'].length, 3);
    const stale = await fetch(server.url + '/api/data/patch?key=icrapro-v1', {
      method: 'PUT',
      headers,
      body: JSON.stringify(diff('icrapro-v1', before, after)),
    });
    assert.equal(stale.status, 409);
    const backup = await store.exportBackup();
    assert.equal(backup._hanBackup.version, 2);
    assert(backup._hanBackup.audit.length > 0);
    const { restoreAudit } = require('../lib/record-store/backup.cjs');
    const { inTransaction } = require('../lib/db-transaction.cjs');
    // This target is a distinct, temporary database; never truncate live audit.
    const target = await database();
    try {
      const { _hanBackup, ...business } = backup;
      await inTransaction(target.pool, async (db) => {
        await importState(db, business);
        await restoreAudit(db, _hanBackup);
      });
      assert.equal(
        (await target.pool.query('SELECT count(*)::int AS n FROM han_private.han_audit')).rows[0].n,
        _hanBackup.audit.length,
      );
      assert.deepEqual(
        (await target.pool.query('SELECT payload FROM han_private.han_state WHERE id=1')).rows[0].payload,
        business,
      );
    } finally {
      await target.pg.close();
    }
  } finally {
    await server?.close();
    await pg.close();
  }
});
