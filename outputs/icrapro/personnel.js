let personnelPayrollTodayMonth = '';
function isRealPersonnelRecord(record) {
  const id = String(record?.id || record?.staffId || '');
  if (['turnover:bonus', 'turnover:hukuk-reddiyat', 'turnover:temlik-reddiyat'].includes(id)) return false;
  const name = String(record?.name || record?.staffName || '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .replaceAll('ı', 'i')
    .replace(/[\s_-]+/g, '');
  return !['bonus', 'hukukreddiyat', 'temlikreddiyat'].includes(name);
}
let calculatedBonus2 = new Map(),
  bonus2Month = '';
function loadCalculatedBonus2(month) {
  bonus2Month = month || businessDate().slice(0, 7);
  const result = authApi('/api/bonus2?month=' + bonus2Month);
  result.rows = result.rows.filter(isRealPersonnelRecord);
  calculatedBonus2 = new Map(result.rows.map((r) => [r.staffId, r]));
  return result;
}
let personnel = [];
try {
  const data = JSON.parse(localStorage.getItem('icrapro-personnel-v1'));
  if (Array.isArray(data)) personnel = data;
} catch {}
function staffSelect(label, name, value = '') {
  const active = personnel.filter((p) => p.active && isRealPersonnelRecord(p));
  const current = personnel.find((p) => p.id === value);
  const unavailable =
    value && !active.some((p) => p.id === value) && isRealPersonnelRecord(current || { id: value });
  return `<label class="field">${esc(label)}<select name="${name}"><option value="">Personel seçin</option>${active.map((p) => `<option value="${esc(p.id)}" ${p.id === value ? 'selected' : ''}>${esc(p.name)}${p.title ? ' · ' + esc(p.title) : ''}</option>`).join('')}${unavailable ? `<option value="${esc(value)}" selected>${esc(current ? current.name + ' (pasif)' : value + ' (eski kayıt)')}</option>` : ''}</select><small>${active.length ? 'Kayıtlı aktif personelden seçin.' : 'Önce Ayarlar → Personel bölümünden personel ekleyin.'}</small>${unavailable ? '<small>Mevcut atama korunur; değiştirmek için aktif personel seçin.</small>' : ''}</label>`;
}
function validStaffSelection(value, previous) {
  return ['documentStaff', 'collectionStaff'].every(
    (key) =>
      !value[key] || value[key] === previous[key] || personnel.some((p) => p.id === value[key] && p.active),
  );
}
let personnelTab = 'records',
  payrollScope = 'active',
  payrollSubTab = 'salary';
async function readPersonnelAttachments(personnelId, attachmentId = '') {
  const path =
    (window.hanRecordsEnabled ? '/api/records/personnel-attachments?' : '/api/personnel-attachments?') +
    new URLSearchParams({ personnelId, ...(attachmentId ? { attachmentId } : {}) });
  if (!window.hanRecordsEnabled) return authApi(path);
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'X-Han-Request': '1' },
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Personel ekleri alınamadı.');
  return result;
}
async function personnelAttachmentsPage(host, ownerId) {
  if (!host || !['ceo', 'admin'].includes(window.hanAuth?.role)) return;

  host.innerHTML = `<div class="panel"><div class="panelhead"><div><h2>Foto ve PDF Ekle</h2><p>Bu personele ait fotoğraf ve PDF dosyalarını ekleyin veya görüntüleyin.</p></div></div><form id="personnelFilesForm" class="formbody"><div class="grid"><label class="field full">Fotoğraf / PDF Ekle<input id="personnelFilePicker" type="file" multiple data-optional="true" accept="application/pdf,image/jpeg,image/png,image/webp" ${ownerId ? '' : 'disabled'}><small>PDF, JPG, PNG veya WEBP · Her dosya en fazla 10 MB. Yeni dosyalar mevcut eklere eklenir.</small></label></div><div class="actions"><button type="submit" class="primary" ${ownerId ? '' : 'disabled'}>Seçilen Dosyaları Ekle</button></div><p role="status" data-personnel-file-status></p></form><div class="formbody" data-personnel-file-list>${ownerId ? 'Ekler yükleniyor…' : 'Ekleri görmek ve yüklemek için personel seçin.'}</div></div>`;
  const form = host.querySelector('#personnelFilesForm'),
    input = form.querySelector('#personnelFilePicker'),
    button = form.querySelector('button[type=submit]'),
    list = host.querySelector('[data-personnel-file-list]'),
    status = form.querySelector('[data-personnel-file-status]');
  bindMultipleFileInput(input);
  const pending = { id: ownerId, attachments: [] };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!ownerId || button.disabled) return;
    button.disabled = true;
    input.disabled = true;
    try {
      const files = await readSelectedFileAttachments(input, 'auto', 10);
      if (!files.length) {
        status.textContent = 'Önce fotoğraf veya PDF seçin.';
        return;
      }
      status.textContent = 'Dosyalar yükleniyor…';
      await saveRecordAttachments(
        'personnel',
        pending,
        files.filter((file) => !pending.attachments.some((old) => old.id === file.id)),
      );
      if (!list.isConnected) return;
      await personnelAttachmentsPage(host, ownerId);
      toast('Personel dosyaları eklendi.');
    } catch (error) {
      if (status.isConnected) status.textContent = error.message || 'Dosyalar yüklenemedi.';
    } finally {
      button.disabled = false;
      input.disabled = false;
    }
  };
  if (!ownerId) return;
  try {
    const result = await readPersonnelAttachments(ownerId);
    if (!list.isConnected) return;
    list.replaceChildren();
    if (!result.items.length) {
      list.textContent = 'Bu personele henüz fotoğraf veya PDF eklenmedi.';
      return;
    }
    for (const file of result.items) {
      const card = document.createElement('section'),
        name = document.createElement('h3'),
        open = document.createElement('button'),
        preview = document.createElement('div');
      name.textContent = file.name;
      open.type = 'button';
      open.className = 'secondary';
      open.textContent = 'Görüntüle / İndir';
      card.append(name, open, preview);
      list.append(card);
      open.onclick = async () => {
        if (open.disabled) return;
        open.disabled = true;
        try {
          const loaded = await readPersonnelAttachments(ownerId, file.id);
          if (!preview.isConnected) return;
          const attachment = loaded.attachment,
            url = safeAttachmentUrl(attachment.data);
          if (!url) throw Error('Dosya güvenli biçimde görüntülenemiyor.');
          const photo = url.startsWith('data:image/'),
            media = document.createElement(photo ? 'img' : 'object'),
            download = document.createElement('a');
          media.className = photo ? 'borrower-document-photo' : 'borrower-document-pdf';
          if (photo) {
            media.src = url;
            media.alt = attachment.name;
          } else {
            media.data = url;
            media.type = 'application/pdf';
          }
          download.href = url;
          download.download = attachment.name;
          download.textContent = attachment.name + ' · İndir';
          preview.replaceChildren(media, document.createElement('br'), download);
        } catch (error) {
          if (preview.isConnected) preview.textContent = error.message;
        } finally {
          open.disabled = false;
        }
      };
    }
  } catch (error) {
    if (list.isConnected) list.textContent = error.message;
  }
}

