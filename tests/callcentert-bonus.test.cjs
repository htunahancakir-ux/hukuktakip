const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { parsers } = require('prettier/plugins/babel');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const { calculateCallcenterBonus, callcenterUnit } = require('../outputs/icrapro/personnel-bonus.cjs');
const { monthlyPayrollRows } = require('../outputs/icrapro/payroll-periods.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { refreshPayroll } = require('../lib/record-store/payroll.cjs');

const payment = (id, amount, date = '2026-11-18', extra = {}) => ({
  type: 'payment',
  date,
  amount,
  turnoverStaffId: id,
  ...extra,
});
function sample(own = 30000000, temlik = 20000000) {
  const s = fixture();
  s.data['icrapro-personnel-v1'] = [
    {
      id: 't',
      name: 'T Personel',
      department: 'Call Center-T',
      active: true,
      officialSalary: 30000,
      unofficialSalary: 0,
      bonus: 999,
    },
  ];
  s.data['hanhukuk-finance-v1'] = [payment('t', own), payment('turnover:temlik-reddiyat', temlik)];
  return s;
}

test('T monthly quota includes Temlik once, while only own collections earn 4 percent', () => {
  for (const [own, temlik, expected] of [
    [30000000, 19999999, 0],
    [30000000, 20000000, 1200000],
    [50000000, 0, 2000000],
    [50000001, 10000000, 2000000],
    [0, 50000000, 0],
    [0, 0, 0],
  ]) {
    const s = sample(own, temlik),
      before = structuredClone(s);
    const row = calculateCallcenterBonus(s, '2026-11')[0];
    assert.equal(row.collected, own);
    assert.equal(row.temlikCollected, temlik);
    assert.equal(row.quotaCollected, own + temlik);
    assert.equal(row.total, expected);
    assert.equal(row.rate, own + temlik >= 50000000 ? 4 : 0);
    assert.equal(row.targetBonus + row.teamBonus + row.firstHalfBonus + row.secondHalfBonus, 0);
    assert.equal(monthlyPayrollRows(s, '2026-11')[0].bonus2, expected, 'No manual bonus fallback');
    assert.deepEqual(s, before, 'Calculation does not mutate records');
  }
});

test('Only same-month valid payments qualify; legacy category attribution and personnel aliases are retained', () => {
  const s = sample(30000000, 0);
  s.data['icrapro-personnel-v1'][0].department = 'Temlik';
  s.data['icrapro-personnel-v1'].push({
    id: 'old-category',
    name: 'TEMLİK REDDİYAT',
    department: 'Call Center-T',
  });
  s.data['icrapro-v1'].docs = [{ id: 'fallback', relatedStaff: 't' }];
  s.data['hanhukuk-finance-v1'].push(
    payment('old-category', 10000000),
    payment('deleted-category', 8000000, '2026-11-18', { turnoverStaffName: 'Temlik Reddiyat' }),
    payment('', 1000000, '2026-11-18', { collectionStaffId: 'turnover:temlik-reddiyat' }),
    payment('turnover:temlik-reddiyat', 1000000, '2026-11-18', { collectionStaffId: 't' }),
    payment('turnover:hukuk-reddiyat', 99000000, '2026-11-18', { turnoverStaffName: 'Temlik Reddiyat' }),
    payment('turnover:bonus', 99000000),
    payment('turnover:temlik-reddiyat', 99000000, '2026-10-18'),
    payment('turnover:temlik-reddiyat', 99000000, '2026-12-18'),
    payment('turnover:temlik-reddiyat', 99000000, '2026-11-18', { type: 'expense' }),
    payment('turnover:temlik-reddiyat', -50000000),
    payment('turnover:temlik-reddiyat', 0.5),
    payment('', 100, '2026-11-18', { documentId: 'fallback' }),
  );
  const rows = calculateCallcenterBonus(s, '2026-11');
  assert.equal(rows.length, 1, 'Category accounts never receive personnel bonuses');
  assert.equal(rows[0].temlikCollected, 20000000);
  assert.equal(rows[0].collected, 30000100);
  assert.equal(rows[0].total, 1200004);
  for (const name of ['Call Center-T', 'CALL CENTER T', 'Callcenter-t', 'Temlik'])
    assert.equal(callcenterUnit({ department: name }), 'callcentert');
});

test('Each T employee reaches their own combined quota; Temlik never changes E, Y or other team rules', () => {
  const s = sample();
  for (const [id, department] of [
    ['t2', 'Call Center-T'],
    ['e', 'Call Center-E'],
    ['y', 'Call Center-Y'],
    ['c', 'Callcenter'],
  ]) {
    s.data['icrapro-personnel-v1'].push({ id, name: id, department, active: true });
    s.data['hanhukuk-finance-v1'].push(payment(id, 29999999));
  }
  const byId = new Map(calculateCallcenterBonus(s, '2026-11').map((r) => [r.staffId, r]));
  assert.equal(byId.get('t').total, 1200000);
  assert.equal(byId.get('t2').total, 0, 'Another T employee cannot borrow personal turnover');
  for (const id of ['e', 'y', 'c']) assert.equal(byId.get(id).total, 0);
});

test('Prim 2 renders own collections, Temlik support and combined quota separately', (t) => {
  const dom = new JSDOM('<div id="personnelView"></div>', { runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const w = dom.window;
  Object.assign(w, {
    $: (q) => w.document.querySelector(q),
    bonus2Month: '2026-11',
    businessDate: () => '2026-11-18',
    money: (n) => String(n),
    esc: (s) => String(s),
    loadCalculatedBonus2: () => ({ month: '2026-11', rows: calculateCallcenterBonus(sample(), '2026-11') }),
    personnelOtherBonusMarkup: () => '',
    personnelMarketingBonusMarkup: () => '',
    personnelLawyerBonusMarkup: () => '',
  });
  const source = fs.readFileSync('outputs/icrapro/personnel.js', 'utf8');
  const view = parsers.babel
    .parse(source)
    .program.body.find((n) => n.type === 'FunctionDeclaration' && n.id.name === 'personnelBonus2View');
  w.eval(source.slice(view.start, view.end));
  w.personnelBonus2View();
  const row = w.document.querySelector('tbody tr');
  assert.match(row.cells[1].textContent, /300000/);
  assert.match(row.cells[1].textContent, /Temlik Reddiyat: 200000/);
  assert.match(row.cells[1].textContent, /Kota toplamı: 500000/);
  assert.equal(row.cells[2].textContent, '%4');
  assert.equal(row.cells[8].textContent, '12000');
});

for (const records of [false, true])
  test('API and payroll preserve T earnings and closed history: records=' + records, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-18T10:00:00Z') });
    const { pg, pool } = await database();
    let server;
    try {
      const s = sample(30000000, 10000000);
      s.data['icrapro-personnel-v1'].push({
        id: 'legacy-category',
        name: 'Temlik Reddiyat',
        department: 'Diğer',
        active: false,
      });
      s.data['hanhukuk-finance-v1'].push(
        payment('legacy-category', 6000000),
        payment('removed-category', 4000000, '2026-11-18', { turnoverStaffName: 'TEMLİK REDDİYAT' }),
      );
      s.data['icrapro-v1'].clients = [{ id: 'c', name: 'Test Client' }];
      s.data['hanhukuk-finance-v1'].forEach((e, i) => {
        e.id = 'event-' + i;
        e.documentId = 'doc-' + i;
        s.data['icrapro-v1'].docs.push({
          id: e.documentId,
          number: String(i + 1),
          client: 'c',
          amount: 1000000,
          status: 'Derdest',
          docType: 'Senet',
        });
      });
      await importState(pool, s);
      if (records) {
        await importRecords(pool);
        await activateRecords(pool);
      }
      const store = createStore(pool, { records });
      server = await serve(require('../lib/application.cjs').createApplication({ store }));
      const login = await fetch(server.url + '/api/login', {
        method: 'POST',
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'test', password }),
      });
      assert.equal(login.status, 200);
      const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
      const bonus = await fetch(server.url + '/api/bonus2?month=2026-11', { headers });
      assert.equal(bonus.status, 200);
      const row = (await bonus.json()).rows.find((r) => r.staffId === 't');
      assert.equal(row.total, 1200000);
      assert.equal(row.temlikCollected, 20000000);
      assert.equal(row.quotaCollected, 50000000);
      if (records) {
        await refreshPayroll(pool, '2026-11-18');
        await refreshPayroll(pool, '2026-11-18');
        let saved = await store.readState();
        const accruals = saved.personnelLedger.accruals.filter(
          (r) => r.staffId === 't' && r.kind === 'bonus2',
        );
        assert.equal(accruals.length, 1);
        assert.equal(accruals[0].amount, 1200000);
        assert.equal(saved.payrollPeriods['2026-11'].rows.find((r) => r.staffId === 't').bonus2, 1200000);
        await refreshPayroll(pool, '2026-12-01');
        saved = await store.readState();
        assert.equal(saved.payrollPeriods['2026-11'].rows.find((r) => r.staffId === 't').bonus2, 1200000);
        assert.equal(saved.payrollPeriods['2026-12'].rows.find((r) => r.staffId === 't').bonus2, 0);
      }
    } finally {
      await server?.close();
      await pg.close();
    }
  });
