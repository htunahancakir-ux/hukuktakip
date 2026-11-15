// Ayarlar → Entegrasyonlar → Şifre Yenileme: which way "Şifremi unuttum" tries first, what is
// set up, and e-mail verification of the staff accounts.
const RECOVERY_CHANNEL_TEXT = {
  sms: {
    label: 'SMS',
    on: (settings) =>
      settings.officeSms
        ? 'Büronuzun Verimor hesabından 8 haneli geçici şifre gider.'
        : 'Platformun SMS hizmetinden 8 haneli geçici şifre gider.',
    off: 'Entegrasyonlar → SMS (Verimor) bölümünden kurulunca açılır.',
    untested:
      'Kurulu, ancak canlı test yapılmadı. Entegrasyonlar → SMS (Verimor) bölümündeki “Şifre kurtarma canlı testi”ni tamamlayınca açılır.',
  },
  email: {
    label: 'E-posta',
    on: () =>
      'Platformun e-posta adresinden, büronuzun adıyla 8 haneli kod gider. Kod yalnızca kullanıcının Hesabım bölümünde doğruladığı adrese gönderilir.',
    off: 'Platformun e-posta hizmeti henüz açık değil.',
  },
  whatsapp: {
    label: 'WhatsApp',
    on: () => 'Kayıtlı ve onaylı WhatsApp numarasına şifre bağlantısı gider.',
    off: 'Entegrasyonlar → WhatsApp Business bölümünde şifre şablonu kurulunca açılır.',
    untested:
      'Kurulu, ancak canlı test yapılmadı. Entegrasyonlar → WhatsApp Business bölümündeki “Şifre kurtarma canlı testi”ni tamamlayınca açılır.',
  },
};

function recoverySettingsPage() {
  if (hanAuth?.role !== 'ceo') return toast('Şifre yenileme ayarını yalnızca CEO yönetebilir.');
  let settings;
  try {
    settings = authApi('/api/recovery/settings');
  } catch (error) {
    return toast(error.message);
  }
  const chosen = settings.order[0] || '';
  const accounts = settings.accounts;
  const order = [...settings.order.map((id) => RECOVERY_CHANNEL_TEXT[id].label), 'Yöneticiden iste'].join(
    ' → ',
  );
  $('#content').innerHTML = `${settingsSectionTabs('recovery')}<section class="panel">
    <div class="panelhead"><div><h2>Şifre Yenileme</h2>
    <p>“Şifremi unuttum” kodunun önce hangi yolla gideceğini seçin. Kod ulaşmazsa kullanıcı ekrandaki “SMS gelmedi mi?” bağlantısıyla diğer açık yolları seçebilir; hiçbiri işe yaramazsa “Yöneticiden iste” ile talebi size ve diğer yöneticilere mesaj olarak düşer.</p></div></div>
    <form id="recoveryPolicyForm"><div class="formbody">
      <fieldset class="recovery-channels"><legend>İlk tercih</legend>${['sms', 'email', 'whatsapp']
        .map((id) => {
          const text = RECOVERY_CHANNEL_TEXT[id];
          const on = settings.available[id] === true;
          // The office's own channel is set up but has not passed its live delivery test yet.
          const untested = !on && settings.configured?.[id] === true && settings.tested?.[id] !== true;
          return `<label class="recovery-channel"><input type="radio" name="primary" value="${id}" ${on ? '' : 'disabled'} ${chosen === id ? 'checked' : ''}><span><b>${text.label}</b> ${on ? '<span class="email-verified-mark">Açık</span>' : `<span class="email-unverified-mark">${untested ? 'Canlı test bekliyor' : 'Kurulu değil'}</span>`}</span><small>${esc(on ? text.on(settings) : untested ? text.untested : text.off)}</small></label>`;
        })
        .join('')}</fieldset>
      <p class="recovery-order">Şu anki sıra: <b>${esc(order)}</b></p>
    </div><div class="actions"><button class="primary" type="submit" ${settings.order.length ? '' : 'disabled'}>Kaydet</button></div></form>
    <div class="formbody"><h3 class="sectiontitle">Personel e-posta doğrulaması</h3>
      <p>${accounts.verified} hesabın e-postası doğrulandı, ${accounts.unverified} hesabınki doğrulanmadı, ${accounts.missing} hesapta e-posta yok. Doğrulanan adreslerin yanında Kullanıcı Yönetimi ve Hesabım ekranlarında ✓ işareti görünür.</p>
      <p>Toplu gönderimde her kişiye 24 saat geçerli 6 haneli kod gider; kişi kodu Hesabım → İletişim bilgilerim bölümüne girer. Tek kişiye göndermek için Kullanıcı Yönetimi’nde “E-posta / Cep Telefonu”nu açın.</p>
      <button type="button" class="secondary" id="sendAllVerifications" ${settings.available.email && accounts.unverified ? '' : 'disabled'}>Doğrulanmamış adreslere doğrulama kodu gönder</button>
      <p role="status" id="recoveryVerifyStatus">${settings.available.email ? '' : 'E-posta gönderimi açılınca doğrulama kodu gönderilebilir.'}</p>
    </div>
  </section>`;
  bindSettingsSectionTabs();
  $('#recoveryPolicyForm').onsubmit = (event) => {
    event.preventDefault();
    const primary = new FormData(event.target).get('primary');
    if (!primary) return toast('İlk tercih olarak açık bir yöntem seçin.');
    try {
      authApi('/api/recovery/settings', 'PUT', { primary });
      recoverySettingsPage();
      toast('Şifre yenileme ilk tercihi kaydedildi.');
    } catch (error) {
      toast(error.message);
    }
  };
  $('#sendAllVerifications').onclick = (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = authApi('/api/email-verification/send-all', 'POST', {});
      $('#recoveryVerifyStatus').textContent =
        `${result.queued} adrese doğrulama kodu gönderiliyor.` +
        (result.recent ? ` ${result.recent} hesaba son 24 saatte zaten kod gitti.` : '') +
        (result.missing ? ` ${result.missing} hesapta e-posta yok.` : '');
    } catch (error) {
      $('#recoveryVerifyStatus').textContent = error.message;
      button.disabled = false;
    }
  };
}
