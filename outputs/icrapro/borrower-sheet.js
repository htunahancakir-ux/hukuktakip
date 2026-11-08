function borrowerDetail(id, savedForm) {
  const d = db.docs.find((x) => x.id === id);
  if (!d) return;
  let dialog = document.getElementById('borrowerDetail');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'borrowerDetail';
    document.body.append(dialog);
  }
  const drafts = dialog.open && dialog.dataset.borrowerId === id ? modalDrafts(dialog, savedForm) : [];
  dialog.dataset.borrowerId = id;
  const f = docFinance(d),
    client = db.clients.find((c) => c.id === d.client),
    type = docType(d),
    definition = documentTypes[type];
  const value = (label, v) =>
    `<div class="detail-field"><small>${esc(label)}</small><div>${esc(displayDate(v) || '—')}</div></div>`;
  const address = (label, a, district, city) => value(label, [a, district, city].filter(Boolean).join(' / '));
  dialog.innerHTML = `<div class="panelhead"><div><h2>Borçlu Detayı · <span class="debtor-name-emphasis">${esc(d.debtor)}</span></h2><p>${esc(d.number)} · ${esc(type)} · ${esc(client?.name || '')}</p><p><b>Dosya Sorumlusu:</b> ${esc(personnel.find((p) => p.id === d.relatedStaff)?.name || d.relatedStaffName || 'Atanmad?')}</p></div><div class="toolbar">${(Array.isArray(d.guarantors) ? d.guarantors : []).map((g, index) => `<button type="button" class="primary guarantor-top-button" data-top-guarantor="${esc(g.id)}" title="${esc(g.name)}" aria-label="Kefil ${index + 1}: ${esc(g.name)}">♙ Kefil ${index + 1}</button>`).join('')}<button class="secondary" id="closeBorrower">Kapat</button></div></div><div class="formbody"><div class="settings-tabs borrower-tabs" role="tablist" aria-label="Borçlu föyü bölümleri">${borrowerSheetTabs.map(([key, label]) => `<button type="button" role="tab" id="borrower-tab-${key}" aria-controls="borrower-panel-${key}" data-borrower-tab="${key}">${esc(label)}</button>`).join('')}</div><section role="tabpanel" id="borrower-panel-personal" aria-labelledby="borrower-tab-personal" data-borrower-panel="personal"><h3 class="sectiontitle">Borçlu Bilgileri</h3><div class="grid"><div class="detail-field"><small>Ad Soyad / Unvan</small><div class="borrower-sheet-name">${esc(d.debtor || '—')}</div></div>${value('Takip Tarihi', borrowerTrackingDate(d))}${value('TC Kimlik / Vergi No', d.identity)}${value('Tel-1', d.phone1)}${value('Tel-2', d.phone2)}${value('Ref. Tel-1', d.referencePhone1)}${value('Ref. Tel-2', d.referencePhone2)}${value('Ofis Tel-1', d.officePhone1)}${value('Ofis Tel-2', d.officePhone2)}${address('Borçlu Adres-1', d.address, d.district, d.city)}${address('Borçlu Adres-2', d.address2, d.address2District, d.address2City)}${address('Borçlu Adres (Ofis)-3', d.officeAddress3, d.officeAddress3District, d.officeAddress3City)}${(d.additionalPhones || []).map((phone, i) => value('Ek Telefon ' + (i + 1), phone)).join('')}${(d.additionalAddresses || []).map((a, i) => address('Ek Adres ' + (i + 1), a.address, a.district, a.city)).join('')}${value('Dosya Sorumlusu', personnel.find((p) => p.id === d.relatedStaff)?.name || d.relatedStaffName)}</div></section><section role="tabpanel" id="borrower-panel-assets" aria-labelledby="borrower-tab-assets" data-borrower-panel="assets" hidden>${propertySummary(d)}</section><section role="tabpanel" id="borrower-panel-guarantors" aria-labelledby="borrower-tab-guarantors" data-borrower-panel="guarantors" hidden>${guarantorSection(d)}</section><section role="tabpanel" id="borrower-panel-conversations" aria-labelledby="borrower-tab-conversations" data-borrower-panel="conversations" hidden>${borrowerConversationsMarkup(d)}</section><section role="tabpanel" id="borrower-panel-financial" aria-labelledby="borrower-tab-financial" data-borrower-panel="financial" hidden>${borrowerFinanceOverview(d, f)}</section><section role="tabpanel" id="borrower-panel-payout" aria-labelledby="borrower-tab-payout" data-borrower-panel="payout" hidden>${clientPayoutSection(d)}</section><section role="tabpanel" id="borrower-panel-finance" aria-labelledby="borrower-tab-finance" data-borrower-panel="finance" hidden><h3 class="sectiontitle" style="margin-top:30px">Finansal Bilgiler</h3><form id="borrowerStatusForm"><div class="grid"><label class="field">Durum<select name="status">${['Derdest', 'İade', 'İnfaz', 'İcra'].map((s) => `<option ${s === (d.status || 'Derdest') ? 'selected' : ''}>${s}</option>`).join('')}</select></label>${debtorStatus(d) === 'İnfaz' ? value('İnfaz Tarihi', clientPayoutClosureDate(d)) : ''}<div class="detail-status-action"><button class="primary">Durumu Kaydet</button></div></div></form><div class="stats" style="margin-top:20px">${[
    ['Anapara', f.principal],
    ['Faiz', isParkingDocument(d) ? 0 : financeCents(d.financeInterest)],
    ['Avukatlık / Hizmet Ücreti', isParkingDocument(d) ? 0 : financeCents(d.financeFee)],
    ['Borçluya Eklenen Masraf', f.expenses],
    ['Yapılandırma İndirimi', f.discount],
    ['Toplam Alacak', f.target],
    ['Tahsil Edilen', f.received],
    ['Kalan Borç', f.remaining],
  ]
    .map(
      ([title, n]) =>
        `<div class="stat"><div><small>${esc(title)}</small><strong>${money(n / 100)}</strong></div></div>`,
    )
    .join(
      '',
    )}</div><button class="primary" id="borrowerFinancial">Tahsilat</button><button class="secondary" id="borrowerExpense">Masraf</button>${repaymentSection(d)}</section><section role="tabpanel" id="borrower-panel-document" aria-labelledby="borrower-tab-document" data-borrower-panel="document" hidden><h3 class="sectiontitle" style="margin-top:30px">${esc(type)} Bilgileri</h3><div class="grid">${value('Evrak Türü', type)}${isParkingDocument(d) ? value('Anlaşılan Ofis Payı (%)', validParkingRate(d) ? String(d.parkingCommissionRate) : 'Belirtilmedi') : ''}${value('Evrak Aslı', d.originalDocument || 'Belirtilmedi')}${value(definition.serial, d.serial)}${value(definition.due, d.due)}${value('Düzenleme Tarihi', d.issued)}${definition.extras.map(([label, key]) => value(label, d[key])).join('')}${value('Teslim Eden', d.deliveredBy)}${value('Teslim Alan', d.receivedBy)}${value('Kabul Notu', d.notes)}</div>${borrowerAttachmentPreviews(d)}</section></div>`;
  layoutBorrowerSheet(dialog, d, f, client);
  if (d.fileData || d.photoData) {
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (d.fileData) addWhatsAppFileButton(actions, d, 'file');
    if (d.photoData) addWhatsAppFileButton(actions, d, 'photo');
    if (actions.childElementCount) dialog.querySelector('#borrower-panel-document')?.append(actions);
  }
  setupBorrowerPin(dialog, d);
  setupBorrowerChain(dialog, d);
  setupBorrowerDeletion(dialog, d);
  setupBorrowerNavigation(dialog, id);
  bindBorrowerSheetTabs(dialog, id);
  dialog.querySelectorAll('[data-sheet-collection-receipt]').forEach((button) => {
    button.onclick = () => openCollectionReceipt(button.dataset.sheetCollectionReceipt);
  });
  bindGuarantors(d);
  dialog
    .querySelectorAll('[data-top-guarantor]')
    .forEach((button) => (button.onclick = () => guarantorDetail(d, button.dataset.topGuarantor)));
  bindBorrowerConversations(d);
  bindRepayment(d);
  bindClientPayout(d);
  $('#closeBorrower').onclick = () => dialog.close();
  $('#borrowerFinancial').onclick = () => {
    financialOperations(id, $('#borrowerFinancial').dataset.operation || 'payment');
    delete $('#borrowerFinancial').dataset.operation;
    $('#modal').addEventListener(
      'close',
      () => {
        if (dialog.open) borrowerDetail(id);
      },
      { once: true },
    );
  };
  $('#borrowerExpense').onclick = () => {
    $('#borrowerFinancial').dataset.operation = 'expense';
    $('#borrowerFinancial').click();
  };
  $('#borrowerStatusForm').onsubmit = (e) => {
    e.preventDefault();
    const status = e.target.elements.status.value;
    if (!['Derdest', 'İade', 'İnfaz', 'İcra'].includes(status)) return;
    if (status === 'İnfaz' && docFinance(d).remaining > 0)
      return toast('İnfaz için kalan borç tamamen tahsil edilmelidir.');
    if (status !== 'İnfaz' && docFinance(d).received > 0 && docFinance(d).remaining === 0)
      return toast('Tamamı tahsil edilmiş evrak infaz durumunda kalmalıdır.');
    if (status === 'İcra' && debtorStatus(d) !== 'İcra') {
      const dialog = document.getElementById('borrowerDetail');
      if (dialog?.open) dialog.close();
      return moveBorrowerToEnforcement(id);
    }
    const previous = d.status;
    d.status = status;
    try {
      save();
    } catch {
      d.status = previous;
      return toast('Durum kaydedilemedi.');
    }
    if (page === 'documents') docRows();
    stats();
    toast('Evrak durumu kaydedildi.');
    borrowerDetail(id, e.target);
  };
  for (const draft of drafts) {
    if (draft.id) dialog.querySelector('#' + CSS.escape(draft.id))?.replaceWith(draft);
  }
  if (!dialog.open) {
    if (document.querySelector('.pinned-borrower-sheet')) dialog.show();
    else dialog.showModal();
  }
}

