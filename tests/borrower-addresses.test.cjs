const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const addresses = require('../outputs/icrapro/borrower-addresses.js');

test('Legacy second and office addresses are read as numbered extra addresses without mutating or losing data', () => {
  const record = {
    address: 'Ana adres',
    city: 'İstanbul',
    district: 'Kadıköy',
    addressSource: 'Kendisi',
    address2: 'İkinci adres',
    address2City: 'Ankara',
    address2District: 'Çankaya',
    officeAddress3: 'Eski ofis adresi',
    officeAddress3City: 'İzmir',
    officeAddress3District: 'Konak',
    additionalAddresses: [{ address: 'Dördüncü adres', source: 'Tapu kaydı' }],
  };
  const before = JSON.stringify(record);
  assert.deepEqual(addresses.all(record), [
    { address: 'Ana adres', city: 'İstanbul', district: 'Kadıköy', source: 'Kendisi' },
    { address: 'İkinci adres', city: 'Ankara', district: 'Çankaya', source: '' },
    { address: 'Eski ofis adresi', city: 'İzmir', district: 'Konak', source: '' },
    { address: 'Dördüncü adres', city: '', district: '', source: 'Tapu kaydı' },
  ]);
  assert.equal(JSON.stringify(record), before);
  assert.deepEqual(addresses.extras({}), []);
});

test('Extra address fields open only when added; optional sources save, reopen and stay with their address after removal', (t) => {
  const dom = new JSDOM(
    '<form><label class="field full">Adres<textarea name="address"></textarea></label></form>',
    { runScripts: 'dangerously', url: 'https://test.invalid' },
  );
  t.after(() => dom.window.close());
  const w = dom.window;
  w.eval(fs.readFileSync('outputs/icrapro/borrower-addresses.js', 'utf8'));
  let form = w.document.querySelector('form');
  const config = {
    cities: ['İstanbul', 'Ankara'],
    districts: { İstanbul: ['Kadıköy'], Ankara: ['Çankaya'] },
  };
  w.HanBorrowerAddresses.setup(form, {}, config);
  assert.equal(form.querySelectorAll('[data-borrower-address-row]').length, 0);
  assert.equal(form.elements.addressSource.value, '');
  assert.equal(form.elements.addressSource.required, false);
  form.elements.addressSource.value = 'Kendisi';
  form.querySelector('[data-add-borrower-address]').click();
  let row = form.querySelector('[data-borrower-address-row]');
  assert.equal(row.querySelector('h4').textContent, 'Adres 2');
  row.querySelector('[data-address-field="address"]').value = 'İkinci adres';
  row.querySelector('[data-address-field="city"]').value = 'İstanbul';
  row.querySelector('[data-address-field="city"]').dispatchEvent(new w.Event('change'));
  row.querySelector('[data-address-field="district"]').value = 'Kadıköy';
  form.querySelector('[data-add-borrower-address]').click();
  row = form.querySelectorAll('[data-borrower-address-row]')[1];
  row.querySelector('[data-address-field="address"]').value = 'Üçüncü adres';
  row.querySelector('[data-address-field="source"]').value = 'Komşusu <Ayşe>';
  for (const input of form.querySelectorAll('[data-address-field]')) assert.equal(input.required, false);
  const saved = JSON.parse(JSON.stringify(w.HanBorrowerAddresses.read(form)));
  assert.equal(saved.addressSource, 'Kendisi');
  assert.equal(saved.additionalAddresses[0].source, '');
  assert.equal(saved.additionalAddresses[1].source, 'Komşusu <Ayşe>');
  assert.equal(saved.officeAddress3, '');
  w.document.body.innerHTML =
    '<form><label class="field full">Adres<textarea name="address"></textarea></label></form>';
  form = w.document.querySelector('form');
  w.HanBorrowerAddresses.setup(form, saved, config);
  assert.equal(form.querySelectorAll('[data-borrower-address-row]').length, 2);
  assert.equal(form.querySelector('ayşe'), null);
  form.querySelector('[data-remove-borrower-address]').click();
  row = form.querySelector('[data-borrower-address-row]');
  assert.equal(row.querySelector('h4').textContent, 'Adres 2');
  assert.equal(row.querySelector('[data-address-field="source"]').value, 'Komşusu <Ayşe>');
  assert.equal(w.HanBorrowerAddresses.read(form).additionalAddresses.length, 1);
  form.reset();
  assert.equal(form.querySelectorAll('[data-borrower-address-row]').length, 0);
  assert.equal(form.elements.addressSource.value, '');
});

test('Legacy incomplete locations survive opening and saving; changing city clears only its district', (t) => {
  const dom = new JSDOM('<form><label>Adres<textarea name="address"></textarea></label></form>', {
    runScripts: 'dangerously',
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.eval(fs.readFileSync('outputs/icrapro/borrower-addresses.js', 'utf8'));
  const form = w.document.querySelector('form');
  w.HanBorrowerAddresses.setup(
    form,
    { officeAddress3: 'Mevcut kayıt', officeAddress3City: 'Eski il', officeAddress3District: 'Eski ilçe' },
    { cities: ['İstanbul'], districts: { İstanbul: ['Kadıköy'] } },
  );
  const first = JSON.parse(JSON.stringify(w.HanBorrowerAddresses.read(form)));
  assert.equal(first.additionalAddresses[0].city, 'Eski il');
  assert.equal(first.additionalAddresses[0].district, 'Eski ilçe');
  const city = form.querySelector('[data-address-field="city"]');
  city.value = 'İstanbul';
  city.dispatchEvent(new w.Event('change'));
  assert.equal(form.querySelector('[data-address-field="district"]').value, '');
  assert.equal(form.querySelector('[data-address-field="address"]').value, 'Mevcut kayıt');
});
