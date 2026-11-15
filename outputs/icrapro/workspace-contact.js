function contactFields(value) {
  return `<label class="field">E-posta adresi<input name="contactEmail" type="email" maxlength="254" autocomplete="email" value="${esc(value.email || '')}" data-optional="true"></label><label class="field">Cep telefonu<input name="contactMobile" type="tel" maxlength="40" autocomplete="tel" placeholder="05xx xxx xx xx" value="${esc(value.mobilePhone || '')}" data-optional="true"></label>`;
}
// A small mark beside an e-mail address: verified by a code sent to it, or not yet.
function emailVerifiedMark(verified) {
  return verified
    ? '<span class="email-verified-mark" title="Bu adrese gönderilen kodla doğrulandı">✓ Doğrulandı</span>'
    : '<span class="email-unverified-mark" title="Bu adres henüz doğrulanmadı">Doğrulanmadı</span>';
}
// E-mail verification under the contact fields: send a 6-digit code to the saved address and
// enter it here. A manager can do it for a staff account while the person reads out the code.
function bindEmailVerification(host, profile, onVerified) {
  const box = host.querySelector('[data-email-verify]');
  const email = host.querySelector('[name="contactEmail"]');
  const state = box.querySelector('[data-verify-state]');
  const send = box.querySelector('[data-verify-send]');
  const code = box.querySelector('[name="verifyCode"]');
  const confirm = box.querySelector('[data-verify-confirm]');
  const status = box.querySelector('[data-verify-status]');
  const render = () => {
    const saved = profile.email || '';
    const changed = email.value.trim() !== saved;
    box.hidden = !saved && !email.value.trim();
    const canVerify = !!saved && !changed && !profile.emailVerified && profile.emailVerification === true;
    state.innerHTML = changed
      ? '<span class="email-unverified-mark">Kaydedilince doğrulanabilir</span>'
      : emailVerifiedMark(profile.emailVerified === true);
    // Disabled rather than hidden: the row keeps its size whatever the state.
    send.disabled = !canVerify;
    code.disabled = !canVerify;
    confirm.disabled = !canVerify;
    if (!changed && !profile.emailVerified && profile.emailVerification !== true && saved)
      status.textContent = 'E-posta gönderimi bu büroda henüz açık değil; doğrulama kodu gönderilemiyor.';
  };
  email.addEventListener('input', render);
  send.onclick = () => {
    status.textContent = '';
    send.disabled = true;
    try {
      const result = authApi('/api/email-verification/send', 'POST', { userId: profile.id });
      if (result.email && result.email.sent === false) throw Error(result.email.error);
      status.textContent = `Kod ${result.sentTo} adresine gönderildi. 24 saat geçerlidir.`;
      code.focus();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      render();
    }
  };
  confirm.onclick = () => {
    if (!code.reportValidity() || !code.value.trim()) {
      status.textContent = 'E-postadaki 6 haneli kodu girin.';
      return;
    }
    try {
      const result = authApi('/api/email-verification/confirm', 'POST', {
        userId: profile.id,
        code: code.value.replace(/\s/g, ''),
      });
      if (!result.ok) throw Error(result.error);
      Object.assign(profile, { email: result.email, emailVerified: true });
      code.value = '';
      code.defaultValue = '';
      status.textContent = 'E-posta adresi doğrulandı.';
      onVerified?.(result);
    } catch (error) {
      status.textContent = error.message;
    }
    render();
  };
  // Enter in the code field verifies instead of saving the contact form.
  code.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    confirm.click();
  });
  render();
  return render;
}
function bindContactEditor(host, profile, route, done) {
  host.innerHTML = `<h3>İletişim bilgilerim</h3><p>E-posta adresinizi ve cep telefonunuzu güncel tutun. Doğrulanan e-posta adresine “Şifremi unuttum” kodu gönderilebilir.</p><div class="grid">${contactFields(profile)}</div>
    <div class="contact-verify" data-email-verify><span data-verify-state></span>
      <button type="button" class="secondary" data-verify-send>Doğrulama kodu gönder</button>
      <label class="field">E-postadaki kod<input name="verifyCode" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" placeholder="6 haneli kod" data-optional="true"></label>
      <button type="button" class="secondary" data-verify-confirm>Doğrula</button>
      <p class="full" role="status" data-verify-status></p></div>
    <p role="status" data-contact-status></p><button type="button" class="primary" data-save-contact>İletişim Bilgilerini Kaydet</button>`;
  const renderVerification = bindEmailVerification(host, profile, (verified) => {
    if (verified.id === hanAuth.id) window.refreshContactReminder?.();
    done?.(verified);
  });
  const save = (event) => {
    event.preventDefault();
    const email = host.querySelector('[name="contactEmail"]'),
      phone = host.querySelector('[name="contactMobile"]');
    if (!email.reportValidity() || !phone.reportValidity()) return;
    const status = host.querySelector('[data-contact-status]');
    try {
      const saved = authApi(route, 'PUT', { id: profile.id, email: email.value, mobilePhone: phone.value });
      status.textContent = saved.complete
        ? 'İletişim bilgileriniz kaydedildi.'
        : 'Kaydedildi. Eksik iletişim bilginizi de tamamlayın.';
      email.value = saved.email;
      phone.value = saved.mobilePhone;
      Object.assign(profile, saved);
      renderVerification();
      // Only this section was saved; password inputs elsewhere in Hesabım remain untouched.
      host.querySelectorAll('input').forEach((input) => (input.defaultValue = input.value));
      if (host.tagName === 'FORM') window.modalFormSaved?.(host);
      if (saved.id === hanAuth.id) window.refreshContactReminder?.();
      done?.(saved);
    } catch (error) {
      status.textContent = error.message;
    }
  };
  const button = host.querySelector('[data-save-contact]');
  if (host.tagName === 'FORM') {
    button.type = 'submit';
    host.onsubmit = save;
  } else button.onclick = save;
}
function setupAccountContact(form) {
  const host = document.createElement('form');
  host.id = 'accountContactForm';
  form.querySelector('.account-settings-form').prepend(host);
  try {
    bindContactEditor(host, authApi('/api/account/contact'), '/api/account/contact');
  } catch (error) {
    host.textContent = error.message;
  }
}
function showUserContact(account, onSaved) {
  let dialog = document.getElementById('userContactDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'userContactDialog';
    document.body.append(dialog);
  }
  dialog.replaceChildren();
  const head = document.createElement('div');
  head.className = 'panelhead';
  const title = document.createElement('h2');
  title.textContent = account.name + ' · İletişim Bilgileri';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'secondary';
  close.textContent = 'Kapat';
  close.onclick = () => dialog.close();
  head.append(title, close);
  const host = document.createElement('div');
  host.className = 'formbody';
  dialog.append(head, host);
  try {
    bindContactEditor(
      host,
      authApi('/api/users/contact?id=' + encodeURIComponent(account.id)),
      '/api/users/contact',
      onSaved,
    );
    host.querySelector('h3').textContent = 'E-posta ve cep telefonu';
  } catch (error) {
    host.textContent = error.message;
  }
  dialog.showModal();
}
let contactReminderRequest = 0;
window.refreshContactReminder = async function () {
  const seq = ++contactReminderRequest;
  if (!window.hanAuth || hanAuth.readOnly) return;
  try {
    const response = await fetch('/api/account/contact', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-Han-Request': '1' },
    });
    if (!response.ok) return;
    const profile = await response.json();
    if (seq !== contactReminderRequest) return;
    let banner = document.getElementById('contactCompletionReminder');
    // A saved but unverified address is asked to be verified once e-mail sending is on.
    const verify =
      profile.complete && profile.email && !profile.emailVerified && profile.emailVerification === true;
    if (profile.complete && !verify) {
      banner?.remove();
      return;
    }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'contactCompletionReminder';
      banner.className = 'notice contact-completion-reminder';
      banner.setAttribute('role', 'status');
      document.querySelector('main')?.prepend(banner);
    }
    banner.replaceChildren();
    const label = document.createElement('span');
    const missing =
      profile.missing || [!profile.email && 'email', !profile.mobilePhone && 'mobilePhone'].filter(Boolean);
    label.textContent = verify
      ? 'E-posta adresinizi doğrulayın: Hesabım ekranında “Doğrulama kodu gönder”e basın ve e-postanıza gelen kodu girin.'
      : 'Lütfen ' +
        (missing.map((key) => (key === 'email' ? 'e-posta adresinizi' : 'cep telefonunuzu')).join(' ve ') ||
          'iletişim bilgilerinizi') +
        ' Hesabım ekranından tamamlayın.';
    const button = document.createElement('button');
    button.className = 'secondary';
    button.type = 'button';
    button.textContent = verify ? 'E-postamı Doğrula' : 'Bilgilerimi Tamamla';
    button.onclick = showAccountPanel;
    banner.append(label, button);
  } catch {}
};
