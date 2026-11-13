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
  dialog.innerHTML = `<form id="expensePoolFundingForm"><div class="panelhead"><div><h2>Masraf Avansı Oluştur</h2><p>Seçilen hesaptan çıkış, işlem tarihinde gider olarak kaydedilir.</p></div><button type="button" class="secondary" id="closeExpensePoolFunding">Kapat</button></div><div class="formbody grid"><label class="field">Kaynak Kasa / Banka<select name="accountId" required>${accountOptions(typeof accountingFilter === 'string' ? accountingFilter : '')}</select></label>${field('İşlem Tarihi', 'date', 'date', businessDate(), true)}${field('Tutar (TL)', 'amount', 'number', '', true)}${field('Açıklama', 'note', 'text', '', true, true)}</div><div class="actions"><button class="primary" type="submit">Avansa Aktar</button></div></form>`;
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
      accountingAlertsAt = 0;
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

let accountingScrollToLedger = false,
  accountingAlertsCache = null,
  accountingAlertsAt = 0;

// Quick actions: one visible button and one keyboard shortcut per kind of money movement.
function accountingActions() {
  return [
    {
      id: 'addCashEntry',
      tone: 'in',
      icon: '↓',
      label: 'Para Girişi',
      code: 'KeyG',
      tip: 'Tahsilat: dosyaya bağlı olmayan para girişi. Haricen giriş de buradan yapılır.',
      run: () => cashEntryForm('in'),
    },
    {
      id: 'accCashOut',
      tone: 'out',
      icon: '↑',
      label: 'Para Çıkışı',
      code: 'KeyC',
      tip: 'Ödeme: gider kalemi seçilerek kasadan veya bankadan çıkan para.',
      run: () => cashEntryForm('out'),
    },
    {
      id: 'accDebtorPayment',
      tone: 'collection',
      icon: '₺',
      label: 'Borçlu Tahsilatı',
      code: 'KeyB',
      tip: 'Dosyayı seçin; tahsilat dosyanın kendi finansal işlemlerine işlenir.',
      run: accountingDebtorPayment,
    },
    {
      id: 'fundExpensePool',
      tone: 'pool',
      icon: '◔',
      label: 'Masraf Avansı',
      code: 'KeyM',
      tip: 'Dosya masrafları için ortak havuza aktarım. Kasa çıkışı gider sayılır.',
      run: showExpensePoolFunding,
    },
    {
      id: 'accAdvance',
      tone: 'advance',
      icon: '◑',
      label: 'Avans Çıkışı',
      code: 'KeyA',
      tip: 'T.Ç / S.S / Diğer avans ödemesi. Kasadan düşer, gider sayılmaz.',
      run: () => cashEntryForm('advance'),
    },
    {
      id: 'accTransfer',
      tone: 'transfer',
      icon: '⇄',
      label: 'Hesaplar Arası Transfer',
      code: 'KeyT',
      tip: 'Bir hesaptan diğerine aktarım. Ciro veya kâr oluşturmaz.',
      run: () => cashEntryForm('transfer'),
    },
  ];
}

function accountingShortcut(event) {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (typeof page === 'undefined' || page !== 'accounting' || document.querySelector('dialog[open]')) return;
  const button = document.querySelector('#content .acc-action[data-code="' + event.code + '"]');
  if (!button) return;
  event.preventDefault();
  button.click();
}

function accountingTone(value) {
  const cents = BigInt(value || 0);
  return cents > 0n ? 'acc-pos' : cents < 0n ? 'acc-neg' : 'acc-zero';
}

function accountingBadge(e) {
  const tone = /^Hesaplar arası/.test(e.label || '')
    ? 'transfer'
    : e.type === 'advance'
      ? 'advance'
      : e.type === 'clientPayout'
        ? 'payout'
        : e.type === 'payment'
          ? 'collection'
          : ['expense', 'costOnly'].includes(e.type)
            ? 'cost'
            : BigInt(e.signed || 0) > 0n
              ? 'in'
              : 'out';
  return `<span class="acc-badge acc-badge--${tone}">${esc(e.label)}</span>`;
}

