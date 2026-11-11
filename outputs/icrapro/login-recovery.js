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

// Step 2 of SMS recovery: the one-time temporary password from the SMS plus a new password.
// On success the user is signed in with the new password through the normal login form.
function smsRecoveryGate(account = '') {
  loginFrame(`<form id="smsRecoveryForm" class="panel" aria-labelledby="smsRecoveryTitle">
    <div class="login-heading"><h1 id="smsRecoveryTitle">SMS ile giriş.</h1>
    <p>SMS ile gelen 8 haneli geçici şifreyi girin ve kendi şifrenizi belirleyin. Geçici şifre 15 dakika geçerlidir ve bir kez kullanılır.</p></div>
    <div class="login-fields">
      <label class="field" for="sms-account">Telefon veya kullanıcı adı<input id="sms-account" name="account" required maxlength="80" autocomplete="username" placeholder="05xx xxx xx xx veya kullanıcı adınız"></label>
      <label class="field" for="sms-code">Geçici şifre (SMS)<input id="sms-code" name="code" required inputmode="numeric" pattern="[0-9 ]{8,9}" maxlength="9" autocomplete="one-time-code" placeholder="8 haneli kod"></label>
      <label class="field" for="sms-password">Yeni şifre<input id="sms-password" name="password" type="password" required minlength="10" maxlength="128" autocomplete="new-password" placeholder="En az 10 karakter"></label>
      <label class="field" for="sms-confirm">Yeni şifre tekrar<input id="sms-confirm" name="confirm" type="password" required minlength="10" maxlength="128" autocomplete="new-password" placeholder="Yeni şifrenizi tekrar girin"></label>
    </div><p id="smsRecoveryStatus" class="login-status" role="status"></p>
    <div class="login-actions"><button type="submit" class="login-submit">Şifremi belirle ve giriş yap</button>
    <button type="button" class="login-link" id="smsNewCode">Yeni kod iste</button>
    <button type="button" class="login-link" id="smsBackToLogin">Girişe dön</button></div></form>`);
  const form = document.getElementById('smsRecoveryForm');
  const submit = form.querySelector('[type="submit"]');
  const status = document.getElementById('smsRecoveryStatus');
  form.elements.account.value = account;
  installPasswordVisibility(form);
  (account ? form.elements.code : form.elements.account).focus({ preventScroll: true });
  document.getElementById('smsNewCode').onclick = () => passwordRecoveryGate();
  document.getElementById('smsBackToLogin').onclick = () => {
    authGate(false);
    document.getElementById('login-username').focus({ preventScroll: true });
  };
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
      const result = await recoveryApi('/api/password-reset/sms-complete', {
        account: value.account.trim(),
        code: value.code.replace(/\s/g, ''),
        password: value.password,
      });
      if (!result.ok) throw Error(result.error || 'Geçici şifre hatalı veya süresi dolmuş.');
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

function passwordRecoveryGate(token) {
  loginFrame(`<form id="recoveryForm" class="panel" aria-labelledby="recoveryTitle">
    <div class="login-heading"><h1 id="recoveryTitle">${token ? 'Yeni şifreniz.' : 'Şifrenizi yenileyin.'}</h1>
    <p>${token ? 'Hesabınız için en az 10 karakterli yeni bir şifre belirleyin.' : 'Kullanıcı adınızı veya kayıtlı cep telefonunuzu girin. Büronuzun ayarına göre WhatsApp ile şifre bağlantısı ya da SMS ile tek kullanımlık geçici şifre gönderilir.'}</p></div>
    <div class="login-fields">${
      token
        ? '<label class="field" for="recovery-password">Yeni şifre<input id="recovery-password" name="password" type="password" required minlength="10" maxlength="128" autocomplete="new-password" placeholder="Yeni şifrenizi girin" aria-describedby="recoveryStatus"></label><label class="field" for="recovery-confirm">Yeni şifre tekrar<input id="recovery-confirm" name="confirm" type="password" required minlength="10" maxlength="128" autocomplete="new-password" placeholder="Yeni şifrenizi tekrar girin" aria-describedby="recoveryStatus"></label>'
        : '<label class="field" for="recovery-account">Telefon veya kullanıcı adı<input id="recovery-account" name="account" required maxlength="80" autocomplete="username" placeholder="05xx xxx xx xx veya kullanıcı adınız" aria-describedby="recoveryStatus"></label><p class="login-note" data-recovery-limit>Talep sınırı: WhatsApp ile günde 1, SMS ile günde 3.</p>'
    }</div><p id="recoveryStatus" class="login-status" role="status"></p>
    <div class="login-actions"><button type="submit" class="login-submit">${token ? 'Şifreyi kaydet' : 'Bağlantı iste'}</button>
    ${token ? '' : '<button type="button" class="login-link" id="haveSmsCode">SMS ile geçici şifre aldım</button>'}
    <button type="button" class="login-link" id="backToLogin">Girişe dön</button></div></form>`);
  const form = document.getElementById('recoveryForm');
  const submit = form.querySelector('[type="submit"]');
  const status = document.getElementById('recoveryStatus');
  let recoveryRequestCount = 0;
  document.getElementById('backToLogin').onclick = () => {
    authGate(false);
    document.getElementById('login-username').focus({ preventScroll: true });
  };
  if (token) installPasswordVisibility(form);
  else document.getElementById('haveSmsCode').onclick = () => smsRecoveryGate();
  form.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    status.textContent = '';
    const value = Object.fromEntries(new FormData(form));
    try {
      if (token) {
        if (value.password !== value.confirm) throw Error('Şifreler aynı olmalıdır.');
        await recoveryApi('/api/password-reset/complete', { token, password: value.password });
        form.reset();
        status.textContent = 'Şifreniz güncellendi. Yeni şifrenizle giriş yapabilirsiniz.';
      } else {
        if (recoveryRequestCount === 1)
          form.querySelector('[data-recovery-limit]').textContent =
            'Ek talep sınırları: 7 günde 3 ve 30 günde 8. Kalan haklar WhatsApp mesajında gösterilir.';
        const result = await recoveryApi('/api/password-reset/request', { account: value.account });
        recoveryRequestCount++;
        // The platform SMS channel: go straight to entering the temporary password. The same
        // screen appears whether or not the account exists.
        if (result.channel === 'sms') return smsRecoveryGate(value.account);
        form.reset();
        status.textContent =
          'Uygun bir hesap ve kalan hak varsa bağlantı kayıtlı WhatsApp numarasına gönderilir.';
        submit.disabled = false;
      }
    } catch (error) {
      status.textContent = error.message;
      submit.disabled = false;
    }
  };
}
