async function userManagement(editId) {
  if (window.hanAuth?.role === 'ceo' && typeof requireCeoPin === 'function') {
    $('#content').textContent = 'Güvenlik doğrulaması bekleniyor…';
    if (!(await requireCeoPin('permissions')) || page !== 'users') return;
  }
  let users;
  try {
    users = authApi('/api/users');
  } catch (error) {
    $('#content').textContent = error.message;
    return;
  }
  const selected = users.find((u) => u.id === editId);
  // "Yöneticiden iste" requests and whether a new password can be sent by SMS or e-mail.
  let help = { requests: [], delivery: {} };
  try {
    const answer = authApi('/api/password-help');
    if (Array.isArray(answer?.requests)) help = answer;
  } catch {}
  const helpFor = selected && help.requests.find((request) => request.userId === selected.id);
  const deliveryOption = (value, label, ready, missing) =>
    `<option value="${value}" ${ready ? '' : 'disabled'}>${esc(label)}${ready ? '' : ' — ' + esc(missing)}</option>`;
  $('#content').innerHTML =
    `${passwordHelpPanel(help.requests)}<div class="panel"><div class="panelhead"><div><h2>Personel Şifre Değiştirme / Sıfırlama</h2><p>Yeni hesaplar Personel bölümünden açılır. Şifre sıfırlanınca kullanıcının açık oturumları kapatılır.</p></div></div>${
      selected
        ? `<form id="passwordResetForm"><div class="formbody grid"><p class="full"><b>${esc(selected.name)}</b> · ${esc(selected.username)}${helpFor ? ' · <span class="email-unverified-mark">Şifre talebi bekliyor</span>' : ''}</p><label class="field">Yeni Şifre<input name="password" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></label><label class="field">Yeni Şifre Tekrar<input name="confirm" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></label><label class="field">Yeni şifreyi kullanıcıya iletme<select name="deliver">${deliveryOption('none', 'Kendim ileteceğim (telefonla / yüz yüze)', true)}${deliveryOption(
            'sms',
            'SMS ile gönder (kayıtlı cep telefonuna)',
            help.delivery?.sms && selected.mobilePhone,
            help.delivery?.sms ? 'cep telefonu kayıtlı değil' : 'SMS açık değil',
          )}${deliveryOption(
            'email',
            'E-posta ile gönder (kayıtlı adrese)',
            help.delivery?.email && selected.email,
            help.delivery?.email ? 'e-posta kayıtlı değil' : 'e-posta gönderimi açık değil',
          )}</select></label><div class="field"><span>Güçlü şifre</span><button type="button" class="secondary" id="generatePassword">Şifre üret</button></div><p class="full" id="generatedPassword" role="status"></p><p class="full">Kimliğini doğrulamadığınız birine şifre iletmeyin. Kayıtlı telefon veya e-posta yanlışsa önce tablodaki “E-posta / Cep Telefonu” ile düzeltin.</p></div><div class="actions"><button class="secondary" type="button" id="cancelPasswordReset">Vazgeç</button><button class="primary" type="submit">Şifreyi Sıfırla</button></div></form>`
        : ''
    }<div class="formbody"><label class="field">Personel / Kullanıcı Ara<input type="search" id="passwordUserSearch" placeholder="Ad, kullanıcı adı, e-posta veya telefon…"></label></div><div class="overflow"><table><thead><tr><th>AD SOYAD</th><th>KULLANICI ADI</th><th>E-POSTA</th><th>CEP TELEFONU</th><th>ROL</th><th>DURUM</th><th>ŞİFRE İŞLEMİ</th></tr></thead><tbody id="passwordUserRows"></tbody></table></div></div>`;
  $('#content').insertAdjacentHTML('afterbegin', userAuditTabs('users'));
  bindUserAuditTabs();
  const inactiveToggle = document.createElement('label');
  inactiveToggle.className = 'settings-check';
  inactiveToggle.innerHTML = '<input type="checkbox" id="showInactiveUsers"> Pasif hesapları göster';
  $('#passwordUserSearch').closest('label').after(inactiveToggle);
  $('#showInactiveUsers').checked = selected?.active === false;
  const renderRows = () => {
    const query = $('#passwordUserSearch').value.trim().toLocaleLowerCase('tr');
    const visibleUsers = users.filter(
      (u) =>
        ($('#showInactiveUsers').checked || u.active !== false) &&
        normalizeSearch([u.name, u.username, u.email, u.mobilePhone].join(' ')).includes(
          normalizeSearch(query),
        ),
    );
    $('#passwordUserRows').innerHTML =
      visibleUsers
        .map(
          (u) =>
            `<tr><td>${esc(u.name)}${u.testAccount ? '<small class="test-record-badge">Test hesabı</small>' : ''}</td><td>${esc(u.username)}</td><td>${(window.hanPrivacy && hanPrivacy.html('email', u.email)) || esc(u.email || '—')}${u.email ? ' ' + emailVerifiedMark(u.emailVerified === true) : ''}</td><td>${((phone) => (window.hanPrivacy && hanPrivacy.html('phone', u.mobilePhone, phone)) || esc(phone || '—'))(u.mobilePhone && typeof formatPhoneNumber === 'function' ? formatPhoneNumber(u.mobilePhone) : u.mobilePhone)}</td><td>${u.role === 'ceo' ? 'CEO' : u.role === 'admin' ? 'Yönetici' : 'Personel'}</td><td>${u.active ? 'Aktif' : 'Pasif'}</td><td>${u.role !== 'ceo' || hanAuth.role === 'ceo' ? `<button class="link" data-reset-password="${esc(u.id)}">Şifre Değiştir / Sıfırla</button>` : 'CEO tarafından yönetilir'}</td></tr>`,
        )
        .join('') || '<tr><td colspan="7" class="empty">Kullanıcı bulunamadı.</td></tr>';
    document.querySelectorAll('[data-reset-password]').forEach((b) => {
      b.onclick = () => userManagement(b.dataset.resetPassword);
      const account = users.find((user) => user.id === b.dataset.resetPassword);
      if (globalThis.hanModules?.['whatsapp'] === false) return;
      const whatsapp = document.createElement('button');
      whatsapp.type = 'button';
      whatsapp.className = 'link';
      whatsapp.textContent = 'WhatsApp ve Şifre Bağlantısı';
      whatsapp.onclick = () => whatsappAccountDialog(account);
      b.after(whatsapp);
    });
    document.querySelectorAll('#passwordUserRows tr').forEach((row, index) => {
      const account = visibleUsers[index];
      if (!account) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link';
      button.textContent = 'E-posta / Cep Telefonu';
      button.onclick = () =>
        showUserContact(account, (saved) => {
          Object.assign(account, {
            email: saved.email,
            mobilePhone: saved.mobilePhone,
            emailVerified: saved.emailVerified === true,
          });
          renderRows();
        });
      row.lastElementChild.append(button);
      if (hanAuth.role === 'ceo' && account.role !== 'ceo') {
        const permissions = document.createElement('button');
        permissions.type = 'button';
        permissions.className = 'link';
        permissions.textContent = 'Yetkileri Düzenle';
        permissions.onclick = () => userPermissionsPage(account.id);
        row.lastElementChild.append(permissions);
      }
    });
  };
  $('#passwordUserSearch').oninput = renderRows;
  $('#showInactiveUsers').onchange = renderRows;
  renderRows();
  bindPasswordHelpPanel();
  if (!selected) return;
  const resetForm = $('#passwordResetForm');
  installPasswordVisibility(resetForm);
  if (selected.id === hanAuth.id) resetForm.elements.deliver.closest('label').hidden = true;
  $('#generatePassword').onclick = () => {
    const password = strongPassword();
    resetForm.elements.password.value = password;
    resetForm.elements.confirm.value = password;
    $('#generatedPassword').textContent = 'Üretilen şifre: ' + password;
  };
  $('#cancelPasswordReset').onclick = () => userManagement();
  resetForm.onsubmit = (e) => {
    e.preventDefault();
    const value = Object.fromEntries(new FormData(e.target));
    if (value.password !== value.confirm) return toast('Şifreler aynı olmalıdır.');
    try {
      const result = authApi('/api/users/password', 'POST', {
        id: selected.id,
        password: value.password,
        deliver: selected.id === hanAuth.id ? 'none' : value.deliver || 'none',
      });
      if (result.reauthenticate) {
        hanAuth = null;
        location.reload();
        return;
      }
      const sent = result.sms || result.email;
      userManagement();
      toast(
        !sent
          ? 'Şifre güncellendi. Kullanıcının açık oturumları kapatıldı; yeni şifreyi kullanıcıya iletin.'
          : sent.sent
            ? 'Şifre güncellendi ve kullanıcıya ' + (result.sms ? 'SMS' : 'e-posta') + ' ile gönderildi.'
            : 'Şifre güncellendi ama gönderilemedi: ' +
              sent.error +
              ' Yeni şifreyi kullanıcıya kendiniz iletin.',
      );
    } catch (error) {
      toast(error.message);
    }
  };
}

