const whatsappTemplates = [
  ['resetTemplate', 'Şifre bağlantısı şablonu'],
  ['messageTemplate', 'Mesaj şablonu'],
  ['reminderTemplate', 'İş emri ve hatırlatma şablonu'],
  ['documentTemplate', 'PDF / evrak şablonu'],
  ['imageTemplate', 'Fotoğraf şablonu'],
];

function whatsappSettingsPage() {
  let config;
  try {
    config = authApi('/api/whatsapp/config');
  } catch (error) {
    return toast(error.message);
  }
  $('#content').innerHTML = `${settingsSectionTabs('whatsapp')}<section class="panel">
    <div class="panelhead"><div><h2>WhatsApp Business</h2>
    <p>Meta Cloud API bilgilerini ve onaylı mesaj şablonlarını girin.</p></div><span class="badge">${config.enabled ? 'Etkin' : 'Kapalı'}</span></div>
    <form id="whatsappConfigForm"><div class="formbody grid">
      <label class="settings-check full"><input type="checkbox" name="enabled" ${config.enabled ? 'checked' : ''}> WhatsApp gönderimlerini aç</label>
      <label class="field">Telefon numarası kimliği<input name="phoneNumberId" inputmode="numeric" data-optional="true" value="${esc(config.phoneNumberId)}"></label>
      <label class="field">Graph API sürümü<input name="version" data-optional="true" value="${esc(config.version)}"></label>
      <label class="field">Şablon dili<input name="language" data-optional="true" value="${esc(config.language)}"></label>
      <label class="field full">Meta erişim anahtarı<input name="token" type="password" maxlength="4096" autocomplete="new-password" data-optional="true"
        placeholder="${config.tokenSaved ? 'Kayıtlı anahtarı korumak için boş bırakın' : 'Meta Cloud API erişim anahtarı'}"></label>
      ${whatsappTemplates.map(([key, label]) => `<label class="field">${esc(label)}<input name="${key}" maxlength="128" data-optional="true" value="${esc(config[key])}"></label>`).join('')}
      <details class="full"><summary>Şablonları nasıl hazırlamalıyım?</summary>
        <p>Meta geliştirici panelinde WhatsApp ürününü açın, işletme gönderici numaranızı ekleyin ve telefon numarası kimliğini alın. Ardından API erişim anahtarını ve WhatsApp Manager’da onaylanan şablon adlarını yukarıya girin.</p>
        <p>Şifre şablonunun metninde sırasıyla günlük, haftalık ve aylık kalan hak için üç değişken kullanın. İlk düğme, sonunda değişken olan bir URL olmalı: <code>https://www.hanhukuktakip.com/#sifre={{1}}</code></p>
        <p>Mesaj şablonu sırasıyla gönderen, konu ve mesaj önizlemesini; hatırlatma şablonu gönderen, iş başlığı ve son tarihi alır.</p>
        <p>PDF ve fotoğraf için sırasıyla belge veya görsel başlıklı şablon oluşturun. Metin gövdesinde evrak numarası için bir değişken kullanın.</p>
      </details></div><div class="actions"><button class="primary" type="submit">Bağlantı Ayarlarını Kaydet</button></div></form>
  </section>`;
  bindSettingsSectionTabs();
  $('#whatsappConfigForm').onsubmit = (event) => {
    event.preventDefault();
    const form = event.target;
    const input = Object.fromEntries(new FormData(form));
    input.enabled = form.elements.enabled.checked;
    for (const key of Object.keys(input)) if (typeof input[key] === 'string') input[key] = input[key].trim();
    try {
      authApi('/api/whatsapp/config', 'PUT', input);
      whatsappSettingsPage();
      toast('WhatsApp ayarları kaydedildi.');
    } catch (error) {
      toast(error.message);
    }
  };
}

function whatsappDeliveryNotice(result) {
  const delivery = result.whatsapp;
  if (!delivery) return '';
  const counts = [];
  if (delivery.accepted) counts.push(delivery.accepted + ' gönderim Meta tarafından kabul edildi');
  if (delivery.skipped)
    counts.push(delivery.skipped + ' alıcı atlandı (bağlantı, şablon veya onaylı numara eksik)');
  if (delivery.failed) {
    const reasons = (Array.isArray(delivery.errors) ? delivery.errors : []).map(
      (row) =>
        (row.code ? 'Hata ' + row.code + ': ' : '') +
        row.message +
        (delivery.failed > 1 && row.count > 1 ? ' (' + row.count + ' gönderim)' : ''),
    );
    counts.push(delivery.failed + ' gönderim başarısız' + (reasons.length ? ' — ' + reasons.join('; ') : ''));
  }
  return counts.length ? ' WhatsApp: ' + counts.join('; ') + '.' : '';
}

