const test = require('node:test');
const assert = require('node:assert/strict');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { database, fixture, serve, password } = require('./support/postgres.cjs');

test('read-only accounts can log in and read but cannot mutate records or send messages, even as CEO', async (t) => {
  const { pool, pg } = await database();
  const initial = fixture();
  initial.users[0].readOnly = true;
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
