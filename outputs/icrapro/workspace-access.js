function userManagement(editId) {
  let users;
  try {
    users = authApi('/api/users');
  } catch (error) {
    $('#content').textContent = error.message;
    return;
  }
  const selected = users.find((u) => u.id === editId);
  $('#content').innerHTML =
    `<div class="panel"><div class="panelhead"><div><h2>Personel Şifre Değiştirme / Sıfırlama</h2><p>Yeni hesap ve yetki işlemleri Personel bölümünden yapılır. Şifre sıfırlanınca kullanıcının açık oturumları kapatılır.</p></div></div>${selected ? `<form id="passwordResetForm"><div class="formbody grid"><p class="full"><b>${esc(selected.name)}</b> · ${esc(selected.username)}</p><label class="field">Yeni Şifre<input name="password" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></label><label class="field">Yeni Şifre Tekrar<input name="confirm" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></label></div><div class="actions"><button class="secondary" type="button" id="cancelPasswordReset">Vazgeç</button><button class="primary" type="submit">Şifreyi Sıfırla</button></div></form>` : ''}<div class="formbody"><label class="field">Personel / Kullanıcı Ara<input type="search" id="passwordUserSearch" placeholder="Ad veya kullanıcı adı…"></label></div><div class="overflow"><table><thead><tr><th>AD SOYAD</th><th>KULLANICI ADI</th><th>ROL</th><th>DURUM</th><th>ŞİFRE İŞLEMİ</th></tr></thead><tbody id="passwordUserRows"></tbody></table></div></div>`;
  $('#content').insertAdjacentHTML('afterbegin', userAuditTabs('users'));
  bindUserAuditTabs();
  const renderRows = () => {
    const query = $('#passwordUserSearch').value.trim().toLocaleLowerCase('tr');
    $('#passwordUserRows').innerHTML =
      users
        .filter((u) => normalizeSearch(u.name + ' ' + u.username).includes(normalizeSearch(query)))
        .map(
          (u) =>
            `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${u.role === 'ceo' ? 'CEO' : u.role === 'admin' ? 'Yönetici' : 'Personel'}</td><td>${u.active ? 'Aktif' : 'Pasif'}</td><td>${u.role !== 'ceo' || hanAuth.role === 'ceo' ? `<button class="link" data-reset-password="${u.id}">Şifre Değiştir / Sıfırla</button>` : 'CEO tarafından yönetilir'}</td></tr>`,
        )
        .join('') || '<tr><td colspan="5" class="empty">Kullanıcı bulunamadı.</td></tr>';
    document
      .querySelectorAll('[data-reset-password]')
      .forEach((b) => (b.onclick = () => userManagement(b.dataset.resetPassword)));
  };
  $('#passwordUserSearch').oninput = renderRows;
  renderRows();
  if (!selected) return;
  $('#cancelPasswordReset').onclick = () => userManagement();
  $('#passwordResetForm').onsubmit = (e) => {
    e.preventDefault();
    const value = Object.fromEntries(new FormData(e.target));
    if (value.password !== value.confirm) return toast('Şifreler aynı olmalıdır.');
    try {
      const result = authApi('/api/users/password', 'POST', { id: selected.id, password: value.password });
      if (result.reauthenticate) {
        hanAuth = null;
        location.reload();
        return;
      }
      userManagement();
      toast('Şifre güncellendi. Kullanıcının açık oturumları kapatıldı.');
    } catch (error) {
      toast(error.message);
    }
  };
}

