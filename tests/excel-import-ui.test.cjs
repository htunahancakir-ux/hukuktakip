const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const wait = () => new Promise((resolve) => setTimeout(resolve, 30));
test('Excel entrypoints, file preview, safe rows, paging, mapping validation and selected single commit', async (t) => {
  const dom = new JSDOM('<div><button id="newClient">Yeni</button></div><dialog id="modal"></dialog>', {
    url: 'https://test.invalid',
    runScripts: 'dangerously',
  });
  t.after(() => dom.window.close());
  const w = dom.window,
    requests = [];
  let saved = 0;
  Object.assign(w, {
    AbortController,
    hanAuth: { role: 'ceo' },
    businessDate: () => '2026-11-15',
    selected: '',
    recordClientList: {},
    recordIntakeList: {},
    render() {},
    modalFormSaved() {
      saved++;
    },
  });
  w.eval(fs.readFileSync('outputs/icrapro/html-safety.js', 'utf8'));
  w.esc = w.escapeHtml;
  const modal = w.document.getElementById('modal');
  modal.showModal = () => {
    modal.open = true;
  };
  modal.close = () => {
    modal.open = false;
    modal.dispatchEvent(new w.Event('close'));
  };
  w.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, body });
    if (url.includes('options'))
      return {
        ok: true,
        json: async () => ({
          categories: ['Diğer'],
          fields: [{ key: 'name', label: 'Müvekkil Adı' }],
          staff: [],
          docTypes: ['Senet'],
          maxFileBytes: 2 * 1024 * 1024,
        }),
      };
    if (url.endsWith('preview'))
      return {
        ok: true,
        json: async () => ({
          sheets: [
            { name: 'Sayfa1', rowCount: 53, columns: [{ key: 'A', label: 'Unvan' }], mapping: { name: 'A' } },
          ],
          sheet: 'Sayfa1',
          totals: { ready: 51, duplicate: 1, error: 1 },
          items: Array.from({ length: 53 }, (_, i) => ({
            key: 'Sayfa1:' + (i + 2),
            sources: [{ sheet: 'Sayfa1', row: i + 2 }],
            label: i === 0 ? '<img src=x onerror="evil()">' : 'Firma ' + i,
            detail: 'Diğer',
            state: i < 51 ? 'ready' : i === 51 ? 'duplicate' : 'error',
            message: i < 51 ? '' : 'Kontrol edin',
          })),
        }),
      };
    await wait();
    return {
      ok: true,
      json: async () => ({
        imported: body.keys.length,
        skipped: 0,
        payments: 0,
        records: [{ id: 'synthetic', name: 'Yeni Firma' }],
      }),
    };
  };
  w.eval(fs.readFileSync('outputs/icrapro/workspace-excel-import.js', 'utf8'));
  w.bindExcelImportButtons('clients');
  assert(w.document.getElementById('excelImportClients'));
  w.bindExcelImportButtons('intake');
  assert(!w.document.getElementById('excelImportClients'));
  assert(w.document.getElementById('excelImportDocuments'));
  w.hanAuth.readOnly = true;
  w.hanAuth.role = 'staff';
  w.bindExcelImportButtons('intake');
  assert(!w.document.getElementById('excelImportDocuments'));
  w.hanAuth = { role: 'ceo' };
  await w.openExcelImport('clients');
  const form = w.document.getElementById('excelImportForm'),
    file = form.elements.workbook;
  Object.defineProperty(file, 'files', {
    value: [
      new w.File(['synthetic'], 'import.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    ],
    configurable: true,
  });
  await file.onchange();
  const preview = form.querySelector('[data-excel-preview]'),
    commit = form.querySelector('[data-excel-commit]');
  assert.equal(preview.querySelectorAll('tbody tr').length, 50);
  assert.equal(preview.querySelectorAll('img').length, 0);
  assert(preview.textContent.includes('<img'));
  assert.equal(commit.disabled, false);
  preview.querySelector('[data-excel-next]').click();
  assert.equal(preview.querySelectorAll('tbody tr').length, 3);
  assert.equal(preview.querySelectorAll('tbody input:disabled').length, 2);
  const row = preview.querySelector('tbody input');
  row.checked = false;
  row.dispatchEvent(new w.Event('change'));
  assert.match(commit.textContent, /50/);
  const mapping = form.querySelector('[data-excel-field]');
  mapping.value = '';
  mapping.dispatchEvent(new w.Event('change'));
  assert.equal(commit.disabled, true);
  commit.click();
  assert.equal(requests.filter((r) => r.url.endsWith('commit')).length, 0);
  mapping.value = 'A';
  form.querySelector('[data-excel-recheck]').click();
  await wait();
  assert.equal(commit.disabled, false);
  preview.querySelector('[data-excel-all]').click();
  assert.equal(commit.disabled, true);
  preview.querySelector('[data-excel-all]').click();
  assert.equal(commit.disabled, false);
  const one = preview.querySelector('tbody input');
  one.checked = false;
  one.dispatchEvent(new w.Event('change'));
  commit.click();
  commit.click();
  await wait();
  await wait();
  const writes = requests.filter((r) => r.url.endsWith('commit'));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.keys.length, 50);
  assert(!writes[0].body.keys.includes('Sayfa1:2'));
  assert.equal(saved, 1);
  assert.match(preview.textContent, /Aktarım tamamlandı/);
  assert.equal(commit.disabled, true);
});
