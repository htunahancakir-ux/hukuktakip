function prepareEmbeddedIntake(form) {
  const documentFields = form.querySelector('[data-form-panel="document"] .grid');
  const visibleFields = new Set([form.elements.amount.closest('label'), form.elements.due.closest('label')]);
  for (const field of documentFields.children) {
    if (!visibleFields.has(field)) field.hidden = true;
  }
  form.querySelector('.intake-record-header').hidden = true;
  form.querySelectorAll('[data-doc-type="Yediemin Park Ücreti"]').forEach((button) => {
    button.hidden = true;
  });
  form.querySelector('.record-form-tabs').hidden = true;
  form.querySelector('select[name="client"]').closest('label').hidden = true;
  form.querySelector('[name="clientParty"]').closest('label').hidden = true;
  form.querySelector('.notice').hidden = true;
  form.noValidate = true;
}

function copySharedIntakeFields(form) {
  const parentForm = window.top.document.getElementById('intakeForm');
  if (!parentForm) return false;
  const shared = form.querySelectorAll(
    '[data-form-panel]:not([data-form-panel="document"]) [name], [name="client"], [name="clientParty"]',
  );
  for (const input of shared) {
    if (input.type === 'file') continue;
    const parentInput = parentForm.elements[input.name];
    if (!parentInput) continue;
    if (input.type === 'radio') input.checked = input.value === parentInput.value;
    else if ('value' in parentInput) input.value = parentInput.value;
  }
  if (form.elements.client.value && Array.from(shared).every((input) => input.validity.valid)) return true;
  toast('Üst evrak formunda müvekkil, borçlu ve teslim bilgilerini tamamlayın.');
  return false;
}

function bindAdditionalIntake(form) {
  const checkbox = form.querySelector('#intakeAddAnother');
  const host = document.createElement('div');
  host.hidden = true;
  form.after(host);

  function refresh() {
    host.hidden = !checkbox.checked;
    if (!checkbox.checked || host.firstElementChild) return;
    const frame = document.createElement('iframe');
    frame.title = 'Yeni Evrak Bilgileri';
    frame.style.cssText = 'display:block;width:100%;min-height:420px;border:0;margin-top:16px';
    frame.src = '/?embeddedIntake=1&client=' + encodeURIComponent(form.elements.client.value);
    host.append(frame);
  }

  checkbox.onchange = refresh;
  form.addEventListener('reset', () => queueMicrotask(refresh));
  form.elements.client.addEventListener('change', () => {
    host.querySelector('iframe')?.contentWindow.setAdditionalIntakeClient?.(form.elements.client.value);
  });
}

function setAdditionalIntakeClient(clientId) {
  const control = document.querySelector('#intakeForm:not([data-intake-saved]) [name="client"]');
  if (!control) return;
  control.value = clientId;
  control.dispatchEvent(new Event('change'));
}

function refreshIntakeBatchAfterSave() {
  db = JSON.parse(localStorage.getItem('icrapro-v1'));
  const group = document.getElementById('intakeBatchGroup');
  if (group) {
    group.outerHTML = intakeBatchToolbar();
    bindIntakeBatchToolbar();
    stats();
  }
  if (embeddedIntake) window.parent.refreshIntakeBatchAfterSave();
}

