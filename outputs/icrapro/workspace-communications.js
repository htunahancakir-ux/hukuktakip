function messageTimestamp(date) {
  const d = new Date(date);
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Asia/Baghdad',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(d);
}

function messagesPage() {
  if (communicationView === 'orders') return workOrdersPage();
  let result;
  try {
    result = authApi('/api/messages?box=' + messageBox + '&offset=' + messageOffset);
  } catch (error) {
    $('#content').textContent = error.message;
    return;
  }
  $('#content').innerHTML =
    communicationTabsMarkup() +
    `<div class="panel"><div class="panelhead"><div><h2>Mesajlar</h2><p>Programdaki mesajları yönetici de görebilir.</p></div><div class="toolbar"><button class="secondary" id="refreshMessages">Yenile</button><button class="primary" id="composeMessage">＋ Yeni Mesaj</button></div></div><div class="formbody"><div class="settings-tabs">${[['inbox', 'Gelen Mesajlar'], ['sent', 'Gönderilen Mesajlar'], ...(['ceo', 'admin'].includes(hanAuth.role) ? [['all', 'Tüm Mesajlar']] : [])].map(([key, label]) => `<button type="button" data-message-box="${key}" class="${messageBox === key ? 'selected' : ''}">${label}</button>`).join('')}</div><p>${result.total} mesaj · ${result.total ? messageOffset + 1 : 0}–${messageOffset + result.messages.length}</p></div><div class="overflow"><table><thead><tr><th>TARİH / SAAT</th><th>GÖNDEREN</th><th>ALICILAR</th><th>KONU</th><th>DURUM</th></tr></thead><tbody>${result.messages.map((m) => `<tr class="${m.isUnread ? 'message-unread' : ''}"><td>${messageTimestamp(m.createdAt)}</td><td>${esc(m.senderName)}</td><td>${esc(m.recipientNames.join(', '))}</td><td><button type="button" class="link" data-open-message="${m.id}">${esc(m.subject)}</button></td><td>${m.isUnread ? 'Yeni' : messageBox === 'inbox' ? 'Okundu' : m.readCount + '/' + m.recipientIds.length + ' okundu'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Bu kutuda henüz mesaj yok.</td></tr>'}</tbody></table></div><div class="actions"><button class="secondary" id="previousMessages" ${messageOffset === 0 ? 'disabled' : ''}>Önceki</button><button class="secondary" id="nextMessages" ${messageOffset + 50 >= result.total ? 'disabled' : ''}>Sonraki</button></div></div>`;
  bindCommunicationTabs();
  $('#composeMessage').onclick = () => composeMessage();
  $('#refreshMessages').onclick = () => {
    messagesPage();
    updateMessageBadge();
  };
  document.querySelectorAll('[data-message-box]').forEach(
    (b) =>
      (b.onclick = () => {
        messageBox = b.dataset.messageBox;
        messageOffset = 0;
        messagesPage();
      }),
  );
  $('#previousMessages').onclick = () => {
    messageOffset = Math.max(0, messageOffset - 50);
    messagesPage();
  };
  $('#nextMessages').onclick = () => {
    messageOffset += 50;
    messagesPage();
  };
  document
    .querySelectorAll('[data-open-message]')
    .forEach(
      (b) => (b.onclick = () => openMessage(result.messages.find((m) => m.id === b.dataset.openMessage))),
    );
  updateMessageBadge();
}

function messageRecipientGroups(users, selected) {
  const sorted = [...users].sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  const groups = [
    ['Yöneticiler', sorted.filter((user) => ['ceo', 'admin'].includes(user.role))],
    ['Personel', sorted.filter((user) => !['ceo', 'admin'].includes(user.role))],
  ];
  return (
    groups
      .filter(([, people]) => people.length)
      .map(
        ([label, people]) =>
          `<fieldset class="message-recipient-group"><legend>${label}</legend><div class="message-recipient-grid">${people
            .map(
              (user) =>
                `<label title="${esc(user.name)}"><input type="checkbox" name="recipient" value="${esc(user.id)}" ${selected === user.id ? 'checked' : ''}><span>${esc(user.name)}</span></label>`,
            )
            .join('')}</div></fieldset>`,
      )
      .join('') || '<p>Mesaj gönderilebilecek başka aktif kullanıcı yok.</p>'
  );
}

function composeMessage(reply) {
  let users;
  try {
    users = authApi('/api/message-users');
  } catch (error) {
    return toast(error.message);
  }
  let dialog = document.getElementById('messageComposeDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'messageComposeDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML = `<form id="messageComposeForm"><div class="panelhead"><h2>${reply ? 'Mesajı Yanıtla' : 'Yeni Mesaj'}</h2><button type="button" class="secondary" id="closeMessageCompose">Kapat</button></div><div class="formbody"><label class="field">Gönderim<select name="audience"><option value="selected">Kişi / Seçili Kişiler</option><option value="all">Tüm Aktif Kullanıcılar</option></select></label><div id="messageRecipients" class="message-recipients">${messageRecipientGroups(users, reply?.senderId)}</div><label class="field">Konu<input name="subject" required maxlength="150" value="${reply ? esc(('Yanıt: ' + reply.subject).slice(0, 150)) : ''}"></label><label class="field">Mesaj<textarea name="text" required maxlength="10000" rows="4" placeholder="Mesajınızı yazın…"></textarea></label><p>Mesajlar yönetici tarafından da görüntülenebilir.</p></div><div class="actions"><button class="primary" type="submit">Gönder</button></div></form>`;
  $('#closeMessageCompose').onclick = () => dialog.close();
  const form = $('#messageComposeForm');
  form
    .querySelector('.formbody')
    .insertAdjacentHTML(
      'beforeend',
      '<label class="settings-check"><input type="checkbox" name="whatsapp" checked> WhatsApp’tan da gönder</label>',
    );
  form.elements.audience.onchange = () => {
    const all = form.elements.audience.value === 'all';
    $('#messageRecipients').hidden = all;
    form.querySelectorAll('[name="recipient"]').forEach((el) => (el.disabled = all));
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const value = Object.fromEntries(new FormData(form));
      value.recipientIds = [...form.querySelectorAll('[name="recipient"]:checked')].map((el) => el.value);
      value.whatsapp = form.elements.whatsapp.checked;
      const result = await recoveryApi('/api/messages', value);
      dialog.close();
      communicationView = 'messages';
      messageBox = 'sent';
      messageOffset = 0;
      messagesPage();
      toast('Uygulama içi mesaj gönderildi.' + whatsappDeliveryNotice(result));
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  };
  dialog.showModal();
}

function openMessage(message) {
  if (!message) return;
  try {
    authApi('/api/messages/read', 'POST', { id: message.id });
  } catch (error) {
    return toast(error.message);
  }
  messagesPage();
  let dialog = document.getElementById('messageDetailDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'messageDetailDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML = `<div class="panelhead"><h2>${esc(message.subject)}</h2><button class="secondary" id="closeMessageDetail">Kapat</button></div><div class="formbody"><p><b>Gönderen:</b> ${esc(message.senderName)}</p><p><b>Alıcılar:</b> ${esc(message.recipientNames.join(', '))}</p><p><b>Tarih:</b> ${messageTimestamp(message.createdAt)}</p><div class="message-text">${esc(message.text)}</div></div><div class="actions">${message.senderId !== hanAuth.id ? '<button class="primary" id="replyMessage">Gönderene Yanıtla</button>' : ''}</div>`;
  $('#closeMessageDetail').onclick = () => dialog.close();
  if ($('#replyMessage'))
    $('#replyMessage').onclick = () => {
      dialog.close();
      composeMessage(message);
    };
  dialog.showModal();
}

function applyMessageSummary(result) {
  const badge = document.getElementById('messageUnreadCount');
  messageKnownUnread = result.unread;
  if (badge) {
    badge.textContent = result.unread + Number(result.pendingWorkOrders || 0) || '';
    badge.setAttribute(
      'aria-label',
      result.unread + ' okunmamış mesaj, ' + Number(result.pendingWorkOrders || 0) + ' bekleyen iş emri',
    );
  }
  if (typeof updateHeaderNotifications === 'function')
    updateHeaderNotifications({
      unread: Number(result.unread || 0),
      pendingWorkOrders: Number(result.pendingWorkOrders || 0),
    });
}
function updateMessageBadge() {
  return pollWorkspaceNotifications();
}
function startMessageNotifications() {
  return startWorkspaceNotifications();
}

function communicationTabsMarkup() {
  return `<div class="settings-tabs" style="margin-bottom:20px"><button type="button" data-communication-view="messages" class="${communicationView === 'messages' ? 'selected' : ''}">Mesajlar</button><button type="button" data-communication-view="orders" class="${communicationView === 'orders' ? 'selected' : ''}">İş Emirleri</button></div>`;
}

function bindCommunicationTabs() {
  document.querySelectorAll('[data-communication-view]').forEach(
    (b) =>
      (b.onclick = () => {
        communicationView = b.dataset.communicationView;
        messagesPage();
      }),
  );
}

function workOrdersPage() {
  let result;
  try {
    result = authApi(
      '/api/work-orders?scope=' +
        workOrderScope +
        '&status=' +
        workOrderStatus +
        '&offset=' +
        workOrderOffset,
    );
  } catch (error) {
    $('#content').textContent = error.message;
    return;
  }
  $('#content').innerHTML =
    communicationTabsMarkup() +
    `<div class="panel"><div class="panelhead"><div><h2>İş Emirleri</h2><p>Tamamlanmamış işler her program girişinde hatırlatılır. Yönetici tüm iş emirlerini görebilir.</p></div><div class="toolbar"><button class="secondary" id="refreshWorkOrders">Yenile</button><button class="primary" id="newWorkOrder">＋ İş Emri Ata</button></div></div><div class="formbody"><label class="field">Görevler<select id="workOrderScope">${[['mine', 'Bana Atanan'], ['created', 'Benim Atadıklarım'], ...(['ceo', 'admin'].includes(hanAuth.role) ? [['all', 'Tüm İş Emirleri']] : [])].map(([k, t]) => `<option value="${k}" ${workOrderScope === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label><div class="settings-tabs" style="margin-top:18px">${[
      ['pending', 'Yapılmadı / Bekleyen'],
      ['done', 'Yapıldı'],
      ['all', 'Tümü'],
    ]
      .map(
        ([k, t]) =>
          `<button type="button" data-work-status="${k}" class="${workOrderStatus === k ? 'selected' : ''}">${t}</button>`,
      )
      .join(
        '',
      )}</div><p>${result.total} iş emri</p></div><div class="overflow"><table><thead><tr><th>İŞ / TARİH</th><th>ATAYAN</th><th>GÖREVLİ</th><th>SON TARİH</th><th>DURUM / İŞLEM</th></tr></thead><tbody>${result.orders.map((w) => `<tr><td><button class="link" data-work-open="${w.id}">${esc(w.title)}</button><small>${messageTimestamp(w.createdAt)}</small></td><td>${esc(w.assignerName)}</td><td>${esc(w.assigneeName)}</td><td>${esc(displayDate(w.due) || '—')}</td><td>${w.status === 'done' ? '✓ Yapıldı' : 'Bekliyor'}${w.status === 'pending' && w.assigneeId === hanAuth.id ? `<div><button class="primary" data-work-done="${w.id}">Yapıldı</button></div>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Bu seçimde iş emri yok.</td></tr>'}</tbody></table></div><div class="actions"><button class="secondary" id="previousOrders" ${workOrderOffset === 0 ? 'disabled' : ''}>Önceki</button><button class="secondary" id="nextOrders" ${workOrderOffset + 50 >= result.total ? 'disabled' : ''}>Sonraki</button></div></div>`;
  bindCommunicationTabs();
  $('#newWorkOrder').onclick = composeWorkOrder;
  $('#refreshWorkOrders').onclick = workOrdersPage;
  $('#workOrderScope').onchange = (e) => {
    workOrderScope = e.target.value;
    workOrderOffset = 0;
    workOrdersPage();
  };
  document.querySelectorAll('[data-work-status]').forEach(
    (b) =>
      (b.onclick = () => {
        workOrderStatus = b.dataset.workStatus;
        workOrderOffset = 0;
        workOrdersPage();
      }),
  );
  document
    .querySelectorAll('[data-work-open]')
    .forEach(
      (b) => (b.onclick = () => openWorkOrder(result.orders.find((w) => w.id === b.dataset.workOpen))),
    );
  document
    .querySelectorAll('[data-work-done]')
    .forEach(
      (b) => (b.onclick = () => openWorkOrder(result.orders.find((w) => w.id === b.dataset.workDone))),
    );
  $('#previousOrders').onclick = () => {
    workOrderOffset = Math.max(0, workOrderOffset - 50);
    workOrdersPage();
  };
  $('#nextOrders').onclick = () => {
    workOrderOffset += 50;
    workOrdersPage();
  };
  updateMessageBadge();
}

function composeWorkOrder() {
  const users = authApi('/api/message-users');
  let dialog = document.getElementById('workOrderComposeDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'workOrderComposeDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML = `<form id="workOrderComposeForm"><div class="panelhead"><h2>İş Emri Ata</h2><button type="button" class="secondary" id="closeWorkCompose">Kapat</button></div><div class="formbody grid"><label class="field full">Atanacak Kişi<select name="assigneeId" required><option value="">Seçin</option>${users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label><label class="field full">İş Başlığı<select name="title" required><option value="">İş başlığı seçin</option><option>Arama Yap</option><option>Borçluya Geri Dön</option><option>İcra Aç</option><option>Diğer</option></select></label><label class="field full">İş Açıklaması<textarea name="description" data-optional="true" maxlength="10000" rows="6"></textarea></label><label class="field full">Son Tarih (isteğe bağlı)<input name="due" type="date" data-optional="true"></label></div><div class="actions"><button type="submit" class="primary">İş Emrini Ata</button></div></form>`;
  $('#closeWorkCompose').onclick = () => dialog.close();
  const form = $('#workOrderComposeForm');
  form
    .querySelector('.formbody')
    .insertAdjacentHTML(
      'beforeend',
      '<label class="settings-check"><input type="checkbox" name="whatsapp" checked> WhatsApp’tan da gönder</label>',
    );
  form.onsubmit = async (e) => {
    e.preventDefault();
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const value = Object.fromEntries(new FormData(form));
      value.whatsapp = form.elements.whatsapp.checked;
      const result = await recoveryApi('/api/work-orders', value);
      dialog.close();
      communicationView = 'orders';
      workOrderScope = 'created';
      workOrderStatus = 'pending';
      workOrderOffset = 0;
      messagesPage();
      toast(
        'İş emri kaydedildi ve görevliye uygulama içi bildirim gönderildi.' + whatsappDeliveryNotice(result),
      );
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  };
  dialog.showModal();
}

function openWorkOrder(order) {
  if (!order) return;
  let dialog = document.getElementById('workOrderDetailDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'workOrderDetailDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML = `<div class="panelhead"><h2>${esc(order.title)}</h2><button class="secondary" id="closeWorkDetail">Kapat</button></div><div class="formbody"><p>Atayan: <b>${esc(order.assignerName)}</b> · Görevli: <b>${esc(order.assigneeName)}</b></p><p>Atama: ${messageTimestamp(order.createdAt)} · Son tarih: ${esc(displayDate(order.due) || '—')}</p><div class="message-text">${esc(order.description)}</div>${order.status === 'done' ? `<p>✓ Yapıldı · ${messageTimestamp(order.completedAt)}</p><p><b>İş Sonucu:</b> ${esc(order.completionResult || 'Belirtilmedi')}</p><div class="message-text">${esc(order.completionNote || '')}</div>` : order.assigneeId === hanAuth.id ? '<form id="completeWorkForm"><label class="field">İş Sonucu<select name="result" required><option value="">Sonuç seçin</option><option>Borçlu Arandı</option><option>İcra Açıldı</option><option>Diğer</option></select></label><label class="field" style="margin-top:20px">Tamamlama Notu (isteğe bağlı)<textarea name="note" rows="3" maxlength="3000" data-optional="true"></textarea></label><div class="actions"><button type="submit" class="primary">✓ Yapıldı</button></div></form>' : '<p>Durum: Yapılmadı / Bekliyor</p>'}</div>`;
  $('#closeWorkDetail').onclick = () => dialog.close();
  if (
    order.status === 'pending' &&
    (order.assignerId === hanAuth.id || ['ceo', 'admin'].includes(hanAuth.role))
  ) {
    const reminder = document.createElement('button');
    reminder.type = 'button';
    reminder.className = 'secondary';
    reminder.textContent = 'WhatsApp’tan Hatırlat';
    reminder.onclick = async () => {
      reminder.disabled = true;
      try {
        const result = await recoveryApi('/api/whatsapp/reminder', { orderId: order.id });
        toast(whatsappDeliveryNotice(result).trim(), dialog);
      } catch (error) {
        toast(error.message, dialog);
      } finally {
        reminder.disabled = false;
      }
    };
    dialog.querySelector('.formbody').append(reminder);
  }
  if ($('#completeWorkForm'))
    $('#completeWorkForm').onsubmit = (e) => {
      e.preventDefault();
      const button = e.target.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        authApi('/api/work-orders/complete', 'POST', {
          id: order.id,
          result: e.target.elements.result.value,
          note: e.target.elements.note.value,
        });
        dialog.close();
        communicationView = 'orders';
        workOrderStatus = 'done';
        messagesPage();
        toast('İş tamamlandı; atayan kişiye bildirim gönderildi.');
      } catch (error) {
        toast(error.message);
      } finally {
        button.disabled = false;
      }
    };
  dialog.showModal();
}

function showPendingWorkOrders() {
  let result;
  try {
    result = authApi('/api/work-orders?scope=mine&status=pending');
  } catch {
    return;
  }
  if (!result.total) return;
  let dialog = document.getElementById('pendingWorkOrdersDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'pendingWorkOrdersDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML = `<div class="panelhead"><h2>Bekleyen İş Emirleriniz (${result.total})</h2></div><div class="formbody"><p>Bu işler yapılana kadar her program girişinde hatırlatılır.</p>${result.orders.map((w) => `<div class="notice" style="margin:12px 0"><button class="link" data-pending-work="${w.id}">${esc(w.title)}</button><p>Atayan: ${esc(w.assignerName)} · Son tarih: ${esc(displayDate(w.due) || '—')}</p></div>`).join('')}</div><div class="actions"><button class="secondary" id="laterWorkOrders">Daha Sonra</button><button class="primary" id="goWorkOrders">İş Emirlerine Git</button></div>`;
  $('#laterWorkOrders').onclick = () => dialog.close();
  $('#goWorkOrders').onclick = () => {
    dialog.close();
    communicationView = 'orders';
    workOrderScope = 'mine';
    workOrderStatus = 'pending';
    workOrderOffset = 0;
    page = 'messages';
    render();
  };
  dialog.querySelectorAll('[data-pending-work]').forEach(
    (b) =>
      (b.onclick = () => {
        dialog.close();
        openWorkOrder(result.orders.find((w) => w.id === b.dataset.pendingWork));
      }),
  );
  dialog.showModal();
}
