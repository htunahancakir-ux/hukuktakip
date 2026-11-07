const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, fixture } = require('./support/postgres.cjs');
const { importState } = require('../lib/postgres-store.cjs');
const { inTransaction } = require('../lib/db-transaction.cjs');
const { split, join } = require('../lib/record-store/codec.cjs');
const {
  importRecords,
  exportRecords,
  load,
  writeChanges,
  activateRecords,
  returnToLegacy,
} = require('../lib/record-store/storage.cjs');
const { documentPage, documentDetail } = require('../lib/record-store/queries.cjs');
const { balance } = require('../lib/record-store/balances.cjs');
const crypto = require('node:crypto');
async function session(pool) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at,seen_at) VALUES($1,'test-ceo','desktop',$2,$3)",
    [crypto.createHash('sha256').update(token).digest('hex'), Date.now() + 600000, Date.now()],
  );
  return { headers: { cookie: 'han_session=' + token } };
}
function sample(count = 75) {
  const s = fixture();
  s.data['icrapro-v1'].clients = [
    {
      id: 'c',
      name: 'Sentetik',
      attachments: [{ name: 'test', data: 'data:application/pdf;base64,WA==', custom: 1 }],
    },
  ];
  s.data['icrapro-v1'].docs = Array.from({ length: count }, (_, i) => ({
    id: 'd' + String(i).padStart(5, '0'),
    number: 'T-' + i,
    client: 'c',
    amount: 100,
    status: 'Derdest',
    docType: 'Diğer',
    customUnknown: { x: [1, 2] },
    conversations: [
      { id: 'v', note: 'Aynı kimlik farklı dosyada geçerli', date: '2026-11-01', time: '10:30' },
    ],
    fileData: 'data:application/pdf;base64,WA==',
    photoData: 'data:image/png;base64,WA==',
  }));
  s.data['hanhukuk-accounting-v1'].accounts = [{ id: 'cash', name: 'Kasa' }];
  s.data['hanhukuk-finance-v1'] = [
    { id: 'f', documentId: 'd00000', accountId: 'cash', type: 'payment', amount: 1000, date: '2026-11-01' },
  ];
  s.unknownRoot = { preserve: [1, { a: 'x' }] };
  s.messages = [{ id: 'm', text: 'test', unknown: true }];
  s.staffBreaks = [{ accountId: 'test-ceo', start: '2026-11-01' }];
  s.deletedDocuments = [
    {
      document: {
        id: 'old',
        client: 'c',
        number: 'ARCHIVE',
        conversations: [{ id: 'v', note: 'archive' }],
        fileData: 'unchanged',
      },
      deletedAt: '2026-11-01',
    },
  ];
  return s;
}
test('Record decomposition preserves every field, archive and ordering without mutating source', () => {
  const source = sample(),
    original = structuredClone(source),
    { metadata, rows } = split(source);
  assert.deepEqual(join(metadata, rows), source);
  assert.deepEqual(source, original);
  assert.equal(rows.documents[0].body.fileData, undefined);
  assert.deepEqual(rows.documents[0].body.conversations, []);
  assert.equal(metadata.data['icrapro-v1'].docs.length, 0);
  assert.equal(rows.conversations.length, 76);
});
test('Database import roundtrips unknown fields and refuses overwrite; legacy state remains intact', async () => {
  const { pg, pool } = await database();
  try {
    const source = sample();
    await importState(pool, source);
    const result = await importRecords(pool);
    assert.equal(result.counts.documents, 76);
    assert.deepEqual(await exportRecords(pool), source);
    assert.deepEqual(
      (await pool.query('SELECT payload FROM han_private.han_state WHERE id=1')).rows[0].payload,
      source,
    );
    await assert.rejects(importRecords(pool), /üzerine/);
    const before = await load(pool),
      next = structuredClone(source);
    next.data['icrapro-v1'].docs[0].notes = 'updated';
    await inTransaction(pool, (db) => writeChanges(db, before, next));
    assert.deepEqual(await exportRecords(pool), next);
    const changed = await pool.query('SELECT count(*)::int AS n FROM han_data.documents WHERE revision>1');
    assert.equal(changed.rows[0].n, 1);
    const stale = structuredClone(next);
    stale.data['icrapro-v1'].docs[0].notes = 'stale';
    await assert.rejects(
      inTransaction(pool, (db) => writeChanges(db, before, stale)),
      /başka bir işlem/,
    );
    assert.deepEqual(await exportRecords(pool), next);
  } finally {
    await pg.close();
  }
});
test('Bad references roll back the entire import, including its control flag', async () => {
  const { pg, pool } = await database();
  try {
    const source = sample();
    source.data['icrapro-v1'].docs[0].client = 'missing';
    await importState(pool, source);
    await assert.rejects(importRecords(pool), /foreign key/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM han_data.documents')).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM han_data.control')).rows[0].n, 0);
  } finally {
    await pg.close();
  }
});