function userPermissionsPage(selectedId) {
  const endpoint = '/api/users/module-permissions';
  const host = $('#content');
  host.innerHTML = `${userAuditTabs('permissions')}<section class="panel" aria-labelledby="userPermissionsTitle">
    <div class="panelhead"><div><h2 id="userPermissionsTitle">Rol ve Yetkiler</h2>
      <p>Kullanıcı seçip modül bazında görüntüleme, kayıt ve ödeme yetkilerini ayarlayın.</p></div></div>
    <div class="formbody" id="userPermissionsBody"></div>
  </section>`;
  bindUserAuditTabs();
  const body = $('#userPermissionsBody');
  let data;
  try {
    data = authApi(endpoint);
  } catch (error) {
    body.textContent = error.message;
    return;
  }
  if (!data.accounts.length) {
    body.textContent = 'Yetkisi düzenlenebilecek kullanıcı yok.';
    return;
  }
  const accounts = [...data.accounts].sort(
    (a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'tr'),
  );
  body.innerHTML = `<form id="userPermissionsForm" aria-labelledby="userPermissionsTitle" method="post">
    <label class="field" for="permissionAccount">Kullanıcı</label>
    <select id="permissionAccount" name="account" required>
      <option value="">Kullanıcı seçin</option>
      ${accounts.map((account) => `<option value="${esc(account.id)}">${esc(account.name)} · ${esc(account.username)} · ${accountRoleLabel(account.role)}${account.active ? '' : ' · Pasif'}</option>`).join('')}
    </select>
    <div id="userPermissionMatrix" hidden></div>
    <p id="userPermissionsStatus" role="status"></p>
  </form>`;
  const form = $('#userPermissionsForm');
  const picker = form.elements.account;
  const matrix = $('#userPermissionMatrix');
  const status = $('#userPermissionsStatus');
  let account;
  function renderMatrix() {
    account = accounts.find((item) => item.id === picker.value);
    matrix.hidden = !account;
    status.textContent = '';
    matrix.replaceChildren();
    if (!account) return;
    matrix.innerHTML = `<p><strong>Rol</strong> ${accountRoleLabel(account.role)}${account.readOnly ? ' · Salt okunur' : ''}. Rol ataması Personel bölümünden yapılır.</p>
      <p id="userPermissionsHelp">Rol varsayılanı mevcut yetkiyi kullanır. Açık işlem, rolün erişebildiği kayıtlar için geçerlidir. Personel Cari ve Hakediş için CEO, yönetici ve muhasebe personeli varsayılan olarak görüntüleyebilir ve ödeme yapabilir. Ödeme, görüntüleme ve muhasebe yeni kayıt yetkilerinin de açık olmasını gerektirir. Yöneticilere modül bazında silme yetkisi verilebilir.</p>
      <div class="overflow" tabindex="0" role="region" aria-label="Modül işlem yetkileri"><table class="user-permissions-table" aria-describedby="userPermissionsHelp">
      <thead><tr><th scope="col">Modül</th>${Object.values(data.actions)
        .map((label) => `<th scope="col">${esc(label)}</th>`)
        .join('')}</tr></thead>
      <tbody>${Object.entries(data.modules)
        .map(
          ([module, [label, supported]]) => `<tr>
        <th scope="row">${esc(label)}</th>${Object.entries(data.actions)
          .map(([action, actionLabel]) => {
            if (!supported.includes(action)) return '<td>—</td>';
            const value = account.modulePermissions?.[module]?.[action];
            return `<td><select name="${esc(module)}.${esc(action)}" data-permission-module="${esc(module)}" data-permission-action="${esc(action)}" aria-label="${esc(label + ' · ' + actionLabel)}">
            <option value="">Rol varsayılanı</option>
            <option value="true" ${value === true ? 'selected' : ''}>Açık</option>
            <option value="false" ${value === false ? 'selected' : ''}>Kapalı</option>
          </select></td>`;
          })
          .join('')}</tr>`,
        )
        .join('')}</tbody></table></div>
      <div class="actions"><button class="primary" type="submit">Yetkileri Kaydet</button></div>`;
  }
  picker.value = selectedId || '';
  picker.onchange = renderMatrix;
  renderMatrix();
  form.onsubmit = (event) => {
    event.preventDefault();
    if (!account) return;
    const modulePermissions = {};
    for (const control of matrix.querySelectorAll('[data-permission-module]')) {
      if (!control.value) continue;
      const { permissionModule, permissionAction } = control.dataset;
      (modulePermissions[permissionModule] ||= {})[permissionAction] = control.value === 'true';
    }
    try {
      const saved = authApi(endpoint, 'PUT', {
        id: account.id,
        revision: account.revision,
        modulePermissions,
      });
      Object.assign(account, saved);
      status.textContent = 'Yetkiler kaydedildi. Kullanıcı yeni yetkileriyle tekrar giriş yapabilir.';
    } catch (error) {
      status.textContent = error.message;
    }
  };
}

