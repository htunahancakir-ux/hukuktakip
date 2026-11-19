async function externalOutApi(path = '', method = 'GET', value) {
  const response = await fetch('/api/external-out' + path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Harici çıkış işlemi tamamlanamadı.');
  if (result.accountBalances) window.hanAccountBalances = result.accountBalances;
  return result;
}
function mountCashOutTabs(form, selected) {
  const tabs = document.createElement('div');
  tabs.className = 'settings-tabs full';
  tabs.dataset.cashOutTabs = '';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Para çıkışı türü');
  tabs.innerHTML = ['expense', 'external']
    .map(
      (key, i) =>
        '<button type="button" role="tab" data-cash-out-tab="' +
        key +
        '" aria-selected="' +
        (selected === key) +
        '" class="' +
        (selected === key ? 'selected' : '') +
        '">' +
        (i ? 'Harici Para Çıkışı' : 'Para Çıkışı') +
        '</button>',
    )
    .join('');
  const header = form.querySelector('.panelhead');
  if (header) {
    tabs.style.padding = '16px 24px 0';
    header.after(tabs);
  } else form.elements.type.closest('label').after(tabs);
  tabs.querySelector('[data-cash-out-tab="external"]').onclick = () => {
    if (selected !== 'external') externalOutForm();
  };
  tabs.querySelector('[data-cash-out-tab="expense"]').onclick = () => {
    if (selected === 'expense') return;
    if (window.hanAuth?.role === 'staff' && !window.hanAuth.accountingAccess) {
      $('#modal').close();
      staffAccounting();
      const staffForm = $('#staffCashForm');
      staffForm.elements.type.value = 'out';
      staffForm.elements.type.dispatchEvent(new Event('change', { bubbles: true }));
    } else cashEntryForm('out');
  };
}
function externalOutForm() {
  const dialog = $('#modal'),
    id = crypto.randomUUID();
  dialog.innerHTML = `<form id="externalOutForm"><div class="panelhead"><div><h2>Harici Para Çıkışı</h2><p>CEO onayladığında seçilen kasa veya bankadan otomatik düşer.</p></div><button type="button" class="secondary" data-external-close>Kapat</button></div><div class="formbody grid"><input type="hidden" name="type" value="out"><label class="field">Paranın Çıkacağı Kasa / Banka *<select name="accountId" required>${accountOptions()}</select></label>${field('İşlem Tarihi', 'date', 'date', businessDate(), true)}${field('Tutar (TL)', 'amount', 'number', '', true)}<label class="field">Kâr Seçimi *<select name="profitChoice" required><option value="">Seçin</option><option value="yes">Kârdan Düş</option><option value="no">Kârdan Düşme</option></select></label>${field('Açıklama', 'note', 'text', '', true, true)}<p class="full">Gider kalemi seçilmez ve gider raporuna dahil edilmez. Kârdan Düş seçilirse çıkış tutarı kârı azaltır. CEO onayına kadar kasa/banka bakiyesi değişmez.</p><p class="full formerror" role="alert"></p></div><div class="actions"><button type="button" class="secondary" data-external-history>Taleplerim</button><button type="submit" class="primary">CEO Onayına Gönder</button></div></form>`;
  const form = dialog.querySelector('form');
  mountCashOutTabs(form, 'external');
  if (typeof bindCurrentAccountCashField === 'function') bindCurrentAccountCashField(form);
  dialog.querySelector('[data-external-close]').onclick = () => dialog.close();
  dialog.querySelector('[data-external-history]').onclick = () => {
    dialog.close();
    externalOutRequestsPage();
  };
  let pending = false;
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending || !form.reportValidity()) return;
    pending = true;
    const button = form.querySelector('button.primary');
    button.disabled = true;
    try {
      const value = Object.fromEntries(new FormData(form));
      value.amount = financeCents(value.amount);
      await externalOutApi('/request', 'POST', { ...value, id });
      window.modalFormSaved?.(form);
      dialog.close();
      toast('Harici çıkış talebi CEO onayına gönderildi.');
      externalOutRequestsPage();
    } catch (error) {
      form.querySelector('.formerror').textContent = error.message;
    } finally {
      pending = false;
      button.disabled = false;
    }
  };
  if (!dialog.open) dialog.showModal();
}
function externalOutRequestsPage(initialStatus = '') {
  const ceo = window.hanAuth?.role === 'ceo';
  $('#content').innerHTML =
    `<section class="panel"><div class="panelhead"><div><h2>${ceo ? 'Onay Bekleyenler' : 'Harici Çıkış Taleplerim'}</h2><p>Onaylanan tutar kasadan çıkar. Gider raporuna dahil edilmez; kâr tercihi talepte gösterilir.</p></div><button type="button" class="secondary" id="externalOutBack">${ceo ? 'Ana Sayfa' : 'Kasa / Banka'}</button></div><div class="formbody toolbar"><label class="field">Durum<select id="externalOutStatus" data-optional="true"><option value="">Tümü</option><option value="pending">Onay Bekliyor</option><option value="approved">Onaylandı</option><option value="rejected">Reddedildi</option></select></label><button type="button" class="secondary" id="externalOutRefresh">Yenile</button><button type="button" class="primary" id="externalOutNew">Yeni Harici Çıkış</button></div><p class="formbody" id="externalOutMessage" role="status"></p><div class="overflow"><table><thead><tr><th>TARİH</th><th>TALEP EDEN</th><th>KASA / BANKA</th><th>CARİ</th><th>TUTAR</th><th>KÂR TERCİHİ</th><th>AÇIKLAMA</th><th>DURUM</th><th></th></tr></thead><tbody id="externalOutRows"></tbody></table></div><div class="tablefoot"><span id="externalOutCount"></span><div class="toolbar"><button class="secondary" id="externalOutPrevious">Önceki</button><button class="secondary" id="externalOutNext">Sonraki</button></div></div></section>`;
  const host = $('#externalOutRows');
  let offset = 0,
    data,
    loading = 0;
  $('#externalOutStatus').value = initialStatus;
  async function load() {
    const token = ++loading;
    $('#externalOutMessage').textContent = 'Talepler yükleniyor…';
    try {
      const result = await externalOutApi(
        '?' + new URLSearchParams({ offset, status: $('#externalOutStatus').value }),
      );
      if (!host.isConnected || token !== loading) return;
      data = result;
      const labels = { pending: 'Onay Bekliyor', approved: 'Onaylandı', rejected: 'Reddedildi' };
      host.innerHTML =
        data.items
          .map(
            (r) =>
              `<tr><td>${esc(displayDate(r.date))}</td><td>${esc(r.requestedByName)}</td><td>${esc(r.accountName)}</td><td>${esc(r.currentAccountName || '—')}</td><td>${esc(currentAccountMoney(r.amount))}</td><td>${r.includeInProfit ? 'Kârdan Düş' : 'Kârdan Düşme'}</td><td>${esc(r.note)}</td><td>${esc(labels[r.status] || r.status)}${r.decidedByName ? '<br><small>' + esc(r.decidedByName) + '</small>' : ''}</td><td>${ceo && r.status === 'pending' ? '<button type="button" class="primary" data-external-approve="' + esc(r.id) + '">Onayla</button> <button type="button" class="secondary" data-external-reject="' + esc(r.id) + '">Reddet</button>' : '—'}</td></tr>`,
          )
          .join('') || '<tr><td colspan="9" class="empty">Talep bulunamadı.</td></tr>';
      $('#externalOutMessage').textContent = '';
      $('#externalOutCount').textContent =
        (data.count ? offset + 1 : 0) + '–' + (offset + data.items.length) + ' / ' + data.count;
      $('#externalOutPrevious').disabled = offset === 0;
      $('#externalOutNext').disabled = !data.more;
      $('#externalOutNew').hidden = !data.mayRequest;
      for (const button of host.querySelectorAll('[data-external-approve],[data-external-reject]'))
        button.onclick = async () => {
          const id = button.dataset.externalApprove || button.dataset.externalReject;
          const row = data.items.find((r) => r.id === id),
            action = button.dataset.externalApprove ? 'approve' : 'reject';
          if (
            !confirm(
              action === 'approve'
                ? `${row.accountName} hesabından ${currentAccountMoney(row.amount)} çıkışı onaylansın mı? ${row.includeInProfit ? 'Kârdan düşülecek.' : 'Kârı etkilemeyecek.'}`
                : 'Harici çıkış talebi reddedilsin mi?',
            )
          )
            return;
          for (const b of host.querySelectorAll('button')) b.disabled = true;
          try {
            await externalOutApi('/decide', 'POST', { id, action });
            toast(action === 'approve' ? 'Onaylandı; para çıkışı kaydedildi.' : 'Talep reddedildi.');
            if (host.isConnected) load();
          } catch (error) {
            if (host.isConnected) {
              $('#externalOutMessage').textContent = error.message;
              for (const b of host.querySelectorAll('button')) b.disabled = false;
            }
          }
        };
    } catch (error) {
      if (host.isConnected) $('#externalOutMessage').textContent = error.message;
    }
  }
  $('#externalOutBack').onclick = () => {
    if (ceo) {
      page = 'home';
      render();
    } else accountingPage();
  };
  $('#externalOutStatus').onchange = () => {
    offset = 0;
    load();
  };
  $('#externalOutRefresh').onclick = load;
  $('#externalOutNew').onclick = externalOutForm;
  $('#externalOutPrevious').onclick = () => {
    offset = Math.max(0, offset - 50);
    load();
  };
  $('#externalOutNext').onclick = () => {
    if (data?.more) {
      offset += 50;
      load();
    }
  };
  load();
}
function mountExternalOutApprovals(host) {
  if (window.hanAuth?.role !== 'ceo') return;
  const section = document.createElement('section');
  section.className = 'panel';
  section.style.marginBottom = '18px';
  section.innerHTML =
    '<div class="panelhead"><div><h2>CEO Onayları</h2><p>Harici para çıkışı talepleri</p></div><button type="button" class="primary">Onay Bekleyenler</button></div>';
  const button = section.querySelector('button');
  button.onclick = () => externalOutRequestsPage('pending');
  host.prepend(section);
  const update = async () => {
    try {
      const data = await externalOutApi('?status=pending');
      if (button.isConnected) button.textContent = 'Onay Bekleyenler (' + data.count + ')';
    } catch {}
  };
  update();
  const timer = setInterval(() => {
    if (!button.isConnected) clearInterval(timer);
    else if (document.visibilityState === 'visible') update();
  }, 30000);
}
