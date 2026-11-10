const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function setup(role = 'admin', status = 'Derdest') {
  const dom = new JSDOM('<dialog id="modal"></dialog>', {
    url: 'http://localhost/',
    runScripts: 'dangerously',
  });
  const w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const doc = { id: 'd1', number: 'D-1', debtor: 'Test', docType: 'Senet', status, amount: 1000 };
  const requests = [];
  Object.assign(w, {
    hanAuth: { role, id: 'user', name: 'Test' },
    db: { docs: [doc] },
    financeEvents: [{ id: 'payment', documentId: 'd1', type: 'payment', amount: 1000, date: '2026-01-01' }],
    accounting: { accounts: [{ id: 'cash', name: 'Kasa' }], entries: [] },
    personnel: [],
    financeOperationTab: 'expense',
    financeHistoryTab: 'all',
    $: (selector) => w.document.querySelector(selector),
    esc: (value) => String(value ?? ''),
    money: (value) => String(value),
    displayDate: (value) => value,
    businessDate: () => '2026-01-02',
    field: (label, name, type, value = '', required = false) =>
      `<label>${label}<input name="${name}" type="${type}" value="${value}" ${required ? 'required' : ''}></label>`,
    collectionAccountField: () =>
      '<label>Hesap<select name="accountId"><option value="cash">Kasa</option></select></label>',
    staffSelect: () => '',
    activeOperator: () => ({ id: 'user', name: 'Test' }),
    financeCents: (value) => Math.round(Number(value || 0) * 100),
    accountBalance: () => 9999999,
    setupFinanceOperationTabs: () => {},
    bindFinanceHistory: () => {},
    financeHistoryMarkup: () => '',
    docFinance: () => ({ remaining: 99000, principal: 100000, received: 1000, target: 100000, expenses: 0 }),
    save: () => {},
    stats: () => {},
    toast: () => {},
    authApi: (path, method, payload) => {
      if (path === '/api/expense-pool') return { balance: 500000 };
      if (path === '/api/expense-pool/allocate') {
        requests.push(payload);
        return { ok: true };
      }
      if (path === '/api/data?key=hanhukuk-finance-v1') return w.financeEvents;
      throw Error('Unexpected request: ' + path);
    },
  });
  w.eval(fs.readFileSync('outputs/icrapro/finance-operations.js', 'utf8'));
  // Keep the UI test focused on the expense form and payment permission.
  w.docFinance = () => ({ remaining: 99000, principal: 100000, received: 1000, target: 100000, expenses: 0 });
  w.financeHistoryMarkup = () => '';
  w.bindFinanceHistory = () => {};
  w.setupFinanceOperationTabs = () => {};
  return { dom, w, doc, requests };
}

test('Yönetici tahsilatlı açık dosyada faiz ve ücreti değiştirebilir; personel ve infaz dosyası değiştiremez', () => {
  for (const [role, status, enabled] of [
    ['admin', 'Derdest', true],
    ['staff', 'Derdest', false],
    ['admin', 'İnfaz', false],
  ]) {
    const { dom, w } = setup(role, status);
    try {
      w.financialOperations('d1');
      const form = w.document.querySelector('#financeTerms');
      assert.equal(!form.elements.interest.disabled, enabled);
      assert.equal(!form.elements.fee.disabled, enabled);
      assert.equal(!form.querySelector('button:not([type])').disabled, enabled);
    } finally {
      dom.window.close();
    }
  }
});

test('Masraf avansından borca ekleyerek veya eklemeden dağıtım yapılır', () => {
  for (const [buttonValue, expected] of [
    ['addToDebt', 'expense'],
    ['costOnly', 'costOnly'],
  ]) {
    const { dom, w, requests } = setup();
    try {
      w.financialOperations('d1');
      const form = w.document.querySelector('#expenseEntry');
      form.elements.accountId.value = '__expense_pool__';
      form.elements.date.value = '2026-01-02';
      form.elements.amount.value = '25';
      form.elements.note.value = 'Dosya masrafı';
      const submitter = form.querySelector(`[value="${buttonValue}"]`);
      form.dispatchEvent(new w.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter }));
      assert.equal(requests.length, 1);
      assert.equal(requests[0].type, expected);
      assert.equal(requests[0].amount, 2500);
      assert.equal(requests[0].documentId, 'd1');
    } finally {
      dom.window.close();
    }
  }
});

