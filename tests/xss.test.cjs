const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { parsers } = require('prettier/plugins/babel');

const root = path.resolve(__dirname, '../outputs/icrapro');
const attack = '<img src=x onerror="window.__xss=1"><svg onload="window.__xss=1"></svg>';
const attributeAttack = '\" autofocus onfocus="window.__xss=1" data-injected="yes';
const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n%%EOF').toString('base64');
const photo = 'data:image/png;base64,iVBORw0KGgo=';
const modules = [
  'app.js',
  'form-inputs.js',
  'client-records.js',
  'document-records.js',
  'borrower-sheet.js',
  'finance-operations.js',
  'workspace-reminders.js',
  'workspace-reports.js',
  'settings.js',
  'employee-terms.js',
];

// Load the real rendering functions without startup timers, auth or live APIs.
const renderers = modules
  .map((file) => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    return parsers.babel
      .parse(source)
      .program.body.filter((node) => node.type === 'FunctionDeclaration')
      .map((node) => source.slice(node.start, node.end))
      .join('\n');
  })
  .join('\n');

function browser(t) {
  const dom = new JSDOM(
    '<div id="count"></div><div id="stats"></div><input id="search"><div id="total"></div><table><tbody id="rows"></tbody></table><dialog id="modal"></dialog><div id="content"></div>',
    {
      url: 'https://local-test.invalid/',
      runScripts: 'dangerously',
    },
  );
  t.after(() => dom.window.close());
  const w = dom.window;
  w.eval(fs.readFileSync(path.join(root, 'html-safety.js'), 'utf8'));
  w.eval(renderers);
  Object.assign(w, {
    $: (selector) => w.document.querySelector(selector),
    esc: w.escapeHtml,
    money: (n) => new Intl.NumberFormat('tr-TR').format(n) + ' TL',
    updateActiveDebtorCount() {},
    renderClientSuggestions() {},
    normalizeSearch: (v) => String(v || '').toLocaleLowerCase('tr'),
    docType: () => 'Senet',
    documentExtraReceipt: () => '',
    addWhatsAppFileButton() {},
    businessDate: () => '2026-11-07',
    personnel: [],
    financeEvents: [],
    accounting: { entries: [] },
    config: { firm: { name: attack }, preferences: {}, contact: {} },
    toast(message) {
      throw Error(message);
    },
  });
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  return w;
}

function assertInert(w, root = w.document) {
  assert.equal(root.querySelectorAll('script, [data-injected]').length, 0);
  for (const node of root.querySelectorAll('*')) {
    for (const attr of node.attributes) assert.ok(!/^on/i.test(attr.name), attr.name);
    for (const event of ['error', 'load', 'focus']) node.dispatchEvent(new w.Event(event));
  }
  assert.equal(w.__xss, undefined, 'User input executed as script');
}

test('XSS harness executes a vulnerable handler; production field output stays literal', (t) => {
  const w = browser(t),
    host = w.document.getElementById('content');
  host.innerHTML = '<img onerror="window.__xss=1">';
  host.firstChild.dispatchEvent(new w.Event('error'));
  assert.equal(w.__xss, 1);
  delete w.__xss;
  const value = 'İpek Şahin & O\'Connor "<örnek>" ' + attack + attributeAttack;
  host.innerHTML = w.field('Açıklama', 'note', 'text', value);
  assert.equal(host.querySelector('input').value, value);
  assertInert(w);
});

test('selected client card and record IDs cannot create elements or event attributes', (t) => {
  const w = browser(t);
  w.db = { clients: [{ id: attributeAttack, name: attack, identity: '', type: 'Şahıs' }], docs: [] };
  w.page = 'intake';
  w.selected = attributeAttack;
  w.stats();
  assert.ok(w.document.getElementById('stats').textContent.includes(attack));
  w.clientRows();
  assert.equal(w.document.querySelector('[data-edit]').dataset.edit, attributeAttack);
  assert.ok(w.document.querySelector('#rows').textContent.includes(attack));
  assertInert(w);
});

test('receipt rejects attribute breakout and executable URLs while preserving notes', (t) => {
  const w = browser(t);
  w.db = {
    clients: [{ id: 'client', name: attack }],
    docs: [
      {
        id: 'doc',
        client: 'client',
        number: 'D-001',
        debtor: attack,
        notes: attack,
        due: attack,
        created: '2026-11-07',
        amount: 100,
        fileData: '\"><img src=x onerror="window.__xss=1">',
        photoData: 'javascript:window.__xss=1',
        fileName: attack,
        photoFileName: attack,
      },
    ],
  };
  w.receipt('doc');
  assert.equal(w.document.querySelectorAll('#modal a, #modal img').length, 0);
  assert.ok(w.document.getElementById('modal').textContent.includes(attack));
  assertInert(w);
  w.db.docs[0].fileData = pdf;
  w.db.docs[0].photoData = photo;
  w.receipt('doc');
  const links = [...w.document.querySelectorAll('#modal a')];
  assert.deepEqual(
    links.map((a) => a.getAttribute('href')),
    [pdf, photo],
  );
  assert.deepEqual(
    links.map((a) => a.download),
    [attack, attack],
  );
  assertInert(w);
});

