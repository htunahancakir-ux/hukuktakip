const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createApplication } = require('../lib/application.cjs');
const { reportPage, reportExport, insReport } = require('../lib/record-store/reports.cjs');
const definitions = require('../outputs/icrapro/report-definitions.js');
const { businessDate } = require('../lib/business-time.cjs');
const { balance } = require('../lib/record-store/balances.cjs');
const { recognizedCollectionRevenue } = require('../outputs/icrapro/profit-rules.js');
const { parsers } = require('prettier/plugins/babel');
function legacy(state) {
  const context = vm.createContext({
    db: state.data['icrapro-v1'],
    personnel: state.data['icrapro-personnel-v1'],
    financeEvents: state.data['hanhukuk-finance-v1'],
    accounting: state.data['hanhukuk-accounting-v1'],
    businessDate,
    recognizedCollectionRevenue,
    financeCents: (v) => Math.round(Number(v || 0) * 100),
    calculatedBonus2: new Map(),
    debtorStatus: (d) => (['Derdest', 'İnfaz', 'İade', 'İcra'].includes(d.status) ? d.status : 'Derdest'),
    docType: (d) => d.docType || 'Senet',
    displayDate: (d) => (d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '—'),
    normalizeSearch: (s) =>
      String(s || '')
        .toLocaleLowerCase('tr')
        .replace(/ı/g, 'i')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, ''),
  });
  for (const file of [
    'workspace-reports.js',
    'workspace-accounting.js',
    'finance-operations.js',
    'personnel.js',
    'document-records.js',
  ]) {
    const s = fs.readFileSync('outputs/icrapro/' + file, 'utf8');
    const code = parsers.babel
      .parse(s)
      .program.body.filter((n) => n.type === 'FunctionDeclaration')
      .map((n) => s.slice(n.start, n.end))
      .join('\n');
    vm.runInContext(code, context);
  }
  context.docFinance = (d) => {
    const b = balance(d, context.financeEvents, businessDate());
    return {
      principal: Number(b.principal_cents),
      target: Number(b.target_cents),
      received: Number(b.received_cents),
      remaining: Number(b.remaining_cents),
    };
  };
  return context;
}
function comparable(rows, type) {
  return Array.from(rows, (r) => [
    r.date || '',
    r.clientId || '',
    r.staffId || '',
    r.status || '',
    r.accountId || '',
    ...definitions[type].columns.map(([k, , format]) =>
      format === 'money' ? String(r.cells[k] || 0) : String(r.cells[k] ?? '—'),
    ),
  ])
    .map((r) => JSON.stringify(r))
    .sort();
}
test('Cloud exports reject oversized files before headers and close the export cursor', async () => {
  let closed = false;
  const server = await serve(
    createApplication({
      cloud: true,
      appOrigin: 'https://local-test.invalid',
      store: {
        recordQueries: {
          reportExport: async () => ({
            format: 'csv',
            filename: 'test.csv',
            chunks: (async function* () {
              try {
                for (let i = 0; i < 5; i++) yield 'x'.repeat(1024 * 1024);
              } finally {
                closed = true;
              }
            })(),
          }),
        },
      },
    }),
  );
  try {
    const response = await fetch(server.url + '/api/records/reports/export');
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('content-disposition'), null);
    assert.match((await response.json()).error, /seçimi daralt/);
    assert.equal(closed, true);
  } finally {
    await server.close();
  }
});
test('All report types match established calculations; pages, totals and streaming exports stay complete and private', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture(),
      today = businessDate(),
      old = '2026-01-01',
      attack = '<img src=x onerror=alert(1)>';
    state.data['icrapro-personnel-v1'] = [
      {
        id: 'p',
        name: 'IŞIK',
        active: true,
        department: 'Takip',
        officialSalary: 100,
        unofficialSalary: 20,
        bonus: 10,
      },
      { id: 'q', name: 'İpek', active: false, officialSalary: 90, bonus: 0 },
    ];
    const clients = Array.from({ length: 65 }, (_, i) => ({
      id: 'c' + i,
      name: 'Müvekkil ' + i,
      type: 'Şahıs',
      createdAt: old,
      identity: '100000000' + String(i).padStart(2, '0'),
      notes: 'PRIVATE CLIENT NOTES',
      attachments: [{ data: 'PRIVATE FILE DATA' }],
    }));
    clients[0].name = 'IŞIK %_ ' + attack;
    clients[0].createdAt = 'not-a-date';
    const docs = Array.from({ length: 123 }, (_, i) => ({
      id: 'd' + String(i).padStart(3, '0'),
      number: 'R-' + i,
      client: 'c' + (i % 65),
      relatedStaff: 'p',
      debtor: 'Borçlu ' + i,
      amount: 100,
      docType: 'Senet',
      status: 'Derdest',
      created: i === 0 ? 'invalid' : old,
      notes: 'PRIVATE DOCUMENT NOTES',
      fileData: 'data:application/pdf;base64,UFJJVkFURQ==',
    }));
    docs[0].status = 'İnfaz';
    docs[0].amount = 50;
    docs[0].created = '2026-01-01T22:30:00Z';
    docs[0].clientPaidAmount = 5;
    docs[1].status = 'İade';
    docs[2].docType = 'Yediemin Park Ücreti';
    docs[2].status = 'İnfaz';
    docs[2].parkingCommissionRate = 25;
    docs[2].amount = 200;
    docs[3].repaymentPlan = {
      receivedAtCreation: 1000,
      method: 'equal',
      installments: [
        { due: old, amount: 10000 },
        { due: today, amount: 10000 },
        { due: '2099-01-01', amount: 10000 },
      ],
    };
    docs[3].guarantors = [{ name: '=evil', identity: '12345678901', phone: '555', createdAt: old }];
    docs[3].discountHistory = [{ date: old, before: 30000, amount: 5000, after: 25000, reason: attack }];
    docs[3].conversations = [
      { id: 'call', date: old, time: '10:00', staff: 'p', result: 'Raporlandı', note: attack },
    ];
    docs[4].relatedStaff = 'q';
    docs[4].created = '';
    docs[5].created = '2026-01-01T21:00:00Z';
    state.data['icrapro-v1'] = { clients, docs };
    const events = [
      { id: 'e1', documentId: docs[0].id, type: 'payment', amount: 3000, date: old, collectionStaffId: 'p' },
      {
        id: 'e2',
        documentId: docs[0].id,
        type: 'payment',
        amount: 4000,
        date: today,
        closes: true,
        closedAmount: 7000,
        principalAtCollection: 5000,
        turnoverStaffId: 'q',
      },
      { id: 'e3', documentId: docs[1].id, type: 'payment', amount: 1000, date: today },
      { id: 'e4', documentId: docs[2].id, type: 'payment', amount: 20000, date: today, closes: true },
      { id: 'e5', documentId: docs[3].id, type: 'payment', amount: 16000, date: today },
      { id: 'e6', documentId: docs[0].id, type: 'expense', amount: 500, date: old, operatorId: 'p' },
      { id: 'e7', documentId: docs[0].id, type: 'costOnly', amount: 200, date: today, operatorId: 'p' },
    ].map((e) => ({ ...e, accountId: 'cash', note: attack }));
    state.data['hanhukuk-finance-v1'] = events;
    state.data['hanhukuk-accounting-v1'] = {
      accounts: [
        { id: 'cash', name: 'Kasa' },
        { id: 'bank', name: 'Banka' },
      ],
      excludedFinanceIds: ['e6'],
      entries: [
        { id: 'l1', type: 'clientPayout', documentId: docs[0].id, amount: 1200 },
        { id: 'l2', type: 'out', amount: 1000, expenseCategory: 'Ofis' },
        { id: 'l3', type: 'transfer', amount: 2000, destination: 'bank' },
        { id: 'l4', type: 'in', amount: 3000, entryKind: 'external', includeInProfit: true },
        { id: 'l5', type: 'out', amount: 500, financeEventId: 'e6' },
      ].map((e) => ({ ...e, accountId: 'cash', date: today, operatorId: 'p', note: attack })),
    };
    state.users.push({ ...state.users[0], id: 'staff', username: 'staff', role: 'staff', permissions: [] });
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,'test-ceo','desktop',$2)",
      [crypto.createHash('sha256').update(token).digest('hex'), Date.now() + 600000],
    );
    const req = { headers: { cookie: 'han_session=' + token } },
      oldCode = legacy(structuredClone(state));
    const before = await pool.query('SELECT id,body,revision FROM han_data.documents ORDER BY id');
    for (const type of Object.keys(definitions).filter((t) => t !== 'clientList')) {
      const expected = oldCode.reportRows(type),
        pages = [];
      let next = '',
        first;
      do {
        const result = await reportPage(pool, req, { type, after: next });
        first ??= result;
        pages.push(...result.items);
        next = result.next;
        assert.equal(result.count, String(expected.length), type + ' count');
        assert.deepEqual(result.totals, first.totals, type + ' global totals');
        assert(result.items.length <= 50);
      } while (next);
      assert.deepEqual(comparable(pages, type), comparable(expected, type), type + ' parity');
      for (const [key, , format] of definitions[type].columns)
        if (format === 'money')
          assert.equal(
            first.totals[key],
            String(expected.reduce((s, r) => s + Number(r.cells[key] || 0), 0)),
            type + ' ' + key,
          );
      const range = { type, from: today, to: today, undated: false, staff: 'q' };
      const filtered = await reportPage(pool, req, range);
      assert.deepEqual(
        comparable(filtered.items, type),
        comparable(oldCode.filterReportRows(expected, range), type),
        type + ' filtered parity',
      );
    }
    const first = await reportPage(pool, req, { type: 'documents' });
    await assert.rejects(
      reportPage(pool, req, { type: 'documents', after: first.next, query: 'changed' }),
      (e) => e.status === 400,
    );
    await assert.rejects(
      reportPage(pool, req, { type: 'documents', after: 'invalid' }),
      (e) => e.status === 400,
    );
    for (const invalid of [
      { type: '__proto__' },
      { type: "finance'; DROP TABLE x;--" },
      { from: '2026-13-01' },
      { from: '2026-02-28', to: '2026-01-01' },
      { limit: 10000 },
      { undated: 'yes' },
    ])
      await assert.rejects(reportPage(pool, req, invalid), (e) => e.status === 400);
    assert.equal((await reportPage(pool, req, { type: 'documents', query: "' OR 1=1--" })).count, '0');
    assert.equal((await reportPage(pool, req, { type: 'documents', query: 'ışık %_' })).count, '2');
    const clientList = await reportPage(pool, req, { type: 'clientList' });
    assert.equal(clientList.count, '65');
    assert.equal(clientList.items.length, 50);
    const ins = await insReport(pool, req, { from: old, to: today });
    const expectedIns = oldCode.insPersonnelRows(
      events,
      state.data['icrapro-personnel-v1'],
      docs,
      'day',
      old,
      today,
    );
    assert.deepEqual(
      ins.rows.map((r) => [r.id, r.name, r.collected, r.closedCount, r.closedAmount]).sort(),
      Array.from(expectedIns, (r) => [
        r.id,
        r.name,
        String(r.collected),
        String(r.closedCount),
        String(r.closedAmount),
      ]).sort(),
    );
    const collect = async (type) => {
      const output = await reportExport(pool, req, type);
      let s = '';
      for await (const chunk of output.chunks) s += chunk;
      return s;
    };
    const csv = await collect({ type: 'documents', format: 'csv' });
    assert.equal(csv.split('\r\n').length, 125);
    assert(!csv.includes('PRIVATE'));
    assert(csv.includes('R-122'));
    const html = await collect({ type: 'calls', format: 'html' });
    assert(html.includes('&lt;img'));
    assert(!html.includes('<img'));
    assert((await collect({ type: 'guarantors', format: 'csv' })).includes("'=evil"));
    const canceled = await reportExport(pool, req, { type: 'documents' });
    for await (const chunk of canceled.chunks) {
      assert(chunk);
      break;
    }
    assert.equal(
      (await pool.query('SELECT 1 AS ok')).rows[0].ok,
      1,
      'canceled export releases its connection',
    );
    server = await serve(createApplication({ store: createStore(pool, { records: true }) }));
    assert.equal((await fetch(server.url + '/api/records/reports')).status, 401);
    const login = await fetch(server.url + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Han-Request': '1' },
      body: JSON.stringify({ username: 'staff', password }),
    });
    assert.equal(login.status, 200, await login.text());
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const api = await fetch(server.url + '/api/records/reports?type=documents', { headers: { cookie } });
    assert.equal(api.status, 200);
    assert.equal((await api.json()).count, '123');
    const download = await fetch(server.url + '/api/records/reports/export?type=documents', {
      headers: { cookie },
    });
    assert.equal(download.status, 200);
    assert(download.headers.get('content-type').includes('text/csv'));
    assert((await download.text()).includes('R-122'));
    assert.deepEqual(
      (await pool.query('SELECT id,body,revision FROM han_data.documents ORDER BY id')).rows,
      before.rows,
      'reports never rewrite business records',
    );
  } finally {
    if (server) await server.close();
    await pg.close();
  }
});
