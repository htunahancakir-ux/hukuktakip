const { test } = require('node:test');
const assert = require('node:assert/strict');
const { staffBreakStatus, changeStaffBreak } = require('../lib/staff-breaks.cjs');
const staff = { id: 'staff', role: 'staff', name: 'Test Staff', active: true };
function fixture() {
  return {
    users: [
      staff,
      { id: 'ceo', role: 'ceo', name: 'CEO', active: true },
      { id: 'admin', role: 'admin', name: 'Admin', active: true },
      { id: 'inactive', role: 'admin', active: false },
      { id: 'other', role: 'staff', active: true },
    ],
    messages: [],
    workflowNotices: [],
  };
}
const start = Date.parse('2026-11-07T08:00:00Z');
test('Server timestamps persist a single active break and notify only enabled managers with exact duration', () => {
  const state = fixture(),
    original = structuredClone(state);
  let seq = 0;
  const options = { now: start, randomUUID: () => String(++seq), userEnabled: (u) => u.active };
  const begun = changeStaffBreak(
    state,
    staff,
    { action: 'start', requestId: 'req', userId: 'other', startedAt: '1900-01-01' },
    options,
  );
  assert.deepEqual(state, original);
  assert.equal(begun.next.staffBreaks.length, 1);
  assert.equal(begun.status.activeBreak.startedAt, new Date(start).toISOString());
  assert.deepEqual(begun.next.messages[0].recipientIds, ['ceo', 'admin']);
  assert.equal(begun.next.workflowNotices.length, 2);
  assert.equal(begun.next.users.find((u) => u.id === 'other').activeBreak, undefined);
  assert.equal(
    changeStaffBreak(begun.next, staff, { action: 'start', requestId: 'another' }, options).next,
    null,
  );
  const ended = changeStaffBreak(
    begun.next,
    staff,
    { action: 'end', breakId: begun.status.activeBreak.id, endedAt: '1900-01-01', durationSeconds: 1 },
    { ...options, now: start + 165000 },
  );
  assert.equal(ended.status.activeBreak, null);
  assert.equal(ended.status.lastBreak.durationSeconds, 165);
  assert.equal(ended.status.lastBreak.durationMinutes, 2.75);
  assert(ended.next.messages[1].text.includes('2 dk 45 sn'));
  assert.equal(ended.next.messages.length, 2);
  assert.equal(ended.next.workflowNotices.length, 4);
  assert.equal(
    changeStaffBreak(ended.next, staff, { action: 'end', breakId: begun.status.activeBreak.id }, options)
      .next,
    null,
  );
  assert.throws(() => changeStaffBreak(ended.next, staff, { action: 'start', requestId: 'req' }, options), {
    code: 409,
  });
  const nextBreak = changeStaffBreak(
    ended.next,
    staff,
    { action: 'start', requestId: 'next' },
    { ...options, now: start + 200000 },
  );
  const oldRetry = changeStaffBreak(
    nextBreak.next,
    staff,
    { action: 'end', breakId: begun.status.activeBreak.id },
    options,
  );
  assert.equal(oldRetry.next, null);
  assert.equal(oldRetry.status.activeBreak.id, nextBreak.status.activeBreak.id);
});
test('Reject forged or invalid break operations without modifying records', () => {
  const state = fixture();
  assert.throws(
    () => changeStaffBreak(state, { ...staff, role: 'admin' }, { action: 'start', requestId: 'a' }),
    { code: 403 },
  );
  for (const input of [
    null,
    {},
    { action: 'unknown' },
    { action: 'start' },
    { action: 'end', breakId: 'another-user' },
  ])
    assert.throws(
      () => changeStaffBreak(state, staff, input),
      (error) => [400, 409].includes(error.code),
    );
  assert.equal(staffBreakStatus(state, staff).activeBreak, null);
  assert.deepEqual(state.messages, []);
});

