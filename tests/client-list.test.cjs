const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '../outputs/icrapro');

test('Client UI keeps global totals across pages, loads one editor and saves only changed client fields', async (t) => {
  const dom = new JSDOM(
    '<div id="stats"></div><span id="count"></span><input id="search"><div id="clientSuggestions"></div><table><tbody id="rows"></tbody></table><div id="total"></div>',
    { url: 'https://local-test.invalid', runScripts: 'dangerously' },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    requests = [];
  Object.assign(w, {
    structuredClone,
    AbortController,
    hanRecordsEnabled: true,
    hanWorkspaceComplete: false,
    page: 'clients',
    hanAuth: { role: 'ceo' },
    $: (q) => w.document.querySelector(q),
    db: { clients: [], docs: [] },
    hanRecordSummary: { clients: '75' },
    hanDataBaselines: new Map([['icrapro-v1', { clients: [], docs: [] }]]),
    toast: (message) => {
      throw Error(message);
    },
  });
  for (const file of [
    'html-safety.js',
    'record-patch.js',
    'client-records.js',
    'workspace-record-list.js',
    'workspace-client-list.js',
  ])
    w.eval(
      fs.readFileSync(path.join(root, file), 'utf8') +
        (file === 'workspace-client-list.js' ? '\nwindow.clientListState=recordClientList;' : ''),
    );
  w.esc = w.escapeHtml;
  assert.equal(w.recordPageNeedsCompatibility(), false, 'client menu must not hydrate the workspace');
  let rejectSave = false,
    submitted;
  const summary = {
    clients: '75',
    documents: '100',
    amountCents: '1234500',
    closed: '2',
    returned: '1',
    closedCents: '100000',
    paidCents: '50000',
  };
  const original = { id: 'c50', name: 'Selected', notes: 'old', extra: { keep: true }, attachments: [] };
  w.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    const parsed = new URL(url, 'https://local-test.invalid');
    if (parsed.pathname === '/api/data/patch') {
      submitted = JSON.parse(options.body);
      return {
        ok: !rejectSave,
        json: async () =>
          rejectSave
            ? { error: 'Kayıt başka bir işlemle değişti.' }
            : {
                records: [
                  {
                    path: ['clients'],
                    id: 'c50',
                    value: { ...original, notes: 'new', canonical: true },
                    preservedFields: ['attachments'],
                  },
                ],
              },
      };
    }
    if (parsed.pathname === '/api/records/client')
      return {
        ok: true,
        json: async () =>
          parsed.searchParams.get('section') === 'attachment'
            ? { value: { id: 'pdf', name: 'test.pdf', data: 'data:application/pdf;base64,JVBERi0x' } }
            : { record: original, attachments: [{ id: 'client:c50:0', revision: '1' }] },
      };
    const offset = parsed.searchParams.has('after') ? 50 : 0;
    if (parsed.searchParams.get('q') === 'sak')
      return {
        ok: true,
        json: async () => ({
          count: '2',
          next: null,
          summary,
          items: [
            { id: 's1', name: 'Sakarya Mobilya' },
            { id: 's2', name: 'SAK Ticaret' },
          ],
        }),
      };
    return {
      ok: true,
      json: async () => ({
        count: '75',
        next: offset ? null : 'cursor',
        summary,
        items: Array.from({ length: offset ? 25 : 50 }, (_, i) => ({
          id: 'c' + (i + offset),
          name: '<img src=x onerror=alert(1)>',
          identity: '123',
          type: 'Şahıs',
          documentCount: '4',
        })),
      }),
    };
  };
  await w.clientRows();
  assert.equal(w.document.querySelectorAll('#rows tr').length, 50);
  assert.equal(w.document.querySelector('#rows img'), null);
  assert.match(w.document.querySelector('#rows').textContent, /4 evrak/);
  assert.match(w.document.querySelector('#total').textContent, /1–50 \/ 75/);
  const firstStats = w.document.querySelector('#stats').textContent;
  assert.match(firstStats, /12.345,00 TL/);
  w.clientListState.cursors[1] = 'cursor';
  w.clientListState.index = 1;
  await w.loadRecordClientPage();
  assert.equal(w.document.querySelectorAll('#rows tr').length, 25);
  assert.match(w.document.querySelector('#total').textContent, /51–75 \/ 75/);
  assert.equal(w.document.querySelector('#stats').textContent, firstStats);
  assert.equal(w.db.clients.length, 0, 'list projections must not become edit baselines');
  w.bindClientSearch();
  const input = w.document.querySelector('#search');
  input.value = 'sak';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(w.clientListState.index, 0);
  assert.equal(w.clientListState.q, 'sak');
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.match(w.document.querySelector('#rows').textContent, /Sakarya Mobilya/);
  assert.equal(w.document.querySelectorAll('[data-client-suggestion]').length, 2);
  assert.equal(w.document.querySelector('#clientSuggestions').hidden, false);
  assert.match(w.document.querySelector('#total').textContent, /2 müvekkil/);
  w.clientModal = (id, record) => {
    w.opened = record;
  };
  await w.openRecordClient('c50');
  assert.equal(w.opened.attachments.length, 1);
  assert.equal(w.opened.extra.keep, true);
  assert(requests.every((r) => !r.url.startsWith('/api/data?')));
  const edited = structuredClone(w.opened);
  edited.notes = 'new';
  rejectSave = true;
  await assert.rejects(w.saveRecordClient(w.opened, edited), /başka bir işlem/);
  assert.equal(w.db.clients.length, 0, 'failed saves must not publish edits');
  rejectSave = false;
  await w.saveRecordClient(w.opened, edited);
  assert.equal(submitted.changes.length, 1);
  assert.deepEqual(submitted.changes[0].path, ['clients']);
  assert.equal(submitted.changes[0].field, 'notes');
  assert.equal(w.db.clients[0].canonical, true);
  assert.equal(w.db.clients[0].attachments.length, 1);
  assert.equal(w.hanDataBaselines.get('icrapro-v1').clients[0].notes, 'new');
  // Suggestions work without a complete client list in memory.
  w.renderClientSuggestions('Selected', [{ id: 'c50', name: 'Selected', type: 'Şahıs' }]);
  w.document.querySelector('[data-client-suggestion]').click();
  assert.equal(w.document.querySelector('#search').value, 'Selected');
  await w.loadRecordClientPage();
  assert.equal(new URL(requests.at(-1).url, 'https://local-test.invalid').searchParams.has('after'), false);
});