test('Historical duplicate display numbers survive import and rollback with distinct identities', async () => {
  const { pg, pool } = await database();
  try {
    const source = sample(2);
    source.data['icrapro-v1'].docs[1].number = source.data['icrapro-v1'].docs[0].number;
    source.deletedDocuments[0].document.number = source.data['icrapro-v1'].docs[0].number;
    await importState(pool, source);
    await importRecords(pool);
    assert.deepEqual(await exportRecords(pool), source);
    await activateRecords(pool);
    await returnToLegacy(pool);
    assert.deepEqual(
      (await pool.query('SELECT payload FROM han_private.han_state WHERE id=1')).rows[0].payload,
      source,
    );
  } finally {
    await pg.close();
  }
});
test('Pagination totals include all 75 records, remain stable on page two, and filters use the same snapshot', async () => {
  const { pg, pool } = await database();
  try {
    const source = sample();
    await importState(pool, source);
    await importRecords(pool);
    await activateRecords(pool);
    const req = await session(pool);
    const first = await documentPage(pool, req, { limit: 50 });
    const second = await documentPage(pool, req, { limit: 50, after: first.next });
    assert.equal(first.items.length, 50);
    assert.equal(second.items.length, 25);
    assert.equal(first.totals.count, '75');
    assert.equal(first.totals.principalCents, '750000');
    assert.equal(first.totals.remainingCents, '749000');
    assert.deepEqual(first.totals, second.totals);
    assert.equal(second.next, null);
    assert(!JSON.stringify(first).includes('fileData'));
    assert(!JSON.stringify(first).includes('conversations'));
    assert.equal((await documentPage(pool, req, { query: 'not-found' })).totals.count, '0');
    assert.equal((await documentPage(pool, req, { client: "' OR true --" })).totals.count, '0');
    assert.equal((await documentDetail(pool, req, 'd00000', { section: 'conversations' })).items.length, 1);
    await assert.rejects(documentPage(pool, { headers: {} }, {}), (e) => e.status === 401);
    await assert.rejects(documentPage(pool, req, { limit: 1000 }), (e) => e.status === 400);
    const before = await load(pool),
      next = structuredClone(source);
    next.data['hanhukuk-finance-v1'].push({
      id: 'f2',
      documentId: 'd00074',
      accountId: 'cash',
      type: 'payment',
      amount: 2000,
      date: '2026-11-01',
    });
    await inTransaction(pool, (db) => writeChanges(db, before, next));
    const after = await documentPage(pool, req, {});
    assert.equal(after.totals.remainingCents, '747000');
    await assert.rejects(
      pool.query("UPDATE han_private.han_state SET payload=jsonb_set(payload,'{test}','true') WHERE id=1"),
      /legacy writes/,
    );
    await returnToLegacy(pool);
    assert.equal(
      (
        await pool.query(
          "SELECT jsonb_array_length(payload#>'{data,hanhukuk-finance-v1}') AS n FROM han_private.han_state WHERE id=1",
        )
      ).rows[0].n,
      2,
    );
  } finally {
    await pg.close();
  }
});
test('Balance preserves parking treatment, discount, expenses and safe large aggregates', () => {
  const doc = {
    id: 'd',
    amount: 1000,
    financeInterest: 100,
    financeFee: 200,
    debtDiscountCents: 5000,
    status: 'İcra',
  };
  const events = [
    { documentId: 'd', type: 'payment', amount: 20000 },
    { documentId: 'd', type: 'expense', amount: 1000 },
  ];
  assert.equal(balance(doc, events).remaining_cents, '106000');
  assert.equal(balance({ ...doc, docType: 'Yediemin Park Ücreti' }, events).remaining_cents, '75000');
  assert.equal(balance(doc, [{ documentId: 'd', type: 'payment', amount: 100000000 }]).remaining_cents, '0');
});
test('Dashboard includes prior partial collections in closing profit and retains closed document amount', async () => {
  const { pg, pool } = await database();
  try {
    const source = sample(1);
    Object.assign(source.data['icrapro-v1'].docs[0], { amount: 800, status: 'İnfaz' });
    source.data['hanhukuk-finance-v1'] = [
      {
        id: 'previous',
        documentId: 'd00000',
        accountId: 'cash',
        type: 'payment',
        amount: 80000,
        date: '2026-10-01',
      },
      {
        id: 'closing',
        documentId: 'd00000',
        accountId: 'cash',
        type: 'payment',
        amount: 20000,
        date: '2026-11-01',
        closes: true,
        closedAmount: 100000,
        principalAtCollection: 80000,
      },
      {
        id: 'expense',
        documentId: 'd00000',
        accountId: 'cash',
        type: 'costOnly',
        amount: 1000,
        date: '2026-11-01',
      },
    ];
    source.data['hanhukuk-accounting-v1'].entries = [
      {
        id: 'external',
        type: 'in',
        entryKind: 'external',
        includeInProfit: true,
        amount: 3000,
        accountId: 'cash',
        date: '2026-11-01',
      },
    ];
    await importState(pool, source);
    await importRecords(pool);
    await activateRecords(pool);
    const req = await session(pool),
      result = await require('../lib/record-store/dashboard.cjs').dashboard(pool, req, {
        period: 'day',
        date: '2026-11-01',
      });
    assert.deepEqual(result.buckets, [
      {
        key: '2026-11-01',
        collected: '20000',
        revenue: '23000',
        expenses: '1000',
        profit: '22000',
        closedCount: '1',
        closedAmount: '100000',
      },
    ]);
  } finally {
    await pg.close();
  }
});

