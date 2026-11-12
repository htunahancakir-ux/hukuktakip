// Settings → Integrations → iyzico: the office's own merchant account for online card payments.
// Keys are sealed on the server and never shown again; only "saved" and the last characters.
function iyzicoKurus(text) {
  const raw = String(text ?? '').replace(/\s/g, '');
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return NaN;
  const [whole, fraction = ''] = normalized.split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(value) ? value : NaN;
}

function iyzicoSettingsPage() {
  if (hanAuth?.role !== 'ceo') return toast('iyzico ayarlarını yalnızca CEO yönetebilir.');
  let config;
  try {
    config = authApi('/api/iyzico/config');
  } catch (error) {
    return toast(error.message);
  }
  const live = config.mode === 'live';
  $('#content').innerHTML = `${settingsSectionTabs('iyzico')}<section class="panel">
    <div class="panelhead"><div><h2>iyzico — Online Ödeme</h2><p>Müşterilerinizden kartla tahsilat yapmak için kendi iyzico hesabınızı bağlayın. Para doğrudan sizin iyzico hesabınıza geçer.</p></div><span class="badge">${config.configured ? 'Bağlı · ' + (live ? 'canlı' : 'deneme') : 'Bağlı değil'}</span></div>
    <form id="iyzicoConfigForm"><div class="formbody grid">
      <label class="field">Ortam<select name="mode"><option value="sandbox" ${live ? '' : 'selected'}>Deneme (sandbox)</option><option value="live" ${live ? 'selected' : ''}>Canlı</option></select><small>Önce deneme anahtarlarıyla bir ödeme linki oluşturup deneyin; ardından canlı anahtarlara geçin.</small></label>
      <label class="field">API anahtarı<input name="apiKey" type="password" maxlength="200" autocomplete="new-password" data-optional="true" placeholder="${config.configured ? 'Kayıtlı ' + esc(config.apiKeyHint) + ' — değiştirmek için yazın' : 'iyzico API anahtarı'}"></label>
      <label class="field">Gizli anahtar<input name="secretKey" type="password" maxlength="200" autocomplete="new-password" data-optional="true" placeholder="${config.configured ? 'Kayıtlı — değiştirmek için yazın' : 'iyzico gizli anahtarı'}"></label>
      ${config.configured ? '<label class="settings-check full"><input type="checkbox" name="clear"> Kayıtlı iyzico anahtarlarını sil</label>' : ''}
      <div class="full"><button class="secondary" type="button" id="iyzicoTest">Anahtarları Test Et</button><small id="iyzicoTestStatus" role="alert" aria-live="polite">Test, yazdığınız anahtarları (boşsa kayıtlı olanları) iyzico'ya gönderir; hiçbir şey kaydedilmez.</small></div>
      <div class="notice full">Anahtarlar sunucuda şifreli saklanır ve ekrana geri gösterilmez. Yedek dosyalarına yazılmaz. Hesabınıza kart ödemesi için iyzico'dan "ödeme linki" yetkisi alınmış olmalıdır.</div>
    </div><div class="actions"><button type="submit" class="primary">Kaydet</button></div></form>
  </section>
  ${
    config.configured
      ? `<section class="panel">
    <div class="panelhead"><div><h2>Ödeme linki oluştur</h2><p>Belirlediğiniz tutar için paylaşılabilir iyzico ödeme sayfası. Tahsilatı iyzico panelinizden takip edin.</p></div></div>
    <form id="iyzicoLinkForm"><div class="formbody grid">
      <label class="field">Başlık<input name="name" required minlength="2" maxlength="60" placeholder="ör. Danışmanlık ücreti"></label>
      <label class="field">Tutar (TL)<input name="amount" required inputmode="decimal" placeholder="1250,00"></label>
      <label class="field full">Açıklama<input name="description" required minlength="2" maxlength="200" placeholder="Müşterinin ödeme sayfasında göreceği açıklama"></label>
      <div class="full" id="iyzicoLinkResult" hidden><label class="field">Müşteriye gönderin<input name="url" readonly></label><button class="secondary" type="button" id="iyzicoCopy">Kopyala</button></div>
    </div><div class="actions"><button type="submit" class="primary">Link Oluştur</button></div></form>
  </section>`
      : ''
  }`;
  bindSettingsSectionTabs();

  const form = $('#iyzicoConfigForm');
  const read = () => ({
    mode: form.elements.mode.value,
    apiKey: form.elements.apiKey.value.trim(),
    secretKey: form.elements.secretKey.value.trim(),
    clear: form.elements.clear?.checked === true,
  });
  $('#iyzicoTest').onclick = () => {
    const button = $('#iyzicoTest');
    const status = $('#iyzicoTestStatus');
    button.disabled = true;
    status.textContent = 'iyzico ile bağlantı deneniyor…';
    try {
      const input = read();
      const result = authApi('/api/iyzico/test', 'POST', {
        mode: input.mode,
        apiKey: input.apiKey,
        secretKey: input.secretKey,
      });
      status.textContent = result.ok
        ? '✓ Anahtarlar iyzico tarafından kabul edildi. Kalıcı yapmak için Kaydet’e basın.'
        : '✕ ' + (result.message || 'Anahtarlar kabul edilmedi.');
    } catch (error) {
      status.textContent = '✕ ' + error.message;
    } finally {
      button.disabled = false;
    }
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    try {
      const input = read();
      if (input.clear && !window.confirm('Kayıtlı iyzico anahtarlarını silmek istiyor musunuz?')) return;
      authApi('/api/iyzico/config', 'PUT', input);
      iyzicoSettingsPage();
      toast(input.clear ? 'iyzico anahtarları silindi.' : 'iyzico ayarları kaydedildi.');
    } catch (error) {
      toast(error.message);
    }
  };

  const linkForm = $('#iyzicoLinkForm');
  if (!linkForm) return;
  linkForm.onsubmit = (event) => {
    event.preventDefault();
    const amountKurus = iyzicoKurus(linkForm.elements.amount.value);
    if (Number.isNaN(amountKurus) || amountKurus < 100)
      return toast('Tutar geçersiz. Örnek: 1250,00 (en az 1,00 TL).');
    const submit = linkForm.querySelector('button[type=submit]');
    submit.disabled = true;
    try {
      const result = authApi('/api/iyzico/link', 'POST', {
        name: linkForm.elements.name.value.trim(),
        description: linkForm.elements.description.value.trim(),
        amountKurus,
      });
      linkForm.elements.url.value = result.url;
      $('#iyzicoLinkResult').hidden = false;
      toast('Ödeme linki oluşturuldu.');
    } catch (error) {
      toast(error.message);
    } finally {
      submit.disabled = false;
    }
  };
  $('#iyzicoCopy').onclick = async () => {
    const field = linkForm.elements.url;
    try {
      await navigator.clipboard.writeText(field.value);
      toast('Link kopyalandı.');
    } catch {
      field.select();
    }
  };
}
