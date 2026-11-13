const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { parsers } = require('prettier/plugins/babel');

test('Full intake saves Senet and Ekstre then appends Fatura to the same folio; existing Senet can add another type', async (t) => {
  const dom = new JSDOM(
    '<div class="heading"></div><div id="content"></div><select id="clientScope"></select><dialog id="modal"></dialog>',
    { url: 'https://test.invalid', runScripts: 'dangerously' },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    notices = [];
  Object.assign(w, {
    structuredClone,
    $: (s) => w.document.querySelector(s),
    esc: (value) =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    money: (value) => String(value),
    financeCents: (value) => Math.round(Number(value || 0) * 100),
    formatAmountInput: (value) => String(value),
    businessDate: () => '2026-11-11',
    borrowerTrackingDate: () => '2026-11-11',
    db: { clients: [{ id: 'c', name: 'Client' }], docs: [] },
    selected: 'c',
    embeddedIntake: false,
    hanAuth: { role: 'ceo' },
    personnel: [{ id: 'p', name: 'Person', active: true }],
    financeEvents: [],
    turkeyCities: ['İstanbul'],
    turkeyDistricts: { İstanbul: ['Kadıköy'] },
    normalizeSearch: (value) => String(value || '').toLocaleLowerCase('tr'),
    propertyFields: () => '',
    bindPropertyFields() {},
    validatePropertyFields: () => true,
    clientDebtorIdentityConflict: () => '',
    save() {},
    stats() {},
    toast: (message) => notices.push(message),
    setupParkingCapture() {},
    safeAttachmentUrl: () => '',
    automaticLegalCharges() {},
    offerSameIdentityChain() {},
    renderActiveOperator() {},
  });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  for (const file of [
    'phone-format.js',
    'borrower-addresses.js',
    'form-inputs.js',
    'parking-fees.js',
    'receivable-rules.js',
    'document-types.js',
    'workspace-receivables.js',
    'client-records.js',
    'document-records.js',
    'borrower-sheet.js',
  ]) {
    const script = w.document.createElement('script');
    script.textContent = fs.readFileSync('outputs/icrapro/' + file, 'utf8');
    w.document.body.append(script);
  }
  const personnelSource = fs.readFileSync('outputs/icrapro/personnel.js', 'utf8');
  for (const node of parsers.babel.parse(personnelSource).program.body)
    if (
      node.type === 'FunctionDeclaration' &&
      [
        'isRealPersonnelRecord',
        'staffSelect',
        'mandatoryControls',
        'enforceRequired',
        'validateRequiredForm',
      ].includes(node.id.name)
    )
      w.eval(personnelSource.slice(node.start, node.end));
  w.bindIntakeSearch = () => {};
  w.propertyFields = () => '';
  w.bindPropertyFields = () => {};
  w.validatePropertyFields = () => true;
  w.offerSameIdentityChain = () => {};
  w.renderClientScope = () => {};
  w.save = () => w.localStorage.setItem('icrapro-v1', JSON.stringify(w.db));
  w.save();
  w.intake();
  let form = w.$('#intakeForm');
  assert.equal(form.hidden, false, 'intake opens a blank folio directly');
  assert.equal(form.classList.contains('intake-borrower-sheet'), true);
  assert(
    form.elements.receivedBy.closest('.sheet-metadata'),
    'receiving personnel remains visible in the sheet header',
  );
  assert.equal(form.elements.receivedBy.disabled, false);
  assert(
    form.elements.receivedBy.compareDocumentPosition(form.elements.recordedBy) &
      w.Node.DOCUMENT_POSITION_FOLLOWING,
  );
  assert([...form.elements.receivedBy.options].some((option) => option.value === 'p'));
  const tabs = form.querySelectorAll('.intake-sheet-tabs button');
  assert.equal(tabs[0].textContent, 'Kimlik ve İletişim');
  assert.equal(tabs[1].textContent, 'Alacak');
  assert.equal(form.dataset.activeFormTab, 'debtor');
  assert.equal(form.querySelector('[data-draft-balance="9"]').textContent, '0');
  const inlinePhone = form.querySelector('[data-draft-meta="phone1"]');
  inlinePhone.value = '05551234567';
  inlinePhone.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(form.elements.phone1.value, '05551234567');
  form.elements.phone1.value = '';
  assert.equal(form.querySelectorAll('[data-select-claim]').length, 0);
  for (const [key, value] of Object.entries({
    client: 'c',
    debtor: 'Borrower',
    phone1: '05551234567',
    city: 'İstanbul',
    address: 'Address',
    receivedBy: 'p',
    recordedBy: 'p',
    deliveredBy: 'Sender',
  })) {
    form.elements[key].value = value;
    form.elements[key].dispatchEvent(new w.Event('change'));
  }
  form.elements.district.value = 'Kadıköy';
  form.elements.originalDocument.value = 'Alındı';
  assert.equal(form.elements.officeAddress3, undefined);
  assert.equal(form.elements.address2, undefined);
  assert.equal(form.querySelectorAll('[data-borrower-address-row]').length, 0);
  form.elements.addressSource.value = 'Kendisi';
  form.querySelector('[data-add-borrower-address]').click();
  const addedAddress = form.querySelector('[data-borrower-address-row]');
  addedAddress.querySelector('[data-address-field="address"]').value = 'İkinci adres';
  addedAddress.querySelector('[data-address-field="source"]').value = 'Muhtarlık';
  const sourceHeader = form.querySelector('[data-draft-meta="phoneSource"]');
  assert.equal(sourceHeader.value, '');
  assert.equal(sourceHeader.required, false);
  sourceHeader.value = 'İş yeri / Ayşe';
  sourceHeader.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(form.elements.phone1._phoneSourceInput.value, 'İş yeri / Ayşe');
  const add = (type, amount, due) => {
    form.querySelector('[data-doc-type="' + type + '"]').click();
    const row = form.querySelector('[data-receivable-rows]>section:last-child');
    row.querySelector('[data-claim-field="amount"]').value = amount;
    row.querySelector('[data-claim-field="due"]').value = due;
    return row;
  };
  add('Senet', '1000', '2026-11-01');
  add('Cari Ekstre', '2000', '2026-11-05');
  assert.equal(form.dataset.activeFormTab, 'claims');
  w.enforceRequired(form);
  assert.deepEqual(
    [...form.querySelectorAll('input,select,textarea')]
      .filter((input) => !input.validity.valid)
      .map((input) => input.outerHTML + input.validationMessage),
    [],
  );
  assert.equal(w.validateRequiredForm(form), true);
  await form.onsubmit({ preventDefault() {}, target: form });
  assert.equal(w.db.docs.length, 1, notices.join('; '));
  assert.equal(w.db.docs[0].amount, 3000);
  assert.equal(w.db.docs[0].addressSource, 'Kendisi');
  assert.equal(w.db.docs[0].additionalAddresses[0].source, 'Muhtarlık');
  assert.equal(w.db.docs[0].phoneSources['5551234567'], 'İş yeri / Ayşe');
  const id = w.db.docs[0].id,
    number = w.db.docs[0].number;
  form = w.$('#intakeForm');
  assert.equal(form.dataset.existingFolio, number);
  assert.equal(form.elements.addressSource.value, 'Kendisi');
  assert.equal(form.querySelector('[data-address-field="source"]').value, 'Muhtarlık');
  assert.equal(form.elements.phone1._phoneSourceInput.value, 'İş yeri / Ayşe');
  assert.equal(form.querySelector('[data-draft-meta="phoneSource"]').value, 'İş yeri / Ayşe');
  add('Fatura', '500', '2026-11-07');
  assert.equal(w.validateRequiredForm(form), true);
  await form.onsubmit({ preventDefault() {}, target: form });
  assert.equal(w.db.docs.length, 1, notices.join('; '));
  assert.equal(w.db.docs[0].id, id);
  assert.equal(w.db.docs[0].number, number);
  assert.equal(w.db.docs[0].amount, 3500);
  assert.deepEqual(
    Array.from(w.db.docs[0].receivables, (item) => item.docType),
    ['Senet', 'Cari Ekstre', 'Fatura'],
  );
  const old = {
    ...w.db.docs[0],
    id: 'old',
    number: 'S-0042',
    address2: 'Eski ikinci adres',
    officeAddress3: 'Eski ofis adresi',
    docType: 'Senet',
    amount: 900,
    originalAmount: 1000,
    preTrackingPayment: 100,
    due: '2026-11-01',
  };
  delete old.receivables;
  w.db.docs.push(old);
  w.save();
  w.intake('old', true, true);
  form = w.$('#intakeForm');
  form.querySelector('[data-append-receivable]').click();
  add('Fatura', '500', '2026-11-07');
  assert.equal(w.validateRequiredForm(form), true);
  await form.onsubmit({ preventDefault() {}, target: form });
  const converted = w.db.docs.find((doc) => doc.id === 'old');
  assert.equal(w.db.docs.length, 2);
  assert.equal(converted.number, 'S-0042');
  assert.equal(converted.amount, 1400);
  assert.equal(converted.officeAddress3, '');
  assert.equal(converted.address2, '');
  assert.deepEqual(
    Array.from(converted.additionalAddresses, (a) => a.address),
    ['Eski ikinci adres', 'Eski ofis adresi', 'İkinci adres'],
  );
  assert(!form.textContent.includes('Borçlu Adres (Ofis)'));
  assert.equal(converted.receivables.length, 2);
  assert.equal(converted.receivables[0].amount, 1000);
  assert.equal(converted.receivables[0].preTrackingPayment, 100);
  w.$('#newIntakeDocument').click();
  form = w.$('#intakeForm');
  assert.equal(form.hidden, false);
  assert.equal(form.elements.client.value, '');
  assert.equal(form.elements.debtor.value, '');
  assert.equal(form.querySelectorAll('[data-select-claim]').length, 0);
  assert.equal(w.db.docs.length, 2, 'opening a blank folio preserves saved records');
});
