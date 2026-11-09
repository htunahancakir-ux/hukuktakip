const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const tick = async () => {
  for (let i = 0; i < 6; i++) await new Promise(setImmediate);
};
test('Payout UI pages complete totals, fetches selected detail only, and retries a payment with the same ID', async (t) => {
  const dom = new JSDOM('<div id="content"></div>', {
    url: 'https://test.invalid',
    runScripts: 'dangerously',
  });
  t.after(() => dom.window.close());
  const w = dom.window,
    requests = [],
    posts = [],
    notices = [];
  Object.assign(w, {
    AbortController,
    structuredClone,
    hanRecordsEnabled: true,
    hanWorkspaceComplete: false,
    page: 'accounting',
    db: { clients: [], docs: [] },
    accounting: { accounts: [], entries: [] },
    financeEvents: [],
    personnel: [],
    documentTypes: { Senet: {} },
    clientPayoutFilter: '',
    clientPayoutStart: '',
    clientPayoutEnd: '',
    displayDate: (s) => s,
    docType: (d) => d.docType,
    $: (s) => w.document.querySelector(s),
    money: (n) => String(n),
    financeCents: (n) => Math.round(Number(n || 0) * 100),
    formatAmountInput: String,
    businessDate: () => '2026-11-08',
    legalDate: () => {},
    accountingPage: () => {},
    toast: (s) => notices.push(s),
    field: (l, n, t, v = '', r = false) =>
      `<label>${l}<input name="${n}" type="${t}" value="${v}" ${r ? 'required' : ''}></label>`,
  });
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  w.eval(
    [
      'html-safety.js',
      'workspace-record-list.js',
      'workspace-report-records.js',
      'finance-operations.js',
      'workspace-payout-records.js',
    ]
      .map((f) => fs.readFileSync('outputs/icrapro/' + f, 'utf8'))
      .join('\n'),
  );
  w.esc = w.escapeHtml;
  let fail = true,
    deferred;
  w.fetch = async (url, options = {}) => {
    requests.push(url);
    if (url === '/api/client-payout') {
      posts.push(JSON.parse(options.body));
      if (fail) throw Error('Bağlantı kesildi');
      return { ok: true, json: async () => ({ ok: true, accountBalances: { cash: '5000' } }) };
    }
    const p = new URL(url, 'https://test.invalid');
    if (p.searchParams.get('debtor') === 'slow')
      return new Promise((r) => {
        deferred = () => r({ ok: true, json: async () => ({ items: [], totals: { count: '999' } }) });
      });
    if (p.pathname === '/api/records/client-payout')
      return {
        ok: true,
        json: async () => ({
          record: { id: 'd', number: 'D-1', client: 'c', closedDate: '2026-01-02' },
          client: { name: '<img src=x>', iban: 'IBAN' },
          totals: { entitlement: '10000', paid: '0', remaining: '10000', eligible: true },
          accounts: [{ id: 'cash', name: 'Kasa' }],
          accountBalances: { cash: '10000' },
        }),
      };
    if (p.pathname === '/api/records/clients')
      return {
        ok: true,
        json: async () => ({
          items: [{ id: 'outside', name: 'Sakarya <img src=x>' }],
          count: '1',
          next: null,
        }),
      };
    return {
      ok: true,
      json: async () => ({
        items: [
          {
            id: 'd',
            number: 'D-1',
            type: 'Senet',
            debtor: '<img src=x>',
            client: 'c',
            clientName: 'Test',
            closedDate: '2026-01-02',
            entitlement: '10000',
            paid: '0',
            remaining: '10000',
          },
        ],
        totals: {
          count: '101',
          entitlement: '900719925474099301',
          paid: '100',
          remaining: '900719925474099201',
        },
        next: 'next',
      }),
    };
  };
  await w.clientPayoutPage();
  const total = w.document.querySelector('tfoot').textContent;
  w.document.querySelector('#nextPayout').click();
  await tick();
  assert.equal(w.document.querySelector('tfoot').textContent, total);
  assert.match(w.document.querySelector('.tablefoot').textContent, /51–51 \/ 101/);
  assert.equal(w.document.querySelectorAll('img,script').length, 0);
  w.document.querySelector('#payoutClientLookup').dispatchEvent(new w.Event('focus'));
  await tick();
  assert.ok(w.document.querySelector('#clientPayoutFilter option[value="outside"]'));
  assert.equal(w.document.querySelector('#payoutClientMatches').hidden, false);
  assert.match(w.document.querySelector('#payoutClientMatches').textContent, /Sakarya/);
  assert.equal(w.document.querySelector('#payoutClientMatches img'), null);
  let filtered = 0;
  w.document.querySelector('#clientPayoutFilter').form.requestSubmit = () => filtered++;
  w.document.querySelector('#payoutClientMatches button').click();
  assert.equal(w.document.querySelector('#clientPayoutFilter').value, 'outside');
  assert.equal(filtered, 1);
  assert.equal(w.db.clients.length, 0);
  await w.clientPayoutForm('d');
  const form = w.document.querySelector('#clientPayoutForm');
  assert.ok(form);
  assert.equal(w.db.docs.length, 0);
  assert.equal(w.accounting.entries.length, 0);
  form.elements.accountId.value = 'cash';
  form.elements.amount.value = '50';
  form.elements.note.value = 'Ödeme';
  await form.onsubmit({ preventDefault() {} });
  assert.equal(posts.length, 1);
  assert.match(notices.at(-1), /kesildi/);
  assert.equal(form.closest('dialog').open, true);
  fail = false;
  await form.onsubmit({ preventDefault() {} });
  assert.equal(posts.length, 2);
  assert.equal(posts[0].id, posts[1].id);
  assert.equal(posts[1].amount, 5000);
  assert.equal(form.closest('dialog').open, false);
  await tick();
  assert.ok(requests.every((u) => !u.startsWith('/api/data')));
  const dateForm = w.document.querySelector('#clientPayoutDateForm');
  const setFilter = (value) => {
    dateForm.elements.debtor.value = value;
    dateForm.onsubmit({ preventDefault() {} });
  };
  w.parseAmountInput = (value) => (value === '' ? '' : Number(value));
  setFilter('slow');
  await tick();
  setFilter('new');
  await tick();
  deferred();
  await tick();
  assert.ok(w.document.querySelector('#nextPayout'));
});
