const documentTypes = {
  'Alacak Föyü': {
    amount: 'Toplam Alacak (₺)',
    serial: 'Föy Açıklaması',
    due: 'İlk Vade',
    requiredDue: false,
    extras: [],
  },
  Senet: {
    amount: 'Senet Tutarı (₺)',
    serial: 'Senet Numarası',
    due: 'Vade Tarihi',
    requiredDue: true,
    extras: [],
  },
  Çek: {
    amount: 'Çek Tutarı (₺)',
    serial: 'Çek Numarası',
    due: 'İbraz Tarihi',
    requiredDue: true,
    extras: [
      ['Banka', 'bank'],
      ['Şube', 'branch'],
      ['Hesap Numarası', 'account'],
    ],
  },
  Sözleşme: {
    amount: 'Takibe Konu Alacak (₺)',
    serial: 'Sözleşme Numarası',
    due: 'Ödeme / Vade Tarihi',
    requiredDue: false,
    extras: [['Sözleşme Konusu', 'contractSubject']],
  },
  'Cari Ekstre': {
    amount: 'Alacak Bakiyesi (₺)',
    serial: 'Ekstre / Hesap Numarası',
    due: 'Son Ödeme Tarihi',
    requiredDue: true,
    extras: [],
  },
  İlam: {
    amount: 'İlama Konu Alacak (₺)',
    serial: 'Karar Numarası',
    due: 'Ödeme / Vade Tarihi',
    requiredDue: false,
    extras: [
      ['Mahkeme', 'court'],
      ['Esas Numarası', 'courtFile'],
      ['Karar Tarihi', 'decisionDate', 'date'],
    ],
  },
  'Yediemin Park Ücreti': {
    amount: 'Park Ücreti Tutarı (₺)',
    serial: 'Park / Teslim Belgesi Numarası',
    due: 'Ödeme / Vade Tarihi',
    requiredDue: false,
    extras: [
      ['Araç Plakası', 'vehiclePlate'],
      ['Şase Numarası', 'chassisNumber'],
      ['Yediemin Otoparkı', 'parkingName'],
      ['Giriş / Men Tarihi', 'parkingEntry', 'date'],
      ['Araç Cinsi', 'vehicleKind', 'select', ['Motosiklet', 'Otomobil', 'Diğer']],
      ['Anlaşılan %', 'parkingCommissionRate', 'number'],
    ],
  },
  Fatura: {
    amount: 'Fatura Tutarı (₺)',
    serial: 'Fatura Numarası',
    due: 'Vade Tarihi',
    requiredDue: true,
    extras: [['Fatura Konusu', 'invoiceSubject']],
  },
  Diğer: {
    amount: 'Alacak Tutarı (₺)',
    serial: 'Belge / Referans Numarası',
    due: 'Ödeme / Vade Tarihi',
    requiredDue: true,
    extras: [['Evrak Açıklaması', 'otherDocumentDescription']],
  },
};
function docType(d) {
  if (Array.isArray(d.receivables))
    return d.receivables.length === 1 ? d.receivables[0].docType : 'Alacak Föyü';
  return documentTypes[d.docType] ? d.docType : 'Senet';
}
function nextDocumentNumber(type, documents, archivedNumbers = []) {
  const values = [...documents.map((doc) => doc.number), ...archivedNumbers];
  const maximum = values.reduce((max, value) => {
    const match = String(value || '').match(/([0-9]+)$/);
    return Math.max(max, match ? Number(match[1]) : 0);
  }, 0);
  if (!Number.isSafeInteger(maximum + 1)) throw Error('Föy numarası güvenli sınırı aşıyor.');
  return String(maximum + 1);
}

