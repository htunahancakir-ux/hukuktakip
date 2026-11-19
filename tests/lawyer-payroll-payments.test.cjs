const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const ledger = require('../lib/personnel-ledger.cjs');
const date = '2026-11-19';
function sample() {
  const s = fixture();
  s.data['icrapro-personnel-v1'] = [
    {
      id: 'lawyer',
      name: 'Avukat',
      department: 'AVUKAT',
      active: true,
      officialSalary: 1000,
      unofficialSalary: 200,
      bonus: 0,
    },
  ];
  s.data['hanhukuk-accounting-v1'] = {
    accounts: [{ id: 'cash', name: 'Kasa' }],
    entries: [{ id: 'opening', type: 'in', accountId: 'cash', amount: 1000000, date, note: 'Opening' }],
  };
  require('../outputs/icrapro/payroll-periods.cjs').syncPayrollPeriods(s, date);
  return s;
}
const payment = (id, amount, category = 'Maaş Avansı') => ({
  id,
  type: 'out',
  accountId: 'cash',
  staffId: 'lawyer',
  payrollMonth: '2026-11',
  date,
  expenseCategory: category,
  amount,
  note: 'Avukat ödemesi',
});
test('Lawyers can repeatedly receive the full earned salary and bonuses, but never exceed unpaid entitlements', () => {
  const s = sample(),
    owner = s.users[0];
  s.payrollPeriods['2026-11'].rows[0].bonus2 = 30000;
  s.payrollPeriods['2026-11'].rows[0].dailyBonus = 1000;
  ledger.syncPersonnelLedger(s, date);
  let data = ledger.details(s, 'lawyer', date);
  assert.equal(data.paymentEarnedOnly, true);
  assert.equal(data.paymentUnrestricted, false);
  assert.equal(data.advanceLimit, 151000);
  assert.equal(data.payable, 151000);
  ledger.validatePayment(s, payment('first', 60000), owner, date);
  s.data['hanhukuk-accounting-v1'].entries.push({ ...payment('first', 60000), payrollKind: 'salaryAdvance' });
  data = ledger.details(s, 'lawyer', date);
  assert(data.advanceUsed);
  assert.equal(data.advanceLimit, 91000);
  ledger.validatePayment(s, payment('second', 60000), owner, date);
  s.data['hanhukuk-accounting-v1'].entries.push({
    ...payment('second', 60000),
    payrollKind: 'salaryAdvance',
  });
  assert.throws(() => ledger.validatePayment(s, payment('over', 31001, 'Maaş'), owner, date), /hakediş/);
  ledger.validatePayment(s, payment('salary', 31000, 'Maaş'), owner, date);
  s.data['hanhukuk-accounting-v1'].entries.push({
    ...payment('salary', 31000, 'Maaş'),
    payrollKind: 'salaryPayment',
  });
  assert.equal(ledger.details(s, 'lawyer', date).balance, 0);
  assert.throws(() => ledger.validatePayment(s, payment('empty', 1), owner, date), /hakediş/);
  assert.throws(
    () => ledger.validatePayment(s, { ...payment('future', 1), payrollMonth: '2026-12' }, owner, date),
    /hak edilmemiş/,
  );
});
test('Record cash commands and payroll UI enforce the same earned ceiling after repeated lawyer advances', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 19, 9) });
  const { pg, pool } = await database();
  let server;
  try {
    const s = sample();
    await importState(pool, s);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(require('../lib/application.cjs').createApplication({ store }));
    const login = await fetch(server.url + '/api/login', {
      method: 'POST',
      headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test', password }),
    });
    assert.equal(login.status, 200);
    const headers = {
      cookie: login.headers.get('set-cookie').split(';')[0],
      'X-Han-Request': '1',
      'Content-Type': 'application/json',
    };
    const read = async () => {
      const r = await fetch(server.url + '/api/records/personnel-ledger?staffId=lawyer', { headers });
      assert.equal(r.status, 200);
      return r.json();
    };
    const post = async (value) => {
      const r = await fetch(server.url + '/api/cash-entry', {
        method: 'POST',
        headers,
        body: JSON.stringify(value),
      });
      return { status: r.status, body: await r.json() };
    };
    let data = await read();
    assert.equal(data.advanceLimit, 120000);
    assert(data.months[0].payable);
    assert.equal((await post(payment('one', 50000))).status, 200);
    assert.equal((await post(payment('two', 50000))).status, 200);
    data = await read();
    assert.equal(data.advanceLimit, 20000);
    const { JSDOM } = require('jsdom'),
      fs = require('node:fs');
    const dom = new JSDOM('<div></div>', { runScripts: 'dangerously' });
    try {
      dom.window.eval(fs.readFileSync('outputs/icrapro/workspace-personnel-ledger.js', 'utf8'));
      const regular = dom.window.personnelPaymentPeriods(data, false),
        advance = dom.window.personnelPaymentPeriods(data, true);
      assert.equal(regular[0].month, '2026-11');
      assert.equal(regular[0].remaining, 20000);
      assert.equal(advance[0].remaining, 20000);
    } finally {
      dom.window.close();
    }
    assert.equal((await post(payment('excess', 20001, 'Maaş'))).status, 400);
    assert.equal((await post(payment('salary', 20000, 'Maaş'))).status, 200);
    assert.equal((await post(payment('unearned', 1))).status, 400);
    data = await read();
    assert.equal(data.balance, 0);
    assert.equal(data.payable, 0);
    const balances = await require('../lib/record-store/accounts.cjs').accountBalances(pool);
    assert.equal(balances.cash, '880000');
    assert.equal(
      (await store.readState()).data['hanhukuk-accounting-v1'].entries.filter((e) => e.staffId === 'lawyer')
        .length,
      3,
    );
  } finally {
    await server?.close();
    await pg.close();
  }
});
