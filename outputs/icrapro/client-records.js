function setupClientDistrict(prefix = 'client') {
  const city = $('#' + prefix + 'City'),
    input = $('#' + prefix + 'District'),
    box = $('#' + prefix + 'DistrictSuggestions');
  let lastCity = city.value;
  function synchronize() {
    const canonical = turkeyCities.find(
      (c) => c.toLocaleLowerCase('tr') === city.value.trim().toLocaleLowerCase('tr'),
    );
    if (city.value !== lastCity) {
      input.value = '';
      input.setCustomValidity('');
      lastCity = city.value;
    }
    input.disabled = !canonical;
    input.placeholder = canonical ? 'İlçenin ilk harfini yazın…' : 'Önce il seçin';
    box.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    return canonical;
  }
  function show() {
    const selected = synchronize();
    if (!selected) return;
    const query = input.value.trim().toLocaleLowerCase('tr'),
      names = (turkeyDistricts[selected] || []).filter((d) =>
        normalizeSearch(d).includes(normalizeSearch(query)),
      );
    box.innerHTML =
      names
        .map((name) => `<button type="button" data-district="${esc(name)}">${esc(name)}</button>`)
        .join('') || '<p>Eşleşen ilçe bulunamadı.</p>';
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    box.querySelectorAll('button').forEach(
      (b) =>
        (b.onclick = () => {
          input.value = b.dataset.district;
          input.setCustomValidity('');
          input.focus();
          box.hidden = true;
          input.setAttribute('aria-expanded', 'false');
        }),
    );
  }
  city.addEventListener('input', synchronize);
  city.addEventListener('change', synchronize);
  input.onfocus = show;
  input.oninput = show;
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      show();
      box.querySelector('button')?.focus();
    }
    if (e.key === 'Escape') {
      box.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    }
  };
  box.onkeydown = (e) => {
    const buttons = [...box.querySelectorAll('button')],
      index = buttons.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = index + (e.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) input.focus();
      else buttons[next % buttons.length]?.focus();
    }
    if (e.key === 'Escape') {
      input.focus();
      box.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    }
  };
  input.parentElement.addEventListener('focusout', (e) => {
    if (!input.parentElement.contains(e.relatedTarget)) {
      box.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    }
  });
  synchronize();
}

function clientCityField(c, prefix = 'client') {
  return `<div class="field"><label for="${prefix}City">İl *</label><input id="${prefix}City" name="city" required autocomplete="off" value="${esc(c.city || '')}" placeholder="İlin ilk harfini yazın…" aria-controls="${prefix}CitySuggestions" aria-expanded="false"><div id="${prefix}CitySuggestions" class="city-suggestions" hidden></div></div><div class="field"><label for="${prefix}District">İlçe *</label><input id="${prefix}District" name="district" required autocomplete="off" value="${esc(c.district || '')}" placeholder="Önce il seçin" aria-controls="${prefix}DistrictSuggestions" aria-expanded="false"><div id="${prefix}DistrictSuggestions" class="city-suggestions" hidden></div></div>`;
}

function setupClientCity(prefix = 'client') {
  const input = $('#' + prefix + 'City'),
    box = $('#' + prefix + 'CitySuggestions');
  function show() {
    const q = input.value.trim().toLocaleLowerCase('tr');
    const cities = turkeyCities.filter((city) => normalizeSearch(city).includes(normalizeSearch(q)));
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    box.innerHTML =
      cities.map((city) => `<button type="button" data-city="${city}">${city}</button>`).join('') ||
      '<p>Eşleşen il bulunamadı.</p>';
    box.querySelectorAll('button').forEach(
      (b) =>
        (b.onclick = () => {
          input.value = b.dataset.city;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.setCustomValidity('');
          box.hidden = true;
          input.setAttribute('aria-expanded', 'false');
          document.getElementById(prefix + 'District').focus();
        }),
    );
  }
  input.oninput = show;
  input.onfocus = show;
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (box.hidden) show();
      box.querySelector('button')?.focus();
    }
    if (e.key === 'Escape') {
      box.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    }
  };
  box.onkeydown = (e) => {
    const buttons = [...box.querySelectorAll('button')],
      index = buttons.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? index + 1 : index - 1;
      if (next < 0) input.focus();
      else buttons[next % buttons.length]?.focus();
    }
    if (e.key === 'Escape') {
      input.focus();
      box.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    }
  };
  input.form.addEventListener('focusout', (e) => {
    if (!input.parentElement.contains(e.relatedTarget)) {
      box.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    }
  });
}

