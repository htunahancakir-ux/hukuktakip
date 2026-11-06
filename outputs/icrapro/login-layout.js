function loginBrand() {
  return '<div class="login-brand"><div class="brand"><span class="login-brand-mark" aria-hidden="true">⚖</span> <strong>han<span>hukuk</span></strong></div><small>HUKUK VE TAHSİLAT YÖNETİMİ</small></div>';
}

function loginIcon(kind) {
  const drawing =
    kind === 'user'
      ? '<circle cx="12" cy="8" r="3.25"/><path d="M5.5 20v-2a6.5 6.5 0 0 1 13 0v2"/>'
      : '<rect x="5" y="10" width="14" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14v3"/>';
  return `<svg class="login-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${drawing}</svg>`;
}

function loginFrame(content) {
  document.querySelector('aside').hidden = true;
  document.querySelector('.shell').hidden = true;
  let gate = document.getElementById('authGate');
  if (!gate) {
    gate = document.createElement('main');
    gate.id = 'authGate';
    document.body.append(gate);
  }
  if (!gate.querySelector('.login-card'))
    gate.innerHTML = `<section class="login-story" aria-label="Han Hukuk">
      <img class="login-art" src="login-justice-v1.png" alt="" width="1254" height="1254" fetchpriority="high" decoding="async">
      <div class="login-story-shade" aria-hidden="true"></div>
      ${loginBrand()}
      <div class="login-story-copy">
        <h2>Her dosyada özen.</h2>
        <p>Hukuk ve tahsilat yönetiminiz, tek bir çalışma alanında.</p>
      </div>
      <span class="login-story-domain">hanhukuktakip.com</span>
    </section>
    <section class="login-entry" aria-label="Hesap erişimi">
      <div class="login-entry-top">
        <div class="login-mobile-brand">${loginBrand()}</div>
        <span class="login-access-label">${loginIcon('lock')} Kurumsal giriş</span>
      </div>
      <div class="login-card"></div>
      <div class="login-entry-footer"><span>Han Hukuk</span><span data-login-version></span></div>
    </section>`;
  gate.querySelector('.login-card').innerHTML = content;
  const version = document.getElementById('appVersion')?.textContent.replace(/^●\s*/, '').trim();
  gate.querySelector('[data-login-version]').textContent = version || 'Hukuk ve Tahsilat Yönetimi';
  return gate;
}
