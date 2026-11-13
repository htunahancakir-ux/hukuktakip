const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { parsers } = require('prettier/plugins/babel');

test('Personnel window uploads multiple files to its selected person and disables uploads without an owner', async (t) => {
  const dom = new JSDOM('<div id="content"></div>', {
    url: 'https://test.invalid',
    runScripts: 'dangerously',
  });
  t.after(() => dom.window.close());
  const w = dom.window,
    stored = [];
  const people = [
    { id: 'person-one', name: 'Person One', officialSalary: 1000 },
    { id: 'person-two', name: 'Person Two', officialSalary: 2000 },
  ];
  const original = JSON.stringify(people);
  w.eval(fs.readFileSync('outputs/icrapro/html-safety.js', 'utf8'));
  Object.assign(w, {
    structuredClone,
    esc: w.escapeHtml,
    $: (selector) => w.document.querySelector(selector),
    hanAuth: { role: 'ceo' },
    hanRecordsEnabled: true,
    personnel: people,
    personnelTab: 'files',
    personnelAttachmentStaffId: '',
    personnelPayrollTodayMonth: '2026-11',
    bonus2Month: '2026-11',
    dailyBonusMonth: '2026-11',
    page: 'personnel',
    businessDate: () => '2026-11-10',
    renderActiveOperator() {},
    loadCalculatedBonus2() {},
    authApi: (path) => (path.startsWith('/api/users') ? [] : { rows: [] }),
    toast() {},
    db: { clients: [], docs: [] },
    hanDataBaselines: new Map(),
  });
  for (const [file, names] of [
    ['client-records.js', ['bindMultipleFileInput', 'readSelectedFileAttachments']],
    ['workspace-record-list.js', ['saveRecordAttachments']],
    ['personnel.js', ['personnelSettings', 'personnelAttachmentsPage', 'readPersonnelAttachments']],
  ]) {
    const source = fs.readFileSync('outputs/icrapro/' + file, 'utf8');
    for (const node of parsers.babel.parse(source).program.body)
      if (node.type === 'FunctionDeclaration' && names.includes(node.id.name))
        w.eval(source.slice(node.start, node.end));
  }
  w.fetch = async (url, options = {}) => {
    if (url === '/api/record-attachments') {
      const body = JSON.parse(options.body);
      assert.equal(body.ownerType, 'personnel');
      assert.equal(body.ownerId, 'person-two');
      stored.push({ id: 'personnel:person-two:' + body.attachment.id, ...body });
      return { ok: true, json: async () => ({ ok: true }) };
    }
    const parsed = new URL(url, 'https://test.invalid');
    assert.equal(parsed.searchParams.get('personnelId'), 'person-two');
    const id = parsed.searchParams.get('attachmentId');
    return {
      ok: true,
      json: async () =>
        id
          ? { attachment: stored.find((row) => row.id === id).attachment }
          : {
              items: stored.map((row) => ({
                id: row.id,
                name: row.attachment.name,
                mime: row.attachment.mime,
              })),
            },
    };
  };
  const host = w.document.querySelector('#content');
  await w.personnelAttachmentsPage(host, '');
  assert.equal(w.document.querySelector('#personnelFilePicker').disabled, true);
  await w.personnelAttachmentsPage(host, 'person-two');
  const input = w.document.querySelector('#personnelFilePicker');
  for (const file of [
    new w.File(['%PDF-1.4'], '<first>.pdf', { type: 'application/pdf' }),
    new w.File(['photo'], 'photo.png', { type: 'image/png' }),
  ]) {
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new w.Event('change'));
  }
  await w.document.querySelector('#personnelFilesForm').onsubmit(new w.Event('submit', { cancelable: true }));
  assert.equal(stored.length, 2);
  assert(stored.every((file) => file.ownerId === 'person-two'));
  assert.equal(w.document.querySelectorAll('[data-personnel-file-list] section').length, 2);
  assert.equal(w.document.querySelector('first'), null);
  await w.document.querySelector('[data-personnel-file-list] button').onclick();
  assert.match(
    w.document.querySelector('[data-personnel-file-list] a').href,
    /^data:application\/pdf;base64,/,
  );
  assert.equal(w.document.querySelector('[data-personnel-file-list] a').download, '<first>.pdf');
  assert.equal(JSON.stringify(people), original, 'personnel/payroll metadata must never receive file bodies');
});

