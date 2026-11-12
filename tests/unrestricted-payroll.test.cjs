const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { database, fixture, serve } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createApplication } = require('../lib/application.cjs');
const { syncPayrollPeriods } = require('../outputs/icrapro/payroll-periods.cjs');
const { validatePayment } = require('../lib/personnel-ledger.cjs');
const people = [
  { id: 'bc62c63e-8a8e-486d-89a9-956fd8355299', name: 'Enes Yıldırım' },
  { id: 'd73b315e-669c-4a83-8061-d5f770641790', name: 'Musa Şeker' },
];
test('Only the two designated managers receive repeated and above-earned salary/advance payments; cash, roles and ledger remain enforced', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 15, 9) });
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    state.users.push({
      ...state.users[0],
      id: 'staff',
      username: 'staff',
      role: 'staff',
      permissions: ['cashOut'],
    });
    state.data['icrapro-personnel-v1'] = [...people, { id: 'lookalike', name: 'Enes Yıldırım' }].map((p) => ({
      ...p,
      department: 'Yönetici',
      active: true,
      officialSalary: 1000,
      unofficialSalary: 0,
      bonus: 0,
    }));
    state.data['hanhukuk-accounting-v1'] = {
      accounts: [{ id: 'cash', name: 'Kasa' }],
      entries: [
        {
          id: 'fund',
          type: 'in',
          accountId: 'cash',
          amount: 10000000,
          date: '2026-11-01',
          note: 'Synthetic funding',
        },
      ],
    };
    syncPayrollPeriods(state, '2026-11-15');
    const payment = (staffId, id, extra = {}) => ({
      id,
      staffId,
      type: 'out',
      accountId: 'cash',
      date: '2026-11-15',
      payrollMonth: '2026-11',
      expenseCategory: 'Maaş Avansı',
      amount: 200000,
      note: 'Synthetic payment',
      ...extra,
    });
    assert.throws(
      () => validatePayment(state, payment('lookalike', 'limited'), state.users[0], '2026-11-15'),
      /%25/,
    );
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
        [crypto.createHash('sha256').update(token).digest('hex'), user.id, Date.now() + 600000],
      );
      headers[user.id] = {
        cookie: 'han_session=' + token,
        'X-Han-Request': '1',
        'Content-Type': 'application/json',
      };
    }
    async function request(path, data, user = 'test-ceo') {
      const res = await fetch(server.url + path, {
        method: data ? 'POST' : 'GET',
        headers: headers[user],
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      return { status: res.status, body: await res.json() };
    }
    for (const person of people) {
      const first = payment(person.id, person.id + '-one');
      for (const value of [
        first,
        first,
        payment(person.id, person.id + '-two'),
        payment(person.id, person.id + '-salary', { expenseCategory: 'Maaş', amount: 300000 }),
      ]) {
        const result = await request('/api/cash-entry', value);
        assert.equal(result.status, 200, JSON.stringify(result.body));
      }
      const data = (await request('/api/records/personnel-ledger?staffId=' + person.id)).body;
      assert.equal(data.paymentUnrestricted, true);
      assert.equal(data.advanceLimit, null);
      assert.equal(data.advanceUsed, true);
      assert.equal(data.months[0].advance, 400000);
      assert.equal(data.months[0].paid, 300000);
      assert.equal(data.months[0].remaining, data.currentEarned - 700000);
      assert(data.balance < 0);
      await checkForms(data, person.id);
    }
    assert.equal(
      (await request('/api/cash-entry', payment(people[0].id, 'unauthorized'), 'staff')).status,
      403,
    );
    const noCash = await request('/api/cash-entry', payment(people[0].id, 'no-cash', { amount: 10000001 }));
    assert.equal(noCash.status, 400);
    assert.match(noCash.body.error, /bakiye/);
    assert.equal(
      (await request('/api/cash-entry', payment(people[0].id, 'zero', { amount: 0 }))).status,
      400,
    );
    assert.equal((await request('/api/cash-entry', payment('lookalike', 'still-limited'))).status, 400);
    const saved = await store.readState();
    const expenses = saved.data['hanhukuk-accounting-v1'].entries.filter((r) => r.type === 'out');
    assert.equal(expenses.length, 6);
    assert.equal(
      expenses.reduce((s, r) => s + r.amount, 0),
      1400000,
    );
  } finally {
    await server?.close();
    await pg.close();
    t.mock.timers.reset();
  }
});
async function checkForms(data, staffId) {
  const { JSDOM } = require('jsdom'),
    fs = require('node:fs');
  const dom = new JSDOM(
    '<div id="ledger"></div><form id="cash"><div class="formbody"></div><select name="type"><option>out</option></select><select name="expenseCategory"><option>Maaş Avansı</option><option>Maaş</option></select><input name="amount" type="number" max="1"></form>',
    { runScripts: 'dangerously' },
  );
  try {
    const w = dom.window;
    Object.assign(w, {
      hanRecordsEnabled: true,
      businessDate: () => '2026-11-15',
      money: String,
      financeCents: Number,
      esc: (v) => String(v ?? ''),
      displayDate: String,
      personnel: people,
      toast() {},
      fetch: async () => ({
        ok: true,
        json: async () => ({ ...data, people, accounts: [{ id: 'cash', name: 'Kasa' }] }),
      }),
    });
    for (const file of ['form-inputs.js', 'workspace-personnel-ledger.js'])
      w.eval(fs.readFileSync('outputs/icrapro/' + file, 'utf8'));
    await w.personnelLedgerPage(w.document.querySelector('#ledger'), staffId);
    const form = w.document.querySelector('.personnel-payment-form');
    assert.equal(form.elements.payrollMonth.value, '2026-11');
    assert.equal(form.elements.amount.hasAttribute('max'), false);
    assert.equal(form.querySelector('[type=submit]').disabled, false);
    assert.match(w.document.querySelector('#ledger').textContent, /Sınırsız/);
    form.elements.mode.value = 'salaryAdvance';
    form.elements.mode.onchange();
    assert.equal(form.elements.mode.selectedOptions[0].disabled, false);
    assert.equal(form.elements.amount.hasAttribute('max'), false);
    const cash = w.document.querySelector('#cash');
    w.setupPayrollCashFields(cash);
    cash.elements.staffId.value = staffId;
    cash.elements.staffId.dispatchEvent(new w.Event('change', { bubbles: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cash.elements.payrollMonth.value, '2026-11');
    assert.equal(cash.elements.amount.hasAttribute('max'), false);
    cash.elements.expenseCategory.value = 'Maaş';
    cash.elements.expenseCategory.dispatchEvent(new w.Event('change', { bubbles: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cash.elements.payrollMonth.value, '2026-11');
    assert.equal(cash.elements.amount.hasAttribute('max'), false);
  } finally {
    dom.window.close();
  }
}
