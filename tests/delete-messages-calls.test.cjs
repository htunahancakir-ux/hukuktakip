const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const { database, fixture, serve } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createApplication } = require('../lib/application.cjs');

test('Only the CEO deletes staff messages and call records; messages are archived, calls removed', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    for (const [id, role] of [
      ['admin', 'admin'],
      ['staff', 'staff'],
    ])
      state.users.push({ ...state.users[0], id, username: id, name: id, role, permissions: [] });
    state.messages = ['m1', 'm2'].map((id, i) => ({
      id,
      senderId: 'staff',
      senderName: 'staff',
      recipientIds: ['test-ceo'],
      recipientNames: ['Test'],
      subject: 'Konu ' + i,
      text: 'Metin',
      createdAt: '2026-11-0' + (i + 1) + 'T12:00:00.000Z',
      readBy: {},
    }));
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    const audits = [];
    server = await serve(createApplication({ store, background: () => {} }));
    await pool.query("UPDATE han_private.han_jobs SET next_at=clock_timestamp()+interval '1 day'");
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
    const request = async (path, user, data) => {
      const r = await fetch(server.url + path, {
        method: data ? 'POST' : 'GET',
        headers: headers[user],
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      return { status: r.status, data: await r.json() };
    };

    // Messages: listed for the CEO only, deleted with an archive copy.
    assert.equal((await request('/api/operations/delete?type=messages', 'admin')).status, 403);
    const listed = await request('/api/operations/delete?type=messages&id=m2', 'test-ceo');
    assert.equal(listed.status, 200);
    assert.equal(listed.data.items.length, 1);
    assert.match(listed.data.items[0].label, /staff → Test · Konu 1/);
    const row = listed.data.items[0];
    assert.equal(
      (
        await request('/api/operations/delete', 'admin', {
          type: 'messages',
          id: row.id,
          revision: row.revision,
        })
      ).status,
      403,
    );
    const deleted = await request('/api/operations/delete', 'test-ceo', {
      type: 'messages',
      id: row.id,
      revision: row.revision,
    });
    assert.equal(deleted.status, 200);
    const inbox = (await request('/api/messages?box=inbox', 'test-ceo')).data.messages.map((m) => m.id);
    assert.deepEqual(inbox, ['m1']);
    const archived = (await pool.query('SELECT body FROM han_data.operation_archives WHERE active')).rows;
    assert.equal(archived.length, 1);
    assert.equal(archived[0].body.type, 'messages');
    assert.equal(archived[0].body.record.id, 'm2');

    // Call records: the CEO removes a finished call; admins cannot; a live call cannot be removed.
    const call = (id, status) => ({
      id,
      documentId: '',
      phone: '905320000005',
      userId: 'staff',
      requestId: 'request-' + id,
      createdAt: new Date().toISOString(),
      status,
      staffName: 'staff',
    });
    const finished = call(crypto.randomUUID(), 'completed'),
      live = call(crypto.randomUUID(), 'answered');
    for (const c of [finished, live])
      await pool.query(
        `INSERT INTO han_private.voip_calls(id,document_id,phone,user_id,request_id,created_at,status,body,search_text)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'')`,
        [c.id, c.documentId, c.phone, c.userId, c.requestId, c.createdAt, c.status, JSON.stringify(c)],
      );
    assert.equal((await request('/api/voip/delete', 'admin', { id: finished.id })).status, 403);
    assert.equal((await request('/api/voip/delete', 'test-ceo', { id: live.id })).status, 409);
    const removed = await request('/api/voip/delete', 'test-ceo', { id: finished.id });
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    const ids = (await pool.query('SELECT id FROM han_private.voip_calls ORDER BY id')).rows.map((r) => r.id);
    assert.deepEqual(ids, [live.id]);
    const audit = (
      await pool.query(
        "SELECT action, actor_id, record_ref FROM han_private.han_audit WHERE area='Görüşme Kayıtları'",
      )
    ).rows;
    audits.push(...audit);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'delete');
    assert.equal(audits[0].actor_id, 'test-ceo');
    assert.match(audits[0].record_ref, /905320000005/);
  } finally {
    await server?.close();
    await pg.close();
  }
});
