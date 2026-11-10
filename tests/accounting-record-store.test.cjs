const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const { database, fixture, serve } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { accountingPage } = require('../lib/record-store/accounting.cjs');
const { accountBalances } = require('../lib/record-store/accounts.cjs');
const { createApplication } = require('../lib/application.cjs');
test('Accounting pages preserve all balances, transfers, exclusions and filters without loading business objects', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture(),
      ledger = state.data['hanhukuk-accounting-v1'];
    ledger.accounts = [
      { id: 'cash', name: 'Kasa', type: 'cash' },
      { id: 'bank', name: 'Banka', type: 'bank' },
    ];
    ledger.excludedFinanceIds = ['excluded'];
    ledger.entries = Array.from({ length: 123 }, (_, i) => ({
      id: 'l' + i,
      type: 'in',
      amount: 100 + i,
      accountId: 'cash',
      date: '2026-11-01',
      operatorName: 'IŞIK',
      note: 'Literal %_ <img src=x>',
      createdAt: '2026-11-01T10:00:00Z',
    }));
    ledger.entries.push(
      ...[
        { id: 'transfer', type: 'transfer', amount: 200, destination: 'bank' },
        { id: 'expense', type: 'out', amount: 100, expenseCategory: 'Yakıt' },
        { id: 'advance', type: 'advance', amount: 90, advanceType: 'T.Ç' },
        { id: 'external', type: 'in', amount: 500, entryKind: 'external', includeInProfit: true },
        { id: 'payout', type: 'clientPayout', amount: 30 },
      ].map((e) => ({
        ...e,
        accountId: 'cash',
        date: '2026-11-02',
        operatorName: 'Diğer',
        note: 'not',
        createdAt: '',
      })),
    );
    state.data['hanhukuk-finance-v1'] = [
      { id: 'pay', type: 'payment', amount: 500 },
      { id: 'excluded', type: 'payment', amount: 100000 },
      { id: 'cost', type: 'costOnly', amount: 50 },
      { id: 'noaccount', type: 'payment', amount: 999, accountId: '' },
    ].map((e) => ({ accountId: 'cash', date: '2026-11-03', documentId: 'd', note: 'note', ...e }));
    state.data['icrapro-v1'].docs = [
      { id: 'd', number: 'D-001', amount: 100, status: 'Derdest', fileData: 'DO-NOT-SEND' },
    ];
    state.users.push({ ...state.users[0], id: 'staff', username: 'staff', role: 'staff' });
    state.data['icrapro-personnel-v1'].push({
      id: 'accountant-person',
      name: 'Accountant',
      department: 'Muhasebe',
      active: true,
    });
    state.users.push({
      ...state.users[0],
      id: 'accountant',
      username: 'accountant',
      role: 'staff',
      staffId: 'accountant-person',
      permissions: [],
    });
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    async function session(id) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
        [crypto.createHash('sha256').update(token).digest('hex'), id, Date.now() + 600000],
      );
      return { headers: { cookie: 'han_session=' + token } };
    }
    const req = await session('test-ceo'),
      staff = await session('staff');
    const accountant = await session('accountant');
    assert.equal((await accountingPage(pool, accountant)).totals.count, '131');
    const ctx = vm.createContext({
      accounting: ledger,
      financeEvents: state.data['hanhukuk-finance-v1'],
      db: state.data['icrapro-v1'],
      normalizeSearch: (s) =>
        String(s || '')
          .toLocaleLowerCase('tr')
          .replace(/ı/g, 'i')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, ''),
    });
    vm.runInContext(fs.readFileSync('outputs/icrapro/workspace-accounting.js', 'utf8'), ctx);
    const all = ctx.accountMovements();
    const before = await pool.query('SELECT id,body,revision FROM han_data.ledger_entries ORDER BY id');
    let fullBalances;
    for (const f of [
      {},
      { type: 'transfer' },
      { account: 'bank' },
      { type: 'external' },
      { type: 'in' },
      { operator: 'IŞIK' },
      { category: 'Yakıt' },
      { query: '%_' },
      { query: 'isik' },
      { query: "' OR 1=1 --" },
      { start: '2026-11-02', end: '2026-11-02' },
    ]) {
      const expected = ctx.filterAccountMovements(all, f.account || '', f);
      let after = '',
        items = [],
        first;
      do {
        const data = await accountingPage(pool, req, { ...f, limit: 30, after });
        first ??= data;
        items.push(...data.items);
        after = data.next || '';
        assert.deepEqual(data.totals, first.totals);
        assert.equal(data.totals.count, String(expected.length));
        assert.equal(data.totals.net, String(expected.reduce((s, e) => s + e.signed, 0)));
        assert.ok(Buffer.byteLength(JSON.stringify(data)) < 30000);
        assert.ok(!JSON.stringify(data).includes('DO-NOT-SEND'));
      } while (after);
      assert.equal(items.length, expected.length);
      assert.equal(new Set(items.map((x) => x.id)).size, items.length);
      if (!Object.keys(f).length) {
        const running = new Map();
        fullBalances = new Map();
        const key = (r) => [r.date, r.created, r.id].join('|');
        for (const row of items.slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))) {
          const next = (running.get(row.accountId) || 0n) + BigInt(row.signed);
          running.set(row.accountId, next);
          assert.equal(row.balance, String(next));
          fullBalances.set(row.id, row.balance);
        }
        for (const account of ledger.accounts) {
          const s = first.accountSummaries[account.id];
          assert.equal(BigInt(s.incoming) - BigInt(s.outgoing), BigInt(first.balances[account.id]));
        }
      }
      for (const row of items) assert.equal(row.balance, fullBalances.get(row.id));
      const canon = (rows) =>
        Array.from(rows, (r) =>
          JSON.stringify([r.accountId, String(r.signed), r.label, r.note, r.operatorName || null]),
        ).sort();
      assert.deepEqual(canon(items), canon(expected));
    }
    const balances = await accountBalances(pool);
    for (const a of ledger.accounts)
      assert.equal(
        balances[a.id],
        String(all.filter((e) => e.accountId === a.id).reduce((s, e) => s + e.signed, 0)),
      );
    const first = await accountingPage(pool, req, { limit: 1 });
    await assert.rejects(accountingPage(pool, req, { limit: 1, after: first.next, type: 'out' }), {
      status: 400,
    });
    await assert.rejects(accountingPage(pool, staff), { status: 403 });
    await assert.rejects(accountingPage(pool, { headers: {} }), { status: 401 });
    await assert.rejects(accountingPage(pool, req, { start: '2026-02-30' }), { status: 400 });
    server = await serve(createApplication({ store: createStore(pool, { records: true }) }));
    const accountantHeaders = {
      ...accountant.headers,
      'X-Han-Request': '1',
      'Content-Type': 'application/json',
    };
    const sessionResult = await fetch(server.url + '/api/session', { headers: accountant.headers }).then(
      (r) => r.json(),
    );
    assert.equal(sessionResult.user.accountingAccess, true);
    assert.equal(sessionResult.user.canDelete, false);
    const patchAccount = (change, headers = accountantHeaders) =>
      fetch(server.url + '/api/data/patch?key=hanhukuk-accounting-v1', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ changes: [change] }),
      });
    const newAccount = { id: 'accountant-account', name: 'Accountant cash', type: 'cash' };
    assert.equal(
      (await patchAccount({ path: ['accounts'], id: newAccount.id, before: null, value: newAccount })).status,
      200,
    );
    assert.equal(
      (
        await patchAccount({
          path: ['accounts'],
          id: newAccount.id,
          field: 'name',
          before: { value: newAccount.name },
          after: { value: 'Updated cash' },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await patchAccount(
          {
            path: ['accounts'],
            id: 'unauthorized',
            before: null,
            value: { ...newAccount, id: 'unauthorized' },
          },
          { ...accountantHeaders, ...staff.headers },
        )
      ).status,
      403,
    );
    assert.equal(
      (await fetch(server.url + '/api/operations/delete?type=accounting', { headers: accountant.headers }))
        .status,
      403,
    );
    assert.equal(
      (
        await patchAccount({
          path: ['accounts'],
          id: newAccount.id,
          before: { ...newAccount, name: 'Updated cash' },
          value: null,
        })
      ).status,
      403,
    );
    assert.equal(
      (await patchAccount({ path: ['entries'], id: 'l0', before: ledger.entries[0], value: null })).status,
      403,
    );
    assert.equal(
      (await fetch(server.url + '/api/records/accounting', { headers: accountant.headers })).status,
      200,
    );
    assert.equal((await fetch(server.url + '/api/records/accounting', { headers: req.headers })).status, 200);
    assert.equal(
      (await fetch(server.url + '/api/records/accounting', { headers: staff.headers })).status,
      403,
    );
    assert.deepEqual(
      (await pool.query('SELECT id,body,revision FROM han_data.ledger_entries ORDER BY id')).rows,
      before.rows,
    );
  } finally {
    await server?.close();
    await pg.close();
  }
});