function documentTypePicker() {
  return `<div class="segments document-types" role="group" aria-label="Evrak türü">${Object.keys(
    documentTypes,
  )
    .filter((type) => type !== 'Alacak Föyü')
    .map(
      (type, i) =>
        `<button type="button" data-doc-type="${type}" aria-pressed="${i === 0}" class="${i === 0 ? 'selected' : ''}">${type} Ekle</button>`,
    )
    .join(
      '',
    )}</div><select name="docType" id="docType" hidden aria-hidden="true" data-optional="true" tabindex="-1">${Object.keys(
    documentTypes,
  )
    .map((type) => `<option>${type}</option>`)
    .join('')}</select><div class="grid" id="typeFields" style="margin:20px 0"></div>`;
}
function setupDocumentTypes() {
  const form = $('#intakeForm'),
    select = form.elements.docType;
  const drafts = {};
  let previous = '';
  function update() {
    if (previous)
      drafts[previous] = Object.fromEntries(
        [...$('#typeFields').querySelectorAll('input,select')].map((el) => [el.name, el.value]),
      );
    const type = select.value,
      t = documentTypes[type];
    const folio = form.querySelector('#intakeFolioNumber');
    if (folio) {
      folio.value =
        form.dataset.existingFolio ||
        form.dataset.folioNumber ||
        (window.hanRecordsEnabled
          ? 'Numara hazırlanıyor…'
          : nextDocumentNumber(type, db.docs, db.archivedNumbers));
      folio.hidden = false;
      const label = folio.closest('label');
      label.hidden = false;
      label.firstChild.textContent = 'Föy No · ' + type;
    }
    previous = type;
    const orderedExtras = (embeddedIntake ? [] : [...t.extras]).sort(
      (a, b) => (a[1] === 'parkingName' ? -1 : 0) - (b[1] === 'parkingName' ? -1 : 0),
    );
    $('#typeFields').innerHTML = orderedExtras
      .map((extra) => documentExtraField(extra, drafts[type]?.[extra[1]] || ''))
      .join('');
    if (form.elements.parkingCommissionRate) {
      form.elements.parkingCommissionRate.min = '0';
      form.elements.parkingCommissionRate.max = '100';
      form.elements.parkingCommissionRate.step = '0.01';
      form.elements.parkingCommissionRate.required = true;
    }
    for (const [name, label] of [
      ['amount', ['Senet', 'Diğer'].includes(type) ? 'Toplam Evrak Tutarı (₺)' : t.amount],
      ['serial', t.serial],
      ['due', t.due],
    ]) {
      const input = form.elements[name];
      if (name === 'due') {
        const parking = type === 'Yediemin Park Ücreti';
        input.required = !parking && t.requiredDue;
        input.disabled = parking;
        input.dataset.optional = String(parking || !t.requiredDue);
        input.closest('label').hidden = parking;
        input.setCustomValidity('');
        if (input._dateProxy) {
          input._dateProxy.disabled = parking;
          input._dateProxy.required = !parking && t.requiredDue;
        }
      }
      if (name === 'serial') {
        const optional = embeddedIntake || type === 'Cari Ekstre' || type === 'Senet';
        input.disabled = embeddedIntake;
        input.dataset.optional = String(optional);
        input.required = !optional;
        input.setAttribute('aria-required', String(!optional));
        input.setCustomValidity('');
      }
      input.closest('label').firstChild.textContent = label + (input.required ? ' *' : '');
    }
    const issued = form.elements.issued;
    const showIssued = !embeddedIntake && (type === 'Senet' || type === 'Çek');
    issued.closest('label').hidden = !showIssued;
    issued.disabled = !showIssued;
    if (issued._dateProxy) issued._dateProxy.disabled = !showIssued;
    setupParkingIdentityFields(form);
    setupParkingCapture(form);
    setupParkingFeePreview(form);
    $('#intakeHeading').textContent = type + ' Evrak Kabul';
    document.querySelectorAll('[data-doc-type]').forEach((b) => {
      b.classList.toggle('selected', b.dataset.docType === type);
      b.setAttribute('aria-pressed', String(b.dataset.docType === type));
    });
  }
  select.onchange = update;
  document.querySelectorAll('[data-doc-type]').forEach(
    (b) =>
      (b.onclick = () => {
        select.value = b.dataset.docType;
        update();
      }),
  );
  form.addEventListener('reset', () => {
    for (const key of Object.keys(drafts)) delete drafts[key];
    previous = '';
    queueMicrotask(update);
  });
  update();
}
function documentExtraReceipt(d) {
  return `<br><b>Evrak Türü:</b> ${esc(docType(d))}${documentTypes[docType(d)].extras
    .filter(([, key]) => d[key])
    .map(([label, key]) => `<br><b>${esc(label)}:</b> ${esc(displayDate(d[key]))}`)
    .join('')}`;
}

function documentExtraField([label, name, input, options], value = '') {
  if (input !== 'select') return field(label, name, input || 'text', value);
  return `<label class="field">${esc(label)} *<select name="${esc(name)}" required><option value="">Seçin</option>${options.map((option) => `<option value="${esc(option)}" ${option === value ? 'selected' : ''}>${esc(option)}</option>`).join('')}</select></label>`;
}

function setupParkingFeePreview(form) {
  let hint = form.querySelector('#parkingFeePreview');
  const parking = form.elements.docType.value === 'Yediemin Park Ücreti';
  if (!hint && parking) {
    hint = document.createElement('p');
    hint.id = 'parkingFeePreview';
    hint.className = 'notice full';
    form.elements.amount.closest('label').after(hint);
  }
  if (hint) hint.hidden = !parking;
  const amount = form.elements.amount;
  amount.readOnly = parking || !!form.dataset.financeLocked;
  if (amount._moneyProxy) amount._moneyProxy.readOnly = amount.readOnly;
  if (!parking) return;
  function update() {
    const value = {
      docType: form.elements.docType.value,
      vehicleKind: form.elements.vehicleKind?.value,
      parkingEntry: form.elements.parkingEntry?.value,
    };
    const info = parkingFeeInfo(value, businessDate());
    if (info && info.days > 0) {
      amount.value = info.amount / 100;
      amount.setCustomValidity('');
      hint.textContent =
        info.days +
        ' gün × ' +
        money(info.daily / 100) +
        ' = ' +
        money(info.amount / 100) +
        ' (men günü dahil). Her yeni gün ücret eklenir.';
    } else {
      amount.value = '';
      hint.textContent = 'Araç cinsi ve bugünden ileri olmayan geçerli giriş / men tarihi seçin.';
    }
    if (amount._moneyProxy) amount._moneyProxy.value = formatAmountInput(amount.value);
  }
  for (const key of ['vehicleKind', 'parkingEntry']) form.elements[key]?.addEventListener('change', update);
  form._refreshParkingFee = update;
  update();
}

function setupParkingIdentityFields(form) {
  const parking = form.elements.docType.value === 'Yediemin Park Ücreti';
  for (const key of ['identity', 'vehiclePlate', 'chassisNumber']) {
    const input = form.elements[key];
    if (!input) continue;
    const optional = parking || key === 'identity';
    input.dataset.optional = String(optional);
    input.required = !optional;
    input.setAttribute('aria-required', String(!optional));
    input.setCustomValidity('');
    if (parking && input.closest('label')?.firstChild?.nodeType === 3)
      input.closest('label').firstChild.textContent = input
        .closest('label')
        .firstChild.textContent.replace(/\s*\*/g, '');
    if (parking)
      input.oninput = () => {
        for (const name of ['identity', 'vehiclePlate', 'chassisNumber'])
          form.elements[name]?.setCustomValidity('');
      };
  }
}
function validParkingIdentity(d) {
  return ['identity', 'vehiclePlate', 'chassisNumber'].some((key) => String(d[key] || '').trim());
}
