(function (root) {
  const legacyFields = [
    'address2',
    'address2City',
    'address2District',
    'officeAddress3',
    'officeAddress3City',
    'officeAddress3District',
  ];
  const text = (value) => String(value ?? '').trim();
  function entry(value = {}) {
    return {
      address: text(value.address),
      city: text(value.city),
      district: text(value.district),
      source: text(value.source),
    };
  }
  function extras(record = {}) {
    // Fold the former separate address slots into the same list, without changing stored records on read.
    return [
      entry({ address: record.address2, city: record.address2City, district: record.address2District }),
      entry({
        address: record.officeAddress3,
        city: record.officeAddress3City,
        district: record.officeAddress3District,
      }),
      ...(Array.isArray(record.additionalAddresses) ? record.additionalAddresses.map(entry) : []),
    ].filter((row) => Object.values(row).some(Boolean));
  }
  function all(record = {}) {
    return [entry({ ...record, source: record.addressSource }), ...extras(record)];
  }
  function setup(form, record = {}, { cities = [], districts = {} } = {}) {
    if (form._borrowerAddressEditor) return;
    const input = form.elements.address,
      label = input?.closest('label');
    if (!label) return;
    const doc = form.ownerDocument;
    const pair = doc.createElement('div');
    pair.className = 'full borrower-address-pair';
    label.before(pair);
    pair.append(label);
    const sourceLabel = doc.createElement('label');
    sourceLabel.className = 'field';
    sourceLabel.textContent = 'Kaynak (isteğe bağlı)';
    const source = doc.createElement('input');
    source.name = 'addressSource';
    source.type = 'text';
    source.maxLength = 200;
    source.dataset.optional = 'true';
    source.placeholder = 'Adresin kaynağı / kime ait';
    source.value = text(record.addressSource);
    sourceLabel.append(source);
    pair.append(sourceLabel);
    const host = doc.createElement('section');
    host.className = 'full borrower-extra-addresses';
    host.dataset.borrowerAddresses = 'true';
    const list = doc.createElement('div');
    list.className = 'borrower-address-list';
    const add = doc.createElement('button');
    add.type = 'button';
    add.className = 'secondary';
    add.dataset.addBorrowerAddress = 'true';
    add.textContent = '＋ Adres Ekle';
    host.append(list, add);
    pair.after(host);
    const renumber = () =>
      [...list.children].forEach(
        (row, index) => (row.querySelector('h4').textContent = 'Adres ' + (index + 2)),
      );
    function makeField(title, key, value, kind = 'input') {
      const field = doc.createElement('label');
      field.className = 'field';
      field.textContent = title;
      const control = doc.createElement(kind);
      if (kind === 'input') control.type = 'text';
      if (kind === 'textarea') control.rows = 3;
      if (key === 'source') control.maxLength = 200;
      control.dataset.addressField = key;
      control.dataset.optional = 'true';
      control.value = text(value);
      field.append(control);
      return field;
    }
    function options(select, values, current, placeholder) {
      select.replaceChildren(new doc.defaultView.Option(placeholder, ''));
      for (const value of [...new Set([...values, ...(current ? [current] : [])])])
        select.add(new doc.defaultView.Option(value, value));
      select.value = current;
    }
    function addRow(value = {}) {
      const row = doc.createElement('section');
      row.className = 'borrower-address-row';
      row.dataset.borrowerAddressRow = 'true';
      const heading = doc.createElement('div');
      heading.className = 'toolbar';
      heading.append(doc.createElement('h4'));
      const remove = doc.createElement('button');
      remove.type = 'button';
      remove.className = 'link';
      remove.textContent = 'Adresi Kaldır';
      remove.dataset.removeBorrowerAddress = 'true';
      remove.onclick = () => {
        row.remove();
        renumber();
      };
      heading.append(remove);
      const grid = doc.createElement('div');
      grid.className = 'grid';
      const city = makeField('İl', 'city', '', 'select'),
        district = makeField('İlçe', 'district', '', 'select');
      const cityInput = city.querySelector('select'),
        districtInput = district.querySelector('select');
      options(cityInput, cities, text(value.city), 'İl seçin');
      options(districtInput, districts[cityInput.value] || [], text(value.district), 'İlçe seçin');
      cityInput.onchange = () => options(districtInput, districts[cityInput.value] || [], '', 'İlçe seçin');
      const addressPair = doc.createElement('div');
      addressPair.className = 'full borrower-address-pair';
      addressPair.append(
        makeField('Açık Adres', 'address', value.address, 'textarea'),
        makeField('Kaynak (isteğe bağlı)', 'source', value.source),
      );
      grid.append(city, district, addressPair);
      row.append(heading, grid);
      list.append(row);
      renumber();
      return row;
    }
    for (const row of extras(record)) addRow(row);
    add.onclick = () => addRow().querySelector('textarea').focus();
    form._borrowerAddressEditor = { list, addRow, source };
    form.addEventListener('reset', () => {
      list.replaceChildren();
      source.value = '';
    });
  }
  function read(form) {
    const editor = form._borrowerAddressEditor;
    if (!editor) throw Error('Adres alanları yüklenemedi. Föyü yeniden açın.');
    return {
      addressSource: text(editor.source.value),
      additionalAddresses: [...editor.list.children]
        .map((row) =>
          entry(
            Object.fromEntries(
              [...row.querySelectorAll('[data-address-field]')].map((input) => [
                input.dataset.addressField,
                input.value,
              ]),
            ),
          ),
        )
        .filter((row) => Object.values(row).some(Boolean)),
      ...Object.fromEntries(legacyFields.map((key) => [key, ''])),
    };
  }
  const api = { extras, all, setup, read };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HanBorrowerAddresses = api;
})(typeof window !== 'undefined' ? window : this);
