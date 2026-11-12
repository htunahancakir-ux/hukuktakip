const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { database, fixture, serve } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
test('Pazarlama erişimi personel birimine ve yönetici rolüne göre uygulanır', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture(),
      template = state.users[0];
    state.users.push(
      { ...template, id: 'marketing', username: 'marketing', role: 'staff', staffId: 'm' },
      { ...template, id: 'other', username: 'other', role: 'staff', staffId: 'o' },
    );
    state.data['icrapro-personnel-v1'].push(
      { id: 'm', name: 'P', department: 'Pazarlama', active: true },
      { id: 'o', name: 'D', department: 'Muhasebe', active: true },
    );
    state.marketingProspects = [{ id: 'a', createdBy: 'marketing', company: 'Example' }];
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    server = await serve(createApplication({ store: createStore(pool, { records: true }) }));
    for (const [id, allowed] of [
      ['test-ceo', true],
      ['marketing', true],
      ['other', false],
    ]) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
        [crypto.createHash('sha256').update(token).digest('hex'), id, Date.now() + 600000],
      );
      const headers = {
        cookie: 'han_session=' + token,
        'X-Han-Request': '1',
        'Content-Type': 'application/json',
      };
      const session = await fetch(server.url + '/api/session', { headers });
      assert.equal((await session.json()).user.marketingAccess, allowed);
      const get = await fetch(server.url + '/api/marketing-prospects', { headers });
      assert.equal(get.status, allowed ? 200 : 403);
      if (id === 'marketing') {
        const entry = {
          company: 'Örnek',
          date: '2026-11-09',
          status: 'Mevcut Müvekkil',
          notes: 'Görüşme',
          phone: '05321234567',
          phoneSource: 'Firma yetkilisi',
        };
        const post = await fetch(server.url + '/api/marketing-prospects', {
          method: 'POST',
          headers,
          body: JSON.stringify(entry),
        });
        assert.equal(post.status, 201);
        const saved = await (await fetch(server.url + '/api/marketing-prospects', { headers })).json();
        assert.equal(saved.items.find((item) => item.company === 'Örnek').notes, 'Görüşme');
        assert.deepEqual(saved.items.find((item) => item.company === 'Örnek').phoneSources, {
          5321234567: 'Firma yetkilisi',
        });
        const invalid = await fetch(server.url + '/api/marketing-prospects', {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...entry, status: 'Potansiyel Müvekkil' }),
        });
        assert.equal(invalid.status, 400);
      }
      if (!allowed) {
        const post = await fetch(server.url + '/api/marketing-prospects', {
          method: 'POST',
          headers,
          body: '{}',
        });
        assert.equal(post.status, 403);
      }
    }
    const anonymous = await fetch(server.url + '/api/session');
    assert.equal(anonymous.status, 200);
  } finally {
    await server?.close();
    await pg.close();
  }
});
