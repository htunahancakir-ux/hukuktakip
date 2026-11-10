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

function collectionAccountField(direction = 'in', { expensePool = false } = {}) {
  return `<label class="field">${direction === 'out' ? 'Paranın Çıktığı Kasa / Banka' : 'Paranın Girdiği Kasa / Banka'} *<select name="accountId" required>${accountOptions()}${expensePool ? '<option value="__expense_pool__">Masraf Avansı (Ortak Havuz)</option>' : ''}</select><small>Hesapları Muhasebe bölümünden ekleyebilirsiniz.</small></label>`;
}

function showExpensePoolFunding() {
  const dialog = $('#modal');
  dialog.innerHTML = `<form id="expensePoolFundingForm"><div class="panelhead"><div><h2>Masraf Avansı Oluştur</h2><p>Seçilen hesaptan çıkış, işlem tarihinde gider olarak kaydedilir.</p></div><button type="button" class="secondary" id="closeExpensePoolFunding">Kapat</button></div><div class="formbody grid"><label class="field">Kaynak Kasa / Banka<select name="accountId" required>${accountOptions()}</select></label>${field('İşlem Tarihi', 'date', 'date', businessDate(), true)}${field('Tutar (TL)', 'amount', 'number', '', true)}${field('Açıklama', 'note', 'text', '', true, true)}</div><div class="actions"><button class="primary" type="submit">Avansa Aktar</button></div></form>`;
  const form = document.getElementById('expensePoolFundingForm');
  const requestId = crypto.randomUUID();
  document.getElementById('closeExpensePoolFunding').onclick = () => dialog.close();
  if (!dialog.open) dialog.showModal();
  form.onsubmit = (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]');
    if (button.disabled) return;
    const values = Object.fromEntries(new FormData(form));
    values.amount = financeCents(values.amount);
    values.id = requestId;
    button.disabled = true;
    try {
      authApi('/api/expense-pool/fund', 'POST', values);
      if (!window.hanRecordsEnabled) accounting = authApi('/api/data?key=hanhukuk-accounting-v1');
      dialog.close();
      accountingPage();
      toast('Masraf avansı kaydedildi.');
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  };
}

