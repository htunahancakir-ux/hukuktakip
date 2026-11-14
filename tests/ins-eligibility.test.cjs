const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm'),
  crypto = require('node:crypto');
const { database, fixture } = require('./support/postgres.cjs');
const { importState } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { insReport } = require('../lib/record-store/reports.cjs');

test('INS ranks each chart by its own descending metric while table sorting and totals remain independent', async (t) => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="content"></div>', {
    url: 'https://local-test.invalid',
    runScripts: 'dangerously',
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  const rows = [
    { id: 'b', name: 'Bora', collected: '10000', closedCount: '3', closedAmount: '10000' },
    { id: 'c', name: 'Cem', collected: '20000', closedCount: '2', closedAmount: '90000' },
    { id: 'a', name: 'Ali', collected: '30000', closedCount: '1', closedAmount: '20000' },
    { id: 'bonus', name: 'Bonus', collected: '0', closedCount: '0', closedAmount: '0' },
  ];
  Object.assign(w, {
    AbortController,
    page: 'reports',
    hanRecordsEnabled: true,
    insDate: '2026-11-13',
    insEndDate: '2026-11-13',
    insSort: 'collected',
    insPeriod: 'day',
    $: (s) => w.document.querySelector(s),
    esc: (s) => String(s),
    money: (n) => String(n),
    displayDate: (s) => s,
    businessDate: () => '2026-11-13',
    field: (label, name, type, value) =>
      `<label>${label}<input name="${name}" type="${type}" value="${value}"></label>`,
    fetch: async () => ({ ok: true, json: async () => ({ rows }) }),
  });
  w.eval(
    ['workspace-reports.js', 'workspace-report-records.js']
      .map((file) => fs.readFileSync('outputs/icrapro/' + file, 'utf8'))
      .join('\n'),
  );
  const tableNames = () => [...w.document.querySelectorAll('tbody tr')].map((r) => r.cells[0].textContent);
  const chartNames = () =>
    [...w.document.querySelectorAll('.ins-chart')].map((c) =>
      [...c.querySelectorAll('.ins-chart-row>span')].map((s) => s.textContent),
    );
  const expectedCharts = [
    ['Ali', 'Cem', 'Bora', 'Bonus'],
    ['Bora', 'Cem', 'Ali', 'Bonus'],
    ['Cem', 'Ali', 'Bora', 'Bonus'],
  ];
  await w.insReportPage();
  assert.deepEqual(tableNames(), expectedCharts[0]);
  assert.deepEqual(chartNames(), expectedCharts);
  const totals = w.document.querySelector('tfoot').textContent;
  for (const [metric, order] of [
    ['closedCount', expectedCharts[1]],
    ['closedAmount', expectedCharts[2]],
  ]) {
    const select = w.document.getElementById('insSort');
    select.value = metric;
    select.dispatchEvent(new w.Event('change'));
    for (let i = 0; i < 6; i++) await new Promise(setImmediate);
    assert.deepEqual(tableNames(), order);
    assert.deepEqual(chartNames(), expectedCharts, 'changing table sort never disturbs the other rankings');
    assert.equal(w.document.querySelector('tfoot').textContent, totals);
  }
  const local = Object.freeze(
    rows.map((r) =>
      Object.freeze({
        ...r,
        collected: Number(r.collected),
        closedCount: Number(r.closedCount),
        closedAmount: Number(r.closedAmount),
      }),
    ),
  );
  w.renderInsReportPage(local);
  assert.deepEqual(chartNames(), expectedCharts, 'local preview shares the same descending chart order');
  assert.deepEqual(
    rows.map((r) => r.id),
    ['b', 'c', 'a', 'bonus'],
  );
});
test('INS includes every callcenter unit and only the three existing categories, retaining legacy category collections', async () => {
  const { pg, pool } = await database();
  try {
    const s = fixture();
    s.data['icrapro-personnel-v1'] = [
      { id: 'cc', name: 'Call Center', department: 'Callcenter' },
      { id: 'y', name: 'Y Personel', department: 'Call Center-Y' },
      { id: 'e', name: 'E Personel', department: 'Call Center-E' },
      { id: 'admin', name: 'Yönetici', department: 'Yönetici' },
      { id: 'marketing', name: 'Pazarlama', department: 'Pazarlama' },
      { id: 'other', name: 'Başka Personel', department: 'Diğer' },
      { id: 'legacy', name: 'HUKUK REDDIYAT', department: 'Diğer' },
    ].map((p) => ({ ...p, active: true }));
    s.data['icrapro-v1'].clients = [{ id: 'c', name: 'Müvekkil' }];
    const ids = [
      'cc',
      'y',
      'e',
      'admin',
      'marketing',
      'other',
      'legacy',
      'turnover:bonus',
      'turnover:temlik-reddiyat',
      'unassigned',
    ];
    s.data['icrapro-v1'].docs = ids.map((id, i) => ({
      id: 'd' + i,
      number: 'D-' + i,
      client: 'c',
      amount: 100,
    }));
    s.data['hanhukuk-finance-v1'] = ids.map((id, i) => ({
      id: 'p' + i,
      documentId: 'd' + i,
      type: 'payment',
      turnoverStaffId: id,
      amount: 1000,
      date: '2026-11-12',
      closes: true,
      closedAmount: 1000,
    }));
    await importState(pool, s);
    await importRecords(pool);
    await activateRecords(pool);
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,'test-ceo','desktop',$2)",
      [crypto.createHash('sha256').update(token).digest('hex'), Date.now() + 600000],
    );
    const sql = await insReport(
      pool,
      { headers: { cookie: 'han_session=' + token } },
      { from: '2026-11-12', to: '2026-11-12' },
    );
    assert.deepEqual(
      sql.rows.map((r) => r.id).sort(),
      ['cc', 'y', 'e', 'turnover:bonus', 'turnover:hukuk-reddiyat', 'turnover:temlik-reddiyat'].sort(),
    );
    assert.equal(
      sql.rows.reduce((sum, r) => sum + Number(r.collected), 0),
      6000,
    );
    assert.equal(sql.rows.find((r) => r.id === 'turnover:hukuk-reddiyat').collected, '1000');
    const source = fs.readFileSync('outputs/icrapro/workspace-reports.js', 'utf8');
    const start = source.indexOf('function insPersonnelRows('),
      end = source.indexOf('function renderInsReportPage(', start);
    const context = {};
    vm.createContext(context);
    vm.runInContext(source.slice(start, end), context);
    const local = context.insPersonnelRows(
      s.data['hanhukuk-finance-v1'],
      s.data['icrapro-personnel-v1'],
      s.data['icrapro-v1'].docs,
      'day',
      '2026-11-12',
      '2026-11-12',
    );
    for (const row of sql.rows) {
      const same = local.find((r) => r.id === row.id);
      assert(same);
      for (const key of ['collected', 'closedCount', 'closedAmount'])
        assert.equal(same[key], Number(row[key]));
    }
    assert.equal(local.length, 6);
  } finally {
    await pg.close();
  }
});