function renderClientScope() {
  const bar = document.getElementById('clientScopeBar'),
    filter = document.getElementById('clientScope');
  bar.hidden = page !== 'intake';
  if (page !== 'intake') return;
  if (window.hanRecordsEnabled) return renderRecordIntakeScope(bar, filter);
  if (selected && !db.clients.some((c) => c.id === selected)) selected = '';
  filter.innerHTML =
    '<option value="">Tüm Müvekkiller</option>' +
    db.clients
      .map(
        (c) =>
          `<option value="${esc(c.id)}" ${selected === c.id ? 'selected' : ''}>${esc(c.name)}${c.identity ? ' · ' + (window.hanPrivacy ? hanPrivacy.text('id', c.identity) : esc(c.identity)) : ''}</option>`,
      )
      .join('');
  filter.onchange = (e) => {
    selected = e.target.value;
    const form = document.getElementById('intakeForm');
    if (form) form.elements.client.value = selected;
    stats();
  };
}

function renderClientSuggestions(query, list) {
  const box = document.getElementById('clientSuggestions'),
    input = document.getElementById('search');
  if (!box) return;
  box.hidden = !query;
  input.setAttribute('aria-expanded', String(!!query));
  box.innerHTML = query
    ? list.length
      ? list
          .map(
            (c) =>
              `<button type="button" data-client-suggestion="${esc(c.id)}"><strong>${esc(c.name)}</strong><small>${esc(c.type)}${c.identity ? ' · ' + (window.hanPrivacy ? hanPrivacy.text('id', c.identity) : esc(c.identity)) : ''}</small></button>`,
          )
          .join('')
      : '<p>Eşleşen müvekkil bulunamadı.</p>'
    : '';
  box.querySelectorAll('[data-client-suggestion]').forEach(
    (button) =>
      (button.onclick = () => {
        const client = list.find((c) => c.id === button.dataset.clientSuggestion);
        input.value = client.name;
        clientRows();
        box.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        input.focus();
      }),
  );
  input.onkeydown = (event) => {
    if (event.key === 'Escape') {
      box.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    }
    if (event.key === 'ArrowDown' && !box.hidden) {
      event.preventDefault();
      box.querySelector('button')?.focus();
    }
  };
  box.onkeydown = (event) => {
    const buttons = [...box.querySelectorAll('button')],
      index = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      buttons[(index + 1) % buttons.length]?.focus();
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (index <= 0) input.focus();
      else buttons[index - 1].focus();
    }
    if (event.key === 'Escape') {
      box.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.focus();
    }
  };
}

function normalizeSearch(value) {
  return String(value ?? '')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function matchesFolioNumber(number, query) {
  const canonical = (value) => normalizeSearch(value).replace(/^([a-z]+)-0*([0-9]+)$/, '$1-$2');
  return /^[a-z]+-[0-9]+$/.test(normalizeSearch(query)) && canonical(number) === canonical(query);
}

function recordSearchText(doc, client) {
  const fields = (record) =>
    Object.entries(record || {})
      .filter(
        ([key, value]) =>
          !['id', 'client', 'fileData'].includes(key) && ['string', 'number'].includes(typeof value),
      )
      .flatMap(([key, value]) => {
        const out = [value];
        if (/date|due|issued|created|period/i.test(key)) {
          const date = String(value).slice(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(date))
            out.push(date.split('-').reverse().join('.'), date.split('-').reverse().join('/'));
        }
        return out;
      });
  const staff =
    typeof personnel === 'undefined'
      ? []
      : personnel
          .filter((p) => [client?.documentStaff, client?.collectionStaff].includes(p.id))
          .map((p) => p.name);
  const amount = Number(doc.amount || 0);
  return normalizeSearch(
    [
      ...fields(doc),
      ...fields(client),
      ...staff,
      docType(doc),
      String(amount),
      amount.toFixed(2),
      new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2 }).format(amount),
    ].join(' '),
  );
}