function expensePoolHistory() {
  let data;
  try {
    data = authApi('/api/expense-pool');
  } catch (error) {
    return toast(error.message);
  }
  const accounts = new Map(accounting.accounts.map((account) => [account.id, account.name]));
  const balances = new Map();
  let running = 0;
  const chronological = data.movements
    .slice()
    .sort(
      (a, b) =>
        String(a.date).localeCompare(String(b.date)) ||
        (a.kind === 'fund' ? 0 : 1) - (b.kind === 'fund' ? 0 : 1) ||
        String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
        String(a.id).localeCompare(String(b.id)),
    );
  for (const row of chronological) {
    running += row.kind === 'fund' ? row.amount : -row.amount;
    balances.set(row, running);
  }
  const dialog = $('#modal');
  dialog.classList.add('expense-pool-dialog');
  dialog.addEventListener('close', () => dialog.classList.remove('expense-pool-dialog'), { once: true });
  dialog.innerHTML = `<div class="panelhead"><div><h2>Masraf Avansı Hareketleri</h2><p>Ortak havuz ve dosyalara yapılan dağıtımlar</p></div><button type="button" class="secondary" id="closeExpensePoolHistory">Kapat</button></div><div class="expense-pool-body"><div class="expense-pool-summary"><div><small>Toplam avans</small><strong>${money(data.funded / 100)}</strong></div><div><small>Dağıtılan</small><strong>${money(data.allocated / 100)}</strong></div><div><small>Kalan</small><strong>${money(data.balance / 100)}</strong></div></div><form id="expensePoolFilter" class="expense-pool-filters"><label class="field">Başlangıç Tarihi<input type="date" name="from"></label><label class="field">Bitiş Tarihi<input type="date" name="to"></label><button type="submit" class="primary">Filtrele</button><button type="button" class="secondary" id="clearExpensePoolDates">Temizle</button></form><p role="status" id="expensePoolFilterStatus" class="expense-pool-status"></p><div class="overflow expense-pool-scroll"><table class="expense-pool-table"><thead><tr><th>TARİH</th><th>İŞLEM</th><th>KASA / DOSYA</th><th>PERSONEL</th><th>AÇIKLAMA</th><th>GİREN</th><th>ÇIKAN</th><th>KALAN</th></tr></thead><tbody></tbody></table></div><div class="expense-pool-pagination"><span id="expensePoolPageInfo" aria-live="polite"></span><div><button type="button" class="secondary" id="expensePoolPrev">Önceki</button><button type="button" class="secondary" id="expensePoolNext">Sonraki</button></div></div></div>`;
  const filter = document.getElementById('expensePoolFilter');
  const tbody = dialog.querySelector('tbody');
  const status = document.getElementById('expensePoolFilterStatus');
  const prev = document.getElementById('expensePoolPrev');
  const next = document.getElementById('expensePoolNext');
  let filtered = data.movements.slice(),
    pageIndex = 0;
  const pageSize = 50;
  const renderPage = () => {
    const start = pageIndex * pageSize;
    const page = filtered.slice(start, start + pageSize);
    tbody.innerHTML =
      page
        .map(
          (row) =>
            `<tr class="${row.kind === 'fund' ? 'expense-pool-in' : 'expense-pool-out'}"><td>${esc(displayDate(row.date))}</td><td>${row.kind === 'fund' ? 'Avans Girişi' : row.type === 'expense' ? 'Borca Eklenen Masraf' : 'Borca Eklenmeyen Masraf'}</td><td>${esc(row.kind === 'fund' ? accounts.get(row.accountId) || 'Hesap' : row.documentNumber || 'Dosya')}</td><td>${esc(row.operatorName || '—')}</td><td>${esc(row.note || '—')}</td><td>${row.kind === 'fund' ? money(row.amount / 100) : '—'}</td><td>${row.kind === 'fund' ? '—' : money(row.amount / 100)}</td><td>${money(balances.get(row) / 100)}</td></tr>`,
        )
        .join('') || '<tr><td colspan="8" class="empty">Bu aralıkta hareket bulunamadı.</td></tr>';
    document.getElementById('expensePoolPageInfo').textContent = filtered.length
      ? start + 1 + '–' + (start + page.length) + ' / ' + filtered.length + ' hareket'
      : '0 hareket';
    prev.disabled = pageIndex === 0;
    next.disabled = start + pageSize >= filtered.length;
  };
  filter.onsubmit = (event) => {
    event.preventDefault();
    const from = filter.elements.from.value,
      to = filter.elements.to.value;
    if (from && to && from > to) {
      status.textContent = 'Başlangıç tarihi bitiş tarihinden sonra olamaz.';
      return;
    }
    filtered = data.movements.filter((row) => (!from || row.date >= from) && (!to || row.date <= to));
    pageIndex = 0;
    status.textContent = 'Üstteki toplamlar tüm tarihleri kapsar.';
    renderPage();
  };
  document.getElementById('clearExpensePoolDates').onclick = () => {
    filter.reset();
    filter.requestSubmit();
  };
  prev.onclick = () => {
    if (pageIndex > 0) {
      pageIndex--;
      renderPage();
    }
  };
  next.onclick = () => {
    if ((pageIndex + 1) * pageSize < filtered.length) {
      pageIndex++;
      renderPage();
    }
  };
  document.getElementById('closeExpensePoolHistory').onclick = () => dialog.close();
  renderPage();
  if (!dialog.open) dialog.showModal();
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
  if (window.hanRecordsEnabled && !window.hanWorkspaceComplete) {
    const value = Number(window.hanAccountBalances?.[id]);
    if (!Number.isSafeInteger(value)) throw Error('Hesap bakiyesi doğrulanamadı. Dosyayı yeniden açın.');
    return value;
  }
  return accountMovements()
    .filter((e) => e.accountId === id)
    .reduce((sum, e) => sum + e.signed, 0);
}

function accountLedgerRows(rows) {
  const balances = new Map();
  const ordered = rows
    .slice()
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
        String(a.id || '').localeCompare(String(b.id || '')),
    );
  for (const row of ordered) {
    const value = (balances.get(row.accountId) || 0n) + BigInt(row.signed);
    balances.set(row.accountId, value);
    row.balance = String(value);
  }
  return ordered.reverse();
}