function intake(editId, showNew = false) {
  document.getElementById('newIntakeDocument')?.remove();
  const original = editId ? db.docs.find((d) => d.id === editId) : null;
  const receiptId = original?.id || intakeBatchIds().at(-1);
  $('#content').innerHTML =
    `<div class="toolbar" style="margin-bottom:18px"><button type="button" class="primary new-document-button" id="newIntakeDocument" aria-controls="intakeForm" aria-expanded="${Boolean(original || showNew)}">＋ Yeni Evrak Ekle</button></div><form class="panel" id="intakeForm" ${original || showNew ? '' : 'hidden'}><div class="panelhead"><div><h2 id="intakeHeading">Evrak Kabul</h2><p>Müvekkil seçimi ve evrak bilgileri</p></div><span class="badge">Yeni kayıt</span></div><div class="formbody"><div class="notice">Evrak kaydı müvekkile bağlanır. Kaydettiğinizde evrak numarası atanır. Tek evrak tutanağını veya bu kabul grubunun toplu teslim tesellümünü ayrı düğmelerden oluşturabilirsiniz.</div><h3 class="sectiontitle">01 &nbsp; Müvekkil seçimi</h3><div class="grid"><label class="field full">Müvekkil *<select name="client" required><option value="">Müvekkil seçin</option>${db.clients.map((c) => `<option value="${esc(c.id)}" ${selected === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label><label class="field full" data-record-group="document">Müvekkil Parti<input name="clientParty" type="text" data-optional="true" placeholder="Parti bilgisi (isteğe bağlı)"></label></div><h3 class="sectiontitle" style="margin-top:28px">02 &nbsp; Evrak türü ve borçlu bilgileri</h3>${documentTypePicker()}<div class="grid"><label class="field full">Föy Numarası<input id="intakeFolioNumber" type="text" readonly data-optional="true" value="${esc(original?.number || nextDocumentNumber('Senet', db.docs, db.archivedNumbers))}" aria-label="Föy Numarası"><small>Otomatik atanır.</small></label><label class="field">Takip Tarihi<input id="intakeTrackingDate" type="text" readonly data-optional="true" value="${esc(displayDate(original ? borrowerTrackingDate(original) : businessDate()))}" aria-label="Takip Tarihi"><small>Kayıt sırasında otomatik atanır.</small></label>${field('Borçlu Ad Soyad / Unvan', 'debtor', 'text', '', true)}${field('Borçlu TC Kimlik / Vergi No', 'identity')}${field('Tel-1', 'phone1', 'tel')}${clientCityField({}, 'document')}<label class="field full">Borçlu Açık Adres<textarea name="address" rows="3" required></textarea></label><h3 class="sectiontitle full">Borçlu Adres-2</h3>${clientCityField({}, 'document2').replace('name="city"', 'name="address2City"').replace('name="district"', 'name="address2District"')}<label class="field full">Borçlu Adres-2 — Açık Adres<textarea name="address2" rows="3" required></textarea></label><h3 class="sectiontitle full">Borçlu Adres (Ofis)-3</h3>${clientCityField({}, 'document3').replace('name="city"', 'name="officeAddress3City"').replace('name="district"', 'name="officeAddress3District"')}<label class="field full">Borçlu Adres (Ofis)-3 — Açık Adres<textarea name="officeAddress3" rows="3" required></textarea></label>${field('Toplam Evrak Tutarı (₺)', 'amount', 'number', '', true)}<label class="field" data-pre-tracking-amount hidden>Takip Öncesi Ödeme (₺)<input name="preTrackingPayment" type="number" min="0" step="0.01" data-optional="true" disabled></label><label class="field" data-pre-tracking-amount hidden>Asıl Olacak (₺)<input id="intakePrincipal" type="text" readonly data-optional="true"></label>${field('Vade Tarihi', 'due', 'date', '', true)}${field('Düzenleme Tarihi', 'issued', 'date')}${field('Senet Numarası', 'serial')}${staffSelect('Teslim Alan', 'receivedBy')}${staffSelect('Evrak Kaydeden *', 'recordedBy').replace('<select ', '<select required ')}${field('Teslim Eden', 'deliveredBy', 'text', '', true)}${staffSelect('Dosya Sorumlusu', 'relatedStaff')}${propertyFields({}, 'intake')}<div class="full" id="intakeGuarantors"></div><fieldset class="field full original-document"><legend>Evrak Aslı *</legend><label><input type="radio" name="originalDocument" value="Alındı" required> Alındı</label><label><input type="radio" name="originalDocument" value="Firmada" required> Firmada</label></fieldset><label class="field">PDF Ekle (isteğe bağlı)<input id="attachment" data-optional="true" type="file" accept="application/pdf"><small>PDF · En fazla 3 MB</small></label><label class="field">Fotoğraf Ekle (isteğe bağlı)<input id="photoAttachment" data-optional="true" type="file" accept="image/png,image/jpeg"><small>PNG veya JPEG · En fazla 3 MB</small></label><label class="field full">Kabul notu<textarea name="notes" rows="3" placeholder="Evrakın durumu ve teslim notları…"></textarea></label></div></div><div class="formbody" ${original ? 'hidden' : ''}><label class="settings-check"><input type="checkbox" id="intakeAddAnother" data-optional="true"> Bu müvekkil için başka evrak var mı?</label></div><div class="actions"><button type="reset" class="secondary">Formu Temizle</button><button class="primary" id="accept">Evrakı Kaydet</button><button type="button" class="secondary" id="createIntakeReceipt" ${receiptId ? '' : 'disabled'}>Tutanak Oluştur</button></div></form>${embeddedIntake ? '' : intakeBatchToolbar() + intakeSearchMarkup()}`;
  document.querySelector('.heading').append($('#newIntakeDocument'));
  $('#newIntakeDocument').onclick = () => {
    const form = $('#intakeForm');
    if (original) {
      intake(undefined, true);
      return;
    }
    form.hidden = !form.hidden;
    $('#newIntakeDocument').setAttribute('aria-expanded', String(!form.hidden));
    if (!form.hidden) form.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  $('#createIntakeReceipt').onclick = () => {
    if (receiptId) receipt(receiptId);
  };
  if (!embeddedIntake) bindIntakeBatchToolbar();
  setupDocumentTypes();
  setupClientCity('document');
  setupClientDistrict('document');
  setupClientCity('document2');
  setupClientDistrict('document2');
  setupClientCity('document3');
  setupClientDistrict('document3');
  setupOptionalDebtorFields();
  setupIntakeGuarantors();
  bindPropertyFields($('#intakeForm'));
  bindIntakeSearch();
  if (original) populateIntakeEdit(original);
  setupAssignmentAccess($('#intakeForm'));
  if (original && !['ceo', 'admin'].includes(hanAuth.role)) {
    $('#intakeForm').elements.amount.readOnly = true;
    $('#intakeForm').dataset.financeLocked = 'true';
  }
  setupIntakePrincipal($('#intakeForm'), original);
  setupRecordFormTabs($('#intakeForm'), 'intake');
  const folioField = $('#intakeFolioNumber').closest('label');
  folioField.classList.add('intake-folio-header');
  const trackingField = $('#intakeTrackingDate').closest('label');
  trackingField.classList.add('intake-tracking-header');
  const recordHeader = document.createElement('div');
  recordHeader.className = 'intake-record-header';
  recordHeader.append(folioField, trackingField);
  const typePicker = $('#intakeForm .document-types'),
    recordTabs = $('#intakeForm .record-form-tabs');
  if (typePicker && recordTabs) {
    recordTabs.before(typePicker);
    typePicker.after(recordHeader);
  } else $('#intakeForm .panelhead').after(recordHeader);
  const legacyPhoneKeys = ['phone2', 'referencePhone1', 'referencePhone2', 'officePhone1', 'officePhone2'];
  const contactRecord = original
    ? {
        ...original,
        additionalPhones: [
          ...(original.additionalPhones || []),
          ...legacyPhoneKeys.map((key) => original[key]).filter(Boolean),
        ],
      }
    : {};
  setupExtraContacts($('#intakeForm'), contactRecord);
  if (embeddedIntake) prepareEmbeddedIntake($('#intakeForm'));
  else {
    const clientSelect = $('#intakeForm').elements.client;
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Müvekkil adı, soyadı veya unvanı ara…';
    search.setAttribute('aria-label', 'Müvekkil ara');
    search.dataset.optional = 'true';
    const names = new Map(
      db.clients.map((client) => [
        client.id,
        [client.name, client.fullName, client.tradeName].map(normalizeSearch),
      ]),
    );
    const result = document.createElement('small');
    result.setAttribute('role', 'status');
    clientSelect.before(search);
    clientSelect.after(result);
    function filterClients() {
      const query = normalizeSearch(search.value);
      let count = 0;
      for (const option of clientSelect.options) {
        if (!option.value) continue;
        const matches = !query || (names.get(option.value) || []).some((name) => name.includes(query));
        option.hidden = !matches;
        if (matches) count++;
      }
      result.textContent = query
        ? count
          ? count + ' eşleşme. Listeden müvekkili seçin.'
          : 'Eşleşen müvekkil yok.'
        : '';
    }
    search.addEventListener('input', filterClients);
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        clientSelect.focus();
        clientSelect.showPicker?.();
      }
    });
    clientSelect.form.addEventListener('reset', () =>
      queueMicrotask(() => {
        search.value = '';
        filterClients();
      }),
    );
  }
  $('#intakeForm').elements.client.onchange = (e) => {
    selected = e.target.value;
    $('#clientScope').value = selected;
    stats();
  };
  $('#intakeForm').elements.receivedBy.required = true;
  const addAnother = $('#intakeAddAnother');
  if (!original) bindAdditionalIntake(addAnother.form);
  $('#intakeForm').onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    if (form.dataset.intakeSaved || form.dataset.intakeSaving) return;
    if (embeddedIntake && (!copySharedIntakeFields(form) || !form.reportValidity())) return;
    const keepForm = !original && (embeddedIntake || addAnother.checked);
    let d = Object.fromEntries(new FormData(form));
    Object.assign(
      d,
      embeddedIntake
        ? window.top.readExtraContacts(window.top.document.getElementById('intakeForm'))
        : readExtraContacts(form),
    );
    if (original) {
      d.docType = original.docType || 'Senet';
      for (const key of legacyPhoneKeys) d[key] = '';
    }
    if (['Senet', 'Diğer'].includes(d.docType)) {
      const total = financeCents(d.amount),
        paid = financeCents(d.preTrackingPayment || 0);
      if (
        !d.amount ||
        !Number.isSafeInteger(total) ||
        !Number.isSafeInteger(paid) ||
        total < 0 ||
        paid < 0 ||
        paid > total
      )
        return toast('Takip öncesi ödeme toplam evrak tutarını aşamaz.');
      d.originalAmount = total / 100;
      d.preTrackingPayment = paid / 100;
      d.amount = (total - paid) / 100;
    }
    const duplicate = clientDebtorIdentityConflict('document', original?.id, d.identity, d.debtor);
    if (duplicate) return toast(duplicate);
    if (!['ceo', 'admin'].includes(hanAuth.role)) {
      d.relatedStaff = original?.relatedStaff || '';
      d.relatedStaffName = original?.relatedStaffName || '';
    }
    d.guarantors = structuredClone(
      (embeddedIntake ? window.top.document.getElementById('intakeForm') : form)._guarantorDraft
        ?.guarantors || [],
    );
    if (!validatePropertyFields(d)) return;
    if (d.docType === 'Yediemin Park Ücreti') {
      d.captureStatus = d.captureStatus || '';
      d.captureDetails = d.captureStatus === 'Var' ? String(d.captureDetails || '').trim() : '';
    }
    if (!['Alındı', 'Firmada'].includes(d.originalDocument))
      return toast('Evrak aslı için Alındı veya Firmada seçeneğini işaretleyin.');
    const docCity = turkeyCities.find(
      (city) => city.toLocaleLowerCase('tr') === d.city.trim().toLocaleLowerCase('tr'),
    );
    if (!docCity) {
      $('#documentCity').setCustomValidity('Listeden geçerli bir il seçin.');
      $('#documentCity').reportValidity();
      return;
    }
    const docDistrict = (turkeyDistricts[docCity] || []).find(
      (district) => district.toLocaleLowerCase('tr') === d.district.trim().toLocaleLowerCase('tr'),
    );
    if (!docDistrict) {
      $('#documentDistrict').setCustomValidity('Seçtiğiniz ilin ilçelerinden birini seçin.');
      $('#documentDistrict').reportValidity();
      return;
    }
    d.city = docCity;
    d.district = docDistrict;
    for (const [prefix, base] of [
      ['document2', 'address2'],
      ['document3', 'officeAddress3'],
    ]) {
      d[base] = String(d[base] || '').trim();
      d[base + 'City'] = String(d[base + 'City'] || '').trim();
      d[base + 'District'] = String(d[base + 'District'] || '').trim();
      if (!d[base] && !d[base + 'City'] && !d[base + 'District']) continue;
      if (!d[base]) {
        const input = form.elements[base];
        input.setCustomValidity('Ek adres giriyorsanız açık adresi de tamamlayın.');
        input.reportValidity();
        return;
      }
      const city = turkeyCities.find(
        (city) => city.toLocaleLowerCase('tr') === d[base + 'City'].trim().toLocaleLowerCase('tr'),
      );
      const district =
        city &&
        (turkeyDistricts[city] || []).find(
          (district) =>
            district.toLocaleLowerCase('tr') === d[base + 'District'].trim().toLocaleLowerCase('tr'),
        );
      if (!city || !district) {
        const input = document.getElementById(prefix + (!city ? 'City' : 'District'));
        input.setCustomValidity('Geçerli bir il ve o ile bağlı ilçe seçin.');
        input.reportValidity();
        return;
      }
      d[base + 'City'] = city;
      d[base + 'District'] = district;
    }
    if (
      !d.recordedBy ||
      (d.recordedBy !== original?.recordedBy && !personnel.some((p) => p.id === d.recordedBy && p.active))
    )
      return toast('Evrak kaydeden için kayıtlı aktif personel seçin.');
    d.recordedByName = personnel.find((p) => p.id === d.recordedBy)?.name || original?.recordedByName || '';
    if (
      d.relatedStaff &&
      d.relatedStaff !== original?.relatedStaff &&
      !personnel.some((p) => p.id === d.relatedStaff && p.active)
    )
      return toast('Kayıtlı aktif bir personel seçin.');
    if (!db.clients.some((c) => c.id === d.client)) return toast('Geçerli bir müvekkil seçin.');
    if (
      d.receivedBy !== original?.receivedById &&
      d.receivedBy !== original?.receivedBy &&
      !personnel.some((p) => p.id === d.receivedBy && p.active)
    )
      return toast('Teslim alan için kayıtlı aktif personel seçin.');
    for (const k of ['debtor', 'deliveredBy', 'receivedBy']) {
      d[k] = d[k].trim();
      if (!d[k]) return toast('Zorunlu alanları doldurun.');
    }
    if (d.docType === 'Yediemin Park Ücreti') {
      if (!validParkingIdentity(d)) {
        const input = form.elements.vehiclePlate;
        input.setCustomValidity('Şase numarası, plaka veya TC/vergi numarasından en az birini girin.');
        input.reportValidity();
        return toast('Şase numarası, plaka veya TC/vergi numarasından en az birini girin.');
      }
      const fee = parkingFeeInfo(d, businessDate());
      if (!fee || fee.days <= 0) return toast('Geçerli araç cinsi ve giriş / men tarihi seçin.');
      if (original && ['İnfaz', 'İade'].includes(original.status)) {
        d.amount = original.amount;
      } else {
        applyParkingFee(d, businessDate());
      }
      const rate = Number(d.parkingCommissionRate);
      if (d.parkingCommissionRate === '' || !Number.isFinite(rate) || rate < 0 || rate > 100)
        return toast('Anlaşma yüzdesini 0 ile 100 arasında girin.');
      d.parkingCommissionRate = rate;
    }
    if (d.issued && d.due && d.issued > d.due) return toast('Vade tarihi düzenleme tarihinden önce olamaz.');
    if (
      original &&
      (financeEvents.some((e) => e.documentId === original.id) || original.repaymentPlan) &&
      ['amount', 'due', 'parkingCommissionRate', 'parkingEntry', 'vehicleKind'].some((key) =>
        ['due', 'parkingEntry', 'vehicleKind'].includes(key)
          ? String(d[key] ?? '') !== String(original[key] ?? '')
          : Number(d[key] || 0) !== Number(original[key] || 0),
      )
    )
      return toast('Finansal hareket veya yapılandırma bulunan evrakta tutar, vade ve oran değiştirilemez.');
    form.dataset.intakeSaving = 'true';
    try {
      const pdf = await readDocumentAttachment($('#attachment').files[0], ['application/pdf']);
      if (pdf) {
        d.fileName = pdf.name;
        d.fileData = pdf.data;
      }
      const photo = await readDocumentAttachment($('#photoAttachment').files[0], ['image/png', 'image/jpeg']);
      if (photo) {
        d.photoFileName = photo.name;
        d.photoData = photo.data;
      }
    } catch (error) {
      return toast(error.message);
    } finally {
      delete form.dataset.intakeSaving;
    }
    if (!original) {
      try {
        db = JSON.parse(localStorage.getItem('icrapro-v1'));
      } catch (error) {
        return toast(error.message || 'Güncel evraklar alınamadı.');
      }
      if (!form.isConnected || form.dataset.intakeSaved) return;
      const duplicate = clientDebtorIdentityConflict('document', undefined, d.identity, d.debtor);
      if (duplicate) return toast(duplicate);
    }
    d.receivedById = d.receivedBy;
    d.receivedBy = personnel.find((p) => p.id === d.receivedById)?.name || original?.receivedBy || '';
    d.relatedStaffName = d.relatedStaff
      ? personnel.find((p) => p.id === d.relatedStaff)?.name || original?.relatedStaffName || ''
      : '';
    const before = db.docs.slice();
    if (original) {
      d = {
        ...original,
        ...d,
        id: original.id,
        number: original.number,
        created: original.created,
        updatedAt: new Date().toISOString(),
      };
      db.docs[db.docs.findIndex((x) => x.id === original.id)] = d;
    } else {
      d.id = crypto.randomUUID();
      d.number = nextDocumentNumber(d.docType, db.docs, db.archivedNumbers);
      d.created = new Date().toISOString();
      d.trackingDate = businessDate();
      db.docs.push(d);
    }
    try {
      save();
    } catch (error) {
      db.docs = before;
      return toast(error.message || 'Evrak kaydedilemedi.');
    }
    if (!original) addToIntakeBatch(d.id);
    automaticLegalCharges(d);
    if (keepForm) {
      form.dataset.intakeSaved = 'true';
      form.querySelectorAll('input, select, textarea, button').forEach((control) => {
        if (control !== addAnother) control.disabled = true;
      });
      form.querySelector('#accept').textContent = 'Kaydedildi · ' + d.number;
      form.querySelector('#intakeFolioNumber').value = d.number;
      refreshIntakeBatchAfterSave();
    } else {
      intake(original?.id);
      stats();
    }
    toast(original ? 'Evrak değişiklikleri kaydedildi.' : 'Evrak kaydedildi.');
    if (!original) offerSameIdentityChain(d);
  };
}

function debtorStatus(d) {
  return ['Derdest', 'İnfaz', 'İade', 'İcra'].includes(d.status) ? d.status : 'Derdest';
}

function debtorColumnInput(key, label, options) {
  const attrs =
    ' data-debtor-column="' +
    key +
    '" data-optional="true" aria-label="' +
    esc(label) +
    '" style="display:block;width:100%;min-width:85px;margin-top:5px"';
  const value = debtorColumnFilters[key] || '';
  if (options) {
    return (
      '<select' +
      attrs +
      '><option value="">Tümü</option>' +
      options
        .map((option) => '<option' + (value === option ? ' selected' : '') + '>' + esc(option) + '</option>')
        .join('') +
      '</select>'
    );
  }
  return '<input type="search"' + attrs + ' placeholder="Süz…" value="' + esc(value) + '">';
}

function matchesDebtorColumns(doc) {
  const client = db.clients.find((item) => item.id === doc.client);
  const staff = personnel.find((item) => item.id === doc.relatedStaff);
  const values = {
    record: [doc.number, docType(doc), client?.name].join(' '),
    debtor: doc.debtor,
    staff: staff?.name || doc.relatedStaffName || 'Atanmadı',
    amount: money(doc.amount),
    tracking: displayDate(borrowerTrackingDate(doc)),
    due: displayDate(doc.due),
    closure: displayDate(clientPayoutClosureDate(doc)),
  };
  return Object.entries(debtorColumnFilters).every(
    ([key, value]) =>
      !value ||
      (key === 'type'
        ? docType(doc) === value
        : normalizeSearch(values[key]).includes(normalizeSearch(value))),
  );
}

function documents() {
  debtorStatusFilter = 'Derdest';
  $('#content').innerHTML =
    `<div class="panel"><div class="panelhead"><div><h2>Borçlu kayıtları</h2><p id="globalSearchHint">Borçlu, telefon, müvekkil, kimlik, evrak no, tür, tutar, tarih veya not ile arayın.</p></div><div class="toolbar global-search"><input class="search" id="docSearch" type="search" placeholder="Tüm alanlarda ara…" aria-label="Borçlu listesinde global arama" aria-describedby="globalSearchHint"><button type="button" class="secondary" id="clearDocSearch" hidden>Temizle</button></div></div><details class="borrower-filter-section" id="borrowerFilterSection"><summary>Filtreleme</summary>${borrowerFilterMarkup()}</details><div class="segments" style="padding:0 24px 20px" role="group" aria-label="Borçlu durum filtresi">${['Derdest', 'İnfaz', 'İade', 'İcra', 'Tümü'].map((status) => `<button type="button" data-status-filter="${status}">${status}</button>`).join('')}</div><div class="overflow borrower-records-scroll"><table class="borrower-records-table"><thead><tr><th>DURUM<select id="debtorColumnStatus" data-optional="true" aria-label="Duruma göre süz" style="display:block;width:100%;margin-top:5px">${['Tümü', 'Derdest', 'İnfaz', 'İade', 'İcra'].map((status) => '<option>' + status + '</option>').join('')}</select></th><th>EVRAK / MÜVEKKİL${debtorColumnInput('type', 'Evrak türüne göre süz', Object.keys(documentTypes))}${debtorColumnInput('record', 'Föy veya müvekkile göre süz')}</th><th>BORÇLU${debtorColumnInput('debtor', 'Borçluya göre süz')}</th><th>DOSYA SORUMLUSU${debtorColumnInput('staff', 'Dosya sorumlusuna göre süz')}</th><th>ASIL ALACAK${debtorColumnInput('amount', 'Asıl alacağa göre süz')}</th><th id="debtorEntryDateHeading"><button type="button" class="link" id="sortDebtorEntryDate" style="padding:0;font:inherit;color:inherit;letter-spacing:inherit">TAKİP TARİHİ ↕</button>${debtorColumnInput('tracking', 'Takip tarihine göre süz')}</th><th>VADE${debtorColumnInput('due', 'Vadeye göre süz')}</th><th id="closureDateHeading" hidden>İNFAZ TARİHİ${debtorColumnInput('closure', 'İnfaz tarihine göre süz')}</th><th>İŞLEM</th></tr></thead><tbody id="docRows"></tbody></table></div><div class="tablefoot" id="docSearchCount" role="status" aria-live="polite"></div></div>`;
  if (['ceo', 'admin'].includes(hanAuth.role)) {
    const archive = document.createElement('button');
    archive.type = 'button';
    archive.className = 'secondary';
    archive.textContent = 'Silinen Evraklar';
    archive.onclick = () => archivedDocuments();
    $('#docSearch').parentElement.append(archive);
  }
  document.querySelectorAll('[data-status-filter]').forEach(
    (button) =>
      (button.onclick = () => {
        debtorStatusFilter = button.dataset.statusFilter;
        docRows();
      }),
  );
  bindBorrowerFilters();
  $('#sortDebtorEntryDate').onclick = () => {
    debtorEntryDateSort = debtorEntryDateSort === -1 ? 1 : -1;
    docRows();
  };
  $('#debtorColumnStatus').onchange = (event) => {
    debtorStatusFilter = event.target.value;
    docRows();
  };
  document.querySelectorAll('[data-debtor-column]').forEach((input) => {
    input.oninput = () => {
      debtorColumnFilters[input.dataset.debtorColumn] = input.value;
      docRows();
    };
  });
  $('#docSearch').oninput = docRows;
  $('#clearDocSearch').onclick = () => {
    $('#docSearch').value = '';
    docRows();
    $('#docSearch').focus();
  };
  docRows();
}

function archivedDocuments(offset = 0) {
  let archive;
  try {
    archive = authApi('/api/documents/archived?offset=' + offset);
  } catch (error) {
    return toast(error.message);
  }
  const rows = archive.items
    .map(
      (row, index) => `<tr>
    <td><strong>${esc(row.number || '—')}</strong><small>${esc(row.type || '')}</small></td>
    <td>${esc(row.debtor || '—')}</td><td>${backupDate(row.deletedAt, true)}</td>
    <td>${esc(row.deletedByName || '—')}</td><td><button type="button" class="link" data-restore-row="${index}">Arşivden Çıkar</button></td>
  </tr>`,
    )
    .join('');
  $('#content').innerHTML = `<section class="panel"><div class="panelhead"><div><h2>Silinen Evraklar</h2>
    <p>Arşive alınan evraklar, ekleri ve tahsilat geçmişiyle korunur.</p></div>
    <button type="button" class="secondary" id="backToActiveDocs">Aktif Evraklar</button></div>
    ${rows ? `<div class="overflow"><table><thead><tr><th>Evrak</th><th>Borçlu</th><th>Arşiv zamanı</th><th>Arşivleyen</th><th>İşlem</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="formbody">Arşivde evrak yok.</p>'}
    <div class="actions"><button type="button" class="secondary" id="archivePrevious" ${offset ? '' : 'disabled'}>Daha yeni</button>
    <button type="button" class="secondary" id="archiveNext" ${offset + 50 < archive.total ? '' : 'disabled'}>Daha eski</button></div></section>`;
  $('#backToActiveDocs').onclick = () => documents();
  $('#archivePrevious').onclick = () => archivedDocuments(Math.max(0, offset - 50));
  $('#archiveNext').onclick = () => archivedDocuments(offset + 50);
  document.querySelectorAll('[data-restore-row]').forEach(
    (button) =>
      (button.onclick = () => {
        const row = archive.items[Number(button.dataset.restoreRow)];
        if (!row || !confirm('Evrak aktif listeye alınsın mı?')) return;
        try {
          authApi('/api/documents/restore', 'POST', { documentId: row.id });
          db = authApi('/api/data?key=icrapro-v1');
          archivedDocuments();
          toast('Evrak aktif listeye geri alındı.');
        } catch (error) {
          toast(error.message);
        }
      }),
  );
}

function docRows() {
  if (window.hanRecordsEnabled) return queueRecordPage();
  const showClosureDate = debtorStatusFilter === 'İnfaz';
  $('#closureDateHeading').hidden = !showClosureDate;
  $('#debtorColumnStatus').value = debtorStatusFilter;
  if (!showClosureDate) {
    delete debtorColumnFilters.closure;
    document.querySelector('[data-debtor-column=closure]').value = '';
  }
  updateActiveDebtorCount();
  const isAdmin = ['ceo', 'admin'].includes(hanAuth.role);
  db.docs.forEach(automaticLegalCharges);
  let q = $('#docSearch').value;
  let list = filteredBorrowers(db.docs, borrowerFilters, debtorStatusFilter, q, isAdmin).filter(
    matchesDebtorColumns,
  );
  const entryHeading = $('#debtorEntryDateHeading');
  entryHeading.setAttribute(
    'aria-sort',
    debtorEntryDateSort === 0 ? 'none' : debtorEntryDateSort === 1 ? 'ascending' : 'descending',
  );
  $('#sortDebtorEntryDate').textContent =
    'TAKİP TARİHİ ' + (debtorEntryDateSort === 0 ? '↕' : debtorEntryDateSort === 1 ? '↑' : '↓');
  if (debtorEntryDateSort) {
    list.sort((left, right) => {
      const first = borrowerTrackingDate(left);
      const second = borrowerTrackingDate(right);
      if (!first || !second) return Number(!first) - Number(!second);
      return debtorEntryDateSort * first.localeCompare(second);
    });
  }
  document.querySelectorAll('[data-status-filter]').forEach((button) => {
    const status = button.dataset.statusFilter;
    button.classList.toggle('selected', status === debtorStatusFilter);
    button.setAttribute('aria-pressed', String(status === debtorStatusFilter));
    button.textContent =
      status + ' (' + filteredBorrowers(db.docs, borrowerFilters, status, q, isAdmin).length + ')';
  });
  $('#clearDocSearch').hidden = !q;
  $('#docSearchCount').textContent =
    debtorStatusFilter +
    ': ' +
    list.length +
    ' / ' +
    db.docs.filter((d) => debtorStatusFilter === 'Tümü' || debtorStatus(d) === debtorStatusFilter).length +
    ' kayıt gösteriliyor';
  paintDocumentRows(list, isAdmin, showClosureDate);
}

function paintDocumentRows(list, isAdmin, showClosureDate) {
  const action = (id, callback) => (window.hanRecordsEnabled ? recordAction(id, callback) : callback());
  $('#docRows').innerHTML =
    list
      .map(
        (d) =>
          `<tr class="${debtorStatus(d) === 'İnfaz' ? 'status-closed' : debtorStatus(d) === 'İade' ? 'status-returned' : 'status-pending'}"><td><select ${isAdmin ? '' : 'disabled'} class="row-status" aria-label="${esc(d.debtor)} durumu" data-row-status="${esc(d.id)}">${['Derdest', 'İnfaz', 'İade', 'İcra'].map((status) => `<option ${status === debtorStatus(d) ? 'selected' : ''}>${status}</option>`).join('')}</select></td><td><strong>${esc(d.number)}</strong><small>${esc(docType(d))} · ${esc(d._clientName ?? db.clients.find((c) => c.id === d.client)?.name)}</small></td><td><button class="link debtor-name" data-debtor="${esc(d.id)}">${esc(d.debtor)}</button><small>${esc(d.status || 'Derdest')}</small></td><td>${borrowerAssignmentMarkup(d, isAdmin)}</td><td><strong>${d._principalCents ? recordMoney(d._principalCents) : money(d.amount)}</strong>${isAdmin ? `<small>Toplam alacak: ${d._targetCents ? recordMoney(d._targetCents) : money(docFinance(d).target / 100)}</small>` : ''}</td><td>${esc(displayDate(borrowerTrackingDate(d)) || '—')}</td><td>${esc(d.due ? displayDate(d.due) : '—')}</td>${showClosureDate ? '<td>' + esc(displayDate(clientPayoutClosureDate(d)) || '—') + '</td>' : ''}<td><button type="button" class="link" data-edit-debtor="${esc(d.id)}">Düzenle</button><button type="button" class="link" data-add-guarantor="${esc(d.id)}">Kefil Ekle</button><button class="link" data-receipt="${esc(d.id)}">Tutanak Görüntüle ↗</button>${isAdmin ? `<button class="link" data-finance="${esc(d.id)}">Finansal İşlemler</button>` : ''}${hanAuth.canDelete ? `<button type="button" class="link" data-delete-document="${esc(d.id)}">Dosyayı Sil</button>` : ''}${isAdmin && debtorStatus(d) === 'Derdest' ? `<button type="button" class="link" data-move-enforcement="${esc(d.id)}">İcraya Taşı</button>` : ''}</td></tr>`,
      )
      .join('') ||
    `<tr><td colspan="${showClosureDate ? 9 : 8}" class="empty">Seçili durum ve aramayla eşleşen borçlu bulunamadı.</td></tr>`;
  document
    .querySelectorAll('[data-delete-document]')
    .forEach(
      (b) =>
        (b.onclick = () =>
          action(b.dataset.deleteDocument, () => deleteBorrowerDocument(b.dataset.deleteDocument))),
    );
  document
    .querySelectorAll('[data-move-enforcement]')
    .forEach(
      (b) =>
        (b.onclick = () =>
          action(b.dataset.moveEnforcement, () => moveBorrowerToEnforcement(b.dataset.moveEnforcement))),
    );
  document
    .querySelectorAll('[data-save-assignment]')
    .forEach(
      (b) =>
        (b.onclick = () =>
          action(b.dataset.saveAssignment, () => saveBorrowerAssignment(b.dataset.saveAssignment))),
    );
  document
    .querySelectorAll('[data-edit-debtor]')
    .forEach(
      (b) => (b.onclick = () => action(b.dataset.editDebtor, () => editBorrower(b.dataset.editDebtor))),
    );
  document.querySelectorAll('[data-add-guarantor]').forEach(
    (b) =>
      (b.onclick = () =>
        action(b.dataset.addGuarantor, () => {
          const d = db.docs.find((d) => d.id === b.dataset.addGuarantor);
          if (d) guarantorForm(d);
        })),
  );
  document
    .querySelectorAll('[data-row-status]')
    .forEach(
      (select) =>
        (select.onchange = () =>
          action(select.dataset.rowStatus, () => changeDebtorStatus(select.dataset.rowStatus, select.value))),
    );
  document
    .querySelectorAll('[data-debtor]')
    .forEach((b) => (b.onclick = () => action(b.dataset.debtor, () => borrowerDetail(b.dataset.debtor))));
  document
    .querySelectorAll('[data-finance]')
    .forEach(
      (b) => (b.onclick = () => action(b.dataset.finance, () => financialOperations(b.dataset.finance))),
    );
  document
    .querySelectorAll('[data-receipt]')
    .forEach((b) => (b.onclick = () => action(b.dataset.receipt, () => receipt(b.dataset.receipt))));
}

function receipt(id) {
  let d = db.docs.find((x) => x.id === id),
    c = db.clients.find((x) => x.id === d.client);
  $('#modal').innerHTML =
    `<div class="receipt"><p class="eyebrow">hanhukuk 1.1.1 · EVRAK KABUL</p>${firmReceipt()}<h2>${esc(docType(d))} Teslim Tutanağı</h2><p><b>Evrak No:</b> ${esc(d.number)}<br><b>Kabul Tarihi:</b> ${new Date(d.created).toLocaleDateString('tr-TR')}<br><b>Müvekkil:</b> ${esc(c?.name)}<br><b>Borçlu:</b> ${esc(d.debtor)}<br><b>Evrak Aslı:</b> ${esc(d.originalDocument || 'Belirtilmedi')}<br><b>Evrak No / Referans:</b> ${esc(d.serial || '—')}${documentExtraReceipt(d)}<br><b>Tutar:</b> ${money(d.amount)}<br><b>Vade:</b> ${esc(d.due ? displayDate(d.due) : '—')}</p><p><b>Tel-1 / Tel-2:</b> ${esc(d.phone1 || '—')} / ${esc(d.phone2 || '—')}<br><b>Ref. Tel-1 / Tel-2:</b> ${esc(d.referencePhone1 || '—')} / ${esc(d.referencePhone2 || '—')}<br><b>Ofis Tel-1 / Tel-2:</b> ${esc(d.officePhone1 || '—')} / ${esc(d.officePhone2 || '—')}<br><b>Adres:</b> ${esc([d.address, d.district, d.city].filter(Boolean).join(' / '))}<br><b>Borçlu Adres-2:</b> ${esc([d.address2, d.address2District, d.address2City].filter(Boolean).join(' / ') || '—')}<br><b>Borçlu Adres (Ofis)-3:</b> ${esc([d.officeAddress3, d.officeAddress3District, d.officeAddress3City].filter(Boolean).join(' / ') || '—')}</p><p><b>Dosya Sorumlusu:</b> ${esc(personnel.find((p) => p.id === d.relatedStaff)?.name || d.relatedStaffName || '—')}<br><b>Teslim Eden:</b> ${esc(d.deliveredBy)}<br><b>Teslim Alan:</b> ${esc(d.receivedBy)}</p><p><b>Kabul Notu:</b> ${esc(d.notes || '—')}</p>${d.fileData ? `<p>${attachmentDownloadLink(d.fileData, d.fileName, 'Ekli evrakı indir: ' + (d.fileName || 'Evrak'), 'pdf')}</p>` : ''}${d.photoData ? `<p>${attachmentDownloadLink(d.photoData, d.photoFileName || 'fotograf', 'Fotoğrafı indir: ' + (d.photoFileName || 'Fotoğraf'), 'photo')}</p>` : ''}<div class="grid" style="margin-top:35px"><div>Teslim Eden İmza<br>________________</div><div>Teslim Alan İmza<br>________________</div></div><p style="font-size:11px;color:#8a95a2;margin-top:30px">Prototip çıktısıdır. Resmî işlem veya elektronik imza içermez.</p></div><div class="actions"><button class="secondary" id="closeReceipt">Kapat</button><button class="primary" id="print">Yazdır / PDF</button></div>`;
  $('#modal').showModal();
  $('#closeReceipt').onclick = () => $('#modal').close();
  $('#print').onclick = () => window.print();
  const actions = $('#modal').querySelector('.actions');
  addWhatsAppFileButton(actions, d, 'receipt');
  if (d.fileData) addWhatsAppFileButton(actions, d, 'file');
  if (d.photoData) addWhatsAppFileButton(actions, d, 'photo');
}

function setupOptionalDebtorFields() {
  const form = document.getElementById('intakeForm');
  for (const name of [
    'notes',
    'relatedStaff',
    'phone2',
    'referencePhone1',
    'referencePhone2',
    'officePhone1',
    'officePhone2',
    'address2',
    'address2City',
    'address2District',
    'officeAddress3',
    'officeAddress3City',
    'officeAddress3District',
  ]) {
    const input = form.elements[name];
    if (!input) continue;
    input.dataset.optional = 'true';
    input.required = false;
    input.setAttribute('aria-required', 'false');
    const label = input.id ? form.querySelector('label[for="' + input.id + '"]') : input.closest('label');
    if (label?.firstChild?.nodeType === 3)
      label.firstChild.textContent = label.firstChild.textContent.replace(/\s*\*/g, '');
  }
}

function changeDebtorStatus(id, status) {
  const d = db.docs.find((d) => d.id === id);
  if (!d || !['Derdest', 'İnfaz', 'İade', 'İcra'].includes(status)) return;
  if (status === 'İcra' && debtorStatus(d) !== 'İcra') return moveBorrowerToEnforcement(id);
  const totals = docFinance(d);
  if (status === 'İnfaz' && totals.remaining > 0) {
    toast('İnfaz için kalan borcun tamamen tahsil edilmiş olması gerekir.');
    docRows();
    return;
  }
  if (status !== 'İnfaz' && totals.received > 0 && totals.remaining === 0) {
    toast('Tamamı tahsil edilmiş evrak infaz durumunda kalmalıdır.');
    docRows();
    return;
  }
  const previous = d.status;
  d.status = status;
  try {
    save();
  } catch {
    d.status = previous;
    toast('Durum kaydedilemedi.');
    docRows();
    return;
  }
  stats();
  docRows();
  toast('Borçlu durumu ' + status + ' olarak kaydedildi.');
}

function intakeSearchMarkup() {
  return `<div class="panel" style="margin-bottom:22px"><div class="panelhead"><div><h2>Kayıtlı Evrak Ara</h2><p>Evrak numarası, borçlu, müvekkil, TC kimlik veya diğer bilgilerle arayın.</p></div><input type="search" class="search" id="intakeSearch" placeholder="Kayıtlı evraklarda ara…" aria-label="Kayıtlı evrak ara"></div><div class="overflow"><table><thead><tr><th>EVRAK / TÜR</th><th>BORÇLU / MÜVEKKİL</th><th>DURUM</th><th>İŞLEM</th></tr></thead><tbody id="intakeSearchResults"></tbody></table></div><div class="tablefoot" id="intakeSearchTotal" role="status"></div></div>`;
}

function bindIntakeSearch() {
  const input = $('#intakeSearch');
  function search() {
    const query = input.value.trim(),
      list = db.docs.filter((d) =>
        matchesGlobalSearch(
          d,
          db.clients.find((c) => c.id === d.client),
          query,
        ),
      );
    $('#intakeSearchResults').innerHTML =
      list
        .map(
          (d) =>
            `<tr><td><strong>${esc(d.number)}</strong><small>${esc(docType(d))}</small></td><td>${esc(d.debtor)}<small>${esc(db.clients.find((c) => c.id === d.client)?.name)}</small></td><td>${esc(debtorStatus(d))}</td><td><button type="button" class="link" data-edit-intake="${esc(d.id)}">Aç / Düzelt</button></td></tr>`,
        )
        .join('') || '<tr><td colspan="4" class="empty">Eşleşen evrak bulunamadı.</td></tr>';
    $('#intakeSearchTotal').textContent = list.length + ' / ' + db.docs.length + ' evrak';
    document.querySelectorAll('[data-edit-intake]').forEach(
      (b) =>
        (b.onclick = () => {
          const d = db.docs.find((d) => d.id === b.dataset.editIntake);
          if (d) {
            selected = d.client;
            intake(d.id);
            $('#intakeForm').scrollIntoView({ block: 'start', behavior: 'smooth' });
          }
        }),
    );
  }
  input.oninput = search;
  search();
}

function setupIntakePrincipal(form, original) {
  const { amount, preTrackingPayment, docType } = form.elements;
  const result = form.querySelector('#intakePrincipal');
  if (original && ['Senet', 'Diğer'].includes(docType.value))
    amount.value = original.originalAmount ?? original.amount;
  preTrackingPayment.readOnly = Boolean(form.dataset.financeLocked);
  function refresh() {
    const active = !embeddedIntake && ['Senet', 'Diğer'].includes(docType.value);
    preTrackingPayment.disabled = !active;
    if (preTrackingPayment._moneyProxy) preTrackingPayment._moneyProxy.disabled = !active;
    form.querySelectorAll('[data-pre-tracking-amount]').forEach((label) => {
      label.hidden = !active;
    });
    const total = financeCents(amount.value);
    const paid = financeCents(preTrackingPayment.value || 0);
    result.value = active && amount.value && paid <= total ? formatAmountInput((total - paid) / 100) : '';
  }
  form.addEventListener('input', refresh);
  docType.addEventListener('change', refresh);
  form.addEventListener('reset', () => queueMicrotask(refresh));
  refresh();
}

function populateIntakeEdit(d) {
  const form = $('#intakeForm');
  form.dataset.existingFolio = d.number;
  form.querySelector('#intakeFolioNumber').value = d.number;
  form.elements.docType.value = d.docType || 'Senet';
  form.elements.docType.dispatchEvent(new Event('change', { bubbles: true }));
  for (const [key, value] of Object.entries(d)) {
    const control = form.elements[key];
    if (!control || typeof value === 'object' || key === 'receivedBy' || key === 'receivedById') continue;
    if (control instanceof RadioNodeList) {
      for (const radio of control) radio.checked = radio.value === String(value);
    } else if (control.type !== 'file') control.value = String(value ?? '');
  }
  for (const [prefix, key] of [
    ['document', 'city'],
    ['document2', 'address2City'],
    ['document3', 'officeAddress3City'],
  ]) {
    const city = document.getElementById(prefix + 'City'),
      district = document.getElementById(prefix + 'District');
    city.value = d[key] || '';
    city.dispatchEvent(new Event('change', { bubbles: true }));
    district.value = d[key === 'city' ? 'district' : key.replace('City', 'District')] || '';
  }
  for (const [name, value] of [
    ['receivedBy', d.receivedById || d.receivedBy],
    ['relatedStaff', d.relatedStaff],
    ['recordedBy', d.recordedBy],
  ]) {
    const control = form.elements[name];
    if (value && ![...control.options].some((o) => o.value === value)) {
      control.add(
        new Option(
          (name === 'receivedBy'
            ? d.receivedBy
            : name === 'recordedBy'
              ? d.recordedByName
              : d.relatedStaffName) || value,
          value,
        ),
      );
    }
    control.value = value || '';
  }
  form.elements.docType.disabled = true;
  document.querySelectorAll('[data-doc-type]').forEach((b) => (b.disabled = true));
  form._guarantorDraft = {
    _intakeDraft: true,
    debtor: d.debtor,
    number: d.number,
    guarantors: structuredClone(d.guarantors || []),
  };
  renderIntakeGuarantors();
  bindPropertyFields(form);
  form.querySelector('.badge').textContent = 'Düzenleniyor · ' + d.number;
  $('#accept').textContent = 'Değişiklikleri Kaydet';
  form.querySelector('button[type="reset"]').onclick = (e) => {
    e.preventDefault();
    intake();
  };
  if (financeEvents.some((e) => e.documentId === d.id) || d.repaymentPlan) {
    form.dataset.financeLocked = 'true';
    for (const name of ['amount', 'due', 'parkingCommissionRate', 'parkingEntry', 'vehicleKind'])
      if (form.elements[name]) {
        if (form.elements[name].tagName === 'SELECT') {
          form.elements[name].setAttribute('aria-readonly', 'true');
          form.elements[name].onchange = () => {
            form.elements[name].value = d[name] || '';
            form._refreshParkingFee?.();
          };
        } else form.elements[name].readOnly = true;
      }
    form.querySelector('.notice').textContent =
      'Finansal kayıtlar korunur. Tutar, vade ve anlaşma oranı bu ekranda değiştirilemez.';
  }
  const photoUrl = safeAttachmentUrl(d.photoData, 'photo'),
    fileUrl = safeAttachmentUrl(d.fileData, 'pdf');
  if (photoUrl) {
    const note = document.createElement('p'),
      link = document.createElement('a');
    link.href = photoUrl;
    link.download = d.photoFileName || 'fotograf';
    link.textContent = 'Mevcut fotoğraf: ' + (d.photoFileName || 'Fotoğraf');
    note.append(link);
    $('#photoAttachment').after(note);
  }
  if (fileUrl) {
    const note = document.createElement('p'),
      link = document.createElement('a');
    link.href = fileUrl;
    link.download = d.fileName || 'evrak';
    link.textContent = 'Mevcut evrak: ' + (d.fileName || 'Ek dosya');
    note.append(link);
    $('#attachment').after(note);
  }
  if (form._refreshParkingFee && !['İnfaz', 'İade'].includes(d.status)) form._refreshParkingFee();
  selected = d.client;
  $('#clientScope').value = selected;
  stats();
}

function setupIntakeGuarantors() {
  const form = $('#intakeForm');
  form._guarantorDraft = { _intakeDraft: true, debtor: 'Yeni borçlu', number: 'Yeni evrak', guarantors: [] };
  form.addEventListener('reset', () => {
    form._guarantorDraft.guarantors = [];
    renderIntakeGuarantors();
  });
  renderIntakeGuarantors();
}

function renderIntakeGuarantors() {
  const form = $('#intakeForm');
  if (!form?._guarantorDraft) return;
  const draft = form._guarantorDraft;
  $('#intakeGuarantors').innerHTML = guarantorSection(draft);
  bindGuarantors(draft);
}

function intakeBatchKey() {
  return 'hanhukuk-intake-batch-' + (window.hanAuth?.id || 'local');
}

function intakeBatchIds() {
  try {
    const value = JSON.parse(sessionStorage.getItem(intakeBatchKey()) || '[]');
    return Array.isArray(value) ? [...new Set(value)].filter((id) => db.docs.some((d) => d.id === id)) : [];
  } catch {
    return [];
  }
}

function addToIntakeBatch(id) {
  const ids = intakeBatchIds();
  if (!ids.includes(id)) ids.push(id);
  sessionStorage.setItem(intakeBatchKey(), JSON.stringify(ids));
}

function intakeBatchToolbar() {
  const ids = intakeBatchIds();
  const count = ids.length;
  const batch = ids.map((id) => db.docs.find((doc) => doc.id === id));
  const summary = batch.length
    ? '<ul aria-label="Bu teslim grubundaki evraklar">' +
      batch
        .map(
          (doc) => '<li>' + esc(doc.number) + ' · ' + esc(docType(doc)) + ' · ' + esc(doc.debtor) + '</li>',
        )
        .join('') +
      '</ul>'
    : '';
  return (
    '<div id="intakeBatchGroup" class="panel formbody" style="margin-bottom:20px"><div class="toolbar"><button type="button" class="primary" id="intakeBatchReceipt">Teslim Tesellüm (' +
    count +
    ')</button><button type="button" class="secondary" id="newIntakeBatch">Yeni Teslim Grubu</button></div><p>Bu kabul grubunda kaydedilen evraklar toplu listelenir. Yeni teslim grubu açmak kayıtlı evrakları silmez.</p>' +
    summary +
    '</div>'
  );
}

function bindIntakeBatchToolbar() {
  $('#intakeBatchReceipt').onclick = intakeBatchReceipt;
  $('#newIntakeBatch').onclick = () => {
    sessionStorage.setItem(intakeBatchKey(), '[]');
    intake();
    toast('Yeni teslim grubu açıldı.');
  };
}

function intakeBatchReceipt() {
  const ids = intakeBatchIds(),
    docs = ids.map((id) => db.docs.find((d) => d.id === id));
  if (!docs.length) return toast('Bu teslim grubunda henüz kaydedilmiş evrak yok.');
  const total = docs.reduce((sum, d) => sum + financeCents(d.amount), 0);
  $('#modal').innerHTML =
    `<div class="receipt">${firmReceipt()}<h2>Teslim Tesellüm Tutanağı</h2><p>Tarih: ${esc(displayDate(businessDate()))} · Evrak adedi: ${docs.length}</p><div class="overflow"><table><thead><tr><th>SIRA</th><th>EVRAK NO / TÜR</th><th>MÜVEKKİL</th><th>BORÇLU</th><th>VADE</th><th>EVRAK ASLI</th><th>TUTAR</th></tr></thead><tbody>${docs.map((d, i) => `<tr><td>${i + 1}</td><td>${esc(d.number)}<small>${esc(docType(d))}</small></td><td>${esc(db.clients.find((c) => c.id === d.client)?.name || '—')}</td><td>${esc(d.debtor)}</td><td>${esc(displayDate(d.due) || '—')}</td><td>${esc(d.originalDocument || '—')}</td><td>${money(d.amount)}</td></tr>`).join('')}</tbody><tfoot><tr><td colspan="6"><b>TOPLAM</b></td><td><b>${money(total / 100)}</b></td></tr></tfoot></table></div><div class="grid" style="margin-top:35px"><div>Teslim Eden: ${esc([...new Set(docs.map((d) => d.deliveredBy).filter(Boolean))].join(', '))}<br>İmza: __________________</div><div>Teslim Alan: ${esc([...new Set(docs.map((d) => d.receivedBy).filter(Boolean))].join(', '))}<br>İmza: __________________</div></div><p>Yukarıda listelenen evraklar belirtilen asıl durumlarıyla teslim edilmiştir.</p></div><div class="actions"><button type="button" class="secondary" id="closeBatchReceipt">Kapat</button><button type="button" class="primary" id="printBatchReceipt">Yazdır / PDF</button></div>`;
  $('#closeBatchReceipt').onclick = () => $('#modal').close();
  $('#printBatchReceipt').onclick = () => window.print();
  addWhatsAppFileButton($('#modal').querySelector('.actions'), docs[0], 'batchReceipt', null, {
    documentIds: ids,
  });
  $('#modal').showModal();
}

async function readDocumentAttachment(file, types) {
  if (!file) return null;
  if (file.size > 3 * 1024 * 1024) throw Error('Her dosya en fazla 3 MB olabilir.');
  if (!types.includes(file.type)) throw Error('PDF alanına PDF, fotoğraf alanına PNG veya JPEG seçin.');
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(Error('Dosya okunamadı.'));
    reader.readAsDataURL(file);
  });
  return { name: file.name, data };
}

