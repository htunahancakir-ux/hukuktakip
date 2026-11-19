const { test } = require('node:test');
const assert = require('node:assert/strict');
const cari = require('../lib/current-accounts.cjs');
const { appendCashEntry } = require('../lib/cash-entry.cjs');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const { businessDate } = require('../lib/business-time.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { accountBalances } = require('../lib/record-store/accounts.cjs');
function sample() {
  const s = fixture();
  s.data['hanhukuk-accounting-v1'] = {
    accounts: [{ id: 'cash', name: 'Kasa' }],
    entries: [
      {
        id: 'initial',
        type: 'in',
        amount: 2000000,
        date: businessDate(),
        accountId: 'cash',
        note: 'Opening',
      },
    ],
  };
  return s;
}
const owner = { id: 'test-ceo', name: 'Test', role: 'ceo' };
const p = { id: 'party', name: 'Örnek Firma', kind: 'Firma' };
test('Manual balances and linked cash are independent: 10,000 owed less 4,000 paid leaves 6,000 owed once', () => {
  const original = sample();
  let s = cari.saveParty(original, p, owner).next;
  s = cari.addEntry(
    s,
    { id: 'invoice', partyId: p.id, date: businessDate(), side: 'credit', amount: 1000000, note: 'Invoice' },
    owner,
  ).next;
  assert.deepEqual(s.data, original.data, 'Manual entries never change cash, expenses, debtors or payroll');
  s = appendCashEntry(
    s,
    {
      id: 'paid',
      type: 'out',
      expenseCategory: 'Masraf',
      accountId: 'cash',
      amount: 400000,
      date: businessDate(),
      note: 'Payment',
      currentAccountId: p.id,
    },
    owner,
    () => true,
    { cash: '2000000' },
    () => 0,
  );
  assert.equal(cari.list(s).items[0].balance, '-600000');
  assert.equal(cari.list(s).totals.payable, '600000');
  assert.equal(s.data['hanhukuk-accounting-v1'].entries.length, 2);
  assert.equal(s.currentAccountEntries.length, 1);
  assert.equal(cari.statement(s, p.id).totals.current, '-600000');
  const invoice = s.currentAccountEntries[0];
  assert.equal(cari.addEntry(s, invoice, owner).next, null, 'Manual save retries are idempotent');
  assert.throws(
    () => cari.addEntry(s, { ...invoice, amount: 2 }, owner),
    (e) => e.code === 409,
  );
  assert.throws(
    () => cari.saveParty(s, { ...p, name: 'Stale edit', revision: 0 }, owner),
    (e) => e.code === 409,
  );
});
test('A historic movement can move between caris or be unlinked without creating another payment', () => {
  let s = cari.saveParty(sample(), p, owner).next;
  s = cari.saveParty(s, { id: 'second', name: 'Diğer Firma', kind: 'Firma' }, owner).next;
  const money = structuredClone(s.data['hanhukuk-accounting-v1'].entries);
  s = cari.linkEntry(s, { entryId: 'initial', partyId: p.id, expectedPartyId: '' }, owner).next;
  assert.equal(cari.list(s).items.find((r) => r.id === p.id).balance, '-2000000');
  assert.equal(
    cari.linkEntry(s, { entryId: 'initial', partyId: p.id, expectedPartyId: '' }, owner).next,
    null,
  );
  assert.throws(
    () => cari.linkEntry(s, { entryId: 'initial', partyId: 'second', expectedPartyId: '' }, owner),
    (e) => e.code === 409,
  );
  s = cari.linkEntry(s, { entryId: 'initial', partyId: 'second', expectedPartyId: p.id }, owner).next;
  assert.equal(cari.list(s).items.find((r) => r.id === p.id).balance, '0');
  s = cari.linkEntry(s, { entryId: 'initial', partyId: '', expectedPartyId: 'second' }, owner).next;
  assert.equal(cari.list(s).items.find((r) => r.id === 'second').balance, '0');
  const saved = s.data['hanhukuk-accounting-v1'].entries.map(
    ({ currentAccountLinkedBy, currentAccountLinkedAt, ...r }) => r,
  );
  assert.deepEqual(saved, money);
});

test('Cash receipts reduce a receivable and invalid legacy cash links are rejected', () => {
  let s = cari.saveParty(sample(), p, owner).next;
  s = cari.addEntry(
    s,
    {
      id: 'receivable',
      partyId: p.id,
      date: businessDate(),
      side: 'debit',
      amount: 1000000,
      note: 'Receivable',
    },
    owner,
  ).next;
  s = appendCashEntry(
    s,
    {
      id: 'received',
      type: 'in',
      accountId: 'cash',
      amount: 400000,
      date: businessDate(),
      note: 'Received',
      currentAccountId: p.id,
    },
    owner,
    () => true,
    { cash: '2000000' },
    () => 0,
  );
  assert.equal(cari.statement(s, p.id).totals.current, '600000');
  assert.equal(cari.list(s).totals.receivable, '600000');
  const ledger = structuredClone(s.data['hanhukuk-accounting-v1']);
  ledger.entries.find((e) => e.id === 'received').type = 'transfer';
  assert.throws(() => cari.validateLedgerLinks(s, ledger));
  ledger.entries.find((e) => e.id === 'received').type = 'in';
  ledger.entries.find((e) => e.id === 'received').currentAccountId = 'missing';
  assert.throws(() => cari.validateLedgerLinks(s, ledger));
});
test('Date filtering retains opening balances, complete period totals and consistent pagination', () => {
  let s = cari.saveParty(sample(), p, owner).next;
  s = cari.addEntry(
    s,
    {
      id: 'old-invoice',
      partyId: p.id,
      date: '2026-01-01',
      side: 'credit',
      amount: 100000,
      note: 'Earlier debt',
    },
    owner,
  ).next;
  for (let i = 0; i < 60; i++)
    s = cari.addEntry(
      s,
      {
        id: 'entry-' + i,
        partyId: p.id,
        date: businessDate(),
        side: 'debit',
        amount: 100,
        note: 'Current entry',
      },
      owner,
    ).next;
  const f = { from: businessDate(), to: businessDate(), limit: 50 };
  const first = cari.statement(s, p.id, f),
    second = cari.statement(s, p.id, { ...f, offset: 50, version: first.version });
  assert.equal(first.items.length, 50);
  assert.equal(second.items.length, 10);
  assert.equal(first.count, 60);
  assert.equal(first.totals.opening, '-100000');
  assert.equal(first.totals.debit, '6000');
  assert.equal(first.totals.closing, '-94000');
  assert.deepEqual(first.totals, second.totals);
  s = cari.addEntry(
    s,
    { id: 'changed', partyId: p.id, date: businessDate(), side: 'debit', amount: 100, note: 'New entry' },
    owner,
  ).next;
  assert.throws(
    () => cari.statement(s, p.id, { ...f, offset: 50, version: first.version }),
    (e) => e.code === 409,
  );
  assert.throws(() => cari.statement(s, p.id, { limit: 0 }));
  assert.throws(() => cari.list(s, { offset: -1 }));
  assert.throws(() =>
    cari.addEntry(
      s,
      { id: 'bad', partyId: p.id, date: '2999-01-01', side: 'debit', amount: 10, note: 'Future' },
      owner,
    ),
  );
  s.data['hanhukuk-accounting-v1'].entries.push({ id: 'transfer', type: 'transfer', amount: 10 });
  assert.throws(() => cari.linkEntry(s, { entryId: 'transfer', partyId: p.id, expectedPartyId: '' }, owner));
});
for (const records of [false, true])
  test(
    'Cari HTTP flows persist manual entries, link payments, export and keep cash totals unchanged: ' +
      records,
    async () => {
      const { pg, pool } = await database();
      let server;
      try {
        const s = sample();
        s.users.push({
          ...s.users[0],
          id: 'cash-user',
          username: 'cash-user',
          role: 'staff',
          permissions: ['cashOut'],
        });
        s.users.push({
          ...s.users[0],
          id: 'create-only',
          username: 'create-only',
          role: 'staff',
          accountingAccess: true,
          modulePermissions: { accounting: { update: false, delete: false } },
        });
        s.users.push({
          ...s.users[0],
          id: 'readonly',
          username: 'readonly',
          role: 'admin',
          readOnly: true,
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
            headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
            body: JSON.stringify({ username, password }),
          });
          assert.equal(r.status, 200);
          return {
            'Content-Type': 'application/json',
            'X-Han-Request': '1',
            cookie: r.headers.get('set-cookie').split(';')[0],
          };
        };
        const auth = await login('test'),
          staff = await login('cash-user'),
          creator = await login('create-only'),
          reader = await login('readonly');
        const post = (path, data, headers = auth) =>
          fetch(server.url + path, { method: 'POST', headers, body: JSON.stringify(data) });
        const get = async (path, headers = auth) => {
          const r = await fetch(server.url + path, { headers });
          assert.equal(r.status, 200, await r.clone().text());
          return r.json();
        };
        assert.equal((await post('/api/current-accounts', p, creator)).status, 200);
        assert.equal(
          (await post('/api/current-accounts', p, creator)).status,
          200,
          'Create-only users can retry their save',
        );
        assert.equal(
          (await post('/api/current-accounts', { ...p, revision: 1, name: 'Blocked update' }, creator))
            .status,
          403,
        );
        assert.equal(
          (await post('/api/current-accounts', { ...p, id: 'readonly-attempt' }, reader)).status,
          403,
        );
        assert.equal(
          (
            await post(
              '/api/current-accounts/link',
              {
                entryId: 'initial',
                partyId: p.id,
                expectedPartyId: '',
              },
              creator,
            )
          ).status,
          403,
        );
        const manual = {
          id: 'invoice',
          partyId: p.id,
          date: businessDate(),
          side: 'credit',
          amount: 1000000,
          note: '=Unsafe spreadsheet text',
        };
        assert.equal((await post('/api/current-accounts/entries', manual)).status, 200);
        assert.equal((await post('/api/current-accounts/entries', manual)).status, 200);
        const cash = {
          id: 'paid',
          type: 'out',
          amount: 400000,
          accountId: 'cash',
          date: businessDate(),
          expenseCategory: 'Masraf',
          note: 'Payment',
          currentAccountId: p.id,
        };
        assert.equal((await post('/api/cash-entry', cash)).status, 200);
        assert.equal((await post('/api/cash-entry', cash)).status, 200);
        let result = await get('/api/current-accounts/statement?id=party');
        assert.equal(result.totals.current, '-600000');
        assert.equal(result.count, 2);
        assert(!Object.hasOwn(result, 'allItems'));
        assert.equal((await get('/api/current-accounts')).count, 1);
        assert.deepEqual(await get('/api/current-accounts/options', staff), {
          items: [{ id: p.id, name: p.name }],
        });
        assert.equal(
          (await fetch(server.url + '/api/current-accounts/statement?id=party', { headers: staff })).status,
          403,
        );
        assert.equal(
          (await post('/api/current-accounts/entries', { ...manual, id: 'denied' }, staff)).status,
          403,
        );
        const saved = await store.readState();
        assert.equal(saved.currentAccountEntries.length, 1);
        assert.equal(saved.data['hanhukuk-accounting-v1'].entries.length, 2);
        if (records) assert.deepEqual(await accountBalances(pool), { cash: '1600000' });
        const exported = await fetch(server.url + '/api/current-accounts/statement?id=party&export=csv', {
          headers: auth,
        });
        assert.equal(exported.status, 200);
        assert.match(exported.headers.get('content-type'), /text\/csv/);
        assert.match(await exported.text(), /'\=Unsafe spreadsheet text/);
        assert.equal(
          (
            await post('/api/current-accounts/link', {
              entryId: 'initial',
              partyId: p.id,
              expectedPartyId: '',
            })
          ).status,
          200,
        );
        result = await get('/api/current-accounts/statement?id=party');
        assert.equal(result.totals.current, '-2600000');
        assert.equal(
          (
            await post('/api/current-accounts/link', {
              entryId: 'initial',
              partyId: '',
              expectedPartyId: p.id,
            })
          ).status,
          200,
        );
        assert.equal((await get('/api/current-accounts/statement?id=party')).totals.current, '-600000');
        assert.equal((await store.readState()).data['hanhukuk-accounting-v1'].entries.length, 2);
      } finally {
        await server?.close();
        await pg.close();
      }
    },
  );
