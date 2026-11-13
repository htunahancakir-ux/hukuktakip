const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
function browser(t) {
  const dom = new JSDOM('', { url: 'https://test.invalid', runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.eval(fs.readFileSync('outputs/icrapro/html-safety.js', 'utf8'));
  w.eval(fs.readFileSync('outputs/icrapro/receivable-units.js', 'utf8'));
  const doc = {
    id: 'd',
    number: '1',
    debtor: 'Borçlu',
    status: 'Derdest',
    amount: 0,
    receivables: [
      { id: 'e', docType: 'Senet', currency: 'EUR', amount: 500, preTrackingPayment: 0, due: '2026-11-01' },
    ],
  };
  const notices = [],
    calls = [];
  Object.assign(w, {
    esc: w.escapeHtml,
    db: { docs: [doc], clients: [] },
    financeEvents: [],
    personnel: [{ id: 'p', name: 'Personel', active: true }],
    hanAuth: { id: 'u', role: 'ceo' },
    hanRecordsEnabled: true,
    businessDate: () => '2026-11-13',
    displayDate: (v) => v,
    money: (v) => Number(v).toFixed(2) + ' TL',
    financeCents: (v) => Math.round(Number(v) * 100),
    toast: (v) => notices.push(v),
    turnoverStaffField: () =>
      '<label class="field">Ciro<select name="turnoverStaffId" required><option value="">Seçin</option><option value="p">Personel</option><option value="__other__">Diğer</option></select></label><label data-turnover-other hidden><select name="turnoverOther" disabled><option value="turnover:bonus">Bonus</option></select></label>',
    bindFolioLock: (dialog, id) => {
      calls.push(['lease', id]);
      dialog.dataset.folioReadOnly = 'false';
    },
    recordAction: async (id, callback) => {
      calls.push(['reload', id]);
      return callback();
    },
  });
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  w.eval(fs.readFileSync('outputs/icrapro/workspace-unit-finance.js', 'utf8'));
  const group = {
    currency: 'EUR',
    gross: 50000,
    prepaid: 0,
    principal: 50000,
    interest: 0,
    fee: 0,
    discount: 0,
    target: 50000,
    received: 0,
    remaining: 50000,
  };
  const finance = {
    documentId: 'd',
    status: 'Derdest',
    asOf: '2026-11-13',
    revision: 'snapshot',
    groups: [group],
    history: [],
    accounts: [{ id: 'a', name: 'Banka' }],
  };
  const quote = {
    ...finance,
    quote: {
      id: 'official-quote',
      currency: 'EUR',
      rateMicros: 50000000,
      rate: 50,
      rateDate: '2026-11-13',
      date: '2026-11-13',
      source: 'TCMB Döviz Satış',
    },
  };
  return { w, doc, notices, calls, finance, quote };
}

test('TL preview shows native deduction, blocks an overpayment, posts once and refreshes the saved file', async (t) => {
  const { w, doc, notices, calls, finance, quote } = browser(t);
  let release,
    posts = 0,
    payload;
  w.fetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      posts++;
      payload = JSON.parse(options.body);
      return new Promise((resolve) => {
        release = () =>
          resolve({
            ok: true,
            json: async () => ({
              record: { id: 'd', status: 'Derdest' },
              payment: {
                id: payload.requestId,
                documentId: 'd',
                type: 'payment',
                amount: 250000,
                collectionStaffName: 'Personel',
                unitAllocation: { currency: 'EUR', quantityMinor: 5000 },
              },
            }),
          });
      });
    }
    return { ok: true, json: async () => (String(url).includes('currency-quote') ? quote : finance) };
  };
  await w.openUnitFinance('d', 'EUR');
  const dialog = w.document.querySelector('#unitFinanceDialog'),
    form = dialog.querySelector('#unitCollectionForm');
  form.elements.amount.value = '26000';
  form.elements.amount.oninput();
  assert.equal(form.querySelector('[type=submit]').disabled, true);
  assert.match(form.querySelector('[data-unit-error]').textContent, /kalan alacağı/);
  form.elements.amount.value = '2500';
  form.elements.accountId.value = 'a';
  form.elements.turnoverStaffId.value = 'p';
  form.elements.note.value = 'Dekont';
  form.elements.amount.oninput();
  assert.match(form.querySelector('[data-unit-conversion]').textContent, /50,00 Euro/);
  assert.match(form.querySelector('[data-unit-conversion]').textContent, /450,00 Euro/);
  dialog.dataset.folioReadOnly = 'true';
  form.elements.amount.oninput();
  assert.equal(form.querySelector('[type=submit]').disabled, true);
  await form.onsubmit({ preventDefault() {} });
  assert.equal(posts, 0);
  dialog.dataset.folioReadOnly = 'false';
  form.elements.amount.oninput();
  const first = form.onsubmit({ preventDefault() {} }),
    second = form.onsubmit({ preventDefault() {} });
  assert.equal(posts, 1);
  assert.equal(payload.amount, 2500);
  assert.equal(payload.currency, 'EUR');
  assert.equal(payload.quoteId, 'official-quote');
  assert.equal(payload.turnoverStaffId, 'p');
  release();
  await Promise.all([first, second]);
  assert.equal(w.financeEvents.length, 1);
  assert.equal(w.financeEvents[0].amount, 250000);
  assert.equal(dialog.open, false);
  assert(calls.some(([name, id]) => name === 'reload' && id === 'd'));
  assert.match(notices.at(-1), /Personel/);
  assert.equal(doc.status, 'Derdest');
});

