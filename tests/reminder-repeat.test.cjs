const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { nextOccurrence, advanceRepeatingReminders } = require('../lib/reminder-repeat.cjs');
const { database, fixture, serve } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createApplication } = require('../lib/application.cjs');
const { deliverScheduledReminders } = require('../lib/scheduled-reminders.cjs');
test('Recurring dates preserve Turkey time, month-end and leap-year anchors and skip missed dates without a flood', () => {
  const next = (anchor, repeat, now = anchor, index) =>
    nextOccurrence(anchor, repeat, Date.parse(now), index);
  assert.deepEqual(next('2026-11-15T07:30:00.000Z', 'daily'), {
    dueAt: '2026-11-16T07:30:00.000Z',
    index: 1,
  });
  assert.equal(next('2026-11-15T07:30:00.000Z', 'weekly').dueAt, '2026-11-22T07:30:00.000Z');
  assert.equal(next('2027-01-31T21:30:00.000Z', 'monthly').dueAt, '2027-02-28T21:30:00.000Z'); // Feb 1 00:30 Turkey -> March 1
  const jan31 = '2027-01-31T07:30:00.000Z';
  assert.equal(next(jan31, 'monthly').dueAt, '2027-02-28T07:30:00.000Z');
  assert.equal(next(jan31, 'monthly', '2027-02-28T07:30:00.000Z', 2).dueAt, '2027-03-31T07:30:00.000Z');
  const leap = '2024-02-29T07:30:00.000Z';
  assert.equal(next(leap, 'yearly').dueAt, '2025-02-28T07:30:00.000Z');
  assert.equal(next(leap, 'yearly', '2027-03-01T00:00:00.000Z').dueAt, '2028-02-29T07:30:00.000Z');
  assert.deepEqual(next('2026-11-15T07:30:00.000Z', 'daily', '2026-12-01T08:00:00.000Z'), {
    dueAt: '2026-12-02T07:30:00.000Z',
    index: 17,
  });
  assert.equal(next(leap, 'none'), null);
  const state = {
    scheduledReminders: [
      {
        id: 'r',
        accountId: 'a',
        repeat: 'daily',
        dueAt: '2026-11-15T07:30:00.000Z',
        note: 'Test',
        deliveryStatus: 'off',
      },
    ],
  };
  assert.equal(advanceRepeatingReminders(state, Date.parse('2026-12-01T08:00:00Z'), 'a'), true);
  assert.equal(state.scheduledReminders.length, 2);
  assert.equal(state.scheduledReminders[1].dueAt, '2026-12-02T07:30:00.000Z');
  assert.equal(advanceRepeatingReminders(state, Date.parse('2026-12-01T08:00:00Z'), 'a'), false);
  assert.equal(state.scheduledReminders.length, 2);
});
test('Record reminder creation, due notifications, independent recurrence, completion and whole-series cancellation stay owner-scoped', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 15, 6) });
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    state.users.push({ ...state.users[0], id: 'other', username: 'other', role: 'staff', permissions: [] });
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store, background: () => {} }));
    await pool.query("UPDATE han_private.han_jobs SET next_at=clock_timestamp()+interval '1 day'");
    const headers = {};
    for (const user of state.users) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
        [crypto.createHash('sha256').update(token).digest('hex'), user.id, Date.now() + 864000000],
      );
      headers[user.id] = {
        cookie: 'han_session=' + token,
        'X-Han-Request': '1',
        'Content-Type': 'application/json',
      };
    }
    async function req(path, data, user = 'test-ceo') {
      const res = await fetch(server.url + path, {
        method: data ? 'POST' : 'GET',
        headers: headers[user],
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      const body = await res.json();
      return { status: res.status, body };
    }
    const create = (repeat) => ({
      action: 'create',
      date: '2026-11-15',
      time: '10:30',
      note: 'Follow up',
      ...(repeat ? { repeat } : {}),
    });
    assert.equal((await req('/api/scheduled-reminders', create('invalid'))).status, 400);
    const first = await req('/api/scheduled-reminders', create('daily'));
    assert.equal(first.status, 200);
    const id = first.body.id;
    const single = (await req('/api/scheduled-reminders', create())).body.id;
    assert.equal((await req('/api/notifications')).body.reminders.dueCount, 0);
    t.mock.timers.setTime(Date.UTC(2026, 10, 15, 7, 30));
    assert.equal((await req('/api/notifications')).body.reminders.dueCount, 2);
    let list = (await req('/api/scheduled-reminders')).body;
    assert.equal(list.total, 3); // next day exists even before current occurrence is completed
    let future = list.items.find((r) => r.id !== id && r.repeat === 'daily');
    assert.equal(future.dueAt, '2026-11-16T07:30:00.000Z');
    assert.equal(list.items.find((r) => r.id === single).repeat, 'none');
    assert(!list.items.some((r) => 'phoneHash' in r));
    await Promise.all([req('/api/notifications'), req('/api/scheduled-reminders')]);
    assert.equal((await req('/api/scheduled-reminders')).body.total, 3);
    assert.equal((await req('/api/scheduled-reminders', undefined, 'other')).body.total, 0);
    assert.equal(
      (await req('/api/scheduled-reminders', { action: 'cancel', id: future.id }, 'other')).status,
      404,
    );
    assert.equal((await req('/api/scheduled-reminders', { action: 'complete', id })).status, 200);
    assert.equal((await req('/api/notifications')).body.reminders.dueCount, 1);
    assert.equal((await req('/api/scheduled-reminders')).body.total, 2);
    t.mock.timers.setTime(Date.UTC(2026, 10, 16, 7, 30));
    assert.equal((await req('/api/notifications')).body.reminders.dueCount, 2);
    list = (await req('/api/scheduled-reminders')).body;
    assert.equal(list.total, 3);
    assert(list.items.some((r) => r.dueAt === '2026-11-17T07:30:00.000Z'));
    // Cancelling via a completed occurrence must stop all remaining recurrences too.
    assert.equal((await req('/api/scheduled-reminders', { action: 'cancel', id })).status, 200);
    t.mock.timers.setTime(Date.UTC(2026, 10, 18, 9));
    assert.equal((await req('/api/notifications')).body.reminders.dueCount, 1);
    list = (await req('/api/scheduled-reminders')).body;
    assert.equal(list.total, 1);
    assert.equal(list.items[0].id, single);
    assert.equal((await req('/api/scheduled-reminders?status=closed')).body.total, 3);
    // A recurrence can also be advanced by the existing background delivery transaction.
    await pool.query(
      "INSERT INTO han_data.reminders(id,body,ordinal,active) VALUES('background',$1::jsonb,900,true)",
      [
        JSON.stringify({
          id: 'background',
          accountId: 'test-ceo',
          note: 'Background',
          repeat: 'weekly',
          dueAt: '2026-11-17T07:30:00.000Z',
          deliveryStatus: 'off',
        }),
      ],
    );
    const delivery = await deliverScheduledReminders(store.reminderTransaction, {
      authorize: () => true,
      now: Date.now(),
      fetcher: () => {
        throw Error('No real messages in test');
      },
    });
    assert.equal(delivery.processed, 0);
    const series = (
      await pool.query(
        "SELECT body FROM han_data.reminders WHERE id='background' OR body->>'repeatSeriesId'='background'",
      )
    ).rows;
    assert.equal(series.length, 2);
    assert(series.some((r) => r.body.dueAt === '2026-11-24T07:30:00.000Z'));
  } finally {
    await server?.close();
    await pg.close();
    t.mock.timers.reset();
  }
});
test('Reminder dialog submits each repeat choice and shows the recurrence on the list', () => {
  const { JSDOM } = require('jsdom'),
    fs = require('node:fs');
  const dom = new JSDOM('<div id="content"></div>', { runScripts: 'dangerously' });
  try {
    const w = dom.window,
      submitted = [];
    Object.assign(w, {
      businessDate: () => '2026-11-15',
      esc: String,
      termsDate: String,
      toast() {},
      modalFormSaved() {},
      bindReminderPagination() {},
      authApi: (url, method, body) => {
        submitted.push(body);
        return {};
      },
      termsDialog: () => {
        const d = w.document.createElement('div');
        d.innerHTML = '<div class="terms-dialog-content"></div>';
        d.showModal = () => {};
        d.close = () => d.remove();
        w.document.body.append(d);
        return d;
      },
    });
    w.eval(fs.readFileSync('outputs/icrapro/workspace-scheduled-reminders.js', 'utf8'));
    w.scheduledRemindersPage({
      items: [
        {
          id: 'r',
          dueAt: '2099-11-15T07:30:00.000Z',
          note: 'Test',
          repeat: 'monthly',
          deliveryStatus: 'off',
        },
      ],
      dueCount: 0,
    });
    assert.match(w.document.querySelector('.scheduled-list').textContent, /Her Ay/);
    assert.equal(w.document.querySelector('[data-reminder-action=cancel]').textContent, 'Tekrarı durdur');
    w.scheduledRemindersPage = () => {};
    for (const repeat of ['none', 'daily', 'weekly', 'monthly', 'yearly']) {
      w.scheduledReminderDialog(false);
      const form = w.document.querySelector('form');
      assert.equal(form.elements.repeat.options.length, 5);
      form.elements.repeat.value = repeat;
      form.elements.date.value = '2026-11-20';
      form.elements.time.value = '10:30';
      form.elements.note.value = 'Test';
      form.onsubmit({ preventDefault() {} });
      assert.equal(submitted.at(-1).repeat, repeat);
    }
  } finally {
    dom.window.close();
  }
});
