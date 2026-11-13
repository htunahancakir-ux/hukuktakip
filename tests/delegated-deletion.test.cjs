const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { database, fixture, serve } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createApplication } = require('../lib/application.cjs');

test('Delegated deletion is enforced in active record mode, cannot be self-granted and revokes in the same session', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    for (const [id, role, grant] of [
      ['delegated', 'admin', true],
      ['ordinary', 'admin', false],
      ['staff', 'staff', true],
    ])
      state.users.push({ ...state.users[0], id, username: id, name: id, role, deletionAccess: grant });
    state.messages = ['m1', 'm2'].map((id) => ({
      id,
      senderId: 'staff',
      senderName: 'staff',
      recipientIds: ['test-ceo'],
      recipientNames: ['Test'],
      subject: id,
      text: 'Test message',
      createdAt: '2026-11-01T10:00:00Z',
      readBy: {},
    }));
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store, background: () => {} }));
    const cookies = {};
    for (const user of state.users) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
        [crypto.createHash('sha256').update(token).digest('hex'), user.id, Date.now() + 600000],
      );
      cookies[user.id] = 'han_session=' + token;
    }
    async function request(path, user, body) {
      const res = await fetch(server.url + path, {
        method: body ? 'POST' : 'GET',
        headers: { cookie: cookies[user], 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: await res.json() };
    }
    assert.equal((await request('/api/session', 'delegated')).body.user.canDelete, true);
    for (const user of ['ordinary', 'staff'])
      assert.equal((await request('/api/operations/delete?type=messages', user)).status, 403);
    const forged = await request('/api/users', 'ordinary', {
      id: 'ordinary',
      role: 'admin',
      active: true,
      deletionAccess: true,
    });
    assert.equal(forged.status, 200, JSON.stringify(forged.body));
    assert.equal((await request('/api/session', 'ordinary')).body.user.canDelete, false);
    const listed = await request('/api/operations/delete?type=messages', 'delegated');
    assert.equal(listed.status, 200);
    const row = listed.body.items[0];
    const deleted = await request('/api/operations/delete', 'delegated', {
      type: 'messages',
      id: row.id,
      revision: row.revision,
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    const saved = await store.readState();
    assert.equal(saved.deletedOperations[0].deletedBy, 'delegated');
    assert.equal(saved.messages.length, 1);
    // The same session immediately observes a server-side revocation.
    await store.transaction(({ state, saveState }) => {
      state.users.find((u) => u.id === 'delegated').deletionAccess = false;
      saveState(state);
    });
    assert.equal((await request('/api/session', 'delegated')).body.user.canDelete, false);
    assert.equal((await request('/api/operations/delete?type=messages', 'delegated')).status, 403);
    assert.equal(
      (
        await request('/api/operations/delete', 'delegated', {
          type: 'messages',
          id: 'm2',
          revision: row.revision,
        })
      ).status,
      403,
    );
  } finally {
    await server?.close();
    await pg.close();
  }
});
