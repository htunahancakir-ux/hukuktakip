const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const tick = async () => {
  for (let i = 0; i < 6; i++) await new Promise(setImmediate);
};
test('Accounting UI loads bounded pages, preserves totals and edit baselines and rejects stale results', async (t) => {
  const dom = new JSDOM('<div id="content"></div>', {
    url: 'https://test.invalid',
    runScripts: 'dangerously',
  });
  t.after(() => dom.window.close());
  const w = dom.window,
    requests = [],
    baseline = { accounts: [], entries: [{ id: 'existing' }] };
  Object.assign(w, {
    AbortController,
    structuredClone,
    hanRecordsEnabled: true,
    hanWorkspaceComplete: false,
    page: 'accounting',
    hanAuth: { role: 'ceo' },
    accounting: { accounts: [], entries: [{ id: 'existing' }] },
    hanDataBaselines: new Map([['hanhukuk-accounting-v1', baseline]]),
    accountingFilter: '',
    movementFilters: { start: '', end: '', type: '', operator: '', category: '', query: '' },
    accountingExpenseCategories: ['Yakıt'],
    displayDate: (s) => s,
    $: (s) => w.document.querySelector(s),
    money: (n) => String(n),
    financeEvents: [],
    toast: () => {},
    clientPayoutPage: () => {},
  });
  w.eval(
    [
      'html-safety.js',
      'workspace-record-list.js',
      'workspace-accounting.js',
      'workspace-accounting-records.js',
    ]
      .map((f) => fs.readFileSync('outputs/icrapro/' + f, 'utf8'))
      .join('\n'),
  );
  w.esc = w.escapeHtml;
  let deferred,
    fail = false;
  w.fetch = async (url) => {
    requests.push(url);
    if (url.includes('query=slow'))
      return new Promise((r) => {
        deferred = () => r({ ok: true, json: async () => ({}) });
      });
    return {
      ok: !fail,
      json: async () =>
        fail
          ? { error: 'Bağlantı hatası' }
          : {
              items: [
                {
                  id: 'x',
                  date: '2026-11-01',
                  accountId: 'cash',
                  label: '<img src=x>',
                  note: '<script>bad()</script>',
                  signed: '100',
                  balance: '900719925474099201',
                  type: 'in',
                },
              ],
              totals: {
                count: '101',
                incoming: '900719925474099301',
                outgoing: '100',
                net: '900719925474099201',
              },
              balances: { cash: '900719925474099201' },
              accountSummaries: { cash: { incoming: '900719925474099301', outgoing: '100' } },
              accounts: [{ id: 'cash', name: 'Kasa', type: 'cash' }],
              operators: ['<img src=x>'],
              next: url.includes('after=next') ? null : 'next',
            },
    };
  };
  await w.accountingPage();
  assert.equal(w.document.querySelectorAll('.account-ledger tbody tr').length, 1);
  assert.equal(w.document.querySelectorAll('.account-summary tbody tr').length, 1);
  assert.ok(w.document.querySelector('[data-account-ledger="cash"]'));
  assert.match(w.document.querySelector('.account-ledger thead').textContent, /KALAN/);
  assert.equal(w.document.querySelector('.account-ledger tbody tr').children.length, 9);
  assert.equal(w.document.querySelectorAll('img,script').length, 0);
  const total = w.document.querySelector('tfoot').textContent;
  w.document.querySelector('#nextAccounting').click();
  await tick();
  assert.equal(w.document.querySelector('tfoot').textContent, total);
  assert.match(w.document.querySelector('.tablefoot').textContent, /51–51 \/ 101/);
  assert.deepEqual(w.accounting.entries, [{ id: 'existing' }]);
  assert.deepEqual(baseline.entries, [{ id: 'existing' }]);
  assert.equal(
    requests.some((u) => u.includes('/api/data')),
    false,
  );
  w.movementFilters.query = 'slow';
  const old = w.accountingPage();
  await tick();
  w.movementFilters.query = 'new';
  await w.accountingPage();
  deferred();
  await old;
  assert.ok(w.document.querySelector('#nextAccounting'));
  let scrolled = 0;
  w.HTMLElement.prototype.scrollIntoView = function () {
    scrolled++;
    assert.ok(this.querySelector('.account-ledger'));
  };
  w.document.querySelector('[data-account-name]').click();
  await tick();
  assert.equal(scrolled, 1);
  assert.equal(new URL(requests.at(-1), w.location.origin).searchParams.get('account'), 'cash');
  fail = true;
  await w.accountingPage();
  assert.match(w.document.querySelector('#content').textContent, /Bağlantı hatası/);
  assert.equal(w.document.querySelector('table'), null);
  assert.equal(w.recordPageNeedsCompatibility(), false);
});
