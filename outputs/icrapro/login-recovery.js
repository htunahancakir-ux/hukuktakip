async function recoveryApi(path, data) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
    body: JSON.stringify(data),
    cache: 'no-store',
  });
  const result = await response.json().catch(() => ({}));
  if (
    response.status === 423 &&
    result.code === 'staff_on_break' &&
    typeof applyStaffBreakStatus === 'function'
  )
    applyStaffBreakStatus(result.activeBreak);
  if (!response.ok) throw Error(result.error || 'İşlem tamamlanamadı. Daha sonra tekrar deneyin.');
  return result;
}

// The ways this office can send a code, its first choice first (Ayarlar → Entegrasyonlar →
// Şifre Yenileme). Null when the answer cannot be read.
async function recoveryChannels() {
  try {
    const response = await fetch('/api/password-reset/channels', {
      headers: { 'X-Han-Request': '1' },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const result = await response.json();
    return Array.isArray(result.channels) ? result.channels : null;
  } catch {
    return null;
  }
}

const RECOVERY_SEND = { whatsapp: 'WhatsApp ile gönder', sms: 'SMS ile gönder', email: 'E-posta ile gönder' };
const RECOVERY_MISSING = {
  whatsapp: 'WhatsApp mesajı gelmedi mi?',
  sms: 'SMS gelmedi mi?',
  email: 'E-posta gelmedi mi?',
};
// The other ways are offered after this wait, so a slow message is not answered with a second one.
const RECOVERY_WAIT_SECONDS = 30;

function recoveryBackToLogin() {
  authGate(false);
  document.getElementById('login-username')?.focus({ preventScroll: true });
}

// Asks for a code on `channel` (or the office's first way) and opens the matching screen.
async function requestRecovery(account, channel) {
  const result = await recoveryApi('/api/password-reset/request', {
    account,
    ...(channel ? { channel } : {}),
  });
  showRecoveryChannel(account, result);
}
function showRecoveryChannel(account, result) {
  const alternatives = Array.isArray(result.alternatives) ? result.alternatives : [];
  if (result.channel === 'sms' || result.channel === 'email')
    return codeRecoveryGate(account, result.channel, alternatives);
  if (result.channel === 'whatsapp') return whatsappSentGate(account, alternatives);
  return managerHelpGate(account, { none: true });
}

// "SMS gelmedi mi?": after a short wait, sending again, the office's other ways and
// "Yöneticiden iste". The space is reserved from the start so nothing below moves.
function recoveryFallbackMarkup(channel) {
  return `<div class="login-fallback" data-recovery-fallback>
    <button type="button" class="login-link" data-fallback-open disabled>${RECOVERY_MISSING[channel]} (${RECOVERY_WAIT_SECONDS} sn)</button>
    <div class="login-fallback-choices" data-fallback-choices hidden></div></div>`;
}
function bindRecoveryFallback(form, account, channel, alternatives, status) {
  const box = form.querySelector('[data-recovery-fallback]');
  const open = box.querySelector('[data-fallback-open]');
  const choices = box.querySelector('[data-fallback-choices]');
  const accountValue = () => form.elements.account?.value.trim() || account;
  let left = RECOVERY_WAIT_SECONDS;
  const timer = setInterval(() => {
    if (!form.isConnected) return clearInterval(timer);
    left--;
    if (left > 0) {
      open.textContent = `${RECOVERY_MISSING[channel]} (${left} sn)`;
      return;
    }
    clearInterval(timer);
    open.textContent = RECOVERY_MISSING[channel];
    open.disabled = false;
  }, 1000);
  const choice = (label, action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'login-link';
    button.textContent = label;
    button.onclick = async () => {
      if (!accountValue()) {
        status.textContent = 'Önce kullanıcı adınızı, cep telefonunuzu veya e-posta adresinizi girin.';
        return;
      }
      choices.querySelectorAll('button').forEach((item) => (item.disabled = true));
      try {
        await action();
      } catch (error) {
        status.textContent = error.message;
        choices.querySelectorAll('button').forEach((item) => (item.disabled = false));
      }
    };
    return button;
  };
  open.onclick = () => {
    open.hidden = true;
    choices.hidden = false;
    choices.append(
      ...alternatives.map((other) =>
        choice(RECOVERY_SEND[other], () => requestRecovery(accountValue(), other)),
      ),
      choice(channel === 'whatsapp' ? 'WhatsApp bağlantısını yeniden gönder' : 'Kodu yeniden gönder', () =>
        requestRecovery(accountValue(), channel),
      ),
      choice('Yöneticiden iste', async () => managerHelpGate(accountValue())),
    );
    choices.querySelector('button')?.focus();
  };
}

// The code step of SMS or e-mail recovery: the code and a new password. On success the user is
// signed in with the new password through the normal login form. An e-mail code is sent only to
// an address the user verified in Hesabım; otherwise the other ways and "Yöneticiden iste" below.
function codeRecoveryGate(account = '', channel = 'sms', alternatives = []) {
  const email = channel === 'email';
  loginFrame(`<form id="codeRecoveryForm" class="panel" aria-labelledby="codeRecoveryTitle" data-channel="${channel}">
    <div class="login-heading"><h1 id="codeRecoveryTitle">${email ? 'E-posta ile yenileme.' : 'SMS ile giriş.'}</h1>
    <p id="codeRecoveryHint">${
      email
        ? 'E-postanıza gelen 8 haneli kodu girin ve yeni şifrenizi belirleyin. Kod 15 dakika geçerlidir ve yalnızca Hesabım bölümünde doğruladığınız adrese gönderilir. Adresinizi doğrulamadıysanız aşağıdan başka bir yol seçin ya da yöneticinizden isteyin.'
        : 'SMS ile gelen 8 haneli geçici şifreyi girin ve kendi şifrenizi belirleyin. Geçici şifre 15 dakika geçerlidir ve bir kez kullanılır.'
    }</p></div>
    <div class="login-fields">
      <label class="field" for="code-account">Kullanıcı adı, telefon veya e-posta<input id="code-account" name="account" required maxlength="120" autocomplete="username" autocorrect="off" autocapitalize="none" spellcheck="false" placeholder="Kullanıcı adınız veya 05xx xxx xx xx"></label>
      <label class="field" for="code-value">${email ? 'E-postadaki kod' : 'Geçici şifre (SMS)'}<input id="code-value" name="code" type="text" required inputmode="numeric" pattern="[0-9 ]{8,9}" maxlength="9" autocomplete="one-time-code" aria-describedby="codeRecoveryHint" placeholder="8 haneli kod"></label>
      <label class="field" for="code-password">Yeni şifre<input id="code-password" name="password" type="password" required minlength="10" maxlength="128" autocomplete="new-password" placeholder="En az 10 karakter"></label>
      <label class="field" for="code-confirm">Yeni şifre tekrar<input id="code-confirm" name="confirm" type="password" required minlength="10" maxlength="128" autocomplete="new-password" placeholder="Yeni şifrenizi tekrar girin"></label>
    </div><p id="codeRecoveryStatus" class="login-status" role="status"></p>
    <div class="login-actions"><button type="submit" class="login-submit">Şifremi belirle ve giriş yap</button>
    ${recoveryFallbackMarkup(channel)}
    <button type="button" class="login-link" id="codeBackToLogin">Girişe dön</button></div></form>`);
  const form = document.getElementById('codeRecoveryForm');
  const submit = form.querySelector('[type="submit"]');
  const status = document.getElementById('codeRecoveryStatus');
  form.elements.account.value = account;
  installPasswordVisibility(form);
  (account ? form.elements.code : form.elements.account).focus({ preventScroll: true });
  document.getElementById('codeBackToLogin').onclick = recoveryBackToLogin;
  bindRecoveryFallback(form, account, channel, alternatives, status);
  form.onsubmit = async (event) => {
    event.preventDefault();
    status.textContent = '';
    const value = Object.fromEntries(new FormData(form));
    if (value.password !== value.confirm) {
      status.textContent = 'Şifreler aynı olmalıdır.';
      return;
    }
    submit.disabled = true;
    try {
      const result = await recoveryApi(
        email ? '/api/password-reset/email-complete' : '/api/password-reset/sms-complete',
        { account: value.account.trim(), code: value.code.replace(/\s/g, ''), password: value.password },
      );
      if (!result.ok) throw Error(result.error || 'Kod hatalı veya süresi dolmuş.');
      authGate(false);
      const login = document.getElementById('loginForm');
      document.getElementById('login-username').value = result.username;
      document.getElementById('login-password').value = value.password;
      login.requestSubmit();
    } catch (error) {
      status.textContent = error.message;
      submit.disabled = false;
    }
  };
}
// Kept for callers that open the SMS step directly.
function smsRecoveryGate(account = '', alternatives = []) {
  return codeRecoveryGate(account, 'sms', alternatives);
}

function whatsappSentGate(account, alternatives = []) {
  loginFrame(`<form id="whatsappSentForm" class="panel" aria-labelledby="whatsappSentTitle">
    <div class="login-heading"><h1 id="whatsappSentTitle">WhatsApp’a bakın.</h1>
    <p>Uygun bir hesap ve kalan hak varsa şifre bağlantısı kayıtlı WhatsApp numaranıza gönderildi. Bağlantıyı açıp yeni şifrenizi belirleyin.</p></div>
    <p id="recoveryStatus" class="login-status" role="status">Bağlantı gönderildi.</p>
    <div class="login-actions">${recoveryFallbackMarkup('whatsapp')}
    <button type="button" class="login-link" id="whatsappBackToLogin">Girişe dön</button></div></form>`);
  const form = document.getElementById('whatsappSentForm');
  form.onsubmit = (event) => event.preventDefault();
  document.getElementById('whatsappBackToLogin').onclick = recoveryBackToLogin;
  bindRecoveryFallback(form, account, 'whatsapp', alternatives, document.getElementById('recoveryStatus'));
}

// The last resort: the request lands in the office managers' inbox; a manager sets a new
// password and passes it on (in person, or by SMS or e-mail to a corrected contact).
function managerHelpGate(account = '', { none = false } = {}) {
  loginFrame(`<form id="managerHelpForm" class="panel" aria-labelledby="managerHelpTitle">
    <div class="login-heading"><h1 id="managerHelpTitle">Yöneticinizden isteyin.</h1>
    <p>${none ? 'Büronuzda şifre yenileme için SMS, e-posta veya WhatsApp henüz açık değil. ' : ''}Kayıtlı telefonunuz ya da e-postanız yoksa veya kod size ulaşmıyorsa talebiniz büro yöneticilerine mesaj olarak iletilir. Yöneticiniz kimliğinizi doğruladıktan sonra yeni şifrenizi belirleyip size iletir.</p></div>
    <div class="login-fields">
      <label class="field" for="help-account">Kullanıcı adı, telefon veya e-posta<input id="help-account" name="account" required maxlength="120" autocomplete="username" autocorrect="off" autocapitalize="none" spellcheck="false" placeholder="Kullanıcı adınız"></label>
      <label class="field" for="help-note">Yöneticinize not (isteğe bağlı)<input id="help-note" name="note" maxlength="300" data-optional="true" autocomplete="off" placeholder="Örn. Telefon numaram değişti, bana 05xx… numarasından ulaşın"></label>
    </div><p id="managerHelpStatus" class="login-status" role="status"></p>
    <div class="login-actions"><button type="submit" class="login-submit">Yöneticiden yeni şifre iste</button>
    <p class="login-note">Büronun tek yöneticisi sizseniz platform desteğine başvurun.</p>
    <button type="button" class="login-link" id="helpBackToLogin">Girişe dön</button></div></form>`);
  const form = document.getElementById('managerHelpForm');
  const submit = form.querySelector('[type="submit"]');
  const status = document.getElementById('managerHelpStatus');
  form.elements.account.value = account;
  (account ? form.elements.note : form.elements.account).focus({ preventScroll: true });
  document.getElementById('helpBackToLogin').onclick = recoveryBackToLogin;
  form.onsubmit = async (event) => {
    event.preventDefault();
    status.textContent = '';
    submit.disabled = true;
    try {
      await recoveryApi('/api/password-reset/ask-manager', {
        account: form.elements.account.value.trim(),
        note: form.elements.note.value.trim(),
      });
      // The same answer whether or not the account exists.
      status.textContent =
        'Talebiniz iletildi. Uygun bir hesap varsa yöneticiniz yeni şifrenizi belirleyip size iletecek.';
      submit.textContent = 'Talep iletildi';
    } catch (error) {
      status.textContent = error.message;
      submit.disabled = false;
    }
  };
}

function passwordRecoveryGate(token) {
  if (token) return recoveryLinkGate(token);
  loginFrame(`<form id="recoveryForm" class="panel" aria-labelledby="recoveryTitle">
    <div class="login-heading"><h1 id="recoveryTitle">Şifrenizi yenileyin.</h1>
    <p id="recoveryIntro">Kullanıcı adınızı, kayıtlı cep telefonunuzu veya doğrulanmış e-posta adresinizi girin. Büronuzun seçtiği yolla (SMS, e-posta veya WhatsApp) tek kullanımlık kod gönderilir.</p></div>
    <div class="login-fields"><label class="field" for="recovery-account">Kullanıcı adı, telefon veya e-posta<input id="recovery-account" name="account" required maxlength="120" autocomplete="username" autocorrect="off" autocapitalize="none" spellcheck="false" placeholder="Kullanıcı adınız veya 05xx xxx xx xx" aria-describedby="recoveryIntro recoveryStatus"></label>
    <p class="login-note" data-recovery-limit>Talep sınırı: SMS ve e-posta ile günde 3, WhatsApp ile günde 1.</p></div>
    <p id="recoveryStatus" class="login-status" role="status"></p>
    <div class="login-actions"><button type="submit" class="login-submit">Kod gönder</button>
    <div class="login-fallback-choices"><button type="button" class="login-link" id="haveSmsCode" hidden>SMS ile kod aldım</button><button type="button" class="login-link" id="haveEmailCode" hidden>E-posta ile kod aldım</button><button type="button" class="login-link" id="askManager">Yöneticiden iste</button></div>
    <button type="button" class="login-link" id="backToLogin">Girişe dön</button></div></form>`);
  const form = document.getElementById('recoveryForm');
  const submit = form.querySelector('[type="submit"]');
  const status = document.getElementById('recoveryStatus');
  const account = () => form.elements.account.value.trim();
  let open = [];
  document.getElementById('backToLogin').onclick = recoveryBackToLogin;
  document.getElementById('haveSmsCode').onclick = () =>
    codeRecoveryGate(
      account(),
      'sms',
      open.filter((item) => item !== 'sms'),
    );
  document.getElementById('haveEmailCode').onclick = () =>
    codeRecoveryGate(
      account(),
      'email',
      open.filter((item) => item !== 'email'),
    );
  document.getElementById('askManager').onclick = () => managerHelpGate(account());
  recoveryChannels().then((channels) => {
    if (!form.isConnected) return;
    // Unknown: keep the long-standing SMS shortcut.
    open = channels || ['sms'];
    document.getElementById('haveSmsCode').hidden = !open.includes('sms');
    document.getElementById('haveEmailCode').hidden = !open.includes('email');
    if (channels && !channels.length) {
      submit.textContent = 'Yöneticiden yeni şifre iste';
      document.getElementById('askManager').hidden = true;
      document.getElementById('recoveryIntro').textContent =
        'Büronuzda şifre yenileme için SMS, e-posta veya WhatsApp henüz açık değil. Yöneticinizden yeni şifre isteyin.';
    }
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    status.textContent = '';
    try {
      await requestRecovery(account());
    } catch (error) {
      status.textContent = error.message;
      submit.disabled = false;
    }
  };
}

// A WhatsApp password link (#sifre=<token>) is either a user's own reset link or the link of
// the office's live delivery test (Ayarlar → WhatsApp → Şifre kurtarma canlı testi). The test
// link changes no password: opening it and confirming proves the message really arrives.
function recoveryLinkGate(token) {
  loginFrame(`<section class="panel" aria-labelledby="linkCheckTitle"><div class="login-heading">
    <h1 id="linkCheckTitle">Bağlantı kontrol ediliyor…</h1></div>
    <p id="linkCheckStatus" class="login-status" role="status"></p></section>`);
  recoveryApi('/api/password-reset/channel-test-link', { token })
    .then((result) =>
      result.test ? channelTestGate(token, result.usable === true) : passwordLinkGate(token),
    )
    .catch((error) => {
      document.getElementById('linkCheckTitle').textContent = 'Bağlantı kontrol edilemedi.';
      document.getElementById('linkCheckStatus').textContent = error.message;
    });
}
function channelTestGate(token, usable) {
  loginFrame(`<section class="panel" aria-labelledby="channelTestTitle">
    <div class="login-heading"><h1 id="channelTestTitle">WhatsApp kurtarma testi.</h1>
    <p>${
      usable
        ? 'Bu bağlantı büronuzun WhatsApp şifre yenileme şablonundan geldi. Testi doğruladığınızda WhatsApp seçeneği “Şifremi unuttum” ekranında açılır. Hesap şifreniz değişmez.'
        : 'Test bağlantısının süresi dolmuş ya da ayarlar değişmiş. Ayarlar → WhatsApp bölümünden yeni test başlatın.'
    }</p></div>
    <p id="channelTestStatus" class="login-status" role="status"></p>
    <div class="login-actions">${usable ? '<button type="button" class="login-submit" id="channelTestConfirm">Testi doğrula</button>' : ''}
    <button type="button" class="login-link" id="channelTestBack">Girişe dön</button></div></section>`);
  document.getElementById('channelTestBack').onclick = recoveryBackToLogin;
  const button = document.getElementById('channelTestConfirm');
  if (!button) return;
  const status = document.getElementById('channelTestStatus');
  button.onclick = async () => {
    button.disabled = true;
    status.textContent = '';
    try {
      const confirmed = await recoveryApi('/api/password-reset/channel-test-link', { token, confirm: true });
      if (!confirmed.ok) throw Error(confirmed.error || 'Test doğrulanamadı.');
      status.textContent =
        '✓ WhatsApp kurtarma testi doğrulandı. Seçenek artık giriş ekranında kullanılabilir.';
      button.hidden = true;
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  };
}

// The page a user's own WhatsApp password link opens.
function passwordLinkGate(token) {
  loginFrame(`<form id="recoveryForm" class="panel" aria-labelledby="recoveryTitle">
    <div class="login-heading"><h1 id="recoveryTitle">Yeni şifreniz.</h1>
    <p>Hesabınız için en az 10 karakterli yeni bir şifre belirleyin.</p></div>
    <div class="login-fields"><label class="field" for="recovery-password">Yeni şifre<input id="recovery-password" name="password" type="password" required minlength="10" maxlength="128" autocomplete="new-password" placeholder="Yeni şifrenizi girin" aria-describedby="recoveryStatus"></label><label class="field" for="recovery-confirm">Yeni şifre tekrar<input id="recovery-confirm" name="confirm" type="password" required minlength="10" maxlength="128" autocomplete="new-password" placeholder="Yeni şifrenizi tekrar girin" aria-describedby="recoveryStatus"></label></div>
    <p id="recoveryStatus" class="login-status" role="status"></p>
    <div class="login-actions"><button type="submit" class="login-submit">Şifreyi kaydet</button>
    <button type="button" class="login-link" id="backToLogin">Girişe dön</button></div></form>`);
  const form = document.getElementById('recoveryForm');
  const submit = form.querySelector('[type="submit"]');
  const status = document.getElementById('recoveryStatus');
  document.getElementById('backToLogin').onclick = recoveryBackToLogin;
  installPasswordVisibility(form);
  form.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    status.textContent = '';
    const value = Object.fromEntries(new FormData(form));
    try {
      if (value.password !== value.confirm) throw Error('Şifreler aynı olmalıdır.');
      await recoveryApi('/api/password-reset/complete', { token, password: value.password });
      form.reset();
      status.textContent = 'Şifreniz güncellendi. Yeni şifrenizle giriş yapabilirsiniz.';
    } catch (error) {
      status.textContent = error.message;
      submit.disabled = false;
    }
  };
}
