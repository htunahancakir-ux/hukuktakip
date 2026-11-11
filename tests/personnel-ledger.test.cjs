const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const { syncPayrollPeriods } = require('../outputs/icrapro/payroll-periods.cjs');
const ledger = require('../lib/personnel-ledger.cjs');
const { appendCashEntry } = require('../lib/cash-entry.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
function sample() {
  const state = fixture();
  state.data['icrapro-personnel-v1'] = [
    {
      id: 'p',
      name: 'Personel',
      active: true,
      department: 'Diğer',
      officialSalary: 40000,
      unofficialSalary: 1000,
      bonus: 0,
    },
  ];
  state.data['hanhukuk-accounting-v1'] = {
    accounts: [{ id: 'cash', name: 'Kasa' }],
    entries: [
      {
        id: 'fund',
        type: 'in',
        accountId: 'cash',
        date: '2026-11-01',
        amount: 10000000,
        note: 'Initial balance',
      },
    ],
  };
  state.dailyBonuses = [
    { id: 'daily', staffId: 'p', date: '2026-11-13', amount: 50000, note: 'Hak edilen prim' },
  ];
  return state;
}
const ceo = { id: 'ceo', role: 'ceo', name: 'CEO' };
const payment = (id, extra = {}) => ({
  id,
  type: 'out',
  accountId: 'cash',
  staffId: 'p',
  payrollMonth: '2026-11',
  date: '2026-11-15',
  expenseCategory: 'Maaş Avansı',
  amount: 1000000,
  note: 'Maaş avansı',
  ...extra,
});
test('Monthly accruals are idempotent; new bonuses post differences; advances and prior-month settlements reconcile', () => {
  let state = sample();
  syncPayrollPeriods(state, '2026-11-01');
  let data = ledger.details(state, 'p', '2026-11-01');
  assert.equal(data.balance, 4100000);
  assert.equal(data.payable, 0);
  assert.equal(data.advanceLimit, 1025000);
  assert(state.personnelLedger.accruals.every((row) => row.date === '2026-11-01'));
  const count = state.personnelLedger.accruals.length;
  syncPayrollPeriods(state, '2026-11-01');
  assert.equal(state.personnelLedger.accruals.length, count);
  state.dailyBonuses = [{ id: 'daily', staffId: 'p', date: '2026-11-13', amount: 50000 }];
  syncPayrollPeriods(state, '2026-11-15');
  assert.equal(ledger.details(state, 'p', '2026-11-15').balance, 4150000);
  assert.equal(state.personnelLedger.accruals.at(-1).date, '2026-11-15');
  assert.throws(
    () => ledger.validatePayment(state, payment('too-large', { amount: 1025001 }), ceo, '2026-11-15'),
    /%25/,
  );
  assert.equal(
    ledger.validatePayment(state, payment('exact-limit', { amount: 1025000 }), ceo, '2026-11-15').payrollKind,
    'salaryAdvance',
  );
  ledger.validatePayment(state, payment('advance'), ceo, '2026-11-15');
  state.data['hanhukuk-accounting-v1'].entries.push({ ...payment('advance'), payrollKind: 'salaryAdvance' });
  assert.throws(
    () => ledger.validatePayment(state, payment('second', { amount: 1 }), ceo, '2026-11-15'),
    /zaten aldı/,
  );
  assert.throws(
    () => ledger.validatePayment(state, payment('early', { expenseCategory: 'Maaş' }), ceo, '2026-11-15'),
    /Mevcut ay/,
  );
  syncPayrollPeriods(state, '2026-12-03');
  data = ledger.details(state, 'p', '2026-12-03');
  assert.equal(data.payable, 3150000);
  assert.equal(data.advanceLimit, 1025000);
  const current = data.currentEarned;
  const normal = payment('normal', { expenseCategory: 'Maaş', date: '2026-12-03', amount: 3150000 });
  assert.equal(ledger.validatePayment(state, normal, ceo, '2026-12-03').payrollKind, 'salaryPayment');
  state.data['hanhukuk-accounting-v1'].entries.push({ ...normal, payrollKind: 'salaryPayment' });
  data = ledger.details(state, 'p', '2026-12-03');
  assert.equal(data.months.find((row) => row.month === '2026-11').remaining, 0);
  assert.equal(data.currentEarned, current);
  assert.equal(data.balance, current);
  assert.throws(
    () => ledger.validatePayment(state, { ...normal, payrollMonth: '2026-12' }, ceo, '2026-12-03'),
    /Mevcut ay/,
  );
  assert.throws(() => ledger.validatePayment(state, { ...normal, amount: 1 }, ceo, '2026-12-03'), /kalan/);
  assert(!state.personnelLedger.accruals.some((row) => row.month < '2026-11'));
});
test('Generic accounting updates cannot bypass the monthly advance count or alter settled payment metadata', () => {
  const state = sample();
  syncPayrollPeriods(state, '2026-11-15');
  const next = structuredClone(state);
  next.data['hanhukuk-accounting-v1'].entries.push(
    payment('one', { amount: 100 }),
    payment('two', { amount: 100 }),
  );
  assert.throws(() => ledger.assertPaymentChanges(state, next, ceo, '2026-11-15'), /zaten aldı/);
  const paid = structuredClone(state);
  paid.data['hanhukuk-accounting-v1'].entries.push({ ...payment('one'), payrollKind: 'salaryAdvance' });
  const altered = structuredClone(paid);
  altered.data['hanhukuk-accounting-v1'].entries.at(-1).amount = 1;
  assert.throws(() => ledger.assertPaymentChanges(paid, altered, ceo, '2026-11-15'), /değiştirilemez/);
  assert.throws(
    () => ledger.validatePayment(state, payment('staff'), { role: 'staff' }, '2026-11-15'),
    /yalnızca/,
  );
});
test('Record API serializes simultaneous advances, keeps salary payments in closed months and preserves cash and expense totals', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 15, 9) });
  const { pg, pool } = await database();
  let server;
  try {
    const state = sample();
    syncPayrollPeriods(state, '2026-11-15');
    state.users.push({
      ...state.users[0],
      id: 'staff',
      username: 'staff',
      role: 'staff',
      staffId: 'p',
      permissions: ['cashOut'],
    });
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store }));
    async function login(username = 'test') {
      const response = await fetch(server.url + '/api/login', {
        method: 'POST',
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(response.status, 200, await response.text());
      return {
        cookie: response.headers.get('set-cookie').split(';')[0],
        'X-Han-Request': '1',
        'Content-Type': 'application/json',
      };
    }
    let headers = await login();
    async function get() {
      const r = await fetch(server.url + '/api/records/personnel-ledger?staffId=p', { headers });
      const b = await r.json();
      assert.equal(r.status, 200, JSON.stringify(b));
      return b;
    }
    async function post(value, auth = headers) {
      const r = await fetch(server.url + '/api/cash-entry', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(value),
      });
      return { status: r.status, body: await r.json() };
    }
    assert.equal((await get()).advanceLimit, 1025000);
    const staff = await login('staff');
    assert.equal(
      (await fetch(server.url + '/api/records/personnel-ledger?staffId=p', { headers: staff })).status,
      403,
    );
    assert.equal((await post(payment('forbidden'), staff)).status, 403);
    assert.equal((await post(payment('excess', { amount: 1025001 }))).status, 400);
    const attempts = await Promise.all([post(payment('race-one')), post(payment('race-two'))]);
    assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409], JSON.stringify(attempts));
    const accepted = attempts[0].status === 200 ? 'race-one' : 'race-two';
    assert.equal((await post(payment(accepted))).status, 200);
    let data = await get();
    assert.equal(data.advanceUsed, true);
    assert.equal(data.months.find((row) => row.month === '2026-11').advance, 1000000);
    assert.equal((await post(payment('current', { expenseCategory: 'Maaş', amount: 1 }))).status, 400);
    t.mock.timers.setTime(Date.UTC(2026, 11, 3, 9));
    headers = await login();
    data = await get();
    assert.equal(data.payable, 3150000);
    assert.equal(data.currentEarned, 4100000);
    const normal = (id, amount, month = '2026-11') =>
      payment(id, { expenseCategory: 'Maaş', date: '2026-12-03', payrollMonth: month, amount });
    assert.equal((await post(normal('new-month', 1, '2026-12'))).status, 400);
    assert.equal((await post(normal('overpayment', 3150001))).status, 400);
    const { JSDOM } = require('jsdom'),
      fs = require('node:fs');
    const dom = new JSDOM('<div id="ledger"></div>', { url: server.url, runScripts: 'dangerously' });
    try {
      const w = dom.window;
      Object.assign(w, {
        hanRecordsEnabled: true,
        businessDate: () => '2026-12-03',
        money: (value) => Number(value).toFixed(2) + ' TL',
        financeCents: (value) => Math.round(Number(value) * 100),
        esc: (value) =>
          String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('"', '&quot;'),
        toast() {},
      });
      w.fetch = (url, options = {}) =>
        fetch(server.url + url, {
          ...options,
          headers: { ...headers, ...options.headers },
          signal: undefined,
        });
      for (const file of ['form-inputs.js', 'workspace-personnel-ledger.js']) {
        const script = w.document.createElement('script');
        script.textContent = fs.readFileSync('outputs/icrapro/' + file, 'utf8');
        w.document.body.append(script);
      }
      const host = w.document.querySelector('#ledger');
      await w.personnelLedgerPage(host, 'p');
      const form = host.querySelector('.personnel-payment-form');
      assert(form);
      assert.equal(form.elements.payrollMonth.value, '2026-11');
      assert.equal(form.elements.payrollMonth.options.length, 1);
      assert.equal(form.elements.amount.max, '31500');
      form.elements.mode.value = 'salaryAdvance';
      form.elements.mode.onchange();
      assert.equal(form.elements.payrollMonth.value, '2026-12');
      assert.equal(form.elements.amount.max, '10250');
      form.elements.mode.value = 'salaryPayment';
      form.elements.mode.onchange();
      form.elements.accountId.value = 'cash';
      form.elements.amount.value = '10000';
      assert.equal(form.checkValidity(), true);
      await form.onsubmit({ preventDefault() {} });
    } finally {
      dom.window.close();
    }
    assert.equal((await get()).payable, 2150000);
    const full = await post(normal('full', 2150000));
    assert.equal(full.status, 200, JSON.stringify(full.body));
    data = await get();
    assert.equal(data.months.find((row) => row.month === '2026-11').remaining, 0);
    assert.equal(data.payable, 0);
    assert.equal(data.balance, 4100000);
    const saved = await store.readState();
    const expenses = saved.data['hanhukuk-accounting-v1'].entries.filter((row) => row.type === 'out');
    assert.equal(expenses.length, 3);
    assert.equal(
      expenses.reduce((sum, row) => sum + row.amount, 0),
      4150000,
    );
    assert.equal(expenses.filter((row) => row.expenseCategory === 'Maaş Avansı').length, 1);
    const expenseReport = await fetch(server.url + '/api/records/reports?type=expenses', { headers });
    assert.equal(expenseReport.status, 200);
    const report = await expenseReport.json();
    assert.equal(Number(report.totals.amount), 4150000);
    assert(report.items.some((row) => row.cells.category === 'Maaş Avansı'));
    assert.equal((await fetch(server.url + '/api/personnel-ledger/cron')).status, 401);
    process.env.CRON_SECRET = 'Synthetic-Payroll-Cron-Only';
    try {
      const cron = await fetch(server.url + '/api/personnel-ledger/cron', {
        headers: { authorization: 'Bearer Synthetic-Payroll-Cron-Only' },
      });
      assert.equal(cron.status, 200, await cron.text());
      const count = (await store.readState()).personnelLedger.accruals.length;
      await fetch(server.url + '/api/personnel-ledger/cron', {
        headers: { authorization: 'Bearer Synthetic-Payroll-Cron-Only' },
      });
      assert.equal((await store.readState()).personnelLedger.accruals.length, count);
    } finally {
      delete process.env.CRON_SECRET;
    }
  } finally {
    await server?.close();
    await pg.close();
    t.mock.timers.reset();
  }
});