// 12 characters without look-alikes (0/O, 1/l/I), easy to read out on the phone.
function strongPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}

// "Yöneticiden iste": users who could not sign in and asked for a new password.
function passwordHelpPanel(requests) {
  if (!requests?.length) return '';
  return `<section class="panel password-help-list" aria-labelledby="passwordHelpTitle"><div class="panelhead"><div><h2 id="passwordHelpTitle">Bekleyen şifre talepleri (${requests.length})</h2><p>Bu kişiler giriş yapamadığını bildirdi. Kimliğini doğrulayın, yeni şifre belirleyip iletin; şifre değişince talep kapanır.</p></div></div><div class="overflow"><table><thead><tr><th>AD SOYAD</th><th>KULLANICI ADI</th><th>TALEP ZAMANI</th><th>NOT</th><th>KAYITLI İLETİŞİM</th><th>İŞLEM</th></tr></thead><tbody>${requests
    .map(
      (request) =>
        `<tr><td>${esc(request.name)}</td><td>${esc(request.username)}</td><td>${esc(new Date(request.at).toLocaleString('tr-TR'))}</td><td class="password-help-note">${esc(request.note || '—')}</td><td>${request.mobilePhone ? ((phone) => (window.hanPrivacy && hanPrivacy.html('phone', request.mobilePhone, phone)) || esc(phone))(typeof formatPhoneNumber === 'function' ? formatPhoneNumber(request.mobilePhone) : request.mobilePhone) : 'Cep telefonu yok'}<br>${request.email ? ((window.hanPrivacy && hanPrivacy.html('email', request.email)) || esc(request.email)) + ' ' + emailVerifiedMark(request.emailVerified === true) : 'E-posta yok'}</td><td><button type="button" class="link" data-help-reset="${esc(request.userId)}">Şifre Belirle</button><button type="button" class="link" data-help-close="${esc(request.id)}">Talebi Kapat</button></td></tr>`,
    )
    .join('')}</tbody></table></div></section>`;
}
function bindPasswordHelpPanel() {
  document.querySelectorAll('[data-help-reset]').forEach((button) => {
    button.onclick = () => userManagement(button.dataset.helpReset);
  });
  document.querySelectorAll('[data-help-close]').forEach((button) => {
    button.onclick = () => {
      if (!confirm('Talep şifre belirlenmeden kapatılsın mı?')) return;
      try {
        authApi('/api/password-help/close', 'POST', { id: button.dataset.helpClose });
        userManagement();
        toast('Şifre talebi kapatıldı.');
      } catch (error) {
        toast(error.message);
      }
    };
  });
}

