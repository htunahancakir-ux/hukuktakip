const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const { database, fixture, serve } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { accountBalances } = require('../lib/record-store/accounts.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');
test('Scoped cash commands validate permissions, atomically transfer, deduplicate and preserve unrelated records', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    state.data['icrapro-v1'] = {
      clients: [{ id: 'c', name: 'Client' }],
      docs: [{ id: 'd', client: 'c', amount: 100, status: 'Derdest', fileData: 'keep' }],
    };
    state.data['hanhukuk-accounting-v1'] = {
      accounts: [
        { id: 'cash', name: 'Cash' },
        { id: 'bank', name: 'Bank' },
      ],
      entries: [{ id: 'initial', accountId: 'cash', amount: 10000, type: 'in', date: '2026-01-01' }],
      excludedFinanceIds: ['excluded'],
    };
    state.data['hanhukuk-finance-v1'] = [
      {
        id: 'excluded',
        documentId: 'd',
        accountId: 'bank',
        amount: 90000,
        type: 'payment',
        date: '2026-01-01',
      },
    ];
    for (const [id, permissions] of [
      ['in', ['cashIn']],
      ['out', ['cashOut']],
      ['no', []],
    ])
      state.users.push({ ...state.users[0], id, username: id, role: 'staff', permissions });
    state.data['icrapro-personnel-v1'].push({
      id: 'accountant-person',
      name: 'Accountant',
      department: 'Muhasebe',
      active: true,
    });
    state.users.push({
      ...state.users[0],
      id: 'accountant',
      username: 'accountant',
      role: 'staff',
      staffId: 'accountant-person',
      permissions: [],
    });
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const headers = {};
    for (const u of state.users) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
        [crypto.createHash('sha256').update(token).digest('hex'), u.id, Date.now() + 600000],
      );
      headers[u.id] = {
        'X-Han-Request': '1',
        'Content-Type': 'application/json',
        cookie: 'han_session=' + token,
      };
    }
    const before = (await pool.query('SELECT id,body,revision FROM han_data.documents')).rows;
    server = await serve(createApplication({ store: createStore(pool, { records: true }) }));
    let seq = 0;
    async function post(value, user = 'test-ceo') {
      const r = await fetch(server.url + '/api/cash-entry', {
        method: 'POST',
        headers: headers[user],
        body: JSON.stringify({
          id: 'req-' + ++seq,
          accountId: 'cash',
          type: 'out',
          amount: 1000,
          note: 'Test',
          expenseCategory: 'Masraf',
          date: '2026-01-02',
          ...value,
        }),
      });
      return { status: r.status, body: await r.json() };
    }
    assert.equal((await post({}, 'no')).status, 403);
    assert.equal((await post({}, 'in')).status, 403);
    assert.equal((await post({ type: 'transfer', destination: 'bank' }, 'out')).status, 403);
    assert.equal(
      (await post({ type: 'transfer', destination: 'bank', amount: 1 }, 'accountant')).status,
      200,
    );
    assert.equal(
      (await post({ type: 'transfer', accountId: 'bank', destination: 'cash', amount: 1 }, 'accountant'))
        .status,
      200,
    );
    for (const v of [
      { date: '2026-02-30' },
      { date: '2999-01-01' },
      { amount: 0 },
      { amount: 10001 },
      { expenseCategory: 'bad' },
      { type: 'transfer', destination: 'cash' },
      { type: 'external', profitChoice: 'bad' },
    ])
      assert.equal((await post(v)).status, 400);
    const transferred = await post({ id: 'transfer', type: 'transfer', destination: 'bank', amount: 2500 });
    assert.equal(transferred.status, 200);
    assert.deepEqual(transferred.body.accountBalances, { bank: '2500', cash: '7500' });
    assert.equal(
      (await post({ id: 'transfer', type: 'transfer', destination: 'bank', amount: 2500 })).status,
      200,
    );
    assert.equal(
      (await post({ id: 'transfer', type: 'transfer', destination: 'bank', amount: 2000 })).status,
      409,
    );
    assert.equal((await post({ type: 'external', profitChoice: 'yes', amount: 1000 }, 'in')).status, 200);
    const outgoing = await post({ type: 'advance', advanceType: 'T.Ç', amount: 500 }, 'out');
    assert.equal(outgoing.status, 200);
    assert.equal(outgoing.body.accountBalances, undefined);
    assert.deepEqual(await accountBalances(pool), { bank: '2500', cash: '8000' });
    const race = await Promise.all([
      post({ amount: 6000, expenseCategory: 'Yediemin Gideri' }),
      post({ amount: 6000, expenseCategory: 'Yediemin Gideri' }),
    ]);
    assert.deepEqual(race.map((r) => r.status).sort(), [200, 400]);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM han_data.ledger_entries WHERE body->>'expenseCategory'='Yediemin Gideri'",
        )
      ).rows[0].n,
      1,
    );
    const ledger = state.data['hanhukuk-accounting-v1'],
      after = structuredClone(ledger);
    after.accounts[0].name = 'Renamed';
    const patch = diff('hanhukuk-accounting-v1', ledger, after);
    const edited = await fetch(server.url + '/api/data/patch?key=hanhukuk-accounting-v1', {
      method: 'PUT',
      headers: headers['test-ceo'],
      body: JSON.stringify(patch),
    });
    assert.equal(edited.status, 200, await edited.text());
    assert.equal(
      (await pool.query("SELECT body->>'name' AS name FROM han_data.accounts WHERE id='cash'")).rows[0].name,
      'Renamed',
    );
    assert.deepEqual((await pool.query('SELECT id,body,revision FROM han_data.documents')).rows, before);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM han_data.attachments')).rows[0].n, 1);
    assert.deepEqual(await accountBalances(pool), { bank: '2500', cash: '2000' });
  } finally {
    await server?.close();
    await pg.close();
  }
});
