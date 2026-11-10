function contactFields(value) {
  return `<label class="field">E-posta adresi<input name="contactEmail" type="email" maxlength="254" autocomplete="email" value="${esc(value.email || '')}" data-optional="true"></label><label class="field">Cep telefonu<input name="contactMobile" type="tel" maxlength="40" autocomplete="tel" placeholder="05xx xxx xx xx" value="${esc(value.mobilePhone || '')}" data-optional="true"></label>`;
}
function bindContactEditor(host, profile, route, done) {
  host.innerHTML = `<h3>İletişim bilgilerim</h3><p>E-posta adresinizi ve cep telefonunuzu güncel tutun.</p><div class="grid">${contactFields(profile)}</div><p role="status" data-contact-status></p><button type="button" class="primary" data-save-contact>İletişim Bilgilerini Kaydet</button>`;
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
      // Only this section was saved; password inputs elsewhere in Hesabım remain untouched.
      host.querySelectorAll('input').forEach((input) => (input.defaultValue = input.value));
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
function showUserContact(account) {
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
    if (profile.complete) {
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
    label.textContent =
      'Lütfen ' +
      (missing.map((key) => (key === 'email' ? 'e-posta adresinizi' : 'cep telefonunuzu')).join(' ve ') ||
        'iletişim bilgilerinizi') +
      ' Hesabım ekranından tamamlayın.';
    const button = document.createElement('button');
    button.className = 'secondary';
    button.type = 'button';
    button.textContent = 'Bilgilerimi Tamamla';
    button.onclick = showAccountPanel;
    banner.append(label, button);
  } catch {}
};
