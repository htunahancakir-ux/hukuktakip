const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { businessDate } = require('../lib/business-time.cjs');
const cheques = require('../lib/cheques.cjs');
function sample() {
  const s = fixture();
  s.data['icrapro-v1'].clients = [
    {
      id: 'client',
      name: 'Örnek Müvekkil <img src=x>',
      type: 'Şirket',
      clientCode: '000-MV-7',
      phone: '05320000001',
      address: 'Adres',
      city: 'İstanbul',
      district: 'Kadıköy',
    },
  ];
  s.data['icrapro-personnel-v1'] = [
    {
      id: 'acc',
      name: 'Muhasebe',
      department: 'Muhasebe',
      active: true,
      officialSalary: 1000,
      unofficialSalary: 0,
      bonus: 0,
    },
  ];
  for (const [id, staffId, readOnly, modulePermissions] of [
    ['accountant', 'acc', false, {}],
    ['readonly', 'acc', true, {}],
    ['blocked', 'acc', false, { accounting: { create: false } }],
    ['ordinary', '', false, {}],
  ])
    s.users.push({
      ...s.users[0],
      id,
      username: id,
      name: id,
      role: 'staff',
      staffId,
      readOnly,
      modulePermissions,
      permissions: staffId ? [] : ['cashIn', 'cashOut'],
    });
  s.data['hanhukuk-accounting-v1'] = {
    accounts: [{ id: 'cash', name: 'Örnek Kasa' }],
    entries: [
      {
        id: 'opening',
        type: 'in',
        amount: 1000000,
        accountId: 'cash',
        date: businessDate(),
        note: 'Opening',
      },
    ],
  };
  return s;
}
const cheque = (id, direction, amount, profitChoice = 'yes', currentAccountId = '') => ({
  id,
  direction,
  amount,
  profitChoice,
  currentAccountId,
  accountId: 'cash',
  date: businessDate(),
  chequeDate: '2027-01-01',
  bankName: 'Banka <img src=x>',
  holder: 'Çek Sahibi',
  number: '0007-' + id,
  description: 'Örnek çek',
});
test('Client-derived current accounts preserve source data and cheque guards reject unauthorised ledger insertion', () => {
  const s = sample(),
    actor = s.users[0],
    cari = require('../lib/current-accounts.cjs');
  const result = cari.fromClient(
    s,
    { id: 'party', clientId: 'client', name: 'Untrusted caller name' },
    actor,
  );
  assert.equal(result.party.name, s.data['icrapro-v1'].clients[0].name);
  assert.equal(result.party.clientCode, '000-MV-7');
  assert.deepEqual(result.next.data, s.data);
  assert.equal(cari.fromClient(result.next, { id: 'another', clientId: 'client' }, actor).party.id, 'party');
  const forged = structuredClone(s);
  forged.data['hanhukuk-accounting-v1'].entries.push({
    id: 'forged',
    type: 'in',
    entryKind: 'cheque',
    amount: 100,
  });
  assert.throws(() => cheques.assertChanges(s, forged, actor), /çek kaydından/);
  for (const extra of [
    { amount: 0 },
    { profitChoice: '' },
    { chequeDate: '2027-02-30' },
    { holder: '' },
    { expenseCategory: 'Masraf' },
  ])
    assert.throws(() => cheques.create(s, { ...cheque('invalid', 'received', 100), ...extra }, actor));
});
for (const records of [false, true])
  test(
    'Cheque postings, current accounts, CEO decisions and profit remain atomic and idempotent: ' + records,
    async () => {
      const { pg, pool } = await database();
      let server;
      try {
        const state = sample();
        await importState(pool, state);
        if (records) {
          await importRecords(pool);
          await activateRecords(pool);
        }
        const store = createStore(pool, { records });
        server = await serve(require('../lib/application.cjs').createApplication({ store }));
        const cookies = {};
        for (const username of ['test', 'accountant', 'readonly', 'blocked', 'ordinary']) {
          const r = await fetch(server.url + '/api/login', {
            method: 'POST',
            headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
          });
          assert.equal(r.status, 200);
          cookies[username] = r.headers.get('set-cookie').split(';')[0];
        }
        async function call(who, path, value) {
          const r = await fetch(server.url + path, {
            method: value ? 'POST' : 'GET',
            headers: { cookie: cookies[who], 'X-Han-Request': '1', 'Content-Type': 'application/json' },
            ...(value ? { body: JSON.stringify(value) } : {}),
          });
          return { status: r.status, body: await r.json() };
        }
        assert.equal(
          (await call('ordinary', '/api/current-accounts/from-client', { id: 'denied', clientId: 'client' }))
            .status,
          403,
        );
        assert.equal(
          (await call('blocked', '/api/current-accounts/from-client', { id: 'denied', clientId: 'client' }))
            .status,
          403,
        );
        const created = await Promise.all([
          call('accountant', '/api/current-accounts/from-client', { id: 'party-one', clientId: 'client' }),
          call('accountant', '/api/current-accounts/from-client', { id: 'party-two', clientId: 'client' }),
        ]);
        assert(
          created.every((r) => r.status === 200),
          JSON.stringify(created),
        );
        const partyId = created[0].body.party.id;
        assert.equal(created[1].body.party.id, partyId);
        let saved = await store.readState();
        assert.equal(saved.currentAccountParties.length, 1);
        assert.deepEqual(saved.data['icrapro-v1'].clients, state.data['icrapro-v1'].clients);
        assert.equal(saved.data['hanhukuk-accounting-v1'].entries.length, 1);
        const received = cheque('r1', 'received', 100000, 'yes', partyId);
        for (const who of ['ordinary', 'readonly', 'blocked'])
          assert.equal((await call(who, '/api/cheques', received)).status, 403);
        assert.equal((await call('ordinary', '/api/cheques')).status, 403);
        assert.equal((await call('accountant', '/api/cheques', received)).status, 200);
        assert.equal((await call('accountant', '/api/cheques', received)).status, 200);
        assert.equal((await call('accountant', '/api/cheques', { ...received, amount: 1 })).status, 409);
        assert.equal(
          (await call('accountant', '/api/cheques', cheque('r2', 'received', 50000, 'no', partyId))).status,
          200,
        );
        const issued = cheque('i1', 'issued', 40000, 'yes', partyId);
        assert.equal((await call('accountant', '/api/cheques', issued)).status, 200);
        saved = await store.readState();
        assert.equal(
          saved.data['hanhukuk-accounting-v1'].entries.length,
          3,
          'Given cheque creates no cash movement before approval',
        );
        assert.equal(
          (await call('accountant', '/api/cheques?direction=issued')).body.items[0].status,
          'pending',
        );
        assert.equal(
          (await call('accountant', '/api/external-out/decide', { id: 'cheque-i1', action: 'approve' }))
            .status,
          403,
        );
        const approvals = await Promise.all([
          call('test', '/api/external-out/decide', { id: 'cheque-i1', action: 'approve' }),
          call('test', '/api/external-out/decide', { id: 'cheque-i1', action: 'approve' }),
        ]);
        assert(
          approvals.every((r) => r.status === 200),
          JSON.stringify(approvals),
        );
        await call('accountant', '/api/cheques', cheque('i2', 'issued', 10000, 'no', partyId));
        assert.equal(
          (await call('test', '/api/external-out/decide', { id: 'cheque-i2', action: 'approve' })).status,
          200,
        );
        await call('accountant', '/api/cheques', cheque('i3', 'issued', 1, 'yes', partyId));
        assert.equal(
          (await call('test', '/api/external-out/decide', { id: 'cheque-i3', action: 'reject' })).status,
          200,
        );
        saved = await store.readState();
        assert.equal(saved.cheques.length, 5);
        assert.equal(saved.data['hanhukuk-accounting-v1'].entries.length, 5);
        assert(
          saved.data['hanhukuk-accounting-v1'].entries
            .filter((e) => e.chequeId)
            .every((e) => !Object.hasOwn(e, 'expenseCategory')),
        );
        assert.equal(
          (await call('test', '/api/current-accounts/statement?id=' + partyId)).body.totals.current,
          '-100000',
        );
        const list = await call('accountant', '/api/cheques?direction=issued');
        assert.equal(list.body.count, 3);
        assert.equal(list.body.totals.recorded, '50000');
        assert.equal(list.body.totals.pending, '0');
        assert(list.body.items.some((r) => r.status === 'rejected'));
        assert.equal(
          (await call('accountant', '/api/cheques?direction=received&from=2027-01-01&to=2027-01-01')).body
            .count,
          2,
        );
        assert.equal((await call('accountant', '/api/cheques?direction=received&q=missing')).body.count, 0);
        const changed = structuredClone(saved);
        changed.data['hanhukuk-accounting-v1'].entries.find((e) => e.chequeId).amount++;
        assert.throws(() => cheques.assertChanges(saved, changed, state.users[0]), /finansal/);
        const source = fs.readFileSync('outputs/icrapro/finance-operations.js', 'utf8'),
          { parsers } = require('prettier/plugins/babel'),
          vm = require('node:vm');
        const funcs = parsers.babel
          .parse(source)
          .program.body.filter(
            (n) => n.type === 'FunctionDeclaration' && ['periodKeys', 'aggregateFinance'].includes(n.id.name),
          );
        const context = vm.createContext({ db: { docs: [] }, recognizedCollectionRevenue: () => 0 });
        vm.runInContext(funcs.map((n) => source.slice(n.start, n.end)).join('\n'), context);
        const browser = context.aggregateFinance(
          [],
          'day',
          businessDate(),
          saved.data['hanhukuk-accounting-v1'].entries,
        )[0];
        assert.equal(browser.profit, 60000);
        assert.equal(browser.expenses, 0);
        if (records) {
          assert.equal(
            (await require('../lib/record-store/accounts.cjs').accountBalances(pool)).cash,
            '1100000',
          );
          const dash = await call('test', '/api/records/dashboard?period=day&date=' + businessDate());
          assert.equal(dash.body.buckets[0].profit, '60000');
          assert.equal(dash.body.buckets[0].expenses, '0');
          const report = await call('test', '/api/records/reports?type=finance');
          assert.equal(report.body.totals.profit, '60000');
          assert.equal(report.body.totals.expense, '0');
          assert.equal((await call('test', '/api/records/reports?type=expenses')).body.count, '0');
        }
      } finally {
        await server?.close();
        await pg.close();
      }
    },
  );