function recordFieldGroup(node, kind) {
  if (node.dataset.recordGroup) return node.dataset.recordGroup;
  if (node.id === 'intakeGuarantors') return 'guarantors';
  if (node.querySelector('[data-property-details]')) return 'assets';
  const controls = [
    ...(node.matches('input,select,textarea') ? [node] : []),
    ...node.querySelectorAll('input,select,textarea'),
  ];
  const keys = controls.map((el) => el.name || el.id);
  if (
    keys.some((k) => ['attachment', 'photoAttachment', 'clientPhotos', 'clientPowerOfAttorney'].includes(k))
  )
    return 'files';
  if (keys.some((k) => /^(bankName|bankBranch|accountHolder|iban)$/.test(k))) return 'bank';
  if (keys.some((k) => /^(city|district|address|address2.*|officeAddress3.*)$/.test(k))) return 'address';
  if (keys.some((k) => /^(phone.*|referencePhone.*|officePhone.*|phone|email)$/.test(k)))
    return kind === 'client' ? 'contact' : 'debtor';
  if (
    keys.some((k) =>
      [
        'relatedStaff',
        'receivedBy',
        'recordedBy',
        'deliveredBy',
        'originalDocument',
        'notes',
        'documentStaff',
        'collectionStaff',
        'reference',
      ].includes(k),
    )
  )
    return kind === 'client' ? 'staff' : 'delivery';
  if (keys.some((k) => ['debtor', 'identity'].includes(k))) return kind === 'client' ? 'general' : 'debtor';
  if (
    kind === 'intake' &&
    (node.id === 'typeFields' ||
      node.classList.contains('document-types') ||
      keys.some((k) => ['docType', 'amount', 'due', 'issued', 'serial'].includes(k)))
  )
    return 'document';
  return kind === 'client' ? 'general' : 'document';
}