function staffAccounting() {
  const canIn = hanCan('cashIn'),
    canOut = hanCan('cashOut');
  $('#content').innerHTML =
    `<div class="panel"><div class="panelhead"><h2>Muhasebe — Para Giriş / Çıkış</h2></div><div class="formbody"><p>İşlemi yapan: <b>${esc(hanAuth.name)}</b></p><form id="staffCashForm"><div class="grid"><label class="field">İşlem<select name="type">${canIn ? '<option value="in">Para Girişi</option><option value="external">Haricen Para Girişi</option>' : ''}${canOut ? '<option value="out">Para Çıkışı</option><option value="advance">Avans Çıkışı</option>' : ''}</select></label><label class="field" id="advanceTypeField" hidden>Avans Türü *<select name="advanceType" disabled required><option value="">Avans türü seçin</option><option value="T.Ç">T.Ç</option><option value="S.S">S.S</option><option value="Diğer">Diğer</option></select></label><label class="field">Kasa / Banka<select name="accountId" required>${accountOptions()}</select></label>${field('Tarih', 'date', 'date', businessDate(), true)}${field('Tutar (TL)', 'amount', 'number', '', true)}<label class="field" id="staffExternalProfitField" hidden>Kâr Seçimi<select name="profitChoice" disabled required><option value="">Seçin</option><option value="yes">Kâra Ekle</option><option value="no">Kâra Ekleme</option></select></label><label class="field" id="staffCategoryField">Gider Kalemi<select name="expenseCategory">${accountingExpenseCategories.map((x) => `<option>${x}</option>`).join('')}</select></label>${field('Açıklama', 'note', 'text', '', true, true)}</div><div class="actions"><button class="primary">Kaydet</button></div></form></div></div>`;
  const form = $('#staffCashForm');
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
    $('#staffCategoryField').hidden = !out;
    form.elements.expenseCategory.disabled = !out;
  }
  form.elements.type.onchange = toggle;
  toggle();
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
    esc(d.identity) +
    '</p><p>Telefon: ' +
    esc(d.phone1) +
    '</p><p>Adres: ' +
    esc([d.address, d.district, d.city].filter(Boolean).join(' / ')) +
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
  if (!dialog.open) dialog.showModal();
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
      )}</select></label><label class="field">${dashboardPeriod === 'year' ? 'Yıl' : dashboardPeriod === 'month' ? 'Ay' : 'Tarih'}<input id="staffDashboardDate" type="${dashboardPeriod === 'year' ? 'number' : dashboardPeriod === 'month' ? 'month' : 'date'}" value="${dashboardPeriod === 'year' ? dashboardDate.slice(0, 4) : dashboardPeriod === 'month' ? dashboardDate.slice(0, 7) : dashboardDate}" ${dashboardPeriod === 'year' ? 'min="1900" max="9999"' : ''}></label></div></div><div class="formbody"><div class="stats">${[
      ['Tahsilat Toplamım', result.collected],
      ['Brüt Kâr Toplamım', result.grossProfit],
      ['Prim 2 (' + dashboardDate.slice(0, 7) + ')', result.bonus || 0],
      ['Günlük Prim Toplamı (' + result.dailyBonusMonth + ')', result.dailyBonusTotal || 0],
      ['Prim 2 + Günlük Prim Toplamı', Number(result.bonus || 0) + Number(result.dailyBonusTotal || 0)],
    ]
      .map(
        ([title, n]) =>
          `<div class="stat"><div><small>${title}</small><strong>${money(n / 100)}</strong></div></div>`,
      )
      .join(
        '',
      )}</div><p>Callcenter / Call Center-Y Prim 2, seçilen ayın toplam tahsilatına ve birim hedeflerine göre hesaplanır.</p>${result.linked ? '' : '<p>Hesabınız henüz bir personel kaydına bağlanmamış. Yönetici bağlantıyı tamamladığında dosya toplamlarınız görünecek.</p>'}</div></div><div class="panel" style="margin-top:20px"><div class="overflow"><table><thead><tr><th>TARİH</th><th>TAHSİLAT</th><th>BRÜT KÂR</th></tr></thead><tbody>${result.rows.map((r) => `<tr><td>${displayDate(r.key)}</td><td>${money(r.collected / 100)}</td><td>${money(r.grossProfit / 100)}</td></tr>`).join('')}</tbody><tfoot><tr><td>TOPLAM</td><td>${money(result.collected / 100)}</td><td>${money(result.grossProfit / 100)}</td></tr></tfoot></table></div></div>`;
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