function staffMoney(p) {
  const official = Math.round(Number(p.officialSalary || 0) * 100),
    unofficial = Math.round(Number(p.unofficialSalary || 0) * 100),
    bonus = calculatedBonus2.has(p.id)
      ? calculatedBonus2.get(p.id).total
      : Math.round(Number(p.bonus || 0) * 100);
  return { official, unofficial, bonus, salary: official + unofficial, total: official + unofficial + bonus };
}
function payrollRows() {
  return personnel
    .filter(isRealPersonnelRecord)
    .filter((p) => payrollScope === 'all' || (payrollScope === 'active' ? p.active : !p.active));
}
function payrollTotals(rows) {
  return rows.reduce(
    (a, p) => {
      const v = staffMoney(p);
      for (const k of Object.keys(a)) a[k] += v[k];
      return a;
    },
    { official: 0, unofficial: 0, bonus: 0, salary: 0, total: 0 },
  );
}
async function personnelSettings(editId) {
  if (window.hanAuth?.role === 'ceo' && typeof requireCeoPin === 'function') {
    const requestedPage = page;
    $('#content').textContent = 'Güvenlik doğrulaması bekleniyor…';
    if (!(await requireCeoPin('permissions')) || page !== requestedPage) return;
  }
  const currentMonth = businessDate().slice(0, 7);
  if (personnelPayrollTodayMonth !== currentMonth) {
    personnelPayrollTodayMonth = currentMonth;
    bonus2Month = currentMonth;
    dailyBonusMonth = currentMonth;
  }
  if (!['ceo', 'admin'].includes(window.hanAuth?.role))
    return toast('Personel tanımını yalnızca yönetici yapabilir.');
  renderActiveOperator();
  loadCalculatedBonus2();
  const dailyPrimData = authApi('/api/daily-bonuses?month=' + businessDate().slice(0, 7));
  const dailyPrimTotal = (id) =>
    dailyPrimData.rows.filter((e) => e.staffId === id).reduce((sum, e) => sum + e.amount, 0);
  const staffRows = personnel.filter(isRealPersonnelRecord).sort((a, b) =>
    String(a.name || '')
      .trim()
      .localeCompare(String(b.name || '').trim(), 'tr-TR', { sensitivity: 'base' }),
  );
  const isSettings = page === 'settings';
  $('#content').innerHTML =
    `${isSettings ? settingsSectionTabs('staff') : ''}<div class="settings-tabs" role="tablist" aria-label="Personel sekmeleri"><button role="tab" aria-selected="${personnelTab === 'records'}" data-staff-view="records" class="${personnelTab === 'records' ? 'selected' : ''}">Personel Kayıtları</button><button role="tab" aria-selected="${personnelTab === 'payroll'}" data-staff-view="payroll" class="${personnelTab === 'payroll' ? 'selected' : ''}">Maaş ve Prim</button></div><div id="personnelView"></div>`;
  if (isSettings) bindSettingsSectionTabs();
  document
    .querySelector('[data-staff-view="payroll"]')
    .parentElement.insertAdjacentHTML(
      'beforeend',
      `<button type="button" role="tab" aria-selected="${personnelTab === 'ledger'}" data-staff-view="ledger" class="${personnelTab === 'ledger' ? 'selected' : ''}">Cari Hesap</button>`,
    );
  document.querySelectorAll('[data-staff-view]').forEach(
    (b) =>
      (b.onclick = () => {
        personnelTab = b.dataset.staffView;
        personnelSettings();
      }),
  );
  if (personnelTab === 'payroll') return personnelCompensationPage();
  if (personnelTab === 'ledger') return personnelLedgerPage($('#personnelView'));
  $('#personnelView').innerHTML =
    `<div class="panel"><div class="panelhead"><div><h2>Personel Kayıtları</h2><p>Bilgileri görmek ve düzenlemek için personel adına tıklayın.</p></div><div class="toolbar"><span class="badge">${staffRows.filter((p) => p.active).length} aktif / ${staffRows.length} kayıt</span><button type="button" class="primary" id="newPersonnel">Yeni Personel</button></div></div><div class="overflow"><table><thead><tr><th>AD SOYAD</th><th>BİRİM / GÖREV</th><th>TELEFON</th><th>MAAŞ + PRİM 1</th><th>PRİM 2</th><th>G. PRİM</th><th>GENEL TOPLAM</th><th>DURUM</th><th>İŞLEM</th></tr></thead><tbody>${staffRows.map((p) => `<tr><td><button type="button" class="link" data-personnel-edit="${esc(p.id)}">${esc(p.name)}</button></td><td>${esc(p.department || '—')}<small>${esc(p.title || '—')}</small></td><td>${esc(p.phone || '—')}</td><td>${money(staffMoney(p).salary / 100)}</td><td>${money(staffMoney(p).bonus / 100)}</td><td>${money(dailyPrimTotal(p.id) / 100)}</td><td>${money((staffMoney(p).total + dailyPrimTotal(p.id)) / 100)}</td><td>${p.active ? 'Aktif' : 'Pasif'}</td><td><button type="button" class="link" data-personnel-edit="${esc(p.id)}">Düzenle</button></td></tr>`).join('') || '<tr><td colspan="9" class="empty">Henüz personel yok. Yeni Personel butonuyla ekleyin.</td></tr>'}</tbody><tfoot><tr><td colspan="3"><strong>ALT TOPLAM</strong></td><td><strong>${money(staffRows.reduce((sum, p) => sum + staffMoney(p).salary, 0) / 100)}</strong></td><td><strong>${money(staffRows.reduce((sum, p) => sum + staffMoney(p).bonus, 0) / 100)}</strong></td><td><strong>${money(staffRows.reduce((sum, p) => sum + dailyPrimTotal(p.id), 0) / 100)}</strong></td><td><strong>${money(staffRows.reduce((sum, p) => sum + staffMoney(p).total + dailyPrimTotal(p.id), 0) / 100)}</strong></td><td colspan="2"></td></tr></tfoot></table></div></div>`;
  $('#newPersonnel').onclick = () => openPersonnelRecord();
  $('#personnelView')
    .querySelectorAll('[data-personnel-edit]')
    .forEach((button) => (button.onclick = () => openPersonnelRecord(button.dataset.personnelEdit)));
  if (editId) return openPersonnelRecord(editId);
}
async function openPersonnelRecord(editId) {
  if (!['ceo', 'admin'].includes(window.hanAuth?.role))
    return toast('Personel tanımını yalnızca yönetici yapabilir.');
  const requestedPage = page;
  if (window.hanAuth.role === 'ceo' && typeof requireCeoPin === 'function') {
    if (!(await requireCeoPin('permissions')) || page !== requestedPage) return;
  }
  const current = editId ? personnel.find((record) => record.id === editId) : {};
  if (!current) return toast('Personel kaydı bulunamadı.');
  let accounts;
  try {
    accounts = authApi('/api/users');
  } catch (error) {
    return toast(error.message || 'Personel giriş bilgileri alınamadı.');
  }
  const loginAccount = editId ? accounts.find((account) => account.staffId === editId) : null;
  let dialog = document.getElementById('personnelRecordDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'personnelRecordDialog';
    dialog.style.width = '900px';
    dialog.setAttribute('aria-labelledby', 'personnelRecordTitle');
    document.body.append(dialog);
  }
  dialog.innerHTML = `<div class="panelhead"><div><h2 id="personnelRecordTitle">${editId ? esc(current.name) : 'Yeni Personel'}</h2><p>Personel kayıt ve bilgileri</p></div><button type="button" class="secondary" data-personnel-close>Kapat</button></div><form id="personnelForm"><div class="formbody"><h3 class="sectiontitle">${editId ? 'Personel düzenle' : 'Yeni personel'}</h3><div class="grid">${field('Ad Soyad', 'staffName', 'text', current.name, true)}<label class="field">TC Kimlik Numarası (isteğe bağlı)<input name="identity" data-optional="true" inputmode="numeric" maxlength="11" pattern="[0-9]{11}" title="11 rakam girin" value="${esc(current.identity || '')}"></label>${field('E-posta (isteğe bağlı)', 'email', 'email', current.email).replace('<input ', '<input data-optional="true" ')}${field('Cep telefonu (isteğe bağlı)', 'mobilePhone', 'tel', current.mobilePhone ?? (/^(?:90|0)?5\d{9}$/.test(String(current.phone || '').replace(/\D/g, '')) ? current.phone : '')).replace('<input ', '<input data-optional="true" ')}${field('Telefon (isteğe bağlı)', 'phone', 'tel', current.phone).replace('<input ', '<input data-optional="true" ')}<label class="field">Birimi<select name="department"><option value="">Birim seçin</option>${['Yönetici', 'Pazarlama', 'Callcenter', 'Call Center-Y', 'Call Center-E', 'Muhasebe', 'İcra', 'Evrak Takip', 'Temlik', 'Diğer'].map((unit) => `<option value="${unit}" ${(loginAccount?.role === 'admin' ? 'Yönetici' : current.department) === unit ? 'selected' : ''}>${unit}</option>`).join('')}${current.department && !['Yönetici', 'Pazarlama', 'Callcenter', 'Call Center-Y', 'Call Center-E', 'Muhasebe', 'İcra', 'Evrak Takip', 'Temlik', 'Diğer'].includes(current.department) ? `<option value="${esc(current.department)}" selected>${esc(current.department)} (önceki kayıt)</option>` : ''}</select></label>${clientCityField(current, 'staff')}<label class="field full">Açık Adres<textarea name="address" rows="3">${esc(current.address || '')}</textarea></label></div><h3 class="sectiontitle" style="margin-top:25px">Personel Giriş Bilgileri ve Yetkileri</h3><div class="grid"><label class="field">Kullanıcı Adı<input name="loginUsername" autocomplete="off" value="${esc(loginAccount?.username || '')}" ${editId && !loginAccount ? 'data-optional="true"' : 'required'}></label><label class="field">${loginAccount ? 'Yeni Şifre (değiştirmek için doldurun)' : 'Şifre'}<input name="loginPassword" type="password" minlength="10" autocomplete="new-password" ${editId ? 'data-optional="true"' : 'required'}></label><div class="full"><p>Personel bu kullanıcı adı ve şifreyle giriş yapar. Ana sayfasında yalnızca kendi dosyalarının tahsilatını, brüt kârını ve hesaplanan primini görür.</p>${[
    ['clients', 'Müvekkil Kayıtları'],
    ['documents', 'Evrak / Borçlu Kayıtları'],
    ['cashIn', 'Muhasebe Para Girişi'],
    ['cashOut', 'Muhasebe Para Çıkışı'],
  ]
    .map(
      ([key, label]) =>
        `<label class="settings-check"><input type="checkbox" name="loginPermission" value="${key}" ${(loginAccount?.permissions || []).includes(key) ? 'checked' : ''}>${esc(label)}</label>`,
    )
    .join(
      '',
    )}</div></div><h3 class="sectiontitle">Maaş ve Prim 1</h3><div class="grid">${salaryField('Maaş *', 'officialSalary', current.officialSalary)}${salaryField('Prim 1 (isteğe bağlı)', 'unofficialSalary', current.unofficialSalary)}<label class="settings-check full"><input name="staffActive" type="checkbox" ${current.active !== false ? 'checked' : ''}> Aktif personel · Seçim listelerinde göster</label></div></div><div class="actions"><button type="button" class="secondary" id="cancelPersonnel">Vazgeç</button><button class="primary">${editId ? 'Personeli Güncelle' : 'Personel Ekle'}</button></div></form>`;
  dialog.querySelector('[data-personnel-close]').onclick = () => dialog.close();
  dialog.querySelector('#cancelPersonnel').onclick = () => dialog.close();
  const form = dialog.querySelector('#personnelForm');
  setupExtraContacts(form, current);
  setupPersonnelPhoneRelationships(form, current);
  setupPersonnelCompensationTabs(form, current, editId);
  setupPersonnelDepartmentRole(form, loginAccount, !!editId);
  setupPersonnelSalaryRequirements(form);
  if (typeof installPasswordVisibility === 'function')
    installPasswordVisibility(dialog.querySelector('#personnelForm'));
  setupClientCity('staff');
  setupClientDistrict('staff');
  form.onsubmit = (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form)),
      name = data.staffName.trim(),
      identity = data.identity.trim();
    if (!name) return toast('Personel adını girin.');
    if (
      identity &&
      (!/^\d{11}$/.test(identity) || personnel.some((p) => p.id !== editId && p.identity === identity))
    )
      return toast('TC kimlik numarası 11 rakam olmalı ve başka personelde kayıtlı olmamalıdır.');
    const city = turkeyCities.find(
      (c) => c.toLocaleLowerCase('tr') === data.city.trim().toLocaleLowerCase('tr'),
    );
    const district =
      city &&
      (turkeyDistricts[city] || []).find(
        (d) => d.toLocaleLowerCase('tr') === data.district.trim().toLocaleLowerCase('tr'),
      );
    if (!city || !district) return toast('Geçerli bir il ve o ilin ilçesini seçin.');
    if (!String(data.unofficialSalary ?? '').trim()) data.unofficialSalary = '0';
    const otherDepartment = data.department === 'Diğer';
    if (otherDepartment && !String(data.officialSalary ?? '').trim()) data.officialSalary = '0';
    const amounts = { bonus: Number(data.bonus || 0) };
    for (const key of ['officialSalary', 'unofficialSalary']) {
      if (
        data[key] == null ||
        !String(data[key]).trim() ||
        !Number.isFinite(Number(data[key])) ||
        Number(data[key]) < 0
      )
        return toast('Maaş ve Prim 1 alanlarını doldurun.');
      amounts[key] = Math.round(Number(data[key]) * 100) / 100;
    }
    if (!otherDepartment && amounts.officialSalary <= 0) return toast('Maaş sıfırdan büyük olmalıdır.');
    const next = structuredClone(personnel);
    const record = {
      ...current,
      ...readExtraContacts(form),
      createdAt: editId ? current.createdAt : new Date().toISOString(),
      id: editId || crypto.randomUUID(),
      name,
      title: current.title || '',
      identity,
      city,
      district,
      address: data.address.trim(),
      phone: data.phone.trim(),
      email: data.email.trim(),
      mobilePhone: data.mobilePhone.trim(),
      phoneRelationship: data.phoneRelationship.trim(),
      additionalPhoneRelationships: [
        ...form.querySelectorAll('[data-extra-contact="phone"] .extra-contact-row'),
      ]
        .filter((row) => row.querySelector('[data-extra="phone"]').value.trim())
        .map((row) => row.querySelector('[data-phone-relationship]').value.trim()),
      department: data.department.trim(),
      ...amounts,
      active: form.elements.staffActive.checked,
    };
    if (editId) next[next.findIndex((p) => p.id === editId)] = record;
    else next.push(record);
    try {
      authApi('/api/personnel-save', 'POST', {
        record,
        account: {
          username: data.loginUsername,
          password: data.loginPassword,
          permissions: [...form.querySelectorAll('[name="loginPermission"]:checked')].map((el) => el.value),
        },
      });
    } catch (error) {
      return toast(error.message || 'Personel kaydedilemedi.');
    }
    personnel = next;
    window.modalFormSaved?.(form);
    dialog.close();
    personnelSettings();
    toast(editId ? 'Personel bilgileri güncellendi.' : 'Personel kaydedildi.');
  };
  if (!dialog.open) dialog.showModal();
  form.elements.staffName.focus();
}
function salaryField(label, name, value) {
  return `<label class="field">${esc(label)}<input name="${name}" type="number" min="0" step="0.01" value="${esc(value ?? '')}" ${name === 'unofficialSalary' ? 'data-optional="true"' : 'required'}></label>`;
}
function setupPersonnelSalaryRequirements(form, department) {
  const controls = ['officialSalary', 'unofficialSalary'].map((name) => {
    const input = form.elements[name];
    return {
      input,
      required: input.required,
      optional: input.dataset.optional,
      label: input.closest('label')?.firstChild?.textContent,
    };
  });
  const update = () => {
    const other = (form.elements.department?.value ?? department) === 'Diğer';
    for (const { input, required, optional, label } of controls) {
      input.required = other ? false : required;
      if (other) input.dataset.optional = 'true';
      else if (optional === undefined) delete input.dataset.optional;
      else input.dataset.optional = optional;
      if (other) {
        input.removeAttribute('aria-required');
        input.setCustomValidity('');
      }
      const text = input.closest('label')?.firstChild;
      if (text?.nodeType === 3)
        text.textContent = other
          ? label.replace(/\s*\*/g, '').replace(/\s*\(isteğe bağlı\)/g, '') + ' (isteğe bağlı) '
          : label;
    }
  };
  form.elements.department?.addEventListener('change', update);
  update();
}
function payrollView() {
  loadCalculatedBonus2();
  const rows = payrollRows(),
    totals = payrollTotals(rows);
  $('#personnelView').innerHTML =
    `<div class="panel"><div class="panelhead"><div><h2>Maaş ve Prim Toplamları</h2><p>Kayıtlı tutarların kişi bazında ve genel toplamı · ${rows.length} personel</p></div><label class="field">Personel Durumu<select id="payrollScope"><option value="active" ${payrollScope === 'active' ? 'selected' : ''}>Aktif Personel</option><option value="all" ${payrollScope === 'all' ? 'selected' : ''}>Tüm Personel</option><option value="inactive" ${payrollScope === 'inactive' ? 'selected' : ''}>Pasif Personel</option></select></label></div><div class="formbody"><div class="stats">${[
      ['Maaş', totals.official],
      ['Prim 1', totals.unofficial],
      ['Toplam Maaş', totals.salary],
      ['Toplam Prim 2', totals.bonus],
      ['Genel Toplam', totals.total],
    ]
      .map(
        ([label, n]) =>
          `<div class="stat"><div><small>${esc(label)}</small><strong>${money(n / 100)}</strong></div></div>`,
      )
      .join(
        '',
      )}</div><p>Toplamlar seçilen personelin kayıtlı tutarlarını gösterir. Geçmiş ayları Geçmiş Ay Raporu bölümünden görüntüleyebilirsiniz.</p></div><div class="overflow"><table><thead><tr><th>PERSONEL / BİRİM</th><th>MAAŞ</th><th>PRİM 1</th><th>TOPLAM MAAŞ</th><th>PRİM 2</th><th>GENEL TOPLAM</th><th>İŞLEM</th></tr></thead><tbody>${
      rows
        .map((p) => {
          const v = staffMoney(p);
          return `<tr><td><strong>${esc(p.name)}</strong><small>${esc(p.department || '—')}</small></td>${['official', 'unofficial', 'salary', 'bonus', 'total'].map((k) => `<td>${money(v[k] / 100)}</td>`).join('')}<td><button type="button" class="secondary" data-edit-payroll="${esc(p.id)}">Maaş / Prim Düzenle</button></td></tr>`;
        })
        .join('') || '<tr><td colspan="6" class="empty">Bu seçimde personel yok.</td></tr>'
    }</tbody><tfoot><tr><td><strong>GENEL TOPLAM</strong></td>${['official', 'unofficial', 'salary', 'bonus', 'total'].map((k) => `<td><strong>${money(totals[k] / 100)}</strong></td>`).join('')}</tr></tfoot></table></div></div>`;
  $('#payrollScope').onchange = (e) => {
    payrollScope = e.target.value;
    payrollView();
  };
  document
    .querySelectorAll('[data-edit-payroll]')
    .forEach((b) => (b.onclick = () => editPersonnelPayroll(b.dataset.editPayroll)));
  dailyBonusSection($('#personnelView'));
}

