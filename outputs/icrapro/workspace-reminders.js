function startCollectionNotices() {
  return startWorkspaceNotifications();
}
function pollCollectionNotices() {
  return pollWorkspaceNotifications();
}

function showNextCollectionNotice() {
  if (hanAuth?.activeBreak) return;
  if (collectionNoticeShowing || !collectionNoticeQueue.length) return;
  collectionNoticeShowing = true;
  const notice = collectionNoticeQueue.shift();
  if (notice.workflow) {
    showWorkflowReceipt(notice);
    return;
  }
  const host = document.createElement('div');
  host.className =
    'collection-receipt ' + (notice.closes ? 'collection-receipt-closed' : 'collection-receipt-partial');
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  host.innerHTML = `<div class="receipt-brand">HANHUKUK · TAHSİLAT</div><div class="receipt-rule"></div><strong>${notice.closes ? 'DOSYA İNFAZ EDİLDİ' : 'KISMİ ÖDEME'}</strong><div class="receipt-amount">${money(notice.amount / 100)}</div><p>${esc(notice.operatorName)} personeli ${money(notice.amount / 100)} tahsilat yapmıştır.</p><b>${notice.closes ? 'Tebrikler, teşekkürler!' : 'Tebrikler!'}</b><small>${messageTimestamp(notice.createdAt)}</small><div class="receipt-rule"></div><div class="receipt-barcode">▌▏▎▍▌▎▏▌▍▎▌▏▎▍▌</div>`;
  document.body.append(host);
  if (host.showPopover)
    try {
      host.setAttribute('popover', 'manual');
      host.showPopover();
    } catch {
      host.removeAttribute('popover');
    }
  setTimeout(() => {
    host.remove();
    collectionNoticeShowing = false;
    showNextCollectionNotice();
  }, 10000);
}

function paymentPromiseButton(d) {
  return `<button type="button" class="secondary" data-payment-promise="${esc(d.id)}" ${['İnfaz', 'İade'].includes(d.status) ? 'disabled' : ''}>Ödeme Sözü</button>`;
}

function paymentPromiseSummary(d) {
  const p = d.paymentPromise;
  return p
    ? `<div class="notice" style="margin:16px 0"><b>Ödeme Sözü:</b> ${esc(displayDate(p.date))} · ${money(p.amount / 100)}<p class="message-text">${esc(p.description)}</p><small>Son güncelleyen: ${esc(p.updatedByName || '—')} · ${p.updatedAt ? messageTimestamp(p.updatedAt) : ''}</small></div>`
    : '';
}

function bindPaymentPromise(d, root) {
  root?.querySelector('[data-payment-promise]')?.addEventListener('click', () => openPaymentPromise(d.id));
}

