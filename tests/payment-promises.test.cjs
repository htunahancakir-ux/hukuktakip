const { test } = require('node:test');
const assert = require('node:assert/strict');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { createApplication } = require('../lib/application.cjs');
const { password, fixture, database, serve } = require('./support/postgres.cjs');

// Istanbul calendar day, as the server's parkingToday() uses.
const day = (offset) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Istanbul' }).format(new Date(Date.now() + offset * 86400000));

test('payment promises: staff see their own files, managers see all with the responsible person, upcoming ones too', async () => {
  const state = fixture();
  state.data['icrapro-personnel-v1'].push(
    { id: 'p-cihan', name: 'Cihan Erol', active: true },
    { id: 'p-other', name: 'Ayşe Kaya', active: true },
  );
  state.users.push({ ...state.users[0], id: 'u-cihan', username: 'cihan', name: 'Cihan Erol', role: 'staff', staffId: 'p-cihan' });
  const promise = (date, amount = 100000) => ({ id: 'pp-' + date, date, amount, description: 'Söz ' + date, receivedAtCreation: 0 });
  state.data['icrapro-v1'].docs.push(
    { id: 'd-talip', number: 'D-1', debtor: 'Talip Çelik', relatedStaff: 'p-cihan', status: 'Derdest', paymentPromise: promise(day(5)) },
    { id: 'd-due', number: 'D-2', debtor: 'Bugün Ödeyecek', relatedStaff: 'p-cihan', status: 'Derdest', paymentPromise: promise(day(0)) },
    { id: 'd-late', number: 'D-3', debtor: 'Gecikmiş Borçlu', relatedStaff: 'p-other', status: 'Derdest', paymentPromise: promise(day(-3)) },
    { id: 'd-closed', number: 'D-4', debtor: 'Kapanmış', relatedStaff: 'p-cihan', status: 'İnfaz', paymentPromise: promise(day(-1)) },
  );
  const { pg, pool } = await database();
  await importState(pool, state);
  const app = await serve(createApplication({ store: createStore(pool) }));
  try {
    const get = async (username) => {
      const login = await fetch(app.url + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
        body: JSON.stringify({ username, password }),
      });
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const res = await fetch(app.url + '/api/payment-promises', { headers: { cookie, 'X-Han-Request': '1' } });
      assert.equal(res.status, 200);
      return res.json();
    };
    const staff = await get('cihan');
    assert.equal(staff.manager, false);
    assert.deepEqual(
      staff.rows.map((r) => [r.debtor, r.upcoming]),
      [
        ['Bugün Ödeyecek', false],
        ['Talip Çelik', true],
      ],
      'own files only; due first, then the upcoming promise',
    );
    assert.equal(staff.rows[0].staffName, undefined, 'staff do not get the responsible column');

    const ceo = await get('test');
    assert.equal(ceo.manager, true);
    assert.deepEqual(
      ceo.rows.map((r) => [r.debtor, r.staffName, r.upcoming]),
      [
        ['Gecikmiş Borçlu', 'Ayşe Kaya', false],
        ['Bugün Ödeyecek', 'Cihan Erol', false],
        ['Talip Çelik', 'Cihan Erol', true],
      ],
      'every open file, overdue first; closed (İnfaz) files are left out',
    );
  } finally {
    await app.close();
    await pg.close();
  }
});
