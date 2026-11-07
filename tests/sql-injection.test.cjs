const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, fixture, password, serve } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { createApplication } = require('../lib/application.cjs');
const { event } = require('../lib/audit.cjs');
const { insertNormalizedRow } = require('../lib/records/insert.cjs');

test('Import rejects unapproved SQL identifiers before executing any query', async () => {
  let calls = 0;
  const db = {
    async query() {
      calls++;
    },
  };
  for (const table of ['parties; DROP TABLE han_core.clients; --', 'han_state', '__proto__', 'toString'])
    await assert.rejects(insertNormalizedRow(db, table, { id: 'x' }), /Invalid import/);
  for (const row of [
    { id: 'x', 'name) VALUES ($1); DELETE FROM han_core.clients; --': 'x' },
    { id: 'x', source_payload: '{}' },
    JSON.parse('{"id":"x","__proto__":"x"}'),
    {},
    [],
    null,
  ])
    await assert.rejects(insertNormalizedRow(db, 'parties', row), /Invalid import/);
  assert.equal(calls, 0);
});

test('HTTP login, cookies, data keys, JSON writes and audit filters keep SQL input as data', async () => {
  const { pg, pool } = await database();
  const initial = fixture();
  await importState(pool, initial);
  const store = createStore(pool);
  const app = await serve(createApplication({ store }));
  const headers = { 'Content-Type': 'application/json', 'X-Han-Request': '1' };
  const payload = "'); DELETE FROM han_private.han_state; --";
  try {
    for (const username of ["' OR '1'='1' --", "test' OR 1=1 --", payload]) {
      const result = await fetch(app.url + '/api/login', {
        method: 'POST',
        headers,
        body: JSON.stringify({ username, password }),
      });
      assert.equal(result.status, 401);
      assert.equal(result.headers.get('set-cookie'), null);
      await result.arrayBuffer();
    }
    const forged = await fetch(app.url + '/api/session', {
      headers: { cookie: "han_session=' OR 1=1 --" },
    });
    assert.equal((await forged.json()).user, null);
    assert.deepEqual(await store.readState(), initial);

    const login = await fetch(app.url + '/api/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'test', password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    await login.arrayBuffer();
    const invalidKey = await fetch(app.url + '/api/data?' + new URLSearchParams({ key: payload }), {
      headers: { cookie },
    });
    assert.equal(invalidKey.status, 404);
    await invalidKey.arrayBuffer();

    const path = '/api/data?key=icrapro-settings-v1';
    const current = await fetch(app.url + path, { headers: { cookie } });
    const etag = current.headers.get('etag');
    await current.arrayBuffer();
    const value = { firm: { name: payload }, [payload]: "O'Connor \\ ; --" };
    const saved = await fetch(app.url + path, {
      method: 'PUT',
      headers: { ...headers, cookie, 'If-Match': etag },
      body: JSON.stringify({ value }),
    });
    assert.equal(saved.status, 200);
    await saved.arrayBuffer();
    const read = await fetch(app.url + path, { headers: { cookie } });
    assert.deepEqual(await read.json(), value);

    await store.appendAudit([
      event({ id: 'literal', name: payload, username: 'literal' }, 'changes', 'update', 'SQLi test', 'one'),
      event({ id: 'other', name: 'Other', username: 'other' }, 'changes', 'update', 'SQLi test', 'two'),
    ]);
    const filtered = await fetch(app.url + '/api/audit?' + new URLSearchParams({ actor: payload }), {
      headers: { cookie },
    });
    assert.equal(filtered.status, 200);
    const items = (await filtered.json()).items;
    assert.equal(items.length, 1, 'A boolean-injection payload must not return other audit rows');
    assert.equal(items[0].actor_name, payload);
    for (const field of ['category', 'action', 'cursor', 'from', 'to']) {
      const invalid = await fetch(app.url + '/api/audit?' + new URLSearchParams({ [field]: payload }), {
        headers: { cookie },
      });
      assert.equal(invalid.status, 400, field);
      await invalid.arrayBuffer();
    }
    const final = await store.readState();
    assert.deepEqual(final.users, initial.users);
    assert.deepEqual(final.data['icrapro-v1'], initial.data['icrapro-v1']);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM han_private.han_state')).rows[0].n, 1);
  } finally {
    await app.close();
    await pg.close();
  }
});