function setupRecordFormTabs(form, kind) {
  if (!form || form.dataset.tabbed) return;
  form.dataset.tabbed = 'true';
  const definitions =
    kind === 'client'
      ? [
          ['general', 'Müvekkil Bilgileri'],
          ['contact', 'İletişim'],
          ['address', 'Adres'],
          ['staff', 'Personel ve Notlar'],
          ['bank', 'Banka Bilgileri'],
          ['files', 'Fotoğraf / Vekâletname'],
        ]
      : [
          ['document', 'Müvekkil ve Evrak'],
          ['debtor', 'Borçlu Bilgileri'],
          ['address', 'Adresler'],
          ['delivery', 'Teslim ve Personel'],
          ['assets', 'Tapu / Araç / SGK'],
          ['guarantors', 'Kefiller'],
          ['files', 'PDF / Fotoğraf'],
        ];
  const body = form.querySelector('.formbody'),
    nodes = [];
  for (const node of [...body.children]) {
    if (node.classList.contains('grid') && node.id !== 'typeFields') nodes.push(...node.children);
    else nodes.push(node);
  }
  const nav = document.createElement('div');
  nav.className = 'settings-tabs record-form-tabs';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', kind === 'client' ? 'Müvekkil kayıt bölümleri' : 'Evrak kayıt bölümleri');
  const panels = new Map();
  for (const [key, label] of definitions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.formTab = key;
    button.id = form.id + '-tab-' + key;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', form.id + '-panel-' + key);
    nav.append(button);
    const panel = document.createElement('section');
    panel.dataset.formPanel = key;
    panel.id = form.id + '-panel-' + key;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    const grid = document.createElement('div');
    grid.className = 'grid';
    panel.append(grid);
    panels.set(key, { panel, grid, button });
  }
  for (const node of nodes) {
    if (node.matches('h3.sectiontitle')) {
      node.remove();
      continue;
    }
    if (node.classList.contains('notice')) continue;
    const group = recordFieldGroup(node, kind);
    if (!node.classList.contains('field')) node.classList.add('full');
    (panels.get(group) || panels.values().next().value).grid.append(node);
  }
  for (const child of [...body.children])
    if (child.classList.contains('grid') && !child.children.length) child.remove();
  body.append(nav);
  for (const { panel } of panels.values()) body.append(panel);
  function select(key) {
    for (const [k, { panel, button }] of panels) {
      const active = k === key;
      panel.hidden = !active;
      button.classList.toggle('selected', active);
      button.setAttribute('aria-selected', String(active));
    }
    form.dataset.activeFormTab = key;
  }
  for (const [key, { button }] of panels) button.onclick = () => select(key);
  form.addEventListener(
    'invalid',
    (event) => {
      const first = form.querySelector('input:invalid,select:invalid,textarea:invalid') || event.target;
      const panel = first.closest('[data-form-panel]');
      if (panel) select(panel.dataset.formPanel);
      if (event.target !== first) event.preventDefault();
    },
    true,
  );
  form.addEventListener('reset', () => select(definitions[0][0]));
  select(definitions[0][0]);
}