test('PostgreSQL: concurrent starts and ends, refresh and fast notifications retain break state and manager messages', async () => {
  const { database, fixture: baseFixture, password, serve } = require('./support/postgres.cjs');
  const { importState, createStore } = require('../lib/postgres-store.cjs');
  const { createApplication } = require('../lib/application.cjs');
  const { pg, pool } = await database();
  let app;
  try {
    const state = baseFixture();
    state.users.push({
      ...state.users[0],
      id: 'staff',
      username: 'staff',
      name: 'Test Staff',
      role: 'staff',
    });
    await importState(pool, state);
    const store = createStore(pool);
    app = await serve(createApplication({ store }));
    const post = (url, value, cookie, extraHeaders = {}) =>
      fetch(app.url + url, {
        method: 'POST',
        headers: {
          'X-Han-Request': '1',
          'Content-Type': 'application/json',
          ...(cookie ? { cookie } : {}),
          ...extraHeaders,
        },
        body: JSON.stringify(value),
      });
    const login = async (username, extraHeaders) => {
      const res = await post('/api/login', { username, password }, null, extraHeaders);
      assert.equal(res.status, 200);
      return res.headers.get('set-cookie').split(';')[0];
    };
    let employee = await login('staff');
    const manager = await login('test');
    const mobile = await login('staff', { 'user-agent': 'Mobile Test Browser' });
    const requests = await Promise.all(
      ['one', 'two'].map((requestId) => post('/api/staff-breaks', { action: 'start', requestId }, employee)),
    );
    assert.deepEqual(
      requests.map((r) => r.status),
      [200, 200],
    );
    const active = (await requests[0].json()).activeBreak;
    const get = async (url, cookie) => {
      const res = await fetch(app.url + url, { headers: { cookie } });
      assert.equal(res.status, 200);
      return res.json();
    };
    assert.equal((await get('/api/session', employee)).user.activeBreak.id, active.id);
    assert.equal((await get('/api/notifications', employee)).staffBreak.id, active.id);
    assert.equal((await get('/api/session', mobile)).user.activeBreak.id, active.id);
    for (const cookie of [employee, mobile]) {
      assert.equal((await fetch(app.url + '/api/data?key=icrapro-v1', { headers: { cookie } })).status, 423);
      const blocked = await post(
        '/api/messages',
        { recipientIds: ['test-ceo'], subject: 'Blocked', text: 'Do not save' },
        cookie,
      );
      assert.equal(blocked.status, 423);
      assert.equal((await blocked.json()).code, 'staff_on_break');
      const write = await fetch(app.url + '/api/data?key=hanhukuk-finance-v1', {
        method: 'PUT',
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ value: [] }),
      });
      assert.equal(write.status, 423);
    }
    assert.equal(
      (
        await post(
          '/api/account/password',
          { currentPassword: password, password: 'NoChange-Synthetic' },
          employee,
        )
      ).status,
      423,
    );
    assert.equal(
      (await post('/api/staff-breaks', { action: 'end', breakId: active.id }, employee)).status,
      403,
    );
    assert.equal(
      (
        await post(
          '/api/staff-breaks',
          { action: 'end', breakId: active.id, password: 'wrong-synthetic' },
          employee,
        )
      ).status,
      403,
    );
    assert.equal(
      (await post('/api/work-orders', { assigneeId: 'missing', title: 'Test' }, manager)).status,
      400,
    );
    assert.equal((await post('/api/logout', {}, mobile)).status, 200);
    assert.equal(
      (
        await post(
          '/api/messages',
          { recipientIds: ['test-ceo'], subject: 'Old session', text: 'Blocked' },
          employee,
        )
      ).status,
      401,
    );
    employee = await login('staff');
    assert.equal((await get('/api/session', employee)).user.activeBreak.id, active.id);
    const notices = await get('/api/notifications', manager);
    assert.equal(notices.messages.unread, 1);
    assert.equal(notices.workflow.notices[0].type, 'breakStarted');
    assert.equal(
      (await post('/api/staff-breaks', { action: 'start', requestId: 'manager' }, manager)).status,
      403,
    );
    const ends = await Promise.all(
      [1, 2].map(() => post('/api/staff-breaks', { action: 'end', breakId: active.id, password }, employee)),
    );
    assert.deepEqual(
      ends.map((r) => r.status),
      [200, 200],
    );
    assert.equal((await get('/api/notifications', employee)).staffBreak, null);
    const snapshot = await store.readState();
    assert.equal(snapshot.staffBreaks.length, 1);
    assert.equal(snapshot.messages.length, 2);
    assert(snapshot.staffBreaks[0].durationSeconds >= 0);
    assert(!JSON.stringify(snapshot).includes(password));
    const final = await get('/api/notifications', manager);
    assert.equal(final.messages.unread, 2);
    assert.deepEqual(
      final.workflow.notices.map((n) => n.type),
      ['breakStarted', 'breakEnded'],
    );
    assert.equal(
      (
        await post(
          '/api/messages',
          { recipientIds: ['test-ceo'], subject: 'Resumed', text: 'Allowed after break' },
          employee,
        )
      ).status,
      201,
    );
  } finally {
    if (app) await app.close();
    await pg.close();
  }
});
