const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createApplication } = require('../lib/application.cjs');
const { businessDate } = require('../lib/business-time.cjs');
const { names } = require('../outputs/icrapro/debtor-folders.js');

for (const records of [false, true]) {
  test(
    'Debtor folders persist independently of status and finance, with scoped permissions: ' + records,
    async () => {
      const { pg, pool } = await database();
      let server;
      try {
        const s = fixture();
        for (const [id, role, extra] of [
          ['manager', 'admin', {}],
          ['staff', 'staff', { permissions: ['documents'] }],
          ['readonly', 'admin', { readOnly: true }],
          ['denied', 'admin', { modulePermissions: { documents: { update: false } } }],
        ])
          s.users.push({ ...s.users[0], id, username: id, role, ...extra });
        s.data['icrapro-v1'].clients = [{ id: 'client', name: 'Örnek Müvekkil' }];
        s.data['icrapro-v1'].docs = Array.from({ length: 56 }, (_, i) => ({
          id: 'doc-' + String(i).padStart(3, '0'),
          number: String(i + 1),
          debtor: 'Örnek Borçlu ' + i,
          client: 'client',
          status: i === 0 ? 'İnfaz' : 'Derdest',
          docType: 'Senet',
          amount: 100,
          financeInterest: 0,
          financeFee: 0,
          financeTermsManual: true,
          due: businessDate(),
          trackingDate: businessDate(),
          ...(i < 52 ? { debtorFolder: 'Marmara' } : {}),
        }));
        await importState(pool, s);
        if (records) {
          await importRecords(pool);
          await activateRecords(pool);
        }
        const store = createStore(pool, { records });
        server = await serve(createApplication({ store }));
        async function login(username) {
          const response = await fetch(server.url + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
            body: JSON.stringify({ username, password }),
          });
          assert.equal(response.status, 200);
          return {
            cookie: response.headers.get('set-cookie').split(';')[0],
            'Content-Type': 'application/json',
            'X-Han-Request': '1',
          };
        }
        const manager = await login('manager'),
          staff = await login('staff'),
          readonly = await login('readonly'),
          denied = await login('denied');
        async function move(documentId, expectedFolder, folder, headers = manager) {
          const response = await fetch(server.url + '/api/documents/folder', {
            method: 'POST',
            headers,
            body: JSON.stringify({ documentId, expectedFolder, folder }),
          });
          return { status: response.status, body: await response.json() };
        }
        if (records) {
          const list = async (params) => {
            const response = await fetch(
              server.url + '/api/records/documents?' + new URLSearchParams(params),
              { headers: manager },
            );
            assert.equal(response.status, 200, await response.clone().text());
            return response.json();
          };
          const first = await list({ folder: 'Marmara', status: 'Tümü', limit: '50' });
          assert.equal(first.totals.count, '52');
          assert.equal(first.items.length, 50);
          assert.equal(first.items[0].debtorFolder, 'Marmara');
          assert.equal(first.statusCounts['İnfaz'], '1');
          assert.equal(
            (await list({ folder: 'Marmara', status: 'Tümü', limit: '50', after: first.next })).items.length,
            2,
          );
          assert.equal((await list({ folder: 'Marmara', status: 'Derdest' })).totals.count, '51');
          assert.equal((await list({ folder: 'none' })).totals.count, '4');
        }
        for (const headers of [staff, readonly, denied])
          assert.equal((await move('doc-000', 'Marmara', 'Bursa', headers)).status, 403);
        assert.equal((await move('doc-000', 'Marmara', 'Invalid')).status, 400);
        assert.equal((await move('doc-000', '', 'Bursa')).status, 409);
        assert.equal((await move('absent', '', 'Bursa')).status, 404);
        for (const [i, name] of names.entries()) {
          const result = await move('doc-' + String(52 + i).padStart(3, '0'), '', name);
          assert.equal(result.status, 200, JSON.stringify(result.body));
        }
        assert.equal((await move('doc-000', 'Marmara', 'Bursa')).status, 200);
        assert.equal((await move('doc-000', 'Marmara', 'Ort.Kardnz')).status, 409);
        if (records) {
          const ceo = await login('test');
          const lease = async (action) => {
            const response = await fetch(server.url + '/api/documents/lease', {
              method: 'POST',
              headers: ceo,
              body: JSON.stringify({ documentId: 'doc-001', viewId: 'folder-test-window-01', action }),
            });
            return { status: response.status, body: await response.json() };
          };
          const acquired = await lease('acquire');
          assert.equal(acquired.status, 200, JSON.stringify(acquired.body));
          assert.equal((await move('doc-001', 'Marmara', 'Bursa')).status, 423);
          assert.equal((await lease('release')).status, 200);
          assert.equal((await move('doc-001', 'Marmara', 'Bursa')).status, 200);
        }
        const saved = await store.readState();
        const first = saved.data['icrapro-v1'].docs.find((d) => d.id === 'doc-000');
        assert.equal(first.debtorFolder, 'Bursa');
        assert.equal(first.status, 'İnfaz');
        assert.equal(first.amount, 100);
        assert.deepEqual(saved.data['hanhukuk-finance-v1'], s.data['hanhukuk-finance-v1']);
        assert.deepEqual(saved.data['hanhukuk-accounting-v1'], s.data['hanhukuk-accounting-v1']);
        assert.equal((await move('doc-000', 'Bursa', '')).status, 200);
        assert.equal(
          (await store.readState()).data['icrapro-v1'].docs.find((d) => d.id === 'doc-000').debtorFolder,
          undefined,
        );
      } finally {
        await server?.close();
        await pg.close();
      }
    },
  );
}

