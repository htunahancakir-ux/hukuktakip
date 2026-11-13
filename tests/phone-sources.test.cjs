const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const {
  phoneSourceKey,
  phoneSource,
  cleanPhoneSources,
  normalizePhoneRecords,
  borrowerPhoneSlots,
} = require('../outputs/icrapro/phone-format.js');
const { phones } = require('../lib/voip.cjs');

function browser(t, html) {
  const dom = new JSDOM(html, { url: 'https://test.invalid', runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.esc = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('"', '&quot;');
  for (const file of [
    'phone-format.js',
    'borrower-addresses.js',
    'form-inputs.js',
    'client-records.js',
    'borrower-sheet.js',
  ])
    w.eval(fs.readFileSync('outputs/icrapro/' + file, 'utf8'));
  return w;
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test('Phone sources normalize Turkish number formats, stay optional and reject malformed values', () => {
  for (const value of ['05321234567', '905321234567', '0 (532) 123 45 67'])
    assert.equal(phoneSourceKey(value), '5321234567');
  assert.deepEqual(cleanPhoneSources(null), {});
  assert.deepEqual(cleanPhoneSources(['Name']), {});
  assert.deepEqual(
    cleanPhoneSources(JSON.parse('{"__proto__":"bad","05321234567":"  Eşi Ayşe  ","05321234568":42}')),
    { 5321234567: 'Eşi Ayşe' },
  );
  assert.equal(phoneSource({ phoneSources: { '05321234567': 'x'.repeat(250) } }, '905321234567').length, 200);
  const doc = {
    phone1: '',
    phone2: '05321234567',
    additionalPhones: ['905321234567', '05321234568'],
    phoneSources: { 905321234567: 'Eşi Ayşe' },
  };
  Object.assign(doc, borrowerPhoneSlots(doc));
  normalizePhoneRecords(doc);
  assert.equal(doc.phone1, '0 (532) 123 45 67');
  assert.equal(phoneSource(doc, doc.phone1), 'Eşi Ayşe');
  assert.equal(phoneSource(doc, doc.phone2), '');
});

test('Every phone and added phone has a blank optional source; save/reopen, edits, removals and hidden sources persist correctly', (t) => {
  const w = browser(
    t,
    '<form><div class="grid"><label class="field">Tel<input type="tel" name="phone" value="05321234567"></label><label class="field">Adres<textarea name="address"></textarea></label></div></form>',
  );
  let form = w.document.querySelector('form');
  const record = {
    phone: '05321234567',
    referencePhone1: '05321234569',
    additionalPhones: ['05321234568'],
    phoneSources: { 5321234569: 'Ofis arşivinden' },
  };
  w.setupExtraContacts(form, record);
  assert.equal(form.querySelectorAll('[data-phone-source]').length, 2);
  for (const input of form.querySelectorAll('[data-phone-source]')) {
    assert.equal(input.value, '');
    assert.equal(input.required, false);
    assert.equal(input.dataset.optional, 'true');
  }
  form.elements.phone._phoneSourceInput.value = 'Eşi <Ayşe>';
  form.querySelector('[data-extra="phone"]')._phoneSourceInput.value = 'İş yeri';
  const add = form.querySelector('[data-extra-contact="phone"] .secondary');
  add.click();
  const added = form.querySelectorAll('[data-extra="phone"]')[1];
  assert.equal(added._phoneSourceInput.value, '');
  added.value = '05321234560';
  added._phoneSourceInput.value = 'Komşusu';
  const saved = { ...record, ...plain(w.readExtraContacts(form)) };
  assert.deepEqual(saved.phoneSources, {
    5321234567: 'Eşi <Ayşe>',
    5321234568: 'İş yeri',
    5321234560: 'Komşusu',
    5321234569: 'Ofis arşivinden',
  });
  // JSON round trip simulates the same payload persisted by the record store.
  w.document.body.innerHTML =
    '<form><label class="field">Tel<input type="tel" name="phone" value="05321234567"></label><label class="field">Adres<textarea name="address"></textarea></label></form>';
  form = w.document.querySelector('form');
  w.setupExtraContacts(form, JSON.parse(JSON.stringify(saved)));
  assert.equal(form.elements.phone._phoneSourceInput.value, 'Eşi <Ayşe>');
  assert.equal(form.querySelector('ayşe'), null);
  form.elements.phone._phoneSourceInput.value = '';
  form.querySelector('[data-extra-contact="phone"] .extra-contact-row .link').click();
  const updated = plain(w.readExtraContacts(form));
  assert.deepEqual(updated.phoneSources, { 5321234560: 'Komşusu', 5321234569: 'Ofis arşivinden' });
  form.reset();
  assert.equal(form.elements.phone._phoneSourceInput.value, '');
  assert.equal(form.querySelectorAll('[data-extra="phone"]').length, 0);
});

test('Borrower editor saves sources for primary, reference, office and newly added numbers then reopens them', (t) => {
  const w = browser(t, '');
  const doc = {
    id: 'd',
    number: '150',
    debtor: 'Borçlu',
    phone1: '05321234567',
    phone2: '05321234568',
    referencePhone1: '05321234569',
    officePhone1: '02121234567',
    additionalPhones: [],
    city: 'İstanbul',
    district: 'Kadıköy',
    address: 'Adres',
    address2: 'Eski ikinci adres',
    officeAddress3: 'Eski ofis adresi',
  };
  Object.assign(w, {
    $: (s) => w.document.querySelector(s),
    db: { docs: [doc] },
    docType: () => 'Senet',
    propertyFields: () => '',
    bindPropertyFields() {},
    validatePropertyFields: () => true,
    setupBorrowerPartyFields() {},
    borrowerPartyFields: () => '',
    clientCityField: (record) =>
      `<label class="field"><input name="city" value="${record.city || ''}"></label><label class="field"><input name="district" value="${record.district || ''}"></label>`,
    setupClientCity() {},
    setupClientDistrict() {},
    turkeyCities: ['İstanbul'],
    turkeyDistricts: { İstanbul: ['Kadıköy'] },
    save() {
      w.localStorage.setItem('saved', JSON.stringify(doc));
    },
    toast() {},
    stats() {},
    page: 'home',
    structuredClone,
  });
  w.propertyFields = () => '';
  w.bindPropertyFields = () => {};
  w.validatePropertyFields = () => true;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  w.editBorrower('d', true);
  let form = w.document.querySelector('form');
  assert.equal(form.elements.officeAddress3, undefined);
  assert.equal(form.querySelectorAll('[data-borrower-address-row]').length, 3);
  form.elements.addressSource.value = 'Kendisi';
  const newAddress = form.querySelector('[data-borrower-address-row]:last-child');
  newAddress.querySelector('[data-address-field="address"]').value = 'Yeni adres';
  newAddress.querySelector('[data-address-field="source"]').value = 'Muhtarlık';
  assert.equal(form.querySelectorAll('[data-phone-source]').length, 6);
  for (const name of ['phone1', 'referencePhone1', 'officePhone1'])
    form.elements[name]._phoneSourceInput.value = name + ' kaynağı';
  form.querySelector('[data-add-extra-phone]').click();
  const extra = form.querySelector('[data-extra-phone]');
  extra.value = '05321234560';
  extra._phoneSourceInput.value = 'Kardeşi';
  form.onsubmit({ preventDefault() {} });
  const savedAddress = JSON.parse(w.localStorage.getItem('saved'));
  assert.equal(savedAddress.addressSource, 'Kendisi');
  assert.equal(savedAddress.officeAddress3, '');
  assert.deepEqual(
    savedAddress.additionalAddresses.map((a) => a.address),
    ['Eski ikinci adres', 'Eski ofis adresi', 'Yeni adres'],
  );
  assert.equal(savedAddress.additionalAddresses[2].source, 'Muhtarlık');
  assert.deepEqual(JSON.parse(w.localStorage.getItem('saved')).phoneSources, {
    5321234567: 'phone1 kaynağı',
    5321234569: 'referencePhone1 kaynağı',
    2121234567: 'officePhone1 kaynağı',
    5321234560: 'Kardeşi',
  });
  w.editBorrower('d');
  form = w.document.querySelector('form');
  assert.equal(form.elements.referencePhone1._phoneSourceInput.value, 'referencePhone1 kaynağı');
  assert.equal(form.querySelector('[data-extra-phone]')._phoneSourceInput.value, 'Kardeşi');
  // The same source fields work in the separate guarantor window.
  doc._intakeDraft = true;
  doc.guarantors = [
    {
      id: 'g',
      name: 'Kefil',
      identity: '12345678901',
      phone1: '05321234561',
      city: 'İstanbul',
      district: 'Kadıköy',
      address: 'Kefil adresi',
    },
  ];
  w.renderIntakeGuarantors = () => {};
  w.guarantorForm(doc, 'g');
  const guarantor = w.document.querySelector('#guarantorForm');
  assert.equal(guarantor.querySelectorAll('[data-phone-source]').length, 6);
  guarantor.elements.phone1._phoneSourceInput.value = 'Kefilin iş yeri';
  guarantor.onsubmit({ preventDefault() {} });
  assert.equal(doc.guarantors[0].phoneSources['5321234561'], 'Kefilin iş yeri');
  w.guarantorForm(doc, 'g');
  assert.equal(
    w.document.querySelector('#guarantorForm').elements.phone1._phoneSourceInput.value,
    'Kefilin iş yeri',
  );
});

test('Call list returns sources with numbers after Tel slot normalization and preserves old response for blank sources', () => {
  assert.deepEqual(
    phones({ additionalPhones: ['05321234567', '05321234568'], phoneSources: { 905321234567: 'Annesi' } }),
    [
      { label: 'Tel-1', phone: '905321234567', source: 'Annesi' },
      { label: 'Tel-2', phone: '905321234568' },
    ],
  );
});