function renderAccountingAlerts() {
  const host = document.getElementById('accStatus');
  if (!host) return;
  const data = accountingAlertsCache,
    pool = data?.pool,
    overdue = data?.overdue,
    manager = !window.hanAuth || ['ceo', 'admin'].includes(hanAuth.role),
    cents = (value) => money(Number(value || 0) / 100),
    alerts = [];
  let poolTone = '';
  if (pool && pool.funded > 0 && pool.balance <= 0) {
    poolTone = 'acc-neg';
    alerts.push('<span class="acc-alert acc-alert--danger">Masraf avansı tükendi</span>');
  } else if (pool && pool.funded > 0 && pool.balance <= pool.threshold) {
    poolTone = 'acc-warn';
    alerts.push(
      `<span class="acc-alert acc-alert--warn">Masraf avansı azaldı · Kalan ${esc(cents(pool.balance))}</span>`,
    );
  }
  if (overdue?.count)
    alerts.push(
      `<button type="button" class="acc-alert acc-alert--danger" id="accOverdue" data-tip="${esc(overdue.installments + ' taksit · ' + overdue.promises + ' ödeme sözü. Listeyi açmak için tıklayın.')}">Vadesi geçen ${esc(overdue.count)} ödeme · ${esc(cents(overdue.remaining))}</button>`,
    );
  host.innerHTML = `${alerts.length ? `<div class="acc-alerts">${alerts.join('')}</div>` : ''}<div class="acc-pool"><span class="acc-pool-title">Masraf avansı havuzu</span>${
    pool
      ? `<span>Toplam <b>${esc(cents(pool.funded))}</b></span><span>Dağıtılan <b>${esc(cents(pool.allocated))}</b></span><span>Kalan <b class="${poolTone || accountingTone(pool.balance)}">${esc(cents(pool.balance))}</b></span>`
      : ''
  }<button type="button" class="link" id="expensePoolHistory">Avans Hareketleri</button>${
    pool && manager
      ? `<button type="button" class="link" id="accPoolThreshold">Uyarı eşiği: ${esc(cents(pool.threshold))}</button>`
      : ''
  }</div>`;
  document.getElementById('expensePoolHistory').onclick = expensePoolHistory;
  const threshold = document.getElementById('accPoolThreshold');
  if (threshold) threshold.onclick = accountingPoolThresholdForm;
  const overdueButton = document.getElementById('accOverdue');
  if (overdueButton) overdueButton.onclick = accountingOverdueList;
}

async function loadAccountingAlerts(force) {
  if (typeof fetch !== 'function' || (!force && Date.now() - accountingAlertsAt < 30000)) return;
  accountingAlertsAt = Date.now();
  try {
    const response = await fetch('/api/accounting/alerts', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-Han-Request': '1' },
    });
    const data = await response.json();
    if (!response.ok || !data?.pool || !data?.overdue) return;
    accountingAlertsCache = data;
    renderAccountingAlerts();
  } catch {}
}

function accountingOverdueList() {
  const rows = accountingAlertsCache?.overdue?.rows || [],
    total = accountingAlertsCache?.overdue?.count || 0,
    dialog = $('#modal');
  dialog.classList.add('expense-pool-dialog');
  dialog.addEventListener('close', () => dialog.classList.remove('expense-pool-dialog'), { once: true });
  dialog.innerHTML = `<div class="panelhead"><div><h2>Vadesi Geçen Ödemeler</h2><p>Vadesi bugünden önce olan, ödenmemiş taksitler ve ödeme sözleri. İnfaz ve iade dosyaları dahil değildir.</p></div><button type="button" class="secondary" id="closeAccOverdue">Kapat</button></div><div class="expense-pool-body"><div class="overflow expense-pool-scroll"><table class="acc-overdue-table"><thead><tr><th>VADE</th><th>TÜR</th><th>DOSYA</th><th>BORÇLU</th><th>SORUMLU</th><th>KALAN</th></tr></thead><tbody>${
    rows
      .map(
        (row) =>
          `<tr><td>${esc(displayDate(row.due))}</td><td>${row.kind === 'installment' ? esc(row.sequence + '. taksit') : 'Ödeme sözü'}</td><td><button type="button" class="link" data-overdue-document="${esc(row.documentId)}">${esc(row.number || 'Dosya')}</button></td><td>${esc(row.debtor || '—')}</td><td>${esc(row.staffName || '—')}</td><td class="acc-num acc-neg">${esc(money(row.remaining / 100))}</td></tr>`,
      )
      .join('') || '<tr><td colspan="6" class="empty">Vadesi geçen ödeme yok.</td></tr>'
  }</tbody></table></div>${total > rows.length ? `<p class="expense-pool-status">İlk ${esc(rows.length)} kayıt gösteriliyor; toplam ${esc(total)}.</p>` : ''}</div>`;
  document.getElementById('closeAccOverdue').onclick = () => dialog.close();
  dialog.querySelectorAll('[data-overdue-document]').forEach((button) => {
    button.onclick = () => openPromiseBorrower(button.dataset.overdueDocument);
  });
  if (!dialog.open) dialog.showModal();
}

