function loginBrand() {
  return '<div class="login-brand"><div class="brand">⚖ <strong>han<span>hukuk</span></strong></div><small>HUKUK VE TAHSİLAT YÖNETİMİ</small></div>';
}

async function recoveryApi(path, data) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
    body: JSON.stringify(data),
    cache: 'no-store',
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(result.error || 'İşlem tamamlanamadı. Daha sonra tekrar deneyin.');
  return result;
}

function passwordRecoveryGate(token) {
  document.querySelector('aside').hidden = true;
  document.querySelector('.shell').hidden = true;
  let gate = document.getElementById('authGate');
  if (!gate) {
    gate = document.createElement('main');
    gate.id = 'authGate';
    document.body.append(gate);
  }
  gate.innerHTML = `<form id="recoveryForm" class="panel">${loginBrand()}
    <div class="panelhead"><div><h2>${token ? 'Yeni Şifre Oluştur' : 'Şifremi Unuttum'}</h2>
    <p>${token ? 'Hesabınız için yeni bir şifre belirleyin.' : 'Kullanıcı adınızı veya kayıtlı telefonunuzu girin. Bağlantı kayıtlı WhatsApp numaranıza gönderilir.'}</p></div></div>
    <div class="formbody grid">${
      token
        ? '<label class="field full">Yeni şifre<input name="password" type="password" required minlength="10" maxlength="128" autocomplete="new-password"></label><label class="field full">Yeni şifre tekrar<input name="confirm" type="password" required minlength="10" maxlength="128" autocomplete="new-password"></label>'
        : '<label class="field full">Telefon veya kullanıcı adı<input name="account" required maxlength="80" autocomplete="username"></label><small class="full">Talep sınırı: günde 1, 7 günde 3 ve 30 günde 8. Kalan haklar bağlantı mesajında gösterilir.</small>'
    }<p id="recoveryStatus" class="full" role="status"></p></div>
    <div class="actions"><button type="button" class="secondary" id="backToLogin">Girişe Dön</button>
    <button type="submit" class="primary">${token ? 'Şifreyi Kaydet' : 'Bağlantı İste'}</button></div></form>`;
  const form = document.getElementById('recoveryForm');
  const submit = form.querySelector('[type="submit"]');
  const status = document.getElementById('recoveryStatus');
  document.getElementById('backToLogin').onclick = () => authGate(false);
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
        await recoveryApi('/api/password-reset/request', { account: value.account });
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
