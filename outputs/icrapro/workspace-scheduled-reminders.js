const reminderDeliveryLabels = {
  off: 'Uygulama içi',
  pending: 'WhatsApp bekliyor',
  sending: 'WhatsApp gönderiliyor',
  accepted: 'Meta gönderimi kabul etti',
  failed: 'WhatsApp gönderilemedi',
  unavailable: 'WhatsApp numarası veya bağlantısı artık uygun değil',
  unknown: 'WhatsApp sonucu doğrulanamadı',
  cancelled: 'WhatsApp gönderimi iptal edildi',
};
let reminderListStatus = 'open';
let previousDueCount = 0;

function scheduledReminderBadge(count) {
  const badge = document.getElementById('scheduledReminderCount');
  if (badge) {
    badge.textContent = count || '';
    badge.title = count ? count + ' zamanı gelen hatırlatma' : '';
  }
  if (typeof updateHeaderNotifications === 'function')
    updateHeaderNotifications({ dueReminders: Number(count || 0) });
}

function startScheduledReminderNotices() {
  const poll = async () => {
    if (document.hidden) return;
    try {
      const response = await fetch('/api/scheduled-reminders?summary', { cache: 'no-store' });
      if (!response.ok) return;
      const { dueCount } = await response.json();
      scheduledReminderBadge(dueCount);
      if (dueCount > previousDueCount && !document.querySelector('dialog[open]'))
        toast(dueCount + ' hatırlatmanın zamanı geldi.');
      previousDueCount = dueCount;
    } catch {}
  };
  poll();
  setInterval(poll, 45000);
  document.addEventListener('visibilitychange', poll);
}

function scheduledRemindersPage() {
  const host = document.getElementById('content');
  try {
    const { items, whatsappAvailable, dueCount } = authApi(
      '/api/scheduled-reminders?status=' + reminderListStatus,
    );
    scheduledReminderBadge(dueCount);
    previousDueCount = dueCount;
    host.innerHTML = `<section class="panel scheduled-reminders">
      <div class="panelhead"><div><h2>Zamanlanmış hatırlatmalar</h2><p>${dueCount} hatırlatmanın zamanı geldi.</p></div>
        <button type="button" class="primary" data-add-reminder>＋ Hatırlatma ekle</button></div>
      <div class="formbody"><div class="settings-tabs" aria-label="Hatırlatma durumu">
        <button type="button" data-reminder-view="open" class="${reminderListStatus === 'open' ? 'selected' : ''}">Bekleyenler</button>
        <button type="button" data-reminder-view="closed" class="${reminderListStatus === 'closed' ? 'selected' : ''}">Tamamlanan / İptal</button>
      </div>
      ${
        items.length
          ? `<ul class="scheduled-list">${items
              .map((row) => {
                const due = Date.parse(row.dueAt) <= Date.now();
                return `<li><div><strong>${termsDate(row.dueAt)}</strong> ·
          ${row.closedAt ? (row.closeReason === 'complete' ? 'Tamamlandı' : 'İptal edildi') : due ? 'Zamanı geldi' : 'Planlandı'}
          ${row.target ? `<p><strong>${esc(row.target.label)}</strong> ${esc(row.target.detail || '')}</p>` : ''}
          <p class="scheduled-note">${esc(row.note)}</p><small>${esc(reminderDeliveryLabels[row.deliveryStatus])}</small></div>
          ${
            row.closedAt
              ? ''
              : `<div class="terms-buttons">
            ${due ? `<button type="button" class="secondary" data-reminder-action="complete" data-reminder-id="${esc(row.id)}">Tamamlandı</button>` : ''}
            <button type="button" class="secondary" data-reminder-action="cancel" data-reminder-id="${esc(row.id)}">İptal et</button>
          </div>`
          }</li>`;
              })
              .join('')}</ul>`
          : '<p>Bu listede hatırlatma yok.</p>'
      }</div></section>`;
    host.querySelector('[data-add-reminder]').onclick = () => scheduledReminderDialog(whatsappAvailable);
    host.querySelectorAll('[data-reminder-view]').forEach((button) => {
      button.onclick = () => {
        reminderListStatus = button.dataset.reminderView;
        scheduledRemindersPage();
      };
    });
    host.querySelectorAll('[data-reminder-action]').forEach((button) => {
      button.onclick = () => {
        const { reminderAction, reminderId } = button.dataset;
        if (reminderAction === 'cancel' && !window.confirm('Bu hatırlatma iptal edilsin mi?')) return;
        try {
          authApi('/api/scheduled-reminders', 'POST', { action: reminderAction, id: reminderId });
          scheduledRemindersPage();
        } catch (error) {
          toast(error.message);
        }
      };
    });
  } catch (error) {
    host.textContent = error.message;
  }
}

