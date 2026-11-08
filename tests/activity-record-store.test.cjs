const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const { database, fixture, serve } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createApplication } = require('../lib/application.cjs');
const { deliverScheduledReminders } = require('../lib/scheduled-reminders.cjs');
test('Activity pages and notifications use complete counts; scoped commands preserve history and enforce ownership', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    state.users.push({
      ...state.users[0],
      id: 'staff',
      username: 'staff',
      name: 'Staff',
      role: 'staff',
      permissions: [],
    });
    state.messages = Array.from({ length: 123 }, (_, i) => ({
      id: 'm' + String(i).padStart(3, '0'),
      senderId: 'test-ceo',
      senderName: 'Test',
      recipientIds: ['staff'],
      recipientNames: ['Staff'],
      subject: 'Subject ' + i,
      text: '<img src=x onerror=alert(1)>',
      createdAt: '2026-01-01T12:00:00Z',
      readBy: i === 0 ? { staff: '2026-01-02T12:00:00Z' } : {},
    }));
    state.workOrders = Array.from({ length: 71 }, (_, i) => ({
      id: 'w' + i,
      assignerId: 'test-ceo',
      assignerName: 'Test',
      assigneeId: 'staff',
      assigneeName: 'Staff',
      title: 'Order ' + i,
      description: 'Detail',
      status: 'pending',
      createdAt: '2026-01-01T12:00:00Z',
    }));
    state.scheduledReminders = Array.from({ length: 61 }, (_, i) => ({
      id: 'r' + i,
      accountId: 'staff',
      note: 'Remember',
      dueAt: '2026-01-01T12:00:00Z',
      deliveryStatus: 'off',
      createdAt: '2026-01-01T12:00:00Z',
    }));
    state.scheduledReminders.push({
      id: 'hidden',
      accountId: 'test-ceo',
      note: 'Private',
      dueAt: '2026-01-01T12:00:00Z',
      deliveryStatus: 'pending',
    });
    state.data['icrapro-v1'] = {
      clients: [{ id: 'c', name: 'Client' }],
      docs: [{ id: 'd', client: 'c', amount: 100, status: 'Derdest', fileData: 'keep' }],
    };
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store, background: () => {} }));
    // Keep unrelated automation out of this read/write fixture.
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
    async function request(path, user = 'staff', data) {
      const r = await fetch(server.url + path, {
        method: data ? 'POST' : 'GET',
        headers: headers[user],
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      return { status: r.status, data: await r.json() };
    }
    const before = (await pool.query('SELECT id,body,revision FROM han_data.documents')).rows;
    const first = (await request('/api/messages')).data;
    assert.equal(first.total, 123);
    assert.equal(first.messages.length, 50);
    const second = (await request('/api/messages?after=' + first.next + '&offset=50')).data,
      third = (await request('/api/messages?after=' + second.next + '&offset=100')).data;
    assert.equal(
      new Set([...first.messages, ...second.messages, ...third.messages].map((m) => m.id)).size,
      123,
    );
    assert.equal(third.messages.length, 23);
    assert.equal((await request('/api/messages?box=all')).status, 403);
    assert.equal((await request('/api/work-orders?scope=all')).status, 403);
    assert.equal((await request('/api/messages?box=sent&after=' + first.next)).status, 400);
    const n = (await request('/api/notifications')).data;
    assert.equal(n.messages.unread, 122);
    assert.equal(n.messages.pendingWorkOrders, 71);
    assert.equal(n.reminders.dueCount, 61);
    assert.equal((await request('/api/messages/read', 'staff', { id: 'm001' })).status, 200);
    assert.equal((await request('/api/messages/summary')).data.unread, 121);
    assert.equal(
      (
        await request('/api/messages', 'staff', {
          subject: 'Reply',
          text: 'Hello',
          recipientIds: ['test-ceo'],
          whatsapp: false,
        })
      ).status,
      201,
    );
    assert.equal((await request('/api/messages', 'test-ceo')).data.total, 1);
    assert.equal(
      (await request('/api/work-orders/complete', 'test-ceo', { id: 'w0', result: 'Diğer' })).status,
      404,
    );
    assert.equal(
      (await request('/api/work-orders/complete', 'staff', { id: 'w0', result: 'Diğer', note: 'Done' }))
        .status,
      200,
    );
    assert.equal(
      (await request('/api/work-orders/complete', 'staff', { id: 'w0', result: 'Diğer' })).status,
      200,
    );
    assert.equal((await request('/api/messages', 'test-ceo')).data.total, 2);
    assert.equal((await request('/api/work-orders')).data.total, 70);
    const reminders = (await request('/api/scheduled-reminders')).data;
    assert.equal(reminders.total, 61);
    assert.equal(reminders.items.length, 50);
    assert.ok(reminders.items.every((r) => r.accountId === 'staff' && !('phoneHash' in r)));
    assert.equal(
      (await request('/api/scheduled-reminders', 'staff', { action: 'cancel', id: 'hidden' })).status,
      404,
    );
    assert.equal(
      (await request('/api/scheduled-reminders', 'staff', { action: 'complete', id: 'r0' })).status,
      200,
    );
    assert.equal((await request('/api/notifications')).data.reminders.dueCount, 60);
    assert.equal(
      (
        await request('/api/scheduled-reminders', 'staff', {
          action: 'create',
          date: '2099-01-01',
          time: '12:00',
          note: 'Future',
          targetType: 'client',
          targetId: 'c',
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await request('/api/scheduled-reminders', 'test-ceo', {
          action: 'create',
          date: '2099-01-01',
          time: '12:00',
          note: 'Future',
          targetType: 'client',
          targetId: 'c',
        })
      ).status,
      200,
    );
    await deliverScheduledReminders(store.reminderTransaction, {
      authorize: () => true,
      fetcher: () => {
        throw Error('No external messages allowed');
      },
    });
    assert.equal(
      (await pool.query("SELECT body->>'deliveryStatus' AS status FROM han_data.reminders WHERE id='hidden'"))
        .rows[0].status,
      'unavailable',
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM han_data.messages WHERE active')).rows[0].n,
      125,
    );
    assert.deepEqual((await pool.query('SELECT id,body,revision FROM han_data.documents')).rows, before);
  } finally {
    await server?.close();
    await pg.close();
  }
});
