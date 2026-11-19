const chequePageState = { direction: 'received', q: '', from: '', to: '', offset: 0 };
async function chequeApi(method = 'GET', input) {
  const response = await fetch('/api/cheques' + (method === 'GET' ? '?' + new URLSearchParams(input) : ''), {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Çek işlemi tamamlanamadı.');
  if (result.accountBalances) window.hanAccountBalances = result.accountBalances;
  return result;
}
function chequesPage(direction = chequePageState.direction) {
  const state = chequePageState;
  if (direction !== state.direction) {
    state.direction = direction;
    state.offset = 0;
  }
  $('#content').innerHTML =
    '<section class="panel"><div class="panelhead"><div><h2>Çek İşlemleri</h2><p>Alınan çek kayıtta, verilen çek CEO onayında kasa/banka ve cari hesaba işlenir.</p></div><div class="toolbar"><button type="button" class="secondary" id="chequesBack">Kasa / Banka</button><button type="button" class="primary" id="chequesNew">' +
    (direction === 'received' ? 'Alınan Çek Ekle' : 'Verilen Çek Ekle') +
    '</button></div></div><div class="formbody"><div class="settings-tabs" role="tablist" aria-label="Çek türü"><button type="button" role="tab" data-cheque-direction="received">Alınan Çek</button><button type="button" role="tab" data-cheque-direction="issued">Verilen Çek</button></div><form id="chequeFilters"><div class="grid"><label class="field">Ara<input name="q" type="search" data-optional="true" placeholder="Çek no, banka, çek sahibi veya cari"></label><label class="field">Çek Tarihi · Başlangıç<input name="from" type="date" data-optional="true"></label><label class="field">Çek Tarihi · Bitiş<input name="to" type="date" data-optional="true"></label></div><div class="toolbar"><button class="secondary" type="submit">Filtrele / Yenile</button><button class="secondary" type="button" id="chequesClear">Temizle</button></div></form><p id="chequesTotals" role="status"></p></div><div class="overflow"><table><thead><tr><th>İŞLEM TARİHİ</th><th>ÇEK TARİHİ / NO</th><th>BANKA</th><th>ÇEK SAHİBİ</th><th>CARİ</th><th>KASA / BANKA</th><th>TUTAR</th><th>KÂR TERCİHİ</th><th>DURUM</th></tr></thead><tbody id="chequesRows"></tbody></table></div><div class="tablefoot"><span id="chequesCount"></span><div class="toolbar"><button class="secondary" id="chequesPrevious">Önceki</button><button class="secondary" id="chequesNext">Sonraki</button></div></div></section>';
  const host = $('#chequesRows'),
    form = $('#chequeFilters');
  let data,
    sequence = 0;
  for (const key of ['q', 'from', 'to']) form.elements[key].value = state[key];
  for (const tab of document.querySelectorAll('[data-cheque-direction]')) {
    const active = tab.dataset.chequeDirection === direction;
    tab.classList.toggle('selected', active);
    tab.setAttribute('aria-selected', String(active));
    tab.onclick = () => chequesPage(tab.dataset.chequeDirection);
  }
  async function load() {
    const token = ++sequence;
    $('#chequesTotals').textContent = 'Çekler yükleniyor…';
    try {
      const result = await chequeApi('GET', state);
      if (!host.isConnected || token !== sequence) return;
      data = result;
      const statuses = {
        recorded: 'Kaydedildi',
        pending: 'CEO Onayı Bekliyor',
        rejected: 'Reddedildi',
        deleted: 'Kasa Kaydı Silinmiş',
      };
      host.innerHTML =
        data.items
          .map(
            (r) =>
              '<tr><td>' +
              esc(displayDate(r.date)) +
              '</td><td>' +
              esc(displayDate(r.chequeDate)) +
              '<br><small>' +
              esc(r.number || '—') +
              '</small></td><td>' +
              esc(r.bankName) +
              '</td><td>' +
              esc(r.holder) +
              '</td><td>' +
              (r.effectiveCurrentAccountId
                ? '<button type="button" class="link" data-cheque-party="' +
                  esc(r.effectiveCurrentAccountId) +
                  '">' +
                  esc(r.currentAccountName || 'Cari') +
                  '</button>'
                : '—') +
              '</td><td>' +
              esc(r.accountName) +
              '</td><td style="white-space:nowrap">' +
              esc(currentAccountMoney(r.amount)) +
              '</td><td>' +
              (direction === 'received'
                ? r.includeInProfit
                  ? 'Kâra Ekle'
                  : 'Kâra Ekleme'
                : r.includeInProfit
                  ? 'Kârdan Düş'
                  : 'Kârdan Düşme') +
              '</td><td>' +
              esc(statuses[r.status]) +
              (r.decidedByName ? '<br><small>' + esc(r.decidedByName) + '</small>' : '') +
              '</td></tr>',
          )
          .join('') || '<tr><td colspan="9" class="empty">Çek kaydı bulunamadı.</td></tr>';
      host
        .querySelectorAll('[data-cheque-party]')
        .forEach((b) => (b.onclick = () => currentAccountStatement(b.dataset.chequeParty)));
      $('#chequesTotals').textContent =
        'Kaydedilen: ' +
        currentAccountMoney(data.totals.recorded) +
        (direction === 'issued' ? ' · CEO onayı bekleyen: ' + currentAccountMoney(data.totals.pending) : '');
      $('#chequesCount').textContent =
        (data.count ? state.offset + 1 : 0) + '–' + (state.offset + data.items.length) + ' / ' + data.count;
      $('#chequesPrevious').disabled = state.offset === 0;
      $('#chequesNext').disabled = !data.more;
    } catch (error) {
      if (host.isConnected) $('#chequesTotals').textContent = error.message;
    }
  }
  form.onsubmit = (e) => {
    e.preventDefault();
    Object.assign(state, Object.fromEntries(new FormData(form)), { offset: 0 });
    load();
  };
  $('#chequesClear').onclick = () => {
    Object.assign(state, { q: '', from: '', to: '', offset: 0 });
    chequesPage(direction);
  };
  $('#chequesPrevious').onclick = () => {
    state.offset = Math.max(0, state.offset - 50);
    load();
  };
  $('#chequesNext').onclick = () => {
    if (data?.more) {
      state.offset += 50;
      load();
    }
  };
  $('#chequesBack').onclick = accountingPage;
  $('#chequesNew').disabled =
    window.hanModuleAction?.('accounting', 'create') === false || window.hanAuth?.readOnly === true;
  $('#chequesNew').onclick = () => chequeForm(direction);
  load();
}
function chequeForm(direction) {
  const received = direction === 'received',
    dialog = $('#modal'),
    id = crypto.randomUUID(),
    screen = $('#content').firstElementChild;
  dialog.innerHTML =
    '<form id="chequeForm"><div class="panelhead"><div><h2>' +
    (received ? 'Alınan Çek Kaydı' : 'Verilen Çek Kaydı') +
    '</h2><p>' +
    (received
      ? 'Kayıt anında seçilen kasa/banka ve cari hesaba işlenir.'
      : 'CEO onayladığında seçilen kasa/banka ve cari hesaba işlenir.') +
    '</p></div><button class="secondary" type="button" data-cheque-close>Kapat</button></div><div class="formbody grid">' +
    field('Tutar (TL)', 'amount', 'number', '', true) +
    field('İşlem Tarihi', 'date', 'date', businessDate(), true) +
    field('Çek Tarihi / Vade', 'chequeDate', 'date', '', true) +
    field('Çek No', 'number', 'text').replace('<input ', '<input data-optional="true" maxlength="80" ') +
    field('Çekin Bankası', 'bankName', 'text', '', true).replace('<input ', '<input maxlength="200" ') +
    field('Çek Sahibi', 'holder', 'text', '', true).replace('<input ', '<input maxlength="200" ') +
    '<label class="field">' +
    (received ? 'Paranın Gireceği' : 'Paranın Çıkacağı') +
    ' Kasa / Banka *<select name="accountId" required>' +
    accountOptions() +
    '</select></label><label class="field">Kâr Tercihi *<select name="profitChoice" required><option value="">Seçin</option><option value="yes">' +
    (received ? 'Kâra Ekle' : 'Kârdan Düş') +
    '</option><option value="no">' +
    (received ? 'Kâra Ekleme' : 'Kârdan Düşme') +
    '</option></select></label><label class="field full">Cari Hesap<select name="currentAccountId" data-optional="true" disabled><option value="">Cariye bağlama</option></select><small data-cheque-options-status></small></label><label class="field full">Açıklama<textarea name="description" data-optional="true" maxlength="1500"></textarea></label><p class="full">Gider kalemi seçilmez. Çek tutarı gider raporuna dahil edilmez; kâr tercihi ayrı uygulanır.</p><p class="formerror full" role="alert"></p></div><div class="actions"><button class="primary" type="submit">' +
    (received ? 'Çeki Kaydet' : 'CEO Onayına Gönder') +
    '</button></div></form>';
  const form = dialog.querySelector('form');
  dialog.querySelector('[data-cheque-close]').onclick = () => dialog.close();
  currentAccountApi('/options')
    .then((data) => {
      if (!form.isConnected) return;
      const select = form.elements.currentAccountId;
      for (const p of data.items) select.append(new Option(p.name, p.id));
      select.disabled = false;
    })
    .catch((error) => {
      if (form.isConnected) form.querySelector('[data-cheque-options-status]').textContent = error.message;
    });
  let pending = false;
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending || !form.reportValidity()) return;
    pending = true;
    const button = form.querySelector('.primary');
    button.disabled = true;
    try {
      const value = Object.fromEntries(new FormData(form));
      value.amount = financeCents(value.amount);
      await chequeApi('POST', { ...value, id, direction });
      window.modalFormSaved?.(form);
      dialog.close();
      toast(received ? 'Alınan çek kaydedildi.' : 'Verilen çek CEO onayına gönderildi.');
      if (screen?.isConnected) chequesPage(direction);
    } catch (error) {
      form.querySelector('.formerror').textContent = error.message;
    } finally {
      pending = false;
      button.disabled = false;
    }
  };
  if (!dialog.open) dialog.showModal();
}
