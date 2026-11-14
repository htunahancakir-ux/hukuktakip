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
function smsRecoveryGate(account = '', channel = 'sms') {
  const byEmail = channel === 'email';
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
  if (byEmail) {
    document.getElementById('smsRecoveryTitle').textContent = 'E-posta ile şifre sıfırlama.';
    form.querySelector('.login-heading p').textContent =
      'Uygun bir hesap ve kalan hak varsa kod doğrulanmış kurtarma e-postasına gönderilir. E-postadaki 8 haneli kodu girin. Kod 15 dakika geçerlidir ve bir kez kullanılır.';
    const input = form.elements.account;
    input.maxLength = 254;
    input.placeholder = 'E-posta veya kullanıcı adınız';
    input.parentElement.firstChild.textContent = 'E-posta veya kullanıcı adı';
    form.elements.code.parentElement.firstChild.textContent = 'E-postadaki 8 haneli kod';
  }
  form.elements.account.value = account;
  installPasswordVisibility(form);
  (account ? form.elements.code : form.elements.account).focus({ preventScroll: true });
  document.getElementById('smsNewCode').onclick = () =>
    byEmail ? emailRecoveryGate() : passwordRecoveryGate(undefined, 'phone');
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
      const result = await recoveryApi(
        byEmail ? '/api/password-reset/email-complete' : '/api/password-reset/sms-complete',
        {
          account: value.account.trim(),
          code: value.code.replace(/\s/g, ''),
          password: value.password,
        },
      );
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

function passwordRecoveryGate(token, channel = 'email', testChecked = false) {
  if (token && !testChecked) {
    recoveryChannelTestGate(token, channel);
    return;
  }
  if (!token && channel === 'email') return emailRecoveryGate();
  loginFrame(`<form id="recoveryForm" class="panel" aria-labelledby="recoveryTitle">
    <div class="login-heading"><h1 id="recoveryTitle">${token ? 'Yeni şifreniz.' : 'Şifrenizi yenileyin.'}</h1>
    <p>${token ? 'Hesabınız için en az 10 karakterli yeni bir şifre belirleyin.' : 'Kullanıcı adınızı veya kayıtlı cep telefonunuzu girin. Büronuzun ayarına göre WhatsApp ile şifre bağlantısı ya da SMS ile tek kullanımlık geçici şifre gönderilir.'}</p></div>
    <div class="login-fields">${
      token
        ? '<label class="field" for="recovery-password">Yeni şifre<input id="recovery-password" name="password" type="password" required minlength="10" maxlength="128" autocomplete="new-password" placeholder="Yeni şifrenizi girin" aria-describedby="recoveryStatus"></label><label class="field" for="recovery-confirm">Yeni şifre tekrar<input id="recovery-confirm" name="confirm" type="password" required minlength="10" maxlength="128" autocomplete="new-password" placeholder="Yeni şifrenizi tekrar girin" aria-describedby="recoveryStatus"></label>'
        : '<label class="field" for="recovery-account">Telefon veya kullanıcı adı<input id="recovery-account" name="account" required maxlength="80" autocomplete="username" placeholder="05xx xxx xx xx veya kullanıcı adınız" aria-describedby="recoveryStatus"></label><p class="login-note" data-recovery-limit>Talep sınırı: WhatsApp ile günde 1, SMS ile günde 3.</p>'
    }</div><p id="recoveryStatus" class="login-status" role="status"></p>
    <div class="login-actions"><button type="submit" class="login-submit">${token ? 'Şifreyi kaydet' : 'Bağlantı iste'}</button>
    ${token ? '' : `${channel === 'phone' ? '<button type="button" class="login-link" id="haveSmsCode">SMS ile geçici şifre aldım</button>' : ''}<button type="button" class="login-link" id="emailRecovery">E-posta ile şifremi sıfırla</button>`}
    <button type="button" class="login-link" id="backToLogin">Girişe dön</button></div></form>`);
  const form = document.getElementById('recoveryForm');
  const submit = form.querySelector('[type="submit"]');
  const status = document.getElementById('recoveryStatus');
  if (!token && ['sms', 'whatsapp'].includes(channel)) {
    const label = channel === 'sms' ? 'SMS' : 'WhatsApp';
    document.getElementById('recoveryTitle').textContent = `${label} ile şifre sıfırlama.`;
    form.querySelector('.login-heading p').textContent =
      channel === 'sms'
        ? 'Kayıtlı cep telefonunuza tek kullanımlık şifre sıfırlama kodu gönderilir.'
        : 'Onaylı WhatsApp numaranıza şifre sıfırlama bağlantısı gönderilir.';
    form.querySelector('[type="submit"]').textContent = `${label} ile gönder`;
    form.querySelector('[data-recovery-limit]').textContent =
      channel === 'sms' ? 'Talep sınırı: günde 3.' : 'Talep sınırı: günde 1.';
  }
  let recoveryRequestCount = 0;
  document.getElementById('backToLogin').onclick = () => {
    authGate(false);
    document.getElementById('login-username').focus({ preventScroll: true });
  };
  if (token) installPasswordVisibility(form);
  else {
    const haveSms = document.getElementById('haveSmsCode');
    if (haveSms) haveSms.onclick = () => smsRecoveryGate();
    document.getElementById('emailRecovery').onclick = () => emailRecoveryGate();
  }
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
            channel === 'sms'
              ? 'Ek talep sınırları: 7 günde 6 ve 30 günde 12.'
              : 'Ek talep sınırları: 7 günde 3 ve 30 günde 8. Kalan haklar WhatsApp mesajında gösterilir.';
        const result = await recoveryApi('/api/password-reset/request', {
          account: value.account,
          ...(['sms', 'whatsapp'].includes(channel) ? { channel } : {}),
        });
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

function emailRecoveryGate() {
  loginFrame(
    `<form id="emailRecoveryForm" class="panel"><div class="login-heading"><h1>E-posta ile şifre sıfırlama.</h1><p>Hesabım bölümünde önceden doğruladığınız kurtarma e-postasını veya kullanıcı adınızı girin. Şifre sıfırlama kodu bu e-posta adresine gönderilir. E-postanızı daha önce doğrulamadıysanız büro yöneticinizle iletişime geçin.</p></div><div class="login-fields"><label class="field">E-posta veya kullanıcı adı<input name="account" required maxlength="254" autocomplete="username"></label></div><p role="status" class="login-status"></p><div class="login-actions"><button type="submit" class="login-submit">Şifre sıfırlama e-postası gönder</button><button type="button" class="login-link" data-email-login>Girişe dön</button></div></form>`,
  );
  const form = document.getElementById('emailRecoveryForm');
  // The server reveals only channels whose current saved setup passed a live delivery test.
  fetch('/api/password-reset/channels', { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok || !form.isConnected) return;
      const channels = await response.json();
      for (const [channel, label] of [
        ['sms', 'SMS'],
        ['whatsapp', 'WhatsApp'],
      ]) {
        if (channels[channel] !== true || !form.isConnected) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'login-link';
        button.textContent = `${label} ile şifre sıfırla`;
        button.dataset.recoveryChannel = channel;
        button.onclick = () => passwordRecoveryGate(undefined, channel);
        form.querySelector('.login-actions').insertBefore(button, form.querySelector('[data-email-login]'));
      }
    })
    .catch(() => {});
  form.querySelector('[data-email-login]').onclick = () => authGate(false);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const account = form.elements.account.value.trim();
      await recoveryApi('/api/password-reset/email-request', { account });
      smsRecoveryGate(account, 'email');
    } catch (error) {
      form.querySelector('[role="status"]').textContent = error.message;
      submit.disabled = false;
    }
  };
}

