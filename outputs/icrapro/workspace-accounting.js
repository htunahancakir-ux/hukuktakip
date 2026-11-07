function activeOperator() {
  if (window.hanAuth) return { id: hanAuth.id, name: hanAuth.name, active: true };
  let id = '';
  try {
    id = sessionStorage.getItem('hanhukuk-active-operator') || '';
  } catch {}
  return personnel.find((p) => p.id === id && p.active) || null;
}

function renderActiveOperator() {
  const select = document.getElementById('activeOperator');
  if (!select) return;
  const current = activeOperator();
  select.innerHTML =
    '<option value="">Personel seçin</option>' +
    personnel
      .filter((p) => p.active)
      .map(
        (p) =>
          `<option value="${esc(p.id)}" ${current?.id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`,
      )
      .join('');
  select.onchange = () => {
    try {
      sessionStorage.setItem('hanhukuk-active-operator', select.value);
    } catch {
      toast('Personel seçimi saklanamadı.');
    }
  };
}

function filterAccountMovements(rows, accountId, filters) {
  return rows.filter(
    (e) =>
      (!accountId || e.accountId === accountId) &&
      (!filters.start || e.date >= filters.start) &&
      (!filters.end || e.date <= filters.end) &&
      (!filters.type ||
        (filters.type === 'external'
          ? e.type === 'in' && e.entryKind === 'external'
          : filters.type === 'in'
            ? e.type === 'in' && e.entryKind !== 'external'
            : e.type === filters.type)) &&
      (!filters.operator || e.operatorName === filters.operator) &&
      (!filters.category || (e.type === 'out' && e.expenseCategory === filters.category)) &&
      (!filters.query ||
        [e.note, e.label, e.operatorName, e.expenseCategory].some((v) =>
          normalizeSearch(v).includes(normalizeSearch(filters.query)),
        )),
  );
}

function saveAccounting(next) {
  try {
    localStorage.setItem('hanhukuk-accounting-v1', JSON.stringify(next));
    accounting = next;
    return true;
  } catch (error) {
    toast('Muhasebe kaydı saklanamadı. ' + (error.message || ''));
    return false;
  }
}

function accountOptions(value = '') {
  return (
    '<option value="">Hesap seçin</option>' +
    accounting.accounts
      .map((a) => `<option value="${esc(a.id)}" ${a.id === value ? 'selected' : ''}>${esc(a.name)}</option>`)
      .join('')
  );
}

function collectionAccountField(direction = 'in') {
  return `<label class="field">${direction === 'out' ? 'Paranın Çıktığı Kasa / Banka' : 'Paranın Girdiği Kasa / Banka'} *<select name="accountId" required>${accountOptions()}</select><small>Hesapları Muhasebe bölümünden ekleyebilirsiniz.</small></label>`;
}

function accountMovements() {
  const own = accounting.entries.flatMap((e) =>
    e.type === 'transfer'
      ? [
          {
            ...e,
            id: e.id + '-out',
            accountId: e.accountId,
            signed: -e.amount,
            label: 'Hesaplar arası çıkış',
          },
          {
            ...e,
            id: e.id + '-in',
            accountId: e.destination,
            signed: e.amount,
            label: 'Hesaplar arası giriş',
          },
        ]
      : [
          {
            ...e,
            signed: e.type === 'in' ? e.amount : -e.amount,
            label:
              e.type === 'in'
                ? e.entryKind === 'external'
                  ? 'Haricen para girişi (' + (e.includeInProfit ? 'kâra eklendi' : 'kâra eklenmedi') + ')'
                  : 'Para girişi'
                : e.type === 'clientPayout'
                  ? 'Müvekkile anapara ödemesi'
                  : e.type === 'advance'
                    ? 'Avans çıkışı · ' + (e.advanceType || '')
                    : 'Para çıkışı',
          },
        ],
  );
  return [
    ...own,
    ...financeEvents
      .filter(
        (e) =>
          ['payment', 'expense', 'costOnly'].includes(e.type) &&
          e.accountId &&
          !(accounting.excludedFinanceIds || []).includes(e.id),
      )
      .map((e) => ({
        ...e,
        signed: e.type === 'payment' ? e.amount : -e.amount,
        label:
          e.type === 'payment'
            ? 'Borçlu tahsilatı'
            : e.type === 'expense'
              ? 'Borçlu masrafı'
              : 'Masraf (borca eklenmedi)',
        note: (db.docs.find((d) => d.id === e.documentId)?.number || 'Evrak') + ' · ' + e.note,
      })),
  ].sort(
    (a, b) =>
      b.date.localeCompare(a.date) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  );
}