function staffAccounting() {
  const canIn = hanCan('cashIn'),
    canOut = hanCan('cashOut');
  $('#content').innerHTML =
    `<div class="panel"><div class="panelhead"><h2>Muhasebe — Para Giriş / Çıkış</h2></div><div class="formbody"><p>İşlemi yapan: <b>${esc(hanAuth.name)}</b></p><form id="staffCashForm"><div class="grid"><label class="field">İşlem<select name="type">${canIn ? '<option value="in">Para Girişi</option><option value="external">Haricen Para Girişi</option>' : ''}${canOut ? '<option value="out">Para Çıkışı</option><option value="advance">Avans Çıkışı</option>' : ''}</select></label><label class="field" id="advanceTypeField" hidden>Avans Türü *<select name="advanceType" disabled required><option value="">Avans türü seçin</option><option value="T.Ç">T.Ç</option><option value="S.S">S.S</option><option value="Diğer">Diğer</option></select></label><label class="field">Kasa / Banka<select name="accountId" required>${accountOptions()}</select></label>${field('Tarih', 'date', 'date', businessDate(), true)}${field('Tutar (TL)', 'amount', 'number', '', true)}<label class="field" id="staffExternalProfitField" hidden>Kâr Seçimi<select name="profitChoice" disabled required><option value="">Seçin</option><option value="yes">Kâra Ekle</option><option value="no">Kâra Ekleme</option></select></label><label class="field" id="staffCategoryField">Gider Kalemi<select name="expenseCategory">${accountingExpenseCategories.map((x) => `<option>${x}</option>`).join('')}</select></label>${field('Açıklama', 'note', 'text', '', true, true)}</div><div class="actions"><button class="primary">Kaydet</button></div></form></div></div>`;
  const form = $('#staffCashForm');
  if (canOut && typeof mountCashOutTabs === 'function') mountCashOutTabs(form, 'expense');
  if (window.hanModuleAction?.('accounting', 'create') === false) {
    form.querySelector('button.primary').disabled = true;
  }
  function toggle() {
    const advance = form.elements.type.value === 'advance';
    $('#advanceTypeField').hidden = !advance;
    form.elements.advanceType.disabled = !advance;
    form.elements.advanceType.required = advance;
    const external = form.elements.type.value === 'external';
    $('#staffExternalProfitField').hidden = !external;
    const note = form.elements.note;
    const label = note.closest('label');
    if (label?.firstChild?.nodeType === 3)
      label.firstChild.textContent = external ? 'Harici Para Girişi Açıklaması * ' : 'Açıklama / Referans * ';
    note.placeholder = external ? 'Paranın kaynağını ve giriş nedenini yazın…' : '';
    form.elements.profitChoice.disabled = !external;
    const out = form.elements.type.value === 'out';
    const tabs = form.querySelector('[data-cash-out-tabs]');
    if (tabs) tabs.hidden = !out;
    $('#staffCategoryField').hidden = !out;
    form.elements.expenseCategory.disabled = !out;
  }
  form.elements.type.onchange = toggle;
  toggle();
  if (window.hanRecordsEnabled) return bindRecordCashSubmit(form, { onSaved: staffAccounting });
  form.onsubmit = (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(form));
      data.amount = financeCents(data.amount);
      authApi('/api/cash-entry', 'POST', data);
      staffAccounting();
      toast('Para hareketi kaydedildi.');
    } catch (error) {
      toast(error.message);
    }
  };
}