function borrowerAssignmentMarkup(d, isAdmin) {
  const current = personnel.find((p) => p.id === d.relatedStaff),
    name = current?.name || d.relatedStaffName || 'Atanmadı';
  if (!isAdmin) return esc(name);
  return `<div><small>Mevcut: ${esc(name)}${current && current.active !== true ? ' (pasif)' : ''}</small><select data-assignment-for="${esc(d.id)}" aria-label="${esc(d.debtor)} dosya sorumlusu"><option value="">Aktif personel seçin</option>${personnel
    .filter((p) => p.active === true)
    .map(
      (p) =>
        `<option value="${esc(p.id)}" ${p.id === d.relatedStaff ? 'selected' : ''}>${esc(p.name)}</option>`,
    )
    .join(
      '',
    )}</select><button type="button" class="link" data-save-assignment="${esc(d.id)}">Sorumlu Ata</button></div>`;
}

function saveBorrowerAssignment(id) {
  const select = document.querySelector('[data-assignment-for="' + id + '"]');
  if (!select?.value) return toast('Aktif bir personel seçin.');
  try {
    const result = authApi('/api/documents/assign', 'POST', { documentId: id, staffId: select.value }),
      index = db.docs.findIndex((d) => d.id === id);
    if (index >= 0) db.docs[index] = result.document;
    docRows();
    toast('Dosya sorumlusu kaydedildi.');
  } catch (error) {
    toast(error.message);
  }
}

