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
    state.data['icrapro-v1'].clients = [{ id: 'c', name: 'Sentetik Hacim Testi' }];
    state.data['icrapro-v1'].docs = Array.from({ length: 10000 }, (_, n) => ({
      id: 'd' + String(n).padStart(5, '0'),
      number: 'SCALE-' + n,
      client: 'c',
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
    console.log(
      JSON.stringify({
        fixtureDocuments: 10000,
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
