const currentAccountListState = { q: '', offset: 0 };
let currentAccountRequest;
async function currentAccountApi(path, method = 'GET', value, signal) {
  const response = await fetch('/api/current-accounts' + path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
    ...(value ? { body: JSON.stringify(value) } : {}),
    ...(signal ? { signal } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Cari işlemi tamamlanamadı.');
  return result;
}
function currentAccountMoney(value) {
  const n = BigInt(value || '0'),
    absolute = n < 0n ? -n : n;
  return (
    (n < 0n ? '-' : '') +
    (absolute / 100n).toLocaleString('tr-TR') +
    ',' +
    String(absolute % 100n).padStart(2, '0') +
    ' TL'
  );
}
function currentAccountBalance(value) {
  const n = BigInt(value || '0');
  return n === 0n
    ? 'Bakiye yok'
    : (n > 0n ? 'Alacağımız: ' : 'Borcumuz: ') + currentAccountMoney(n < 0n ? -n : n);
}
function currentAccountsPage() {
  currentAccountRequest?.abort();
  $('#content').innerHTML =
    '<section class="panel"><div class="panelhead"><div><h2>Cari Hesaplar</h2><p>Firma ve kişi bazında borç, alacak ve kasa/banka bağlantıları.</p></div><div class="toolbar"><button type="button" class="secondary" id="currentBack">Kasa / Banka</button><button type="button" class="primary" id="currentNew">Yeni Cari</button></div></div><div class="formbody"><div class="toolbar"><input type="search" id="currentQuery" data-optional="true" placeholder="Cari adı veya telefon ara" aria-label="Cari ara"><button type="button" class="secondary" id="currentSearch">Ara</button></div><p id="currentTotals" role="status"></p></div><div class="overflow"><table><thead><tr><th>CARİ ADI</th><th>TÜR</th><th>TELEFON</th><th>BAKİYE</th><th></th></tr></thead><tbody id="currentRows"></tbody></table></div><div class="tablefoot"><span id="currentCount"></span><div class="toolbar"><button class="secondary" id="currentPrevious">Önceki</button><button class="secondary" id="currentNext">Sonraki</button></div></div></section>';
  const host = $('#currentRows'),
    state = currentAccountListState;
  $('#currentQuery').value = state.q;
  let data, timer;
  const load = async () => {
    currentAccountRequest?.abort();
    const request = new AbortController();
    currentAccountRequest = request;
    host.textContent = '';
    $('#currentTotals').textContent = 'Cariler yükleniyor…';
    try {
      data = await currentAccountApi(
        '?' + new URLSearchParams({ q: state.q, offset: state.offset, limit: 50 }),
        'GET',
        undefined,
        request.signal,
      );
      if (!host.isConnected || request !== currentAccountRequest) return;
      host.innerHTML =
        data.items
          .map(
            (p) =>
              `<tr><td><button type="button" class="link" data-current-open="${esc(p.id)}"><strong>${esc(p.name)}</strong></button></td><td>${esc(p.kind)}</td><td>${esc(p.phone || '—')}</td><td>${esc(currentAccountBalance(p.balance))}</td><td><button type="button" class="link" data-current-edit="${esc(p.id)}">Düzenle</button></td></tr>`,
          )
          .join('') || '<tr><td colspan="5" class="empty">Cari bulunamadı.</td></tr>';
      $('#currentTotals').textContent =
        'Alacağımız: ' +
        currentAccountMoney(data.totals.receivable) +
        ' · Borcumuz: ' +
        currentAccountMoney(data.totals.payable);
      $('#currentCount').textContent =
        (data.count ? state.offset + 1 : 0) + '–' + (state.offset + data.items.length) + ' / ' + data.count;
      $('#currentPrevious').disabled = state.offset === 0;
      $('#currentNext').disabled = !data.more;
      host
        .querySelectorAll('[data-current-open]')
        .forEach((b) => (b.onclick = () => currentAccountStatement(b.dataset.currentOpen)));
      host.querySelectorAll('[data-current-edit]').forEach((b) => {
        b.disabled = window.hanModuleAction?.('accounting', 'update') === false;
        b.onclick = () =>
          currentAccountPartyForm(
            data.items.find((p) => p.id === b.dataset.currentEdit),
            () => host.isConnected && load(),
          );
      });
    } catch (error) {
      if (error.name !== 'AbortError' && host.isConnected) $('#currentTotals').textContent = error.message;
    }
  };
  const search = () => {
    state.q = $('#currentQuery').value;
    state.offset = 0;
    load();
  };
  $('#currentSearch').onclick = search;
  $('#currentQuery').oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(search, 200);
  };
  $('#currentPrevious').onclick = () => {
    state.offset = Math.max(0, state.offset - 50);
    load();
  };
  $('#currentNext').onclick = () => {
    if (data?.more) {
      state.offset += 50;
      load();
    }
  };
  $('#currentNew').disabled = window.hanModuleAction?.('accounting', 'create') === false;
  $('#currentNew').onclick = () => currentAccountPartyForm(null, () => host.isConnected && load());
  $('#currentBack').onclick = accountingPage;
  load();
}
function currentAccountPartyForm(p, onSaved) {
  const id = p?.id || crypto.randomUUID(),
    dialog = $('#modal');
  dialog.innerHTML = `<form id="currentPartyForm"><div class="panelhead"><h2>${p ? 'Cariyi Düzenle' : 'Yeni Cari Hesap'}</h2><button type="button" class="secondary" data-current-close>Kapat</button></div><div class="formbody grid"><label class="field">Tür<select name="kind"><option value="Firma">Firma</option><option value="Kişi" ${p?.kind === 'Kişi' ? 'selected' : ''}>Kişi</option></select></label>${field('Cari Adı', 'name', 'text', p?.name || '', true)}${field('Telefon', 'phone', 'tel', p?.phone || '').replace('<input ', '<input data-optional="true" ')}${field('Telefon Kaynağı', 'phoneSource', 'text', p?.phoneSource || '').replace('<input ', '<input data-optional="true" ')}<label class="field full">Açıklama<textarea name="note" data-optional="true" maxlength="3000">${esc(p?.note || '')}</textarea></label><p class="formerror full" role="alert"></p></div><div class="actions"><button type="submit" class="primary">Cariyi Kaydet</button></div></form>`;
  const form = dialog.querySelector('form');
  if (!p) {
    const tabs = document.createElement('div');
    tabs.className = 'settings-tabs';
    tabs.style.padding = '16px 24px 0';
    tabs.innerHTML =
      '<button type="button" class="selected">Manuel Cari</button><button type="button" data-current-from-client>Müvekkilden Getir</button>';
    form.querySelector('.panelhead').after(tabs);
    tabs.querySelector('[data-current-from-client]').onclick = () => currentAccountFromClientForm(onSaved);
  }
  let pending = false;
  dialog.querySelector('[data-current-close]').onclick = () => dialog.close();
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending || !form.reportValidity()) return;
    const button = form.querySelector('button.primary');
    pending = true;
    button.disabled = true;
    try {
      await currentAccountApi('', 'POST', {
        ...Object.fromEntries(new FormData(form)),
        id,
        ...(p ? { revision: p.revision } : {}),
      });
      window.modalFormSaved?.(form);
      dialog.close();
      toast('Cari kaydedildi.');
      onSaved?.();
    } catch (error) {
      form.querySelector('.formerror').textContent = error.message;
    } finally {
      pending = false;
      button.disabled = false;
    }
  };
  if (!dialog.open) dialog.showModal();
}
function currentAccountFromClientForm(onSaved) {
  const dialog = $('#modal'),
    id = crypto.randomUUID(),
    screen = $('#content').firstElementChild;
  dialog.innerHTML =
    '<form id="currentClientPartyForm"><div class="panelhead"><h2>Müvekkilden Cari Oluştur</h2><button type="button" class="secondary" data-current-close>Kapat</button></div><div class="settings-tabs" style="padding:16px 24px 0"><button type="button" data-current-manual>Manuel Cari</button><button type="button" class="selected">Müvekkilden Getir</button></div><div class="formbody"><label class="field">Müvekkil Ara<input type="search" data-current-client-query data-optional="true" placeholder="Müvekkil adı yazın"></label><label class="field">Müvekkil<select name="clientId" required><option value="">Müvekkil seçin</option></select></label><p data-current-client-count role="status"></p><p>Seçilen müvekkile bağlı bir cari açılır. Mevcut carisi varsa aynı hesap açılır.</p><p class="formerror" role="alert"></p></div><div class="actions"><button class="primary" type="submit">Seçilen Müvekkile Cari Aç</button></div></form>';
  const form = dialog.querySelector('form'),
    select = form.elements.clientId;
  dialog.querySelector('[data-current-close]').onclick = () => dialog.close();
  dialog.querySelector('[data-current-manual]').onclick = () => currentAccountPartyForm(null, onSaved);
  if (window.hanRecordsEnabled)
    bindIntakeClientSelect(
      form.querySelector('[data-current-client-query]'),
      select,
      'Müvekkil seçin',
      form.querySelector('[data-current-client-count]'),
    );
  else {
    const show = () => {
      const q = form.querySelector('[data-current-client-query]').value.toLocaleLowerCase('tr');
      select.replaceChildren(new Option('Müvekkil seçin', ''));
      for (const c of db.clients.filter(
        (c) => c.active !== false && c.name.toLocaleLowerCase('tr').includes(q),
      ))
        select.append(new Option(c.name, c.id));
    };
    form.querySelector('[data-current-client-query]').oninput = show;
    show();
  }
  let pending = false;
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending || !form.reportValidity()) return;
    pending = true;
    const button = form.querySelector('.primary');
    button.disabled = true;
    try {
      const result = await currentAccountApi('/from-client', 'POST', { id, clientId: select.value });
      window.modalFormSaved?.(form);
      select._intakeClientRequest?.abort();
      dialog.close();
      toast(result.existing ? 'Mevcut müvekkil carisi açıldı.' : 'Müvekkile cari açıldı.');
      onSaved?.();
      if (screen?.isConnected) currentAccountStatement(result.party.id);
    } catch (error) {
      form.querySelector('.formerror').textContent = error.message;
    } finally {
      pending = false;
      button.disabled = false;
    }
  };
  dialog.addEventListener('close', () => select._intakeClientRequest?.abort(), { once: true });
  if (!dialog.open) dialog.showModal();
}
function currentAccountManualForm(p, onSaved) {
  const id = crypto.randomUUID(),
    dialog = $('#modal');
  dialog.innerHTML = `<form><div class="panelhead"><h2>Borç / Alacak Kaydı</h2><button type="button" class="secondary" data-current-close>Kapat</button></div><div class="formbody grid"><p class="full">${esc(p.name)} · Bu kayıt kasa veya bankada para hareketi oluşturmaz.</p><label class="field full">İşlem<select name="side"><option value="credit">Borcumuz artsın (biz karşı tarafa borçluyuz)</option><option value="debit">Alacağımız artsın (karşı taraf bize borçlu)</option></select></label>${field('Tarih', 'date', 'date', businessDate(), true)}${field('Tutar (TL)', 'amount', 'number', '', true)}${field('Açıklama', 'note', 'text', '', true, true)}<p class="formerror full" role="alert"></p></div><div class="actions"><button type="submit" class="primary">Kaydet</button></div></form>`;
  const form = dialog.querySelector('form');
  let pending = false;
  dialog.querySelector('[data-current-close]').onclick = () => dialog.close();
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending || !form.reportValidity()) return;
    pending = true;
    const button = form.querySelector('button.primary');
    button.disabled = true;
    try {
      const value = Object.fromEntries(new FormData(form));
      value.amount = financeCents(value.amount);
      await currentAccountApi('/entries', 'POST', { ...value, id, partyId: p.id });
      window.modalFormSaved?.(form);
      dialog.close();
      toast('Cari kaydı eklendi.');
      onSaved?.();
    } catch (error) {
      form.querySelector('.formerror').textContent = error.message;
    } finally {
      pending = false;
      button.disabled = false;
    }
  };
  if (!dialog.open) dialog.showModal();
}
function currentAccountStatement(id) {
  currentAccountRequest?.abort();
  $('#content').innerHTML =
    '<section class="panel"><div class="panelhead"><div><h2 id="currentStatementTitle">Cari Ekstresi</h2><p>Pozitif bakiye alacağımızı, negatif bakiye borcumuzu gösterir.</p></div><div class="toolbar"><button class="secondary" id="currentStatementBack">Cariler</button><button class="secondary" id="currentStatementEdit">Cariyi Düzenle</button><button class="primary" id="currentStatementAdd">Borç / Alacak Ekle</button></div></div><div class="formbody"><div class="grid"><label class="field">Başlangıç Tarihi<input type="date" id="currentFrom" data-optional="true"></label><label class="field">Bitiş Tarihi<input type="date" id="currentTo" data-optional="true"></label></div><div class="toolbar"><button class="primary" id="currentStatementFilter">Filtrele / Yenile</button><button class="secondary" id="currentStatementClear">Tarihleri Temizle</button><button class="secondary" id="currentStatementExport">Excel İndir</button></div><p id="currentStatementTotals" role="status"></p></div><div class="overflow"><table><thead><tr><th>TARİH</th><th>İŞLEM</th><th>AÇIKLAMA</th><th>KASA / BANKA</th><th>BORÇ</th><th>ALACAK</th><th>BAKİYE</th></tr></thead><tbody id="currentStatementRows"></tbody><tfoot id="currentStatementFoot"></tfoot></table></div><div class="tablefoot"><span id="currentStatementCount"></span><div class="toolbar"><button class="secondary" id="currentStatementPrevious">Önceki</button><button class="secondary" id="currentStatementNext">Sonraki</button></div></div></section>';
  const host = $('#currentStatementRows');
  let offset = 0,
    version = '',
    data;
  const filters = () => ({ id, from: $('#currentFrom').value, to: $('#currentTo').value });
  const load = async (reset = false) => {
    if (reset) {
      offset = 0;
      version = '';
    }
    currentAccountRequest?.abort();
    const request = new AbortController();
    currentAccountRequest = request;
    $('#currentStatementTotals').textContent = 'Ekstre hazırlanıyor…';
    try {
      data = await currentAccountApi(
        '/statement?' + new URLSearchParams({ ...filters(), offset, version, limit: 50 }),
        'GET',
        undefined,
        request.signal,
      );
      if (!host.isConnected || currentAccountRequest !== request) return;
      version = data.version;
      $('#currentStatementTitle').textContent = data.party.name + ' · Cari Ekstresi';
      $('#currentStatementTotals').textContent =
        'Dönem başı: ' +
        currentAccountMoney(data.totals.opening) +
        ' · Dönem sonu: ' +
        currentAccountMoney(data.totals.closing) +
        ' · Güncel: ' +
        currentAccountBalance(data.totals.current);
      host.innerHTML =
        data.items
          .map(
            (e) =>
              `<tr><td>${esc(e.date ? displayDate(e.date) : 'Tarih yok')}</td><td>${esc(e.kind)}</td><td>${esc(e.note)}</td><td>${esc(e.account)}</td><td>${BigInt(e.signed) > 0n ? esc(currentAccountMoney(e.signed)) : '—'}</td><td>${BigInt(e.signed) < 0n ? esc(currentAccountMoney(-BigInt(e.signed))) : '—'}</td><td><strong>${esc(currentAccountMoney(e.balance))}</strong></td></tr>`,
          )
          .join('') || '<tr><td colspan="7" class="empty">Bu aralıkta hareket yok.</td></tr>';
      $('#currentStatementFoot').innerHTML =
        `<tr><td colspan="4"><strong>DÖNEM TOPLAMI</strong></td><td>${esc(currentAccountMoney(data.totals.debit))}</td><td>${esc(currentAccountMoney(data.totals.credit))}</td><td>${esc(currentAccountMoney(data.totals.closing))}</td></tr>`;
      $('#currentStatementCount').textContent =
        (data.count ? offset + 1 : 0) + '–' + (offset + data.items.length) + ' / ' + data.count;
      $('#currentStatementPrevious').disabled = offset === 0;
      $('#currentStatementNext').disabled = !data.more;
    } catch (error) {
      if (error.name !== 'AbortError' && host.isConnected)
        $('#currentStatementTotals').textContent = error.message;
    }
  };
  $('#currentStatementBack').onclick = currentAccountsPage;
  $('#currentStatementAdd').disabled = window.hanModuleAction?.('accounting', 'create') === false;
  $('#currentStatementAdd').onclick = () =>
    data && currentAccountManualForm(data.party, () => host.isConnected && load(true));
  $('#currentStatementEdit').disabled = window.hanModuleAction?.('accounting', 'update') === false;
  $('#currentStatementEdit').onclick = () =>
    data && currentAccountPartyForm(data.party, () => host.isConnected && load(true));
  $('#currentStatementFilter').onclick = () => load(true);
  $('#currentStatementClear').onclick = () => {
    for (const selector of ['#currentFrom', '#currentTo']) {
      const el = $(selector);
      el.value = '';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    load(true);
  };
  $('#currentStatementPrevious').onclick = () => {
    offset = Math.max(0, offset - 50);
    load();
  };
  $('#currentStatementNext').onclick = () => {
    if (data?.more) {
      offset += 50;
      load();
    }
  };
  $('#currentStatementExport').onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const response = await fetch(
        '/api/current-accounts/statement?' + new URLSearchParams({ ...filters(), export: 'csv' }),
        { credentials: 'same-origin', headers: { 'X-Han-Request': '1' } },
      );
      if (!response.ok) throw Error((await response.json()).error || 'Ekstre indirilemedi.');
      const url = URL.createObjectURL(await response.blob()),
        a = document.createElement('a');
      a.href = url;
      a.download = 'cari-ekstre-' + businessDate() + '.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  };
  load(true);
}
async function bindCurrentAccountCashField(form) {
  if (!['in', 'external', 'out'].includes(form.elements.type.value)) return;
  const label = document.createElement('label');
  label.className = 'field full';
  label.innerHTML =
    'Cari Hesap (isteğe bağlı)<select name="currentAccountId" data-optional="true" disabled><option value="">Cariye bağlama</option></select><small>Cari bakiyesine bağlanır; ayrıca para hareketi oluşturmaz.</small>';
  form.elements.note.closest('label').before(label);
  const select = label.querySelector('select');
  try {
    const data = await currentAccountApi('/options');
    if (!label.isConnected) return;
    for (const p of data.items) select.append(new Option(p.name, p.id));
    select.disabled = false;
  } catch (error) {
    if (label.isConnected)
      label.querySelector('small').textContent = 'Cari listesi alınamadı: ' + error.message;
  }
}
function currentAccountMovementMarkup(e) {
  const eligible =
    typeof e.linkable === 'boolean'
      ? e.linkable
      : ['in', 'out', 'externalOut'].includes(e.type) && !e.financeEventId && !e.expensePoolFunding;
  if (!eligible || !(e.ledgerEntryId || e.id)) return '';
  return `<button type="button" class="link" data-current-movement="${esc(e.id)}" style="display:block;margin-top:5px">${e.currentAccountId ? 'Cari Bağlantısını Düzenle' : 'Cariye Aktar'}</button>`;
}
function bindCurrentAccountMovementActions(rows) {
  document.querySelectorAll('[data-current-movement]').forEach((button) => {
    button.disabled = window.hanModuleAction?.('accounting', 'update') === false;
    button.onclick = () =>
      currentAccountLinkDialog(rows.find((e) => e.id === button.dataset.currentMovement));
  });
}
async function currentAccountLinkDialog(entry) {
  if (!entry) return;
  try {
    const data = await currentAccountApi('/options'),
      dialog = $('#modal');
    dialog.innerHTML =
      '<form><div class="panelhead"><h2>Cariye Aktar</h2><button type="button" class="secondary" data-current-close>Kapat</button></div><div class="formbody"><p>Mevcut para hareketine cari bağlantısı eklenir. Kasa ve gider tutarı tekrar işlenmez.</p><label class="field">Cari Hesap<select name="partyId" data-optional="true"><option value="">Cari bağlantısını kaldır / bağlama</option></select></label><p class="formerror" role="alert"></p></div><div class="actions"><button type="submit" class="primary">Bağlantıyı Kaydet</button></div></form>';
    const form = dialog.querySelector('form'),
      select = form.elements.partyId;
    for (const p of data.items) select.append(new Option(p.name, p.id));
    select.value = entry.currentAccountId || '';
    dialog.querySelector('[data-current-close]').onclick = () => dialog.close();
    let pending = false;
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (pending) return;
      pending = true;
      const button = form.querySelector('button.primary');
      button.disabled = true;
      try {
        await currentAccountApi('/link', 'POST', {
          entryId: entry.ledgerEntryId || entry.id,
          partyId: select.value,
          expectedPartyId: entry.currentAccountId || '',
        });
        window.modalFormSaved?.(form);
        dialog.close();
        toast('Cari bağlantısı kaydedildi.');
        accountingPage();
      } catch (error) {
        form.querySelector('.formerror').textContent = error.message;
      } finally {
        pending = false;
        button.disabled = false;
      }
    };
    if (!dialog.open) dialog.showModal();
  } catch (error) {
    toast(error.message);
  }
}