test('Turkish, phone and column filters preserve literal input and sorted cursors do not skip ties', async () => {
  const { pg, pool } = await database();
  try {
    const source = sample(65);
    source.data['icrapro-v1'].clients[0].name = 'IŞIK İstanbul';
    source.data['icrapro-personnel-v1'] = [{ id: 'staff', name: 'Şule Çelik', active: true }];
    source.data['hanhukuk-finance-v1'] = [];
    source.data['icrapro-v1'].docs.forEach((doc, i) =>
      Object.assign(doc, {
        debtor: i === 0 ? 'ÇAĞRI ÖZTÜRK' : 'Diğer',
        trackingDate: i < 60 ? '2026-11-01' : undefined,
        due: '2026-12-01',
        relatedStaff: 'staff',
        phone1: i === 0 ? '+90 (532) 123 45 67' : '',
        notes: i === 0 ? 'Sözleşme %_ belirteci' : 'normal',
      }),
    );
    await importState(pool, source);
    await importRecords(pool);
    await activateRecords(pool);
    const req = await session(pool);
    for (const input of [
      { query: 'cagri isik' },
      { phone: '05321234567' },
      { query: '+90 532 123 45 67' },
      { query: '%_' },
      { columnDebtor: 'ÖZTÜRK' },
    ]) {
      const result = await documentPage(pool, req, input);
      assert.equal(result.totals.count, '1', JSON.stringify(input));
      assert.equal(result.items[0].id, 'd00000');
    }
    const column = await documentPage(pool, req, {
      columnStaff: 'sule',
      columnDue: '01/12',
      columnAmount: '100,00',
      columnType: 'Diğer',
    });
    assert.equal(column.totals.count, '65');
    for (const sort of ['trackingAsc', 'trackingDesc']) {
      const first = await documentPage(pool, req, { sort, limit: 50 });
      const last = await documentPage(pool, req, { sort, limit: 50, after: first.next });
      const rows = [...first.items, ...last.items];
      assert.equal(new Set(rows.map((r) => r.id)).size, 65);
      assert.equal(rows.at(-1).trackingDate, null, 'Missing dates remain last');
      assert.deepEqual(first.totals, last.totals);
      await assert.rejects(
        documentPage(pool, req, { sort, after: first.next, status: 'İnfaz' }),
        (e) => e.status === 400,
      );
    }
    await assert.rejects(documentPage(pool, req, { dueStart: '2026-02-30' }), (e) => e.status === 400);
    await assert.rejects(
      documentPage(pool, req, { sort: 'id; DROP TABLE documents' }),
      (e) => e.status === 400,
    );
    assert.equal((await documentPage(pool, req, { query: "' OR 1=1 --" })).totals.count, '0');
    const index = await pool.query(
      "SELECT indexdef FROM pg_indexes WHERE schemaname='han_data' AND indexname='documents_search_idx'",
    );
    assert.match(index.rows[0].indexdef, /USING gin/);
  } finally {
    await pg.close();
  }
});