function openPaymentPromise(id, options = {}) {
  let context;
  try {
    context = authApi('/api/payment-promises/context?documentId=' + encodeURIComponent(id));
  } catch (error) {
    return toast(error.message);
  }
  const d = context.document,
    p = d.paymentPromise;
  let dialog = document.getElementById('paymentPromiseDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'paymentPromiseDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML = `<form id="paymentPromiseForm"><div class="panelhead"><div><h2>Ödeme Sözü</h2><p>${esc(d.debtor)} · ${esc(d.number)}</p></div><button type="button" class="secondary" id="closePaymentPromise">Kapat</button></div><div class="formbody grid">${field('Ödeme Tarihi', 'date', 'date', p?.date || businessDate(), true)}${field('Ödeme Tutarı (TL)', 'amount', 'number', p ? p.amount / 100 : '', true)}<label class="field full">Açıklama<textarea name="description" rows="4" maxlength="3000" required>${esc(p?.description || '')}</textarea></label><p class="full">Ödeme sözü tahsilat kaydı oluşturmaz. Tarihi gelen ve henüz karşılanmayan sözler dosya sorumlusunun ana sayfasında görünür.</p></div><div class="actions"><button class="primary" type="submit">${p ? 'Ödeme Sözünü Güncelle' : 'Ödeme Sözünü Kaydet'}</button></div></form>`;
  $('#closePaymentPromise').onclick = () => dialog.close();
  const form = $('#paymentPromiseForm');
  form.elements.date.max = new Date(Date.parse(businessDate() + 'T00:00:00Z') + 30 * 86400000)
    .toISOString()
    .slice(0, 10);
  form.onsubmit = (e) => {
    e.preventDefault();
    try {
      const value = Object.fromEntries(new FormData(form));
      value.documentId = id;
      value.previousId = p?.id || '';
      value.amount = financeCents(value.amount);
      const result = authApi('/api/payment-promises', 'POST', value);
      const record = db.docs.find((x) => x.id === id);
      if (record) record.paymentPromise = result.promise;
      d.paymentPromise = result.promise;
      dialog.close();
      if (options.onSaved) {
        options.onSaved(result.promise);
      } else {
        const parent = document.getElementById('borrowerDetail');
        if (parent?.open) borrowerDetail(id);
        else if (document.getElementById('modal')?.open) staffBorrowerDetail(id, d);
      }
      if (page === 'home') loadPaymentPromisesHome();
      toast('Ödeme sözü kaydedildi.');
    } catch (error) {
      toast(error.message);
    }
  };
  dialog.showModal();
}

function loadPaymentPromisesHome() {
  loadDueInstallmentsHome();
  loadCallRemindersHome();
  let host = document.getElementById('paymentPromisesHome');
  if (!host) {
    host = document.createElement('section');
    host.id = 'paymentPromisesHome';
    host.className = 'panel';
    host.style.marginTop = '22px';
    document.getElementById('content').append(host);
  }
  let result;
  try {
    result = authApi('/api/payment-promises');
  } catch (error) {
    host.textContent = error.message;
    return;
  }
  host.innerHTML = `<div class="panelhead"><div><h2>Ödeme Sözü Veren Borçlularım</h2><p>Bugün veya daha önce ödeme sözü vermiş, size atanmış dosyalar.</p></div><button class="secondary" id="refreshPaymentPromises">Yenile</button></div><div class="overflow"><table><thead><tr><th>BORÇLU / EVRAK</th><th>ÖDEME TARİHİ</th><th>SÖZ VERİLEN</th><th>KARŞILANMAYAN</th><th>AÇIKLAMA</th></tr></thead><tbody>${result.rows.map((r) => `<tr><td><button class="link" data-promise-borrower="${esc(r.documentId)}">${esc(r.debtor)}</button><small>${esc(r.number)}</small></td><td>${esc(displayDate(r.date))}${r.date < result.today ? ' · Gecikmiş' : ''}</td><td>${money(r.amount / 100)}</td><td>${money(r.remaining / 100)}</td><td class="conversation-note">${esc(r.description)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Tarihi gelmiş bekleyen ödeme sözü yok.</td></tr>'}</tbody></table></div>`;
  $('#refreshPaymentPromises').onclick = loadPaymentPromisesHome;
  host
    .querySelectorAll('[data-promise-borrower]')
    .forEach((button) => (button.onclick = () => openPromiseBorrower(button.dataset.promiseBorrower)));
}

function openPromiseBorrower(id) {
  if (window.hanRecordsEnabled) return recordAction(id, () => borrowerDetail(id));
  try {
    const context = authApi('/api/payment-promises/context?documentId=' + encodeURIComponent(id)),
      d = db.docs.find((x) => x.id === id);
    if (d) {
      Object.assign(d, context.document);
      borrowerDetail(id);
    } else staffBorrowerDetail(id, context.document);
  } catch (error) {
    toast(error.message);
  }
}

function startWorkflowNotices() {
  return startWorkspaceNotifications();
}
function pollWorkflowNotices() {
  return pollWorkspaceNotifications();
}

function showWorkflowReceipt(notice) {
  const host = document.createElement('div');
  host.className = 'collection-receipt workflow-receipt workflow-' + notice.type;
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  const breakNotice = ['breakStarted', 'breakEnded'].includes(notice.type);
  host.innerHTML = `<div class="receipt-brand">HANHUKUK · ${breakNotice ? 'MOLA BİLDİRİMİ' : 'DOSYA BİLDİRİMİ'}</div><div class="receipt-rule"></div><strong>${notice.type === 'breakStarted' ? 'MOLAYA ÇIKTI' : notice.type === 'breakEnded' ? 'MOLA BİTTİ' : notice.type === 'noCallWarning' ? 'ARAMA HATIRLATMASI' : notice.type === 'fileWon' ? 'YENİ DOSYA' : notice.type === 'fileLost' ? 'DOSYA DEVRİ' : 'SORUMLU DEĞİŞİKLİĞİ'}</strong><p>${esc(notice.text)}</p>${!breakNotice && notice.type !== 'fileLost' ? '<button type="button" class="secondary" data-workflow-open>Föyü Aç</button>' : ''}<small>${messageTimestamp(notice.createdAt)}</small><div class="receipt-rule"></div><div class="receipt-barcode">▌▏▎▍▌▎▏▌▍▎▌▏▎▍▌</div>`;
  document.body.append(host);
  if (host.showPopover)
    try {
      host.setAttribute('popover', 'manual');
      host.showPopover();
    } catch {
      host.removeAttribute('popover');
    }
  host.querySelector('[data-workflow-open]')?.addEventListener('click', () => {
    host.remove();
    openPromiseBorrower(notice.documentId);
  });
  fetch('/api/workflow-notices/ack', {
    method: 'POST',
    headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [notice.id] }),
  }).catch(() => {});
  setTimeout(
    () => {
      host.remove();
      collectionNoticeShowing = false;
      showNextCollectionNotice();
    },
    breakNotice ? 5000 : 10000,
  );
}

