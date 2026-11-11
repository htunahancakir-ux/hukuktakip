async function readPersonnelLedger(staffId = '', signal) {
  const path =
    (window.hanRecordsEnabled ? '/api/records/personnel-ledger' : '/api/personnel-ledger') +
    '?' +
    new URLSearchParams({ staffId });
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Personel carisi alınamadı.');
  return data;
}
async function personnelLedgerPage(host, staffId = '') {
  host._personnelLedgerRequest?.abort();
  const request = new AbortController();
  host._personnelLedgerRequest = request;
  host.innerHTML = '<p role="status">Personel cari hesabı yükleniyor…</p>';
  try {
    const data = await readPersonnelLedger(staffId, request.signal);
    if (!host.isConnected || request.signal.aborted) return;
    host.innerHTML =
      '<div class="panel personnel-ledger"><div class="panelhead"><div><h2>Personel Cari Hesabı</h2><p>Başlangıç: 1 Kasım 2026 · Maaş avansı: ayda bir, maaş + Prim 1 toplamının en fazla %25’i.</p></div></div><div class="formbody"><label class="field">Personel<select data-ledger-person><option value="">Personel seçin</option>' +
      data.people
        .map(
          (person) =>
            '<option value="' +
            esc(person.id) +
            '">' +
            esc(person.name) +
            (person.active ? '' : ' (pasif)') +
            '</option>',
        )
        .join('') +
      '</select></label><div data-ledger-content></div></div></div>';
    const personSelect = host.querySelector('[data-ledger-person]');
    personSelect.value = staffId;
    personSelect.onchange = () => personnelLedgerPage(host, personSelect.value);
    if (!staffId) return;
    const content = host.querySelector('[data-ledger-content]');
    const summaries = [
      ['Toplam Cari Alacağı', data.balance],
      ['Önceki Aylar · Ödenebilir', data.payable],
      ['Bu Ay Hakedişi', data.currentEarned],
      ['Bu Ay Kullanılabilir Avans', data.advanceLimit],
    ];
    content.innerHTML =
      '<div class="stats personnel-ledger-summary">' +
      summaries
        .map(
          ([label, amount]) =>
            '<div class="stat"><small>' +
            label +
            '</small><strong>' +
            money(amount / 100) +
            '</strong></div>',
        )
        .join('') +
      '</div><div class="overflow"><table><thead><tr><th>DÖNEM</th><th>HAKEDİŞ</th><th>MAAŞ AVANSI</th><th>ÖDENEN MAAŞ / PRİM</th><th>KALAN ALACAK</th><th>DURUM</th></tr></thead><tbody>' +
      data.months
        .map(
          (row) =>
            '<tr><td>' +
            esc(displayDate(row.month)) +
            '</td><td>' +
            money(row.earned / 100) +
            '</td><td>' +
            money(row.advance / 100) +
            '</td><td>' +
            money(row.paid / 100) +
            '</td><td><strong>' +
            money(row.remaining / 100) +
            '</strong></td><td>' +
            (!row.remaining
              ? 'Ödendi'
              : row.payable
                ? 'Ödemeye açık'
                : 'Devam eden ay · Maaş ödemesine kapalı') +
            '</td></tr>',
        )
        .join('') +
      '</tbody></table></div><section data-personnel-payment></section><div class="personnel-ledger-history-head"><h3>Cari Hareketler</h3><label>Dönem <select data-ledger-period data-optional="true"><option value="">Tüm dönemler</option>' +
      data.months
        .map((row) => '<option value="' + esc(row.month) + '">' + esc(displayDate(row.month)) + '</option>')
        .join('') +
      '</select></label></div><div class="overflow"><table><thead><tr><th>TARİH</th><th>DÖNEM</th><th>AÇIKLAMA</th><th>ALACAK</th><th>ÖDENEN</th><th>CARİ BAKİYE</th></tr></thead><tbody data-ledger-movements></tbody></table></div><div class="personnel-ledger-pagination"><span data-ledger-page></span><div><button type="button" class="secondary" data-ledger-prev>Önceki</button> <button type="button" class="secondary" data-ledger-next>Sonraki</button></div></div>';
    let page = 0;
    const history = () => {
      const period = content.querySelector('[data-ledger-period]').value;
      const rows = data.events
          .filter((row) => !period || row.month === period)
          .slice()
          .reverse(),
        count = rows.length;
      page = Math.min(page, Math.max(0, Math.ceil(count / 50) - 1));
      content.querySelector('[data-ledger-movements]').innerHTML =
        rows
          .slice(page * 50, page * 50 + 50)
          .map(
            (row) =>
              '<tr><td>' +
              esc(displayDate(row.date)) +
              '</td><td>' +
              esc(displayDate(row.month)) +
              '</td><td>' +
              esc(row.note || '') +
              (row.accountName ? '<small>' + esc(row.accountName) + '</small>' : '') +
              '</td><td class="personnel-credit">' +
              (row.credit ? money(row.credit / 100) : '—') +
              '</td><td class="personnel-debit">' +
              (row.debit ? money(row.debit / 100) : '—') +
              '</td><td>' +
              money(row.balance / 100) +
              '</td></tr>',
          )
          .join('') || '<tr><td colspan="6">Bu dönemde hareket yok.</td></tr>';
      content.querySelector('[data-ledger-page]').textContent =
        (count ? page * 50 + 1 : 0) + '–' + Math.min(count, page * 50 + 50) + ' / ' + count + ' hareket';
      content.querySelector('[data-ledger-prev]').disabled = page === 0;
      content.querySelector('[data-ledger-next]').disabled = (page + 1) * 50 >= count;
    };
    content.querySelector('[data-ledger-period]').onchange = () => {
      page = 0;
      history();
    };
    content.querySelector('[data-ledger-prev]').onclick = () => {
      page--;
      history();
    };
    content.querySelector('[data-ledger-next]').onclick = () => {
      page++;
      history();
    };
    history();
    const paymentHost = content.querySelector('[data-personnel-payment]');
    paymentHost.innerHTML =
      '<h3>Maaş / Avans Ödemesi</h3><p class="notice">Normal ödemelerde yalnızca kapanmış aylar seçilir. Avans ilgili ayın alacağından düşer; kalan tutar sonraki ay ödenebilir.</p><form class="personnel-payment-form"><div class="grid"><label class="field">Ödeme Türü<select name="mode"><option value="salaryPayment">Kapanmış Ay Maaş / Prim Ödemesi</option><option value="salaryAdvance" ' +
      (data.advanceLimit > 0 ? '' : 'disabled') +
      '>Bu Ay Maaş Avansı</option></select></label><label class="field">Hakediş Dönemi<select name="payrollMonth" required></select></label><label class="field">Ödemenin Çıkacağı Kasa / Banka<select name="accountId" required><option value="">Hesap seçin</option>' +
      data.accounts
        .map((account) => '<option value="' + esc(account.id) + '">' + esc(account.name) + '</option>')
        .join('') +
      '</select></label>' +
      field('Ödeme Tarihi', 'date', 'date', businessDate(), true) +
      field('Ödenecek Tutar (₺)', 'amount', 'number', '', true) +
      '<label class="field">Açıklama<input name="note" maxlength="3000" required></label></div><p data-payment-limit role="status"></p><button type="submit" class="primary">Ödemeyi Kaydet</button></form>';
    const form = paymentHost.querySelector('form'),
      payable = data.months.filter((row) => row.payable && row.remaining > 0);
    if (!payable.length && data.advanceLimit > 0) form.elements.mode.value = 'salaryAdvance';
    const limits = () => {
      const advance = form.elements.mode.value === 'salaryAdvance';
      const months = advance ? [{ month: data.currentMonth, remaining: data.advanceLimit }] : payable;
      const previous = form.elements.payrollMonth.value;
      form.elements.payrollMonth.innerHTML =
        months
          .map((row) => '<option value="' + esc(row.month) + '">' + esc(displayDate(row.month)) + '</option>')
          .join('') || '<option value="">Ödenebilir dönem yok</option>';
      if (months.some((row) => row.month === previous)) form.elements.payrollMonth.value = previous;
      updateMax();
    };
    const updateMax = () => {
      const advance = form.elements.mode.value === 'salaryAdvance';
      const max = advance
        ? data.advanceLimit
        : payable.find((row) => row.month === form.elements.payrollMonth.value)?.remaining || 0;
      form.elements.amount.max = String(max / 100);
      form.querySelector('button[type="submit"]').disabled = max <= 0;
      form.querySelector('[data-payment-limit]').textContent =
        max > 0
          ? 'En fazla ' + money(max / 100)
          : data.advanceUsed
            ? 'Bu ay maaş avansı kullanıldı. Ödenebilir kapanmış ay bulunmuyor.'
            : 'Ödenebilir kapanmış ay bulunmuyor.';
      form.elements.note.value = advance
        ? form.elements.payrollMonth.value + ' maaş avansı'
        : form.elements.payrollMonth.value + ' maaş ve prim ödemesi';
    };
    form.elements.mode.onchange = limits;
    form.elements.payrollMonth.onchange = updateMax;
    limits();
    const requestId = crypto.randomUUID();
    let pending = false;
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (pending || !form.reportValidity()) return;
      const button = form.querySelector('[type="submit"]');
      try {
        pending = true;
        button.disabled = true;
        const value = Object.fromEntries(new FormData(form));
        const response = await fetch('/api/cash-entry', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
          body: JSON.stringify({
            ...value,
            id: requestId,
            staffId,
            type: 'out',
            expenseCategory: value.mode === 'salaryAdvance' ? 'Maaş Avansı' : 'Maaş',
            amount: financeCents(value.amount),
          }),
        });
        const result = await response.json();
        if (!response.ok) throw Error(result.error || 'Personel ödemesi kaydedilemedi.');
        if (result.accountBalances) window.hanAccountBalances = result.accountBalances;
        toast('Personel ödemesi kaydedildi.');
        await personnelLedgerPage(host, staffId);
      } catch (error) {
        toast(error.message);
      } finally {
        pending = false;
        if (button.isConnected) button.disabled = false;
      }
    };
  } catch (error) {
    if (!request.signal.aborted && host.isConnected) host.textContent = error.message;
  }
}