test('Current-account and cheque forms expose client selection and distinct profit choices without expense categories', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="content"><section></section></div><dialog id="modal"></dialog>', {
    url: 'http://test.invalid',
    runScripts: 'dangerously',
  });
  const w = dom.window;
  try {
    Object.assign(w, {
      AbortController,
      hanAuth: { role: 'ceo' },
      hanRecordsEnabled: true,
      businessDate,
      financeCents: (v) => Math.round(Number(v) * 100),
      accountOptions: () => '<option value="cash">Kasa</option>',
      $: (q) => w.document.querySelector(q),
      toast() {},
      accountingPage() {},
    });
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    w.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    w.eval(fs.readFileSync('outputs/icrapro/html-safety.js', 'utf8'));
    w.esc = w.escapeHtml;
    const src = fs.readFileSync('outputs/icrapro/form-inputs.js', 'utf8'),
      { parsers } = require('prettier/plugins/babel');
    const node = parsers.babel
      .parse(src)
      .program.body.find((n) => n.type === 'FunctionDeclaration' && n.id.name === 'field');
    w.eval(src.slice(node.start, node.end));
    w.fetch = async () => ({
      ok: true,
      json: async () => ({ items: [{ id: 'party', name: 'Cari <img src=x>' }] }),
    });
    w.bindIntakeClientSelect = (_, select) => select.append(new w.Option('Müvekkil', 'client'));
    w.eval(fs.readFileSync('outputs/icrapro/workspace-current-accounts.js', 'utf8'));
    w.eval(fs.readFileSync('outputs/icrapro/workspace-cheques.js', 'utf8'));
    w.currentAccountPartyForm(null);
    assert(w.document.querySelector('[data-current-from-client]'));
    w.document.querySelector('[data-current-from-client]').click();
    assert.equal(w.document.querySelector('#currentClientPartyForm').elements.clientId.options.length, 2);
    for (const direction of ['received', 'issued']) {
      w.chequeForm(direction);
      const form = w.document.querySelector('#chequeForm');
      assert(form.elements.profitChoice.required);
      assert.equal(form.elements.expenseCategory, undefined);
      assert(form.elements.chequeDate.required);
      assert(form.elements.bankName.required);
      assert(form.elements.holder.required);
      assert.equal(
        form.elements.profitChoice.options[1].textContent,
        direction === 'received' ? 'Kâra Ekle' : 'Kârdan Düş',
      );
      assert.equal(
        form.elements.profitChoice.options[2].textContent,
        direction === 'received' ? 'Kâra Ekleme' : 'Kârdan Düşme',
      );
      await new Promise(setImmediate);
      assert.equal(form.querySelector('img'), null);
    }
  } finally {
    w.close();
  }
});
