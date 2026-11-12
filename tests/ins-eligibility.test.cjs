const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm'),
  crypto = require('node:crypto');
const { database, fixture } = require('./support/postgres.cjs');
const { importState } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { insReport } = require('../lib/record-store/reports.cjs');
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