function bindStaffConversation(d, dialog) {
  bindLoggedInConversation(d, dialog);
}

function bindLoggedInConversation(d, root) {
  if (root) bindConversationResultFilter(root);
  const form = root?.querySelector('#borrowerConversationForm');
  if (!form) return;
  form.elements.staff.value = hanAuth.name;
  form.elements.staff.readOnly = true;
  bindConversationReport(d, form);
  let promiseId = '',
    callReminder = null;
  function collectCallReminder() {
    openCallReminder(d, (r) => {
      callReminder = r;
      let info = form.querySelector('[data-call-reminder]');
      if (!info) {
        info = document.createElement('p');
        info.dataset.callReminder = 'true';
        info.className = 'notice';
        form.append(info);
      }
      info.textContent = 'Tekrar arama: ' + displayDate(r.date) + ' · ' + r.time + ' · ' + r.note;
    });
  }
  function collectPromise() {
    openPaymentPromise(d.id, {
      onSaved: (promise) => {
        promiseId = promise.id;
        d.paymentPromise = promise;
        let info = form.querySelector('[data-conversation-promise]');
        if (!info) {
          info = document.createElement('p');
          info.dataset.conversationPromise = 'true';
          info.className = 'notice';
          form.append(info);
        }
        info.textContent =
          'Ödeme sözü kaydedildi: ' +
          displayDate(promise.date) +
          ' · ' +
          money(promise.amount / 100) +
          '. Görüşmeyi kaydedebilirsiniz.';
      },
    });
  }
  form.elements.result.addEventListener('change', () => {
    promiseId = '';
    callReminder = null;
    form.querySelector('[data-call-reminder]')?.remove();
    if (form.elements.result.value === 'Tekrar Aranacak') collectCallReminder();
    form.querySelector('[data-conversation-promise]')?.remove();
    if (form.elements.result.value === 'Ödeme Sözü Alındı') collectPromise();
  });
  form.onsubmit = (e) => {
    e.preventDefault();
    if (form.elements.result.value === 'Tekrar Aranacak' && !callReminder) {
      collectCallReminder();
      return;
    }
    if (form.elements.result.value === 'Ödeme Sözü Alındı' && !promiseId) {
      collectPromise();
      return;
    }
    try {
      const result = authApi('/api/documents/conversations', 'POST', {
        ...Object.fromEntries(new FormData(form)),
        documentId: d.id,
        paymentPromiseId: promiseId,
        callReminder,
      });
      d.conversations = result.conversations;
      delete d.conversationReport;
      const record = db.docs.find((x) => x.id === d.id);
      if (record) {
        record.conversations = result.conversations;
        delete record.conversationReport;
      }
      if (['ceo', 'admin'].includes(hanAuth.role)) borrowerDetail(d.id, form);
      else staffBorrowerDetail(d.id, d);
      toast('Görüşme kaydedildi.', root.querySelector('#borrowerConversationForm') || root);
    } catch (error) {
      toast(error.message);
    }
  };
}

