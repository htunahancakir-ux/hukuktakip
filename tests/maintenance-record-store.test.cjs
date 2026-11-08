const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { database, fixture } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createAccess } = require('../outputs/icrapro/access-server.cjs');
test('Maintenance scans bounded files, uses global collection ranking and keeps attachments and completed files', async () => {
  const { pg, pool } = await database();
  try {
    const state = fixture();
    state.data['icrapro-personnel-v1'] = [
      { id: 'p1', name: 'One', active: true },
      { id: 'p2', name: 'Two', active: true },
    ];
    for (const id of ['p1', 'p2'])
      state.users.push({
        ...state.users[0],
        id,
        username: id,
        staffId: id,
        role: 'staff',
        permissions: ['documents'],
      });
    state.data['icrapro-v1'] = {
      clients: [{ id: 'c', name: 'Client' }],
      docs: Array.from({ length: 205 }, (_, i) => ({
        id: 'd' + String(i).padStart(3, '0'),
        number: 'N' + i,
        client: 'c',
        debtor: 'Test',
        amount: 100,
        status: 'Derdest',
        created: '2026-01-01',
        relatedStaff: 'p1',
        fileData: 'preserved-' + i,
      })),
    };
    state.data['icrapro-v1'].docs.push({
      id: 'closed',
      client: 'c',
      amount: 500,
      status: 'İnfaz',
      relatedStaff: 'p2',
    });
    state.data['hanhukuk-finance-v1'] = [
      {
        id: 'all-time',
        documentId: 'closed',
        type: 'payment',
        amount: 50000,
        date: '2026-01-01',
        collectionStaffId: 'p2',
        closes: true,
      },
    ];
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    const run = (tx) =>
      createAccess(null, {
        initialState: tx.state,
        saveState: tx.saveState,
        timers: false,
        skipPayroll: tx.skipPayroll,
        workflowRanking: tx.workflowRanking,
      }).runMaintenance();
    await store.maintenance(run);
    let rows = (
      await pool.query(
        "SELECT id,body FROM han_data.documents WHERE id<>'closed' AND body->>'relatedStaff'='p2'",
      )
    ).rows;
    assert.equal(rows.length, 200);
    assert.equal(
      (await pool.query("SELECT body->>'relatedStaff' AS staff FROM han_data.documents WHERE id='d204'"))
        .rows[0].staff,
      'p1',
    );
    await pool.query('UPDATE han_private.han_jobs SET next_at=clock_timestamp()');
    await store.maintenance(run);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM han_data.documents WHERE id<>'closed' AND body->>'relatedStaff'='p2'",
        )
      ).rows[0].n,
      205,
    );
    const notices = (await pool.query('SELECT count(*)::int AS n FROM han_data.workflow_notices')).rows[0].n;
    await pool.query('UPDATE han_private.han_jobs SET next_at=clock_timestamp()');
    await store.maintenance(run);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM han_data.workflow_notices')).rows[0].n,
      notices,
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM han_data.attachments WHERE active')).rows[0].n,
      205,
    );
    assert.equal(
      (await pool.query("SELECT revision::text AS revision FROM han_data.documents WHERE id='closed'"))
        .rows[0].revision,
      '1',
    );
  } finally {
    await pg.close();
  }
});