function borrowerPhoneMatches(doc, query) {
  const digits = (value) => String(value || '').replace(/\D/g, ''),
    needle = digits(query);
  if (!needle) return true;
  const phones = [
    doc.phone1,
    doc.phone2,
    doc.referencePhone1,
    doc.referencePhone2,
    doc.officePhone1,
    doc.officePhone2,
    ...(doc.additionalPhones || []),
  ];
  return phones.some((phone) => {
    const value = digits(phone);
    return (
      value.includes(needle) ||
      (needle.startsWith('90') && value.replace(/^0/, '').includes(needle.slice(2))) ||
      (needle.startsWith('0') && value.replace(/^90/, '').replace(/^0/, '').includes(needle.slice(1)))
    );
  });
}

function matchesGlobalSearch(doc, client, query) {
  const text = recordSearchText(doc, client);
  if (
    normalizeSearch(query)
      .split(/\s+/)
      .filter(Boolean)
      .every((term) => text.includes(term) || matchesFolioNumber(doc.number, term))
  )
    return true;
  return (
    /^[+\d\s().-]+$/.test(String(query || '')) &&
    String(query).replace(/\D/g, '').length >= 3 &&
    borrowerPhoneMatches(doc, query)
  );
}

function clientDocumentTotals(docs) {
  const closed = docs.filter((d) => normalizeSearch(d.status) === 'infaz');
  const returned = docs.filter((d) => normalizeSearch(d.status) === 'iade');
  return {
    accepted: docs.length,
    closed: closed.length,
    returned: returned.length,
    closedAmount: closed.reduce((sum, d) => sum + Math.round(Number(d.amount || 0) * 100), 0) / 100,
    paidAmount: docs.reduce((sum, d) => sum + clientPayoutTotals(d).paid, 0) / 100,
  };
}

function clientRows(event) {
  if (window.hanRecordsEnabled) return event ? scheduleRecordClientPage() : loadRecordClientPage();
  const q = normalizeSearch($('#search').value);
  const list = db.clients.filter((c) =>
    [c.name, c.fullName, c.tradeName, c.identity].some((value) => normalizeSearch(value).startsWith(q)),
  );
  renderClientSuggestions(q, list);
  paintClientRows(list);
  $('#total').textContent = `${list.length} müvekkil gösteriliyor`;
}

function bindClientSearch() {
  const input = document.getElementById('search');
  input.addEventListener('input', clientRows);
  input.addEventListener('search', clientRows);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      clientRows();
    }
  });
}

function paintClientRows(list, remote = false) {
  $('#rows').innerHTML =
    list
      .map(
        (c) =>
          `<tr><td><div class="rowname"><span class="initial">${esc((c.name || '').slice(0, 2).toLocaleUpperCase('tr'))}</span><div><button type="button" class="link client-name-link" data-edit="${esc(c.id)}">${esc(c.name)}</button><small>${(window.hanPrivacy && hanPrivacy.html('id', c.identity)) || esc(c.identity || 'Kimlik bilgisi eklenmedi')}</small></div></div></td><td><span class="badge">${esc(c.type)}</span></td><td>${(window.hanPrivacy && hanPrivacy.html('phone', c.phone)) || esc(c.phone || '—')}<small>${(window.hanPrivacy && hanPrivacy.html(c.email ? 'email' : 'address', c.email || c.address)) || esc(c.email || c.address || '—')}</small></td><td>${esc(remote ? c.documentCount : db.docs.filter((d) => d.client === c.id).length)} evrak</td><td><button class="link" data-edit="${esc(c.id)}">Düzenle</button><button class="link" data-intake="${esc(c.id)}">＋ Evrak</button></td></tr>`,
      )
      .join('') ||
    '<tr><td colspan="5" class="empty">Müvekkil bulunamadı. Yeni bir kayıt ekleyebilirsiniz.</td></tr>';
  document.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => clientModal(b.dataset.edit)));
  document.querySelectorAll('[data-intake]').forEach(
    (b) =>
      (b.onclick = () => {
        selected = b.dataset.intake;
        page = 'intake';
        render();
      }),
  );
}