test('File selections accumulate and keep stable attachment IDs for retries', async (t) => {
  const dom = new JSDOM('<form><input id="files" type="file" multiple></form>', {
    url: 'https://test.invalid',
    runScripts: 'dangerously',
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  const source = fs.readFileSync('outputs/icrapro/client-records.js', 'utf8');
  for (const node of parsers.babel.parse(source).program.body)
    if (
      node.type === 'FunctionDeclaration' &&
      ['bindMultipleFileInput', 'readSelectedFileAttachments'].includes(node.id.name)
    )
      w.eval(source.slice(node.start, node.end));
  const input = w.document.querySelector('#files');
  w.bindMultipleFileInput(input);
  const pdf = new w.File(['%PDF-1.4'], '<first>.pdf', { type: 'application/pdf', lastModified: 1 });
  const photo = new w.File(['photo'], 'second.png', { type: 'image/png', lastModified: 2 });
  for (const file of [pdf, photo, pdf]) {
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new w.Event('change'));
  }
  assert.equal(input._attachmentQueue.length, 2);
  assert.equal(w.document.querySelector('first'), null);
  const selected = await w.readSelectedFileAttachments(input, 'auto', 3);
  const retry = await w.readSelectedFileAttachments(input, 'auto', 3);
  assert.deepEqual(
    Array.from(retry, (file) => file.id),
    Array.from(selected, (file) => file.id),
  );
  assert.equal(selected[0].mime, 'application/pdf');
  assert.equal(selected[1].kind, 'photo');
  w.document.querySelector('button').click();
  assert.equal(input._attachmentQueue.length, 1);
});

test('Client and document saves upload separately and resume a partial upload without duplicating the record', async (t) => {
  const dom = new JSDOM('', { url: 'https://test.invalid', runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const w = dom.window;
  Object.assign(w, {
    structuredClone,
    db: { clients: [], docs: [] },
    hanDataBaselines: new Map([['icrapro-v1', { clients: [], docs: [] }]]),
  });
  for (const file of [
    'record-patch.js',
    'workspace-record-list.js',
    'workspace-intake.js',
    'workspace-client-list.js',
  ])
    w.eval(fs.readFileSync('outputs/icrapro/' + file, 'utf8'));
  let state = { clients: [], docs: [] },
    saves = 0;
  const failures = new Set(),
    uploads = new Map();
  w.fetch = async (url, options) => {
    const value = JSON.parse(options.body);
    if (url.startsWith('/api/data/patch')) {
      saves++;
      assert.equal(options.body.includes('base64,'), false, 'metadata requests must not contain file bodies');
      state = w.HanRecordPatch.apply('icrapro-v1', state, value);
      const change = value.changes[0],
        record = state[change.path[0]].find((row) => row.id === change.id);
      if (change.path[0] === 'docs')
        Object.assign(record, { number: 'S-0001', created: '2026-11-10', trackingDate: '2026-11-10' });
      return {
        ok: true,
        json: async () => ({
          records: [{ path: change.path, id: record.id, value: structuredClone(record) }],
        }),
      };
    }
    const key = value.ownerType + ':' + value.attachment.id;
    if (value.attachment.id === 'second' && !failures.has(key)) {
      failures.add(key);
      return { ok: false, json: async () => ({ error: 'Synthetic upload failure' }) };
    }
    uploads.set(key, (uploads.get(key) || 0) + 1);
    return { ok: true, json: async () => ({ ok: true }) };
  };
  for (const [kind, save] of [
    ['client', w.saveRecordClient],
    ['document', w.saveRecordIntake],
  ]) {
    const record = {
      id: kind,
      name: 'Client',
      client: 'client',
      debtor: 'Synthetic',
      amount: 100,
      attachments: [
        { id: 'first', name: 'one.pdf', data: 'data:application/pdf;base64,JVBERi0x' },
        { id: 'second', name: 'two.png', data: 'data:image/png;base64,iVBORw0KGgo=' },
      ],
    };
    await assert.rejects(save(null, record), /Synthetic upload failure/);
    await save(null, record);
    assert.equal((kind === 'client' ? w.db.clients : w.db.docs).filter((row) => row.id === kind).length, 1);
    assert.equal(
      (kind === 'client' ? w.db.clients : w.db.docs).find((row) => row.id === kind).attachments.length,
      2,
    );
    assert.equal(uploads.get(kind + ':first'), 1);
    assert.equal(uploads.get(kind + ':second'), 1);
  }
  assert.equal(saves, 2, 'retry must not recreate or overwrite a saved record');
});

test('Borrower TC is optional: blank saves with warning and filled values keep format validation', (t) => {
  const dom = new JSDOM('', { runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const w = dom.window,
    messages = [];
  let saves = 0;
  w.eval(fs.readFileSync('outputs/icrapro/html-safety.js', 'utf8'));
  w.eval(fs.readFileSync('outputs/icrapro/phone-format.js', 'utf8'));
  w.eval(fs.readFileSync('outputs/icrapro/borrower-addresses.js', 'utf8'));
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
          additionalPhones: ['05321234568', '05321234569'],
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
    ['document-records.js', 'borrowerPartyFields'],
    ['document-records.js', 'setupBorrowerPartyFields'],
    ['borrower-sheet.js', 'editBorrower'],
    ['borrower-sheet.js', 'bindBorrowerExtraPhones'],
  ]) {
    const source = fs.readFileSync('outputs/icrapro/' + file, 'utf8');
    const node = parsers.babel
      .parse(source)
      .program.body.find((n) => n.type === 'FunctionDeclaration' && n.id.name === name);
    w.eval(source.slice(node.start, node.end));
  }
  w.editBorrower('d');
  let form = w.document.querySelector('#editBorrowerForm');
  // Numbers added earlier from the call panel fill the empty Tel-2, then Tel-3.
  assert.equal(form.elements.phone2.value, '05321234568');
  assert.deepEqual(
    [...form.querySelectorAll('[data-extra-phone-label]')].map((l) => l.textContent),
    ['Tel-3'],
  );
  assert.equal(form.querySelector('[data-extra-phone]').value, '05321234569');
  assert.equal(form.elements.identity.required, false);
  assert.equal(form.elements.identity.dataset.optional, 'true');
  form.requestSubmit();
  assert.equal(saves, 1);
  assert.match(messages.at(-1), /Uyarı: TC bilgisi girilmedi/);
  assert.equal(w.db.docs[0].identity, '');
  assert.equal(w.db.docs[0].officeIdentity, '00123456789');
  assert.equal(w.db.docs[0].phone2, '05321234568');
  assert.deepEqual([...w.db.docs[0].additionalPhones], ['05321234569']);
  w.editBorrower('d');
  form = w.document.querySelector('#editBorrowerForm');
  form.querySelector('[data-add-extra-phone]').click();
  form.querySelectorAll('[data-extra-phone]')[1].value = '05321234570';
  assert.equal(form.querySelectorAll('[data-extra-phone-label]')[1].textContent, 'Tel-4');
  form.requestSubmit();
  assert.equal(saves, 2);
  assert.deepEqual([...w.db.docs[0].additionalPhones], ['05321234569', '05321234570']);
  w.editBorrower('d');
  form = w.document.querySelector('#editBorrowerForm');
  form.elements.identity.value = 'abc';
  form.requestSubmit();
  assert.equal(saves, 2);
  form.elements.identity.value = '12345678901';
  form.requestSubmit();
  assert.equal(saves, 3);
  assert.doesNotMatch(messages.at(-1), /Uyarı/);
});
const tick = async () => {
  for (let i = 0; i < 6; i++) await new Promise(setImmediate);
};

test('Additional intake copies parent fields before required validation, including dependent districts', (t) => {
  const dom = new JSDOM(
    '<form id="intakeForm"><select name="client" disabled><option value="c80" selected>Selected client</option></select><input name="clientParty" value=""><input name="debtor" value="Parent borrower" disabled><input name="city" value="İstanbul" disabled><input name="district" value="Kadıköy" disabled></form><iframe></iframe>',
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
  // The child lookup may still be loading or not contain a client outside its first page.
  form.elements.client.replaceChildren(new w.Option('Müvekkil seçin', ''));
  assert.equal(w.copySharedIntakeFields(form), true);
  assert.equal(form.elements.client.value, 'c80');
  assert.equal(form.elements.client.selectedOptions[0].textContent, 'Selected client');
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
      const start = Number(parsed.searchParams.get('after') || 0);
      const end = Math.min(start + 50, 123);
      return {
        ok: true,
        json: async () => ({
          more: !id && end < 123,
          next: !id && end < 123 ? String(end) : null,
          items: id
            ? [{ id, name: 'Selected client', identity: '10000000080' }]
            : Array.from({ length: end - start }, (_, i) => ({
                id: 'c' + (start + i),
                name: start + i === 80 ? 'Selected client' : 'Client ' + (start + i),
              })),
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
  assert.equal(w.$('#pick').options.length, 124);
  assert.equal(new Set(Array.from(w.$('#pick').options, (option) => option.value)).size, 124);
  assert.match(w.$('#hint').textContent, /123/);
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
