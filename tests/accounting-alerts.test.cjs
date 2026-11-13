const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { database, fixture, serve } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createApplication } = require('../lib/application.cjs');
const { accountingAlerts, DEFAULT_POOL_THRESHOLD } = require('../lib/accounting-alerts.cjs');

function alertState() {
  const state = fixture();
  state.data['icrapro-personnel-v1'].push(
    { id: 'accountant-person', name: 'Accountant', department: 'Muhasebe', active: true },
    { id: 'collector', name: 'Collector', department: 'Tahsilat', active: true },
  );
  state.data['hanhukuk-accounting-v1'] = {
    accounts: [{ id: 'cash', name: 'Kasa', type: 'cash' }],
    entries: [
      { id: 'open', type: 'in', amount: 900000, accountId: 'cash', date: '2020-01-01', note: 'Açılış' },
      {
        id: 'fund',
        type: 'out',
        amount: 300000,
        accountId: 'cash',
        date: '2020-01-02',
        note: 'Avans',
        expenseCategory: 'Masraf',
        expensePoolFunding: true,
      },
    ],
  };
  state.data['icrapro-v1'].docs = [
    {
      id: 'plan',
      number: 'D-001',
      debtor: 'Planlı Borçlu',
      amount: 1000,
      status: 'Derdest',
      relatedStaff: 'collector',
      fileData: 'DO-NOT-SEND',
      repaymentPlan: {
        receivedAtCreation: 0,
        installments: [
          { due: '2020-02-01', amount: 10000 },
          { due: '2020-03-01', amount: 10000 },
          { due: '2999-01-01', amount: 10000 },
        ],
      },
    },
    {
      id: 'promise',
      number: 'D-002',
      debtor: 'Söz Veren',
      amount: 1000,
      status: 'Derdest',
      paymentPromise: { date: '2020-05-01', amount: 5000, receivedAtCreation: 0 },
    },
    {
      id: 'future',
      number: 'D-003',
      debtor: 'İleri Tarihli',
      amount: 1000,
      status: 'Derdest',
      paymentPromise: { date: '2999-05-01', amount: 5000, receivedAtCreation: 0 },
    },
    {
      id: 'closed',
      number: 'D-004',
      debtor: 'Kapanmış',
      amount: 1000,
      status: 'İnfaz',
      paymentPromise: { date: '2020-05-01', amount: 5000, receivedAtCreation: 0 },
    },
    { id: 'plain', number: 'D-005', debtor: 'Sade', amount: 1000, status: 'Derdest' },
  ];
  state.data['hanhukuk-finance-v1'] = [
    // Settles the first installment and 2.500 of the second.
    { id: 'pay', type: 'payment', amount: 12500, documentId: 'plan', accountId: 'cash' },
    { id: 'other', type: 'payment', amount: 700, documentId: 'plain', accountId: 'cash' },
    { id: 'use', type: 'costOnly', amount: 280000, documentId: 'plain', expensePoolAllocation: true },
  ].map((event) => ({ date: '2020-01-03', note: 'not', ...event }));
  return state;
}

test('Accounting alerts count only overdue open-file payments and report the pool against its threshold', () => {
  const state = alertState(),
    result = accountingAlerts(state, '2026-11-13');
  assert.deepEqual(result.pool, {
    funded: 300000,
    allocated: 280000,
    balance: 20000,
    threshold: DEFAULT_POOL_THRESHOLD,
  });
  assert.equal(result.overdue.count, 2);
  assert.equal(result.overdue.installments, 1);
  assert.equal(result.overdue.promises, 1);
  assert.equal(result.overdue.remaining, 7500 + 5000);
  assert.deepEqual(
    result.overdue.rows.map((row) => [row.documentId, row.kind, row.due, row.remaining, row.staffName]),
    [
      ['plan', 'installment', '2020-03-01', 7500, 'Collector'],
      ['promise', 'promise', '2020-05-01', 5000, 'Atanmadı'],
    ],
  );
  // A payment due today is not overdue yet.
  assert.equal(accountingAlerts(state, '2020-03-01').overdue.count, 0);
  state.data['icrapro-settings-v1'] = { preferences: { expensePoolWarningCents: 1500 } };
  assert.equal(accountingAlerts(state, '2026-11-13').pool.threshold, 1500);
});

test('Accounting alerts are served from a narrow read to accounting users only', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = alertState();
    state.users.push(
      { ...state.users[0], id: 'staff', username: 'staff', role: 'staff', permissions: [] },
      {
        ...state.users[0],
        id: 'accountant',
        username: 'accountant',
        role: 'staff',
        staffId: 'accountant-person',
        permissions: [],
      },
    );
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const session = async (id) => {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
        [crypto.createHash('sha256').update(token).digest('hex'), id, Date.now() + 600000],
      );
      return { cookie: 'han_session=' + token, 'X-Han-Request': '1' };
    };
    server = await serve(createApplication({ store: createStore(pool, { records: true }) }));
    const read = async (id) => {
      const response = await fetch(server.url + '/api/accounting/alerts', { headers: await session(id) });
      return { status: response.status, text: await response.text() };
    };
    for (const id of ['test-ceo', 'accountant']) {
      const { status, text } = await read(id),
        data = JSON.parse(text);
      assert.equal(status, 200);
      assert.equal(data.pool.balance, 20000);
      assert.equal(data.overdue.count, 2);
      assert.equal(data.overdue.remaining, 12500);
      assert.ok(!text.includes('DO-NOT-SEND'));
    }
    assert.equal((await read('staff')).status, 403);
  } finally {
    await server?.close();
    await pg.close();
  }
});