function accountingPoolThresholdForm() {
  const dialog = $('#modal'),
    current = accountingAlertsCache?.pool?.threshold ?? 500000;
  dialog.innerHTML = `<form id="accPoolThresholdForm"><div class="panelhead"><div><h2>Masraf Avansı Uyarı Eşiği</h2><p>Havuzda kalan tutar bu eşiğe indiğinde muhasebe ekranında turuncu uyarı çıkar.</p></div><button type="button" class="link" id="closeAccThreshold">Kapat</button></div><div class="formbody grid">${field('Uyarı Eşiği (TL)', 'amount', 'number', current / 100, true, true)}</div><div class="actions"><button class="primary">Eşiği Kaydet</button></div></form>`;
  const form = document.getElementById('accPoolThresholdForm');
  document.getElementById('closeAccThreshold').onclick = () => dialog.close();
  if (!dialog.open) dialog.showModal();
  form.onsubmit = (event) => {
    event.preventDefault();
    const cents = financeCents(form.elements.amount.value);
    if (!Number.isSafeInteger(cents) || cents <= 0) return toast('Geçerli bir tutar girin.');
    const next = structuredClone(config);
    next.preferences = { ...next.preferences, expensePoolWarningCents: cents };
    try {
      localStorage.setItem('icrapro-settings-v1', JSON.stringify(next));
    } catch (error) {
      return toast('Uyarı eşiği saklanamadı. ' + (error.message || ''));
    }
    config = next;
    if (accountingAlertsCache?.pool) accountingAlertsCache.pool.threshold = cents;
    dialog.close();
    renderAccountingAlerts();
    loadAccountingAlerts(true);
    toast('Uyarı eşiği kaydedildi.');
  };
}