function setupAssignmentAccess(form) {
  const select = form.elements.relatedStaff;
  if (!select) return;
  if (!['ceo', 'admin'].includes(hanAuth.role)) {
    select.disabled = true;
    select.closest('label').querySelector('small').textContent =
      'Dosya sorumlusunu yalnızca yönetici atayabilir.';
  }
}

function filteredBorrowers(docs, filters, status, query, isAdmin) {
  const norm = normalizeSearch;
  return docs.filter((d) => {
    if (status !== 'Tümü' && debtorStatus(d) !== status) return false;
    if (
      !matchesGlobalSearch(
        d,
        db.clients.find((c) => c.id === d.client),
        query,
      )
    )
      return false;
    if ((filters.client && d.client !== filters.client) || (filters.type && docType(d) !== filters.type))
      return false;
    if (
      filters.staff &&
      (filters.staff === 'unassigned' ? !!d.relatedStaff : d.relatedStaff !== filters.staff)
    )
      return false;
    if (filters.identity && !String(d.identity || '').includes(filters.identity.trim())) return false;
    if (filters.phone && !borrowerPhoneMatches(d, filters.phone)) return false;
    if (
      filters.enforcementOffice &&
      !norm(d.enforcementOffice).includes(norm(filters.enforcementOffice).trim())
    )
      return false;
    if (
      filters.enforcementFileNumber &&
      !norm(d.enforcementFileNumber).includes(norm(filters.enforcementFileNumber).trim())
    )
      return false;
    if (
      (filters.number && !norm(d.number).includes(norm(filters.number).trim())) ||
      (filters.debtor && !norm(d.debtor).includes(norm(filters.debtor).trim()))
    )
      return false;
    const tracking = borrowerTrackingDate(d);
    if (
      (filters.trackingStart && (!tracking || tracking < filters.trackingStart)) ||
      (filters.trackingEnd && (!tracking || tracking > filters.trackingEnd))
    )
      return false;
    if (
      (filters.dueStart && (!d.due || d.due < filters.dueStart)) ||
      (filters.dueEnd && (!d.due || d.due > filters.dueEnd))
    )
      return false;
    const amount = isAdmin ? docFinance(d).target : financeCents(d.amount);
    return (
      (filters.minCents === '' || filters.minCents == null || amount >= filters.minCents) &&
      (filters.maxCents === '' || filters.maxCents == null || amount <= filters.maxCents)
    );
  });
}

