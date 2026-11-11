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
      ['staffSelect', 'mandatoryControls', 'enforceRequired', 'validateRequiredForm'].includes(node.id.name)
    )
      w.eval(personnelSource.slice(node.start, node.end));
  w.bindIntakeSearch = () => {};
  w.propertyFields = () => '';
  w.bindPropertyFields = () => {};
  w.validatePropertyFields = () => true;
  w.offerSameIdentityChain = () => {};
  w.save = () => w.localStorage.setItem('icrapro-v1', JSON.stringify(w.db));
  w.save();
  w.intake(undefined, true);
  let form = w.$('#intakeForm');
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
  const add = (type, amount, due) => {
    form.querySelector('[data-doc-type="' + type + '"]').click();
    const row = form.querySelector('[data-receivable-rows]>section:last-child');
    row.querySelector('[data-claim-field="amount"]').value = amount;
    row.querySelector('[data-claim-field="due"]').value = due;
    return row;
  };
  add('Senet', '1000', '2026-11-01');
  add('Cari Ekstre', '2000', '2026-11-05');
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
  const id = w.db.docs[0].id,
    number = w.db.docs[0].number;
  form = w.$('#intakeForm');
  assert.equal(form.dataset.existingFolio, number);
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
  assert.equal(converted.receivables.length, 2);
  assert.equal(converted.receivables[0].amount, 1000);
  assert.equal(converted.receivables[0].preTrackingPayment, 100);
});