function openCallReminder(d, onSaved) {
  let dialog = document.getElementById('callReminderDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'callReminderDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML =
    '<form id="callReminderForm"><div class="panelhead"><div><h2>Tekrar Arama Planla</h2><p>' +
    esc(d.debtor) +
    ' · ' +
    esc(d.number) +
    '</p></div><button type="button" class="secondary" id="closeCallReminder">Kapat</button></div><div class="formbody grid">' +
    field('Arama Tarihi', 'date', 'date', businessDate(), true) +
    field('Arama Saati', 'time', 'time', '', true) +
    '<label class="field full">Arama Notu<textarea name="note" rows="3" data-optional="true" maxlength="3000"></textarea></label></div><div class="actions"><button class="primary">Arama Planını Onayla</button></div></form>';
  dialog.querySelector('#closeCallReminder').onclick = () => dialog.close();
  dialog.querySelector('form').onsubmit = (e) => {
    e.preventDefault();
    const r = Object.fromEntries(new FormData(e.target)),
      now = conversationNow();
    if (r.date + 'T' + r.time <= now.date + 'T' + now.time)
      return toast('Gelecek bir arama tarihi ve saati seçin.', dialog);
    dialog.close();
    onSaved(r);
  };
  dialog.showModal();
}

function loadCallRemindersHome() {
  if (typeof page === 'undefined' || page !== 'home') return;
  if (hanAuth?.role === 'ceo') {
    document.getElementById('callRemindersHome')?.remove();
    return;
  }
  let result;
  try {
    result = authApi('/api/call-reminders');
  } catch {
    return;
  }
  let host = document.getElementById('callRemindersHome');
  if (!host) {
    host = document.createElement('section');
    host.id = 'callRemindersHome';
    host.className = 'panel call-reminders-home';
    document.getElementById('content').prepend(host);
  }
  const allRows = result.rows,
    isManager = ['ceo', 'admin'].includes(hanAuth.role);
  if (isManager && callReminderStaffFilter)
    result.rows = allRows.filter((r) => (r.staffId || 'unassigned') === callReminderStaffFilter);
  const staffChoices = [
    ...new Map(allRows.map((r) => [r.staffId || 'unassigned', r.staffName || 'Atanmamış'])).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1], 'tr'));
  host.innerHTML =
    '<div class="panelhead"><div><h2>Arama Hatırlatmaları (' +
    result.rows.length +
    ')</h2><p>' +
    (['ceo', 'admin'].includes(hanAuth.role)
      ? 'Tüm personellerin tarihi ve saati gelen bekleyen aramaları.'
      : 'Tarihi ve saati gelen bekleyen aramalarınız.') +
    '</p></div>' +
    (isManager
      ? '<label class="field">Dosya Sorumlusuna Göre Süz<select id="callReminderStaffFilter" data-optional="true"><option value="">Tüm Personeller</option>' +
        staffChoices
          .map(
            ([id, name]) =>
              '<option value="' +
              esc(id) +
              '" ' +
              (callReminderStaffFilter === id ? 'selected' : '') +
              '>' +
              esc(name) +
              '</option>',
          )
          .join('') +
        '</select></label>'
      : '') +
    '</div><div class="formbody">' +
    (result.rows
      .map(
        (r) =>
          '<article class="call-reminder-card"><button class="link" data-call-open="' +
          esc(r.documentId) +
          '"><strong>' +
          esc(r.debtor) +
          '</strong> · ' +
          esc(r.number) +
          '</button><b>' +
          esc(displayDate(r.date)) +
          ' ' +
          esc(r.time) +
          '</b>' +
          (['ceo', 'admin'].includes(hanAuth.role)
            ? '<p><strong>Dosya Sorumlusu:</strong> ' +
              esc(r.staffName) +
              ' · <strong>Planlayan:</strong> ' +
              esc(r.createdByName || '—') +
              '</p>'
            : '') +
          '<p>' +
          esc(r.note) +
          '</p><button type="button" class="secondary" data-call-done="' +
          esc(r.conversationId) +
          '" data-document="' +
          esc(r.documentId) +
          '">Arama Tamamlandı</button></article>',
      )
      .join('') || '<p>Şu an zamanı gelmiş bekleyen arama yok.</p>') +
    '</div>';
  if (isManager) {
    const select = host.querySelector('#callReminderStaffFilter');
    if (callReminderStaffFilter && !staffChoices.some(([id]) => id === callReminderStaffFilter))
      select.add(new Option('Seçilen personel (bekleyen arama yok)', callReminderStaffFilter, true, true));
    select.onchange = () => {
      callReminderStaffFilter = select.value;
      loadCallRemindersHome();
    };
  }
  host
    .querySelectorAll('[data-call-open]')
    .forEach((b) => (b.onclick = () => openPromiseBorrower(b.dataset.callOpen)));
  host.querySelectorAll('[data-call-done]').forEach(
    (b) =>
      (b.onclick = () => {
        try {
          authApi('/api/call-reminders/done', 'POST', {
            documentId: b.dataset.document,
            conversationId: b.dataset.callDone,
          });
          loadCallRemindersHome();
          toast('Arama tamamlandı olarak kaydedildi.');
        } catch (error) {
          toast(error.message);
        }
      }),
  );
}

