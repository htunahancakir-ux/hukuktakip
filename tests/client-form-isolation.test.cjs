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
  test(`${role}: client filters coexist with registration, company choices and province/district dropdowns`, async (t) => {
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
      setupClientStatement() {},
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
      'addressSelectValue',
      'addressSelectOptions',
      'clientCityField',
      'clientAttachmentFields',
      'syncClientCompanyFields',
      'validClientIban',
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
    assert.equal(form.elements.clientCode.required, false);
    assert.equal(form.elements.clientCode.dataset.optional, 'true');
    assert.equal(form.elements.clientCode.closest('[data-form-panel]').dataset.formPanel, 'general');
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
    assert.equal(city.tagName, 'SELECT');
    assert.deepEqual(
      [...city.options].map((option) => option.value),
      ['', 'Ankara', 'İstanbul'],
    );
    city.value = 'İstanbul';
    city.dispatchEvent(new w.Event('change'));
    assert.equal(city.value, 'İstanbul');
    assert.equal(district.disabled, false);
    assert.deepEqual(
      [...district.options].map((option) => option.value),
      ['', 'Kadıköy', 'Üsküdar'],
    );
    district.value = 'Kadıköy';
    assert.equal(district.value, 'Kadıköy');
    assert.equal(listCity.value, 'Ankara');
    assert.equal(listDistrict.disabled, true);
    for (const [name, value] of Object.entries({
      tradeName: 'Örnek Firma',
      clientCode: '  000-MV-7  ',
      identity: '1234567890',
      clientCategory: 'Diğer',
      phone: '05320000001',
      address: 'Örnek adres',
    }))
      form.elements[name].value = value;
    await form.onsubmit({ preventDefault() {}, target: form });
    assert.equal(saved.length, 1, notices.join('; '));
    assert.equal(saved[0].type, 'Şahıs Şirketi');
    assert.equal(saved[0].clientCode, '000-MV-7', 'Codes retain leading zeros and letters');
    assert.equal(saved[0].recordedBy, 'manager');
    assert.equal(saved[0].documentStaff, 'manager');
    assert.equal(saved[0].collectionStaff, 'manager');
    assert.equal(saved[0].city, 'İstanbul');
    assert.equal(saved[0].district, 'Kadıköy');
    assert.equal(w.document.getElementById('modal').open, false);
    w.clientModal(saved[0].id, saved[0]);
    const edit = w.document.getElementById('clientForm');
    assert.equal(edit.elements.clientCode.value, '000-MV-7');
    assert.equal(edit.elements.city.value, 'İstanbul');
    assert.equal(edit.elements.district.value, 'Kadıköy');
    assert.deepEqual(
      [...edit.elements.district.options].map((option) => option.value),
      ['', 'Kadıköy', 'Üsküdar'],
    );
    edit.elements.clientCode.value = '';
    await edit.onsubmit({ preventDefault() {}, target: edit });
    assert.equal(saved.length, 2, notices.join('; '));
    assert.equal(saved[1].clientCode, '', 'Code can be cleared without blocking an existing client save');
    assert.equal(saved[1].tradeName, saved[0].tradeName);

    const prospect = w.document.createElement('form');
    prospect.innerHTML = w.clientCityField({}, 'prospect');
    const fill = w.setupClientDistrict('prospect', prospect);
    fill({ city: 'istanbul', district: 'Üsküdar' });
    assert.equal(prospect.elements.city.value, 'İstanbul');
    assert.equal(prospect.elements.district.value, 'Üsküdar');
    prospect.reset();
    await new Promise(setImmediate);
    assert.equal(prospect.elements.city.value, '');
    assert.equal(prospect.elements.district.value, '');
    assert.equal(prospect.elements.district.disabled, true);
  });
}