function scheduledReminderDialog(whatsappAvailable) {
  const dialog = termsDialog('Hatırlatma ekle');
  const content = dialog.querySelector('.terms-dialog-content');
  content.innerHTML = `<form class="grid">
    <div class="full">
      <label class="field">Müvekkil, borçlu veya dosya numarası (isteğe bağlı)
        <input type="search" autocomplete="off" data-reminder-search placeholder="En az iki karakter yazın">
      </label>
      <div data-reminder-target aria-live="polite"></div>
      <div class="scheduled-search-results" data-reminder-results></div>
    </div>
    <label class="field">Gün <input name="date" type="date" min="${esc(businessDate())}" required></label>
    <label class="field">Saat (Türkiye) <input name="time" type="time" required></label>
    <label class="field full">Not <textarea name="note" rows="4" required maxlength="1000"></textarea></label>
    <label class="settings-check full"><input name="whatsapp" type="checkbox" ${whatsappAvailable ? '' : 'disabled'}> Zamanı gelince kendi WhatsApp numarama bildir</label>
    <small class="full">${
      whatsappAvailable
        ? 'Ayrıntılar uygulamada kalır; WhatsApp mesajı hatırlatmanın zamanını bildirir.'
        : 'WhatsApp için Meta bağlantısı, hatırlatma şablonu, zamanlayıcı ve hesabınızda onaylı numara gerekir.'
    }</small>
    <p class="full terms-error" role="alert"></p>
    <div class="full terms-buttons"><button class="primary" type="submit">Hatırlatmayı kaydet</button></div></form>`;
  const form = content.querySelector('form');
  const search = form.querySelector('[data-reminder-search]');
  const results = form.querySelector('[data-reminder-results]');
  const selected = form.querySelector('[data-reminder-target]');
  let target = null,
    timer,
    seq = 0;
  search.oninput = () => {
    const query = search.value.trim();
    const token = ++seq;
    clearTimeout(timer);
    results.replaceChildren();
    if (query.length < 2) return;
    timer = setTimeout(async () => {
      try {
        const response = await fetch('/api/search?q=' + encodeURIComponent(query));
        if (!response.ok) throw Error('Arama tamamlanamadı.');
        const { items } = await response.json();
        if (token !== seq || !dialog.open) return;
        if (!items.length) results.textContent = 'Erişebildiğiniz kayıtlar arasında eşleşme yok.';
        for (const row of items) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'secondary';
          button.textContent =
            (row.type === 'client' ? 'Müvekkil: ' : 'Dosya: ') +
            row.label +
            (row.detail ? ' · ' + row.detail : '');
          button.onclick = () => {
            target = row;
            form.dataset.modalDirty = 'true';
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'link';
            remove.textContent = 'Seçimi kaldır';
            remove.onclick = () => {
              target = null;
              selected.replaceChildren();
              delete form.dataset.modalDirty;
            };
            selected.replaceChildren(button.textContent + ' ', remove);
            search.value = '';
            results.replaceChildren();
          };
          results.append(button);
        }
      } catch (error) {
        if (token === seq) results.textContent = error.message;
      }
    }, 240);
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    const { date, time, note, whatsapp } = form.elements;
    try {
      authApi('/api/scheduled-reminders', 'POST', {
        action: 'create',
        date: date.value,
        time: time.value,
        note: note.value,
        whatsapp: whatsapp.checked,
        targetType: target?.type,
        targetId: target?.id,
      });
      modalFormSaved(form);
      dialog.close();
      reminderListStatus = 'open';
      scheduledRemindersPage();
      toast('Hatırlatma kaydedildi.');
    } catch (error) {
      form.querySelector('[role="alert"]').textContent = error.message;
    }
  };
  dialog.showModal();
}
