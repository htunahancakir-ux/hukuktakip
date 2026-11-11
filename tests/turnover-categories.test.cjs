const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { categories } = require('../lib/turnover-categories.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');
const { businessDate } = require('../lib/business-time.cjs');

test('Other turnover sources enter every INS metric, never personnel lists or bonuses', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture(),
      today = businessDate();
    state.users.push({ ...state.users[0], id: 'staff-user', username: 'staff', role: 'staff' });
    state.data['icrapro-personnel-v1'] = [
      { id: 'person', name: 'Personel', department: 'Call Center-E', active: true, bonus: 0 },
    ];
    state.data['icrapro-v1'] = {
      clients: [{ id: 'client', name: 'Müvekkil' }],
      docs: Object.keys(categories).map((id, i) => ({
        id: 'doc' + i,
        number: 'S-' + i,
        client: 'client',
        relatedStaff: 'person',
        amount: 600000,
        status: 'Derdest',
      })),
    };
    state.data['hanhukuk-accounting-v1'].accounts = [{ id: 'cash', name: 'Kasa' }];
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store }));
    const login = async (username) => {
      const response = await fetch(server.url + '/api/login', {
        method: 'POST',
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(response.status, 200);
      return {
        cookie: response.headers.get('set-cookie').split(';')[0],
        'X-Han-Request': '1',
        'Content-Type': 'application/json',
      };
    };
    const manager = await login('test'),
      staff = await login('staff');
    const post = (event, headers = manager) =>
      fetch(server.url + '/api/data/patch?key=hanhukuk-finance-v1', {
        method: 'PUT',
        headers,
        body: JSON.stringify(diff('hanhukuk-finance-v1', [], [event])),
      });
    let i = 0;
    for (const [id, name] of Object.entries(categories)) {
      const event = {
        id: 'event' + i,
        documentId: 'doc' + i,
        type: 'payment',
        date: today,
        amount: 60000000,
        closes: true,
        closedAmount: 60000000,
        accountId: 'cash',
        turnoverStaffId: id,
        turnoverStaffName: 'Untrusted',
      };
      assert.equal((await post(event, staff)).status, 403);
      const response = await post(event);
      assert.equal(response.status, 200, await response.text());
      const saved = (await store.readState()).data['hanhukuk-finance-v1'].find((e) => e.id === event.id);
      assert.equal(saved.turnoverStaffName, name);
      assert.equal(saved.collectionStaffName, name);
      i++;
    }
    const rows = (
      await require('../lib/record-store/reports.cjs').insReport(
        pool,
        { headers: manager },
        { from: today, to: today },
      )
    ).rows;
    for (const [id, name] of Object.entries(categories)) {
      const row = rows.find((r) => r.id === id);
      assert(row);
      assert.equal(row.name, name);
      assert.equal(row.collected, '60000000');
      assert.equal(row.closedCount, '1');
      assert.equal(row.closedAmount, '60000000');
    }
    const data = (await store.readState()).data;
    const bonus = require('../outputs/icrapro/personnel-bonus.cjs').calculateCallcenterBonus(
      { data },
      today.slice(0, 7),
    );
    assert.equal(bonus[0].collected, 0);
    assert.equal(bonus[0].total, 0);
    const response = await fetch(server.url + '/api/bonus2?month=' + today.slice(0, 7), { headers: manager });
    assert.equal(response.status, 200);
    const payroll = await response.json();
    assert.equal(payroll.rows.length, 1);
    assert.equal(payroll.rows[0].total, 0);
    assert.equal((await store.readState()).data['icrapro-personnel-v1'].length, 1);
  } finally {
    await server?.close();
    await pg.close();
  }
});
