const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { parsers } = require('prettier/plugins/babel');

test('Borrower TC is optional: blank saves with warning and filled values keep format validation', (t) => {
  const dom = new JSDOM('', { runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const w = dom.window,
    messages = [];
  let saves = 0;
  w.eval(fs.readFileSync('outputs/icrapro/html-safety.js', 'utf8'));
  Object.assign(w, {
    esc: w.escapeHtml,
    structuredClone,
    $: (s) => w.document.querySelector(s),
    db: {
      docs: [
        {
          id: 'd',
          debtor: 'Synthetic',
          identity: '',
          officeIdentity: '00123456789',
          phone1: '05321234567',
          address: 'Address',
        },
      ],
    },
    docType: () => 'Senet',
    propertyFields: () => '',
    bindPropertyFields() {},
    setupClientCity() {},
    setupClientDistrict() {},
    clientCityField: () =>
      '<select name="city"><option>Test City</option></select><select name="district"><option>Test District</option></select>',
    guarantorExtraAddress: (d, base) =>
      `<select name="${base}City"></select><select name="${base}District"></select>`,
    turkeyCities: ['Test City'],
    turkeyDistricts: { 'Test City': ['Test District'] },
    validatePropertyFields: () => true,
    save: () => saves++,
    stats() {},
    page: 'test',
    toast: (message) => messages.push(message),
  });
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  for (const [file, name] of [
    ['form-inputs.js', 'field'],
    ['borrower-sheet.js', 'editBorrower'],
  ]) {
    const source = fs.readFileSync('outputs/icrapro/' + file, 'utf8');
    const node = parsers.babel
      .parse(source)
      .program.body.find((n) => n.type === 'FunctionDeclaration' && n.id.name === name);
    w.eval(source.slice(node.start, node.end));
  }
  w.editBorrower('d');
  let form = w.document.querySelector('#editBorrowerForm');
  assert.equal(form.elements.identity.required, false);
  assert.equal(form.elements.identity.dataset.optional, 'true');
  form.requestSubmit();
  assert.equal(saves, 1);
  assert.match(messages.at(-1), /Uyarı: TC bilgisi girilmedi/);
  assert.equal(w.db.docs[0].identity, '');
  assert.equal(w.db.docs[0].officeIdentity, '00123456789');
  w.editBorrower('d');
  form = w.document.querySelector('#editBorrowerForm');
  form.elements.identity.value = 'abc';
  form.requestSubmit();
  assert.equal(saves, 1);
  form.elements.identity.value = '12345678901';
  form.requestSubmit();
  assert.equal(saves, 2);
  assert.doesNotMatch(messages.at(-1), /Uyarı/);
});
const tick = async () => {
  for (let i = 0; i < 6; i++) await new Promise(setImmediate);
};

test('Additional intake copies parent fields before required validation, including dependent districts', (t) => {
  const dom = new JSDOM(
    '<form id="intakeForm"><input name="client" value="c80" disabled><input name="clientParty" value=""><input name="debtor" value="Parent borrower" disabled><input name="city" value="İstanbul" disabled><input name="district" value="Kadıköy" disabled></form><iframe></iframe>',
    { url: 'https://local-test.invalid', runScripts: 'dangerously' },
  );
  const w = dom.window.document.querySelector('iframe').contentWindow;
  t.after(() => {
    w.stopRequiredObserver();
    dom.window.close();
  });
  w.document.body.innerHTML =
    '<form id="intakeForm"><div class="notice"></div><div class="intake-record-header"></div><div class="record-form-tabs"></div><div data-form-panel="document"><div class="grid"><label><select name="client" required><option value="c80">Client</option></select></label><label><input name="clientParty" data-optional="true"></label><label><input name="amount" value="250" required></label><label><input name="due" value="2026-12-09" required></label></div></div><div data-form-panel="debtor"><input name="debtor" required><input name="city" required><input name="district" disabled required></div></form>';
  w.toast = (m) => {
    throw Error(m);
  };
  for (const file of ['document-records.js', 'personnel.js'])
    w.eval(
      fs.readFileSync(path.resolve(__dirname, '../outputs/icrapro', file), 'utf8') +
        (file === 'personnel.js'
          ? '\nwindow.stopRequiredObserver = () => requiredObserver.disconnect();'
          : ''),
    );
  const form = w.document.getElementById('intakeForm');
  form.elements.debtor.setCustomValidity('previous validation error');
  form.elements.city.addEventListener('change', () => {
    form.elements.district.disabled = !form.elements.city.value;
    form.elements.district.value = '';
  });
  w.prepareEmbeddedIntake(form);
  assert.equal(w.validateRequiredForm(form), true);
  assert.equal(form.elements.debtor.value, 'Parent borrower');
  assert.equal(new w.FormData(form).get('district'), 'Kadıköy');
  assert.equal(form.elements.amount.value, '250', 'additional document keeps its own amount');
});

test('Intake UI pages records, keeps totals complete and never saves search/receipt projections', async (t) => {
  const dom = new JSDOM(
    '<div id="stats"></div><input id="intakeSearch"><table><tbody id="intakeSearchResults"></tbody></table><div id="intakeSearchTotal"></div><input id="clientSearch"><select id="pick"><option value="">Select</option></select><small id="hint"></small><dialog id="modal"></dialog>',
    { url: 'https://local-test.invalid', runScripts: 'dangerously' },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    requests = [],
    notices = [];
  Object.assign(w, {
    structuredClone,
    AbortController,
    hanRecordsEnabled: true,
    hanWorkspaceComplete: false,
    embeddedIntake: false,
    page: 'intake',
    selected: '',
    hanAuth: { id: 'test', role: 'ceo' },
    $: (q) => w.document.querySelector(q),
    db: { clients: [], docs: [] },
    hanRecordSummary: { clients: '123' },
    hanDataBaselines: new Map([['icrapro-v1', { clients: [], docs: [] }]]),
    toast: (m) => notices.push(m),
  });
  for (const file of [
    'html-safety.js',
    'record-patch.js',
    'document-types.js',
    'document-records.js',
    'workspace-record-list.js',
    'workspace-intake.js',
  ])
    w.eval(fs.readFileSync(path.resolve(__dirname, '../outputs/icrapro', file), 'utf8'));
  w.esc = w.escapeHtml;
  assert.equal(w.recordPageNeedsCompatibility(), false);
  let rejectSave = false,
    submitted,
    batchResolve;
  const original = {
    id: 'one',
    client: 'c80',
    debtor: 'Debtor',
    number: 'S-0001',
    amount: 100,
    notes: 'old',
    future: { retained: true },
    fileData: 'data:application/pdf;base64,JVBERi0x',
  };
  w.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    const parsed = new URL(url, 'https://local-test.invalid');
    if (parsed.pathname === '/api/data/patch') {
      submitted = JSON.parse(options.body);
      assert.equal(parsed.searchParams.get('operation'), 'intake');
      return {
        ok: !rejectSave,
        json: async () =>
          rejectSave
            ? { error: 'Concurrent edit' }
            : {
                records: [
                  {
                    path: ['docs'],
                    id: 'one',
                    value: { ...original, notes: 'saved', fileData: undefined, canonical: true },
                    preservedFields: ['fileData'],
                  },
                ],
              },
      };
    }
    if (parsed.pathname === '/api/records/search') {
      const id = parsed.searchParams.get('id');
      return {
        ok: true,
        json: async () => ({
          more: !id,
          items: id
            ? [{ id, name: 'Selected client', identity: '10000000080' }]
            : Array.from({ length: 50 }, (_, i) => ({ id: 'c' + i, name: 'Client ' + i })),
        }),
      };
    }
    if (parsed.pathname === '/api/records/intake-batch')
      return new Promise((resolve) => {
        batchResolve = resolve;
      });
    assert.equal(parsed.pathname, '/api/records/documents', 'no full-workspace fallback');
    const after = parsed.searchParams.get('after');
    return {
      ok: true,
      json: async () => ({
        items: Array.from(
          { length: parsed.searchParams.get('limit') === '1' ? 1 : after ? 25 : 50 },
          (_, i) => ({
            id: 'd' + (i + (after ? 50 : 0)),
            number: 'S-' + i,
            kind: 'Senet',
            debtor: '<img src=x onerror=alert(1)>',
            clientName: 'Client',
            status: 'Derdest',
          }),
        ),
        totals: {
          count: parsed.searchParams.get('client') ? '3' : '75',
          principalCents: parsed.searchParams.get('client') ? '30000' : '750000',
        },
        next: after ? null : 'cursor',
      }),
    };
  };
  await w.loadRecordIntakePage();
  assert.equal(w.document.querySelectorAll('[data-edit-intake]').length, 50);
  assert.match(w.$('#intakeSearchTotal').textContent, /1–50 \/ 75/);
  assert.equal(w.document.querySelectorAll('img').length, 0, 'user names remain inert text');
  w.$('#nextIntake').click();
  await tick();
  assert.equal(w.document.querySelectorAll('[data-edit-intake]').length, 25);
  assert.match(w.$('#intakeSearchTotal').textContent, /51–75 \/ 75/);
  await w.renderRecordIntakeStats();
  assert.match(w.$('#stats').textContent, /75/);
  assert.match(w.$('#stats').textContent, /7.500/);
  const client = await w.ensureIntakeClient('c80');
  assert.equal(client.id, 'c80');
  w.setIntakeClientOption(w.$('#pick'), 'c80');
  w.bindIntakeClientSelect(w.$('#clientSearch'), w.$('#pick'), 'Select', w.$('#hint'));
  await tick();
  assert.equal(w.$('#pick').value, 'c80', 'selection outside first 50 must survive lookup');
  assert.equal(w.$('#pick').options.length, 52);
  assert.match(w.$('#hint').textContent, /50/);
  assert.equal(w.db.clients.length, 0, 'search projections never contaminate editable records');
  assert.equal(w.db.docs.length, 0);
  w.selected = 'c80';
  await w.renderRecordIntakeStats();
  assert.match(w.$('#stats').textContent, /Selected client/);
  assert.match(w.$('#stats').textContent, /300/);

  w.db.docs.push(structuredClone(original));
  w.hanDataBaselines.get('icrapro-v1').docs.push(structuredClone(original));
  const saved = await w.saveRecordIntake(original, { ...original, notes: 'saved' });
  assert.equal(submitted.changes.length, 1);
  assert.equal(submitted.changes[0].field, 'notes');
  assert.equal(saved.canonical, true);
  assert.equal(saved.fileData, original.fileData);
  assert.equal(w.db.docs[0].notes, 'saved');
  assert.equal(w.hanDataBaselines.get('icrapro-v1').docs[0].notes, 'saved');
  const snapshot = JSON.stringify(w.db);
  rejectSave = true;
  await assert.rejects(w.saveRecordIntake(saved, { ...saved, notes: 'reject me' }), /Concurrent edit/);
  assert.equal(JSON.stringify(w.db), snapshot, 'failed saves cannot mutate cached state');

  w.sessionStorage.setItem(w.intakeBatchKey(), JSON.stringify(['old-batch', 'missing']));
  assert.equal(w.intakeBatchIds().length, 2, 'reload must not discard IDs that are not yet cached');
  const hydrated = w.hydrateIntakeBatch();
  await tick();
  w.addToIntakeBatch('one');
  batchResolve({
    ok: true,
    json: async () => ({
      items: [
        {
          record: {
            id: 'old-batch',
            client: 'c80',
            number: 'S-1234',
            docType: 'Senet',
            amount: 42,
            debtor: 'Receipt debtor',
          },
          client: { id: 'c80', name: 'Selected client' },
        },
      ],
    }),
  });
  await hydrated;
  assert.deepEqual(
    Array.from(w.intakeBatchIds()),
    ['old-batch', 'one'],
    'nested form additions survive in-flight hydration',
  );
  assert.equal(w.db.docs.length, 1);
  assert.equal(w.db.clients.length, 0);
  Object.assign(w, {
    financeCents: (v) => Math.round(Number(v) * 100),
    money: (v) => v + ' TL',
    firmReceipt: () => '',
    businessDate: () => '2026-11-08',
    displayDate: (v) => v,
    addWhatsAppFileButton: () => {},
  });
  w.$('#modal').showModal = () => {};
  w.intakeBatchReceipt(true);
  assert.match(w.$('#modal').textContent, /Selected client/);
  assert.match(w.$('#modal').textContent, /S-1234/);
  assert.match(w.$('#modal').textContent, /142 TL/);
  assert.equal(notices.length, 0);
});