function loadDueInstallmentsHome() {
  if (typeof page === 'undefined' || page !== 'home') return;
  let result;
  try {
    result = authApi('/api/due-installments');
  } catch {
    return;
  }
  let host = document.getElementById('dueInstallmentsHome');
  if (!host) {
    host = document.createElement('section');
    host.id = 'dueInstallmentsHome';
    host.className = 'panel due-installments-home';
    document.getElementById('content').prepend(host);
  }
  if (hanAuth?.id === 'ef14702a-dcc8-49a6-b88e-ae8311fb5a77') {
    const overview = document.getElementById('dashboardFinanceOverview');
    if (overview) {
      overview.after(host);
      host.style.marginTop = '22px';
    }
  }
  const manager = ['ceo', 'admin'].includes(hanAuth.role);
  host.innerHTML =
    '<div class="panelhead"><div><h2>Vadesi Gelen Taksitler (' +
    result.rows.length +
    ')</h2><p>' +
    (manager ? 'Tüm personellerin dosyalarındaki' : 'Size atanmış dosyalardaki') +
    ' bugün ve daha önce vadesi gelen ödenmemiş taksitler.</p></div></div><div class="overflow"><table><thead><tr><th>BORÇLU / FÖY</th>' +
    (manager ? '<th>DOSYA SORUMLUSU</th>' : '') +
    '<th>TAKSİT</th><th>VADE</th><th>TUTAR</th><th>ÖDENEN</th><th>KALAN</th></tr></thead><tbody>' +
    (result.rows
      .map(
        (r) =>
          '<tr><td><button type="button" class="link" data-installment-borrower="' +
          esc(r.documentId) +
          '">' +
          esc(r.debtor) +
          '</button><small>' +
          esc(r.number) +
          '</small></td>' +
          (manager ? '<td>' + esc(r.staffName) + '</td>' : '') +
          '<td>' +
          esc(r.sequence) +
          '</td><td>' +
          esc(displayDate(r.due)) +
          (r.due < result.today ? ' · Gecikmiş' : ' · Bugün') +
          '</td><td>' +
          money(r.amount / 100) +
          '</td><td>' +
          money(r.paid / 100) +
          '</td><td><strong>' +
          money(r.remaining / 100) +
          '</strong></td></tr>',
      )
      .join('') ||
      '<tr><td colspan="' +
        (manager ? 7 : 6) +
        '" class="empty">Vadesi gelen ödenmemiş taksit yok.</td></tr>') +
    '</tbody><tfoot><tr><td colspan="' +
    (manager ? 6 : 5) +
    '">TOPLAM KALAN</td><td><strong>' +
    money(result.rows.reduce((sum, r) => sum + r.remaining, 0) / 100) +
    '</strong></td></tr></tfoot></table></div>';
  host
    .querySelectorAll('[data-installment-borrower]')
    .forEach((b) => (b.onclick = () => openPromiseBorrower(b.dataset.installmentBorrower)));
}
