const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const tick = async () => {
  for (let i = 0; i < 6; i++) await new Promise(setImmediate);
};
test('Report UI keeps complete totals across pages, rejects stale responses and uses scoped data', async (t) => {
  const dom = new JSDOM('<div id="content"></div>', {
    url: 'https://local-test.invalid',
    runScripts: 'dangerously',
  });
  t.after(() => dom.window.close());
  const w = dom.window,
    requests = [],
    notices = [],
    attack = '<img src=x onerror=alert(1)>';
  Object.assign(w, {
    AbortController,
    hanRecordsEnabled: true,
    hanWorkspaceComplete: false,
    page: 'reports',
    hanAuth: { role: 'ceo' },
    hanPageAllowed: () => true,
    db: { clients: [], docs: [] },
    personnel: [],
    accounting: { accounts: [] },
    reportFilters: {
      type: 'documents',
      from: '',
      to: '',
      client: '',
      staff: '',
      status: '',
      account: '',
      query: '',
      undated: true,
    },
    $: (s) => w.document.querySelector(s),
    toast: (s) => notices.push(s),
    money: (v) => String(v) + ' TL',
    displayDate: (s) => s,
    businessDate: () => '2026-11-08',
    field: (label, name, type, value = '') =>
      `<label>${label}<input name="${name}" type="${type}" value="${value}"></label>`,
  });
  w.eval(
    [
      'html-safety.js',
      'report-definitions.js',
      'workspace-record-list.js',
      'workspace-reports.js',
      'workspace-report-records.js',
    ]
      .map((file) => fs.readFileSync('outputs/icrapro/' + file, 'utf8'))
      .join('\n'),
  );
  w.esc = w.escapeHtml;
  w.URL.createObjectURL = () => 'blob:https://local-test.invalid/report';
  w.URL.revokeObjectURL = () => {};
  let deferred,
    fail = false;
  w.fetch = async (url, options) => {
    requests.push(url);
    const parsed = new URL(url, 'https://local-test.invalid');
    if (parsed.pathname === '/api/records/reports/export')
      return {
        ok: !fail,
        json: async () => ({ error: 'Rapor çıktısı çok büyük.' }),
        blob: async () => new w.Blob(['CSV']),
      };
    if (parsed.pathname === '/api/records/search')
      return { ok: true, json: async () => ({ items: [{ id: 'outside', name: attack }], more: true }) };
    if (parsed.searchParams.get('query') === 'slow')
      return new Promise(
        (resolve) =>
          (deferred = () =>
            resolve({
              ok: true,
              json: async () => ({ items: [], count: '999', undated: '0', totals: {}, next: null }),
            })),
      );
    if (fail) return { ok: false, json: async () => ({ error: 'Retry safely' }) };
    return {
      ok: true,
      json: async () => ({
        items: [
          {
            id: 'one',
            date: '2026-01-01',
            documentId: 'd1',
            cells: {
              debtor: attack,
              principal: '10000',
              total: '10000',
              received: '0',
              remaining: '10000',
              profit: '0',
            },
          },
        ],
        count: '123',
        undated: '0',
        totals: {
          principal: '900719925474099300',
          total: '1230000',
          received: '0',
          remaining: '1230000',
          profit: '0',
        },
        next: parsed.searchParams.get('after') ? null : 'cursor',
      }),
    };
  };
  assert.equal(w.recordPageNeedsCompatibility(), false);
  w.reportsPage();
  await tick();
  assert(w.document.querySelector('tfoot').textContent.includes('9.007.199.254.740.993,00 TL'));
  assert(w.document.querySelector('.notice').textContent.includes('123 kayıt'));
  assert.equal(w.document.querySelector('#reportResult img'), null);
  w.document.querySelector('#nextReport').click();
  await tick();
  assert(requests.some((url) => url.includes('after=cursor')));
  assert(w.document.querySelector('.tablefoot').textContent.includes('51–51 / 123'));
  assert(w.document.querySelector('tfoot').textContent.includes('12.300,00 TL'));
  w.reportFilters.query = 'slow';
  const slow = w.loadRecordReport();
  await tick();
  w.reportFilters.query = 'fast';
  await w.loadRecordReport();
  deferred();
  await slow;
  assert(!w.document.querySelector('.notice').textContent.includes('999'));
  assert(requests.at(-1).includes('after='));
  const input = w.document.querySelector('#reportClientLookup');
  input.focus();
  await tick();
  const select = w.document.querySelector('#reportClient');
  assert.equal(select.options[1].textContent, attack);
  assert.equal(w.db.clients.length, 0);
  select.value = 'outside';
  select.dispatchEvent(new w.Event('change'));
  await tick();
  assert(requests.at(-1).includes('client=outside'));
  let exportUrl;
  w.HTMLAnchorElement.prototype.click = function () {
    exportUrl = this.href;
  };
  await w.exportReport();
  assert(exportUrl.startsWith('blob:'));
  assert(requests.at(-1).includes('/api/records/reports/export?'));
  assert(requests.at(-1).includes('client=outside'));
  assert(!requests.at(-1).includes('after='));
  fail = true;
  await w.loadRecordReport();
  assert.equal(w.document.querySelector('#reportResult').textContent, 'Retry safely');
  assert.equal(w.document.querySelector('#exportReport').disabled, true);
  assert(requests.every((url) => !url.includes('/api/data') && !url.includes('/api/report-data')));
  await w.exportReport();
  assert.deepEqual(notices, ['Rapor çıktısı çok büyük.']);
  fail = false;
  w.document.querySelector('#openExpenseReport').click();
  await tick();
  assert.equal(w.reportFilters.type, 'expenses');
  assert.equal(w.reportFilters.client, '');
  assert.equal(w.document.querySelector('#reportClient').closest('label').hidden, true);
  assert.ok(requests.at(-1).includes('type=expenses'));
  w.personnel = [{ id: 'p', name: 'Örnek Personel' }];
  w.isHanDocumentReceiver = (value) => ['HAN', 'receiver:han'].includes(value);
  w.HanReceivables = { types: ['Senet', 'Fatura'] };
  w.document.querySelector('#openHanDocumentReport').click();
  await tick();
  assert.match(w.document.querySelector('#openHanDocumentReport').textContent, /Evrak Raporu/);
  assert.equal(w.document.querySelector('#clientInfoReportFilters').open, true);
  assert.match(w.document.querySelector('#reportStaff').closest('label').textContent, /Dosya Sorumlusu/);
  for (const [id, value] of [
    ['reportReceiver', 'receiver:han'],
    ['reportDocumentType', 'Fatura'],
  ]) {
    const input = w.document.querySelector('#' + id);
    input.value = value;
    input.dispatchEvent(new w.Event('change'));
    await tick();
  }
  let params = new URL(requests.at(-1), w.location).searchParams;
  assert.equal(params.get('receiver'), 'receiver:han');
  assert.equal(params.get('documentType'), 'Fatura');
  assert.equal(params.get('after'), '');
  await w.exportReport();
  params = new URL(requests.at(-1), w.location).searchParams;
  assert.equal(params.get('receiver'), 'receiver:han');
  assert.equal(params.get('documentType'), 'Fatura');
  assert.equal(params.has('after'), false);
  w.document.querySelector('#clearReportFilters').click();
  await tick();
  assert.equal(w.reportFilters.receiver, '');
  assert.equal(w.reportFilters.documentType, '');
  w.document.querySelector('#reportReceiver').value = 'p';
  w.document.querySelector('#reportReceiver').dispatchEvent(new w.Event('change'));
  w.document.querySelector('#openExpenseReport').click();
  await tick();
  assert.equal(w.reportFilters.receiver, '', 'document filters cannot leak into other reports');
  assert.equal(w.document.querySelector('#reportReceiver'), null);
});
