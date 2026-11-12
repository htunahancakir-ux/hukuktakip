const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs');
const { JSDOM } = require('jsdom'),
  { parsers } = require('prettier/plugins/babel');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');
function load(w, file, names) {
  const s = fs.readFileSync('outputs/icrapro/' + file, 'utf8');
  for (const n of parsers.babel.parse(s).program.body)
    if (n.type === 'FunctionDeclaration' && names.includes(n.id.name)) w.eval(s.slice(n.start, n.end));
}
test('Client company controls and borrower type controls stay optional across type changes and real form saves', async () => {
  const dom = new JSDOM('<dialog id="modal"></dialog>', {
      url: 'http://localhost',
      runScripts: 'dangerously',
    }),
    w = dom.window;
  try {
    w.HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    w.HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
    };
    const notices = [];
    Object.assign(w, {
      $: (q) => w.document.querySelector(q),
      esc: (v) => String(v ?? ''),
      db: { clients: [], docs: [] },
      kind: 'Şahıs',
      personnel: [{ id: 'p', name: 'Personel', active: true }],
      hanAuth: { role: 'staff' },
      turkeyCities: ['İstanbul'],
      turkeyDistricts: { İstanbul: ['Kadıköy'] },
      setupClientCity() {},
      setupClientDistrict() {},
      setupExtraContacts() {},
      bindMultipleFileInput() {},
      readExtraContacts: () => ({}),
      validStaffSelection: () => true,
      clientDebtorIdentityConflict: () => '',
      collectClientAttachments: async () => [],
      save() {},
      render() {},
      toast: (m) => notices.push(m),
      staffSelect: (label, name, value = '') =>
        `<label class="field">${label}<select name="${name}"><option value="">Seçin</option><option value="p" ${value === 'p' ? 'selected' : ''}>Personel</option></select></label>`,
    });
    load(w, 'form-inputs.js', ['field']);
    load(w, 'document-records.js', [
      'setupRecordFormTabs',
      'recordFieldGroup',
      'borrowerPartyFields',
      'setupBorrowerPartyFields',
    ]);
    load(w, 'client-records.js', [
      'clientModal',
      'clientCityField',
      'clientAttachmentFields',
      'syncClientCompanyFields',
      'validClientIban',
    ]);
    load(w, 'personnel.js', ['mandatoryControls', 'enforceRequired']);
    w.clientModal();
    let form = w.document.getElementById('clientForm');
    assert.equal(form.elements.taxOffice.closest('label').hidden, true);
    const choose = (type) => form.querySelector(`[data-kind="${type}"]`).click();
    choose('Şirket');
    assert.equal(form.elements.taxOffice.closest('label').hidden, false);
    w.enforceRequired(form);
    for (const name of ['taxOffice', 'mersisNumber']) {
      assert.equal(form.elements[name].required, false);
      assert.equal(form.elements[name].checkValidity(), true);
    }
    for (const [name, value] of Object.entries({
      tradeName: 'Örnek Firma',
      identity: '1234567890',
      city: 'İstanbul',
      district: 'Kadıköy',
      clientCategory: 'Yediemin',
      recordedBy: 'p',
      documentStaff: 'p',
      address: 'Adres',
      phone: '05551234567',
      reference: 'Referans',
      bankName: 'Banka',
      bankBranch: 'Şube',
      accountHolder: 'Örnek Firma',
    }))
      form.elements[name].value = value;
    await form.onsubmit({ preventDefault() {}, target: form });
    assert.equal(w.db.clients.length, 1, notices.join('; '));
    assert.equal(w.db.clients[0].taxOffice, '');
    assert.equal(w.db.clients[0].mersisNumber, '');
    const id = w.db.clients[0].id;
    w.clientModal(id);
    form = w.document.getElementById('clientForm');
    choose('Şahıs Şirketi');
    form.elements.taxOffice.value = ' Kadıköy ';
    form.elements.mersisNumber.value = ' 0012345678901234 ';
    choose('Şahıs');
    assert.equal(form.elements.mersisNumber.disabled, true);
    choose('Şahıs Şirketi');
    assert.equal(form.elements.mersisNumber.value, ' 0012345678901234 ');
    await form.onsubmit({ preventDefault() {}, target: form });
    assert.equal(w.db.clients[0].type, 'Şahıs Şirketi');
    assert.equal(w.db.clients[0].taxOffice, 'Kadıköy');
    assert.equal(w.db.clients[0].mersisNumber, '0012345678901234');
    w.clientModal(id);
    form = w.document.getElementById('clientForm');
    assert.equal(form.elements.mersisNumber.value, '0012345678901234');
    const borrower = w.document.createElement('form');
    borrower.innerHTML = w.borrowerPartyFields() + w.field('TC Kimlik / Vergi No', 'identity');
    w.document.body.append(borrower);
    w.setupBorrowerPartyFields(borrower);
    assert.equal(borrower.elements.taxOffice.closest('label').hidden, true);
    for (const type of ['Şirket', 'Şahıs Şirketi']) {
      borrower.elements.debtorType.value = type;
      borrower.elements.debtorType.dispatchEvent(new w.Event('change'));
      w.enforceRequired(borrower);
      assert.equal(borrower.elements.taxOffice.closest('label').hidden, false);
      assert(borrower.elements.identity.closest('label').textContent.includes('Vergi No'));
      assert.equal(borrower.elements.taxOffice.required, false);
      assert.equal(borrower.elements.identity.required, false);
      assert.equal(borrower.checkValidity(), true);
    }
  } finally {
    dom.window.close();
  }
});
test('Authorized staff can persist optional client and borrower business fields on creation and later edits', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const s = fixture();
    s.users.push({
      ...s.users[0],
      id: 'staff',
      username: 'staff',
      role: 'staff',
      permissions: ['clients', 'documents'],
    });
    s.data['icrapro-v1'].clients = [{ id: 'c', name: 'Firma', type: 'Şirket', notes: 'Korunacak' }];
    await importState(pool, s);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(require('../lib/application.cjs').createApplication({ store }));
    const login = await fetch(server.url + '/api/login', {
      method: 'POST',
      headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'staff', password }),
    });
    assert.equal(login.status, 200);
    const headers = {
      cookie: login.headers.get('set-cookie').split(';')[0],
      'X-Han-Request': '1',
      'Content-Type': 'application/json',
    };
    const patch = async (before, after, intake = false) => {
      const r = await fetch(
        server.url + '/api/data/patch?key=icrapro-v1' + (intake ? '&operation=intake' : ''),
        { method: 'PUT', headers, body: JSON.stringify(diff('icrapro-v1', before, after)) },
      );
      return { status: r.status, body: await r.json() };
    };
    const client = s.data['icrapro-v1'].clients[0];
    let result = await patch(
      { clients: [client], docs: [] },
      { clients: [{ ...client, taxOffice: 'Kadıköy', mersisNumber: '0012345678901234' }], docs: [] },
    );
    assert.equal(result.status, 200, JSON.stringify(result));
    const doc = {
      id: 'd',
      client: 'c',
      debtor: 'Şirket Borçlu',
      debtorType: 'Şirket',
      taxOffice: '',
      identity: '',
      docType: 'Senet',
      amount: 100,
    };
    result = await patch({ clients: [], docs: [] }, { clients: [], docs: [doc] }, true);
    assert.equal(result.status, 200, JSON.stringify(result));
    let saved = await store.readState(),
      old = saved.data['icrapro-v1'].docs[0];
    assert.equal(old.debtorType, 'Şirket');
    assert.equal(old.taxOffice, '');
    assert.equal(old.identity, '');
    result = await patch(
      { clients: [], docs: [old] },
      {
        clients: [],
        docs: [{ ...old, debtorType: 'Şahıs Şirketi', taxOffice: 'Üsküdar', identity: '12345678901' }],
      },
      true,
    );
    assert.equal(result.status, 200, JSON.stringify(result));
    saved = await store.readState();
    const c = saved.data['icrapro-v1'].clients[0],
      d = saved.data['icrapro-v1'].docs[0];
    assert.equal(c.mersisNumber, '0012345678901234');
    assert.equal(c.taxOffice, 'Kadıköy');
    assert.equal(c.notes, 'Korunacak');
    assert.equal(d.debtorType, 'Şahıs Şirketi');
    assert.equal(d.taxOffice, 'Üsküdar');
    assert.equal(d.identity, '12345678901');
  } finally {
    await server?.close();
    await pg.close();
  }
});
