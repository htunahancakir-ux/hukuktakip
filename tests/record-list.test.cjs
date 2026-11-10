const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { parsers } = require('prettier/plugins/babel');
const root = path.resolve(__dirname, '../outputs/icrapro');

test('Folio searches match omitted leading zeros in column, advanced and global filters', (t) => {
  const dom = new JSDOM('', { runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const w = dom.window;
  const doc = {
    id: 'folio',
    number: 'S-0003',
    debtor: 'Synthetic',
    client: 'c',
    amount: 100,
    status: 'İnfaz',
  };
  Object.assign(w, {
    db: { clients: [{ id: 'c', name: 'Client' }] },
    personnel: [],
    debtorColumnFilters: { record: 'S-003' },
    docType: () => 'Senet',
    debtorStatus: (d) => d.status,
    money: String,
    displayDate: String,
    borrowerTrackingDate: () => '',
    clientPayoutClosureDate: () => '',
    borrowerAmount: () => 10000,
    docFinance: () => ({ target: 10000 }),
  });
  for (const [file, names] of [
    [
      'client-records.js',
      [
        'normalizeSearch',
        'matchesFolioNumber',
        'recordSearchText',
        'matchesGlobalSearch',
        'borrowerPhoneMatches',
      ],
    ],
    ['document-records.js', ['matchesDebtorColumns', 'filteredBorrowers']],
  ]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const node of parsers.babel.parse(source).program.body)
      if (node.type === 'FunctionDeclaration' && names.includes(node.id.name))
        w.eval(source.slice(node.start, node.end));
  }
  for (const query of ['S-003', 's-3', 'S-0003']) {
    w.debtorColumnFilters.record = query;
    assert.equal(w.matchesDebtorColumns(doc), true);
    assert.equal(w.matchesGlobalSearch(doc, w.db.clients[0], query), true);
    assert.equal(w.filteredBorrowers([doc], { number: query }, 'Tümü', '', true).length, 1);
  }
  assert.equal(w.matchesFolioNumber(doc.number, 'F-003'), false);
  assert.equal(w.matchesFolioNumber(doc.number, 'S-004'), false);
  assert.equal(w.matchesFolioNumber('S-0034', 'S-003'), false);
  assert.equal(w.filteredBorrowers([doc], { number: 'S-003' }, 'Derdest', '', true).length, 0);
});
test('Startup reads asynchronously and does not expose a partial or empty workspace after a failed request', async (t) => {
  const dom = new JSDOM('', { url: 'https://local-test.invalid', runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.structuredClone = structuredClone;
  const source = fs.readFileSync(path.join(root, 'auth.js'), 'utf8');
  w.eval(
    source.slice(0, source.indexOf('function authApi(')) +
      '\nwindow.initialData=()=>({cache:hanStartupData,baselines:hanDataBaselines});',
  );
  let fail = true;
  w.fetch = async (url) => {
    const key = new URL(url, 'https://local-test.invalid').searchParams.get('key');
    const value =
      key === 'icrapro-v1'
        ? { clients: [], docs: [] }
        : key === 'hanhukuk-accounting-v1'
          ? { accounts: [], entries: [] }
          : key === 'icrapro-settings-v1'
            ? {}
            : [];
    return {
      ok: !(fail && key === 'icrapro-v1'),
      headers: { get: () => '"revision"' },
      json: async () => value,
    };
  };
  await assert.rejects(w.preloadServerData(), /verileri alınamadı/);
  assert.equal(w.initialData().cache, null);
  assert.equal(w.initialData().baselines.size, 0);
  fail = false;
  await w.preloadServerData();
  assert.equal(w.initialData().cache.size, 6);
  assert.equal(w.initialData().baselines.size, 6);
  w.hanRecordsEnabled = true;
  const urls = [];
  w.fetch = async (url) => {
    urls.push(url);
    return {
      ok: true,
      json: async () => ({
        data: Object.fromEntries(w.initialData().cache),
        summary: {
          documents: '10000',
          clients: '1',
          activeDocuments: '10000',
          documentAmountCents: '100000000',
        },
      }),
    };
  };
  await w.preloadServerData();
  assert.deepEqual(urls, ['/api/records/bootstrap']);
  assert.equal(w.hanWorkspaceComplete, false);
  assert.equal(w.hanRecordSummary.documents, '10000');
});
test('Browser pages show all-record totals, escape labels and fetch only the selected file before editing', async (t) => {
  const dom = new JSDOM(
    `<input id="docSearch"><button id="clearDocSearch"></button><button data-status-filter="Tümü"></button><button data-status-filter="Derdest"></button><table><thead><tr><th id="closureDateHeading"></th><th id="debtorEntryDateHeading"><button id="sortDebtorEntryDate"></button></th><th><select id="debtorColumnStatus"><option>Derdest</option></select></th></tr></thead><tbody id="docRows"></tbody></table><div id="docSearchCount"></div>`,
    { url: 'https://local-test.invalid', runScripts: 'dangerously' },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    requests = [];
  Object.assign(w, {
    structuredClone,
    AbortController,
    hanRecordsEnabled: true,
    hanAuth: { role: 'ceo' },
    page: 'documents',
    borrowerFilters: {},
    debtorColumnFilters: {},
    debtorEntryDateSort: 0,
    debtorStatusFilter: 'Derdest',
    $: (selector) => w.document.querySelector(selector),
    db: { clients: [], docs: [] },
    financeEvents: [],
    accounting: { entries: [] },
    hanDataBaselines: new Map([
      ['icrapro-v1', { clients: [], docs: [] }],
      ['hanhukuk-finance-v1', []],
      ['hanhukuk-accounting-v1', { accounts: [], entries: [] }],
    ]),
    docType: (d) => d.docType,
    debtorStatus: (d) => d.status,
    borrowerAssignmentMarkup: () => '',
    clientPayoutClosureDate: (d) => d.closedDate,
    displayDate: (v) => v,
    money: (n) => String(n),
    docFinance: (d) => d._listFinance,
    borrowerTrackingDate: (d) => d.trackingDate,
    toast: (message) => {
      throw Error(message);
    },
    borrowerDetail: (id) => {
      w.opened = w.db.docs.find((d) => d.id === id);
    },
  });
  w.eval(fs.readFileSync(path.join(root, 'html-safety.js'), 'utf8'));
  w.esc = w.escapeHtml;
  const source = fs.readFileSync(path.join(root, 'document-records.js'), 'utf8');
  const paint = parsers.babel
    .parse(source)
    .program.body.find((n) => n.type === 'FunctionDeclaration' && n.id.name === 'paintDocumentRows');
  w.eval(source.slice(paint.start, paint.end));
  const totals = {
    count: '75',
    principalCents: '750000',
    targetCents: '750000',
    receivedCents: '1000',
    remainingCents: '749000',
  };
  w.fetch = async (url) => {
    requests.push(url);
    const parsed = new URL(url, 'https://local-test.invalid');
    if (parsed.pathname.endsWith('/document'))
      return {
        ok: true,
        json: async () => ({
          record: { id: 'd50', client: 'c', notes: 'authoritative' },
          client: { id: 'c', name: 'Client' },
          financialEvents: [{ id: 'payment', documentId: 'd50', amount: 1000 }],
          ledgerEntries: [],
        }),
      };
    const offset = parsed.searchParams.has('after') ? 50 : 0;
    return {
      ok: true,
      json: async () => ({
        items: Array.from({ length: offset ? 25 : 50 }, (_, i) => ({
          id: 'd' + (offset + i),
          number: 'D-' + i,
          status: 'Derdest',
          kind: 'Diğer',
          clientId: 'c',
          clientName: '<img src=x onerror=alert(1)>',
          debtor: 'Test',
          principalCents: '10000',
          targetCents: '10000',
          receivedCents: '0',
          remainingCents: '10000',
        })),
        totals,
        next: offset ? null : 'next',
        statusCounts: { Derdest: '75' },
      }),
    };
  };
  w.eval(fs.readFileSync(path.join(root, 'workspace-record-list.js'), 'utf8'));
  await w.loadRecordPage();
  assert.equal(
    w.document.querySelectorAll('#docRows tr').length,
    50,
    w.document.querySelector('#docSearchCount').textContent,
  );
  assert.match(w.document.querySelector('#docSearchCount').textContent, /1–50 \/ 75/);
  assert.match(w.document.querySelector('#docSearchCount').textContent, /7.490,00 TL/);
  assert.equal(w.document.querySelectorAll('img').length, 0);
  await w.loadRecordPage(1);
  assert.equal(w.document.querySelectorAll('#docRows tr').length, 25);
  assert.match(w.document.querySelector('#docSearchCount').textContent, /51–75 \/ 75/);
  assert.match(w.document.querySelector('#docSearchCount').textContent, /7.490,00 TL/);
  assert.equal(w.document.querySelectorAll('#docSearchCount button')[1].disabled, true);
  await w.recordAction('d50', () => w.borrowerDetail('d50'));
  assert.equal(w.opened.notes, 'authoritative');
  assert.equal(w.financeEvents.length, 1);
  assert.equal(w.hanDataBaselines.get('icrapro-v1').docs[0].notes, 'authoritative');
  assert(requests.every((url) => !url.startsWith('/api/data')));
  assert.equal(w.recordMoney('900719925474099199'), '9.007.199.254.740.991,99 TL');
});