test('SQL payroll aggregation matches existing team, half-month and rollover rules across all files', async () => {
  const { pg, pool } = await database();
  try {
    const source = sample(3);
    source.data['icrapro-personnel-v1'] = [
      {
        id: 'a',
        name: 'A',
        department: 'Callcenter',
        active: true,
        officialSalary: 25000,
        unofficialSalary: 1000,
        bonus: 20,
      },
      {
        id: 'b',
        name: 'B',
        department: 'Callcenter',
        active: true,
        officialSalary: 25000,
        unofficialSalary: 2000,
        bonus: 30,
      },
      { id: 'c', name: 'C', department: 'Hukuk', active: true, officialSalary: 30000, bonus: 400 },
    ];
    source.data['icrapro-v1'].docs.forEach((d, i) => (d.relatedStaff = ['a', 'b', 'c'][i]));
    source.payrollPeriodMonth = '2026-10';
    source.payrollPeriods = { '2026-09': { month: '2026-09', closed: true, rows: [{ preserved: true }] } };
    source.dailyBonuses = [{ id: 'bonus', staffId: 'b', date: '2026-11-01', amount: 200000 }];
    source.data['hanhukuk-finance-v1'] = [
      { id: 'one', documentId: 'd00000', type: 'payment', date: '2026-10-01', amount: 110000000 },
      { id: 'two', documentId: 'd00001', type: 'payment', date: '2026-10-16', amount: 100000000 },
      { id: 'three', documentId: 'd00000', type: 'payment', date: '2026-11-01', amount: 100000000 },
      {
        id: 'four',
        documentId: 'd00000',
        turnoverStaffId: 'b',
        type: 'payment',
        date: '2026-11-16',
        amount: 100000000,
      },
      { id: 'old', documentId: 'd00000', type: 'payment', date: '2020-01-01', amount: 999999999 },
    ];
    const expected = structuredClone(source);
    require('../outputs/icrapro/payroll-periods.cjs').syncPayrollPeriods(expected, '2026-11-08');
    await importState(pool, source);
    await importRecords(pool);
    await activateRecords(pool);
    await inTransaction(pool, (db) =>
      require('../lib/record-store/payroll.cjs').refreshPayroll(db, '2026-11-08'),
    );
    const actual = await exportRecords(pool);
    assert.deepEqual(actual.payrollPeriods, expected.payrollPeriods);
    assert.deepEqual(actual.data['icrapro-personnel-v1'], expected.data['icrapro-personnel-v1']);
    assert.deepEqual(actual.data['hanhukuk-finance-v1'], source.data['hanhukuk-finance-v1']);
  } finally {
    await pg.close();
  }
});

test('Only date-dependent balances refresh overnight; static balances and source records stay unchanged', async () => {
  const { pg, pool } = await database();
  try {
    const source = sample(2);
    source.data['hanhukuk-finance-v1'] = [];
    source.data['icrapro-v1'].docs[0].due = '2026-11-01';
    await importState(pool, source);
    await importRecords(pool);
    const { refreshBalances } = require('../lib/record-store/balances.cjs');
    assert.equal(await refreshBalances(pool, '2026-11-08'), 2);
    const before = (await pool.query('SELECT * FROM han_data.document_balances ORDER BY document_id')).rows;
    assert.equal(await refreshBalances(pool, '2026-11-09'), 1);
    const after = (await pool.query('SELECT * FROM han_data.document_balances ORDER BY document_id')).rows;
    assert(BigInt(after[0].target_cents) > BigInt(before[0].target_cents));
    assert.deepEqual(after[1], before[1]);
    assert.deepEqual(await exportRecords(pool), source);
  } finally {
    await pg.close();
  }
});
