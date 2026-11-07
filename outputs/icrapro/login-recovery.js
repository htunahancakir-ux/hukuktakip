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

function passwordRecoveryGate(token) {
  loginFrame(`<form id="recoveryForm" class="panel" aria-labelledby="recoveryTitle">
    <div class="login-heading"><h1 id="recoveryTitle">${token ? 'Yeni şifreniz.' : 'Şifrenizi yenileyin.'}</h1>
    <p>${token ? 'Hesabınız için en az 10 karakterli yeni bir şifre belirleyin.' : 'Kullanıcı adınızı veya kayıtlı telefonunuzu girin. Şifre oluşturma bağlantısı WhatsApp numaranıza gönderilir.'}</p></div>
    <div class="login-fields">${
      token
        ? '<label class="field" for="recovery-password">Yeni şifre<input id="recovery-password" name="password" type="password" required minlength="10" maxlength="128" autocomplete="new-password" placeholder="Yeni şifrenizi girin" aria-describedby="recoveryStatus"></label><label class="field" for="recovery-confirm">Yeni şifre tekrar<input id="recovery-confirm" name="confirm" type="password" required minlength="10" maxlength="128" autocomplete="new-password" placeholder="Yeni şifrenizi tekrar girin" aria-describedby="recoveryStatus"></label>'
        : '<label class="field" for="recovery-account">Telefon veya kullanıcı adı<input id="recovery-account" name="account" required maxlength="80" autocomplete="username" placeholder="05xx xxx xx xx veya kullanıcı adınız" aria-describedby="recoveryStatus"></label><p class="login-note" data-recovery-limit>Talep sınırı: günde 1.</p>'
    }</div><p id="recoveryStatus" class="login-status" role="status"></p>
    <div class="login-actions"><button type="submit" class="login-submit">${token ? 'Şifreyi kaydet' : 'Bağlantı iste'}</button>
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
        await recoveryApi('/api/password-reset/request', { account: value.account });
        recoveryRequestCount++;
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