test('Missing automatic price cannot create a collection and stale quote responses cannot re-enable saving', async (t) => {
  const { w, finance } = browser(t);
  let posts = 0;
  w.fetch = async (url, options = {}) => {
    if (options.method === 'POST') posts++;
    return String(url).includes('currency-quote')
      ? { ok: false, json: async () => ({ error: 'Günlük kur alınamadı.' }) }
      : { ok: true, json: async () => finance };
  };
  await w.openUnitFinance('d', 'EUR');
  const form = w.document.querySelector('#unitCollectionForm');
  form.elements.amount.value = '2500';
  form.elements.accountId.value = 'a';
  form.elements.turnoverStaffId.value = 'p';
  form.elements.note.value = 'Dekont';
  form.elements.amount.oninput();
  assert.equal(form.querySelector('[type=submit]').disabled, true);
  await form.onsubmit({ preventDefault() {} });
  assert.equal(posts, 0);
  assert.match(form.querySelector('[data-unit-rate]').textContent, /alınamadı/);
});

test('Changing transaction date discards a late response for an earlier rate request', async (t) => {
  const { w, finance, quote } = browser(t);
  const releases = [];
  w.fetch = async (url) => {
    if (!String(url).includes('currency-quote')) return { ok: true, json: async () => finance };
    return new Promise((resolve) => releases.push((value) => resolve({ ok: true, json: async () => value })));
  };
  const opening = w.openUnitFinance('d', 'EUR');
  while (!releases.length) await new Promise((resolve) => setImmediate(resolve));
  const form = w.document.querySelector('#unitCollectionForm');
  form.elements.date.value = '2026-11-12';
  const newer = form.elements.date.onchange();
  releases[1]({
    ...quote,
    quote: {
      ...quote.quote,
      id: 'new-date-quote',
      date: '2026-11-12',
      rateDate: '2026-11-12',
      rate: 60,
      rateMicros: 60000000,
    },
  });
  await newer;
  releases[0](quote);
  await opening;
  form.elements.amount.value = '3000';
  form.elements.amount.oninput();
  assert.match(form.querySelector('[data-unit-conversion]').textContent, /50,00 Euro/);
  assert.match(form.querySelector('[data-unit-rate]').textContent, /2026-11-12/);
  assert.doesNotMatch(form.querySelector('[data-unit-rate]').textContent, /2026-11-13/);
});

test('Gold principal editor retains three decimal places and submits milligrams', (t) => {
  const { w, doc } = browser(t);
  let payload;
  w.structuredClone = structuredClone;
  doc.receivables = [{ id: 'g', currency: 'XAU', docType: 'Diğer', amount: 2.125, preTrackingPayment: 0 }];
  w.authApi = (path, method, value) => {
    payload = value;
    return { record: { amount: 0, receivables: [{ ...doc.receivables[0], amount: 2.126 }] } };
  };
  w.eval(fs.readFileSync('outputs/icrapro/finance-operations.js', 'utf8'));
  w.financialOperations = () => {};
  w.editDocumentPrincipal('d');
  const form = w.document.querySelector('#principalDialog form');
  assert.match(form.textContent, /Gram Altın/);
  assert.equal(form.elements.principal0.step, '0.001');
  assert.equal(form.elements.principal0.value, '2.125');
  form.elements.principal0.value = '2.126';
  form.onsubmit({ preventDefault() {} });
  assert.equal(payload.expectedPrincipal, 0);
  assert.equal(payload.items[0].expectedAmount, 2125);
  assert.equal(payload.items[0].amount, 2126);
});
