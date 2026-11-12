const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { sixMonthsAfter, syncParkingWaiting } = require('../outputs/icrapro/parking-waiting.js');
const { database, fixture } = require('./support/postgres.cjs');
const { importState } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { refreshParkingWaiting } = require('../lib/record-store/parking-waiting.cjs');
const { documentPage, documentDetail } = require('../lib/record-store/queries.cjs');
test('Six calendar months clamp at month end; closed files remain closed; mixed files wait for their last parking claim', () => {
  assert.equal(sixMonthsAfter('2026-08-31'), '2027-02-28');
  assert.equal(sixMonthsAfter('2023-08-31'), '2024-02-29');
  assert.equal(sixMonthsAfter('2026-05-12'), '2026-11-12');
  assert.equal(sixMonthsAfter('2026-02-30'), '');
  const d = { docType: 'Yediemin Park Ücreti', parkingEntry: '2026-05-12', status: 'Derdest' };
  syncParkingWaiting(d, '2026-11-11');
  assert.equal(d.status, 'Bekleme');
  syncParkingWaiting(d, '2026-11-12');
  assert.equal(d.status, 'Derdest');
  assert.equal(syncParkingWaiting(d, '2026-11-12'), false);
  for (const status of ['İnfaz', 'İade']) {
    const closed = { ...d, status, parkingEntry: '2026-11-10' };
    assert.equal(syncParkingWaiting(closed, '2026-11-12'), false);
    assert.equal(closed.status, status);
  }
  const mixed = {
    docType: 'Diğer',
    status: 'Derdest',
    receivables: [
      { docType: 'Senet' },
      { docType: 'Yediemin Park Ücreti', parkingEntry: '2026-05-01' },
      { docType: 'Yediemin Park Ücreti', parkingEntry: '2026-05-13' },
    ],
  };
  syncParkingWaiting(mixed, '2026-11-12');
  assert.equal(mixed.status, 'Bekleme');
  assert.equal(mixed.parkingProcessOn, '2026-11-13');
  syncParkingWaiting(mixed, '2026-11-13');
  assert.equal(mixed.status, 'Derdest');
});
test('Real indexed record pages include unassigned waiting files and release them exactly on day six months, without money or duplicate writes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-12T08:00:00Z') });
  const { pg, pool } = await database();
  try {
    const s = fixture();
    s.data['icrapro-v1'].clients = [{ id: 'c', name: 'Müvekkil' }];
    s.data['icrapro-v1'].docs = Array.from({ length: 205 }, (_, i) => ({
      id: 'w' + i,
      number: String(i),
      client: 'c',
      docType: 'Yediemin Park Ücreti',
      amount: 100,
      parkingEntry: '2026-05-13',
      status: 'Derdest',
      notes: 'Preserve ' + i,
    }));
    s.data['icrapro-v1'].docs.push(
      {
        id: 'due',
        number: 'due',
        client: 'c',
        docType: 'Yediemin Park Ücreti',
        amount: 200,
        parkingEntry: '2026-05-12',
        status: 'Derdest',
      },
      {
        id: 'closed',
        number: 'closed',
        client: 'c',
        docType: 'Yediemin Park Ücreti',
        amount: 300,
        parkingEntry: '2026-11-01',
        status: 'İnfaz',
      },
      { id: 'plain', number: 'plain', client: 'c', docType: 'Senet', amount: 400, status: 'Derdest' },
    );
    await importState(pool, s);
    await importRecords(pool);
    await activateRecords(pool);
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,'test-ceo','desktop',$2)",
      [crypto.createHash('sha256').update(token).digest('hex'), Date.now() + 600000],
    );
    const req = { headers: { cookie: 'han_session=' + token } };
    let page = await documentPage(pool, req, { status: 'Bekleme', limit: 100 });
    assert.equal(page.totals.count, '205');
    assert.equal(page.items.length, 100);
    assert.equal(page.statusCounts.Bekleme, '205');
    const before = (await pool.query("SELECT revision,body FROM han_data.documents WHERE id='w0'")).rows[0];
    assert.equal(before.body.notes, 'Preserve 0');
    assert.equal(before.body.parkingProcessOn, '2026-11-13');
    await refreshParkingWaiting(pool, '2026-11-12');
    assert.equal(
      (await pool.query("SELECT revision FROM han_data.documents WHERE id='w0'")).rows[0].revision,
      before.revision,
    );
    await refreshParkingWaiting(pool, '2026-11-13');
    const released = await documentDetail(pool, req, 'w0');
    assert.equal(released.record.status, 'Derdest');
    assert.equal(released.record.amount, 100);
    assert.equal(released.record.notes, 'Preserve 0');
    assert.equal((await documentDetail(pool, req, 'closed')).record.status, 'İnfaz');
    assert.equal((await documentDetail(pool, req, 'plain')).record.status, 'Derdest');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM han_data.financial_events')).rows[0].n, 0);
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM han_data.documents WHERE status='Bekleme'")).rows[0]
        .n,
      0,
    );
  } finally {
    await pg.close();
  }
});
test('Waiting files produce no no-call warning; on release the contact clock starts at eligibility', () => {
  const { runWorkflowAutomation } = require('../outputs/icrapro/workflow-automation.cjs');
  const s = fixture();
  s.data['icrapro-personnel-v1'] = [{ id: 'p', name: 'P', active: true }];
  s.users.push({ ...s.users[0], id: 'p-user', staffId: 'p', role: 'staff', permissions: ['documents'] });
  s.data['icrapro-v1'].docs = [
    {
      id: 'd',
      docType: 'Yediemin Park Ücreti',
      parkingEntry: '2026-05-12',
      relatedStaff: 'p',
      created: '2026-05-12',
    },
  ];
  runWorkflowAutomation(s, '2026-11-11');
  assert.equal(s.data['icrapro-v1'].docs[0].status, 'Bekleme');
  assert.equal(s.workflowNotices.length, 0);
  runWorkflowAutomation(s, '2026-11-12');
  assert.equal(s.data['icrapro-v1'].docs[0].status, 'Derdest');
  assert.equal(s.workflowNotices.length, 0);
});
