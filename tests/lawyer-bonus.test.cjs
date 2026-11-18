const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { parsers } = require('prettier/plugins/babel');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const { calculateLawyerBonus, isLawyer } = require('../outputs/icrapro/lawyer-bonus.cjs');
const { monthlyPayrollRows } = require('../outputs/icrapro/payroll-periods.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { refreshPayroll } = require('../lib/record-store/payroll.cjs');
function sample() {
  const s = fixture();
  s.data['icrapro-personnel-v1'] = [
    {
      id: 'lawyer',
      name: 'Avukat <img src=x>',
      department: 'AVUKAT',
      active: true,
      officialSalary: 30000,
      unofficialSalary: 1000,
      bonus: 999,
    },
    {
      id: 'lawyer2',
      name: 'İkinci Avukat',
      department: 'Avukat',
      active: true,
      officialSalary: 30000,
      unofficialSalary: 1000,
    },
    { id: 'inactive', name: 'Eski Avukat', department: 'Avukat', active: false },
    {
      id: 'cc',
      name: 'Call Center',
      department: 'Call Center-E',
      active: true,
      officialSalary: 30000,
      unofficialSalary: 1000,
    },
  ];
  s.data['icrapro-v1'].clients = [{ id: 'c', name: 'Test Client' }];
  s.data['icrapro-v1'].docs = [
    { id: 'd', number: '1', client: 'c', amount: 2000000, status: 'Derdest', docType: 'Senet' },
  ];
  s.data['hanhukuk-finance-v1'] = [
    ['cc', 30000000],
    ['turnover:temlik-reddiyat', 20000000],
    ['', 40000000],
    ['lawyer', 10000000],
  ].map(([id, amount], i) => ({
    id: 'payment-' + i,
    type: 'payment',
    date: '2026-11-18',
    documentId: 'd',
    turnoverStaffId: id,
    amount,
  }));
  return s;
}

test('Each active lawyer earns a separate 1 percent of all monthly office collections, without quota or personal attribution', () => {
  const s = sample(),
    before = structuredClone(s);
  s.data['hanhukuk-finance-v1'].push(
    { type: 'payment', date: '2026-10-18', amount: 99000000 },
    { type: 'payment', date: '2026-12-18', amount: 99000000 },
    { type: 'expense', date: '2026-11-18', amount: 99000000 },
    { type: 'payment', date: '2026-11-18', amount: -10000 },
  );
  const rows = calculateLawyerBonus(s, '2026-11');
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.officeCollected, 100000000);
    assert.equal(row.rate, 1);
    assert.equal(row.total, 1000000, 'The 1 percent is not divided between lawyers');
  }
  const payroll = monthlyPayrollRows(s, '2026-11').find((r) => r.staffId === 'lawyer');
  assert.equal(payroll.salary, 3000000);
  assert.equal(payroll.bonus1, 100000);
  assert.equal(payroll.bonus2, 1000000, 'Automatic bonus replaces manual fallback');
  assert.deepEqual(s.data['icrapro-personnel-v1'], before.data['icrapro-personnel-v1']);
  assert.equal(calculateLawyerBonus(s, '2027-01')[0].total, 0);
  for (const name of ['AVUKAT', 'Avukat', ' avukat ']) assert(isLawyer({ department: name }));
  assert(!isLawyer({ department: 'İcra' }));
});

test('Small collections earn a bonus with cent rounding; unsafe amounts and invalid months are rejected', () => {
  const s = sample();
  for (const [amount, expected] of [
    [100, 1],
    [49, 0],
    [50, 1],
    [0, 0],
  ]) {
    s.data['hanhukuk-finance-v1'] = [{ type: 'payment', date: '2026-11-18', amount }];
    assert.equal(calculateLawyerBonus(s, '2026-11')[0].total, expected);
  }
  assert.throws(() => calculateLawyerBonus(s, '2026-13'));
  s.data['hanhukuk-finance-v1'][0].amount = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => calculateLawyerBonus(s, '2026-11'));
});