function borrowerFinanceOverview(d, f) {
  const payments = financeEvents
    .filter((event) => event.documentId === d.id && event.type === 'payment')
    .sort(
      (a, b) =>
        String(b.date || '').localeCompare(String(a.date || '')) ||
        String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
    );
  const cards = [
    ['Evrak Tutarı', financeCents(d.originalAmount ?? d.amount)],
    ['Takip Öncesi Ödeme', financeCents(d.preTrackingPayment)],
    ['Anapara', f.principal],
    ['Faiz', isParkingDocument(d) ? 0 : financeCents(d.financeInterest)],
    ['Avukatlık / Hizmet Ücreti', isParkingDocument(d) ? 0 : financeCents(d.financeFee)],
    ['Borçluya Eklenen Masraf', f.expenses],
    ['Yapılandırma İndirimi', f.discount],
    ['Toplam Alacak', f.target],
    ['Tahsil Edilen', f.received],
    ['Kalan Borç', f.remaining],
  ];
  return `<h3 class="sectiontitle">Borçlu Finansal Durumu</h3><p>Dosya Durumu: <b>${esc(debtorStatus(d))}</b></p>
    <div class="stats borrower-financial-stats">${cards.map(([label, amount]) => `<div class="stat"><div><small>${esc(label)}</small><strong>${money(amount / 100)}</strong></div></div>`).join('')}</div>
    <h3 class="sectiontitle">Borçlu Ödeme Geçmişi (${payments.length})</h3>
    <div class="overflow"><table class="borrower-payment-history"><thead><tr><th>TARİH</th><th>ÖDENEN TUTAR</th><th>KASA / BANKA</th><th>İŞLEMİ YAPAN</th><th>AÇIKLAMA</th><th>MAKBUZ</th></tr></thead>
    <tbody>${payments.map((event) => `<tr><td>${esc(displayDate(event.date))}</td><td>${money(event.amount / 100)}</td><td>${esc(event.accountName || accounting.accounts.find((account) => account.id === event.accountId)?.name || 'Belirtilmedi')}</td><td>${esc(event.operatorName || 'Belirtilmedi')}</td><td class="conversation-note">${esc(event.note || '—')}</td><td><button type="button" class="link" data-sheet-collection-receipt="${esc(event.id)}">Tahsilat Makbuzu</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">Henüz borçlu ödemesi kaydedilmedi.</td></tr>'}</tbody>
    <tfoot><tr><td>TOPLAM</td><td><strong>${money(payments.reduce((sum, event) => sum + event.amount, 0) / 100)}</strong></td><td colspan="4">${payments.length} ödeme</td></tr></tfoot></table></div>`;
}

function guarantorSection(d) {
  const rows = Array.isArray(d.guarantors) ? d.guarantors : [];
  return `<h3 class="sectiontitle" style="margin-top:30px">Kefiller (${rows.length})</h3><button type="button" class="primary" id="addGuarantor">＋ Kefil Ekle</button><div class="overflow" style="margin-top:15px"><table><thead><tr><th>AD SOYAD</th><th>TELEFON</th><th>İŞLEM</th></tr></thead><tbody>${rows.map((g) => `<tr><td><button type="button" class="link" data-guarantor="${esc(g.id)}">${esc(g.name)}</button></td><td>${esc(g.phone)}</td><td><button type="button" class="link" data-edit-guarantor="${esc(g.id)}">Düzenle</button></td></tr>`).join('') || '<tr><td colspan="3" class="empty">Henüz kefil eklenmedi.</td></tr>'}</tbody></table></div>`;
}

function bindGuarantors(d) {
  if ($('#addGuarantor'))
    $('#addGuarantor').onclick = () => {
      if (d._intakeDraft) d.debtor = $('#intakeForm').elements.debtor.value || 'Yeni borçlu';
      guarantorForm(d);
    };
  document
    .querySelectorAll('[data-guarantor]')
    .forEach((b) => (b.onclick = () => guarantorDetail(d, b.dataset.guarantor)));
  document
    .querySelectorAll('[data-edit-guarantor]')
    .forEach((b) => (b.onclick = () => guarantorForm(d, b.dataset.editGuarantor)));
}

function guarantorPhoneFields(g) {
  return [
    ['Tel-1', 'phone1', g.phone1 || g.phone],
    ['Tel-2', 'phone2', g.phone2],
    ['Ref. Tel-1', 'referencePhone1', g.referencePhone1],
    ['Ref. Tel-2', 'referencePhone2', g.referencePhone2],
    ['Ofis Tel-1', 'officePhone1', g.officePhone1],
    ['Ofis Tel-2', 'officePhone2', g.officePhone2],
  ]
    .map(([label, name, value]) => field(label, name, 'tel', value, name === 'phone1'))
    .join('');
}

function guarantorExtraAddress(g, name, prefix, title) {
  return `<h3 class="sectiontitle full">${esc(title)}</h3>${clientCityField(
    { city: g[name + 'City'], district: g[name + 'District'] },
    prefix,
  )
    .replace('name="city"', 'name="' + name + 'City"')
    .replace(
      'name="district"',
      'name="' + name + 'District"',
    )}<label class="field full">${esc(title)} — Açık Adres<textarea name="${name}" rows="3" data-optional="true">${esc(g[name] || '')}</textarea></label>`;
}

function configureGuarantorOptionalFields() {
  const form = $('#guarantorForm');
  for (const name of [
    'phone2',
    'referencePhone1',
    'referencePhone2',
    'officePhone1',
    'officePhone2',
    'address2City',
    'address2District',
    'officeAddress3City',
    'officeAddress3District',
  ]) {
    const input = form.elements[name];
    input.required = false;
    input.dataset.optional = 'true';
    input.setAttribute('aria-required', 'false');
    const label = input.id ? form.querySelector('label[for="' + input.id + '"]') : input.closest('label');
    if (label?.firstChild?.nodeType === 3)
      label.firstChild.textContent = label.firstChild.textContent.replace(/\s*\*/g, '');
  }
}

function validateGuarantorExtraAddresses(value, form) {
  for (const [base, prefix] of [
    ['address2', 'guarantor2'],
    ['officeAddress3', 'guarantor3'],
  ]) {
    for (const name of [base, base + 'City', base + 'District'])
      value[name] = String(value[name] || '').trim();
    if (!value[base] && !value[base + 'City'] && !value[base + 'District']) continue;
    if (!value[base]) {
      form.elements[base].setCustomValidity('Ek adresin açık adresini tamamlayın.');
      form.elements[base].reportValidity();
      return false;
    }
    const city = turkeyCities.find(
        (c) => c.toLocaleLowerCase('tr') === value[base + 'City'].toLocaleLowerCase('tr'),
      ),
      district =
        city &&
        (turkeyDistricts[city] || []).find(
          (d) => d.toLocaleLowerCase('tr') === value[base + 'District'].toLocaleLowerCase('tr'),
        );
    if (!city || !district) {
      const input = document.getElementById(prefix + (!city ? 'City' : 'District'));
      input.setCustomValidity('Ek adres için geçerli il ve ilçe seçin.');
      input.reportValidity();
      return false;
    }
    value[base + 'City'] = city;
    value[base + 'District'] = district;
  }
  return true;
}

function showBorrowerGuarantors(d) {
  const rows = Array.isArray(d.guarantors) ? d.guarantors : [];
  if (!rows.length) return;
  if (rows.length === 1) return guarantorDetail(d, rows[0].id);
  const dialog = guarantorDialog();
  dialog.innerHTML = `<div class="panelhead"><div><h2>Kefil Bilgileri</h2><p>${esc(d.debtor)} · ${rows.length} kefil</p></div><button type="button" class="secondary" id="closeGuarantorList">Kapat</button></div><div class="formbody"><p>Bilgilerini görüntülemek için kefilin adına tıklayın.</p><div class="overflow"><table><thead><tr><th>AD SOYAD</th><th>TELEFON</th></tr></thead><tbody>${rows.map((g) => `<tr><td><button type="button" class="link" data-open-guarantor="${esc(g.id)}">${esc(g.name)}</button></td><td>${esc(g.phone1 || g.phone || '—')}</td></tr>`).join('')}</tbody></table></div></div>`;
  $('#closeGuarantorList').onclick = () => dialog.close();
  dialog
    .querySelectorAll('[data-open-guarantor]')
    .forEach((button) => (button.onclick = () => guarantorDetail(d, button.dataset.openGuarantor)));
  if (!dialog.open) dialog.showModal();
}

function guarantorDialog() {
  let dialog = document.getElementById('guarantorDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'guarantorDialog';
    document.body.append(dialog);
  }
  return dialog;
}

function guarantorForm(d, id) {
  const g = (d.guarantors || []).find((g) => g.id === id) || {},
    dialog = guarantorDialog();
  dialog.innerHTML = `<form id="guarantorForm"><div class="panelhead"><div><h2>${id ? 'Kefili Düzenle' : 'Kefil Ekle'}</h2><p>Borçlu: ${esc(d.debtor)} · ${esc(d.number)}</p></div><button type="button" class="link" id="closeGuarantorForm">Kapat</button></div><div class="formbody grid">${field('Kefil Ad Soyad', 'name', 'text', g.name, true)}${field('TC Kimlik Numarası', 'identity', 'text', g.identity, true)}${guarantorPhoneFields(g)}${propertyFields(g, 'guarantor')}${clientCityField(g, 'guarantor')}<label class="field full">Açık Adres<textarea name="address" rows="3" required>${esc(g.address || '')}</textarea></label>${guarantorExtraAddress(g, 'address2', 'guarantor2', 'Kefil Adres-2')}${guarantorExtraAddress(g, 'officeAddress3', 'guarantor3', 'Kefil Adres (Ofis)-3')}<label class="field full">Açıklama / Not<textarea name="notes" rows="3" data-optional="true">${esc(g.notes || '')}</textarea></label></div><div class="actions"><button class="primary">Kefili Kaydet</button></div></form>`;
  $('#closeGuarantorForm').onclick = () => dialog.close();
  if (!dialog.open) dialog.showModal();
  setupClientCity('guarantor');
  setupClientDistrict('guarantor');
  setupClientCity('guarantor2');
  setupClientDistrict('guarantor2');
  setupClientCity('guarantor3');
  setupClientDistrict('guarantor3');
  configureGuarantorOptionalFields();
  const form = $('#guarantorForm');
  bindPropertyFields(form);
  form.elements.identity.pattern = '[0-9]{11}';
  form.elements.identity.maxLength = 11;
  form.elements.identity.title = '11 rakam girin';
  form.onsubmit = (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    if (!validatePropertyFields(v)) return;
    v.name = v.name.trim();
    v.identity = v.identity.trim();
    v.phone1 = v.phone1.trim();
    v.phone = v.phone1;
    v.address = v.address.trim();
    if (!v.name || !v.phone || !v.address || !/^\d{11}$/.test(v.identity))
      return toast('Kefilin zorunlu bilgilerini tamamlayın.');
    if ((d.guarantors || []).some((g) => g.id !== id && g.identity === v.identity))
      return toast('Bu TC kimlik numarası bu borçluda zaten kayıtlı.');
    const city = turkeyCities.find(
        (city) => city.toLocaleLowerCase('tr') === v.city.trim().toLocaleLowerCase('tr'),
      ),
      district =
        city &&
        (turkeyDistricts[city] || []).find(
          (district) => district.toLocaleLowerCase('tr') === v.district.trim().toLocaleLowerCase('tr'),
        );
    if (!city || !district) return toast('Geçerli il ve ilçe seçin.');
    if (!validateGuarantorExtraAddresses(v, form)) return;
    const record = {
        ...v,
        id: id || crypto.randomUUID(),
        city,
        district,
        createdAt: g.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      before = d.guarantors,
      next = Array.isArray(before) ? structuredClone(before) : [];
    if (id) {
      const index = next.findIndex((g) => g.id === id);
      if (index < 0) return toast('Kefil kaydı bulunamadı.');
      next[index] = record;
    } else next.push(record);
    d.guarantors = next;
    if (d._intakeDraft) {
      dialog.close();
      renderIntakeGuarantors();
      toast('Kefil evrak taslağına eklendi. Evrakı kaydettiğinizde saklanacak.');
      return;
    }
    try {
      save();
    } catch {
      d.guarantors = before;
      return toast('Kefil kaydedilemedi.');
    }
    dialog.close();
    borrowerDetail(d.id);
    toast('Kefil bilgileri kaydedildi.');
  };
}

function guarantorDetail(d, id) {
  const g = (d.guarantors || []).find((g) => g.id === id);
  if (!g) return;
  const dialog = guarantorDialog();
  const item = (label, value) =>
    `<div class="detail-field"><small>${esc(label)}</small><div>${esc(value || '—')}</div></div>`;
  dialog.innerHTML = `<div class="panelhead"><div><h2>Kefil Bilgileri</h2><p>Borçlu: ${esc(d.debtor)} · ${esc(d.number)}</p></div><button type="button" class="secondary" id="closeGuarantorDetail">Kapat</button></div><div class="formbody grid">${item('Ad Soyad', g.name)}${item('TC Kimlik Numarası', g.identity)}${item('Tel-1', g.phone1 || g.phone)}${item('Tel-2', g.phone2)}${item('Ref. Tel-1', g.referencePhone1)}${item('Ref. Tel-2', g.referencePhone2)}${item('Ofis Tel-1', g.officePhone1)}${item('Ofis Tel-2', g.officePhone2)}${item('İl', g.city)}${item('İlçe', g.district)}${item('Açık Adres', g.address)}${item('Kefil Adres-2', [g.address2, g.address2District, g.address2City].filter(Boolean).join(' / '))}${item('Kefil Adres (Ofis)-3', [g.officeAddress3, g.officeAddress3District, g.officeAddress3City].filter(Boolean).join(' / '))}${item('Açıklama / Not', g.notes)}<div class="full">${propertySummary(g)}</div></div><div class="actions"><button type="button" class="primary" id="editGuarantorDetail">Kefili Düzenle</button></div>`;
  $('#closeGuarantorDetail').onclick = () => dialog.close();
  $('#editGuarantorDetail').onclick = () => guarantorForm(d, g.id);
  if (!dialog.open) dialog.showModal();
}

function editBorrower(id) {
  const d = db.docs.find((d) => d.id === id);
  if (!d) return;
  let dialog = document.getElementById('editBorrowerDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'editBorrowerDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML = `<form id="editBorrowerForm"><div class="panelhead"><div><h2>Borçlu Bilgilerini Düzenle</h2><p>${esc(d.number)} · ${esc(docType(d))}</p></div><button type="button" class="secondary" id="cancelEditBorrower">Kapat</button></div><div class="formbody grid">${field('Ad Soyad / Unvan', 'debtor', 'text', d.debtor, true)}${field('TC Kimlik / Vergi No', 'identity', 'text', d.identity, true)}${field('Tel-1', 'phone1', 'tel', d.phone1, true)}${field('Tel-2', 'phone2', 'tel', d.phone2)}${field('Ref. Tel-1', 'referencePhone1', 'tel', d.referencePhone1)}${field('Ref. Tel-2', 'referencePhone2', 'tel', d.referencePhone2)}${field('Ofis Tel-1', 'officePhone1', 'tel', d.officePhone1)}${field('Ofis Tel-2', 'officePhone2', 'tel', d.officePhone2)}${propertyFields(d, 'editDebtor')}${clientCityField(d, 'editDebtor')}<label class="field full">Borçlu Açık Adres<textarea name="address" rows="3" required>${esc(d.address || '')}</textarea></label>${guarantorExtraAddress(d, 'address2', 'editDebtor2', 'Borçlu Adres-2')}${guarantorExtraAddress(d, 'officeAddress3', 'editDebtor3', 'Borçlu Adres (Ofis)-3')}<label class="field full">Açıklama / Not<textarea name="notes" rows="3" data-optional="true">${esc(d.notes || '')}</textarea></label></div><div class="actions"><button class="primary">Değişiklikleri Kaydet</button></div></form>`;
  $('#cancelEditBorrower').onclick = () => dialog.close();
  if (!dialog.open) dialog.showModal();
  for (const prefix of ['editDebtor', 'editDebtor2', 'editDebtor3']) {
    setupClientCity(prefix);
    setupClientDistrict(prefix);
  }
  const form = $('#editBorrowerForm');
  bindPropertyFields(form);
  for (const name of [
    'phone2',
    'referencePhone1',
    'referencePhone2',
    'officePhone1',
    'officePhone2',
    'address2City',
    'address2District',
    'officeAddress3City',
    'officeAddress3District',
  ]) {
    const input = form.elements[name];
    input.dataset.optional = 'true';
    input.required = false;
    input.setAttribute('aria-required', 'false');
    const label = input.id ? form.querySelector('label[for="' + input.id + '"]') : input.closest('label');
    if (label?.firstChild?.nodeType === 3)
      label.firstChild.textContent = label.firstChild.textContent.replace(/\s*\*/g, '');
  }
  form.onsubmit = (e) => {
    e.preventDefault();
    const value = Object.fromEntries(new FormData(form));
    if (!validatePropertyFields(value)) return;
    for (const key of Object.keys(value)) value[key] = value[key].trim();
    if (!value.debtor || !value.phone1 || !value.address || !/^\d{10,11}$/.test(value.identity))
      return toast('Kimlik, telefon ve adres bilgilerini tamamlayın.');
    const city = turkeyCities.find(
        (city) => city.toLocaleLowerCase('tr') === value.city.toLocaleLowerCase('tr'),
      ),
      district =
        city &&
        (turkeyDistricts[city] || []).find(
          (district) =>
            district.toLocaleLowerCase('tr') === String(value.district || '').toLocaleLowerCase('tr'),
        );
    if (!city || !district) return toast('Geçerli il ve ilçe seçin.');
    for (const [base, prefix] of [
      ['address2', 'editDebtor2'],
      ['officeAddress3', 'editDebtor3'],
    ]) {
      for (const key of [base, base + 'City', base + 'District'])
        value[key] = String(value[key] || '').trim();
      if (!value[base] && !value[base + 'City'] && !value[base + 'District']) continue;
      const selectedCity = turkeyCities.find(
          (city) => city.toLocaleLowerCase('tr') === value[base + 'City'].toLocaleLowerCase('tr'),
        ),
        selectedDistrict =
          selectedCity &&
          (turkeyDistricts[selectedCity] || []).find(
            (district) =>
              district.toLocaleLowerCase('tr') === value[base + 'District'].toLocaleLowerCase('tr'),
          );
      if (!value[base] || !selectedCity || !selectedDistrict)
        return toast('Ek adresin il, ilçe ve açık adresini tamamlayın.');
      value[base + 'City'] = selectedCity;
      value[base + 'District'] = selectedDistrict;
    }
    value.city = city;
    value.district = district;
    const before = structuredClone(d);
    Object.assign(d, value, { updatedAt: new Date().toISOString() });
    try {
      save();
    } catch {
      Object.keys(d).forEach((k) => delete d[k]);
      Object.assign(d, before);
      return toast('Değişiklikler kaydedilemedi.');
    }
    dialog.close();
    if (page === 'documents') docRows();
    stats();
    const detail = document.getElementById('borrowerDetail');
    if (detail?.open) borrowerDetail(d.id);
    toast('Borçlu bilgileri güncellendi.');
  };
}

function propertyFields(record, prefix) {
  return `<section class="full"><h3 class="sectiontitle">Tapu, Araç ve SGK Bilgileri</h3><div class="grid">${propertySections
    .map(([key, title]) => {
      const status = record[key + 'Status'];
      return `<fieldset class="property-field"><legend>${esc(title)}</legend><div class="property-options">${['Var', 'Yok'].map((choice) => `<label><input type="radio" name="${key}Status" value="${choice}" ${status === choice ? 'checked' : ''} data-optional="true"> ${choice}</label>`).join('')}</div><div data-property-details="${key}" ${status === 'Var' ? '' : 'hidden'}><label class="field" for="${prefix}-${key}-details">${esc(title)} Bilgileri<textarea id="${prefix}-${key}-details" name="${key}Details" rows="3" data-optional="true" ${status === 'Var' ? 'required' : 'disabled'} placeholder="${esc(title)} ile ilgili bilgileri yazın…">${esc(record[key + 'Details'] || '')}</textarea></label></div></fieldset>`;
    })
    .join('')}${prefix === 'intake' ? parkingCaptureFields(record) : ''}</div></section>`;
}

function bindPropertyFields(form) {
  setupParkingCapture(form);
  for (const [key] of propertySections) {
    const input = form.elements[key + 'Details'],
      container = form.querySelector('[data-property-details="' + key + '"]');
    if (!input || !container) continue;
    function update() {
      const selected = form.querySelector('input[name="' + key + 'Status"]:checked'),
        show = selected?.value === 'Var';
      container.hidden = !show;
      input.disabled = !show;
      input.required = show;
      input.setAttribute('aria-required', String(show));
      if (!show) input.setCustomValidity('');
    }
    form
      .querySelectorAll('input[name="' + key + 'Status"]')
      .forEach((radio) => radio.addEventListener('change', update));
    form.addEventListener('reset', () => queueMicrotask(update));
    update();
  }
}

function incompletePropertyDescription(root = document) {
  for (const form of root.querySelectorAll('form')) {
    if (form.closest('dialog') && !form.closest('dialog').open) continue;
    for (const [key, title] of propertySections) {
      if (form.querySelector('input[name="' + key + 'Status"]:checked')?.value === 'Var') {
        const input = form.elements[key + 'Details'];
        if (input && !input.value.trim()) return { input, title };
      }
    }
  }
  return null;
}

function blockIncompletePropertyClose(root = document) {
  const missing = incompletePropertyDescription(root);
  if (!missing) return false;
  missing.input.setCustomValidity(missing.title + ' için Var seçtiniz. Açıklama yazmadan form kapatılamaz.');
  missing.input.focus();
  missing.input.reportValidity();
  toast(missing.title + ' açıklamasını doldurun veya Yok seçin.');
  return true;
}

function validatePropertyFields(value) {
  for (const [key, title] of propertySections) {
    const status = value[key + 'Status'];
    if (status && !['Var', 'Yok'].includes(status)) {
      toast(title + ' için Var veya Yok seçin.');
      return false;
    }
    value[key + 'Details'] = status === 'Var' ? String(value[key + 'Details'] || '').trim() : '';
    if (status === 'Var' && !value[key + 'Details']) {
      toast(title + ' bilgilerini doldurun.');
      return false;
    }
  }
  return true;
}

function propertySummary(record) {
  return `<section style="margin-top:24px"><h3 class="sectiontitle">Tapu, Araç ve SGK Bilgileri</h3><div class="grid">${propertySections.map(([key, title]) => `<div class="detail-field"><small>${esc(title)}</small><b>${esc(record[key + 'Status'] || 'Belirtilmedi')}</b>${record[key + 'Status'] === 'Var' ? `<p class="conversation-note">${esc(record[key + 'Details'] || '—')}</p>` : ''}</div>`).join('')}${record.docType === 'Yediemin Park Ücreti' ? '<div class="detail-field"><small>Yakalama</small><b>' + esc(record.captureStatus || 'Belirtilmedi') + '</b>' + (record.captureStatus === 'Var' ? '<p class="conversation-note">' + esc(record.captureDetails || '—') + '</p>' : '') + '</div>' : ''}</div></section>`;
}

function conversationNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Baghdad',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (key) => parts.find((p) => p.type === key).value;
  return {
    date: get('year') + '-' + get('month') + '-' + get('day'),
    time: get('hour') + ':' + get('minute'),
  };
}

function borrowerConversationsMarkup(d) {
  const now = conversationNow(),
    rows = Array.isArray(d.conversations) ? d.conversations : [];
  return `<h3 class="sectiontitle" style="margin-top:30px">Görüşme Süreci</h3><form id="borrowerConversationForm"><div class="grid">${field('Görüşme Tarihi', 'date', 'date', now.date, true)}${field('Görüşme Saati', 'time', 'time', now.time, true)}<label class="field">Görüşen Personel<input name="staff" value="${esc(hanAuth.name)}" readonly data-optional="true" aria-readonly="true"></label><label class="field">Görüşme Sonucu<select name="result" required><option value="">Sonuç seçin</option>${['Görüşüldü', 'Ulaşılamadı', 'Tekrar Aranacak', 'Ödeme Sözü Alındı', 'Ödemeyi Reddetti', 'Raporlandı', 'İcra Raporu', 'Diğer'].map((s) => `<option>${s}</option>`).join('')}</select></label><label class="field full">Görüşme / Süreç Notu<textarea name="note" rows="4" data-optional="true" placeholder="Görüşmenin içeriğini ve sonraki adımı yazabilirsiniz…"></textarea></label><label class="field full">Raporla — Otomatik Görüşme Özeti<textarea rows="3" readonly aria-readonly="true" data-optional="true" data-conversation-report maxlength="300">${esc(d.conversationReport?.sourceCount === rows.length ? d.conversationReport.text : '')}</textarea><small data-conversation-report-status role="status"></small></label><div class="full"><button type="button" class="secondary" data-generate-conversation-report>Raporla</button><small> Tüm görüşme geçmişindeki önemli cümlelerden en fazla 300 karakter. Otomatik oluşturulur; elle değiştirilemez.</small></div></div><div class="actions" style="margin-top:15px"><button class="primary">Görüşmeyi Kaydet</button></div></form><div class="conversation-history"><h4>Görüşme Geçmişi (${rows.length})</h4><label class="field conversation-result-filter">Görüşme Sonucuna Göre Süz<select data-conversation-result-filter data-optional="true" aria-label="Görüşme sonucu süzgeci"><option value="">Tüm Sonuçlar</option>${[
    ...new Set([
      'Görüşüldü',
      'Ulaşılamadı',
      'Tekrar Aranacak',
      'Ödeme Sözü Alındı',
      'Ödemeyi Reddetti',
      'Raporlandı',
      'İcra Raporu',
      'Diğer',
      ...rows.map((r) => r.result),
    ]),
  ]
    .filter(Boolean)
    .map((result) => `<option value="${esc(result)}">${esc(result)}</option>`)
    .join('')}</select></label><p data-conversation-filter-count role="status"></p>${
    rows
      .slice()
      .sort(
        (a, b) =>
          (b.date + 'T' + b.time).localeCompare(a.date + 'T' + a.time) ||
          String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
      )
      .map(
        (row) =>
          `<article class="conversation-entry" data-conversation-result="${esc(row.result)}"><div><strong>${esc(displayDate(row.date))} · ${esc(row.time)}</strong><span class="badge">${esc(row.result)}</span></div><p><b>Görüşen:</b> ${esc(row.staffName || personnel.find((p) => p.id === row.staff)?.name || '—')}</p><p class="conversation-note">${esc(row.note)}</p></article>`,
      )
      .join('') || '<p>Henüz görüşme kaydı yok.</p>'
  }</div>`;
}

function bindBorrowerConversations(d) {
  bindLoggedInConversation(d, document.getElementById('borrowerDetail'));
}

function bindBorrowerSheetTabs(dialog, id) {
  const active = dialog.dataset.borrowerId === id ? dialog.dataset.activeTab : 'conversations';
  dialog.dataset.borrowerId = id;
  function select(key) {
    if (!borrowerSheetTabs.some(([k]) => k === key)) key = 'personal';
    dialog.dataset.activeTab = key;
    dialog.querySelectorAll('[data-borrower-tab]').forEach((b) => {
      const chosen = b.dataset.borrowerTab === key;
      b.classList.toggle('selected', chosen);
      b.setAttribute('aria-selected', String(chosen));
      b.tabIndex = chosen ? 0 : -1;
    });
    dialog
      .querySelectorAll('[data-borrower-panel]')
      .forEach((panel) => (panel.hidden = panel.dataset.borrowerPanel !== key));
  }
  const buttons = [...dialog.querySelectorAll('[data-borrower-tab]')];
  buttons.forEach((b, index) => {
    b.onclick = () => select(b.dataset.borrowerTab);
    b.onkeydown = (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
      else if (event.key === 'ArrowLeft') next = (index + buttons.length - 1) % buttons.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = buttons.length - 1;
      else return;
      event.preventDefault();
      select(buttons[next].dataset.borrowerTab);
      buttons[next].focus();
    };
  });
  select(active);
}

function layoutBorrowerSheet(dialog, d, f, client) {
  dialog.classList.add('compact-borrower-sheet');
  setupBorrowerResize(dialog);
  setupBorrowerDragging(dialog);
  setupBorrowerCornerResize(dialog);
  const head = dialog.querySelector(':scope > .panelhead'),
    body = dialog.querySelector(':scope > .formbody');
  head.querySelector('h2').innerHTML =
    'Borçlu Föyü · <span class="sheet-folio-number">' + esc(d.number) + '</span>';
  const field = (label, value, className = '') =>
    '<div class="sheet-meta-field' +
    (className ? ' ' + className : '') +
    '"><small>' +
    label +
    '</small><strong>' +
    esc(value || '—') +
    '</strong></div>';
  const meta = document.createElement('div');
  meta.className = 'sheet-metadata';
  meta.innerHTML =
    field('Föy No', d.number, 'sheet-folio-number') +
    field('Borçlu', d.debtor, 'sheet-debtor-name') +
    field('Takip Tarihi', displayDate(borrowerTrackingDate(d))) +
    field(
      'Evrakı Kaydeden',
      personnel.find((p) => p.id === d.recordedBy)?.name || d.recordedByName || 'Belirtilmedi',
    ) +
    field('Evrak Türü', docType(d)) +
    field('Durum', debtorStatus(d)) +
    field('Dosya Sorumlusu', personnel.find((p) => p.id === d.relatedStaff)?.name || d.relatedStaffName) +
    '<div class="sheet-meta-field"><small>Müvekkil</small>' +
    (client
      ? '<button type="button" class="sheet-client-link" id="sheetOpenClient">' +
        esc(client.name) +
        '</button>'
      : '<strong>—</strong>') +
    '</div>' +
    field('Vade Tarihi', isParkingDocument(d) ? '—' : displayDate(d.due)) +
    field('TC / Vergi No', d.identity) +
    field('Telefon', d.phone1) +
    field('İl / İlçe', [d.city, d.district].filter(Boolean).join(' / ')) +
    '<div class="sheet-address">' +
    field('Adres', d.address) +
    '</div>';
  head.after(meta);
  setupBorrowerEnforcementFields(dialog, d, meta);
  meta.querySelector('#sheetOpenClient')?.addEventListener('click', () => borrowerClientInfo(client.id));
  const workspace = document.createElement('div');
  workspace.className = 'sheet-workspace';
  body.before(workspace);
  workspace.append(body);
  const summary = document.createElement('section');
  summary.className = 'sheet-finance-summary';
  summary.setAttribute('aria-label', 'Dosya hesap özeti');
  const costs = financeEvents
    .filter((e) => e.documentId === d.id && ['expense', 'costOnly'].includes(e.type))
    .reduce((a, e) => a + e.amount, 0);
  summary.innerHTML =
    '<h3>Dosya Hesabı</h3><div class="sheet-summary-date">Hesap Tarihi <b>' +
    esc(displayDate(businessDate())) +
    '</b></div>' +
    [
      ['Evrak Tutarı', financeCents(d.originalAmount ?? d.amount)],
      ['Takip Öncesi Ödeme', financeCents(d.preTrackingPayment ?? 0)],
      ['Asıl Alacak', f.principal],
      ['İşlemiş Faiz', isParkingDocument(d) ? 0 : financeCents(d.financeInterest)],
      ['Avukatlık Ücreti', isParkingDocument(d) ? 0 : financeCents(d.financeFee)],
      ['Dosya Masrafı', f.expenses],
      ['İndirim', f.discount],
      ['Toplam Alacak', f.target],
      ['Toplam Ödenen', f.received],
      ['Kalan Alacak', f.remaining],
    ]
      .map(
        ([label, amount]) =>
          '<div class="sheet-finance-line ' +
          (label === 'Kalan Alacak' ? 'sheet-balance' : label === 'Toplam Alacak' ? 'sheet-total' : '') +
          '"><span>' +
          label +
          '</span><strong>' +
          money(amount / 100) +
          '</strong></div>',
      )
      .join('') +
    '<div class="sheet-finance-actions"><button type="button" class="primary" id="sheetOpenFinance">Tahsilat</button><button type="button" class="secondary" id="sheetOpenExpense">Masraf</button></div>';
  workspace.append(summary);
  summary.querySelector('#sheetOpenFinance').onclick = () =>
    dialog.querySelector('#borrowerFinancial').click();
  summary.querySelector('#sheetOpenExpense').onclick = () => dialog.querySelector('#borrowerExpense').click();
  moveRepaymentToAccount(dialog, summary);
  moveSheetActionsToHeader(dialog, summary, d);
}

function borrowerClientInfo(id) {
  const c = db.clients.find((c) => c.id === id);
  if (!c) return toast('Müvekkil kaydı bulunamadı.');
  let dialog = document.getElementById('borrowerClientInfo');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'borrowerClientInfo';
    document.body.append(dialog);
  }
  const item = (label, value) =>
      '<div class="detail-field"><small>' + label + '</small><div>' + esc(value || '—') + '</div></div>',
    staff = (id) => personnel.find((p) => p.id === id)?.name || '';
  dialog.innerHTML =
    '<div class="panelhead"><div><h2>Müvekkil Bilgileri</h2><p>' +
    esc(c.name) +
    '</p></div><button type="button" class="secondary" id="closeClientInfo">Kapat</button></div><div class="formbody"><div class="grid">' +
    item('Ad Soyad', c.fullName ?? (c.type === 'Şahıs' ? c.name : '')) +
    item('Ticari Unvan', c.tradeName ?? (c.type !== 'Şahıs' ? c.name : '')) +
    item('Müvekkil Türü', c.clientCategory) +
    item('Şahıs / Şirket', c.type) +
    item('TC / Vergi Numarası', c.identity) +
    item('Telefon', c.phone) +
    item('E-posta', c.email) +
    item('İl / İlçe', [c.city, c.district].filter(Boolean).join(' / ')) +
    item('Açık Adres', c.address) +
    (c.additionalPhones || []).map((phone, i) => item('Ek Telefon ' + (i + 1), phone)).join('') +
    (c.additionalAddresses || [])
      .map((a, i) => item('Ek Adres ' + (i + 1), [a.address, a.district, a.city].filter(Boolean).join(' / ')))
      .join('') +
    item('Referans', c.reference) +
    item('Evrak Alan', staff(c.documentStaff)) +
    item('Evrak Kaydeden', staff(c.recordedBy) || c.recordedByName) +
    item('Tahsilat Uzmanı', staff(c.collectionStaff)) +
    item('Banka', c.bankName) +
    item('Şube', c.bankBranch) +
    item('Hesap Sahibi', c.accountHolder) +
    item('IBAN', c.iban) +
    item('Notlar', c.notes) +
    '</div>' +
    clientAttachmentPreviews(c) +
    '</div>';
  dialog.querySelector('#closeClientInfo').onclick = () => dialog.close();
  dialog.querySelectorAll('[data-wa-client-index]').forEach((host) => {
    const attachmentIndex = Number(host.dataset.waClientIndex);
    const file = c.attachments[attachmentIndex];
    if (/^data:(application\/pdf|image\/(?:png|jpeg));base64,/i.test(file?.data || ''))
      addWhatsAppFileButton(
        host,
        { id: c.id, number: c.name, phone1: c.phone, whatsappPhone: c.whatsappPhone },
        'clientAttachment',
        null,
        { clientId: c.id, attachmentIndex },
      );
  });
  if (!dialog.open) dialog.showModal();
}

function bindConversationResultFilter(root) {
  const select = root.querySelector('[data-conversation-result-filter]');
  if (!select) return;
  const history = select.closest('.conversation-history'),
    rows = [...history.querySelectorAll('[data-conversation-result]')],
    count = history.querySelector('[data-conversation-filter-count]');
  function update() {
    let visible = 0;
    for (const row of rows) {
      row.hidden = !!select.value && row.dataset.conversationResult !== select.value;
      if (!row.hidden) visible++;
    }
    count.textContent =
      visible +
      ' / ' +
      rows.length +
      ' görüşme' +
      (visible === 0 ? ' · Bu sonuç için görüşme bulunamadı.' : '');
  }
  select.onchange = update;
  update();
}

function setupBorrowerEnforcementFields(dialog, d, meta) {
  const form = document.createElement('form');
  form.id = 'borrowerEnforcementForm';
  form.className = 'sheet-enforcement-form';
  form.innerHTML =
    '<label class="field">İcra Dairesi<input name="enforcementOffice" data-optional="true" maxlength="200" value="' +
    esc(d.enforcementOffice || '') +
    '" placeholder="Örn. İstanbul 1. İcra Dairesi"></label><label class="field">İcra Dosya Numarası<input name="enforcementFileNumber" required maxlength="100" value="' +
    esc(d.enforcementFileNumber || '') +
    '" placeholder="Örn. 2026/1234"></label><button type="submit" class="primary">İcra Bilgilerini Kaydet</button>';
  const address = meta.querySelector('.sheet-address');
  if (address) meta.insertBefore(form, address);
  else meta.append(form);
  form.onsubmit = (e) => {
    e.preventDefault();
    try {
      const result = authApi('/api/documents/enforcement', 'POST', {
        documentId: d.id,
        enforcementDetails: true,
        ...Object.fromEntries(new FormData(form)),
      });
      Object.assign(d, result.document);
      if (page === 'documents') {
        debtorStatusFilter = 'İcra';
        docRows();
      }
      updateActiveDebtorCount();
      borrowerDetail(d.id, form);
      toast('İcra bilgileri kaydedildi. Dosya İcra klasöründe.', document.getElementById('borrowerDetail'));
    } catch (error) {
      toast(error.message, dialog);
    }
  };
}

function borrowerNavigationIds(currentId) {
  const listed =
    typeof page !== 'undefined' && page === 'documents'
      ? [...document.querySelectorAll('#docRows [data-debtor]')].map((b) => b.dataset.debtor)
      : [];
  if (listed.includes(currentId)) return listed;
  return db.docs.map((d) => d.id);
}

function setupBorrowerNavigation(dialog, id) {
  const ids = borrowerNavigationIds(id),
    index = ids.indexOf(id),
    nav = document.createElement('div');
  nav.className = 'borrower-sheet-navigation';
  nav.setAttribute('aria-label', 'Föyler arasında gezinme');
  for (const [direction, label, arrow, offset] of [
    ['previous', 'Önceki', '←', -1],
    ['next', 'Sonraki', '→', 1],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary borrower-nav-arrow';
    button.dataset.sheetDirection = direction;
    button.setAttribute('aria-label', label + ' föy');
    button.innerHTML = '<span>' + label + '</span><strong aria-hidden="true">' + arrow + '</strong>';
    const target = ids[index + offset];
    button.disabled = index < 0 || !target;
    button.onclick = () => {
      if (!target || blockIncompletePropertyClose(dialog)) return;
      if (window.hanRecordsEnabled) recordAction(target, () => borrowerDetail(target));
      else borrowerDetail(target);
    };
    nav.append(button);
  }
  const head = dialog.querySelector('.panelhead');
  if (head) head.append(nav);
}

function setupBorrowerResize(dialog) {
  const head = dialog.querySelector(':scope > .panelhead');
  if (!head) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary sheet-resize-toggle';
  button.setAttribute('aria-label', 'Föyü büyüt veya küçült');
  function update() {
    const expanded = dialog.classList.contains('sheet-maximized');
    button.textContent = expanded ? '⊡ Küçült' : '⛶ Büyüt';
    button.setAttribute('aria-pressed', String(expanded));
  }
  button.onclick = () => {
    const expanded = dialog.classList.contains('sheet-maximized');
    if (!expanded) {
      dialog._restoreSize = { width: dialog.style.width, height: dialog.style.height };
      dialog.style.width = '';
      dialog.style.height = '';
    } else {
      dialog.style.width = Math.min(900, window.innerWidth * 0.9) + 'px';
      dialog.style.height = Math.min(600, window.innerHeight * 0.75) + 'px';
      if (dialog.style.left) {
        const width = Math.min(900, window.innerWidth * 0.9),
          height = Math.min(600, window.innerHeight * 0.75);
        dialog.style.left =
          Math.max(0, Math.min(parseFloat(dialog.style.left) || 0, window.innerWidth - width)) + 'px';
        dialog.style.top =
          Math.max(0, Math.min(parseFloat(dialog.style.top) || 0, window.innerHeight - height)) + 'px';
      }
    }
    dialog.classList.toggle('sheet-maximized', !expanded);
    update();
  };
  head.append(button);
  update();
}

function setupBorrowerDragging(dialog) {
  const head = dialog.querySelector(':scope > .panelhead');
  if (!head) return;
  head.classList.add('sheet-drag-handle');
  head.title = 'Föyü taşımak için başlık alanından sürükleyin';
  head.onpointerdown = (e) => {
    if (e.button !== 0 || e.target.closest('button,input,select,textarea,a')) return;
    const rect = dialog.getBoundingClientRect(),
      offsetX = e.clientX - rect.left,
      offsetY = e.clientY - rect.top;
    dialog.style.position = 'fixed';
    dialog.style.margin = '0';
    dialog.style.right = 'auto';
    dialog.style.bottom = 'auto';
    dialog.style.left = rect.left + 'px';
    dialog.style.top = rect.top + 'px';
    head.setPointerCapture(e.pointerId);
    e.preventDefault();
    const move = (event) => {
      dialog.style.left =
        Math.max(
          0,
          Math.min(window.innerWidth - dialog.getBoundingClientRect().width, event.clientX - offsetX),
        ) + 'px';
      dialog.style.top = Math.max(0, Math.min(window.innerHeight - 50, event.clientY - offsetY)) + 'px';
    };
    const stop = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', stop);
      head.removeEventListener('pointercancel', stop);
      try {
        head.releasePointerCapture(e.pointerId);
      } catch {}
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', stop);
    head.addEventListener('pointercancel', stop);
  };
}

function setupBorrowerCornerResize(dialog) {
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const handle = document.createElement('div');
    handle.className = 'sheet-corner-resize sheet-corner-' + corner;
    handle.setAttribute('aria-hidden', 'true');
    dialog.append(handle);
    handle.onpointerdown = (e) => {
      if (e.button !== 0 || dialog.classList.contains('sheet-maximized')) return;
      e.preventDefault();
      e.stopPropagation();
      const r = dialog.getBoundingClientRect(),
        startX = e.clientX,
        startY = e.clientY;
      dialog.style.position = 'fixed';
      dialog.style.margin = '0';
      dialog.style.right = 'auto';
      dialog.style.bottom = 'auto';
      dialog.style.left = r.left + 'px';
      dialog.style.top = r.top + 'px';
      dialog.style.width = r.width + 'px';
      dialog.style.height = r.height + 'px';
      handle.setPointerCapture(e.pointerId);
      const move = (event) => {
        const west = corner.includes('w'),
          north = corner.includes('n'),
          minWidth = Math.min(680, window.innerWidth * 0.94),
          minHeight = Math.min(360, window.innerHeight * 0.9);
        let left = r.left,
          right = r.right,
          top = r.top,
          bottom = r.bottom;
        if (west) left = Math.max(0, Math.min(right - minWidth, r.left + event.clientX - startX));
        else right = Math.min(window.innerWidth, Math.max(left + minWidth, r.right + event.clientX - startX));
        if (north) top = Math.max(0, Math.min(bottom - minHeight, r.top + event.clientY - startY));
        else
          bottom = Math.min(window.innerHeight, Math.max(top + minHeight, r.bottom + event.clientY - startY));
        dialog.style.left = left + 'px';
        dialog.style.top = top + 'px';
        dialog.style.width = right - left + 'px';
        dialog.style.height = bottom - top + 'px';
      };
      const stop = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', stop);
        handle.removeEventListener('pointercancel', stop);
        try {
          handle.releasePointerCapture(e.pointerId);
        } catch {}
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    };
  }
}

function setupBorrowerPin(dialog, d) {
  const head = dialog.querySelector(':scope > .panelhead'),
    pin = document.createElement('button');
  pin.type = 'button';
  pin.className = 'secondary sheet-pin-button';
  pin.textContent = '📌';
  pin.title = 'Föyü ekranda iğnele';
  pin.setAttribute('aria-label', 'Föyü iğnele');
  head.prepend(pin);
  pin.onclick = () => {
    const existing = [...document.querySelectorAll('.pinned-borrower-sheet')].find(
      (p) => p.dataset.pinnedDocument === d.id,
    );
    if (existing) {
      dialog.close();
      existing.focus();
      return;
    }
    const pinned = document.createElement('dialog');
    pinned.className = 'compact-borrower-sheet pinned-borrower-sheet';
    pinned.dataset.pinnedDocument = d.id;
    pinned.innerHTML = dialog.innerHTML;
    pinned.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    pinned.querySelectorAll('.sheet-corner-resize').forEach((el) => el.remove());
    pinned.querySelectorAll('input,select,textarea,button').forEach((el) => (el.disabled = true));
    const pinnedHead = pinned.querySelector(':scope > .panelhead');
    pinnedHead.innerHTML =
      '<strong>📌 ' +
      esc(d.number) +
      ' · ' +
      esc(d.debtor) +
      '</strong><div class="toolbar"><button type="button" class="secondary" data-pin-open>Föyü Aç</button><button type="button" class="secondary close-align-right" data-pin-close>Kapat</button></div>';
    pinnedHead.querySelector('[data-pin-close]').onclick = () => pinned.remove();
    pinnedHead.querySelector('[data-pin-open]').onclick = () => {
      const rect = pinned.getBoundingClientRect();
      pinned.remove();
      borrowerDetail(d.id);
      const active = document.getElementById('borrowerDetail');
      active.classList.remove('sheet-maximized');
      Object.assign(active.style, {
        position: 'fixed',
        margin: '0',
        left: rect.left + 'px',
        top: rect.top + 'px',
        right: 'auto',
        bottom: 'auto',
        width: rect.width + 'px',
        height: rect.height + 'px',
      });
    };
    pinned.querySelectorAll('[data-borrower-tab]').forEach((b) => {
      b.disabled = false;
      b.onclick = () => {
        const key = b.dataset.borrowerTab;
        pinned
          .querySelectorAll('[data-borrower-panel]')
          .forEach((panel) => (panel.hidden = panel.dataset.borrowerPanel !== key));
        pinned
          .querySelectorAll('[data-borrower-tab]')
          .forEach((tab) => tab.classList.toggle('selected', tab === b));
      };
    });
    const count = document.querySelectorAll('.pinned-borrower-sheet').length;
    pinned.style.left = Math.min(30 + count * 35, window.innerWidth * 0.3) + 'px';
    pinned.style.top = Math.min(35 + count * 35, window.innerHeight * 0.25) + 'px';
    document.body.append(pinned);
    setupBorrowerDragging(pinned);
    dialog.close();
    pinned.show();
  };
}

function setupBorrowerChain(dialog, d) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary sheet-chain-button';
  const count = (d.linkedDocumentIds || []).length;
  button.textContent = '🔗 Zincir Yap' + (count ? ' (' + count + ')' : '');
  button.onclick = () => openBorrowerChain(d.id);
  dialog.querySelector(':scope > .panelhead').append(button);
}

function openBorrowerChain(id) {
  if (window.hanRecordsEnabled && !window.hanWorkspaceComplete)
    return ensureRecordWorkspace(() => openBorrowerChain(id));
  const d = db.docs.find((d) => d.id === id);
  if (!d) return;
  let dialog = document.getElementById('borrowerChainDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'borrowerChainDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML =
    '<div class="panelhead"><div><h2>Dosya Zinciri</h2><p>' +
    esc(d.number) +
    ' · ' +
    esc(d.debtor) +
    '</p></div><button type="button" class="secondary" data-chain-close>Kapat</button></div><div class="formbody"><p>Dosyaları birbirine bağlayın. Bağlantı, dosyaların borç ve ödeme hesaplarını değiştirmez.</p><h3>Bağlı Dosyalar</h3><div data-chain-linked></div><label class="field">Bağlanacak Dosyayı Ara<input type="search" data-chain-search data-optional="true" placeholder="Föy no, borçlu, TC veya müvekkil…"></label><div data-chain-results></div></div>';
  dialog.querySelector('[data-chain-close]').onclick = () => dialog.close();
  function update(action, targetId) {
    try {
      const result = authApi('/api/documents/chain', 'POST', { documentId: id, targetId, action });
      for (const record of result.documents) {
        const existing = db.docs.find((x) => x.id === record.id);
        if (existing) Object.assign(existing, record);
      }
      render();
      const parent = document.getElementById('borrowerDetail');
      if (parent?.open) borrowerDetail(id);
      toast(
        action === 'add' ? 'Dosyalar zincir yapılarak kaydedildi.' : 'Dosya bağlantısı kaldırıldı.',
        dialog,
      );
    } catch (error) {
      toast(error.message, dialog);
    }
  }
  function render() {
    const linked = new Set(d.linkedDocumentIds || []),
      row = (x, isLinked) =>
        '<div class="chain-file-row"><div><strong>' +
        esc(x.number) +
        ' · ' +
        esc(x.debtor) +
        '</strong><small>' +
        esc(db.clients.find((c) => c.id === x.client)?.name || '') +
        ' · ' +
        esc(debtorStatus(x)) +
        '</small></div>' +
        (isLinked
          ? '<button class="secondary" data-chain-open="' +
            esc(x.id) +
            '">Föyü Aç</button><button class="link" data-chain-remove="' +
            esc(x.id) +
            '">Bağı Kaldır</button>'
          : '<button class="primary" data-chain-add="' + esc(x.id) + '">Zincire Ekle</button>') +
        '</div>';
    dialog.querySelector('[data-chain-linked]').innerHTML =
      db.docs
        .filter((x) => linked.has(x.id))
        .map((x) => row(x, true))
        .join('') || '<p>Bağlı dosya bulunmuyor.</p>';
    const query = dialog.querySelector('[data-chain-search]').value.trim().toLocaleLowerCase('tr');
    const candidates = db.docs.filter(
      (x) =>
        x.id !== id &&
        !linked.has(x.id) &&
        [x.number, x.debtor, x.identity, db.clients.find((c) => c.id === x.client)?.name].some((value) =>
          normalizeSearch(value).includes(normalizeSearch(query)),
        ),
    );
    dialog.querySelector('[data-chain-results]').innerHTML =
      candidates
        .slice(0, 50)
        .map((x) => row(x, false))
        .join('') || '<p>Eşleşen dosya yok.</p>';
    dialog
      .querySelectorAll('[data-chain-add]')
      .forEach((b) => (b.onclick = () => update('add', b.dataset.chainAdd)));
    dialog
      .querySelectorAll('[data-chain-remove]')
      .forEach((b) => (b.onclick = () => update('remove', b.dataset.chainRemove)));
    dialog.querySelectorAll('[data-chain-open]').forEach(
      (b) =>
        (b.onclick = () => {
          dialog.close();
          borrowerDetail(b.dataset.chainOpen);
        }),
    );
  }
  dialog.querySelector('[data-chain-search]').oninput = render;
  render();
  if (!dialog.open) dialog.showModal();
}

function borrowerAttachmentPreviews(d) {
  const pdf = safeAttachmentUrl(d.fileData, 'pdf'),
    photo = safeAttachmentUrl(d.photoData, 'photo');
  if (!pdf && !photo) return '<p class="notice">Bu evrak için yüklenmiş fotoğraf veya PDF bulunmuyor.</p>';
  return (
    '<div class="borrower-attachment-previews">' +
    (photo
      ? '<section><h3>Kaydedilen Fotoğraf</h3><img class="borrower-document-photo" src="' +
        esc(photo) +
        '" alt="' +
        esc(d.photoFileName || 'Evrak fotoğrafı') +
        '"><p><a href="' +
        esc(photo) +
        '" download="' +
        esc(d.photoFileName || 'evrak-fotografi') +
        '">Fotoğrafı İndir</a></p></section>'
      : '') +
    (pdf
      ? '<section><h3>Kaydedilen PDF</h3><object class="borrower-document-pdf" data="' +
        esc(pdf) +
        '" type="application/pdf"><p>PDF önizlemesi bu tarayıcıda gösterilemiyor. Aşağıdaki bağlantıdan indirebilirsiniz.</p></object><p><a href="' +
        esc(pdf) +
        '" download="' +
        esc(d.fileName || 'evrak.pdf') +
        '">PDF İndir · ' +
        esc(d.fileName || 'Evrak') +
        '</a></p></section>'
      : '') +
    '</div>'
  );
}

function moveRepaymentToAccount(dialog, summary) {
  const panel = dialog.querySelector('[data-borrower-panel="finance"]');
  if (!panel) return;
  panel.removeAttribute('data-borrower-panel');
  panel.removeAttribute('role');
  panel.removeAttribute('aria-labelledby');
  panel.hidden = false;
  panel.classList.add('sheet-account-extra');
  panel.querySelector('.stats')?.remove();
  panel.querySelectorAll('h3.sectiontitle').forEach((el) => el.remove());
  const financial = panel.querySelector('#borrowerFinancial'),
    expense = panel.querySelector('#borrowerExpense');
  financial.hidden = true;
  expense.hidden = true;
  const actions = document.createElement('div');
  actions.className = 'sheet-debt-actions';
  const repayment = panel.querySelector('#openRepayment'),
    promise = panel.querySelector('[data-payment-promise]');
  if (repayment) actions.append(repayment);
  if (promise) actions.append(promise);
  summary.append(actions);
  const status = panel.querySelector('#borrowerStatusForm'),
    statusDetails = document.createElement('details');
  statusDetails.innerHTML = '<summary>Dosya Durumu</summary>';
  if (status) {
    statusDetails.append(status);
    summary.append(statusDetails);
  }
  const details = document.createElement('details');
  details.className = 'sheet-repayment-details';
  details.innerHTML = '<summary>Yapılandırma / Ödeme Sözü Bilgileri</summary>';
  details.append(panel);
  summary.append(details);
}

function moveSheetActionsToHeader(dialog, summary, documentRecord) {
  const head = dialog.querySelector(':scope > .panelhead'),
    toolbar = document.createElement('div');
  toolbar.className = 'sheet-header-actions';
  for (const selector of [
    '#sheetOpenFinance',
    '[data-payment-promise]',
    '#sheetOpenExpense',
    '#openRepayment',
  ]) {
    const button = summary.querySelector(selector);
    if (button) toolbar.append(button);
  }
  if (documentRecord && debtorStatus(documentRecord) === 'İnfaz') {
    const release = document.createElement('button');
    release.type = 'button';
    release.className = 'secondary sheet-release-button';
    release.textContent = 'İbraname';
    release.onclick = () => openBorrowerRelease(documentRecord.id);
    const payment = toolbar.querySelector('#sheetOpenFinance');
    if (payment) payment.after(release);
    else toolbar.append(release);
  }
  const status = summary.querySelector('details:not(.sheet-repayment-details)');
  if (status) {
    status.hidden = true;
    const statusField = document.createElement('label');
    statusField.className = 'sheet-inline-status';
    statusField.append(document.createTextNode('Dosya Durumu'));
    const statusSelect = document.createElement('select');
    statusSelect.setAttribute('aria-label', 'Dosya Durumu');
    statusSelect.dataset.optional = 'true';
    const current = dialog.querySelector('#borrowerStatusForm select').value;
    for (const [value, label] of [
      ['Derdest', 'Derdest'],
      ['İcra', 'İcrada'],
      ['İade', 'İade'],
      ['İnfaz', 'İnfaz'],
    ]) {
      const option = new Option(label, value);
      if (value === 'İade' && !['ceo', 'admin'].includes(hanAuth.role)) option.disabled = true;
      statusSelect.add(option);
    }
    statusSelect.value = current;
    function paint() {
      statusSelect.dataset.statusColor = { Derdest: 'green', İcra: 'orange', İade: 'yellow', İnfaz: 'red' }[
        statusSelect.value
      ];
    }
    paint();
    statusSelect.onchange = () => {
      const form = dialog.querySelector('#borrowerStatusForm');
      form.elements.status.value = statusSelect.value;
      form.requestSubmit();
      const record = db.docs.find((d) => d.id === dialog.dataset.borrowerId);
      statusSelect.value = record ? debtorStatus(record) : current;
      paint();
    };
    statusField.append(statusSelect);
    toolbar.append(statusField);
  }
  const info = document.createElement('button');
  info.type = 'button';
  info.className = 'secondary';
  info.textContent = 'Yapılandırma / Ödeme Sözü Bilgileri';
  info.onclick = () => openSheetPlanInfo(dialog);
  toolbar.append(info);
  const planDetails = summary.querySelector('.sheet-repayment-details');
  if (planDetails) planDetails.hidden = true;
  head.append(toolbar);
  const resize = head.querySelector('.sheet-resize-toggle'),
    close = head.querySelector('#closeBorrower');
  if (resize && close) close.before(resize);
}

function openSheetPlanInfo(source) {
  const original = source.querySelector('.sheet-repayment-details .sheet-account-extra');
  if (!original) return;
  let dialog = document.getElementById('sheetPlanInfoDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'sheetPlanInfoDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML =
    '<div class="panelhead"><h2>Yapılandırma / Ödeme Sözü Bilgileri</h2><button type="button" class="secondary close-align-right" data-close-plan-info>Kapat</button></div><div class="formbody" data-plan-info-content></div>';
  const content = original.cloneNode(true);
  content.removeAttribute('id');
  content.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  content.querySelectorAll('button,form').forEach((el) => el.remove());
  content.hidden = false;
  dialog.querySelector('[data-plan-info-content]').append(content);
  dialog.querySelector('[data-close-plan-info]').onclick = () => dialog.close();
  if (!dialog.open) dialog.showModal();
}

function openSheetStatus(source) {
  const form = source.querySelector('#borrowerStatusForm');
  if (!form) return;
  let dialog = document.getElementById('sheetStatusDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'sheetStatusDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML =
    '<div class="panelhead"><h2>Dosya Durumu</h2><button type="button" class="secondary close-align-right" data-status-close>Kapat</button></div><div class="formbody" data-status-host></div>';
  const parent = form.parentNode;
  dialog.querySelector('[data-status-host]').append(form);
  function restore() {
    if (form.parentNode) parent.append(form);
  }
  dialog.addEventListener('close', restore, { once: true });
  dialog.querySelector('[data-status-close]').onclick = () => dialog.close();
  const originalSubmit = form.onsubmit;
  form.onsubmit = (e) => {
    originalSubmit.call(form, e);
    const current = db.docs.find((d) => d.id === source.dataset.borrowerId);
    if (current && debtorStatus(current) === form.elements.status.value) {
      dialog.close();
    } else {
      const note = document.createElement('p');
      note.className = 'notice';
      note.textContent = 'Durum değiştirilemedi. Dosyanın ödeme ve durum koşullarını kontrol edin.';
      dialog.querySelector('[data-status-host]').append(note);
    }
  };
  dialog.addEventListener(
    'close',
    () => {
      form.onsubmit = originalSubmit;
    },
    { once: true },
  );
  if (!dialog.open) dialog.showModal();
}

function borrowerReleaseContent(d, client) {
  const payments = financeEvents.filter((e) => e.documentId === d.id && e.type === 'payment'),
    paidDate =
      d.closedDate ||
      payments
        .map((e) => e.date)
        .sort()
        .at(-1) ||
      '',
    tracking = borrowerTrackingDate(d);
  return (
    '<article class="release-letter"><h1>İBRANAME</h1><p class="release-addressee">Sn. ' +
    esc(d.debtor) +
    '</p><p>Alacaklı ' +
    esc(client?.tradeName || client?.name || '—') +
    ' firmaya ' +
    esc(displayDate(paidDate) || '—') +
    ' tarihinde ödeme yaptığınız için, ' +
    esc(displayDate(tracking) || '—') +
    ' takip tarihli ' +
    esc(d.number) +
    ' numaralı dosyanızdan borcunuz kalmamıştır.</p><div class="release-signature"><strong>Av. Hasan Bahadır PATAN</strong></div></article>'
  );
}

function openBorrowerRelease(id) {
  const d = db.docs.find((d) => d.id === id);
  if (!d || debtorStatus(d) !== 'İnfaz' || docFinance(d).remaining > 0)
    return toast('İbraname yalnızca borcu tamamen ödenmiş infaz dosyalarında oluşturulur.');
  const client = db.clients.find((c) => c.id === d.client),
    letter = borrowerReleaseContent(d, client);
  let dialog = document.getElementById('borrowerReleaseDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'borrowerReleaseDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML =
    '<div class="panelhead"><h2>İbraname · ' +
    esc(d.number) +
    '</h2><div class="toolbar"><button type="button" class="primary" data-print-release>Yazdır / PDF</button><button type="button" class="secondary close-align-right" data-close-release>Kapat</button></div></div><div class="formbody">' +
    letter +
    '</div>';
  dialog.querySelector('[data-close-release]').onclick = () => dialog.close();
  addWhatsAppFileButton(dialog.querySelector('.panelhead .toolbar'), d, 'release');
  dialog.querySelector('[data-print-release]').onclick = () => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0';
    document.body.append(frame);
    frame.onload = () => {
      frame.contentWindow.focus();
      frame.contentWindow.print();
      setTimeout(() => frame.remove(), 60000);
    };
    frame.srcdoc =
      '<!doctype html><html lang="tr"><meta charset="utf-8"><title>İbraname ' +
      esc(d.number) +
      '</title><style>@page{size:A4;margin:25mm}body{font:12pt Arial;color:#111}.release-letter h1{text-align:center;font-size:18pt;margin:25mm 0 20mm}.release-letter p{line-height:1.9;text-align:justify}.release-addressee{font-weight:bold}.release-signature{text-align:right;margin-top:30mm}</style>' +
      letter +
      '</html>';
  };
  if (!dialog.open) dialog.showModal();
}

function collectionReceiptContent(event, d, client) {
  const item = (label, value) => '<tr><th>' + label + '</th><td>' + esc(value || '—') + '</td></tr>';
  return (
    '<article class="collection-receipt-document"><h1>TAHSİLAT MAKBUZU</h1><p class="receipt-reference">Makbuz No: ' +
    esc(event.id) +
    '</p><table>' +
    item('Tahsilat Tarihi', displayDate(event.date)) +
    item('Föy Numarası', d.number) +
    item('Takip Tarihi', displayDate(borrowerTrackingDate(d))) +
    item('Borçlu', d.debtor) +
    item('TC / Vergi No', d.identity) +
    item('Alacaklı', client?.tradeName || client?.name) +
    item('Tahsil Edilen Tutar', money(event.amount / 100)) +
    item(
      'Kasa / Banka',
      event.accountName || accounting.accounts.find((a) => a.id === event.accountId)?.name,
    ) +
    item('Tahsil Eden', 'Av. Hasan Bahadır Patan Hukuk Bürosu') +
    item('Açıklama / Dekont No', event.note) +
    '</table><p>Yukarıda belirtilen dosyaya ilişkin ' +
    esc(money(event.amount / 100)) +
    ' tutarındaki ödeme tahsil edilmiştir.</p><div class="receipt-signatures"><div>Ödemeyi Yapan<br><strong>' +
    esc(d.debtor) +
    '</strong><br>İmza</div><div>Tahsil Eden<br><strong>Av. Hasan Bahadır Patan Hukuk Bürosu</strong><br>İmza</div></div></article>'
  );
}

function openCollectionReceipt(eventId) {
  const event = financeEvents.find((e) => e.id === eventId && e.type === 'payment');
  if (!event) return toast('Kayıtlı tahsilat bulunamadı.');
  const d = db.docs.find((d) => d.id === event.documentId);
  if (!d) return;
  const letter = collectionReceiptContent(
    event,
    d,
    db.clients.find((c) => c.id === d.client),
  );
  let dialog = document.getElementById('collectionReceiptDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'collectionReceiptDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML =
    '<div class="panelhead"><h2>Tahsilat Makbuzu</h2><div class="toolbar"><button type="button" class="primary" data-receipt-print>Yazdır / PDF</button><button type="button" class="secondary close-align-right" data-receipt-close>Kapat</button></div></div><div class="formbody">' +
    letter +
    '</div>';
  dialog.querySelector('[data-receipt-close]').onclick = () => dialog.close();
  addWhatsAppFileButton(dialog.querySelector('.panelhead .toolbar'), d, 'collection', event.id);
  dialog.querySelector('[data-receipt-print]').onclick = () => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0';
    document.body.append(frame);
    frame.onload = () => {
      frame.contentWindow.focus();
      frame.contentWindow.print();
      setTimeout(() => frame.remove(), 60000);
    };
    frame.srcdoc =
      '<!doctype html><html lang="tr"><meta charset="utf-8"><title>Tahsilat Makbuzu ' +
      esc(d.number) +
      '</title><style>@page{size:A4;margin:22mm}body{font:11pt Arial;color:#111}h1{text-align:center;font-size:19pt;margin:25px 0}table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;text-align:left;padding:10px}th{width:34%}.receipt-reference{font-size:9pt;overflow-wrap:anywhere}.receipt-signatures{display:flex;justify-content:space-between;margin-top:65px;line-height:2}</style>' +
      letter +
      '</html>';
  };
  if (!dialog.open) dialog.showModal();
}

function setupBorrowerDeletion(dialog, d) {
  if (!hanAuth.canDelete) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary sheet-delete-button';
  button.textContent = 'Dosyayı Sil';
  button.onclick = () => deleteBorrowerDocument(d.id);
  dialog.querySelector(':scope > .panelhead .toolbar').prepend(button);
}

function deleteBorrowerDocument(id) {
  if (!hanAuth.canDelete) return;
  const d = db.docs.find((d) => d.id === id);
  if (
    !d ||
    !confirm(
      d.number +
        ' · ' +
        d.debtor +
        ' dosyası Silinen Evraklar arşivine alınsın mı? Ekler ve tahsilat geçmişi korunur.',
    )
  )
    return;
  try {
    authApi('/api/documents/delete', 'POST', { documentId: id });
    db = authApi('/api/data?key=icrapro-v1');
    const detail = document.getElementById('borrowerDetail');
    if (detail?.open) detail.close();
    document.querySelectorAll('.pinned-borrower-sheet').forEach((p) => {
      if (p.dataset.pinnedDocument === id) p.remove();
    });
    page = 'documents';
    render();
    toast('Evrak Silinen Evraklar arşivine alındı.');
  } catch (error) {
    toast(error.message);
  }
}

function clientAttachmentPreviews(c) {
  const files = (Array.isArray(c.attachments) ? c.attachments : []).filter((f) => safeAttachmentUrl(f.data));
  return (
    '<section class="client-poa-previews"><h3>Vekâletname / Yüklenen Belgeler</h3>' +
    (files
      .map((f) => {
        const pdf = /^data:application\/pdf;/i.test(f.data);
        return (
          '<article class="client-poa-file" data-wa-client-index="' +
          c.attachments.indexOf(f) +
          '"><h4>' +
          esc(f.name || (pdf ? 'Vekâletname PDF' : 'Vekâletname / Fotoğraf')) +
          '</h4>' +
          (pdf
            ? '<object type="application/pdf" data="' +
              esc(f.data) +
              '" class="borrower-document-pdf"><p>PDF önizlemesi desteklenmiyor. Aşağıdaki bağlantıdan indirebilirsiniz.</p></object>'
            : '<img class="borrower-document-photo" src="' +
              esc(f.data) +
              '" alt="' +
              esc(f.name || 'Müvekkil belgesi') +
              '">') +
          '<p><a href="' +
          esc(f.data) +
          '" download="' +
          esc(f.name || 'vekaletname') +
          '">İndir</a></p></article>'
        );
      })
      .join('') || '<p>Bu müvekkile yüklenmiş vekâletname veya fotoğraf bulunmuyor.</p>') +
    '</section>'
  );
}