function staffBorrowerDetail(id, record) {
  const d = record || db.docs.find((x) => x.id === id);
  if (!d) return;
  const dialog = document.getElementById('modal');
  dialog.innerHTML =
    '<div class="panelhead"><h2>' +
    esc(d.debtor) +
    '</h2><button class="secondary" id="closeStaffBorrower">Kapat</button></div><div class="formbody"><p>Evrak: ' +
    esc(d.number) +
    '</p><p>TC / Vergi No: ' +
    ((window.hanPrivacy && hanPrivacy.html('id', d.identity)) || esc(d.identity)) +
    '</p><p>Telefon: ' +
    ((window.hanPrivacy && hanPrivacy.html('phone', d.phone1)) || esc(d.phone1)) +
    '</p><p>Adres: ' +
    ((window.hanPrivacy &&
      hanPrivacy.html('address', [d.address, d.district, d.city].filter(Boolean).join(' / '))) ||
      esc([d.address, d.district, d.city].filter(Boolean).join(' / '))) +
    '</p><p>Dosya Sorumlusu: ' +
    esc(personnel.find((p) => p.id === d.relatedStaff)?.name || d.relatedStaffName || 'Atanmadı') +
    '</p>' +
    paymentPromiseButton(d) +
    paymentPromiseSummary(d) +
    (d.relatedStaff === hanAuth.staffId ? borrowerConversationsMarkup(d) : '') +
    '<button class="primary" id="editStaffBorrower">Bilgileri Düzenle</button></div>';
  bindPaymentPromise(d, dialog);
  if (d.relatedStaff === hanAuth.staffId) bindStaffConversation(d, dialog);
  const edit = document.getElementById('editStaffBorrower');
  if (edit) edit.hidden = !hanCan('documents') || !db.docs.some((x) => x.id === id);
  document.getElementById('closeStaffBorrower').onclick = () => dialog.close();
  document.getElementById('editStaffBorrower').onclick = () => {
    dialog.close();
    editBorrower(id);
  };
  setupBorrowerNavigation(dialog, id);
  if (typeof setupBorrowerVoip === 'function') setupBorrowerVoip(dialog, d);
  if (!dialog.open) dialog.showModal();
  if (typeof bindFolioLock === 'function') bindFolioLock(dialog, id);
}

