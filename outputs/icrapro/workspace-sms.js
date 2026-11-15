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
    <p>Şifre yenileme ve benzeri önemli bildirimler için büronuzun Verimor SMS hesabı. SMS seçeneği, ayarlar kaydedilip aşağıdaki canlı test doğrulandıktan sonra giriş ekranında görünür. SMS, e-posta ve WhatsApp arasında hangisinin önce deneneceğini Entegrasyonlar → Şifre Yenileme bölümünden seçin.</p></div><span class="badge" id="smsState">${esc(state)}</span></div>
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
    <div class="formbody"><button type="button" class="secondary" id="openMarketingSms">Pazarlama SMS’i</button></div>
    ${
      config.configured
        ? `<form id="smsSendTestForm"><div class="formbody grid">
      <h3 class="full sectiontitle">Deneme SMS gönder</h3>
      <label class="field">Alıcı cep telefonu<input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" required placeholder="05xx xxx xx xx"><small>Kayıtlı ayarlarla kısa bir deneme mesajı gönderilir.</small></label>
      <p class="full" id="smsSendStatus" role="status" aria-live="polite"></p>
    </div><div class="actions"><button class="secondary" type="submit">Deneme SMS gönder</button></div></form>`
        : ''
    }
    ${recoveryChannelTestPanel('sms')}
  </section>`;
  bindSettingsSectionTabs();
  bindRecoveryChannelTest($('#content'), 'sms');
  $('#openMarketingSms').onclick = marketingSmsPage;
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
          ? 'Sağlayıcı deneme mesajını kabul etti. Kurtarma seçeneğini açmak için aşağıdaki canlı testi tamamlayın.'
          : '✕ ' + (result.sms?.error || 'Deneme SMS gönderilemedi.');
      } catch (error) {
        status.textContent = '✕ ' + error.message;
      } finally {
        button.disabled = false;
      }
    };
}

function recoveryChannelTestPanel(channel) {
  const label = channel === 'sms' ? 'SMS' : 'WhatsApp';
  let ready = false;
  try {
    ready = authApi('/api/password-reset/channels').tested?.[channel] === true;
  } catch {}
  return `<section class="formbody" data-recovery-live-test="${channel}"><h3>Şifre kurtarma canlı testi — ${label}</h3><p role="status" data-live-test-status>${ready ? '✓ Canlı test doğrulandı. Bu seçenek Şifremi unuttum ekranında otomatik görünür.' : 'Kayıtlı ve etkin ayarlarla gerçek test mesajı gönderin. Mesajın kabul edilmesi tek başına kanalı açmaz.'}</p>${ready ? '' : `<div data-live-test-controls><label class="field">Test alıcısının cep telefonu<input type="tel" maxlength="30" data-live-test-phone data-optional="true" placeholder="05xx xxx xx xx"></label><button type="button" class="secondary" data-live-test-start>${label} kurtarma testini gönder</button>${channel === 'sms' ? '<label class="field">SMS ile gelen 8 haneli test kodu<input inputmode="numeric" maxlength="8" data-live-test-code data-optional="true"></label><button type="button" class="secondary" data-live-test-confirm>SMS test kodunu doğrula</button>' : '<p>WhatsApp şifre bağlantısı şablonundan gelen bağlantıyı açıp Testi doğrula düğmesine basın. Hesap şifresi değişmez.</p>'}</div>`}</section>`;
}
function bindRecoveryChannelTest(host, channel) {
  const section = host.querySelector(`[data-recovery-live-test="${channel}"]`);
  const start = section?.querySelector('[data-live-test-start]');
  if (!start) return;
  const status = section.querySelector('[data-live-test-status]');
  start.onclick = async () => {
    const phone = section.querySelector('[data-live-test-phone]').value.trim();
    if (!phone) {
      status.textContent = 'Test alıcısının telefonunu girin.';
      return;
    }
    start.disabled = true;
    status.textContent = 'Test mesajı gönderiliyor…';
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      const result = authApi(`/api/${channel}/recovery-test`, 'POST', { phone });
      const accepted = channel === 'sms' ? result.sms?.sent : result.whatsapp?.accepted > 0;
      status.textContent = accepted
        ? channel === 'sms'
          ? 'Sağlayıcı kabul etti. SMS ile gelen test kodunu aşağıya girin.'
          : 'Sağlayıcı kabul etti. WhatsApp bağlantısını açıp Testi doğrula düğmesine basın.'
        : 'Test gönderimi başarısız. ' + (result.sms?.error || whatsappDeliveryNotice(result));
    } catch (error) {
      status.textContent = error.message;
    } finally {
      start.disabled = false;
    }
  };
  const confirm = section.querySelector('[data-live-test-confirm]');
  if (confirm)
    confirm.onclick = () => {
      try {
        const result = authApi('/api/sms/recovery-test', 'POST', {
          code: section.querySelector('[data-live-test-code]').value.trim(),
        });
        if (!result.ok) throw Error(result.error || 'Test doğrulanamadı.');
        status.textContent =
          '✓ Canlı SMS testi doğrulandı. SMS seçeneği Şifremi unuttum ekranında otomatik görünür.';
        section.querySelector('[data-live-test-controls]').remove();
      } catch (error) {
        status.textContent = error.message;
      }
    };
}

function marketingSmsPage() {
  if (hanAuth?.role !== 'ceo') return toast('Pazarlama SMS’ini yalnızca CEO gönderebilir.');
  let config;
  try {
    config = authApi('/api/sms/config');
  } catch (error) {
    return toast(error.message);
  }
  $('#content').innerHTML = `<section class="panel">
    <div class="panelhead"><div><h2 id="marketingSmsTitle" tabindex="-1">Pazarlama SMS’i</h2>
      <p>SMS’lerin sonuna ret/iptal bilgisi otomatik eklenir. Bu yöntemle çıkış yapan numaralar Verimor’da otomatik kara listeye alınır ve sonraki pazarlama gönderimlerinde engellenir.</p></div>
      <button type="button" class="secondary" id="marketingSmsBack">← Geri</button></div>
    ${
      config.configured && config.header
        ? `<form id="marketingSmsForm" method="post" action="/api/sms/marketing" aria-labelledby="marketingSmsTitle">
      <div class="formbody">
        <p>Gönderici: <strong>${esc(config.header)}</strong>. Ret bağlantısı veya çıkış talimatı Verimor tarafından mesajın sonuna eklenir ve SMS uzunluğuna dahil edilir.</p>
        <div class="field"><label for="marketingSmsPhone">Alıcı cep telefonu (zorunlu)</label>
          <input id="marketingSmsPhone" name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" required aria-describedby="marketingSmsPhoneHelp">
          <small id="marketingSmsPhoneHelp">Türkiye cep telefonu: 05xx xxx xx xx.</small></div>
        <fieldset><legend>İYS alıcı türü (zorunlu)</legend>
          <input id="marketingSmsIndividual" type="radio" name="recipientType" value="BIREYSEL" required><label for="marketingSmsIndividual">Bireysel</label>
          <input id="marketingSmsMerchant" type="radio" name="recipientType" value="TACIR" required><label for="marketingSmsMerchant">Tacir</label>
        </fieldset>
        <div class="field"><label for="marketingSmsText">Mesaj (zorunlu, en fazla 900 karakter)</label>
          <textarea id="marketingSmsText" name="text" rows="5" maxlength="900" required aria-describedby="marketingSmsHelp"></textarea></div>
        <p id="marketingSmsHelp">Gönderim ticari ileti olarak yapılır. İYS izin kontrolü ve ret bilgisi zorunludur. Verimor’un isteği kabul etmesi teslim edildiği anlamına gelmez; alıcı izinleri teslimat sırasında da kontrol edilir.</p>
        <p id="marketingSmsStatus" role="status" aria-live="polite"></p>
      </div><div class="actions"><button type="submit" class="primary">Pazarlama SMS’ini gönder</button></div>
    </form>`
        : '<div class="formbody"><p>Önce Ayarlar → Entegrasyonlar → SMS bölümünde Verimor hesabını ve onaylı SMS başlığını kaydedin.</p></div>'
    }
  </section>`;
  $('#marketingSmsBack').onclick = () => render();
  $('#marketingSmsTitle').focus();
  const form = $('#marketingSmsForm');
  if (!form) return;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    if (button.disabled || !form.reportValidity()) return;
    button.disabled = true;
    const status = $('#marketingSmsStatus');
    status.textContent = 'Gönderim Verimor’a iletiliyor…';
    try {
      const response = await fetch('/api/sms/marketing', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
        body: JSON.stringify({
          phone: form.elements.phone.value,
          text: form.elements.text.value,
          recipientType: form.elements.recipientType.value,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.sms?.accepted) {
        status.textContent = result.error || result.sms?.error || 'Verimor gönderimi kabul etmedi.';
        return;
      }
      form.reset();
      status.textContent = `Verimor isteği kabul etti. Kampanya: ${result.sms.campaignId}. Teslim ve İYS sonuçlarını Verimor Gönderim Takibi ekranından kontrol edin.`;
    } catch {
      status.textContent =
        'Gönderim sonucu alınamadı. Yeniden göndermeden önce Verimor Gönderim Takibi ekranını kontrol edin.';
    } finally {
      button.disabled = false;
    }
  };
}