function borrowerFilterMarkup() {
  const f = borrowerFilters;
  return `<form id="borrowerFilterForm" class="formbody"><div class="grid"><label class="field">Müvekkil${window.hanRecordsEnabled && !window.hanWorkspaceComplete ? recordClientFilterMarkup() : `<select name="client" data-optional="true"><option value="">Tüm Müvekkiller</option>${db.clients.map((c) => `<option value="${esc(c.id)}" ${f.client === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`}</label><label class="field">Evrak Türü<select name="type" data-optional="true"><option value="">Tüm Evrak Türleri</option>${Object.keys(
    documentTypes,
  )
    .map((t) => `<option value="${esc(t)}" ${f.type === t ? 'selected' : ''}>${esc(t)}</option>`)
    .join(
      '',
    )}</select></label><label class="field">Evrak No<input name="number" data-optional="true" value="${esc(f.number)}"></label><label class="field">Borçlu Adı<input name="debtor" data-optional="true" value="${esc(f.debtor)}"></label><label class="field">TC Kimlik / Vergi No<input name="identity" inputmode="numeric" data-optional="true" value="${esc(f.identity || '')}" placeholder="TC kimlik veya vergi numaras?"></label><label class="field">Telefon Numarası<input name="phone" type="tel" data-optional="true" value="${esc(f.phone || '')}" placeholder="Telefon numarası ara…"></label><label class="field">İcra Dairesi<input name="enforcementOffice" data-optional="true" value="${esc(f.enforcementOffice || '')}" placeholder="İcra dairesi ara…"></label><label class="field">İcra Dosya Numarası<input name="enforcementFileNumber" data-optional="true" value="${esc(f.enforcementFileNumber || '')}" placeholder="Örn. 2026/1234"></label><label class="field">Dosya Sorumlusu<select name="staff" data-optional="true"><option value="">Tüm Personeller</option><option value="unassigned" ${f.staff === 'unassigned' ? 'selected' : ''}>Atanmamış Dosyalar</option>${personnel.map((p) => `<option value="${esc(p.id)}" ${f.staff === p.id ? 'selected' : ''}>${esc(p.name)}${p.active ? '' : ' (pasif)'}</option>`).join('')}</select></label><label class="field">En Az Tutar (TL)<input name="minAmount" inputmode="decimal" data-optional="true" placeholder="0,00" value="${esc(f.minAmount)}"></label><label class="field">En Çok Tutar (TL)<input name="maxAmount" inputmode="decimal" data-optional="true" placeholder="0,00" value="${esc(f.maxAmount)}"></label><label class="field">Takip Tarihi Başlangıcı<input type="date" name="trackingStart" data-optional="true" value="${esc(f.trackingStart || '')}"></label><label class="field">Takip Tarihi Bitişi<input type="date" name="trackingEnd" data-optional="true" value="${esc(f.trackingEnd || '')}"></label><label class="field">Vade Başlangıcı<input type="date" name="dueStart" data-optional="true" value="${esc(f.dueStart)}"></label><label class="field">Vade Bitişi<input type="date" name="dueEnd" data-optional="true" value="${esc(f.dueEnd)}"></label></div><div class="toolbar" style="margin-top:16px"><button class="primary" type="submit">Filtrele</button><button class="secondary" type="button" id="clearBorrowerFilters">Tüm Filtreleri Temizle</button></div></form>`;
}

function bindBorrowerFilters() {
  const form = $('#borrowerFilterForm');
  if (window.hanRecordsEnabled) bindRecordClientLookup(form);
  for (const name of ['minAmount', 'maxAmount'])
    form.elements[name].oninput = () => form.elements[name].setCustomValidity('');
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const next = Object.fromEntries(new FormData(form));
    for (const [input, key] of [
      ['minAmount', 'minCents'],
      ['maxAmount', 'maxCents'],
    ]) {
      const parsed = parseAmountInput(next[input]);
      if (parsed === null || (parsed !== '' && Number(parsed) < 0)) {
        form.elements[input].setCustomValidity('Geçerli, sıfır veya pozitif tutar girin.');
        form.elements[input].reportValidity();
        return;
      }
      next[key] = parsed === '' ? '' : financeCents(parsed);
      if (parsed !== '') {
        next[input] = formatAmountInput(parsed);
        form.elements[input].value = next[input];
      }
    }
    if (next.minCents !== '' && next.maxCents !== '' && next.minCents > next.maxCents)
      return toast('En az tutar, en çok tutardan büyük olamaz.');
    if (next.trackingStart && next.trackingEnd && next.trackingStart > next.trackingEnd)
      return toast('Takip bitiş tarihi başlangıçtan önce olamaz.');
    if (next.dueStart && next.dueEnd && next.dueStart > next.dueEnd)
      return toast('Vade başlangıcı bitişten sonra olamaz.');
    borrowerFilters = next;
    docRows();
  };
  $('#clearBorrowerFilters').onclick = () => {
    for (const key of Object.keys(debtorColumnFilters)) delete debtorColumnFilters[key];
    borrowerFilters = {
      client: '',
      type: '',
      number: '',
      debtor: '',
      identity: '',
      staff: '',
      minAmount: '',
      maxAmount: '',
      minCents: '',
      maxCents: '',
      dueStart: '',
      dueEnd: '',
    };
    documents();
  };
}

function moveBorrowerToEnforcement(id) {
  try {
    const result = authApi('/api/documents/enforcement', 'POST', { documentId: id }),
      index = db.docs.findIndex((d) => d.id === id);
    if (index >= 0) db.docs[index] = result.document;
    if (page !== 'documents') {
      page = 'documents';
      render();
    }
    debtorStatusFilter = 'İcra';
    docRows();
    stats();
    toast('Dosya İcra bölümüne taşındı ve kaydedildi.');
  } catch (error) {
    toast(error.message);
    if (page === 'documents') docRows();
  }
}

function updateActiveDebtorCount() {
  const badge = document.getElementById('activeDebtorCount');
  if (!badge) return;
  const count =
    window.hanRecordsEnabled && !window.hanWorkspaceComplete
      ? (window.hanRecordSummary?.activeDocuments ?? '…')
      : db.docs.filter((d) => ['Derdest', 'İcra'].includes(debtorStatus(d))).length;
  badge.textContent = String(count);
  badge.setAttribute('aria-label', 'Derdest ve icra dosyaları toplamı: ' + count);
  badge.title = 'Derdest + İcra: ' + count;
}

function borrowerTrackingDate(d) {
  if (d.trackingDate) return d.trackingDate;
  if (!d.created) return '';
  const date = new Date(d.created);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(date)
    : '';
}

function sameIdentityDocuments(record, documents) {
  const normalize = (value) => String(value || '').replace(/\s/g, '');
  const key = normalize(record.identity);
  return /^\d{10,11}$/.test(key)
    ? documents.filter((d) => d.id !== record.id && normalize(d.identity) === key)
    : [];
}

function offerSameIdentityChain(d) {
  const matches = sameIdentityDocuments(d, db.docs);
  if (!matches.length) return;
  let dialog = document.getElementById('sameIdentityChainDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'sameIdentityChainDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML =
    '<div class="panelhead"><h2>Aynı TC ile Kayıtlı Dosya Bulundu</h2></div><div class="formbody"><p>Yeni kaydettiğiniz <strong>' +
    esc(d.number) +
    '</strong> dosyasının TC numarası aşağıdaki dosyalarla aynı. Zincir yapayım mı?</p>' +
    matches
      .map(
        (x) =>
          '<label class="settings-check"><input type="checkbox" data-identity-chain="' +
          esc(x.id) +
          '" checked> ' +
          esc(x.number) +
          ' · ' +
          esc(x.debtor) +
          ' · ' +
          esc(debtorStatus(x)) +
          '</label>',
      )
      .join('') +
    '<p>Dosya kaydedildi. Zincir yapmadan da devam edebilirsiniz.</p></div><div class="actions"><button type="button" class="secondary" data-skip-chain>Hayır, Devam Et</button><button type="button" class="primary" data-confirm-chain>Evet, Zincir Yap</button></div>';
  dialog.querySelector('[data-skip-chain]').onclick = () => dialog.close();
  dialog.querySelector('[data-confirm-chain]').onclick = () => {
    const selected = [...dialog.querySelectorAll('[data-identity-chain]:checked')];
    if (!selected.length) return toast('Bağlamak istediğiniz dosyayı seçin.', dialog);
    const button = dialog.querySelector('[data-confirm-chain]');
    button.disabled = true;
    try {
      for (const option of selected) {
        const result = authApi('/api/documents/chain', 'POST', {
          documentId: d.id,
          targetId: option.dataset.identityChain,
          action: 'add',
        });
        for (const record of result.documents) {
          const existing = db.docs.find((x) => x.id === record.id);
          if (existing) Object.assign(existing, record);
        }
      }
      dialog.close();
      toast('Dosyalar zincir yapılarak kaydedildi.');
    } catch (error) {
      toast(error.message, dialog);
    } finally {
      button.disabled = false;
    }
  };
  dialog.showModal();
}