function clientModal(id, loadedRecord) {
  if (window.hanRecordsEnabled && id && !loadedRecord) return openRecordClient(id);
  let c = loadedRecord || db.clients.find((x) => x.id === id) || {};
  kind = c.type || 'Şahıs';
  $('#modal').innerHTML =
    `<form id="clientForm"><div class="panelhead"><div><h2>${id ? 'Müvekkili Düzenle' : 'Yeni Müvekkil Kaydı'}</h2><p>Kimlik, iletişim ve adres bilgileri</p></div><button class="link" type="button" id="close">✕</button></div><div class="formbody"><div class="segments">${['Şahıs', 'Şirket', 'Şahıs Şirketi'].map((t) => `<button type="button" class="${kind === t ? 'selected' : ''}" data-kind="${t}">${t}</button>`).join('')}</div><label class="field" style="margin-bottom:23px">Müvekkil Türü<select name="clientCategory" required><option value="">Müvekkil türü seçin</option>${['Mağaza', 'Yediemin', 'Diğer'].map((category) => `<option value="${category}" ${c.clientCategory === category ? 'selected' : ''}>${category}</option>`).join('')}</select></label><h3 class="sectiontitle">01 &nbsp; Müvekkil bilgileri</h3><div class="grid">${field('Ticari Unvan', 'tradeName', 'text', c.tradeName ?? (c.type && c.type !== 'Şahıs' ? c.name : ''), false).replace('<input ', '<input data-optional="true" ')}${field('Ad Soyad', 'fullName', 'text', c.fullName ?? (!c.type || c.type === 'Şahıs' ? c.name : ''), false).replace('<input ', '<input data-optional="true" ')}${field('TC Kimlik / Vergi Numarası', 'identity', 'text', c.identity)}${field('Vergi Dairesi (isteğe bağlı)', 'taxOffice', 'text', c.taxOffice).replace('<input ', '<input data-optional="true" ')}${field('MERSİS No (isteğe bağlı)', 'mersisNumber', 'text', c.mersisNumber).replace('<input ', '<input data-optional="true" ')}${field('Telefon', 'phone', 'tel', c.phone)}${field('E-posta', 'email', 'email', c.email, false, true)}${clientCityField(c)}<label class="field full">Açık Adres<textarea name="address" rows="2">${esc(c.address || '')}</textarea></label>${field('Referans', 'reference', 'text', c.reference, false, true)}${staffSelect('Evrak Alan Personel', 'documentStaff', c.documentStaff)}${staffSelect('Evrak Kaydeden *', 'recordedBy', c.recordedBy).replace('<select ', '<select required ')}${staffSelect('Tahsilat Uzmanı Personel', 'collectionStaff', c.collectionStaff).replace('<select name="collectionStaff"', '<select data-optional="true" name="collectionStaff"')}<h3 class="sectiontitle full">Banka Bilgileri</h3>${field('Banka Adı', 'bankName', 'text', c.bankName)}${field('Şube', 'bankBranch', 'text', c.bankBranch)}${field('Hesap Sahibi', 'accountHolder', 'text', c.accountHolder, false, true)}<label class="field full">IBAN (isteğe bağlı)<input name="iban" data-optional="true" type="text" value="${esc(c.iban || '')}" placeholder="TR00 0000 0000 0000 0000 0000 00" maxlength="32" autocomplete="off"></label>${clientAttachmentFields(c)}<label class="field full">Notlar<textarea name="notes" rows="2" data-optional="true">${esc(c.notes || '')}</textarea></label></div></div><div class="actions"><button type="button" class="secondary" id="cancel">Vazgeç</button><button class="primary">Müvekkili Kaydet</button></div></form>`;
  for (const name of ['email', 'iban']) {
    document.getElementById('clientForm').elements[name].dataset.optional = 'true';
  }
  const clientIbanInput = document.getElementById('clientForm').elements.iban;
  clientIbanInput.required = false;
  clientIbanInput.addEventListener('input', () => clientIbanInput.setCustomValidity(''));
  $('#clientForm').dataset.clientId = id || '';
  setupRecordFormTabs($('#clientForm'), 'client');
  syncClientCompanyFields($('#clientForm'), kind);
  if (id && ['ceo', 'admin'].includes(window.hanAuth?.role))
    setupClientStatement($('#clientForm'), id, c.name || c.tradeName || c.fullName || '');
  setupExtraContacts($('#clientForm'), c);
  setupClientBankAccounts($('#clientForm'), c);
  for (const selector of ['#clientPhotos', '#clientPowerOfAttorney']) bindMultipleFileInput($(selector));
  $('#modal').showModal();
  setupClientCity();
  setupClientDistrict();
  $('#close').onclick = $('#cancel').onclick = () => $('#modal').close();
  document.querySelectorAll('[data-kind]').forEach(
    (b) =>
      (b.onclick = () => {
        kind = b.dataset.kind;
        syncClientCompanyFields($('#clientForm'), kind);
        document.querySelectorAll('[data-kind]').forEach((a) => a.classList.toggle('selected', a === b));
      }),
  );
  $('#clientForm').onsubmit = async (e) => {
    e.preventDefault();
    let v = { ...c, ...Object.fromEntries(new FormData(e.target)) };
    Object.assign(v, readExtraContacts(e.target));
    const city = turkeyCities.find(
      (city) => city.toLocaleLowerCase('tr') === v.city.trim().toLocaleLowerCase('tr'),
    );
    if (!city) {
      $('#clientCity').setCustomValidity('Türkiye illerinden birini seçin.');
      $('#clientCity').reportValidity();
      return;
    }
    v.city = city;
    const district = (turkeyDistricts[city] || []).find(
      (name) => name.toLocaleLowerCase('tr') === v.district.trim().toLocaleLowerCase('tr'),
    );
    if (!district) {
      $('#clientDistrict').setCustomValidity('Seçili ilin ilçelerinden birini seçin.');
      $('#clientDistrict').reportValidity();
      return;
    }
    v.district = district;
    if (!v.district) return toast('İlçe bilgisini girin.');
    if (!['Mağaza', 'Yediemin', 'Diğer'].includes(v.clientCategory)) return toast('Müvekkil türünü seçin.');
    if (
      !v.recordedBy ||
      (v.recordedBy !== c.recordedBy && !personnel.some((p) => p.id === v.recordedBy && p.active))
    )
      return toast('Evrak kaydeden için kayıtlı aktif bir personel seçin.');
    v.recordedByName = personnel.find((p) => p.id === v.recordedBy)?.name || c.recordedByName || '';
    if (!validStaffSelection(v, c)) return toast('Kayıtlı ve aktif bir personel seçin.');
    v.tradeName = String(v.tradeName || '').trim();
    v.fullName = String(v.fullName || '').trim();
    v.taxOffice = String(v.taxOffice || '').trim();
    v.mersisNumber = String(v.mersisNumber || '').trim();
    v.name = kind === 'Şahıs' ? v.fullName || v.tradeName : v.tradeName || v.fullName;
    if (!v.name) return toast('Ticari unvan veya ad soyad girin.');
    const duplicate =
      !window.hanRecordsEnabled && clientDebtorIdentityConflict('client', id, v.identity, v.name);
    if (duplicate) return toast(duplicate);
    if (
      !window.hanRecordsEnabled &&
      v.identity &&
      db.clients.some((x) => x.id !== id && x.identity === v.identity)
    )
      return toast('Bu kimlik / vergi numarası zaten kayıtlı.');
    v.iban = v.iban.replace(/\s/g, '').toUpperCase();
    if (!validClientIban(v.iban)) {
      const input = e.target.elements.iban;
      input.setCustomValidity('Geçerli bir Türkiye IBAN numarası girin.');
      input.reportValidity();
      return;
    }
    try {
      v.additionalBankAccounts = e.target.readAdditionalBankAccounts();
    } catch (error) {
      return toast(error.message);
    }
    const button = e.target.querySelector('button.primary');
    if (button.disabled) return;
    button.disabled = true;
    try {
      v.attachments = await collectClientAttachments(c);
      Object.assign(v, {
        id: id || (e.target.dataset.recordId ||= crypto.randomUUID()),
        type: kind,
        createdAt: id ? c.createdAt : new Date().toISOString(),
      });
      if (window.hanRecordsEnabled) await saveRecordClient(id ? c : null, v);
      else {
        const before = db.clients.slice();
        if (id) db.clients[db.clients.findIndex((x) => x.id === id)] = v;
        else db.clients.push(v);
        try {
          save();
        } catch (error) {
          db.clients = before;
          throw error;
        }
      }
      $('#modal').close();
      render();
      toast('Müvekkil kaydı kaydedildi.');
    } catch (error) {
      toast(error.message || 'Dosyalar kaydedilemedi.');
    } finally {
      button.disabled = false;
    }
  };
}

