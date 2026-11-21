const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { syncPayrollPeriods } = require('../outputs/icrapro/payroll-periods.cjs');
const ledger = require('../lib/personnel-ledger.cjs');
const staffId = '89aa3ed1-4b11-4a3f-852e-4a3d687a1ef9';
const today = '2026-11-20';
function sample() {
  const s = fixture();
  s.data['icrapro-personnel-v1'] = [
    {
      id: staffId,
      name: 'SEFER SASA',
      department: 'Yönetici',
      title: 'CEO',
      active: true,
      officialSalary: 28075.5,
      unofficialSalary: 0,
      bonus: 0,
    },
    {
      id: 'same-name',
      name: 'SEFER SASA',
      department: 'Yönetici',
      active: true,
      officialSalary: 28075.5,
      unofficialSalary: 0,
      bonus: 0,
    },
  ];
  s.users[0].staffId = staffId;
  s.data['hanhukuk-accounting-v1'] = {
    accounts: [{ id: 'cash', name: 'Kasa' }],
    entries: [
      { id: 'opening', type: 'in', amount: 10000000, accountId: 'cash', date: today, note: 'Test opening' },
    ],
  };
  syncPayrollPeriods(s, today);
  return s;
}
const payment = (id, amount, category = 'Maaş') => ({
  id,
  type: 'out',
  accountId: 'cash',
  staffId,
  payrollMonth: '2026-11',
  date: today,
  expenseCategory: category,
  amount,
  note: 'Sefer Sasa salary test',
});
test('Sefer Sasa can receive the full current salary, with repeated payments capped by the unpaid entitlement', () => {
  const s = sample(),
    user = s.users[0];
  let data = ledger.details(s, staffId, today);
  assert.equal(data.payable, 2807550);
  assert.equal(data.advanceLimit, 0);
  assert.equal(data.paymentSalaryOnly, true);
  assert.equal(data.paymentEarnedOnly, true);
  assert.equal(data.paymentUnrestricted, false);
  const row = s.payrollPeriods['2026-11'].rows.find((r) => r.staffId === staffId);
  assert.equal(row.bonus1, 0);
  assert.equal(row.bonus2, 0);
  assert.equal(row.salary, 2807550);
  assert.equal(ledger.details(s, 'same-name', today).paymentEarnedOnly, false);
  assert.throws(() => ledger.validatePayment(s, payment('over', 2807551), user, today), /hakediş/);
  assert.throws(
    () => ledger.validatePayment(s, payment('advance', 1, 'Maaş Avansı'), user, today),
    /maaş avansı kullanılmaz/,
  );
  for (const p of [payment('one', 1000000), payment('two', 1000000), payment('three', 807550)]) {
    const fields = ledger.validatePayment(s, p, user, today);
    s.data['hanhukuk-accounting-v1'].entries.push({ ...p, ...fields });
  }
  assert.equal(ledger.details(s, staffId, today).balance, 0);
  assert.throws(() => ledger.validatePayment(s, payment('again', 1), user, today), /hakediş/);
  assert.throws(
    () => ledger.validatePayment(s, { ...payment('future', 1), payrollMonth: '2026-12' }, user, today),
    /hak edilmemiş/,
  );
  assert.throws(
    () => ledger.validatePayment(sample(), payment('unauthorized', 1), { role: 'staff' }, today),
    /yetkiniz/,
  );
});
test('Sefer Sasa is included in payroll and excluded from INS; record APIs and payment UI allow the full salary', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 20, 9) });
  const { pg, pool } = await database();
  let server;
  const dom = new JSDOM(
    '<div id="ledger"></div><form id="cash"><div class="formbody"></div><select name="type"><option value="out">out</option></select><select name="expenseCategory"><option>Maaş Avansı</option><option>Maaş</option></select><input name="amount" type="number"></form>',
    { runScripts: 'dangerously' },
  );
  try {
    const s = sample();
    await importState(pool, s);
    await importRecords(pool);
    await activateRecords(pool);
    server = await serve(
      require('../lib/application.cjs').createApplication({ store: createStore(pool, { records: true }) }),
    );
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
    const get = async (path) => {
      const r = await fetch(server.url + path, { headers });
      assert.equal(r.status, 200);
      return r.json();
    };
    const data = await get('/api/records/personnel-ledger?staffId=' + staffId);
    assert(data.people.some((p) => p.id === staffId));
    assert.equal(data.payable, 2807550);
    dom.window.eval(fs.readFileSync('outputs/icrapro/workspace-personnel-ledger.js', 'utf8'));
    assert.equal(dom.window.personnelPaymentPeriods(data, false)[0].remaining, 2807550);
    assert.equal(dom.window.personnelPaymentPeriods(data, true).length, 0);
    Object.assign(dom.window, {
      hanRecordsEnabled: true,
      personnel: s.data['icrapro-personnel-v1'],
      businessDate: () => today,
      displayDate: String,
      money: String,
      esc: (v) => String(v ?? ''),
      toast() {},
      fetch: async () => ({ ok: true, json: async () => data }),
    });
    dom.window.eval(fs.readFileSync('outputs/icrapro/form-inputs.js', 'utf8'));
    await dom.window.personnelLedgerPage(dom.window.document.querySelector('#ledger'), staffId);
    const paymentForm = dom.window.document.querySelector('.personnel-payment-form');
    assert(paymentForm);
    assert.equal(paymentForm.elements.mode.options.length, 1);
    assert.equal(paymentForm.elements.mode.value, 'salaryPayment');
    assert.equal(paymentForm.elements.amount.max, '28075.5');
    assert(!dom.window.document.querySelector('#ledger').textContent.includes('Avans'));
    const cashForm = dom.window.document.querySelector('#cash');
    dom.window.setupPayrollCashFields(cashForm);
    cashForm.elements.staffId.value = staffId;
    cashForm.elements.staffId.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cashForm.elements.expenseCategory.value, 'Maaş');
    assert.equal(cashForm.elements.amount.max, '28075.5');
    assert(!cashForm.textContent.includes('Avukat'));
    dom.window.eval(fs.readFileSync('outputs/icrapro/workspace-reports.js', 'utf8'));
    assert(
      !dom.window
        .insPersonnelRows([], s.data['icrapro-personnel-v1'], [], 'month', today)
        .some((p) => p.id === staffId),
    );
    const ins = await get('/api/records/reports/ins?from=' + today + '&to=' + today);
    assert(!JSON.stringify(ins).includes(staffId));
    const advance = await fetch(server.url + '/api/cash-entry', {
      method: 'POST',
      headers,
      body: JSON.stringify(payment('advance-rejected', 1, 'Maaş Avansı')),
    });
    assert.equal(advance.status, 400);
    const paid = await fetch(server.url + '/api/cash-entry', {
      method: 'POST',
      headers,
      body: JSON.stringify(payment('full', 2807550)),
    });
    assert.equal(paid.status, 200, await paid.text());
    assert.equal((await get('/api/records/personnel-ledger?staffId=' + staffId)).balance, 0);
    const second = await fetch(server.url + '/api/cash-entry', {
      method: 'POST',
      headers,
      body: JSON.stringify(payment('extra', 1)),
    });
    assert.equal(second.status, 400);
  } finally {
    dom.window.close();
    await server?.close();
    await pg.close();
    t.mock.timers.reset();
  }
});
