const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { parsers } = require('prettier/plugins/babel');

function load(w, file, functions) {
  const source = fs.readFileSync('outputs/icrapro/' + file, 'utf8');
  for (const node of parsers.babel.parse(source).program.body)
    if (node.type === 'FunctionDeclaration' && functions.includes(node.id.name))
      w.eval(source.slice(node.start, node.end));
}

for (const role of ['ceo', 'admin']) {
  test(`${role}: client filters coexist with manual registration, company choices, personnel and city suggestions`, async (t) => {
    const dom = new JSDOM('<div id="filters"></div><dialog id="modal"></dialog>', {
      url: 'http://localhost',
      runScripts: 'dangerously',
    });
    t.after(() => dom.window.close());
    const w = dom.window,
      notices = [],
      saved = [];
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    w.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    Object.assign(w, {
      $: (q) => w.document.querySelector(q),
      esc: (value) => String(value ?? ''),
      normalizeSearch: (value) =>
        String(value || '')
          .toLocaleLowerCase('tr')
          .replaceAll('ı', 'i'),
      db: { clients: [], docs: [] },
      personnel: [{ id: 'manager', name: 'Örnek Yönetici', active: true }],
      hanAuth: { role, staffId: 'manager' },
      hanRecordsEnabled: true,
      turkeyCities: ['Ankara', 'İstanbul'],
      turkeyDistricts: { Ankara: ['Çankaya'], İstanbul: ['Kadıköy', 'Üsküdar'] },
      setupExtraContacts() {},
      readExtraContacts: () => ({}),
      bindMultipleFileInput() {},
      collectClientAttachments: async () => [],
      clientDebtorIdentityConflict: () => '',
      render() {},
      toast: (message) => notices.push(message),
      authApi: () => ({ categories: ['Diğer'] }),
      saveRecordClient: async (_previous, record) => saved.push(record),
    });
    w.eval(fs.readFileSync('outputs/icrapro/phone-format.js', 'utf8'));
    w.eval(fs.readFileSync('outputs/icrapro/client-bank-accounts.js', 'utf8'));
    load(w, 'form-inputs.js', ['field']);
    load(w, 'personnel.js', ['isRealPersonnelRecord', 'staffSelect', 'validStaffSelection']);
    load(w, 'document-records.js', ['setupRecordFormTabs', 'recordFieldGroup']);
    load(w, 'client-records.js', [
      'clientModal',
      'setupClientBankAccounts',
      'clientCityField',
      'clientAttachmentFields',
      'syncClientCompanyFields',
      'validClientIban',
      'setupClientCity',
      'setupClientDistrict',
      'clientFilterBar',
      'clientPlaceFilter',
    ]);
    w.document.getElementById('filters').innerHTML = w.clientFilterBar();
    const listCity = w.document.querySelector('#filters select'),
      listDistrict = w.document.querySelectorAll('#filters select')[1];
    listCity.value = 'Ankara';
    assert.doesNotThrow(() => w.clientModal());
    const form = w.document.getElementById('clientForm');
    assert.equal(typeof form.onsubmit, 'function', 'registration must finish initializing');
    const ids = [...w.document.querySelectorAll('[id]')].map((el) => el.id);
    assert.equal(new Set(ids).size, ids.length, 'filters and registration must use distinct IDs');
    for (const type of ['Şahıs', 'Şirket', 'Şahıs Şirketi']) {
      form.querySelector('[data-kind="' + type + '"]').click();
      assert.equal(form.querySelector('[data-kind].selected').dataset.kind, type);
      assert.equal(form.elements.taxOffice.disabled, type === 'Şahıs');
    }
    for (const name of ['documentStaff', 'recordedBy', 'collectionStaff']) {
      assert.equal(form.elements[name].disabled, false);
      form.elements[name].value = 'manager';
      assert.equal(form.elements[name].value, 'manager');
    }
    const city = form.elements.city,
      district = form.elements.district;
    assert.equal(district.disabled, true);
    form.querySelector('[data-form-tab="address"]').click();
    city.value = 'ist';
    city.dispatchEvent(new w.Event('input'));
    const cityBox = form.querySelector('#clientCitySuggestions');
    assert.equal(cityBox.hidden, false);
    assert.equal(cityBox.querySelectorAll('[data-city]').length, 1);
    cityBox.querySelector('[data-city="İstanbul"]').click();
    assert.equal(city.value, 'İstanbul');
    assert.equal(district.disabled, false);
    const districtBox = form.querySelector('#clientDistrictSuggestions');
    district.value = 'kad';
    district.dispatchEvent(new w.Event('input'));
    assert.equal(districtBox.hidden, false);
    districtBox.querySelector('[data-district="Kadıköy"]').click();
    assert.equal(district.value, 'Kadıköy');
    assert.equal(listCity.value, 'Ankara');
    assert.equal(listDistrict.disabled, true);
    for (const [name, value] of Object.entries({
      tradeName: 'Örnek Firma',
      identity: '1234567890',
      clientCategory: 'Diğer',
      phone: '05320000001',
      address: 'Örnek adres',
    }))
      form.elements[name].value = value;
    await form.onsubmit({ preventDefault() {}, target: form });
    assert.equal(saved.length, 1, notices.join('; '));
    assert.equal(saved[0].type, 'Şahıs Şirketi');
    assert.equal(saved[0].recordedBy, 'manager');
    assert.equal(saved[0].documentStaff, 'manager');
    assert.equal(saved[0].collectionStaff, 'manager');
    assert.equal(saved[0].city, 'İstanbul');
    assert.equal(saved[0].district, 'Kadıköy');
    assert.equal(w.document.getElementById('modal').open, false);
  });
}
