const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');

test('Unchanged automatic charges preserve their timestamp; changed inputs are still recalculated', () => {
  const { applyAutomaticLegalCharges } = require('../outputs/icrapro/legal-charges.cjs');
  const doc = { id: 'automatic', docType: 'Senet', amount: 1000, due: '2026-11-01', status: 'Derdest' };
  assert.equal(applyAutomaticLegalCharges(doc, [], '2026-11-10'), true);
  doc.legalCalculation.calculatedAt = '2026-11-10T00:00:00.000Z';
  const before = structuredClone(doc);
  assert.equal(applyAutomaticLegalCharges(doc, [], '2026-11-10'), false);
  assert.deepEqual(doc, before);
  doc.amount = 2000;
  assert.equal(applyAutomaticLegalCharges(doc, [], '2026-11-10'), true);
  assert.equal(doc.legalCalculation.principal, 200000);
  doc.due = '2026-11-02';
  assert.equal(applyAutomaticLegalCharges(doc, [], '2026-11-10'), true);
  assert.equal(doc.legalCalculation.start, '2026-11-02');
  assert.equal(applyAutomaticLegalCharges(doc, [], '2026-11-11'), true);
  assert.equal(doc.legalCalculation.end, '2026-11-11');
});
test('CEO/admin manual interest survives scoped saves, reloads and balance reports; staff/closed files stay locked', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    state.users.push(
      { ...state.users[0], id: 'admin', username: 'admin', role: 'admin' },
      { ...state.users[0], id: 'staff', username: 'staff', role: 'staff' },
    );
    state.data['icrapro-v1'] = {
      clients: [{ id: 'client', name: 'Faiz Testi' }],
      docs: ['unpaid', 'paid', 'closed'].map((id) => ({
        id,
        number: id,
        client: 'client',
        debtor: id,
        docType: 'Senet',
        amount: 1000,
        due: '2026-11-01',
        status: id === 'closed' ? 'İnfaz' : 'Derdest',
        financeInterest: 50,
        financeFee: 100,
      })),
    };
    state.data['hanhukuk-accounting-v1'].accounts = [{ id: 'cash', name: 'Kasa' }];
    state.data['hanhukuk-finance-v1'] = ['paid', 'closed'].map((id) => ({
      id: 'payment-' + id,
      documentId: id,
      type: 'payment',
      accountId: 'cash',
      amount: id === 'closed' ? 115000 : 10000,
      date: '2026-11-02',
    }));
    require('../outputs/icrapro/legal-charges.cjs').applyAutomaticLegalCharges(
      state.data['icrapro-v1'].docs[0],
      [],
      require('../lib/business-time.cjs').businessDate(),
    );
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store }));
    for (const username of ['test', 'admin', 'staff']) {
      const login = await fetch(server.url + '/api/login', {
        method: 'POST',
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(login.status, 200);
      const headers = {
        'X-Han-Request': '1',
        'Content-Type': 'application/json',
        cookie: login.headers.get('set-cookie').split(';')[0],
      };
      const load = async (id) =>
        (await fetch(server.url + '/api/records/document?id=' + id + '&section=context', { headers })).json();
      const patch = (before, after) =>
        fetch(server.url + '/api/data/patch?key=icrapro-v1', {
          method: 'PUT',
          headers,
          body: JSON.stringify(
            diff('icrapro-v1', { docs: [before], clients: [] }, { docs: [after], clients: [] }),
          ),
        });
      for (const id of ['unpaid', 'paid']) {
        const before = (await load(id)).record;
        const interest = username === 'admin' ? 450.75 : 325.25;
        const after = { ...before, financeInterest: interest, financeFee: 125.5, financeTermsManual: true };
        if (username === 'test' && id === 'unpaid') {
          // A background save must not alter the unchanged automatic calculation
          // and make the finance form's existing snapshot stale.
          const background = await patch(before, { ...before, notes: 'Başka oturumun notu' });
          assert.equal(background.status, 200, await background.text());
          delete after.legalCalculation;
          delete after.legalCalculationError;
        }
        const response = await patch(before, after);
        if (username === 'staff') {
          assert.equal(response.status, 403);
          const flagResponse = await patch(before, { ...before, financeTermsManual: false });
          assert.equal(flagResponse.status, 403);
          continue;
        }
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.records[0].value.financeInterest, interest);
        assert.equal(body.records[0].value.financeFee, 125.5);
        const reloaded = (await load(id)).record;
        assert.equal(reloaded.financeInterest, interest);
        assert.equal(reloaded.financeTermsManual, true);
        const noteResponse = await patch(reloaded, { ...reloaded, notes: 'Sonraki işlem' });
        assert.equal(noteResponse.status, 200, await noteResponse.text());
        const page = await (await fetch(server.url + '/api/records/documents?q=' + id, { headers })).json();
        const row = page.items.find((item) => item.id === id);
        assert.equal(row.targetCents, String(100000 + Math.round(interest * 100) + 12550));
        assert.equal(row.remainingCents, String(Number(row.targetCents) - (id === 'paid' ? 10000 : 0)));
        assert.equal(
          (await store.readState()).data['icrapro-v1'].docs.find((doc) => doc.id === id).financeInterest,
          interest,
        );
        if (username === 'test' && id === 'unpaid') {
          const current = (await load(id)).record;
          const concurrent = await patch(current, { ...current, financeInterest: interest + 10 });
          assert.equal(concurrent.status, 200, await concurrent.text());
          const stale = await patch(current, { ...current, financeInterest: interest + 20 });
          assert.equal(stale.status, 409, 'Actual concurrent edits of interest must remain protected');
          assert.equal((await load(id)).record.financeInterest, interest + 10);
        }
      }
      const closed = (await load('closed')).record;
      const denied = await patch(closed, { ...closed, financeInterest: 400, financeTermsManual: true });
      assert.equal(denied.status, 403);
    }
  } finally {
    await server?.close();
    await pg.close();
  }
});

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
    const application = createApplication({ store });
    server = await serve((req, res) => {
      const original = new URL(req.url, 'http://localhost');
      req.query = { ...Object.fromEntries(original.searchParams), route: original.pathname.slice(5) };
      req.url = '/api/index';
      req.url = require('../lib/api-request-url.cjs').apiRequestUrl(req);
      return application(req, res);
    });
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