function staffDashboard() {
  const result = authApi(
    '/api/my-dashboard?period=' + dashboardPeriod + '&date=' + encodeURIComponent(dashboardDate),
  );
  $('#content').innerHTML =
    `<div class="panel"><div class="panelhead"><div><h2>Gelir ve Tahsilat Özetim</h2><p>Yalnızca dosya sorumlusu olarak size atanmış dosyalar.</p></div><div class="toolbar"><label class="field">Görünüm<select id="staffDashboardPeriod">${[
      ['day', 'Günlük'],
      ['month', 'Aylık'],
      ['year', 'Yıllık'],
    ]
      .map(([k, t]) => `<option value="${k}" ${dashboardPeriod === k ? 'selected' : ''}>${t}</option>`)
      .join(
        '',
      )}</select></label><label class="field">${dashboardPeriod === 'year' ? 'Yıl' : dashboardPeriod === 'month' ? 'Ay' : 'Tarih'}<input id="staffDashboardDate" type="${dashboardPeriod === 'year' ? 'number' : dashboardPeriod === 'month' ? 'month' : 'date'}" value="${esc(dashboardPeriod === 'year' ? dashboardDate.slice(0, 4) : dashboardPeriod === 'month' ? dashboardDate.slice(0, 7) : dashboardDate)}" ${dashboardPeriod === 'year' ? 'min="1900" max="9999"' : ''}></label></div></div><div class="formbody"><div class="stats">${[
      ['Tahsilat Toplamım', result.collected],
      ['Brüt Kâr Toplamım', result.grossProfit],
      ['Prim 2 (' + dashboardDate.slice(0, 7) + ')', result.bonus || 0],
      ['Günlük Prim Toplamı (' + result.dailyBonusMonth + ')', result.dailyBonusTotal || 0],
      ['Prim 2 + Günlük Prim Toplamı', Number(result.bonus || 0) + Number(result.dailyBonusTotal || 0)],
    ]
      .map(
        ([title, n]) =>
          `<div class="stat"><div><small>${esc(title)}</small><strong>${money(n / 100)}</strong></div></div>`,
      )
      .join(
        '',
      )}</div><p>Callcenter / Call Center-Y Prim 2, seçilen ayın toplam tahsilatına ve birim hedeflerine göre hesaplanır.</p>${result.linked ? '' : '<p>Hesabınız henüz bir personel kaydına bağlanmamış. Yönetici bağlantıyı tamamladığında dosya toplamlarınız görünecek.</p>'}</div></div><div class="panel" style="margin-top:20px"><div class="overflow"><table><thead><tr><th>TARİH</th><th>TAHSİLAT</th><th>BRÜT KÂR</th></tr></thead><tbody>${result.rows.map((r) => `<tr><td>${esc(displayDate(r.key))}</td><td>${money(r.collected / 100)}</td><td>${money(r.grossProfit / 100)}</td></tr>`).join('')}</tbody><tfoot><tr><td>TOPLAM</td><td>${money(result.collected / 100)}</td><td>${money(result.grossProfit / 100)}</td></tr></tfoot></table></div></div>`;
  $('#staffDashboardPeriod').onchange = (e) => {
    dashboardPeriod = e.target.value;
    staffDashboard();
  };
  $('#staffDashboardDate').onchange = (e) => {
    const value = e.target.value;
    if (dashboardPeriod === 'year') {
      if (!/^\d{4}$/.test(value) || +value < 1900 || +value > 9999) return;
      dashboardDate = value + '-01-01';
    } else if (dashboardPeriod === 'month') {
      if (!/^\d{4}-\d{2}$/.test(value)) return;
      dashboardDate = value + '-01';
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
      dashboardDate = value;
    }
    staffDashboard();
  };
  loadPaymentPromisesHome();
}
