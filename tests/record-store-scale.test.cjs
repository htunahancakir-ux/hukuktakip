const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { database, fixture } = require('./support/postgres.cjs');
const { importState } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { documentPage } = require('../lib/record-store/queries.cjs');
test('10000 files over the legacy response limit return bounded pages with complete totals', async () => {
  const { pg, pool } = await database();
  try {
    const state = fixture();
    state.data['icrapro-v1'].clients = Array.from({ length: 10000 }, (_, n) => ({
      id: 'c' + n,
      name: 'Sentetik Müvekkil ' + n,
      notes: 'Yalnız test verisi. '.repeat(35),
    }));
    state.data['icrapro-v1'].docs = Array.from({ length: 10000 }, (_, n) => ({
      id: 'd' + String(n).padStart(5, '0'),
      number: 'SCALE-' + n,
      client: 'c' + n,
      debtor: 'Sentetik ' + n,
      amount: 100,
      status: 'Derdest',
      notes: 'Yalnız test verisi. '.repeat(35),
    }));
    assert(Buffer.byteLength(JSON.stringify(state)) > 4 * 1024 * 1024);
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,'test-ceo','desktop',$2)",
      [crypto.createHash('sha256').update(token).digest('hex'), Date.now() + 600000],
    );
    const req = { headers: { cookie: 'han_session=' + token } },
      started = performance.now();
    const first = await documentPage(pool, req, { status: 'Derdest', limit: 50 }),
      firstMs = performance.now() - started;
    const lastStart = performance.now(),
      last = await documentPage(pool, req, { status: 'Derdest', after: 'd09949', limit: 50 });
    assert.equal(first.items.length, 50);
    assert.equal(last.items.length, 50);
    assert.equal(last.next, null);
    assert.equal(first.totals.count, '10000');
    assert.equal(first.totals.remainingCents, '100000000');
    assert.deepEqual(last.totals, first.totals);
    assert(Buffer.byteLength(JSON.stringify(first)) < 35000);
    const startup = await require('../lib/record-store/bootstrap.cjs').bootstrap(pool, req);
    assert.equal(startup.summary.documents, '10000');
    assert.equal(startup.data['icrapro-v1'].docs.length, 0);
    assert(Buffer.byteLength(JSON.stringify(startup)) < 10000);
    const { clientPage } = require('../lib/record-store/clients.cjs');
    const clientStart = performance.now();
    const clients = await clientPage(pool, req, { limit: 50 });
    const nextClients = await clientPage(pool, req, { limit: 50, after: clients.next });
    const foundClient = await clientPage(pool, req, { q: 'Sentetik Müvekkil 9999' });
    assert.equal(clients.items.length, 50);
    assert.equal(clients.count, '10000');
    assert.equal(foundClient.count, '1');
    assert.equal(foundClient.items[0].documentCount, '1');
    assert.equal(clients.summary.amountCents, '100000000');
    assert.deepEqual(nextClients.summary, clients.summary);
    assert.deepEqual(foundClient.summary, clients.summary);
    assert(Buffer.byteLength(JSON.stringify(clients)) < 15000);
    console.log(
      JSON.stringify({
        fixtureDocuments: 10000,
        fixtureClients: 10000,
        clientThreeQueriesMs: Math.round(performance.now() - clientStart),
        clientPageBytes: Buffer.byteLength(JSON.stringify(clients)),
        firstPageMs: Math.round(firstMs),
        warmLastPageMs: Math.round(performance.now() - lastStart),
        responseBytes: Buffer.byteLength(JSON.stringify(first)),
        allRecordsIncludedInTotals: true,
      }),
    );
  } finally {
    await pg.close();
  }
});
