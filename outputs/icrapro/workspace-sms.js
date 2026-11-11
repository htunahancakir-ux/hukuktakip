function smsSettingsPage() {
  if (hanAuth?.role !== 'ceo') return toast('SMS ayarlarını yalnızca CEO yönetebilir.');
  let config;
  try {
    config = authApi('/api/sms/config');
  } catch (error) {
    return toast(error.message);
  }
  const state = config.configured ? (config.enabled ? 'Açık' : 'Kapalı') : 'Ayarlanmadı';
  $('#content').innerHTML = `${settingsSectionTabs('sms')}<section class="panel">
    <div class="panelhead"><div><h2>SMS — Verimor</h2>
    <p>Şifremi unuttum ve benzeri önemli bildirimler için büronuzun Verimor SMS hesabı. WhatsApp entegrasyonu kuruluysa şifre bağlantısı WhatsApp’tan gider; kurulu değilse SMS ile tek kullanımlık geçici şifre gönderilir.</p></div><span class="badge" id="smsState">${esc(state)}</span></div>
    <form id="smsConfigForm"><div class="formbody grid">
      <label class="field">Kullanıcı adı (Verimor hesap numarası)<input name="username" inputmode="numeric" autocomplete="off" maxlength="15" required data-optional="true" placeholder="ör. 908501234567" value="${esc(config.username)}"></label>
      <label class="field">API şifresi<input name="password" type="password" maxlength="200" autocomplete="new-password" data-optional="true"
        placeholder="${config.configured ? 'Kayıtlı — değiştirmek için yazın' : 'Verimor API şifresi'}"><small>Şifre şifrelenerek saklanır ve bir daha gösterilmez.</small></label>
      <label class="field">SMS başlığı<input name="header" maxlength="20" autocomplete="off" data-optional="true" placeholder="Verimor’da onaylı gönderici başlığı" value="${esc(config.header)}"></label>
      <label class="settings-check"><input type="checkbox" name="enabled" ${config.enabled ? 'checked' : ''}> Şifremi unuttum için SMS kullan</label>
      ${config.configured ? '<label class="settings-check full"><input type="checkbox" name="clear"> Kayıtlı SMS ayarlarını sil</label>' : ''}
      <div class="notice full">Verimor, API isteklerini yalnızca izin verilen sunucu IP adreslerinden kabul eder. Test “IP izni” hatası verirse Verimor panelinde sunucunun IP adresini izinli listeye ekleyin.</div>
      <div class="full"><button class="secondary" type="button" id="smsTestConnection">Bağlantıyı test et</button>
        <small id="smsTestStatus" role="status" aria-live="polite">Test, yazdığınız bilgilerle bakiye ve başlık listesini sorgular; kaydetmez. Şifre alanı boşsa kayıtlı şifre kullanılır.</small></div>
    </div><div class="actions"><button class="primary" type="submit">Kaydet</button></div></form>
    ${
      config.configured
        ? `<form id="smsSendTestForm"><div class="formbody grid">
      <h3 class="full sectiontitle">Deneme SMS gönder</h3>
      <label class="field">Alıcı cep telefonu<input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" required placeholder="05xx xxx xx xx"><small>Kayıtlı ayarlarla kısa bir deneme mesajı gönderilir.</small></label>
      <p class="full" id="smsSendStatus" role="status" aria-live="polite"></p>
    </div><div class="actions"><button class="secondary" type="submit">Deneme SMS gönder</button></div></form>`
        : ''
    }
  </section>`;
  bindSettingsSectionTabs();
  const form = $('#smsConfigForm');
  const typed = () => ({
    username: form.elements.username.value.trim(),
    password: form.elements.password.value.trim(),
    header: form.elements.header.value.trim(),
  });
  const clear = form.elements.clear;
  if (clear)
    clear.onchange = () => {
      form.elements.username.required = !clear.checked;
    };
  $('#smsTestConnection').onclick = async (event) => {
    const button = event.currentTarget;
    const status = $('#smsTestStatus');
    button.disabled = true;
    status.textContent = 'Bağlantı test ediliyor…';
    // Let the browser paint the message before the (synchronous) request blocks the page.
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      const result = authApi('/api/sms/test', 'POST', typed());
      const headers = Array.isArray(result.headers) ? result.headers : [];
      status.textContent = `✓ Bağlandı. Kalan kredi: ${new Intl.NumberFormat('tr-TR').format(Number(result.balance) || 0)}. Başlıklar: ${headers.length ? headers.join(', ') : 'yok'}.`;
    } catch (error) {
      status.textContent = '✕ ' + error.message;
    } finally {
      button.disabled = false;
    }
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    const wantsClear = clear?.checked === true;
    if (
      wantsClear &&
      !window.confirm('Kayıtlı SMS ayarları silinsin mi? Silinirse şifremi unuttum için SMS gönderilemez.')
    )
      return;
    try {
      authApi('/api/sms/config', 'PUT', {
        ...typed(),
        enabled: form.elements.enabled.checked,
        clear: wantsClear,
      });
      smsSettingsPage();
      toast(wantsClear ? 'SMS ayarları silindi.' : 'SMS ayarları kaydedildi.');
    } catch (error) {
      toast(error.message);
    }
  };
  const sendForm = $('#smsSendTestForm');
  if (sendForm)
    sendForm.onsubmit = async (event) => {
      event.preventDefault();
      const button = sendForm.querySelector('[type="submit"]');
      const status = $('#smsSendStatus');
      button.disabled = true;
      status.textContent = 'Deneme SMS gönderiliyor…';
      await new Promise((resolve) => setTimeout(resolve, 30));
      try {
        const result = authApi('/api/sms/send-test', 'POST', { phone: sendForm.elements.phone.value.trim() });
        status.textContent = result.sms?.sent
          ? '✓ Deneme SMS gönderildi.'
          : '✕ ' + (result.sms?.error || 'Deneme SMS gönderilemedi.');
      } catch (error) {
        status.textContent = '✕ ' + error.message;
      } finally {
        button.disabled = false;
      }
    };
}