test('Folder buttons filter all statuses and the move form preserves the saved folder', (t) => {
  const dom = new JSDOM('<main id="content"></main><dialog id="modal"></dialog>', {
    runScripts: 'dangerously',
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  let saved;
  const doc = { id: 'one', number: '1', debtor: '<script>Example</script>', debtorFolder: 'Marmara' };
  Object.assign(w, {
    $: (selector) => w.document.querySelector(selector),
    esc: (value) =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    hanAuth: { role: 'admin' },
    documentTypes: {},
    debtorStatusFilter: 'Derdest',
    debtorColumnFilters: {},
    debtorListSort: { column: '', direction: '' },
    borrowerFilterMarkup: () => '',
    db: { docs: [doc], clients: [] },
    hanDataBaselines: new Map([['icrapro-v1', { docs: [{ ...doc }], clients: [] }]]),
    authApi: (url, method, input) => {
      saved = { url, method, input };
      return { ok: true };
    },
    toast: () => {},
  });
  for (const name of ['showModal', 'close'])
    w.HTMLDialogElement.prototype[name] = function () {
      this.open = name === 'showModal';
    };
  const root = path.join(__dirname, '../outputs/icrapro');
  w.eval(fs.readFileSync(path.join(root, 'debtor-folders.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'workspace-list-sort.js'), 'utf8'));
  w.eval(
    fs.readFileSync(path.join(root, 'document-records.js'), 'utf8') +
      '\nwindow.folderSelection=()=>debtorFolderFilter;',
  );
  w.docRows = () => {};
  w.borrowerFilterMarkup = () => '';
  w.bindBorrowerFilters = () => {};
  w.documents();
  const buttons = [...w.document.querySelectorAll('[data-debtor-folder]')];
  assert.deepEqual(
    buttons.slice(2).map((b) => b.textContent),
    [...names],
  );
  buttons.find((b) => b.textContent === 'Bursa').click();
  assert.equal(w.folderSelection(), 'Bursa');
  assert.equal(w.debtorStatusFilter, 'Tümü');
  assert.equal(w.document.querySelector('[data-debtor-folder="Bursa"]').getAttribute('aria-pressed'), 'true');
  w.borrowerFolderForm(doc);
  const form = w.document.querySelector('#borrowerFolderForm');
  assert.equal(form.elements.folder.value, 'Marmara');
  assert.equal(w.document.querySelectorAll('script').length, 0);
  form.elements.folder.value = 'Bursa';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(saved.url, '/api/documents/folder');
  assert.equal(saved.input.expectedFolder, 'Marmara');
  assert.equal(saved.input.folder, 'Bursa');
  assert.equal(doc.debtorFolder, 'Bursa');
  assert.equal(w.hanDataBaselines.get('icrapro-v1').docs[0].debtorFolder, 'Bursa');
});