function syncClientCompanyFields(form, type) {
  const company = ['Şirket', 'Şahıs Şirketi'].includes(type);
  for (const name of ['taxOffice', 'mersisNumber']) {
    const input = form.elements[name];
    if (!input) continue;
    input.closest('label').hidden = !company;
    input.disabled = !company;
    input.required = false;
    input.dataset.optional = 'true';
    input.removeAttribute('aria-required');
    input.setCustomValidity('');
  }
}

function validClientIban(value) {
  value = String(value || '')
    .replace(/\s/g, '')
    .toUpperCase();
  if (!String(value || '').trim()) return true;
  if (!/^TR\d{24}$/.test(value)) return false;
  const rearranged = value.slice(4) + value.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function clientAttachmentFields(c) {
  const files = Array.isArray(c.attachments) ? c.attachments : [];
  return `<section class="full" data-record-group="files"><h3 class="sectiontitle full">Fotoğraf ve PDF Ekleri</h3><label class="field full">Fotoğraf Ekle (birden fazla seçebilirsiniz)<input id="clientPhotos" type="file" accept="image/jpeg,image/png,image/webp" multiple data-optional="true"><small>JPG, PNG veya WEBP · Her dosya en fazla 2 MB</small></label><label class="field full">PDF / Vekâletname Ekle (birden fazla seçebilirsiniz)<input id="clientPowerOfAttorney" type="file" accept="application/pdf" multiple data-optional="true"><small>PDF · Her dosya en fazla 2 MB. Yeni yüklemeler mevcut dosyalara eklenir.</small></label><div class="full">${files.map((file) => `<div style="margin:12px 0">${file.kind === 'photo' && safeAttachmentUrl(file.data, 'photo') ? `<img src="${esc(safeAttachmentUrl(file.data, 'photo'))}" alt="Müvekkil fotoğrafı" style="max-width:160px;max-height:130px;object-fit:contain;border-radius:6px;display:block;margin-bottom:8px">` : ''}${attachmentDownloadLink(file.data, file.name, file.name, file.kind === 'photo' ? 'photo' : 'pdf')}<small> · ${file.kind === 'photo' ? 'Fotoğraf' : 'Vekâletname'}</small></div>`).join('') || '<p>Henüz dosya eklenmedi.</p>'}</div></section>`;
}

async function collectClientAttachments(c) {
  const photos = await readSelectedFileAttachments($('#clientPhotos'), 'photo', 2);
  const pdfs = await readSelectedFileAttachments($('#clientPowerOfAttorney'), 'pdf', 2);
  return [...(c.attachments || []), ...photos, ...pdfs];
}

function bindMultipleFileInput(input) {
  if (!input || input._attachmentQueue) return;
  input.multiple = true;
  input._attachmentQueue = [];
  const list = document.createElement('div');
  list.setAttribute('aria-live', 'polite');
  input.after(list);
  const render = () => {
    list.replaceChildren();
    for (const file of input._attachmentQueue) {
      const row = document.createElement('div'),
        remove = document.createElement('button');
      row.append(document.createTextNode(file.name + ' '));
      remove.type = 'button';
      remove.className = 'link';
      remove.textContent = 'Seçimden kaldır';
      remove.onclick = () => {
        if (input.disabled) return;
        input._attachmentQueue = input._attachmentQueue.filter((item) => item !== file);
        render();
      };
      row.append(remove);
      list.append(row);
    }
  };
  input.addEventListener('change', () => {
    for (const file of input.files) {
      if (
        !input._attachmentQueue.some(
          (old) =>
            old.name === file.name &&
            old.size === file.size &&
            old.lastModified === file.lastModified &&
            old.type === file.type,
        )
      )
        input._attachmentQueue.push(file);
    }
    input.value = '';
    render();
  });
  input.form?.addEventListener('reset', () => {
    input._attachmentQueue = [];
    render();
  });
}
async function readSelectedFileAttachments(input, kind, maxMB) {
  const files = input?._attachmentQueue || Array.from(input?.files || []);
  input._attachmentReads ||= new WeakMap();
  return Promise.all(
    files.map((file) => {
      if (file.size > maxMB * 1024 * 1024) throw Error('Her dosya en fazla ' + maxMB + ' MB olabilir.');
      const photo = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
      if (
        !(kind === 'photo'
          ? photo
          : kind === 'auto'
            ? photo || file.type === 'application/pdf'
            : file.type === 'application/pdf')
      )
        throw Error('PDF veya JPG/PNG/WEBP fotoğraf seçin.');
      if (!input._attachmentReads.has(file)) {
        const pending = new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              id: crypto.randomUUID(),
              name: file.name,
              mime: file.type,
              kind: photo ? 'photo' : 'powerOfAttorney',
              data: reader.result,
              createdAt: new Date().toISOString(),
            });
          reader.onerror = () => reject(Error('Dosya okunamadı: ' + file.name));
          reader.readAsDataURL(file);
        }).catch((error) => {
          input._attachmentReads.delete(file);
          throw error;
        });
        input._attachmentReads.set(file, pending);
      }
      return input._attachmentReads.get(file);
    }),
  );
}