function accountBalance(id) {
  return accountMovements()
    .filter((e) => e.accountId === id)
    .reduce((sum, e) => sum + e.signed, 0);
}

function accountingPage() {
  if (window.hanAuth && !['ceo', 'admin'].includes(hanAuth.role)) return staffAccounting();
  const allRows = accountMovements(),
    rows = filterAccountMovements(allRows, accountingFilter, movementFilters),
    operators = [...new Set(allRows.map((e) => e.operatorName).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, 'tr'),
    ),
    name = (id) => accounting.accounts.find((a) => a.id === id)?.name || 'Hesap bulunamadı';
  $('#content').innerHTML =
    `<div class="panel" style="margin-bottom:22px"><div class="panelhead"><div><h2>Kasa ve Banka Hesapları</h2><p>Para girişlerini, çıkışlarını ve hangi hesapta bulunduğunu izleyin.</p></div><div class="toolbar"><button class="secondary" id="addAccount">＋ Banka / Kasa Ekle</button><button class="primary" id="addCashEntry">Para Hareketi Kaydet</button><button type="button" class="secondary" id="clientPayoutsTab">Müvekkil Ödeme</button></div></div><div class="formbody"><div class="stats">${accounting.accounts.map((a) => `<div class="stat"><div><small>${esc(a.name)} · ${a.type === 'bank' ? 'Banka' : 'Nakit'}</small><strong>${money(accountBalance(a.id) / 100)}</strong><small>${esc(a.iban || a.bank || 'Nakit kasa')}</small><button class="link" data-edit-account="${esc(a.id)}">Hesap Bilgileri</button></div></div>`).join('')}</div><p>Toplam hesap bakiyesi: <b>${money(accounting.accounts.reduce((sum, a) => sum + accountBalance(a.id), 0) / 100)}</b></p><div class="notice">Borçlu tahsilatlarını Finansal İşlemler ekranından girin; burada tekrar kaydetmeyin. Hesaplar arası transfer ciro veya kâr oluşturmaz. Bu ekran kayıt tutar, bankaya talimat göndermez.</div>${financeEvents.some((e) => e.type === 'payment' && !e.accountId) ? '<p>Hesap seçilmeden girilmiş eski tahsilatlar hesap bakiyelerine dahil değildir.</p>' : ''}</div></div><div class="panel"><div class="panelhead"><h2>Hesap Hareketleri</h2></div><details class="borrower-filter-section" id="accountingFilterSection"${document.getElementById('accountingFilterSection')?.open ? ' open' : ''}><summary>Filtre</summary><form id="movementFilterForm" class="formbody"><div class="grid"><label class="field">Hesap Adı<select id="accountingFilter" aria-label="Hesap adına göre filtrele"><option value="">Tüm Hesaplar</option>${accounting.accounts.map((a) => `<option value="${esc(a.id)}" ${accountingFilter === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label><label class="field">Başlangıç Tarihi<input type="date" name="start" data-optional="true" value="${esc(movementFilters.start)}"></label><label class="field">Bitiş Tarihi<input type="date" name="end" data-optional="true" value="${esc(movementFilters.end)}"></label><label class="field">İşlem Türü<select name="type" data-optional="true">${[
      ['', 'Tüm İşlemler'],
      ['in', 'Para Girişi'],
      ['external', 'Haricen Para Girişi'],
      ['out', 'Para Çıkışı'],
      ['advance', 'Avans Çıkışı'],
      ['payment', 'Borçlu Tahsilatı'],
      ['expense', 'Borçlu Masrafı'],
      ['costOnly', 'Borca Eklenmeyen Masraf'],
      ['transfer', 'Hesaplar Arası Transfer'],
      ['clientPayout', 'Müvekkil Ödemesi'],
    ]
      .map(
        ([key, label]) =>
          `<option value="${key}" ${movementFilters.type === key ? 'selected' : ''}>${esc(label)}</option>`,
      )
      .join(
        '',
      )}</select></label><label class="field">İşlemi Yapan Kullanıcı<select name="operator" data-optional="true"><option value="">Tüm Kullanıcılar</option>${operators.map((n) => `<option value="${esc(n)}" ${movementFilters.operator === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label><label class="field">Gider Kalemi<select name="category" data-optional="true"><option value="">Tüm Gider Kalemleri</option>${accountingExpenseCategories.map((n) => `<option value="${esc(n)}" ${movementFilters.category === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label><label class="field">Açıklama / İşlem Ara<input type="search" name="query" data-optional="true" value="${esc(movementFilters.query)}" placeholder="Açıklama, evrak no veya kullanıcı…"></label></div><div class="toolbar" style="margin-top:16px"><button class="primary" type="submit">Filtrele</button><button class="secondary" type="button" id="clearMovementFilters">Filtreleri Temizle</button></div><p>${rows.length} hareket · Net hareket: <b>${money(rows.reduce((sum, e) => sum + e.signed, 0) / 100)}</b>. Tarih aralığı başlangıç ve bitiş günlerini içerir.</p></form></details><div class="overflow"><table><thead><tr><th>TARİH</th><th>HESAP</th><th>İŞLEM</th><th>GİDER KALEMİ</th><th>İŞLEMİ YAPAN</th><th>AÇIKLAMA</th><th>GİRİŞ</th><th>ÇIKIŞ</th></tr></thead><tbody>${rows.map((e) => `<tr><td>${esc(displayDate(e.date))}</td><td>${esc(name(e.accountId))}</td><td>${esc(e.label)}</td><td>${esc(e.type === 'out' ? e.expenseCategory || 'Belirtilmedi' : '—')}</td><td>${esc(e.operatorName || 'Belirtilmedi')}</td><td>${esc(e.note)}</td><td>${e.signed > 0 ? money(e.signed / 100) : '—'}</td><td>${e.signed < 0 ? money(-e.signed / 100) : '—'}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">Henüz hesap hareketi yok.</td></tr>'}</tbody><tfoot><tr><td colspan="6"><strong>FİLTRELENEN TOPLAM</strong></td><td><strong>${money(rows.filter((e) => e.signed > 0).reduce((sum, e) => sum + e.signed, 0) / 100)}</strong></td><td><strong>${money(rows.filter((e) => e.signed < 0).reduce((sum, e) => sum - e.signed, 0) / 100)}</strong></td></tr></tfoot></table></div></div>`;
  const filterForm = $('#movementFilterForm');
  filterForm.onsubmit = (e) => {
    e.preventDefault();
    if (!filterForm.reportValidity()) return;
    const next = Object.fromEntries(new FormData(filterForm));
    if (next.start && next.end && next.start > next.end)
      return toast('Başlangıç tarihi bitiş tarihinden sonra olamaz.');
    movementFilters = next;
    accountingPage();
  };
  $('#clearMovementFilters').onclick = () => {
    accountingFilter = '';
    movementFilters = { start: '', end: '', type: '', operator: '', category: '', query: '' };
    accountingPage();
  };
  $('#addAccount').onclick = () => accountForm();
  $('#addCashEntry').onclick = cashEntryForm;
  $('#clientPayoutsTab').onclick = clientPayoutPage;
  $('#accountingFilter').onchange = (e) => {
    accountingFilter = e.target.value;
    accountingPage();
  };
  document
    .querySelectorAll('[data-edit-account]')
    .forEach((b) => (b.onclick = () => accountForm(b.dataset.editAccount)));
}

function accountForm(id) {
  const a = accounting.accounts.find((a) => a.id === id) || {};
  $('#modal').innerHTML =
    `<form id="accountForm"><div class="panelhead"><h2>${id ? 'Hesap Bilgileri' : 'Banka / Kasa Ekle'}</h2><button type="button" class="link" id="closeAccount">Kapat</button></div><div class="formbody grid"><label class="field">Hesap Türü<select name="type"><option value="cash" ${a.type === 'cash' ? 'selected' : ''}>Nakit Kasa</option><option value="bank" ${a.type !== 'cash' ? 'selected' : ''}>Banka</option></select></label>${field('Hesap Adı', 'name', 'text', a.name, true)}<div class="full grid" id="bankFields">${field('Banka Adı', 'bank', 'text', a.bank)}${field('Şube', 'branch', 'text', a.branch)}${field('Hesap Sahibi', 'holder', 'text', a.holder)}${field('IBAN', 'iban', 'text', a.iban)}</div></div><div class="actions"><button class="primary">Hesabı Kaydet</button></div></form>`;
  const form = $('#accountForm');
  function toggle() {
    const bank = form.elements.type.value === 'bank';
    $('#bankFields').hidden = !bank;
    $('#bankFields')
      .querySelectorAll('input')
      .forEach((el) => (el.disabled = !bank));
  }
  toggle();
  form.elements.type.onchange = toggle;
  $('#closeAccount').onclick = () => $('#modal').close();
  $('#modal').showModal();
  form.onsubmit = (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    v.name = v.name.trim();
    if (!v.name) return toast('Hesap adını girin.');
    if (
      accounting.accounts.some(
        (a) => a.id !== id && a.name.toLocaleLowerCase('tr') === v.name.toLocaleLowerCase('tr'),
      )
    )
      return toast('Bu hesap adı zaten kayıtlı.');
    if (v.type === 'bank') {
      v.iban = v.iban.replace(/\s/g, '').toUpperCase();
      if (!validClientIban(v.iban)) return toast('Geçerli Türkiye IBAN numarası girin.');
    }
    const next = structuredClone(accounting),
      record = { ...a, ...v, id: id || crypto.randomUUID() };
    if (id) next.accounts[next.accounts.findIndex((a) => a.id === id)] = record;
    else next.accounts.push(record);
    if (saveAccounting(next)) {
      $('#modal').close();
      accountingPage();
      toast('Hesap kaydedildi.');
    }
  };
}

function cashEntryForm() {
  $('#modal').innerHTML =
    `<form id="cashEntryForm"><div class="panelhead"><div><h2>Para Hareketi Kaydet</h2><p>İşlemi yapan: ${esc(activeOperator()?.name || 'Seçilmedi — önce üst bölümden personel seçin')}</p></div><button type="button" class="link" id="closeCashEntry">Kapat</button></div><div class="formbody grid"><label class="field">İşlem Türü<select name="type"><option value="in">Para Girişi</option><option value="external">Haricen Para Girişi</option><option value="out">Para Çıkışı</option><option value="advance">Avans Çıkışı</option><option value="transfer">Hesaplar Arası Transfer</option></select></label><label class="field" id="advanceTypeField" hidden>Avans Türü *<select name="advanceType" disabled required><option value="">Avans türü seçin</option><option value="T.Ç">T.Ç</option><option value="S.S">S.S</option><option value="Diğer">Diğer</option></select></label><label class="field full" id="externalProfitField" hidden>Kâr Seçimi<select name="profitChoice" disabled required><option value="">Seçin</option><option value="yes">Kâra Ekle</option><option value="no">Kâra Ekleme</option></select></label><label class="field full" id="expenseCategoryField" hidden>Gider Kalemi *<select name="expenseCategory" disabled><option value="">Gider kalemi seçin</option>${accountingExpenseCategories.map((category) => `<option value="${category}">${category}</option>`).join('')}</select></label><label class="field">Hesap<select name="accountId" required>${accountOptions()}</select></label><label class="field full" id="destinationField" hidden>Paranın Gireceği Hesap<select name="destination" disabled>${accountOptions()}</select></label>${field('İşlem Tarihi', 'date', 'date', businessDate(), true)}${field('Tutar (TL)', 'amount', 'number', '', true)}${field('Açıklama / Referans', 'note', 'text', '', true, true)}</div><div class="actions"><button class="primary">Hareketi Kaydet</button></div></form>`;
  const form = $('#cashEntryForm');
  form.elements.type.onchange = () => {
    const advance = form.elements.type.value === 'advance';
    $('#advanceTypeField').hidden = !advance;
    form.elements.advanceType.disabled = !advance;
    form.elements.advanceType.required = advance;
    const external = form.elements.type.value === 'external';
    $('#externalProfitField').hidden = !external;
    const note = form.elements.note;
    const label = note.closest('label');
    if (label?.firstChild?.nodeType === 3)
      label.firstChild.textContent = external ? 'Harici Para Girişi Açıklaması * ' : 'Açıklama / Referans * ';
    note.placeholder = external ? 'Paranın kaynağını ve giriş nedenini yazın…' : '';
    form.elements.profitChoice.disabled = !external;
    const transfer = form.elements.type.value === 'transfer';
    $('#destinationField').hidden = !transfer;
    form.elements.destination.disabled = !transfer;
    form.elements.destination.required = transfer;
    const out = form.elements.type.value === 'out';
    $('#expenseCategoryField').hidden = !out;
    form.elements.expenseCategory.disabled = !out;
    form.elements.expenseCategory.required = out;
  };
  $('#closeCashEntry').onclick = () => $('#modal').close();
  $('#modal').showModal();
  form.onsubmit = (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form)),
      amount = financeCents(v.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0 || !v.note.trim())
      return toast('Geçerli tutar ve açıklama girin.');
    if (!accounting.accounts.some((a) => a.id === v.accountId)) return toast('Hesap seçin.');
    if (!['in', 'external', 'out', 'advance', 'transfer'].includes(v.type)) return;
    if (v.type === 'external') {
      if (!['yes', 'no'].includes(v.profitChoice)) return toast('Kâr seçimini yapın.');
      v.type = 'in';
      v.entryKind = 'external';
      v.includeInProfit = v.profitChoice === 'yes';
    }
    delete v.profitChoice;
    if (v.type === 'advance' && !['T.Ç', 'S.S', 'Diğer'].includes(v.advanceType))
      return toast('Avans türünü seçin.');
    if (v.type !== 'advance') delete v.advanceType;
    if (v.type === 'out' && !accountingExpenseCategories.includes(v.expenseCategory))
      return toast('Para çıkışı için gider kalemi seçin.');
    if (v.type !== 'out') delete v.expenseCategory;
    if (
      v.type === 'transfer' &&
      (!accounting.accounts.some((a) => a.id === v.destination) || v.destination === v.accountId)
    )
      return toast('Transfer için farklı bir hedef hesap seçin.');
    try {
      legalDate(v.date);
    } catch {
      return toast('Geçerli tarih girin.');
    }
    if (v.date > businessDate()) return toast('Gelecek tarihe gerçekleşmiş işlem girilemez.');
    if (v.type !== 'in' && amount > accountBalance(v.accountId))
      return toast('Bu hesapta yeterli bakiye yok.');
    const operator = activeOperator();
    if (v.type !== 'in' && !operator)
      return toast('Para çıkışı için önce üst bölümden işlem yapan personeli seçin.');
    const next = structuredClone(accounting);
    next.entries.push({
      ...v,
      operatorId: operator?.id || null,
      operatorName: operator?.name || '',
      id: crypto.randomUUID(),
      amount,
      note: v.note.trim(),
      createdAt: new Date().toISOString(),
    });
    if (saveAccounting(next)) {
      $('#modal').close();
      accountingPage();
      toast('Para hareketi kaydedildi.');
    }
  };
}