function whatsappAccountDialog(user) {
  let contact;
  try {
    contact = authApi('/api/whatsapp/contact?userId=' + encodeURIComponent(user.id));
  } catch (error) {
    return toast(error.message);
  }
  let dialog = document.getElementById('whatsappAccountDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'whatsappAccountDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML = `<form><div class="panelhead"><div><h2>WhatsApp ve Şifre Bağlantısı</h2><p>${esc(user.name)}</p></div>
    <button type="button" class="secondary" data-wa-close>Kapat</button></div>
    <div class="formbody grid"><label class="field full">Kayıtlı WhatsApp numarası<input type="tel" name="phone" data-optional="true" value="${esc(contact.phone)}"></label>
    <label class="settings-check full"><input type="checkbox" name="allowed" ${contact.allowed ? 'checked' : ''}> Alıcının WhatsApp gönderimi için onayı var</label>
    <p class="full" data-wa-status role="status"></p></div>
    <div class="actions"><button type="submit" class="secondary">Numarayı Kaydet</button>
    <button type="button" class="primary" data-wa-password>Şifre Bağlantısı Gönder</button></div></form>`;
  const form = dialog.querySelector('form');
  const status = dialog.querySelector('[data-wa-status]');
  const send = dialog.querySelector('[data-wa-password]');
  dialog.querySelector('[data-wa-close]').onclick = () => dialog.close();
  form.onsubmit = (event) => {
    event.preventDefault();
    try {
      contact = authApi('/api/whatsapp/contact', 'PUT', {
        userId: user.id,
        phone: form.elements.phone.value,
        allowed: form.elements.allowed.checked,
      });
      form.elements.phone.value = contact.phone;
      window.modalFormSaved?.(form);
      status.textContent = 'WhatsApp numarası kaydedildi.';
    } catch (error) {
      status.textContent = error.message;
    }
  };
  function phoneDigits(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (/^05\d{9}$/.test(digits)) return '9' + digits;
    if (/^5\d{9}$/.test(digits)) return '90' + digits;
    return digits.startsWith('00') ? digits.slice(2) : digits;
  }
  send.onclick = async () => {
    if (
      phoneDigits(form.elements.phone.value) !== contact.phone ||
      form.elements.allowed.checked !== contact.allowed
    ) {
      status.textContent = 'Göndermeden önce numarayı ve onay durumunu kaydedin.';
      return;
    }
    send.disabled = true;
    try {
      const result = await recoveryApi('/api/password-reset/send', { userId: user.id });
      status.textContent = whatsappDeliveryNotice(result).trim() || 'Şifre bağlantısı isteği işlendi.';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      send.disabled = false;
    }
  };
  dialog.showModal();
}

function addWhatsAppFileButton(actions, doc, kind, eventId, extra = {}) {
  if (!actions || !doc) return;
  if (
    kind === 'clientAttachment'
      ? !hanPageAllowed('clients')
      : !['ceo', 'admin'].includes(hanAuth.role) && (!hanAuth.staffId || doc.relatedStaff !== hanAuth.staffId)
  )
    return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary';
  button.textContent =
    kind === 'photo'
      ? 'Fotoğrafı WhatsApp’tan Gönder'
      : kind === 'file'
        ? 'Eki WhatsApp’tan Gönder'
        : 'WhatsApp’tan Gönder';
  button.onclick = () => whatsappFileDialog(doc, kind, eventId, extra);
  actions.append(button);
}

function whatsappFileDialog(doc, kind, eventId, extra) {
  let dialog = document.getElementById('whatsappFileDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'whatsappFileDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML = `<form><div class="panelhead"><div><h2>WhatsApp’tan Gönder</h2><p>${esc(doc.number || 'Evrak')}</p></div>
    <button type="button" class="secondary" data-wa-close>Kapat</button></div><div class="formbody grid">
    <label class="field full">Alıcının WhatsApp numarası<input name="phone" type="tel" required autocomplete="tel" value="${esc(doc.whatsappPhone || doc.phone1 || '')}"></label>
    ${kind === 'batchReceipt' ? '' : '<label class="settings-check full"><input name="remember" type="checkbox"> Numarayı bu kayıt için kaydet</label>'}
    <label class="settings-check full"><input name="consent" type="checkbox" required> Bu evrakın bu numaraya gönderilmesine alıcının onayı var</label>
    <p class="full" role="status" data-wa-status></p></div><div class="actions"><button type="submit" class="primary">Gönder</button></div></form>`;
  dialog.querySelector('[data-wa-close]').onclick = () => dialog.close();
  dialog.querySelector('form').onsubmit = async (event) => {
    event.preventDefault();
    const form = event.target;
    const submit = form.querySelector('[type="submit"]');
    const status = dialog.querySelector('[data-wa-status]');
    submit.disabled = true;
    try {
      const result = await recoveryApi('/api/whatsapp/document', {
        documentId: doc.id,
        kind,
        eventId,
        ...extra,
        phone: form.elements.phone.value,
        remember: !!form.elements.remember?.checked,
        consent: form.elements.consent.checked,
      });
      status.textContent = whatsappDeliveryNotice(result).trim();
      if (form.elements.remember?.checked) db = authApi('/api/data?key=icrapro-v1');
      if (!result.whatsapp?.accepted) submit.disabled = false;
    } catch (error) {
      status.textContent = error.message;
      submit.disabled = false;
    }
  };
  dialog.showModal();
}