function setupPayrollCashFields(form) {
  const section = document.createElement('div');
  section.className = 'full grid';
  section.hidden = true;
  section.innerHTML =
    '<label class="field">Ödeme Yapılacak Personel<select name="staffId" disabled required><option value="">Personel seçin</option>' +
    personnel
      .map((person) => '<option value="' + esc(person.id) + '">' + esc(person.name) + '</option>')
      .join('') +
    '</select></label><label class="field">Hakediş Dönemi<select name="payrollMonth" disabled required><option value="">Önce personel seçin</option></select></label><p class="full" data-payroll-cash-limit></p>';
  form.querySelector('.formbody').append(section);
  let controller;
  async function update() {
    controller?.abort();
    controller = new AbortController();
    const request = controller;
    const active =
      form.elements.type.value === 'out' &&
      ['Maaş', 'Prim', 'Maaş Avansı'].includes(form.elements.expenseCategory.value);
    section.hidden = !active;
    for (const input of section.querySelectorAll('select')) input.disabled = !active;
    form.elements.amount.removeAttribute('max');
    if (!active) return;
    const staffId = form.elements.staffId.value;
    if (!staffId) {
      form.elements.payrollMonth.innerHTML = '<option value="">Önce personel seçin</option>';
      return;
    }
    try {
      const data = await readPersonnelLedger(staffId, request.signal);
      if (request.signal.aborted || !section.isConnected) return;
      const advance = form.elements.expenseCategory.value === 'Maaş Avansı';
      const months = advance
        ? data.advanceLimit > 0
          ? [{ month: data.currentMonth, remaining: data.advanceLimit }]
          : []
        : data.months.filter((row) => row.payable && row.remaining > 0);
      form.elements.payrollMonth.innerHTML =
        months
          .map((row) => '<option value="' + esc(row.month) + '">' + esc(displayDate(row.month)) + '</option>')
          .join('') || '<option value="">Ödenebilir dönem yok</option>';
      const max = () => {
        const limit = months.find((row) => row.month === form.elements.payrollMonth.value)?.remaining || 0;
        form.elements.amount.max = String(limit / 100);
        section.querySelector('[data-payroll-cash-limit]').textContent =
          limit > 0
            ? 'En fazla ' +
              money(limit / 100) +
              (advance ? ' · Ayda bir, maaş + Prim 1 toplamının %25’i.' : '')
            : advance
              ? 'Bu ay avans hakkı yok veya kullanıldı.'
              : 'Ödenebilir kapanmış ay yok.';
      };
      form.elements.payrollMonth.onchange = max;
      max();
    } catch (error) {
      if (!request.signal.aborted)
        section.querySelector('[data-payroll-cash-limit]').textContent = error.message;
    }
  }
  form.addEventListener('change', (event) => {
    if (['type', 'expenseCategory', 'staffId'].includes(event.target.name)) update();
  });
  update();
}