test('attachment editors and previews allow only strict PDF/raster data URLs', (t) => {
  const w = browser(t),
    host = w.document.getElementById('content');
  const forbidden = [
    'javascript:window.__xss=1',
    'JaVaScRiPt:window.__xss=1',
    'java\nscript:window.__xss=1',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'https://external.invalid/attachment.html',
    '//external.invalid/file',
    pdf + '\" onload="window.__xss=1',
    photo + '#fragment',
    'data:image/png;base64,abc',
  ];
  for (const data of forbidden) {
    assert.equal(w.safeAttachmentUrl(data), '', data);
    host.innerHTML =
      w.clientAttachmentFields({ attachments: [{ data, kind: 'photo', name: attack }] }) +
      w.clientAttachmentPreviews({ attachments: [{ data, name: attack }] }) +
      w.borrowerAttachmentPreviews({ fileData: data, photoData: data });
    assert.equal(host.querySelectorAll('a[href], img, object').length, 0, data);
    assertInert(w);
  }
  const attachments = [
    { data: pdf, kind: 'powerOfAttorney', name: 'Vekâletname & sözleşme.pdf' },
    { data: photo, kind: 'photo', name: 'İpek.png' },
  ];
  host.innerHTML = w.clientAttachmentFields({ attachments }) + w.clientAttachmentPreviews({ attachments });
  assert.equal(host.querySelectorAll('a').length, 4);
  assert.equal(host.querySelector('object').getAttribute('data'), pdf);
  assert.equal(host.querySelector('img').getAttribute('src'), photo);
  assertInert(w);
});

test('date-shaped fields remain text in payment promises, installments and reports', (t) => {
  const w = browser(t),
    host = w.document.getElementById('content');
  const definition = { columns: [['debtor', 'Borçlu']] };
  const rows = [{ date: attack, documentId: attributeAttack, cells: { debtor: attack } }];
  w.docFinance = () => ({ remaining: 100, received: 0, target: 100 });
  host.innerHTML =
    w.paymentPromiseSummary({ paymentPromise: { date: attack, description: attack, amount: 100 } }) +
    w.repaymentSection({
      id: attributeAttack,
      status: 'Derdest',
      repaymentPlan: {
        receivedAtCreation: 0,
        targetAtCreation: 100,
        balance: 100,
        installments: [{ due: attack, amount: 100 }],
      },
    }) +
    w.reportTable(definition, rows, new Set([attributeAttack]));
  assert.ok(host.textContent.includes(attack));
  assert.equal(host.querySelector('[data-report-borrower]').dataset.reportBorrower, attributeAttack);
  assertInert(w);
});

test('printed report srcdoc encodes titles, filters and stored values', (t) => {
  const w = browser(t);
  w.currentReport = () => ({
    definition: { label: attack, columns: [['debtor', 'Borçlu']] },
    rows: [{ date: attack, cells: { debtor: attack } }],
  });
  w.reportFilters = { from: attack, to: attack };
  w.printReport();
  const markup = w.document.querySelector('iframe').srcdoc;
  const printed = new JSDOM(markup, { runScripts: 'dangerously' });
  t.after(() => printed.window.close());
  assert.equal(printed.window.document.title, attack);
  assert.ok(printed.window.document.body.textContent.includes(attack));
  assertInert(printed.window);
});

test('terms are plain text and external links reject active protocols', (t) => {
  const w = browser(t),
    host = w.document.getElementById('content');
  const doc = {
    domain: 'https://www.hanhukuktakip.com',
    controllerName: attack,
    version: attack,
    issuedAt: '2026-11-07',
    sections: [{ title: attack, highlight: attack, text: attack }],
  };
  for (const url of [
    'javascript:window.__xss=1',
    'data:text/html,abc',
    '//bad.invalid',
    'https://user:pass@example.org',
  ]) {
    assert.equal(w.termsNoticeLink({ url, version: '1' }), '');
  }
  host.innerHTML =
    w.termsDocumentMarkup(doc) +
    w.termsNoticeLink({
      url: 'https://example.org/notice?q=%22&v=1',
      version: attack,
    });
  assert.ok(host.textContent.includes(attack));
  assert.equal(host.querySelector('a').protocol, 'https:');
  assertInert(w);
});