test('Kasa çıkışı masraf avansına kuruş olarak gönderilir', () => {
  const { dom, w } = setup();
  try {
    const requests = [];
    w.hanRecordsEnabled = false;
    w.authApi = (path, method, payload) => {
      if (path === '/api/expense-pool/fund') {
        requests.push({ method, payload });
        return { ok: true };
      }
      if (path === '/api/data?key=hanhukuk-accounting-v1') return w.accounting;
      throw Error('Unexpected request: ' + path);
    };
    w.eval(fs.readFileSync('outputs/icrapro/workspace-accounting.js', 'utf8'));
    w.accountingPage = () => {};
    w.showExpensePoolFunding();
    const form = w.document.getElementById('expensePoolFundingForm');
    form.elements.accountId.value = 'cash';
    form.elements.date.value = '2026-01-02';
    form.elements.amount.value = '10000';
    form.elements.note.value = 'Ortak avans';
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].payload.accountId, 'cash');
    assert.equal(requests[0].payload.amount, 1000000);
  } finally {
    dom.window.close();
  }
});

test('Avans hareketlerinde tarih aralığı iki uç dahil filtrelenir ve temizlenir', () => {
  const { dom, w } = setup();
  try {
    w.authApi = () => ({
      funded: 300,
      allocated: 0,
      balance: 300,
      movements: [
        { id: 'a', date: '2026-01-01', amount: 100, kind: 'fund' },
        { id: 'b', date: '2026-01-02', amount: 100, kind: 'fund' },
        { id: 'c', date: '2026-01-03', amount: 100, kind: 'fund' },
      ],
    });
    w.eval(fs.readFileSync('outputs/icrapro/workspace-accounting.js', 'utf8'));
    w.expensePoolHistory();
    const form = w.document.querySelector('#expensePoolFilter');
    form.elements.from.value = '2026-01-02';
    form.elements.to.value = '2026-01-03';
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(w.document.querySelectorAll('#modal tbody tr').length, 2);
    form.querySelector('#clearExpensePoolDates').click();
    assert.equal(w.document.querySelectorAll('#modal tbody tr').length, 3);
  } finally {
    dom.window.close();
  }
});

test('Avans hareketleri giren, çıkan ve önceki hareketleri içeren kalanı gösterir', () => {
  const { dom, w } = setup();
  try {
    w.authApi = () => ({
      funded: 10000,
      allocated: 3000,
      balance: 7000,
      movements: [
        { id: 'use', date: '2026-01-03', amount: 3000, kind: 'allocation', type: 'expense' },
        { id: 'fund', date: '2026-01-01', amount: 10000, kind: 'fund' },
      ],
    });
    w.eval(fs.readFileSync('outputs/icrapro/workspace-accounting.js', 'utf8'));
    w.expensePoolHistory();
    const rows = [...w.document.querySelectorAll('.expense-pool-table tbody tr')];
    assert(rows[0].classList.contains('expense-pool-out'));
    assert(rows[1].classList.contains('expense-pool-in'));
    assert.deepEqual(
      [...rows[0].cells].slice(-3).map((cell) => cell.textContent),
      ['—', '30', '70'],
    );
    assert.deepEqual(
      [...rows[1].cells].slice(-3).map((cell) => cell.textContent),
      ['100', '—', '100'],
    );
    const form = w.document.querySelector('#expensePoolFilter');
    form.elements.from.value = '2026-01-03';
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(w.document.querySelectorAll('.expense-pool-table tbody tr').length, 1);
    assert.equal(w.document.querySelector('.expense-pool-table tbody tr').cells[7].textContent, '70');
  } finally {
    dom.window.close();
  }
});

test('Avans hareketleri 50 kayıtlık sayfalarda gösterilir', () => {
  const { dom, w } = setup();
  try {
    w.authApi = () => ({
      funded: 10100,
      allocated: 0,
      balance: 10100,
      movements: Array.from({ length: 101 }, (_, i) => ({
        id: String(i),
        date: '2026-01-01',
        amount: 100,
        kind: 'fund',
      })),
    });
    w.eval(fs.readFileSync('outputs/icrapro/workspace-accounting.js', 'utf8'));
    w.expensePoolHistory();
    assert.equal(w.document.querySelectorAll('.expense-pool-table tbody tr').length, 50);
    assert.match(w.document.getElementById('expensePoolPageInfo').textContent, /1–50 \/ 101/);
    w.document.getElementById('expensePoolNext').click();
    assert.match(w.document.getElementById('expensePoolPageInfo').textContent, /51–100 \/ 101/);
    w.document.getElementById('expensePoolNext').click();
    assert.equal(w.document.querySelectorAll('.expense-pool-table tbody tr').length, 1);
    assert.equal(w.document.getElementById('expensePoolNext').disabled, true);
    w.document.getElementById('expensePoolPrev').click();
    assert.equal(w.document.querySelectorAll('.expense-pool-table tbody tr').length, 50);
  } finally {
    dom.window.close();
  }
});
