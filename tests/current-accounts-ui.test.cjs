const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { parsers } = require('prettier/plugins/babel');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { businessDate } = require('../lib/business-time.cjs');
const waitFor = async (check) => {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert(check(), 'UI did not settle');
};
test('Real cari screens create a party, post debt, attach a cash payment, relink history and export with no duplicate money', async () => {
  const { pg, pool } = await database();
  let server, dom;
  try {
    const s = fixture();
    s.data['hanhukuk-accounting-v1'] = {
      accounts: [{ id: 'cash', name: 'Cash' }],
      entries: [
        {
          id: 'opening',
          type: 'in',
          amount: 2000000,
          accountId: 'cash',
          date: businessDate(),
          note: 'Opening',
        },
      ],
    };
    await importState(pool, s);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(require('../lib/application.cjs').createApplication({ store }));
    const login = await fetch(server.url + '/api/login', {
      method: 'POST',
      headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test', password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    dom = new JSDOM('<div id="content"></div><dialog id="modal"></dialog>', {
      url: server.url,
      runScripts: 'dangerously',
    });
    const w = dom.window,
      notices = [];
    let downloads = 0,
      refreshed = 0;
    Object.assign(w, {
      AbortController,
      structuredClone,
      hanRecordsEnabled: true,
      hanAuth: { id: 'test-ceo', name: 'Test', role: 'ceo' },
      hanAccountBalances: { cash: '2000000' },
      accounting: structuredClone(s.data['hanhukuk-accounting-v1']),
      financeEvents: [],
      accountingFilter: '',
      accountingExpenseCategories: ['Masraf', 'Yakıt'],
      financeCents: (v) => Math.round(Number(v) * 100),
      businessDate,
      displayDate: (v) => v,
      money: (v) => String(v),
      legalDate() {},
      toast: (m) => notices.push(m),
      $: (q) => w.document.querySelector(q),
      fetch: (url, options = {}) =>
        fetch(server.url + url, { ...options, headers: { ...options.headers, Cookie: cookie } }),
    });
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    w.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    w.URL.createObjectURL = () => 'blob:statement';
    w.URL.revokeObjectURL = () => {};
    w.HTMLAnchorElement.prototype.click = function () {
      assert.match(this.download, /cari-ekstre/);
      downloads++;
    };
    w.eval(fs.readFileSync('outputs/icrapro/html-safety.js', 'utf8'));
    w.esc = w.escapeHtml;
    const fields = fs.readFileSync('outputs/icrapro/form-inputs.js', 'utf8');
    const fieldNode = parsers.babel
      .parse(fields)
      .program.body.find((n) => n.type === 'FunctionDeclaration' && n.id.name === 'field');
    w.eval(fields.slice(fieldNode.start, fieldNode.end));
    for (const file of [
      'workspace-accounting.js',
      'workspace-cash-records.js',
      'workspace-current-accounts.js',
    ])
      w.eval(fs.readFileSync('outputs/icrapro/' + file, 'utf8'));
    w.accountingPage = () => refreshed++;
    w.currentAccountsPage();
    await waitFor(() => w.document.getElementById('currentTotals').textContent.includes('Alacağımız'));
    w.document.getElementById('currentNew').click();
    let form = w.document.querySelector('#modal form');
    form.elements.name.value = 'Firma <img src=x>';
    await form.onsubmit({ preventDefault() {} });
    await waitFor(() => w.document.querySelector('[data-current-open]'));
    assert.equal(w.document.querySelector('#currentRows img'), null);
    const id = w.document.querySelector('[data-current-open]').dataset.currentOpen;
    w.document.querySelector('[data-current-open]').click();
    await waitFor(() => w.document.getElementById('currentStatementTotals').textContent.includes('Güncel'));
    w.document.getElementById('currentStatementAdd').click();
    form = w.document.querySelector('#modal form');
    form.elements.amount.value = '10000';
    form.elements.note.value = 'Invoice';
    form.elements.side.value = 'credit';
    await form.onsubmit({ preventDefault() {} });
    await waitFor(() =>
      w.document.getElementById('currentStatementTotals').textContent.includes('10.000,00'),
    );
    w.cashEntryForm('out');
    form = w.document.getElementById('cashEntryForm');
    await waitFor(() => form.elements.currentAccountId && !form.elements.currentAccountId.disabled);
    form.elements.accountId.value = 'cash';
    form.elements.amount.value = '4000';
    form.elements.note.value = 'Payment';
    form.elements.currentAccountId.value = id;
    form.querySelector('[name="expenseCategory"][value="Masraf"]').checked = true;
    await form.onsubmit({ preventDefault() {} });
    assert.equal(refreshed, 1, notices.join('; '));
    w.currentAccountStatement(id);
    await waitFor(() => w.document.getElementById('currentStatementTotals').textContent.includes('6.000,00'));
    assert.equal(w.document.querySelectorAll('#currentStatementRows tr').length, 2);
    await w.currentAccountLinkDialog({ id: 'opening', type: 'in' });
    form = w.document.querySelector('#modal form');
    form.elements.partyId.value = id;
    await form.onsubmit({ preventDefault() {} });
    let state = await store.readState();
    assert.equal(state.data['hanhukuk-accounting-v1'].entries.length, 2);
    assert.equal(
      state.data['hanhukuk-accounting-v1'].entries.find((e) => e.id === 'opening').currentAccountId,
      id,
    );
    await w.currentAccountLinkDialog({ id: 'opening', type: 'in', currentAccountId: id });
    form = w.document.querySelector('#modal form');
    form.elements.partyId.value = '';
    await form.onsubmit({ preventDefault() {} });
    state = await store.readState();
    assert.equal(state.data['hanhukuk-accounting-v1'].entries.length, 2);
    assert.equal(state.currentAccountEntries.length, 1);
    assert.equal(
      state.data['hanhukuk-accounting-v1'].entries.reduce(
        (sum, e) => sum + (e.type === 'in' ? e.amount : -e.amount),
        0,
      ),
      1600000,
    );
    w.document.getElementById('currentStatementExport').click();
    await waitFor(() => downloads === 1);
  } finally {
    dom?.window.close();
    await server?.close();
    await pg.close();
  }
});