let accountingScrollToLedger = false;
function accountingPage(remote) {
  if (!Array.isArray(remote?.items) || !remote?.totals) remote = null;
  if (window.hanAuth && !(['ceo', 'admin'].includes(hanAuth.role) || hanAuth.accountingAccess === true))
    return staffAccounting();
  if (window.hanRecordsEnabled && !remote) return loadRecordAccounting();
  const allRows = remote ? [] : accountLedgerRows(accountMovements()),
    rows = remote ? remote.items : filterAccountMovements(allRows, accountingFilter, movementFilters),
    operators = remote
      ? remote.operators
      : [...new Set(allRows.map((e) => e.operatorName).filter(Boolean))].sort((a, b) =>
          a.localeCompare(b, 'tr'),
        ),
    amount = (value) => (remote ? recordMoney(value) : money(Number(value) / 100)),
    balance = (id) => (remote ? remote.balances[id] : accountBalance(id)),
    totals = remote
      ? remote.totals
      : {
          count: rows.length,
          net: rows.reduce((s, e) => s + e.signed, 0),
          incoming: rows.filter((e) => e.signed > 0).reduce((s, e) => s + e.signed, 0),
          outgoing: rows.filter((e) => e.signed < 0).reduce((s, e) => s - e.signed, 0),
        },
    name = (id) => accounting.accounts.find((a) => a.id === id)?.name || 'Hesap bulunamadı';
  const summary = (id) => {
    if (remote) return remote.accountSummaries?.[id] || { incoming: '0', outgoing: '0' };
    const movements = allRows.filter((e) => e.accountId === id);
    return {
      incoming: movements.reduce((sum, e) => sum + (e.signed > 0 ? BigInt(e.signed) : 0n), 0n),
      outgoing: movements.reduce((sum, e) => sum + (e.signed < 0 ? -BigInt(e.signed) : 0n), 0n),
    };
  };
  const accountTable = `<div class="overflow"><table class="account-summary"><thead><tr><th>KASA / BANKA CARİ HESABI</th><th>TÜR</th><th>GİREN</th><th>ÇIKAN</th><th>KALAN BAKİYE</th><th>İŞLEMLER</th></tr></thead><tbody>${accounting.accounts
    .map((a) => {
      const s = summary(a.id);
      return `<tr><td><button type="button" class="link" data-account-ledger="${esc(a.id)}" data-account-name><strong>${esc(a.name)}</strong></button><small>${esc(a.iban || a.bank || 'Nakit kasa')}</small></td><td>${a.type === 'bank' ? 'Banka' : 'Kasa'}</td><td style="color:#15803d;white-space:nowrap">${amount(s.incoming)}</td><td style="color:#b91c1c;white-space:nowrap">${amount(s.outgoing)}</td><td style="white-space:nowrap"><strong>${amount(balance(a.id))}</strong></td><td><button type="button" class="link" data-account-ledger="${esc(a.id)}">Cari Hareketler</button><button type="button" class="link" data-edit-account="${esc(a.id)}">Hesap Bilgileri</button></td></tr>`;
    })
    .join('')}</tbody></table></div>`;
  $('#content').innerHTML =
    `<div class="panel" style="margin-bottom:22px"><div class="panelhead"><div><h2>Kasa ve Banka Cari Hesapları</h2><p>Para girişlerini, çıkışlarını ve hangi hesapta bulunduğunu izleyin.</p></div><div class="toolbar"><button class="secondary" id="addAccount">＋ Banka / Kasa Ekle</button><button class="primary" id="addCashEntry">Para Hareketi Kaydet</button><button type="button" class="secondary" id="clientPayoutsTab">Müvekkil Ödeme</button></div></div><div class="formbody">${accountTable}<p class="notice">Cari hesap özetleri tüm kayıtları kapsar. Hareketler en yeniden eskiye sıralanır; kalan sütunu ilgili işlemin sonrasındaki hesap bakiyesidir.</p><p>Toplam hesap bakiyesi: <b>${amount(accounting.accounts.reduce((sum, a) => sum + BigInt(balance(a.id)), 0n))}</b></p><div class="notice">Borçlu tahsilatlarını Finansal İşlemler ekranından girin; burada tekrar kaydetmeyin. Hesaplar arası transfer ciro veya kâr oluşturmaz. Bu ekran kayıt tutar, bankaya talimat göndermez.</div>${(remote ? remote.unassigned : financeEvents.some((e) => e.type === 'payment' && !e.accountId)) ? '<p>Hesap seçilmeden girilmiş eski tahsilatlar hesap bakiyelerine dahil değildir.</p>' : ''}</div></div><div class="panel"><div class="panelhead"><h2>${accountingFilter ? esc(name(accountingFilter)) + ' · Cari Hesap Hareketleri' : 'Cari Hesap Hareketleri'}</h2></div><details class="borrower-filter-section" id="accountingFilterSection"${document.getElementById('accountingFilterSection')?.open ? ' open' : ''}><summary>Filtre</summary><form id="movementFilterForm" class="formbody"><div class="grid"><label class="field">Hesap Adı<select id="accountingFilter" aria-label="Hesap adına göre filtrele"><option value="">Tüm Hesaplar</option>${accounting.accounts.map((a) => `<option value="${esc(a.id)}" ${accountingFilter === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label><label class="field">Başlangıç Tarihi<input type="date" name="start" data-optional="true" value="${esc(movementFilters.start)}"></label><label class="field">Bitiş Tarihi<input type="date" name="end" data-optional="true" value="${esc(movementFilters.end)}"></label><label class="field">İşlem Türü<select name="type" data-optional="true">${[
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
      )}</select></label><label class="field">İşlemi Yapan Kullanıcı<input name="operator" list="accountingOperators" data-optional="true" value="${esc(movementFilters.operator)}" placeholder="Tüm kullanıcılar"><datalist id="accountingOperators">${operators.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist></label><label class="field">Gider Kalemi<select name="category" data-optional="true"><option value="">Tüm Gider Kalemleri</option>${accountingExpenseCategories.map((n) => `<option value="${esc(n)}" ${movementFilters.category === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label><label class="field">Açıklama / İşlem Ara<input type="search" name="query" data-optional="true" value="${esc(movementFilters.query)}" placeholder="Açıklama, evrak no veya kullanıcı…"></label></div><div class="toolbar" style="margin-top:16px"><button class="primary" type="submit">Filtrele</button><button class="secondary" type="button" id="clearMovementFilters">Filtreleri Temizle</button></div><p>${esc(totals.count)} hareket · Net hareket: <b>${amount(totals.net)}</b>. Tarih aralığı başlangıç ve bitiş günlerini içerir.</p></form></details><div class="overflow"><table class="account-ledger"><thead><tr><th>TARİH</th><th>HESAP</th><th>İŞLEM</th><th>GİDER KALEMİ</th><th>İŞLEMİ YAPAN</th><th>AÇIKLAMA</th><th>GİREN</th><th>ÇIKAN</th><th>KALAN</th></tr></thead><tbody>${rows.map((e) => `<tr><td>${esc(displayDate(e.date))}</td><td>${esc(name(e.accountId))}</td><td>${esc(e.label)}</td><td>${esc(e.type === 'out' ? e.expenseCategory || 'Belirtilmedi' : '—')}</td><td>${esc(e.operatorName || 'Belirtilmedi')}</td><td>${esc(e.note)}</td><td>${e.signed > 0 ? amount(e.signed) : '—'}</td><td>${e.signed < 0 ? amount(-BigInt(e.signed)) : '—'}</td><td style="white-space:nowrap"><strong>${e.balance !== undefined ? amount(e.balance) : '—'}</strong></td></tr>`).join('') || '<tr><td colspan="9" class="empty">Henüz hesap hareketi yok.</td></tr>'}</tbody><tfoot><tr><td colspan="6"><strong>FİLTRELENEN TOPLAM</strong></td><td><strong>${amount(totals.incoming)}</strong></td><td><strong>${amount(totals.outgoing)}</strong></td><td>—</td></tr></tfoot></table></div></div>`;
  const poolPanel = document.createElement('div');
  poolPanel.className = 'panel formbody';
  poolPanel.style.marginBottom = '22px';
  try {
    const pool = authApi('/api/expense-pool');
    poolPanel.innerHTML = `<div class="panelhead"><div><h2>Ortak Masraf Avansı</h2><p>Kasa çıkışı gider olarak kaydedilir; dosyalara dağıtım ikinci bir gider oluşturmaz.</p></div><div class="toolbar"><button type="button" class="primary" id="fundExpensePool">Masraf Avansı Oluştur</button><button type="button" class="secondary" id="expensePoolHistory">Avans Hareketleri</button></div></div><p>Toplam avans: <b>${money(pool.funded / 100)}</b> · Dağıtılan: <b>${money(pool.allocated / 100)}</b> · Kalan: <b>${money(pool.balance / 100)}</b></p>`;
    document.getElementById('content').prepend(poolPanel);
    document.getElementById('fundExpensePool').onclick = showExpensePoolFunding;
    document.getElementById('expensePoolHistory').onclick = expensePoolHistory;
  } catch (error) {
    poolPanel.textContent = 'Masraf avansı bilgileri alınamadı: ' + error.message;
    document.getElementById('content').prepend(poolPanel);
  }
  if (remote) bindAccountingPagination(remote);
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
  document.querySelectorAll('[data-account-ledger]').forEach((button) => {
    button.onclick = () => {
      accountingScrollToLedger = true;
      accountingFilter = button.dataset.accountLedger;
      movementFilters = { start: '', end: '', type: '', operator: '', category: '', query: '' };
      accountingPage();
    };
  });
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
  if (accountingScrollToLedger) {
    accountingScrollToLedger = false;
    const ledger = document.querySelector('.account-ledger')?.closest('.panel');
    if (ledger) {
      ledger.style.scrollMarginTop = '90px';
      ledger.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }
  }
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
  if (window.hanRecordsEnabled)
    return bindRecordCashSubmit(form, { dialog: $('#modal'), onSaved: accountingPage });
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