// Debtor collections belong to the file: pick the file here, then use its own collection form.
function accountingDebtorPayment() {
  const dialog = $('#modal');
  dialog.innerHTML = `<form id="accDocumentPicker"><div class="panelhead"><div><h2>Borçlu Tahsilatı</h2><p>Tahsilatı işleyeceğiniz dosyayı seçin.</p></div><button type="button" class="link" id="closeAccPicker">Kapat</button></div><div class="formbody"><label class="field full">Dosya Ara<input type="search" name="q" data-optional="true" autocomplete="off" placeholder="Dosya no, borçlu adı veya TC / vergi no…"></label><div class="acc-picker-results" id="accPickerResults" aria-live="polite"><p class="empty">Aramak için en az 2 karakter yazın.</p></div></div></form>`;
  const form = document.getElementById('accDocumentPicker'),
    input = form.elements.q,
    results = document.getElementById('accPickerResults');
  let timer,
    controller,
    items = [];
  const message = (text) => {
    items = [];
    results.innerHTML = `<p class="empty">${esc(text)}</p>`;
  };
  const pick = (id) => {
    const open = () => {
      if (!db.docs.some((doc) => doc.id === id)) return toast('Dosya açılamadı.');
      financialOperations(id, 'payment');
      dialog.addEventListener(
        'close',
        () => {
          if (typeof page !== 'undefined' && page === 'accounting') {
            accountingAlertsAt = 0;
            accountingPage();
          }
        },
        { once: true },
      );
    };
    return window.hanRecordsEnabled ? recordAction(id, open) : open();
  };
  const search = async (query) => {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    message('Aranıyor…');
    try {
      const response = await fetch(
        (window.hanRecordsEnabled ? '/api/records/search' : '/api/search') +
          '?q=' +
          encodeURIComponent(query),
        {
          signal: request.signal,
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { 'X-Han-Request': '1' },
        },
      );
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Arama tamamlanamadı. Yeniden deneyin.');
      if (request.signal.aborted || input.value.trim() !== query) return;
      items = (data.items || []).filter((item) => item.type === 'document');
      if (!items.length) return message('Eşleşen dosya bulunamadı.');
      results.innerHTML = items
        .map(
          (item) =>
            `<button type="button" class="acc-picker-result" data-pick="${esc(item.id)}"><strong>${esc(item.label)}</strong>${item.detail ? `<small>${esc(item.detail)}</small>` : ''}</button>`,
        )
        .join('');
    } catch (error) {
      if (!request.signal.aborted) message(error.message);
    }
  };
  input.oninput = () => {
    clearTimeout(timer);
    controller?.abort();
    const query = input.value.trim();
    if (query.length < 2) return message('Aramak için en az 2 karakter yazın.');
    timer = setTimeout(() => search(query), 220);
  };
  results.onclick = (event) => {
    const button = event.target.closest('[data-pick]');
    if (button) pick(button.dataset.pick);
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    if (items.length) pick(items[0].id);
  };
  document.getElementById('closeAccPicker').onclick = () => dialog.close();
  if (!dialog.open) dialog.showModal();
  input.focus();
}

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
  const accountsScroll = document.querySelector('.acc-accounts-scroll')?.scrollTop || 0,
    totalBalance = accounting.accounts.reduce((sum, a) => sum + BigInt(balance(a.id)), 0n),
    unassigned = remote ? remote.unassigned : financeEvents.some((e) => e.type === 'payment' && !e.accountId);
  const actionBar = `<div class="acc-actions" role="toolbar" aria-label="Hızlı işlemler"><div class="acc-actions-main">${accountingActions()
    .map(
      (a) =>
        `<button type="button" class="acc-action acc-action--${a.tone}" id="${a.id}" data-code="${a.code}" data-tip="${esc(a.tip + ' Kısayol: Alt+' + a.code.slice(3))}" aria-keyshortcuts="Alt+${a.code.slice(3)}"><span class="acc-action-icon" aria-hidden="true">${a.icon}</span><span class="acc-action-label">${esc(a.label)}</span><kbd>Alt+${a.code.slice(3)}</kbd></button>`,
    )
    .join(
      '',
    )}</div><button type="button" class="acc-action acc-action--payout" id="clientPayoutsTab" data-tip="Müvekkile yapılan anapara ödemeleri ve hakediş listesi."><span class="acc-action-icon" aria-hidden="true">→</span><span class="acc-action-label">Müvekkil Ödeme</span></button></div></div><div class="acc-status" id="accStatus"></div>`;
  const accountTable = `<div class="overflow acc-accounts-scroll"><table class="account-summary"><thead><tr><th>KASA / BANKA HESABI</th><th>TÜR</th><th class="acc-num">GİREN</th><th class="acc-num">ÇIKAN</th><th class="acc-num">BAKİYE</th><th></th></tr></thead><tbody>${accounting.accounts
    .map((a) => {
      const s = summary(a.id),
        selected = accountingFilter === a.id,
        value = balance(a.id);
      return `<tr${selected ? ' class="selected" aria-current="true"' : ''}><td><button type="button" class="link" data-account-ledger="${esc(a.id)}" data-account-name><strong>${esc(a.name)}</strong></button><small>${(a.iban && window.hanPrivacy && hanPrivacy.html('iban', a.iban)) || esc(a.iban || a.bank || 'Nakit kasa')}</small></td><td>${a.type === 'bank' ? 'Banka' : 'Kasa'}</td><td class="acc-num acc-pos">${amount(s.incoming)}</td><td class="acc-num acc-neg">${amount(s.outgoing)}</td><td class="acc-num ${accountingTone(value)}"><strong>${amount(value)}</strong></td><td class="acc-row-actions"><button type="button" class="link" data-edit-account="${esc(a.id)}">Hesap Bilgileri</button></td></tr>`;
    })
    .join('')}</tbody></table></div>`;
  $('#content').innerHTML =
    `${actionBar}<div class="panel acc-accounts"><div class="panelhead"><div><h2>Kasa ve Banka Hesapları</h2><p>Hareketlerini görmek için hesabı seçin.</p></div><div class="acc-head-side"><span class="acc-total">Toplam bakiye <b class="${accountingTone(totalBalance)}">${amount(totalBalance)}</b></span><button type="button" class="link" data-account-ledger=""${accountingFilter ? '' : ' hidden'}>Tüm Hesaplar</button><button type="button" class="secondary acc-small" id="addAccount">＋ Banka / Kasa Ekle</button></div></div>${accountTable}</div><div class="panel acc-ledger"><div class="panelhead"><div><h2>${accountingFilter ? esc(name(accountingFilter)) + ' · Cari Hesap Hareketleri' : 'Cari Hesap Hareketleri'}</h2><p>${esc(totals.count)} hareket</p></div><div class="acc-head-side"><span class="acc-chip-total">Giren <b class="acc-pos">${amount(totals.incoming)}</b></span><span class="acc-chip-total">Çıkan <b class="acc-neg">${amount(totals.outgoing)}</b></span><span class="acc-chip-total">Net <b class="${accountingTone(totals.net)}">${amount(totals.net)}</b></span></div></div><details class="borrower-filter-section" id="accountingFilterSection"${document.getElementById('accountingFilterSection')?.open ? ' open' : ''}><summary>Filtre</summary><form id="movementFilterForm" class="formbody"><div class="grid"><label class="field">Hesap Adı<select id="accountingFilter" aria-label="Hesap adına göre filtrele"><option value="">Tüm Hesaplar</option>${accounting.accounts.map((a) => `<option value="${esc(a.id)}" ${accountingFilter === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label><label class="field">Başlangıç Tarihi<input type="date" name="start" data-optional="true" value="${esc(movementFilters.start)}"></label><label class="field">Bitiş Tarihi<input type="date" name="end" data-optional="true" value="${esc(movementFilters.end)}"></label><label class="field">İşlem Türü<select name="type" data-optional="true">${[
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
      )}</select></label><label class="field">İşlemi Yapan Kullanıcı<input name="operator" list="accountingOperators" data-optional="true" value="${esc(movementFilters.operator)}" placeholder="Tüm kullanıcılar"><datalist id="accountingOperators">${operators.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist></label><label class="field">Gider Kalemi<select name="category" data-optional="true"><option value="">Tüm Gider Kalemleri</option>${accountingExpenseCategories.map((n) => `<option value="${esc(n)}" ${movementFilters.category === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label><label class="field">Açıklama / İşlem Ara<input type="search" name="query" data-optional="true" value="${esc(movementFilters.query)}" placeholder="Açıklama, evrak no veya kullanıcı…"></label></div><div class="toolbar" style="margin-top:16px"><button class="primary" type="submit">Filtrele</button><button class="secondary" type="button" id="clearMovementFilters">Filtreleri Temizle</button></div><p>Tarih aralığı başlangıç ve bitiş günlerini içerir.</p></form></details><div class="overflow acc-ledger-scroll"><table class="account-ledger"><thead><tr><th>TARİH</th><th>HESAP</th><th>İŞLEM</th><th>GİDER KALEMİ</th><th>İŞLEMİ YAPAN</th><th>AÇIKLAMA</th><th class="acc-num">GİREN</th><th class="acc-num">ÇIKAN</th><th class="acc-num">KALAN</th></tr></thead><tbody>${rows.map((e) => `<tr><td>${esc(displayDate(e.date))}</td><td>${esc(name(e.accountId))}</td><td>${accountingBadge(e)}</td><td>${esc(e.type === 'out' ? e.expenseCategory || 'Belirtilmedi' : '—')}</td><td>${esc(e.operatorName || 'Belirtilmedi')}</td><td>${esc(e.note)}</td><td class="acc-num acc-pos">${e.signed > 0 ? amount(e.signed) : '—'}</td><td class="acc-num acc-neg">${e.signed < 0 ? amount(-BigInt(e.signed)) : '—'}</td><td class="acc-num ${e.balance !== undefined ? accountingTone(e.balance) : ''}"><strong>${e.balance !== undefined ? amount(e.balance) : '—'}</strong></td></tr>`).join('') || '<tr><td colspan="9" class="empty">Henüz hesap hareketi yok.</td></tr>'}</tbody><tfoot><tr><td colspan="6"><strong>FİLTRELENEN TOPLAM</strong></td><td class="acc-num"><strong>${amount(totals.incoming)}</strong></td><td class="acc-num"><strong>${amount(totals.outgoing)}</strong></td><td>—</td></tr></tfoot></table></div><details class="acc-notes"><summary>Bu ekran nasıl çalışır?</summary><p>Hesap özetleri tüm kayıtları kapsar. Hareketler en yeniden eskiye sıralanır; kalan sütunu ilgili işlemin sonrasındaki hesap bakiyesidir.</p><p>Borçlu tahsilatı dosyaya işlenir: Borçlu Tahsilatı düğmesiyle dosyayı seçin veya dosyanın Finansal İşlemler ekranını kullanın; aynı tahsilatı Para Girişi olarak tekrar kaydetmeyin. Hesaplar arası transfer ciro veya kâr oluşturmaz. Bu ekran kayıt tutar, bankaya talimat göndermez.</p>${unassigned ? '<p>Hesap seçilmeden girilmiş eski tahsilatlar hesap bakiyelerine dahil değildir.</p>' : ''}</details></div>`;
  const accountsBox = document.querySelector('.acc-accounts-scroll');
  if (accountsBox && accountsScroll) accountsBox.scrollTop = accountsScroll;
  for (const action of accountingActions()) document.getElementById(action.id).onclick = action.run;
  if (!window.hanAccountingShortcuts) {
    window.hanAccountingShortcuts = true;
    document.addEventListener('keydown', accountingShortcut);
  }
  renderAccountingAlerts();
  loadAccountingAlerts();
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
    // Bring the account strip right under the action bar: accounts and movements stay together.
    const strip = document.querySelector('.account-summary')?.closest('.panel'),
      bar = document.querySelector('.acc-actions');
    if (strip) {
      const header =
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--han-header-h')) || 51;
      strip.style.scrollMarginTop = header + (bar?.offsetHeight || 0) + 8 + 'px';
      strip.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
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

// One focused form per kind of movement, opened from the quick actions.
function cashEntryForm(kind) {
  const kinds = {
    in: ['Para Girişi', 'Kasaya veya bankaya giren, dosyaya bağlı olmayan para.', 'Paranın Girdiği Hesap'],
    out: ['Para Çıkışı', 'Gider kalemini seçerek ödemeyi kaydedin.', 'Paranın Çıktığı Hesap'],
    advance: ['Avans Çıkışı', 'Kasadan düşer; gider veya kâr toplamlarına girmez.', 'Paranın Çıktığı Hesap'],
    transfer: ['Hesaplar Arası Transfer', 'Ciro veya kâr oluşturmaz.', 'Paranın Çıktığı Hesap'],
  };
  if (!Object.hasOwn(kinds, kind)) kind = 'in';
  const [title, hint, accountLabel] = kinds[kind],
    preset = typeof accountingFilter === 'string' ? accountingFilter : '',
    chips = (name, values) =>
      values
        .map(
          (value) =>
            `<label class="acc-chip"><input type="radio" name="${name}" value="${esc(value)}"><span>${esc(value)}</span></label>`,
        )
        .join('');
  const typeControl =
    kind === 'in'
      ? `<fieldset class="full acc-chipset"><legend>Giriş Türü</legend><label class="acc-chip"><input type="radio" name="type" value="in" checked><span>Normal giriş</span></label><label class="acc-chip"><input type="radio" name="type" value="external"><span>Haricen giriş</span></label></fieldset>`
      : `<input type="hidden" name="type" value="${kind}">`;
  $('#modal').innerHTML =
    `<form id="cashEntryForm" class="acc-entry acc-entry--${kind}"><div class="panelhead"><div><h2>${esc(title)}</h2><p>${esc(hint)} İşlemi yapan: ${esc(activeOperator()?.name || 'Seçilmedi — önce üst bölümden personel seçin')}</p></div><button type="button" class="link" id="closeCashEntry">Kapat</button></div><div class="formbody grid">${typeControl}<label class="field">${esc(accountLabel)} *<select name="accountId" required>${accountOptions(preset)}</select></label><label class="field" id="destinationField" hidden>Paranın Gireceği Hesap *<select name="destination" disabled>${accountOptions()}</select></label>${field('İşlem Tarihi', 'date', 'date', businessDate(), true)}${field('Tutar (TL)', 'amount', 'number', '', true)}<p class="${kind === 'transfer' ? 'full ' : ''}acc-balance-line" id="cashBalanceLine" role="status"></p><fieldset class="full acc-chipset" id="expenseCategoryField" hidden><legend>Gider Kalemi *</legend>${chips('expenseCategory', accountingExpenseCategories)}</fieldset><fieldset class="full acc-chipset" id="advanceTypeField" hidden><legend>Avans Türü *</legend>${chips('advanceType', ['T.Ç', 'S.S', 'Diğer'])}</fieldset><label class="field full" id="externalProfitField" hidden>Kâr Seçimi *<select name="profitChoice" disabled><option value="">Seçin</option><option value="yes">Kâra Ekle</option><option value="no">Kâra Ekleme</option></select></label>${field('Açıklama / Referans', 'note', 'text', '', true, true)}${kind === 'in' ? '<p class="full acc-form-hint">Borçlu tahsilatı buradan girilmez; Muhasebe ekranındaki Borçlu Tahsilatı düğmesini veya dosyanın Finansal İşlemler ekranını kullanın.</p>' : ''}</div><div class="actions"><button class="primary">${esc(title)} Kaydet</button></div></form>`;
  const form = $('#cashEntryForm');
  const balanceLine = () => {
    const line = $('#cashBalanceLine'),
      id = form.elements.accountId.value;
    line.textContent = '';
    line.classList.remove('acc-neg');
    if (!id) return;
    try {
      const current = accountBalance(id),
        cents = financeCents(form.elements.amount.value),
        delta =
          Number.isSafeInteger(cents) && cents > 0
            ? ['in', 'external'].includes(form.elements.type.value)
              ? cents
              : -cents
            : 0;
      line.textContent =
        'Mevcut bakiye: ' +
        money(current / 100) +
        (delta ? ' · İşlem sonrası: ' + money((current + delta) / 100) : '');
      line.classList.toggle('acc-neg', current + delta < 0);
    } catch {}
  };
  const sync = () => {
    const type = form.elements.type.value,
      toggle = (wrap, name, on) => {
        $(wrap).hidden = !on;
        form.querySelectorAll('[name="' + name + '"]').forEach((el) => {
          el.disabled = !on;
          el.required = on;
        });
      };
    toggle('#advanceTypeField', 'advanceType', type === 'advance');
    toggle('#externalProfitField', 'profitChoice', type === 'external');
    toggle('#destinationField', 'destination', type === 'transfer');
    toggle('#expenseCategoryField', 'expenseCategory', type === 'out');
    const note = form.elements.note,
      label = note.closest('label'),
      external = type === 'external';
    if (label?.firstChild?.nodeType === 3)
      label.firstChild.textContent = external ? 'Harici Para Girişi Açıklaması * ' : 'Açıklama / Referans * ';
    note.placeholder = external ? 'Paranın kaynağını ve giriş nedenini yazın…' : '';
    balanceLine();
  };
  sync();
  if (typeof setupPayrollCashFields === 'function') setupPayrollCashFields(form);
  form.addEventListener('change', (event) => {
    if (event.target.name === 'type') sync();
    else if (event.target.name === 'accountId') balanceLine();
  });
  form.addEventListener('input', (event) => {
    if (event.target.name === 'amount') balanceLine();
  });
  $('#closeCashEntry').onclick = () => $('#modal').close();
  $('#modal').showModal();
  const refresh = () => {
    accountingAlertsAt = 0;
    accountingPage();
  };
  if (window.hanRecordsEnabled) return bindRecordCashSubmit(form, { dialog: $('#modal'), onSaved: refresh });
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
      refresh();
      toast('Para hareketi kaydedildi.');
    }
  };
}