test('Prim 2 shows a separate lawyer section with office turnover, one percent and escaped personnel names', (t) => {
  const dom = new JSDOM('<div id="personnelView"></div>', { runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.eval(fs.readFileSync('outputs/icrapro/html-safety.js', 'utf8'));
  Object.assign(w, {
    $: (q) => w.document.querySelector(q),
    bonus2Month: '2026-11',
    businessDate: () => '2026-11-18',
    money: (n) => String(n),
    esc: w.escapeHtml,
    loadCalculatedBonus2: () => ({ month: '2026-11', rows: calculateLawyerBonus(sample(), '2026-11') }),
    personnelOtherBonusMarkup: () => '',
    personnelMarketingBonusMarkup: () => '',
  });
  const source = fs.readFileSync('outputs/icrapro/personnel.js', 'utf8');
  for (const node of parsers.babel.parse(source).program.body)
    if (
      node.type === 'FunctionDeclaration' &&
      ['personnelBonus2View', 'personnelLawyerBonusMarkup'].includes(node.id.name)
    )
      w.eval(source.slice(node.start, node.end));
  w.personnelBonus2View();
  const section = w.document.querySelector('section');
  assert.match(section.textContent, /Avukat · Prim 2/);
  assert.equal(section.querySelectorAll('tbody tr').length, 2);
  assert.equal(section.querySelectorAll('img').length, 0);
  assert.equal(section.querySelector('tbody tr').cells[1].textContent, '1000000');
  assert.equal(section.querySelector('tbody tr').cells[3].textContent, '10000');
  assert.equal(section.querySelector('tfoot td:last-child').textContent, '20000');
});

for (const records of [false, true])
  test('Lawyer bonus agrees across API, payroll report and ledger: records=' + records, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-18T10:00:00Z') });
    const { pg, pool } = await database();
    let server;
    try {
      const s = sample();
      s.users.push({
        ...s.users[0],
        id: 'lawyer-user',
        username: 'lawyer',
        role: 'staff',
        staffId: 'lawyer',
      });
      await importState(pool, s);
      if (records) {
        await importRecords(pool);
        await activateRecords(pool);
      }
      const store = createStore(pool, { records });
      server = await serve(require('../lib/application.cjs').createApplication({ store }));
      const login = async (username) => {
        const r = await fetch(server.url + '/api/login', {
          method: 'POST',
          headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        assert.equal(r.status, 200);
        return {
          cookie: r.headers.get('set-cookie').split(';')[0],
          'X-Han-Request': '1',
          'Content-Type': 'application/json',
        };
      };
      const headers = await login('test');
      const response = await fetch(server.url + '/api/bonus2?month=2026-11', { headers });
      assert.equal(response.status, 200);
      const row = (await response.json()).rows.find((r) => r.staffId === 'lawyer');
      assert.equal(row.total, 1000000);
      assert.equal(row.officeCollected, 100000000);
      const own = await fetch(server.url + '/api/bonus2?month=2026-11', { headers: await login('lawyer') });
      assert.equal(own.status, 200);
      assert.deepEqual(await own.json(), { month: '2026-11', total: 1000000 });
      const manual = await fetch(server.url + '/api/personnel-payroll', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          staffId: 'lawyer',
          officialSalary: 30000,
          unofficialSalary: 1000,
          bonus: 500000,
        }),
      });
      assert.equal(manual.status, 200);
      assert.equal(
        (await manual.json()).record.bonus,
        999,
        'Manual input cannot replace the automatic lawyer bonus',
      );
      if (records) {
        await refreshPayroll(pool, '2026-11-18');
        await refreshPayroll(pool, '2026-11-18');
        let saved = await store.readState();
        const accruals = saved.personnelLedger.accruals.filter(
          (r) => r.staffId === 'lawyer' && r.kind === 'bonus2',
        );
        assert.equal(accruals.length, 1);
        assert.equal(accruals[0].amount, 1000000);
        const report = await fetch(server.url + '/api/payroll-report?month=2026-11', { headers });
        assert.equal(report.status, 200);
        assert.equal((await report.json()).rows.find((r) => r.staffId === 'lawyer').bonus2, 1000000);
        await refreshPayroll(pool, '2026-12-01');
        saved = await store.readState();
        assert.equal(
          saved.payrollPeriods['2026-11'].rows.find((r) => r.staffId === 'lawyer').bonus2,
          1000000,
        );
        assert.equal(saved.payrollPeriods['2026-12'].rows.find((r) => r.staffId === 'lawyer').bonus2, 0);
      }
    } finally {
      await server?.close();
      await pg.close();
    }
  });
