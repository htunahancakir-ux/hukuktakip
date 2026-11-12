const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const { calculateOtherPersonnelBonus } = require('../outputs/icrapro/other-personnel-bonus.cjs');
const { syncPayrollPeriods } = require('../outputs/icrapro/payroll-periods.cjs');
const { refreshPayroll } = require('../lib/record-store/payroll.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
function sample() {
  const s = fixture();
  s.data['icrapro-personnel-v1'] = [
    {
      id: 'p',
      name: 'Diğer Personel',
      department: 'Diğer',
      active: true,
      officialSalary: 0,
      unofficialSalary: 0,
      bonus: 0,
    },
    { id: 'fake', name: 'BONUS', department: 'Diğer', active: true },
    { id: 'cc', name: 'Call Center', department: 'Callcenter', active: true },
  ];
  s.data['icrapro-v1'].clients = [{ id: 'c', name: 'Müvekkil' }];
  return s;
}
test('Other Prim 2 excludes partial files; all received-file collections earn 12.5% only in the closure month', () => {
  const s = sample();
  s.data['icrapro-v1'].docs = [
    { id: 'closed', receivedById: 'p', status: 'İnfaz', closedDate: '2026-11-12' },
    { id: 'partial', receivedById: 'p', status: 'Derdest' },
    { id: 'old', receivedById: 'p', status: 'İnfaz', closedDate: '2026-10-31' },
    {
      id: 'collector-only',
      receivedById: 'cc',
      relatedStaffId: 'p',
      status: 'İnfaz',
      closedDate: '2026-11-12',
    },
    { id: 'legacy', receivedBy: 'DİĞER-PERSONEL', status: 'İnfaz' },
  ];
  const event = (id, amount, date) => ({
    documentId: id,
    type: 'payment',
    amount,
    date,
    turnoverStaffId: 'p',
  });
  s.data['hanhukuk-finance-v1'] = [
    event('closed', 40000, '2026-10-01'),
    event('closed', 60000, '2026-11-12'),
    event('partial', 50000, '2026-11-12'),
    event('old', 50000, '2026-10-31'),
    event('collector-only', 50000, '2026-11-12'),
    event('legacy', 801, '2026-11-11'),
  ];
  let rows = calculateOtherPersonnelBonus(s, '2026-11', '2026-11-12');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].collected, 100801);
  assert.equal(rows[0].closedCount, 2);
  assert.equal(rows[0].total, 12600);
  assert.equal(calculateOtherPersonnelBonus(s, '2026-10')[0].total, 6250);
  syncPayrollPeriods(s, '2026-11-12');
  syncPayrollPeriods(s, '2026-12-01');
  assert.equal(s.payrollPeriods['2026-11'].rows[0].bonus2, 12600);
  assert.equal(s.payrollPeriods['2026-12'].rows[0].bonus2, 0);
  s.data['icrapro-v1'].docs[0].status = 'Derdest';
  syncPayrollPeriods(s, '2026-12-02');
  assert.equal(s.payrollPeriods['2026-11'].rows[0].bonus2, 12600, 'Closed payroll snapshots stay unchanged');
  assert.equal(
    calculateOtherPersonnelBonus(s, '2026-11')[0].total,
    100,
    'Reopened files are excluded from live calculations',
  );
  s.data['icrapro-personnel-v1'].push({ id: 'duplicate', name: 'Diğer Personel', department: 'İcra' });
  assert.equal(
    calculateOtherPersonnelBonus(s, '2026-11')[0].total,
    0,
    'Ambiguous legacy names cannot award another person',
  );
});
test('Actual manual closure refreshes Other Prim 2 and ledger exactly once; API and SQL agree', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-12T10:00:00Z') });
  const { pg, pool } = await database();
  let server;
  try {
    const s = sample();
    s.users.push({
      ...s.users[0],
      id: 'staff-user',
      username: 'staff',
      role: 'staff',
      staffId: 'p',
      permissions: ['documents'],
    });
    s.data['icrapro-v1'].docs = [
      {
        id: 'd',
        number: 'S-1',
        client: 'c',
        debtor: 'Borçlu',
        amount: 1000,
        docType: 'Senet',
        receivedById: 'p',
        status: 'Derdest',
        financeTermsManual: true,
        financeFee: 100,
        financeInterest: 0,
      },
    ];
    s.data['hanhukuk-accounting-v1'].accounts = [{ id: 'cash', name: 'Kasa' }];
    s.data['hanhukuk-finance-v1'] = [
      { id: 'oct', documentId: 'd', type: 'payment', date: '2026-10-10', amount: 40000, accountId: 'cash' },
      { id: 'nov', documentId: 'd', type: 'payment', date: '2026-11-12', amount: 60000, accountId: 'cash' },
    ];
    await importState(pool, s);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
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
    const bonus = async () => {
      const r = await fetch(server.url + '/api/bonus2?month=2026-11', { headers });
      assert.equal(r.status, 200);
      return (await r.json()).rows.find((p) => p.staffId === 'p');
    };
    assert.equal((await bonus()).total, 0, 'Partial collections do not earn Prim 2');
    const closed = await fetch(server.url + '/api/documents/manual-close', {
      method: 'POST',
      headers,
      body: JSON.stringify({ documentId: 'd', expectedPrincipal: 100000, expectedReceived: 100000 }),
    });
    assert.equal(closed.status, 200, await closed.text());
    const row = await bonus();
    assert.equal(row.total, 12500);
    assert.equal(row.collected, 100000);
    assert.equal(row.closedCount, 1);
    await refreshPayroll(pool, '2026-11-12');
    await refreshPayroll(pool, '2026-11-12');
    let saved = await store.readState();
    assert.equal(saved.payrollPeriods['2026-11'].rows.find((p) => p.staffId === 'p').bonus2, 12500);
    assert.equal(
      saved.personnelLedger.accruals.filter((p) => p.staffId === 'p' && p.kind === 'bonus2').length,
      1,
    );
    assert.equal(
      saved.personnelLedger.accruals.find((p) => p.staffId === 'p' && p.kind === 'bonus2').amount,
      12500,
    );
    assert(
      saved.data['icrapro-personnel-v1'].some((p) => p.id === 'p'),
      'Other personnel remain stored and visible to the roster',
    );
    const own = await fetch(server.url + '/api/bonus2?month=2026-11', { headers: await login('staff') });
    assert.equal(own.status, 200);
    assert.deepEqual(await own.json(), { month: '2026-11', total: 12500 });
    await refreshPayroll(pool, '2026-12-01');
    saved = await store.readState();
    assert.equal(saved.payrollPeriods['2026-11'].rows.find((p) => p.staffId === 'p').bonus2, 12500);
    assert.equal(saved.payrollPeriods['2026-12'].rows.find((p) => p.staffId === 'p').bonus2, 0);
  } finally {
    await server?.close();
    await pg.close();
  }
});
