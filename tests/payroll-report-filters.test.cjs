const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const tick = async () => {
  for (let i = 0; i < 6; i++) await new Promise(setImmediate);
};

function setup(t) {
  const dom = new JSDOM('<div id="content"></div>', {
    url: 'https://test.invalid',
    runScripts: 'dangerously',
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  Object.assign(w, {
    AbortController,
    hanRecordsEnabled: true,
    page: 'reports',
    monthlyPayrollReportMonth: '2026-11',
    personnel: [{ id: 'a', name: 'Ayşe Güncel', department: 'Diğer' }],
    $: (s) => w.document.querySelector(s),
    toast: (message) => assert.fail(message),
    businessDate: () => '2026-11-14',
    money: (n) => n.toFixed(2) + ' TL',
    normalizeSearch: (v) =>
      String(v || '')
        .toLocaleLowerCase('tr')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ı/g, 'i'),
  });
  w.eval(
    ['html-safety.js', 'workspace-reports.js', 'workspace-report-records.js']
      .map((f) => fs.readFileSync('outputs/icrapro/' + f, 'utf8'))
      .join('\n'),
  );
  w.esc = w.escapeHtml;
  w.safeCsvCell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [
    {
      staffId: 'a',
      name: 'Ayşe Eski',
      department: 'Pazarlama',
      active: true,
      salary: 2000000,
      bonus1: 100000,
      bonus2: 50000,
      dailyBonus: 10000,
      total: 2160000,
    },
    {
      staffId: 'b',
      name: 'Mehmet',
      department: 'Callcenter',
      active: false,
      salary: 3000000,
      bonus1: 200000,
      bonus2: 80000,
      dailyBonus: 20000,
      total: 3300000,
    },
    {
      staffId: 'c',
      name: '<img src=x onerror=alert(1)>',
      department: 'Pazarlama',
      active: true,
      salary: 1000000,
      bonus1: 0,
      bonus2: 0,
      dailyBonus: 0,
      total: 1000000,
    },
  ];
  const change = (key, value, event = 'change') => {
    const input = w.document.querySelector('#payrollReportFilters').elements[key];
    input.value = value;
    input.dispatchEvent(new w.Event(event));
  };
  return { w, rows, change };
}

test('Payroll filters combine, retain historical values and drive totals, Excel and print', async (t) => {
  const { w, rows, change } = setup(t);
  let requests = 0,
    exported;
  w.fetch = async (url) => {
    requests++;
    const month = new URL(url, w.location).searchParams.get('month');
    return {
      ok: true,
      json: async () => ({
        month,
        rows: month === '2026-11' ? rows : [],
        closed: month !== '2026-11',
        missing: month !== '2026-11',
      }),
    };
  };
  w.URL.createObjectURL = (blob) => {
    exported = blob;
    return 'blob:report';
  };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () {};
  await w.monthlyPayrollReportPage();
  const result = () => w.document.querySelector('#payrollReportResult');
  assert.equal(result().querySelectorAll('tbody tr').length, 3);
  assert.equal(result().querySelector('tfoot th:last-child').textContent, '64600.00 TL');
  assert.equal(result().querySelector('img'), null);
  change('department', 'Pazarlama');
  assert.equal(result().querySelectorAll('tbody tr').length, 2);
  assert.equal(result().querySelector('tfoot th:last-child').textContent, '31600.00 TL');
  change('active', 'inactive');
  assert.match(result().textContent, /Filtrelere uygun personel bulunamadı/);
  assert.equal(result().querySelector('tfoot th:last-child').textContent, '0.00 TL');
  change('active', 'active');
  const search = w.document.querySelector('[name="query"]');
  search.focus();
  change('query', 'AYŞE', 'input');
  assert.equal(w.document.activeElement, search, 'typing preserves focus');
  assert.equal(result().querySelectorAll('tbody tr').length, 1);
  assert.match(result().textContent, /Ayşe Eski/);
  assert.equal(result().querySelector('tfoot th:last-child').textContent, '21600.00 TL');
  assert.equal(requests, 1, 'filtering does not refetch or use current personnel values');
  w.document.querySelector('[data-payroll-report-csv]').click();
  const reader = new w.FileReader();
  const csv = await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(exported);
  });
  assert.match(csv, /Ayşe Eski/);
  assert.doesNotMatch(csv, /Mehmet|<img/);
  assert.match(csv, /ALT TOPLAM.*21600\.00 TL/);
  w.document.querySelector('[data-payroll-report-print]').click();
  const print = w.document.querySelector('iframe').srcdoc;
  assert.match(print, /Ayşe Eski/);
  assert.doesNotMatch(print, /Mehmet|<img/);
  assert.match(print, /21600\.00 TL/);
  w.document.querySelector('iframe').remove();
  w.document.querySelector('[data-payroll-report-clear]').click();
  change('active', 'inactive');
  assert.match(result().textContent, /Mehmet/);
  assert.equal(result().querySelectorAll('tbody tr').length, 1);
  w.document.querySelector('[data-payroll-report-clear]').click();
  change('staff', 'a');
  const month = w.document.querySelector('[data-payroll-report-month]');
  month.value = '2026-10';
  month.dispatchEvent(new w.Event('change'));
  await tick();
  assert.equal(
    w.document.querySelector('[name="staff"]').value,
    'a',
    'missing staff selection survives month switch',
  );
  assert.match(result().textContent, /0 \/ 0 personel/);
  assert.match(w.document.querySelector('#content').textContent, /kayıtlı maaş ve prim dönemi bulunmuyor/);
  w.document.querySelector('[data-payroll-report-clear]').click();
  assert.equal(w.document.querySelector('[name="staff"]').value, '');
});

test('Payroll month request cannot overwrite newer month or another report', async (t) => {
  const { w, rows } = setup(t);
  let resolveOld;
  w.fetch = async (url) => {
    const month = new URL(url, w.location).searchParams.get('month');
    if (month === '2026-11')
      return new Promise((resolve) => {
        resolveOld = () => resolve({ ok: true, json: async () => ({ month, rows, closed: false }) });
      });
    return { ok: true, json: async () => ({ month, rows: [], closed: true }) };
  };
  const old = w.monthlyPayrollReportPage();
  await tick();
  w.monthlyPayrollReportMonth = '2026-10';
  await w.monthlyPayrollReportPage();
  resolveOld();
  await old;
  assert.equal(w.document.querySelector('[data-payroll-report-month]').value, '2026-10');
  w.monthlyPayrollReportMonth = '2026-11';
  const leaving = w.monthlyPayrollReportPage();
  await tick();
  w.page = 'home';
  w.document.querySelector('#content').textContent = 'Ana Sayfa';
  resolveOld();
  await leaving;
  assert.equal(w.document.querySelector('#content').textContent, 'Ana Sayfa');
});