function mandatoryControls(form) {
  return [...form.querySelectorAll('input,select,textarea')].filter(
    (el) =>
      !el.disabled &&
      el.dataset.optional !== 'true' &&
      !['checkbox', 'radio', 'hidden', 'submit', 'button', 'reset', 'search'].includes(el.type) &&
      (el.name || el.type === 'file'),
  );
}
function enforceRequired(form) {
  for (const el of form.querySelectorAll('input,textarea')) {
    const label = el.closest('label')?.firstChild?.textContent || '';
    if (
      /^(iban|account|accountNo|accountNumber|bankAccount|bankAccountNumber)$/i.test(el.name) ||
      /hesap\s*(numarası|no\b)|iban/i.test(label)
    ) {
      el.dataset.optional = 'true';
      el.required = false;
      el.removeAttribute('aria-required');
      el.setCustomValidity('');
      const text = el.closest('label')?.firstChild;
      if (text?.nodeType === 3) text.textContent = text.textContent.replace(/\s*\*/g, '');
    }
  }
  for (const el of mandatoryControls(form)) {
    if (!el.required) el.required = true;
    el.setAttribute('aria-required', 'true');
    const label = el.closest('label');
    if (label) {
      const text = label.firstChild;
      if (text?.nodeType === 3) {
        const clean = text.textContent.replace(/\s*\(isteğe bağlı\)/g, '');
        if (!clean.includes('*')) text.textContent = clean.trim() + ' * ';
      }
    }
  }
}
function validateRequiredForm(form) {
  if (form._prepareRequiredValidation && !form._prepareRequiredValidation()) return false;
  enforceRequired(form);
  for (const el of mandatoryControls(form)) {
    el.setCustomValidity('');
    if (el.type !== 'file' && !String(el.value).trim())
      el.setCustomValidity('Bu alan zorunludur. Lütfen doldurun.');
  }
  return form.reportValidity();
}
function validateSettingsDraft() {
  for (const tab of ['firm', 'contact', 'preferences']) {
    for (const [key, value] of Object.entries(settingsDraft[tab])) {
      if (typeof value === 'string' && !value.trim()) {
        settingsTab = tab;
        settings();
        toast('Tüm ayar alanları zorunludur. Eksik bilgileri tamamlayın.');
        document.getElementById('settingsForm')?.reportValidity();
        return false;
      }
    }
  }
  return true;
}
const requiredObserver = new MutationObserver(() =>
  document.querySelectorAll('form').forEach(enforceRequired),
);
requiredObserver.observe(document.body, { childList: true, subtree: true });
document.querySelectorAll('form').forEach(enforceRequired);
document.addEventListener(
  'submit',
  (event) => {
    if (event.target.tagName === 'FORM' && !validateRequiredForm(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  true,
);
document.addEventListener(
  'input',
  (event) => {
    if (typeof event.target.setCustomValidity === 'function') event.target.setCustomValidity('');
  },
  true,
);
function setupPersonnelDepartmentRole(form, account, editing) {
  function update() {
    const manager = form.elements.department.value === 'Yönetici',
      username = form.elements.loginUsername,
      password = form.elements.loginPassword;
    username.required = manager || !editing || !!account;
    username.dataset.optional = String(!username.required);
    password.required = !account && (manager || !editing || !!username.value.trim());
    password.dataset.optional = String(!password.required);
  }
  form.elements.department.addEventListener('change', update);
  form.elements.loginUsername.addEventListener('input', update);
  update();
}

let dailyBonusMonth = '';
function dailyBonusSection(host, staffId) {
  if (!['ceo', 'admin'].includes(hanAuth.role)) return;
  dailyBonusMonth = dailyBonusMonth || businessDate().slice(0, 7);
  const data = authApi('/api/daily-bonuses?month=' + dailyBonusMonth),
    rows = staffId ? data.rows.filter((e) => e.staffId === staffId) : data.rows;
  const section = document.createElement('section');
  section.className = 'panel daily-bonus-section';
  section.innerHTML =
    '<div class="panelhead"><div><h2>Günlük Prim</h2><p>Aylık toplam: <strong>' +
    money(rows.reduce((sum, e) => sum + e.amount, 0) / 100) +
    '</strong></p></div><div class="toolbar"><label class="field">Prim Ayı<input type="month" data-bonus-month data-optional="true" value="' +
    esc(dailyBonusMonth) +
    '"></label><button type="button" class="primary" data-add-daily-bonus>Günlük Prim Ekle</button></div></div><div class="overflow"><table><thead><tr><th>PERSONEL</th><th>TARİH</th><th>TUTAR</th><th>AÇIKLAMA</th></tr></thead><tbody>' +
    rows
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(
        (e) =>
          '<tr><td>' +
          esc(e.staffName) +
          '</td><td>' +
          esc(displayDate(e.date)) +
          '</td><td>' +
          money(e.amount / 100) +
          '</td><td>' +
          esc(e.note) +
          '</td></tr>',
      )
      .join('') +
    '</tbody></table></div>';
  host.append(section);
  section.querySelector('[data-bonus-month]').onchange = (e) => {
    if (!e.target.value) return;
    dailyBonusMonth = e.target.value;
    section.remove();
    dailyBonusSection(host, staffId);
  };
  section.querySelector('[data-add-daily-bonus]').onclick = () =>
    dailyBonusForm(staffId, () => {
      section.remove();
      dailyBonusSection(host, staffId);
    });
}
function dailyBonusForm(staffId, onSaved) {
  if (!['ceo', 'admin'].includes(hanAuth.role)) return;
  let dialog = document.getElementById('dailyBonusDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'dailyBonusDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML =
    '<form><div class="panelhead"><h2>Günlük Prim Ekle</h2><button type="button" class="secondary close-align-right" data-close-bonus>Kapat</button></div><div class="formbody grid"><label class="field full">Personel<select name="staffId" required><option value="">Personel seçin</option>' +
    personnel
      .filter(isRealPersonnelRecord)
      .map(
        (p) =>
          '<option value="' +
          esc(p.id) +
          '" ' +
          (p.id === staffId ? 'selected' : '') +
          '>' +
          esc(p.name) +
          '</option>',
      )
      .join('') +
    '</select></label>' +
    field('Tarih', 'date', 'date', businessDate(), true) +
    field('Tutar (TL)', 'amount', 'number', '', true) +
    '<label class="field full">Açıklama<textarea name="note" rows="3" maxlength="3000" required></textarea></label><p class="full">Bu kayıt prim hakkını kaydeder; kasadan ödeme oluşturmaz.</p></div><div class="actions"><button class="primary">Kaydet</button></div></form>';
  dialog.querySelector('[data-close-bonus]').onclick = () => dialog.close();
  dialog.querySelector('form').onsubmit = (e) => {
    e.preventDefault();
    const button = e.target.querySelector('button.primary');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const v = Object.fromEntries(new FormData(e.target));
      authApi('/api/daily-bonuses', 'POST', { ...v, amount: Math.round(Number(v.amount) * 100) });
      dailyBonusMonth = v.date.slice(0, 7);
      onSaved();
      e.target.reset();
      window.modalFormSaved?.(e.target);
      toast('Günlük prim kaydedildi.', dialog);
    } catch (error) {
      toast(error.message, dialog);
    } finally {
      button.disabled = false;
    }
  };
  dialog.showModal();
}

function editPersonnelPayroll(id) {
  const p = personnel.find((p) => p.id === id);
  if (!p || !['ceo', 'admin'].includes(hanAuth.role)) return;
  let dialog = document.getElementById('personnelPayrollDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'personnelPayrollDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML =
    '<form><div class="panelhead"><div><h2>Maaş ve Prim Düzenle</h2><p>' +
    esc(p.name) +
    '</p></div><button type="button" class="secondary" data-payroll-close>Kapat</button></div><div class="formbody grid">' +
    salaryField('Maaş', 'officialSalary', p.officialSalary) +
    salaryField('Prim 1', 'unofficialSalary', p.unofficialSalary) +
    salaryField('Prim 2', 'bonus', p.bonus) +
    '</div><div class="actions"><button class="primary">Kaydet</button></div></form>';
  const autoBonus = calculatedBonus2.get(id);
  setupPersonnelSalaryRequirements(dialog.querySelector('form'), p.department);
  if (autoBonus && !autoBonus.manual) {
    dialog.querySelector('[name="bonus"]').value = autoBonus.total / 100;
    dialog.querySelector('[name="bonus"]').readOnly = true;
  }
  dialog.querySelector('[data-payroll-close]').onclick = () => dialog.close();
  dialog.querySelector('form').onsubmit = (e) => {
    e.preventDefault();
    try {
      const v = Object.fromEntries(new FormData(e.target));
      const result = authApi('/api/personnel-payroll', 'POST', { staffId: id, ...v });
      Object.assign(p, result.record);
      personnelCompensationPage();
      window.modalFormSaved?.(e.target);
      toast('Maaş ve prim kaydedildi.', dialog);
    } catch (error) {
      toast(error.message, dialog);
    }
  };
  dialog.showModal();
}

function personnelBonus2View() {
  const data = loadCalculatedBonus2(bonus2Month || businessDate().slice(0, 7));
  $('#personnelView').innerHTML =
    '<div class="panel"><div class="panelhead"><div><h2>Prim 2</h2><p>Aylık toplam tahsilata göre otomatik hesaplanır. Kota: Callcenter 900.000 TL, Call Center-Y 1.000.000 TL. Call Center-E: 500.000 TL ve üzerinde toplam tahsilatın %4’ü.</p></div><label class="field">Ay<input type="month" data-bonus2-month data-optional="true" value="' +
    esc(data.month) +
    '"></label></div><div class="overflow"><table><thead><tr><th>PERSONEL</th><th>TAHSİLAT</th><th>ORAN</th><th>ORAN PRİMİ</th><th>EK HEDEF PRİMİ</th><th>EKİP</th><th>1–15</th><th>16–AY SONU</th><th>PRİM 2 TOPLAMI</th></tr></thead><tbody>' +
    data.rows
      .filter((r) => r.kind !== 'marketing' && r.kind !== 'other')
      .map(
        (r) =>
          '<tr><td>' +
          esc(r.name) +
          '</td><td>' +
          money((r.collected || 0) / 100) +
          '</td><td>%' +
          esc(r.rate || 0) +
          '</td>' +
          ['percentageBonus', 'targetBonus', 'teamBonus', 'firstHalfBonus', 'secondHalfBonus', 'total']
            .map((key) => '<td>' + money((r[key] || 0) / 100) + '</td>')
            .join('') +
          '</tr>',
      )
      .join('') +
    '</tbody><tfoot><tr><td colspan="8">TOPLAM</td><td>' +
    money(
      data.rows
        .filter((r) => r.kind !== 'marketing' && r.kind !== 'other')
        .reduce((sum, r) => sum + r.total, 0) / 100,
    ) +
    '</td></tr></tfoot></table></div></div>' +
    personnelOtherBonusMarkup(data) +
    personnelMarketingBonusMarkup(data);
  $('#personnelView').querySelector('[data-bonus2-month]').onchange = (e) => {
    if (e.target.value) {
      bonus2Month = e.target.value;
      personnelCompensationPage();
    }
  };
}

function personnelOtherBonusMarkup(data) {
  const rows = data.rows.filter((r) => r.kind === 'other');
  if (!rows.length) return '';
  return (
    '<section class="panel"><div class="panelhead"><div><h2>Diğer Birim · Prim 2</h2><p>Evrakı alan personelin infaza geçen dosyalarının toplam tahsilatının %12,5’i. Önceki kısmi tahsilatlar infaz ayına dahil edilir.</p></div></div><div class="overflow"><table><thead><tr><th>PERSONEL</th><th>İNFAZ ADEDİ</th><th>İNFAZ CİROSU</th><th>ORAN</th><th>PRİM 2</th></tr></thead><tbody>' +
    rows
      .map(
        (r) =>
          '<tr><td>' +
          esc(r.name) +
          '</td><td>' +
          esc(r.closedCount) +
          '</td><td>' +
          money(r.collected / 100) +
          '</td><td>%12,5</td><td><b>' +
          money(r.total / 100) +
          '</b></td></tr>',
      )
      .join('') +
    '</tbody><tfoot><tr><td colspan="4">TOPLAM</td><td><b>' +
    money(rows.reduce((sum, r) => sum + r.total, 0) / 100) +
    '</b></td></tr></tfoot></table></div></section>'
  );
}
function personnelMarketingBonusMarkup(data) {
  const rows = data.rows.filter((r) => r.kind === 'marketing');
  const sum = (key) => money(rows.reduce((total, r) => total + (r[key] || 0), 0) / 100);
  const totals = [
    'documentBonus',
    'parkingCollected',
    'parkingBonus',
    'officeTargetBonus',
    'newFirmBonus',
    'total',
  ];
  return `<section class="panel" data-marketing-bonus><div class="panelhead"><div><h2>Pazarlama Primi</h2><p>${esc(data.month)} · Ofis tahsilatı: <b>${money((rows[0]?.officeCollected || 0) / 100)}</b></p></div></div><div class="formbody"><p>200 evrağa kadar adet başına 100 TL; 201 ve üzerinde tüm evraklar 150 TL. Yediemin aylık tahsilatı en az 1.000.000 TL ise birinci 15.000 TL, ikinci 7.500 TL alır. Eşit cirolar aynı sıra primini alır.</p><p>Ofis aylık tahsilatı en az 10.000.000 TL ve personel en az 100 evrak: 7.500 TL. Yeni kazanılan firma aynı ay en az 10 evrak getirirse firma başına 2.500 TL.</p><p>Primler Prim 2 olarak bordroya ve personel carisine işlenir. Ciro, tahsil edilen toplam paradır; karma föylerin yediemin payı anapara oranında ayrılır.</p></div><div class="overflow"><table><thead><tr><th>PERSONEL</th><th>EVRAK ADEDİ</th><th>BİRİM PRİM</th><th>EVRAK PRİMİ</th><th>YEDİEMİN CİROSU</th><th>SIRA</th><th>YEDİEMİN PRİMİ</th><th>OFİS HEDEF PRİMİ</th><th>YENİ FİRMA PRİMİ</th><th>TOPLAM PRİM</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.documentCount)}</td><td>${money((r.documentRate || 0) / 100)}</td><td>${money(r.documentBonus / 100)}</td><td>${money(r.parkingCollected / 100)}</td><td>${esc(r.parkingRank || '—')}</td><td>${money(r.parkingBonus / 100)}</td><td>${money(r.officeTargetBonus / 100)}</td><td>${money(r.newFirmBonus / 100)}${r.newFirms?.length ? `<details><summary>Firma dökümü</summary>${r.newFirms.map((firm) => `<p>${esc(firm.name || 'Firma')} · ${esc(firm.documentCount)} evrak · ${money(firm.bonus / 100)}</p>`).join('')}</details>` : ''}</td><td><strong>${money(r.total / 100)}</strong></td></tr>`).join('') || '<tr><td colspan="10" class="empty">Bu ay için pazarlama personeli bulunmuyor.</td></tr>'}</tbody><tfoot><tr><td colspan="3">TOPLAM</td><td>${sum(totals[0])}</td><td>${sum(totals[1])}</td><td></td>${totals
    .slice(2)
    .map((key) => `<td><strong>${sum(key)}</strong></td>`)
    .join('')}</tr></tfoot></table></div></section>`;
}

function personnelMarketingBonusView(host) {
  const data = loadCalculatedBonus2(bonus2Month || businessDate().slice(0, 7));
  host.innerHTML =
    `<div class="panelhead"><div><h2>Pazarlama Prim Dökümü</h2><p>Aylık otomatik hesaplama · Evrakı Alan Personel esas alınır.</p></div><label class="field">Ay<input type="month" data-marketing-bonus-month data-optional="true" value="${esc(data.month)}"></label></div>` +
    personnelMarketingBonusMarkup(data);
  host.querySelector('[data-marketing-bonus-month]').onchange = (e) => {
    if (!e.target.value) return;
    bonus2Month = e.target.value;
    personnelCompensationPage();
  };
}

function personnelCompensationPage() {
  const host = $('#personnelView');
  host.innerHTML =
    '<div class="settings-tabs">' +
    [
      ['salary', 'Maaş'],
      ['bonus1', 'Prim 1'],
      ['bonus2', 'Prim 2'],
      ['marketing', 'Pazarlama Primi'],
      ['daily', 'Günlük Prim'],
      ['history', 'Geçmiş Ay Raporu'],
    ]
      .map(
        ([key, label]) =>
          '<button type="button" data-compensation-view="' +
          key +
          '" class="' +
          (key === payrollSubTab ? 'selected' : '') +
          '">' +
          label +
          '</button>',
      )
      .join('') +
    '</div><div id="compensationContent"></div>';
  const nav = host.firstElementChild,
    body = host.lastElementChild;
  host.querySelectorAll('[data-compensation-view]').forEach(
    (b) =>
      (b.onclick = () => {
        payrollSubTab = b.dataset.compensationView;
        personnelCompensationPage();
      }),
  );
  if (payrollSubTab === 'history') {
    monthlyPayrollReportPage();
    return;
  }
  if (payrollSubTab === 'daily') {
    dailyBonusSection(body);
    return;
  }
  if (payrollSubTab === 'marketing') {
    personnelMarketingBonusView(body);
    return;
  }
  if (payrollSubTab === 'bonus2') {
    personnelBonus2View();
    const content = [...host.children];
    body.append(...content);
    host.append(nav, body);
    return;
  }
  payrollView();
  const content = [...host.children];
  body.append(...content);
  host.append(nav, body);
  body.querySelector('.daily-bonus-section')?.remove();
  if (payrollSubTab === 'bonus1') body.querySelector('h2').textContent = 'Prim 1';
}
function setupPersonnelCompensationTabs(form, current, editId) {
  const body = form.querySelector('.formbody'),
    salary = form.elements.officialSalary.closest('label'),
    bonus1 = form.elements.unofficialSalary.closest('label');
  const general = document.createElement('div');
  while (body.firstChild) general.append(body.firstChild);
  general.querySelectorAll('h3').forEach((h) => {
    if (h.textContent === 'Maaş ve Prim 1') h.remove();
  });
  const payroll = document.createElement('div');
  payroll.hidden = true;
  const nav = document.createElement('div');
  nav.className = 'settings-tabs';
  nav.innerHTML =
    '<button type="button" data-personnel-section="general" class="selected">Personel Bilgileri</button><button type="button" data-personnel-section="payroll">Maaş ve Prim</button><button type="button" data-personnel-section="files">Fotoğraf / PDF Ekle ve Gör</button>';
  nav.insertAdjacentHTML(
    'beforeend',
    '<button type="button" data-personnel-section="ledger">Cari Hesap</button>',
  );
  const sub = document.createElement('div');
  sub.className = 'settings-tabs';
  payroll.append(sub);
  const panels = {};
  for (const [key, label, node] of [
    ['salary', 'Maaş ve Prim 1', salary],
    ['bonus2', 'Prim 2', null],
    ['daily', 'Günlük Prim', null],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    sub.append(button);
    const panel = document.createElement('div');
    panel.className = 'grid';
    panel.hidden = key !== 'salary';
    if (node) panel.append(node);
    if (key === 'salary') {
      panel.classList.add('personnel-salary-first');
      panel.append(bonus1);
      salary.querySelector('input').required = true;
      bonus1.querySelector('input').required = true;
    }
    if (key === 'bonus2')
      panel.innerHTML = salaryField('Prim 2', 'bonus', current.bonus || 0).replace(
        ' required',
        ' data-optional="true"',
      );
    if (key === 'daily') {
      const text = document.createElement('p');
      text.textContent =
        'Günlük primler, personel kaydedildikten sonra Maaş ve Prim → Günlük Prim bölümünden eklenir.';
      panel.append(text);
    }
    panels[key] = panel;
    payroll.append(panel);
    button.onclick = () => {
      Object.entries(panels).forEach(([k, p]) => (p.hidden = k !== key));
      sub.querySelectorAll('button').forEach((b) => b.classList.toggle('selected', b === button));
    };
    if (key === 'salary') button.classList.add('selected');
  }
  const files = document.createElement('section');
  files.hidden = true;
  form.after(files);
  const ledgerPanel = document.createElement('section');
  ledgerPanel.hidden = true;
  form.after(ledgerPanel);
  let filesLoaded = false;
  function select(section) {
    files.hidden = section !== 'files';
    ledgerPanel.hidden = section !== 'ledger';
    form.querySelector('.actions').hidden = ['files', 'ledger'].includes(section);
    if (section === 'ledger') {
      if (editId) personnelLedgerPage(ledgerPanel, editId);
      else ledgerPanel.innerHTML = '<p class="notice">Cari hesap için önce personeli kaydedin.</p>';
    }
    if (section === 'files' && !filesLoaded) {
      filesLoaded = true;
      if (editId) personnelAttachmentsPage(files, editId);
      else
        files.innerHTML =
          '<div class="formbody notice">Fotoğraf veya PDF eklemek için önce personeli kaydedin.</div>';
    }
    general.hidden = section !== 'general';
    payroll.hidden = section !== 'payroll';
    nav
      .querySelectorAll('button')
      .forEach((b) => b.classList.toggle('selected', b.dataset.personnelSection === section));
  }
  nav.querySelectorAll('button').forEach((b) => (b.onclick = () => select(b.dataset.personnelSection)));
  form.addEventListener(
    'invalid',
    (e) => {
      if (payroll.contains(e.target)) {
        select('payroll');
        for (const [key, panel] of Object.entries(panels))
          if (panel.contains(e.target)) {
            Object.values(panels).forEach((p) => (p.hidden = p !== panel));
          }
      } else select('general');
    },
    true,
  );
  body.append(nav, general, payroll);
}

function setupPersonnelPhoneRelationships(form, record) {
  function addRelationship(phoneLabel, value, primary) {
    const pair = document.createElement('div');
    pair.className = 'full personnel-phone-pair';
    phoneLabel.before(pair);
    pair.append(phoneLabel);
    const label = document.createElement('label');
    label.className = 'field';
    label.textContent = 'Yakınlık Derecesi';
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.optional = 'true';
    input.dataset.phoneRelationship = 'true';
    input.placeholder = 'Örn. Kendisi, annesi, kardeşi';
    input.value = value || '';
    if (primary) input.name = 'phoneRelationship';
    label.append(input);
    pair.append(label);
  }
  addRelationship(form.elements.phone.closest('label'), record.phoneRelationship, true);
  const section = form.querySelector('[data-extra-contact="phone"]');
  function updateRows(initial) {
    section.querySelectorAll('.extra-contact-row').forEach((row, index) => {
      if (!row.querySelector('[data-phone-relationship]')) {
        addRelationship(
          row.querySelector('label'),
          initial ? record.additionalPhoneRelationships?.[index] : '',
          false,
        );
      }
    });
  }
  updateRows(true);
  const observer = new MutationObserver(() => updateRows(false));
  observer.observe(section, { childList: true, subtree: true });
}
