const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createApplication } = require('../lib/application.cjs');
const rules = require('../outputs/icrapro/receivable-rules.js');
const parking = require('../outputs/icrapro/parking-fees.js');
const { diff } = require('../outputs/icrapro/record-patch.js');
test('Each selected document kind survives intake; numeric folios share one sequence and a parking folio retains receipt-based settlement', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 12, 10) });
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    state.data['icrapro-v1'].clients = [{ id: 'client', name: 'Client' }];
    state.data['icrapro-personnel-v1'] = [{ id: 'staff', name: 'Staff', active: true }];
    state.data['hanhukuk-accounting-v1'].accounts = [{ id: 'cash', name: 'Kasa' }];
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store, background: () => {} }));
    const login = await fetch(server.url + '/api/login', {
      method: 'POST',
      headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test', password }),
    });
    const headers = {
      cookie: login.headers.get('set-cookie').split(';')[0],
      'X-Han-Request': '1',
      'Content-Type': 'application/json',
    };
    const senet = { id: 's', docType: 'Senet', amount: 1000, due: '2026-11-10' };
    const invoice = { id: 'f', docType: 'Fatura', amount: 500, due: '2026-11-10' };
    const park = {
      id: 'y',
      docType: 'Yediemin Park Ücreti',
      amount: 1,
      parkingEntry: '2026-11-10',
      vehicleKind: 'Otomobil',
      vehiclePlate: '34 TEST 001',
      parkingCommissionRate: 40,
    };
    const stored = [];
    for (const [i, items] of [[park], [senet], [invoice], [senet, invoice]].entries()) {
      const record = {
        id: 'folio-' + i,
        client: 'client',
        debtor: 'Borrower ' + i,
        docType: 'Diğer',
        receivables: rules.normalize(items),
      };
      rules.sync(record, '2026-11-12', parking.parkingFeeInfo);
      delete record.mixedParkingCommissionCents;
      const response = await fetch(server.url + '/api/data/patch?key=icrapro-v1&operation=intake', {
        method: 'PUT',
        headers,
        body: JSON.stringify(diff('icrapro-v1', { clients: [], docs: [] }, { clients: [], docs: [record] })),
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      const saved = body.records[0].value;
      stored.push(saved);
      assert.equal(saved.number, String(i + 1));
      assert.equal(saved.docType, items.length === 1 ? items[0].docType : 'Diğer');
      const actual = (
        await (await fetch(server.url + '/api/records/documents?query=' + saved.number, { headers })).json()
      ).items.find((d) => d.id === saved.id);
      assert.equal(actual.kind, items.length === 1 ? items[0].docType : 'Alacak Föyü');
    }
    assert.equal(stored[0].parkingCommissionRate, 40);
    assert.equal(stored[0].vehicleKind, 'Otomobil');
    assert.equal(stored[0].parkingEntry, '2026-11-10');
    assert.equal(Number(stored[0].financeInterest || 0), 0);
    assert.equal(Number(stored[0].financeFee || 0), 0);
    const event = {
      id: 'collection',
      documentId: stored[0].id,
      type: 'payment',
      date: '2026-11-12',
      amount: 1000000,
      accountId: 'cash',
      turnoverStaffId: 'staff',
      note: 'Payment exceeds parking balance',
    };
    const pay = await fetch(server.url + '/api/data/patch?key=hanhukuk-finance-v1', {
      method: 'PUT',
      headers,
      body: JSON.stringify(diff('hanhukuk-finance-v1', [], [event])),
    });
    assert.equal(pay.status, 200, await pay.text());
    const saved = await store.readState(),
      doc = saved.data['icrapro-v1'].docs.find((d) => d.id === stored[0].id),
      events = saved.data['hanhukuk-finance-v1'];
    assert.equal(doc.status, 'İnfaz');
    assert.equal(
      require('../outputs/icrapro/profit-rules.js').recognizedCollectionRevenue(events[0], events, doc),
      400000,
    );
    const { JSDOM } = require('jsdom'),
      fs = require('node:fs');
    const dom = new JSDOM('', { runScripts: 'dangerously' });
    try {
      const w = dom.window;
      w.eval(fs.readFileSync('outputs/icrapro/document-types.js', 'utf8'));
      assert.equal(w.docType(stored[0]), 'Yediemin Park Ücreti');
      assert.equal(w.docType(stored[3]), 'Alacak Föyü');
      assert.equal(w.nextDocumentNumber('Çek', stored), '5');
    } finally {
      dom.window.close();
    }
  } finally {
    await server?.close();
    await pg.close();
    t.mock.timers.reset();
  }
});
test('Renumbering is atomic and repeatable, preserves archive/history and money, and allocates safely after concurrent calls or a manual numeric import', async () => {
  const { pg, pool } = await database();
  try {
    const s = fixture();
    s.data['icrapro-v1'].clients = [{ id: 'client', name: 'Client' }];
    s.data['icrapro-v1'].docs = [
      { id: 'a', client: 'client', number: 'D-0093', docType: 'Diğer', amount: 100 },
      { id: 'b', client: 'client', number: '1702569', docType: 'Senet', amount: 200 },
    ];
    s.deletedDocuments = [
      {
        id: 'archive',
        document: { id: 'deleted', client: 'client', number: 'Y-0004', docType: 'Diğer', amount: 300 },
      },
    ];
    s.data['hanhukuk-accounting-v1'].accounts = [{ id: 'cash', name: 'Cash' }];
    s.data['hanhukuk-finance-v1'] = [
      {
        id: 'payment',
        type: 'payment',
        documentId: 'a',
        amount: 1000,
        accountId: 'cash',
        date: '2026-11-01',
      },
    ];
    await importState(pool, s);
    await importRecords(pool);
    await activateRecords(pool);
    const { renumberFolios, nextFolioNumber } = require('../lib/record-store/folio-numbers.cjs');
    const before = (await pool.query('SELECT id,body FROM han_data.financial_events')).rows;
    const preview = await renumberFolios(pool, { dryRun: true });
    assert.equal(preview.count, 3);
    assert.equal(
      (await pool.query("SELECT number FROM han_data.documents WHERE id='a'")).rows[0].number,
      'D-0093',
    );
    await renumberFolios(pool);
    const docs = (await pool.query('SELECT body FROM han_data.documents ORDER BY ordinal,id')).rows.map(
      (r) => r.body,
    );
    assert.deepEqual(
      docs.map((d) => d.number),
      ['1', '2', '3'],
    );
    assert(docs[0].previousFolioNumbers.includes('D-0093'));
    assert(docs[1].previousFolioNumbers.includes('1702569'));
    assert.equal(docs[0].amount, 100);
    assert.equal(
      (await pool.query('SELECT body FROM han_data.document_archives')).rows[0].body.document.number,
      '3',
    );
    assert.deepEqual((await pool.query('SELECT id,body FROM han_data.financial_events')).rows, before);
    assert.deepEqual(await Promise.all([nextFolioNumber(pool), nextFolioNumber(pool)]), ['4', '5']);
    assert.equal((await renumberFolios(pool)).alreadyApplied, true);
    await pool.query(
      "INSERT INTO han_data.documents(id,body,ordinal,active) VALUES('manual',$1::jsonb,99,true)",
      [JSON.stringify({ id: 'manual', client: 'client', number: '1000', amount: 1 })],
    );
    assert.equal(await nextFolioNumber(pool), '1001');
  } finally {
    await pg.close();
  }
});
