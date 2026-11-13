const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { database, fixture, serve } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createApplication } = require('../lib/application.cjs');

test('Opening all masked values and exporting personal data are written to the audit log', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    state.users.push({
      ...state.users[0],
      id: 'viewer',
      username: 'viewer',
      name: 'Salt Okunur',
      role: 'admin',
      readOnly: true,
    });
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const headers = async (id) => {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
        [crypto.createHash('sha256').update(token).digest('hex'), id, Date.now() + 600000],
      );
      return { cookie: 'han_session=' + token, 'X-Han-Request': '1', 'Content-Type': 'application/json' };
    };
    server = await serve(createApplication({ store: createStore(pool, { records: true }) }));
    const ceo = await headers('test-ceo'),
      viewer = await headers('viewer');
    const post = (path, who, body) =>
      fetch(server.url + path, { method: 'POST', headers: who, body: JSON.stringify(body) });

    assert.equal(
      (await post('/api/privacy/reveal', ceo, { area: 'Müvekkiller · tüm ekranlar', count: 7 })).status,
      200,
    );
    assert.equal(
      (
        await post('/api/privacy/reveal', ceo, {
          area: 'Personel Kayıtları · Excel dökümü',
          count: 4,
          kind: 'export',
        })
      ).status,
      200,
    );
    assert.equal(
      (await post('/api/privacy/reveal', ceo, { count: 3 })).status,
      400,
      'the screen must be named',
    );
    // A read-only account may look at data, so its viewing is recorded too; it still cannot
    // acknowledge a conflict, which belongs to saving a record.
    assert.equal((await post('/api/privacy/reveal', viewer, { area: 'Borçlu Föyü', count: 2 })).status, 200);
    assert.equal(
      (
        await post('/api/conflicts/ack', viewer, {
          kind: 'client',
          name: 'Ahmet Kaya',
          count: 1,
          reason: 'İsim benzerliği; farklı kişi.',
        })
      ).status,
      403,
    );

    const audit = await fetch(server.url + '/api/audit', { headers: ceo }).then((response) =>
      response.json(),
    );
    const entries = audit.items
      .filter((row) => row.area === 'Gizli Kişisel Veriler')
      .map((row) => [row.action, row.record_ref, row.fields.join(), row.actor_username])
      .sort((a, b) => a[1].localeCompare(b[1], 'tr'));
    assert.deepEqual(entries, [
      ['reveal', 'Borçlu Föyü', '2 alan', 'viewer'],
      ['reveal', 'Müvekkiller · tüm ekranlar', '7 alan', 'test'],
      ['download', 'Personel Kayıtları · Excel dökümü', '4 kayıt', 'test'],
    ]);
    assert.equal(
      audit.items.some((row) => row.action === 'conflict'),
      false,
    );
  } finally {
    await server?.close();
    await pg.close();
  }
});
