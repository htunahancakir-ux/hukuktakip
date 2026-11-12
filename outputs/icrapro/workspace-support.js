// Destek: everyone who is signed in can write to the product's support team from inside the
// application and read the replies (managers see all of the office's tickets, others their own).
// Managers (CEO / admin) can also let the support team into the office for a short, time-limited
// session; the strip that shows an open session lives in workspace-support-access.js. Tickets
// live on the platform side; this screen only talks to /api/support and /api/support-access.
// Everything the user or the support team typed is shown as text.
const SUPPORT_CATEGORIES = [
  ['technical', 'Teknik sorun'],
  ['billing', 'Fatura / ödeme'],
  ['how_to', 'Nasıl yapılır?'],
  ['feature_request', 'Özellik isteği'],
  ['other', 'Diğer'],
];
const SUPPORT_PRIORITIES = [
  ['low', 'Düşük'],
  ['normal', 'Normal'],
  ['high', 'Yüksek'],
];
const SUPPORT_STATUS = {
  open: 'Destek ekibi inceliyor',
  waiting_customer: 'Yanıtınız bekleniyor',
  resolved: 'Çözüldü',
  closed: 'Kapatıldı',
};
const SUPPORT_ACCESS_MINUTES = [
  [15, '15 dk'],
  [30, '30 dk'],
  [60, '1 saat'],
];

function supportLabel(list, key) {
  return (list.find(([id]) => id === key) || [key, key])[1];
}

// Only the office's managers decide who may enter the office; the server enforces it too.
function supportIsManager() {
  return ['ceo', 'admin'].includes(hanAuth?.role);
}

function supportMinutesLabel(minutes) {
  return supportLabel(
    SUPPORT_ACCESS_MINUTES.map(([id, label]) => [String(id), label]),
    String(minutes),
  );
}

function supportTicketsTable(tickets) {
  const rows = tickets
    .map(
      (t) =>
        `<tr><td>#${esc(t.number)}</td><td>${esc(t.subject)}</td><td>${esc(supportLabel(SUPPORT_CATEGORIES, t.category))}</td><td>${esc(SUPPORT_STATUS[t.status] || t.status)}</td><td>${esc(new Date(t.updatedAt).toLocaleString('tr-TR'))}</td><td><button type="button" class="link" data-support-open="${esc(t.id)}">Aç</button></td></tr>`,
    )
    .join('');
  return `<div class="tablewrap"><table><thead><tr><th>No</th><th>Konu</th><th>Kategori</th><th>Durum</th><th>Son işlem</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty">Henüz destek kaydınız yok.</td></tr>'}</tbody></table></div>`;
}

function supportSettingsPage() {
  let data;
  try {
    data = authApi('/api/support');
  } catch (error) {
    return toast(error.message);
  }
  $('#content').innerHTML = `${settingsSectionTabs('support')}<section class="panel">
    <div class="panelhead"><div><h2>Destek</h2><p>Bir sorun yaşarsanız veya bir şey öğrenmek isterseniz destek ekibine buradan yazın; yanıtı da burada görürsünüz.</p></div><button class="primary" type="button" id="supportNew">＋ Yeni Destek Kaydı</button></div>
    <div class="notice">Lütfen kayıtlara müvekkil adı, dosya numarası veya kimlik bilgisi yazmayın. Gerekirse destek ekibi sizden ayrıca ister.</div>
    ${supportTicketsTable(data.tickets)}
  </section>`;
  bindSettingsSectionTabs();
  $('#supportNew').onclick = () => supportNewDialog();
  document.querySelectorAll('[data-support-open]').forEach((button) => {
    button.onclick = () => supportTicketDialog(button.dataset.supportOpen);
  });
}

// The same list in a dialog, for people who cannot open Ayarlar (staff) and for the header
// button. Opening a record or the new-record form from here returns to this list with "Geri".
function supportListDialog() {
  let data;
  try {
    data = authApi('/api/support');
  } catch (error) {
    return toast(error.message);
  }
  const dialog =
    supportDialog(`<div class="panelhead"><div><h2>Destek</h2><p>${data.manager ? 'Büronuzun destek kayıtları.' : 'Açtığınız destek kayıtları.'} Destek ekibinin yanıtını da burada görürsünüz.</p></div><button type="button" class="secondary" data-support-close>Kapat</button></div>
    <div class="formbody"><div class="notice">Lütfen kayıtlara müvekkil adı, dosya numarası veya kimlik bilgisi yazmayın.</div>${supportTicketsTable(data.tickets)}</div>
    <div class="actions"><button class="primary" type="button" id="supportListNew">＋ Yeni Destek Kaydı</button></div>`);
  dialog.querySelector('#supportListNew').onclick = () => supportNewDialog(supportListDialog);
  dialog.querySelectorAll('[data-support-open]').forEach((button) => {
    button.onclick = () => supportTicketDialog(button.dataset.supportOpen, supportListDialog);
  });
}