function clientDebtorIdentityConflict(kind, id, value, borrowerName) {
  const identity = (v) => String(v || '').replace(/\s/g, ''),
    name = (v) =>
      String(v || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLocaleUpperCase('tr'),
    key = identity(value);
  if (!/^\d{10,11}$/.test(key)) return '';
  const conflict =
    kind === 'client'
      ? db.clients.some((c) => c.id !== id && identity(c.identity) === key) ||
        db.docs.some((d) => identity(d.identity) === key)
      : db.clients.some((c) => identity(c.identity) === key) ||
        db.docs.some(
          (d) =>
            d.id !== id &&
            identity(d.identity) === key &&
            (!name(borrowerName) || name(d.debtor) !== name(borrowerName)),
        );
  return conflict
    ? 'Bu TC kimlik / vergi numarası başka bir müvekkil veya borçluda kayıtlı. Kayıt yapılamadı.'
    : '';
}

function setupExtraContacts(form, record) {
  setupPhoneSources(form, record);
  for (const type of ['phone', 'address']) {
    if (type === 'address' && form.id === 'intakeForm') continue;
    const anchor =
      form.elements[type === 'phone' ? (form.elements.phone ? 'phone' : 'phone1') : 'address']?.closest(
        'label',
      );
    if (!anchor) continue;
    const section = document.createElement('section');
    section.className = 'full extra-contacts';
    section.dataset.extraContact = type;
    (anchor.closest('.phone-source-pair') || anchor).after(section);
    const list = document.createElement('div');
    list.className = 'grid';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'secondary';
    add.textContent = type === 'phone' ? '＋ Telefon Ekle' : '＋ Adres Ekle';
    section.append(list, add);
    function row(value = {}) {
      const box = document.createElement('div');
      box.className = 'full extra-contact-row';
      if (type === 'phone') {
        box.innerHTML =
          '<label class="field">Ek Telefon<input type="tel" data-extra="phone" data-optional="true" value="' +
          esc(value.phone || '') +
          '"></label>';
      } else {
        box.innerHTML =
          '<div class="grid"><label class="field">İl<select data-extra="city" data-optional="true"><option value="">İl seçin</option>' +
          turkeyCities
            .map(
              (city) => '<option ' + (city === value.city ? 'selected' : '') + '>' + esc(city) + '</option>',
            )
            .join('') +
          '</select></label><label class="field">İlçe<select data-extra="district" data-optional="true"></select></label><label class="field full">Ek Açık Adres<textarea data-extra="address" data-optional="true" rows="2">' +
          esc(value.address || '') +
          '</textarea></label></div>';
        const city = box.querySelector('[data-extra="city"]'),
          district = box.querySelector('[data-extra="district"]');
        function update() {
          district.innerHTML =
            '<option value="">İlçe seçin</option>' +
            (turkeyDistricts[city.value] || []).map((d) => '<option>' + esc(d) + '</option>').join('');
        }
        city.onchange = update;
        update();
        district.value = value.district || '';
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'link';
      remove.textContent = 'Kaldır';
      remove.onclick = () => box.remove();
      box.append(remove);
      list.append(box);
      if (type === 'phone') bindPhoneSource(form, box.querySelector('input[type=tel]'), record);
    }
    add.onclick = () => row();
    for (const value of record[type === 'phone' ? 'additionalPhones' : 'additionalAddresses'] || [])
      row(typeof value === 'string' ? { phone: value } : value);
    form.addEventListener('reset', () => list.replaceChildren());
  }
  if (form.id === 'intakeForm')
    HanBorrowerAddresses.setup(form, record, { cities: turkeyCities, districts: turkeyDistricts });
}

function readExtraContacts(form) {
  const values = (type) =>
    [...form.querySelectorAll('[data-extra-contact="' + type + '"] .extra-contact-row')].map((row) =>
      Object.fromEntries(
        [...row.querySelectorAll('[data-extra]')].map((el) => [el.dataset.extra, el.value.trim()]),
      ),
    );
  return {
    phoneSources: readPhoneSources(form),
    additionalPhones: values('phone')
      .map((r) => r.phone)
      .filter(Boolean),
    additionalAddresses: values('address').filter((r) => r.address || r.city || r.district),
    ...(form.id === 'intakeForm' ? HanBorrowerAddresses.read(form) : {}),
  };
}

function setupClientBankAccounts(form, record) {
  const host = document.createElement('section');
  host.className = 'full client-bank-accounts';
  const primary = document.createElement('div');
  primary.className = 'client-bank-account';
  primary.innerHTML = '<h4>Banka Hesabı 1</h4><div class="grid"></div>';
  const bankName = form.elements.bankName.closest('label');
  bankName.before(host);
  host.append(primary);
  for (const name of HanClientBanks.fields)
    primary.querySelector('.grid').append(form.elements[name].closest('label'));
  const list = document.createElement('div');
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'secondary';
  add.dataset.addClientBank = 'true';
  add.textContent = '＋ Banka Ekle';
  const status = document.createElement('small');
  status.setAttribute('role', 'status');
  host.append(list, add, status);
  function refresh() {
    const rows = [...list.children];
    rows.forEach((row, index) => (row.querySelector('h4').textContent = 'Banka Hesabı ' + (index + 2)));
    add.disabled = rows.length >= 2;
    status.textContent =
      rows.length + 1 + ' / 3 banka hesabı · Mevcut hesap dahil en fazla 3 hesap ekleyebilirsiniz.';
  }
  function row(account = {}) {
    if (list.children.length >= 2) return;
    const section = document.createElement('section');
    section.className = 'client-bank-account';
    section.dataset.clientBank = 'true';
    section.innerHTML =
      '<div class="toolbar"><h4></h4><button type="button" class="link" data-remove-client-bank>Hesabı Kaldır</button></div><div class="grid">' +
      [
        ['bankName', 'Banka Adı'],
        ['bankBranch', 'Şube'],
        ['accountHolder', 'Hesap Sahibi'],
        ['iban', 'IBAN (isteğe bağlı)'],
      ]
        .map(
          ([key, label]) =>
            '<label class="field">' +
            esc(label) +
            '<input type="text" data-bank-field="' +
            key +
            '" data-optional="true" maxlength="' +
            (key === 'iban' ? '32' : '200') +
            '" value="' +
            esc(key === 'iban' ? formatIbanNumber(account[key]) : account[key] || '') +
            '"></label>',
        )
        .join('') +
      '</div>';
    section.querySelector('[data-bank-field="iban"]').addEventListener('input', (event) => {
      event.target.value = formatIbanNumber(event.target.value);
      event.target.setCustomValidity('');
    });
    section.querySelector('[data-remove-client-bank]').onclick = () => {
      section.remove();
      refresh();
    };
    list.append(section);
    refresh();
    return section;
  }
  for (const account of record.additionalBankAccounts || []) row(account);
  add.onclick = () => row()?.querySelector('input').focus();
  form.readAdditionalBankAccounts = () =>
    HanClientBanks.additional({
      iban: form.elements.iban.value,
      additionalBankAccounts: [...list.children].map((section) =>
        Object.fromEntries(
          [...section.querySelectorAll('[data-bank-field]')].map((input) => [
            input.dataset.bankField,
            input.value,
          ]),
        ),
      ),
    });
  refresh();
}
