const test = require('node:test');
const assert = require('node:assert/strict');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { database, fixture, serve, password } = require('./support/postgres.cjs');

test('CEO retains writes and deletion capability despite read-only or break flags', async (t) => {
  const { pool, pg } = await database();
  const initial = fixture();
  Object.assign(initial.users[0], { readOnly: true, activeBreak: { startedAt: Date.now() } });
  initial.data['icrapro-v1'].clients = [{ id: 'c', name: 'Client' }];
  initial.data['icrapro-v1'].docs = [
    {
      id: 'closed',
      number: 'S-0001',
      client: 'c',
      debtor: 'Synthetic',
      docType: 'Senet',
      status: 'İnfaz',
      amount: 100,
      financeFee: 0,
      financeTermsManual: true,
    },
  ];
  initial.data['hanhukuk-finance-v1'] = [
    { id: 'payment', documentId: 'closed', type: 'payment', amount: 10000 },
  ];
  await importState(pool, initial);
  await importRecords(pool);
  await activateRecords(pool);
  const app = await serve(createApplication({ store: createStore(pool, { records: true }) }));
  t.after(async () => {
    await app.close();
    await pg.close();
  });
  const login = await fetch(app.url + '/api/login', {
    method: 'POST',
    headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test', password }),
  });
  assert.equal(login.status, 200);
  const user = await login.json();
  assert.equal(user.readOnly, false);
  assert.equal(user.canDelete, true);
  assert.equal(user.activeBreak, null);
  const headers = {
    cookie: login.headers.get('set-cookie').split(';')[0],
    'X-Han-Request': '1',
    'Content-Type': 'application/json',
  };
  const response = await fetch(app.url + '/api/data/patch?key=hanhukuk-accounting-v1', {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      changes: [
        {
          path: ['accounts'],
          id: 'ceo-cash',
          before: null,
          value: { id: 'ceo-cash', name: 'CEO cash', type: 'cash' },
        },
      ],
    }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal((await fetch(app.url + '/api/operations/delete?type=accounts', { headers })).status, 200);
  assert.equal((await fetch(app.url + '/api/records/accounting', { headers })).status, 200);
  const terms = await fetch(app.url + '/api/data/patch?key=icrapro-v1', {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      changes: [
        { path: ['docs'], id: 'closed', field: 'financeFee', before: { value: 0 }, after: { value: 5 } },
      ],
    }),
  });
  assert.equal(terms.status, 200, await terms.text());
  assert.equal(
    (await pool.query("SELECT body->>'financeFee' AS fee FROM han_data.documents WHERE id='closed'")).rows[0]
      .fee,
    '5',
  );
});

test('read-only non-CEO accounts can read but cannot mutate records or send messages', async (t) => {
  const { pool, pg } = await database();
  const initial = fixture();
  initial.users[0].readOnly = true;
  initial.users[0].role = 'admin';
  initial.users.push({
    ...initial.users[0],
    id: 'active-ceo',
    username: 'active-ceo',
    role: 'ceo',
    readOnly: false,
  });
  await importState(pool, initial);
  await importRecords(pool);
  await activateRecords(pool);
  const app = await serve(createApplication({ store: createStore(pool, { records: true }) }));
  t.after(async () => {
    await app.close();
    await pg.close();
  });
  const login = await fetch(app.url + '/api/login', {
    method: 'POST',
    headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test', password }),
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).readOnly, true);
  const headers = {
    cookie: login.headers.get('set-cookie').split(';')[0],
    'X-Han-Request': '1',
    'Content-Type': 'application/json',
  };
  const before = (await pool.query('SELECT body FROM han_data.metadata WHERE id=1')).rows[0].body;
  assert.equal((await fetch(app.url + '/api/records/bootstrap', { headers })).status, 200);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const route of [
      '/api/data?key=icrapro-v1',
      '/api/data/patch?key=icrapro-v1',
      '/api/users',
      '/api/messages',
      '/api/work-orders',
      '/api/documents/conversations',
      '/api/cash-entry',
      '/api/whatsapp/send',
      '/api/backups/run',
      '/api/backups/restore',
      '/api/account/password',
    ]) {
      const response = await fetch(app.url + route, { method, headers, body: '{}' });
      assert.equal(response.status, 403, method + ' ' + route);
      assert.match((await response.json()).error, /salt okunur/);
    }
  }
  assert.deepEqual((await pool.query('SELECT body FROM han_data.metadata WHERE id=1')).rows[0].body, before);
  assert.equal((await fetch(app.url + '/api/presence', { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal((await fetch(app.url + '/api/logout', { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal((await fetch(app.url + '/api/session', { headers })).status, 200);
  assert.equal((await (await fetch(app.url + '/api/session', { headers })).json()).user, null);
});
