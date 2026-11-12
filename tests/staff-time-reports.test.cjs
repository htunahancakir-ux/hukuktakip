const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { messageSummary, notificationSummary } = require('../lib/notification-summary.cjs');
test('Managers daily notification counts reset at Istanbul midnight; staff and stored work orders remain intact', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-12T20:59:59Z') });
  const state = {
    workOrders: [{ id: 'w', assigneeId: 'u', status: 'pending', createdAt: '2026-11-12T07:00:00Z' }],
    messages: [{ recipientIds: ['u'], createdAt: '2026-11-12T07:00:00Z' }],
    workflowNotices: [{ id: 'n', userId: 'u', createdAt: '2026-11-12T07:00:00Z' }],
  };
  assert.equal(messageSummary(state, { id: 'u', role: 'admin' }).pendingWorkOrders, 1);
  t.mock.timers.setTime(Date.parse('2026-11-12T21:00:00Z'));
  for (const role of ['admin', 'ceo']) {
    assert.deepEqual(messageSummary(state, { id: 'u', role }), { pendingWorkOrders: 0, unread: 0 });
    assert.equal(notificationSummary(state, { id: 'u', role }, null).workflow.notices.length, 0);
  }
  assert.equal(messageSummary(state, { id: 'u', role: 'staff' }).pendingWorkOrders, 1);
  assert.equal(state.workOrders[0].status, 'pending');
});
test('Real reports calculate period totals, threshold excess and first daily login; SQL reset preserves history', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-13T08:00:00Z') });
  const { pg, pool } = await database();
  let server;
  try {
    const s = fixture();
    s.users.push({ ...s.users[0], id: 'staff', username: 'staff', role: 'staff', staffId: 'p' });
    s.data['icrapro-personnel-v1'] = [{ id: 'p', name: 'Personel', active: true }];
    s.workOrders = [
      { id: 'old', assigneeId: 'test-ceo', status: 'pending', createdAt: '2026-11-12T07:00:00Z' },
    ];
    s.messages = [
      {
        id: 'old-message',
        recipientIds: ['test-ceo'],
        senderId: 'staff',
        subject: 'Mola',
        text: 'Mola',
        readBy: {},
        createdAt: '2026-11-12T07:00:00Z',
      },
    ];
    s.staffBreaks = [
      ['a', '09:30', '09:40'],
      ['b', '10:00', '10:10'],
      ['c', '12:10', '12:40'],
      ['d', '14:10', '14:30'],
      ['e', '11:55', '12:10'],
    ].map(([id, a, b]) => ({
      id,
      userId: 'staff',
      staffId: 'p',
      userName: 'Personel',
      startedAt: '2026-11-12T' + a + ':00+03:00',
      endedAt: '2026-11-12T' + b + ':00+03:00',
    }));
    await importState(pool, s);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(require('../lib/application.cjs').createApplication({ store }));
    const login = async (username) => {
      const r = await fetch(server.url + '/api/login', {
        method: 'POST',
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(r.status, 200, await r.text());
      return { cookie: r.headers.get('set-cookie').split(';')[0], 'X-Han-Request': '1' };
    };
    const headers = await login('test'),
      staff = await login('staff');
    await pool.query(
      "INSERT INTO han_private.han_audit(category,action,area,actor_id,actor_name,occurred_at) VALUES('login','login','Oturum','staff','Personel',$1),('login','login','Oturum','staff','Personel',$2)",
      ['2026-11-12T09:05:00+03:00', '2026-11-12T10:00:00+03:00'],
    );
    const get = async (path, h = headers) => {
      const r = await fetch(server.url + path, { headers: h });
      const body = await r.json();
      assert.equal(r.status, 200, JSON.stringify(body));
      return body;
    };
    assert.equal((await get('/api/notifications')).messages.unread, 0);
    assert.equal((await get('/api/work-orders?scope=mine&status=pending')).total, 1);
    assert.equal((await get('/api/work-orders?scope=mine&status=pending&notification=1')).total, 0);
    const prefix = '/api/records/reports?from=2026-11-12&to=2026-11-12&type=';
    const breaks = await get(prefix + 'staffBreaks');
    assert.equal(breaks.count, '5');
    const rows = breaks.items;
    assert.equal(
      rows.reduce((sum, r) => sum + Number(r.cells.late), 0),
      25,
    );
    assert.equal(rows.find((r) => r.id.startsWith('e:')).cells.period, 'Sabah');
    assert.equal(Number(rows.find((r) => r.id.startsWith('e:')).cells.duration), 15);
    const late = await get(prefix + 'staffBreaks&status=' + encodeURIComponent('Gecikmiş'));
    assert.equal(late.count, '3');
    const arrivals = await get(prefix + 'staffAttendance');
    assert.equal(arrivals.count, '1');
    assert.equal(Number(arrivals.items[0].cells.late), 5);
    assert.equal(arrivals.items[0].cells.arrival, '09:05:00');
    assert.equal((await fetch(server.url + prefix + 'staffBreaks', { headers: staff })).status, 403);
    const saved = await store.readState();
    assert.equal(saved.staffBreaks.length, 5);
    assert.equal(saved.workOrders[0].status, 'pending');
  } finally {
    await server?.close();
    await pg.close();
  }
});