// Header entry for everyone who is signed in except the support team's own account.
function setupSupportButton() {
  if (globalThis.hanModules?.['supportDesk'] !== true || !window.hanAuth || hanAuth.platformSupport === true)
    return;
  if (document.getElementById('supportButton')) return;
  const actions = document.querySelector('.header-actions');
  if (!actions) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'supportButton';
  button.className = 'support-button';
  button.title = 'Destek ekibine yazın';
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.25c-.7.35-1.1.9-1.1 1.75"/><path d="M12 17h.01"/></svg><span>Destek</span>';
  button.onclick = () => supportListDialog();
  actions.insertBefore(button, document.getElementById('notificationBell') || actions.firstChild);
}

function supportDialog(html, { back } = {}) {
  let dialog = document.getElementById('supportDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'supportDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML = html;
  dialog.querySelector('[data-support-close]').onclick = () => (back ? back() : dialog.close());
  if (!dialog.open) dialog.showModal();
  return dialog;
}

// Duration and "may change things" for a support access grant; used by the new-record form and
// by the record's own access section. The text is fixed, nothing here comes from the server.
function supportAccessFields() {
  return `<label class="field">Erişim süresi<select name="grantMinutes" data-ignore-dirty>${SUPPORT_ACCESS_MINUTES.map(([id, label]) => `<option value="${id}" ${id === 30 ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
    <label class="settings-check"><input type="checkbox" name="grantEdit" data-ignore-dirty> Destek ekibi değişiklik yapabilsin</label>
    <p class="support-access-hint">İşaretlemezseniz yalnızca görüntüler. Silme işlemi hiçbir zaman yapamaz. Süre, destek ekibi büronuza ilk bağlandığında başlar.</p>`;
}

function readSupportAccessFields(form) {
  return {
    minutes: Number(form.elements.grantMinutes.value),
    allowEdit: form.elements.grantEdit.checked === true,
  };
}

function supportNewDialog(back) {
  const manager = supportIsManager();
  const dialog = supportDialog(
    `<form id="supportNewForm"><div class="panelhead"><h2>Yeni Destek Kaydı</h2><button type="button" class="secondary" data-support-close>${back ? 'Geri' : 'Kapat'}</button></div>
    <div class="formbody grid">
      <label class="field full">Konu<input name="subject" required minlength="3" maxlength="160"></label>
      <label class="field">Kategori<select name="category">${SUPPORT_CATEGORIES.map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join('')}</select></label>
      <label class="field">Öncelik<select name="priority">${SUPPORT_PRIORITIES.map(([id, label]) => `<option value="${id}" ${id === 'normal' ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
      <label class="field full">Açıklama<textarea name="body" required maxlength="5000" rows="6" placeholder="Ne yapmaya çalışıyordunuz, ne oldu?"></textarea></label>
      ${
        manager
          ? `<div class="support-access-options full"><label class="settings-check"><input type="checkbox" name="grantAccess"> Destek ekibinin büroma bağlanmasına izin ver</label>
        <div class="support-access-detail" id="supportAccessDetail" hidden>${supportAccessFields()}</div></div>`
          : ''
      }
      <p class="formerror full" role="alert" id="supportNewError"></p>
    </div><div class="actions"><button type="submit" class="primary">Gönder</button></div></form>`,
    { back },
  );
  const form = dialog.querySelector('#supportNewForm');
  if (manager)
    form.elements.grantAccess.onchange = () => {
      dialog.querySelector('#supportAccessDetail').hidden = !form.elements.grantAccess.checked;
    };
  form.onsubmit = (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type=submit]');
    submit.disabled = true;
    try {
      const grant = manager && form.elements.grantAccess.checked ? readSupportAccessFields(form) : null;
      const result = authApi('/api/support', 'POST', {
        subject: form.elements.subject.value.trim(),
        category: form.elements.category.value,
        priority: form.elements.priority.value,
        body: form.elements.body.value.trim(),
      });
      // The ticket exists now; a failing grant must not make the person send it twice.
      let grantNote = '';
      if (grant) {
        try {
          authApi('/api/support-access/grant', 'POST', {
            ticketId: result.id,
            minutes: grant.minutes,
            allowEdit: grant.allowEdit,
          });
          grantNote = ` Destek ekibine ${supportMinutesLabel(grant.minutes)} erişim izni verildi (${grant.allowEdit ? 'değişiklik yapabilir' : 'yalnızca görüntüleme'}).`;
          window.refreshSupportAccess?.();
        } catch (grantError) {
          grantNote = ` Erişim izni verilemedi: ${grantError.message}`;
        }
      }
      if (back) back();
      else {
        dialog.close();
        if (
          typeof page !== 'undefined' &&
          page === 'settings' &&
          typeof settingsTab !== 'undefined' &&
          settingsTab === 'support'
        )
          supportSettingsPage();
      }
      toast(`Destek kaydınız alındı (#${result.number}).${grantNote}`);
    } catch (error) {
      dialog.querySelector('#supportNewError').textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  };
}

function supportAccessStateText(access) {
  const edit = access.allowEdit ? 'değişiklik yapabilir' : 'yalnızca görüntüleme';
  if (access.state === 'pending')
    return `${access.minutes} dk erişim izni verildi (${edit}). Destek ekibinin bağlanması bekleniyor; süre ilk bağlantıda başlar.`;
  if (access.state === 'connected')
    return `Destek ekibi şu an bağlı (${edit}). Kalan süreyi sayfanın üstündeki çubukta görebilirsiniz.`;
  return 'Destek ekibinin süresi doldu.';
}

// "Destek erişimi" on a ticket, for managers: the open grant with its state, or the options to
// give one. Returns the markup and a binder that wires its buttons after the dialog is built.
function supportAccessSection(ticket, reopen) {
  if (!supportIsManager() || ticket.status === 'closed') return { html: '', bind() {} };
  let access;
  try {
    access = authApi('/api/support-access/status').access || null;
  } catch {
    // Remote access is not offered on this installation, or the request failed: the ticket still opens.
    return { html: '', bind() {} };
  }
  const here = access && access.ticketId === ticket.id;
  const html = `<div class="formbody support-access-box"><h3>Destek erişimi</h3>${
    here
      ? `<p>${esc(supportAccessStateText(access))}</p>${access.canDecide ? '<button type="button" class="secondary" data-support-access-end>Erişimi sonlandır</button>' : ''}`
      : `<p>${access ? 'Büronuzda başka bir kayıt için açık bir erişim izni var; yeni vereceğiniz izin onun yerine geçer.' : 'Destek ekibinin büronuza geçici olarak bağlanmasına izin verebilirsiniz.'}</p>
        ${supportAccessFields()}<button type="button" class="primary" data-support-access-grant>Erişim izni ver</button>`
  }</div>`;
  const bind = (dialog) => {
    const form = dialog.querySelector('form');
    const end = dialog.querySelector('[data-support-access-end]');
    if (end)
      end.onclick = () => {
        if (!window.confirm('Destek ekibinin büronuza erişimi şimdi sonlandırılsın mı?')) return;
        try {
          authApi('/api/support-access/' + encodeURIComponent(access.id) + '/end', 'POST', {});
          window.refreshSupportAccess?.();
          reopen();
          toast('Destek erişimi sonlandırıldı.');
        } catch (error) {
          toast(error.message);
        }
      };
    const grant = dialog.querySelector('[data-support-access-grant]');
    if (grant)
      grant.onclick = () => {
        const options = readSupportAccessFields(form);
        grant.disabled = true;
        try {
          authApi('/api/support-access/grant', 'POST', {
            ticketId: ticket.id,
            minutes: options.minutes,
            allowEdit: options.allowEdit,
          });
          window.refreshSupportAccess?.();
          reopen();
          toast(`Destek ekibine ${supportMinutesLabel(options.minutes)} erişim izni verildi.`);
        } catch (error) {
          grant.disabled = false;
          toast(error.message);
        }
      };
  };
  return { html, bind };
}

function supportTicketDialog(id, back) {
  let detail;
  try {
    detail = authApi('/api/support/' + encodeURIComponent(id));
  } catch (error) {
    return toast(error.message);
  }
  const { ticket, messages } = detail;
  const thread = messages
    .map(
      (m) =>
        `<div class="support-msg ${m.from === 'support' ? 'support-reply' : ''}"><small>${esc(m.author)} · ${esc(new Date(m.createdAt).toLocaleString('tr-TR'))}</small><p>${esc(m.body)}</p></div>`,
    )
    .join('');
  const closed = ticket.status === 'closed';
  const reopen = () => supportTicketDialog(id, back);
  const access = supportAccessSection(ticket, reopen);
  const dialog = supportDialog(
    `<form id="supportReplyForm"><div class="panelhead"><div><h2>#${esc(ticket.number)} — ${esc(ticket.subject)}</h2><p>${esc(SUPPORT_STATUS[ticket.status] || ticket.status)} · ${esc(supportLabel(SUPPORT_CATEGORIES, ticket.category))}</p></div><button type="button" class="secondary" data-support-close>${back ? 'Geri' : 'Kapat'}</button></div>
    <div class="formbody support-thread">${thread}</div>
    ${access.html}
    ${
      closed
        ? '<div class="notice">Bu kayıt kapatıldı. Yeni bir konu için yeni kayıt açın.</div>'
        : `<div class="formbody"><label class="field">Yanıtınız<textarea name="body" required maxlength="5000" rows="3"></textarea></label><p class="formerror" role="alert" id="supportReplyError"></p></div><div class="actions"><button type="submit" class="primary">Gönder</button></div>`
    }</form>`,
    { back },
  );
  access.bind(dialog);
  const form = dialog.querySelector('#supportReplyForm');
  if (closed) return;
  form.onsubmit = (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type=submit]');
    submit.disabled = true;
    try {
      authApi('/api/support/' + encodeURIComponent(id) + '/messages', 'POST', {
        body: form.elements.body.value.trim(),
      });
      window.refreshSupportAccess?.();
      supportTicketDialog(id, back);
      toast('Yanıtınız gönderildi.');
    } catch (error) {
      dialog.querySelector('#supportReplyError').textContent = error.message;
      submit.disabled = false;
    }
  };
}
