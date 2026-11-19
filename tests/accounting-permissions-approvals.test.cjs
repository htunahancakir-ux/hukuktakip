const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const { businessDate } = require('../lib/business-time.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { personnelLedgerAllowed } = require('../lib/personnel-ledger-access.cjs');
const external = require('../lib/external-out.cjs');
function sample() {
  const s = fixture(),
    today = businessDate();
  s.data['icrapro-personnel-v1'] = [
    {
      id: 'accountant',
      name: 'Muhasebe Personeli',
      department: 'Muhasebe',
      active: true,
      officialSalary: 40000,
      unofficialSalary: 0,
      bonus: 0,
    },
    {
      id: 'payee',
      name: 'Ödeme Yapılan',
      department: 'Diğer',
      active: true,
      officialSalary: 40000,
      unofficialSalary: 0,
      bonus: 0,
    },
  ];
  for (const [id, staffId, modulePermissions, readOnly] of [
    ['accountant', 'accountant', {}, false],
    ['viewer', 'accountant', { personnelLedger: { pay: false } }, false],
    ['denied', 'accountant', { personnelLedger: { view: false, pay: true } }, false],
    ['readonly', 'accountant', {}, true],
    ['ordinary', 'payee', {}, false],
  ])
    s.users.push({
      ...s.users[0],
      id,
      username: id,
      name: id,
      role: 'staff',
      staffId,
      modulePermissions,
      readOnly,
      permissions: ['cashOut'],
    });
  s.data['hanhukuk-accounting-v1'] = {
    accounts: [{ id: 'cash', name: 'Örnek Kasa' }],
    entries: [
      { id: 'opening', type: 'in', accountId: 'cash', date: today, amount: 10000000, note: 'Opening' },
    ],
  };
  s.currentAccountParties = [{ id: 'party', name: 'Cari', kind: 'Firma', active: true, revision: 1 }];
  require('../outputs/icrapro/payroll-periods.cjs').syncPayrollPeriods(s, today);
  return s;
}
test('Payroll access defaults to accounting and separates viewing, paying and read-only sessions', () => {
  const s = sample(),
    people = s.data['icrapro-personnel-v1'];
  const byId = (id) => s.users.find((u) => u.id === id);
  assert(personnelLedgerAllowed(byId('accountant'), people, 'view'));
  assert(personnelLedgerAllowed(byId('accountant'), people, 'pay'));
  assert(personnelLedgerAllowed(byId('viewer'), people, 'view'));
  for (const id of ['viewer', 'denied', 'readonly', 'ordinary'])
    assert(!personnelLedgerAllowed(byId(id), people, 'pay'));
  assert(!personnelLedgerAllowed(byId('denied'), people, 'view'));
});
test('An external withdrawal cannot be forged through ordinary accounting writes', () => {
  const s = sample(),
    user = s.users.find((u) => u.id === 'accountant');
  const next = structuredClone(s);
  next.data['hanhukuk-accounting-v1'].entries.push({
    id: 'forged',
    type: 'externalOut',
    amount: 100,
    accountId: 'cash',
    date: businessDate(),
  });
  assert.throws(() => external.assertChanges(s, next, user), /CEO/);
  assert.throws(() => external.assertChanges(s, next, s.users[0]), /CEO/);
});
for (const records of [false, true])
  test(
    'Accounting payroll access and CEO approval atomically control cash, profit and expenses: ' + records,
    async () => {
      const { pg, pool } = await database();
      let server;
      try {
        const s = sample();
        await importState(pool, s);
        if (records) {
          await importRecords(pool);
          await activateRecords(pool);
        }
        const store = createStore(pool, { records });
        server = await serve(require('../lib/application.cjs').createApplication({ store }));
        const cookies = {};
        async function login(username) {
          const r = await fetch(server.url + '/api/login', {
            method: 'POST',
            headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
          });
          assert.equal(r.status, 200, await r.clone().text());
          cookies[username] = r.headers.get('set-cookie').split(';')[0];
        }
        for (const username of ['test', 'accountant', 'viewer', 'denied', 'readonly', 'ordinary'])
          await login(username);
        async function call(who, path, value) {
          const r = await fetch(server.url + path, {
            method: value ? 'POST' : 'GET',
            headers: { cookie: cookies[who], 'X-Han-Request': '1', 'Content-Type': 'application/json' },
            ...(value ? { body: JSON.stringify(value) } : {}),
          });
          return { status: r.status, body: await r.json() };
        }
        const ledgerPath = records
          ? '/api/records/personnel-ledger?staffId=payee'
          : '/api/personnel-ledger?staffId=payee';
        const access = await call('accountant', '/api/session');
        assert.deepEqual(access.body.user.personnelLedgerAccess, { view: true, pay: true });
        const periods = await call('accountant', ledgerPath);
        assert.equal(periods.status, 200, JSON.stringify(periods.body));
        assert.equal(periods.body.canPay, true);
        assert(periods.body.months.some((m) => m.month === businessDate().slice(0, 7)));
        assert.equal((await call('viewer', ledgerPath)).body.canPay, false);
        assert.equal((await call('denied', ledgerPath)).status, 403);
        assert.equal((await call('ordinary', ledgerPath)).status, 403);
        const payment = {
          id: 'salary-advance',
          type: 'out',
          expenseCategory: 'Maaş Avansı',
          staffId: 'payee',
          payrollMonth: businessDate().slice(0, 7),
          accountId: 'cash',
          date: businessDate(),
          amount: 10000,
          note: 'Avans',
        };
        assert.equal((await call('viewer', '/api/cash-entry', payment)).status, 403);
        assert.equal((await call('readonly', '/api/cash-entry', payment)).status, 403);
        assert.equal((await call('accountant', '/api/cash-entry', payment)).status, 200);
        const original = (await store.readState()).data['hanhukuk-accounting-v1'].entries.length;
        const pending = {
          id: 'request-one',
          accountId: 'cash',
          date: businessDate(),
          amount: 100000,
          profitChoice: 'yes',
          note: 'Harici ödeme',
          currentAccountId: 'party',
        };
        assert.equal((await call('accountant', '/api/external-out/request', pending)).status, 200);
        assert.equal((await call('accountant', '/api/external-out/request', pending)).status, 200);
        assert.equal(
          (await store.readState()).data['hanhukuk-accounting-v1'].entries.length,
          original,
          'A request never moves cash',
        );
        assert.equal((await call('test', '/api/external-out?status=pending')).body.count, 1);
        assert.equal(
          (await call('ordinary', '/api/external-out')).body.count,
          0,
          'Only own requests are visible to staff',
        );
        assert.equal(
          (await call('accountant', '/api/external-out/decide', { id: pending.id, action: 'approve' }))
            .status,
          403,
        );
        const approvals = await Promise.all([
          call('test', '/api/external-out/decide', { id: pending.id, action: 'approve' }),
          call('test', '/api/external-out/decide', { id: pending.id, action: 'approve' }),
        ]);
        assert(
          approvals.every((r) => r.status === 200),
          JSON.stringify(approvals),
        );
        let saved = await store.readState();
        const entry = saved.data['hanhukuk-accounting-v1'].entries.find((e) => e.type === 'externalOut');
        assert.equal(saved.data['hanhukuk-accounting-v1'].entries.length, original + 1);
        assert.equal(entry.includeInProfit, true);
        assert.equal(entry.approvedBy, 'test-ceo');
        assert.equal(entry.currentAccountId, 'party');
        assert(!Object.hasOwn(entry, 'expenseCategory'));
        const second = { ...pending, id: 'request-two', profitChoice: 'no', currentAccountId: '' };
        await call('accountant', '/api/external-out/request', second);
        assert.equal(
          (await call('test', '/api/external-out/decide', { id: second.id, action: 'approve' })).status,
          200,
        );
        const huge = { ...pending, id: 'too-much', amount: 100000000 };
        await call('accountant', '/api/external-out/request', huge);
        assert.equal(
          (await call('test', '/api/external-out/decide', { id: huge.id, action: 'approve' })).status,
          409,
        );
        assert.equal(
          (await call('test', '/api/external-out/decide', { id: huge.id, action: 'reject' })).status,
          200,
        );
        assert.equal(
          (await call('test', '/api/external-out/decide', { id: huge.id, action: 'approve' })).status,
          409,
        );
        const statement = await call('test', '/api/current-accounts/statement?id=party');
        assert.equal(statement.body.totals.current, '100000');
        saved = await store.readState();
        const source = fs.readFileSync('outputs/icrapro/finance-operations.js', 'utf8');
        const { parsers } = require('prettier/plugins/babel');
        const helpers = parsers.babel
          .parse(source)
          .program.body.filter(
            (n) => n.type === 'FunctionDeclaration' && ['periodKeys', 'aggregateFinance'].includes(n.id.name),
          );
        const vm = require('node:vm'),
          context = vm.createContext({
            db: { docs: [] },
            recognizedCollectionRevenue: require('../outputs/icrapro/profit-rules.js')
              .recognizedCollectionRevenue,
          });
        vm.runInContext(helpers.map((n) => source.slice(n.start, n.end)).join('\n'), context);
        const calculated = context.aggregateFinance(
          [],
          'day',
          businessDate(),
          saved.data['hanhukuk-accounting-v1'].entries,
        )[0];
        assert.equal(calculated.profit, -110000);
        assert.equal(calculated.expenses, 10000);
        const altered = structuredClone(saved);
        altered.data['hanhukuk-accounting-v1'].entries.find((e) => e.id === entry.id).amount++;
        assert.throws(() => external.assertChanges(saved, altered, s.users[0]), /değiştirilemez/);
        if (records) {
          const dashboard = await call('test', '/api/records/dashboard?period=day&date=' + businessDate());
          assert.equal(dashboard.body.buckets[0].expenses, '10000');
          assert.equal(dashboard.body.buckets[0].profit, '-110000');
          const report = await call('test', '/api/records/reports?type=expenses');
          assert.equal(
            report.body.totals.amount,
            '10000',
            'External withdrawals never enter expense reports',
          );
          const finance = await call('test', '/api/records/reports?type=finance');
          assert.equal(finance.body.totals.profit, '-110000');
          assert.equal(finance.body.totals.expense, '10000');
          const balance = await require('../lib/record-store/accounts.cjs').accountBalances(pool);
          assert.equal(balance.cash, '9790000');
        }
      } finally {
        await server?.close();
        await pg.close();
      }
    },
  );
test('External request form has mandatory profit choice, no expense category and a stable request ID', async () => {
  const dom = new JSDOM('<dialog id="modal"></dialog><div id="content"></div>', {
    url: 'http://test.invalid',
    runScripts: 'dangerously',
  });
  const w = dom.window,
    payloads = [];
  try {
    Object.assign(w, {
      $: (q) => w.document.querySelector(q),
      businessDate: () => businessDate(),
      financeCents: (v) => Math.round(Number(v) * 100),
      accountOptions: () => '<option value="cash">Kasa</option>',
      field: (label, name, type, value = '') =>
        '<label>' +
        label +
        '<input name="' +
        name +
        '" type="' +
        type +
        '" value="' +
        value +
        '" required></label>',
      toast() {},
      modalFormSaved() {},
    });
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    w.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    w.fetch = async (path, options) => {
      payloads.push(JSON.parse(options.body));
      return { ok: false, json: async () => ({ error: 'Retry safely' }) };
    };
    w.eval(fs.readFileSync('outputs/icrapro/workspace-external-out.js', 'utf8'));
    w.externalOutForm();
    const form = w.document.querySelector('form');
    assert.equal(form.querySelector('[data-cash-out-tab="external"]').getAttribute('aria-selected'), 'true');
    assert.equal(form.querySelectorAll('[role="tab"]').length, 2);
    assert.equal(form.elements.expenseCategory, undefined);
    assert(form.elements.profitChoice.required);
    assert.equal(form.elements.profitChoice.options[1].textContent, 'Kârdan Düş');
    assert.equal(form.elements.profitChoice.options[2].textContent, 'Kârdan Düşme');
    form.elements.amount.value = '1000';
    form.elements.note.value = 'Test';
    form.elements.profitChoice.value = 'no';
    await form.onsubmit({ preventDefault() {} });
    await form.onsubmit({ preventDefault() {} });
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].id, payloads[1].id);
  } finally {
    w.close();
  }
});