function recoveryChannelTestGate(token, channel) {
  loginFrame('<section class="panel"><h1>Bağlantı kontrol ediliyor…</h1></section>');
  recoveryApi('/api/password-reset/channel-test-link', { token })
    .then((result) => {
      if (!result.test) return passwordRecoveryGate(token, channel, true);
      loginFrame(
        `<section class="panel"><div class="login-heading"><h1>WhatsApp kurtarma testi</h1><p>${result.usable ? 'Bu bağlantı WhatsApp şifre kurtarma şablonundan geldi. Testi doğruladığınızda WhatsApp seçeneği giriş ekranında otomatik açılır. Hesap şifreniz değişmez.' : 'Test bağlantısının süresi dolmuş veya ayarlar değişmiş. Ayarlardan yeni test başlatın.'}</p></div><p role="status" data-channel-test-status></p><div class="login-actions">${result.usable ? '<button type="button" class="login-submit" data-channel-test-confirm>Testi doğrula</button>' : ''}<button type="button" class="login-link" data-channel-test-back>Girişe dön</button></div></section>`,
      );
      document.querySelector('[data-channel-test-back]').onclick = () => authGate(false);
      const button = document.querySelector('[data-channel-test-confirm]');
      if (button)
        button.onclick = async () => {
          button.disabled = true;
          try {
            const confirmed = await recoveryApi('/api/password-reset/channel-test-link', {
              token,
              confirm: true,
            });
            if (!confirmed.ok) throw Error(confirmed.error || 'Test doğrulanamadı.');
            document.querySelector('[data-channel-test-status]').textContent =
              '✓ WhatsApp kurtarma testi doğrulandı. Seçenek artık giriş ekranında kullanılabilir.';
            button.remove();
          } catch (error) {
            document.querySelector('[data-channel-test-status]').textContent = error.message;
            button.disabled = false;
          }
        };
    })
    .catch((error) => {
      loginFrame('<section class="panel"><h1>Bağlantı kontrol edilemedi</h1><p role="status"></p></section>');
      document.querySelector('[role="status"]').textContent = error.message;
    });
}
