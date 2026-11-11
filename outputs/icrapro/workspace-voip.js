const voipActiveStatuses = new Set(['starting', 'ringing', 'answered', 'unknown']);
const voipUi = { documentId: '', timer: null, request: 0 };
async function voipApi(path, method = 'GET', value) {
  const response = await fetch('/api/voip/' + path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'X-Han-Request': '1', ...(value ? { 'Content-Type': 'application/json' } : {}) },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(Error(result.error || 'Telefon işlemi tamamlanamadı.'), {
      status: response.status,
      reason: result.reason,
    });
  return result;
}

// ---------- Microphone, browser and connection checks ----------
// The web phone is Verimor's page inside an iframe; this page cannot see whether it reached
// "Hazır". What it can check: browser support, the microphone (permission, device, in use),
// whether this computer reaches Verimor at all, and what Verimor says about the extension.
const VOIP_MIC_MESSAGES = {
  browser: 'Bu tarayıcı web telefonunu desteklemiyor. Güncel Google Chrome veya Microsoft Edge kullanın.',
  insecure: 'Web telefonu yalnızca güvenli (https) bağlantıyla açılan sayfada çalışır.',
  denied:
    'Mikrofon izni engellenmiş. Adres çubuğunun solundaki kilit (site bilgileri) simgesine tıklayın, "Mikrofon" için "İzin ver"i seçin ve sayfayı yenileyin.',
  prompt:
    'Arama için mikrofon izni gerekiyor. "Mikrofona izin ver"e basıp tarayıcının sorusuna "İzin ver" deyin.',
  nodevice: 'Bilgisayarda mikrofon veya kulaklık bulunamadı. Mikrofonlu kulaklığı takıp tekrar deneyin.',
  busy: 'Mikrofon açılamadı. Başka bir uygulama (Teams, Zoom, WhatsApp vb.) kullanıyor olabilir ya da Windows mikrofon erişimini kapatmış olabilir (Ayarlar → Gizlilik ve güvenlik → Mikrofon).',
};
const VOIP_FIREWALL_HINT =
  'Bu bilgisayardan Verimor’a ulaşılamıyor. Kurum ağının güvenlik duvarı, antivirüs web koruması, VPN veya proxy engelliyor olabilir. Bilgi işlem sorumlusundan oim.verimor.com.tr, *.verimor.com.tr ve *.bulutsantralim.com adreslerine HTTPS/WSS (443) erişimine ve web telefonunun ses trafiğine (WebRTC, UDP) izin vermesini isteyin.';
const VOIP_EXTENSION_STATUS = {
  AVAILABLE: [true, 'Verimor dahilinizi çevrimiçi ve müsait görüyor.'],
  TALKING: [true, 'Verimor dahilinizi şu anda bir görüşmede görüyor.'],
  UNREGISTERED: [
    false,
    'Verimor dahilinizi çevrimdışı görüyor: web telefonu santrale bağlanamamış. Web telefonu penceresini açıp "Hazır" olmasını bekleyin; olmuyorsa yukarıdaki maddeleri kontrol edin.',
  ],
  SS_DND: [false, 'Dahilinizde "Rahatsız etmeyin" açık. Verimor panelinden kapatın.'],
  RATE_LIMITED: [
    null,
    'Verimor durum sorgusu sınırına takıldı (dakikada 2). Bir dakika sonra tekrar deneyin.',
  ],
  UNKNOWN: [null, 'Verimor dahili durumunu bildirmedi.'],
};
function voipBrowserProblem() {
  if (!window.isSecureContext) return 'insecure';
  if (
    !navigator.mediaDevices?.getUserMedia ||
    typeof window.RTCPeerConnection !== 'function' ||
    typeof window.WebSocket !== 'function'
  )
    return 'browser';
  return '';
}
// `ask`: may show the browser's permission prompt (only from a click). The permission is asked
// on this page so it also covers the embedded web phone, which cannot show its own prompt well
// while it is minimized.
async function voipMicrophoneCheck({ ask = false } = {}) {
  if (voipUi.micOk) return { ok: true };
  const browser = voipBrowserProblem();
  if (browser) return { ok: false, kind: browser, message: VOIP_MIC_MESSAGES[browser] };
  let state = 'unknown';
  try {
    state = (await navigator.permissions.query({ name: 'microphone' })).state;
  } catch {
    // Firefox and older browsers cannot be asked; fall through to trying the microphone.
  }
  if (state === 'denied') return { ok: false, kind: 'denied', message: VOIP_MIC_MESSAGES.denied };
  if (state === 'granted' && !ask) {
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    if (!devices.some((d) => d.kind === 'audioinput'))
      return { ok: false, kind: 'nodevice', message: VOIP_MIC_MESSAGES.nodevice };
    return { ok: true };
  }
  if (!ask) return { ok: false, kind: 'prompt', message: VOIP_MIC_MESSAGES.prompt };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    voipUi.micOk = true;
    // A web phone that loaded before the permission existed may not retry; reload it.
    if (state !== 'granted' && document.getElementById('voipWebphone')) releaseVoipWebphone();
    return { ok: true, granted: state !== 'granted' };
  } catch (error) {
    const kind = ['NotAllowedError', 'SecurityError', 'PermissionDeniedError'].includes(error?.name)
      ? 'denied'
      : ['NotFoundError', 'OverconstrainedError', 'DevicesNotFoundError'].includes(error?.name)
        ? 'nodevice'
        : 'busy';
    return { ok: false, kind, message: VOIP_MIC_MESSAGES[kind] };
  }
}
// Any HTTP answer (even an error page) proves the network path; only a blocked or failed
// connection rejects.
async function voipReachVerimor() {
  try {
    await fetch('https://oim.verimor.com.tr/favicon.ico?t=' + Date.now(), {
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(6000),
    });
    return true;
  } catch {
    return false;
  }
}
async function voipDiagnose({ ask = false } = {}) {
  const [mic, reach, status] = await Promise.all([
    voipMicrophoneCheck({ ask }),
    voipReachVerimor(),
    voipApi('phone-status').catch((error) => ({ status: 'UNKNOWN', error: error.message })),
  ]);
  const [statusOk, statusText] = VOIP_EXTENSION_STATUS[status.status] || VOIP_EXTENSION_STATUS.UNKNOWN;
  return [
    ['Tarayıcı ve mikrofon', mic.ok, mic.ok ? 'Mikrofon kullanılabilir.' : mic.message],
    ['Verimor’a erişim', reach, reach ? 'Bu bilgisayardan Verimor’a ulaşılabiliyor.' : VOIP_FIREWALL_HINT],
    ['Verimor’daki dahili durumu', statusOk, status.error || statusText],
    [
      'Aynı dahili',
      null,
      'Bir dahili aynı anda tek bilgisayarda kullanılmalı. Başka bir bilgisayarda web telefonu açıksa kapatın.',
    ],
  ];
}
function voipDiagnosisMarkup(rows) {
  return (
    '<ul class="voip-diagnosis">' +
    rows
      .map(
        ([title, ok, text]) =>
          '<li data-ok="' +
          (ok === true ? 'yes' : ok === false ? 'no' : 'info') +
          '"><strong>' +
          (ok === true ? '✓ ' : ok === false ? '✕ ' : 'ℹ ') +
          esc(title) +
          '</strong><span>' +
          esc(text) +
          '</span></li>',
      )
      .join('') +
    '</ul>'
  );
}
// Fills `host` with the checklist; `ask` only from a click.
async function voipShowDiagnosis(host, { ask = false } = {}) {
  if (!host) return;
  host.hidden = false;
  host.innerHTML = '<p class="voip-diagnosis-wait" role="status">Bağlantı kontrol ediliyor…</p>';
  const markup = voipDiagnosisMarkup(await voipDiagnose({ ask }));
  if (host.isConnected) host.innerHTML = markup;
  return markup;
}
const voipNeedsDiagnosis = (error) =>
  error?.reason === 'extension_unregistered' || String(error?.reason || '').startsWith('microphone_');
// Call bar: one always-visible strip at the top of the page shell, from the moment dialing
// starts until the call closes. It belongs to the page, not to the call window, so it stays
// reachable when that window is moved, minimized or hidden, when the page scrolls and on
// every menu. Dynamic values are always written with textContent.
const voipBarIcons = {
  mic: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v3"></path><path class="voip-call-bar-slash" d="M4 4l16 16"></path></svg>',
  note: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 20h4L19 9l-4-4L4 16z"></path><path d="M13 7l4 4"></path></svg>',
};
function voipInitials(name) {
  const words = String(name || '')
    .trim()
    .split(/\s+/u)
    .filter((word) => /^\p{L}/u.test(word));
  if (!words.length) return '☎';
  return (words[0][0] + (words.length > 1 ? words.at(-1)[0] : '')).toLocaleUpperCase('tr-TR');
}
function voipCallBarTick() {
  const state = voipUi.bar,
    time = document.querySelector('#voipCallBar [data-bar-time]');
  if (state && time)
    time.textContent = voipDuration(Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000)));
}
function voipCallBarRender() {
  const state = voipUi.bar;
  if (!state) return;
  let bar = document.getElementById('voipCallBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'voipCallBar';
    bar.className = 'voip-call-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Aktif arama');
    bar.innerHTML = `<div class="voip-call-bar-who"><span class="voip-call-bar-avatar" data-bar-avatar aria-hidden="true"></span><span class="voip-call-bar-text"><strong data-bar-name></strong><small data-bar-detail></small></span></div>
      <div class="voip-call-bar-state"><span class="voip-call-bar-dot" aria-hidden="true"></span><span data-bar-status role="status"></span><time data-bar-time>00:00</time></div>
      <span class="voip-call-bar-line" data-bar-line></span>
      <div class="voip-call-bar-actions">
        <button type="button" class="voip-call-bar-round" data-bar-mute aria-pressed="false" title="Sessize al" aria-label="Sessize al">${voipBarIcons.mic}</button>
        <button type="button" class="voip-call-bar-round" data-bar-open title="Not ve sonuç penceresini aç" aria-label="Not ve sonuç penceresini aç">${voipBarIcons.note}</button>
        <button type="button" class="voip-call-bar-hangup" data-global-hangup aria-label="Aramayı sonlandır"><span aria-hidden="true">☎</span> <span data-bar-hangup-label>Sonlandır</span></button>
      </div>`;
    (document.querySelector('.shell') || document.body).prepend(bar);
    document.body.classList.add('voip-call-bar-open');
    bar.querySelector('[data-global-hangup]').onclick = () => voipUi.bar?.hangup?.();
    bar.querySelector('[data-bar-mute]').onclick = () => voipUi.bar?.mute?.();
    bar.querySelector('[data-bar-open]').onclick = () => voipUi.bar?.open?.();
  }
  if (!voipUi.barTimer) voipUi.barTimer = setInterval(voipCallBarTick, 1000);
  const dialing = state.phase === 'dialing',
    hangup = bar.querySelector('[data-global-hangup]'),
    mute = bar.querySelector('[data-bar-mute]'),
    line = bar.querySelector('[data-bar-line]'),
    detail = bar.querySelector('[data-bar-detail]');
  bar.dataset.phase = state.ending ? 'ending' : state.phase || 'dialing';
  bar.querySelector('[data-bar-avatar]').textContent = voipInitials(state.name);
  bar.querySelector('[data-bar-name]').textContent = state.name || 'Arama';
  detail.textContent = state.detail || '';
  detail.hidden = !state.detail;
  bar.querySelector('[data-bar-status]').textContent = state.ending
    ? dialing
      ? 'İptal ediliyor…'
      : 'Sonlandırılıyor…'
    : state.status || 'Aranıyor…';
  line.textContent = state.line || '';
  line.hidden = !state.line;
  mute.hidden = !state.mute;
  mute.disabled = !!state.muteBusy || !!state.ending;
  mute.setAttribute('aria-pressed', String(!!state.muted));
  bar.querySelector('[data-bar-open]').hidden = !state.open;
  hangup.disabled = !!state.ending;
  hangup.setAttribute('aria-label', state.ending ? 'Arama sonlandırılıyor' : 'Aramayı sonlandır');
  bar.querySelector('[data-bar-hangup-label]').textContent = state.ending
    ? dialing
      ? 'İptal ediliyor…'
      : 'Sonlandırılıyor…'
    : 'Sonlandır';
  voipCallBarTick();
}
function voipCallBarOpen(state) {
  voipUi.bar = { startedAt: Date.now(), phase: 'dialing', ...state };
  voipCallBarRender();
}
function voipCallBarUpdate(patch) {
  if (!voipUi.bar) return;
  voipUi.bar = { ...voipUi.bar, ...patch };
  voipCallBarRender();
}
function voipCallBarClose() {
  clearInterval(voipUi.barTimer);
  voipUi.barTimer = null;
  voipUi.bar = null;
  document.getElementById('voipCallBar')?.remove();
  document.body.classList.remove('voip-call-bar-open');
}
function voipCallLabel(doc, call) {
  const number = call.documentNumber || (doc.id && doc.number !== 'Dosyasız arama' ? doc.number : '');
  return number ? 'Föy ' + number : call.documentId || doc.id ? '' : 'Dosyasız arama';
}
function voipCancelWait(frame, waiting) {
  frame.querySelector(':scope > .voip-cancel-wait')?.remove();
  for (const child of frame.children) child.inert = waiting;
  if (!waiting) return;
  const notice = document.createElement('div');
  notice.className = 'voip-cancel-wait';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  notice.innerHTML =
    '<div><strong>Arama sonlandırılıyor…</strong><span>Kapanana kadar lütfen bekleyiniz.</span></div>';
  frame.append(notice);
}
async function voipStartCancelable(input, container, report, launchButton, context = {}) {
  if (voipUi.startPending) throw Error('Arama başlatılıyor; mevcut işlemin bitmesini bekleyin.');
  voipUi.startPending = true;
  document.querySelectorAll('.local-feedback').forEach((el) => el.remove());
  const frame = container.closest('.voip-number-panel, dialog') || container;
  const rect = frame.getBoundingClientRect();
  voipUi.callPlacement = rect.width > 0 ? { left: rect.left, top: rect.top, width: rect.width } : null;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'voip-hangup';
  cancel.dataset.cancelStarting = '';
  cancel.textContent = 'Sonlandır / İptal et';
  if (launchButton?.isConnected) launchButton.replaceWith(cancel);
  else container.append(cancel);
  let requested = false,
    finished = false,
    sent = false,
    cancellation;
  const requestCancel = async () => {
    while (true) {
      try {
        await voipApi('cancel-start', 'POST', { requestId: input.requestId });
        return;
      } catch (error) {
        if (error.status !== 409 || finished) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  };
  // A running call keeps its own bar; a failed second start must never replace or close it.
  const ownsBar = !voipUi.bar;
  if (ownsBar)
    voipCallBarOpen({
      owner: 'start',
      phase: 'dialing',
      status: 'Aranıyor…',
      name: context.name || voipPhone(input.phone),
      detail: [context.name ? voipPhone(input.phone) : '', context.detail || ''].filter(Boolean).join(' · '),
      hangup: () => cancel.click(),
    });
  cancel.onclick = () => {
    if (requested) return;
    requested = true;
    if (ownsBar) voipCallBarUpdate({ ending: true });
    cancel.disabled = true;
    cancel.textContent = 'İptal ediliyor…';
    voipCancelWait(frame, true);
    // Canceled while the microphone was still being asked for: nothing reached the switchboard.
    if (!sent) return;
    report('İptal istendi; santralin çağrıyı kapatması bekleniyor.');
    cancellation = requestCancel().catch((error) => report(error.message));
  };
  try {
    // Microphone first: a call the user cannot speak into is useless. The cancel control above
    // is already visible while the browser asks.
    const mic = await voipMicrophoneCheck({ ask: true });
    if (!mic.ok) throw Object.assign(Error(mic.message), { reason: 'microphone_' + mic.kind });
    if (requested) throw Error('Arama iptal edildi.');
    sent = true;
    const result = await voipApi('start', 'POST', { ...input, browserManaged: true, waitForPhone: true });
    finished = true;
    if (requested) {
      await cancellation;
      // Also covers cancellation arriving before the reservation was created.
      try {
        await voipApi('cancel-start', 'POST', { requestId: input.requestId });
      } catch (error) {
        result.call.cancelError = error.message;
      }
      result.call.cancelRequested = true;
    }
    return result;
  } finally {
    finished = true;
    if (launchButton && cancel.isConnected) cancel.replaceWith(launchButton);
    else cancel.remove();
    voipCancelWait(frame, false);
    voipUi.startPending = false;
    if (ownsBar && voipUi.bar?.owner === 'start') voipCallBarClose();
  }
}
function voipDate(value) {
  return value
    ? new Intl.DateTimeFormat('tr-TR', {
        timeZone: 'Europe/Istanbul',
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(value))
    : '—';
}
function voipDuration(value) {
  const seconds = Math.max(0, Number(value) || 0);
  return (
    Math.floor(seconds / 60)
      .toString()
      .padStart(2, '0') +
    ':' +
    (seconds % 60).toString().padStart(2, '0')
  );
}
function voipSettingsPage() {
  if (hanAuth.role !== 'ceo') return;
  $('#content').innerHTML =
    settingsSectionTabs('voip') +
    '<div class="panel formbody" id="voipSettingsHost" aria-live="polite">VoIP ayarları yükleniyor…</div>';
  bindSettingsSectionTabs();
  const host = $('#voipSettingsHost');
  voipApi('config')
    .then((config) => {
      if (!host.isConnected) return;
      host.innerHTML = `<div class="panelhead"><div><h2>VoIP bağlantısı</h2><p>Personel dahilileri ve görüşme kayıtları</p></div><span class="badge">${config.enabled ? 'Etkin' : 'Kapalı'}</span></div>
    <form id="voipConfigForm"><div class="grid">
      <label class="settings-check full"><input type="checkbox" name="enabled" ${config.enabled ? 'checked' : ''}> VoIP aramalarını etkinleştir</label>
      <label class="field">Sağlayıcı<select name="provider">${config.providers.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select><small>Yeni sağlayıcılar bağlantı modülüyle eklenebilir.</small></label>
      <label class="field">Santral kimliği (domain_id)<input data-optional="true" name="domainId" maxlength="100" value="${esc(config.domainId || '')}"><small>Verimor bildirimindeki domain_id ile aynı olmalı.</small></label>
      <label class="field">API anahtarı<input data-optional="true" name="apiKey" type="password" maxlength="512" autocomplete="new-password" placeholder="${config.apiKeySaved ? 'Kayıtlı anahtarı korumak için boş bırakın' : 'Verimor API anahtarı'}"><small>Anahtar şifreli saklanır ve tekrar görüntülenmez.</small></label>
      <label class="field">Dış arama numarası<input data-optional="true" name="callerId" type="tel" value="${esc(config.callerId || '')}" placeholder="0850…"><small>Boşsa Verimor dahilisinin dış numarası kullanılır.</small></label>
      <label class="field full">Web telefonu adresi<input data-optional="true" name="webphoneUrl" type="url" value="${esc(config.webphoneUrl || '')}" placeholder="Verimor’un verdiği HTTPS iframe adresi"><small>Tokensız adresi girin. Dahiliye Verimor personel hesabı atanmış olmalı. Masa telefonu / softphone kullanıyorsanız boş bırakabilirsiniz.</small></label>
      <label class="field">Tekrar arama uyarısı (dakika)<input data-optional="true" name="recentMinutes" type="number" min="1" max="10080" value="${config.recentMinutes}"><small>Görüşülen numaralar için uyarır; ulaşılamayan veya meşgul numaralarda onay istemez.</small></label>
      <label class="settings-check"><input data-optional="true" name="clearKey" type="checkbox"> Kayıtlı API anahtarını sil</label>
      <div class="notice full">Dahili numaralarını Ayarlar → Yetkilendirme → Telefon Dahilileri bölümünden CEO veya yöneticiler değiştirebilir.</div>
      <div class="notice full"><strong>Ses kaydı ve arşiv</strong><p>Verimor’da ilgili dahililerin görüşme kaydını açın. Hazır kayıtlar yeniden sıkıştırılmadan, şifreli arşive alınır ve 5 yıl saklanacak şekilde işaretlenir. CEO ve yönetici dinleyebilir; dosya sorumlularına Ayarlar → Yetkilendirme bölümünden dinleme yetkisi verilebilir.</p><p>${config.archiveReady ? 'Kalıcı depolama kullanılabilir.' : 'Bulutta kalıcı arşiv için R2 ortam değişkenlerini tamamlayın.'} ${config.encryptionReady ? 'Şifreleme anahtarı hazır.' : 'Sunucuda VOIP_ENCRYPTION_KEY tanımlanmalı: 64 haneli hex anahtar.'}</p></div>
      <fieldset class="full voip-inbound-settings"><legend>Gelen aramalar</legend>
        <p>İşaretli personelin web telefonu uygulamaya girdiği sürece bağlı kalır ve dışarıdan gelen aramalar onun tarayıcısında çalar. Yalnızca dahilisi olan personel seçilebilir.</p>
        <div class="voip-inbound-users">${
          (config.users || [])
            .filter((u) => config.extensions?.[u.id])
            .map(
              (u) =>
                `<label class="settings-check"><input type="checkbox" name="inboundUsers" value="${esc(u.id)}" ${(config.inboundUsers || []).includes(u.id) ? 'checked' : ''}> ${esc(u.name)} <small>dahili ${esc(config.extensions[u.id])}</small></label>`,
            )
            .join('') || '<small>Önce personele dahili atayın.</small>'
        }</div>
        <label class="field">Yedek hedef<input data-optional="true" name="inboundFallback" maxlength="40" value="${esc(config.inboundFallback || '')}" placeholder="queue/201, group/700 veya user/1001"><small>Borçluyu son arayan ve diğer işaretli personel ulaşılamazsa arama buraya gider.</small></label>
        <label class="field full">Gelen arama yönlendirme adresi<input readonly value="${esc(config.routePath ? location.origin + config.routePath : 'İlk kayıttan sonra oluşur.')}"><small>Verimor → Gelen Arama Yönetimi'nde dış hattın hedefini "Santral Programlama API" yapın ve bu adresi girin. Arama, borçluyu en son arayan personele; o bağlı veya boş değilse işaretli başka bir personele, o da yoksa yedek hedefe gider.</small></label>
      </fieldset>
      <label class="field full">Çağrı bildirim adresi<input readonly value="${esc(config.webhookPath ? location.origin + config.webhookPath : 'İlk kayıttan sonra oluşur.')}"><small>Verimor CRM entegrasyonunda çalma, cevaplanma ve kapanma bildirimleri için bu adresi kullanın. Adres gizli bildirim anahtarı içerir.</small></label>
    </div><p id="voipConfigStatus" role="status"></p><div class="actions"><button class="primary" type="submit">VoIP Ayarlarını Kaydet</button></div></form>`;
      const form = host.querySelector('form');
      form.onsubmit = async (event) => {
        event.preventDefault();
        const button = form.querySelector('[type="submit"]');
        button.disabled = true;
        const value = Object.fromEntries(new FormData(form));
        value.enabled = form.elements.enabled.checked;
        value.clearKey = form.elements.clearKey.checked;
        value.inboundUsers = [...form.querySelectorAll('[name="inboundUsers"]:checked')].map(
          (box) => box.value,
        );
        try {
          await voipApi('config', 'PUT', value);
          voipSettingsPage();
        } catch (error) {
          host.querySelector('#voipConfigStatus').textContent = error.message;
          button.disabled = false;
        }
      };
    })
    .catch((error) => {
      if (host.isConnected) host.textContent = error.message;
    });
}
async function voipExtensionsPanel(before) {
  const panel = document.createElement('section');
  panel.className = 'panel formbody';
  panel.style.marginBottom = '16px';
  before.before(panel);
  panel.textContent = 'Telefon dahilileri yükleniyor…';
  try {
    const data = await voipApi('extensions');
    if (!panel.isConnected) return;
    panel.innerHTML =
      '<h2>Telefon Dahilileri</h2><p>Yalnızca CEO ve yöneticiler değiştirebilir. Personel kendi dahilisini değiştiremez. Buradaki numara Verimor’da tanımlı dahiliyle aynı olmalıdır; bu işlem Verimor’da yeni dahili oluşturmaz.</p><div class="overflow"><table><thead><tr><th>Kullanıcı</th><th>Dahili / İşlem</th></tr></thead><tbody>' +
      data.users
        .map(
          (u) =>
            `<tr><td><strong>${esc(u.name)}</strong><small>Kullanıcı: ${esc(u.username || '')} · ${u.role === 'ceo' ? 'CEO' : u.role === 'admin' ? 'Yönetici' : 'Personel'}</small></td><td><form data-extension-user="${esc(u.id)}" class="toolbar"><input aria-label="${esc(u.name)} dahili numarası" name="extension" type="text" inputmode="numeric" pattern="[0-9]{2,8}" maxlength="8" value="${esc(u.extension)}" placeholder="Atanmadı" data-optional="true" style="width:120px"><button class="secondary" type="submit">Kaydet</button><span role="status"></span></form></td></tr>`,
        )
        .join('') +
      '</tbody></table></div>';
    panel.querySelectorAll('form').forEach(
      (form) =>
        (form.onsubmit = async (event) => {
          event.preventDefault();
          const button = form.querySelector('button'),
            status = form.querySelector('[role="status"]');
          button.disabled = true;
          status.textContent = 'Kaydediliyor…';
          try {
            const saved = await voipApi('extensions', 'PUT', {
              userId: form.dataset.extensionUser,
              extension: form.elements.extension.value.trim(),
            });
            form.elements.extension.value = saved.users.find(
              (u) => u.id === form.dataset.extensionUser,
            ).extension;
            form.elements.extension.defaultValue = form.elements.extension.value;
            status.textContent = 'Kaydedildi.';
          } catch (error) {
            status.textContent = error.message;
          } finally {
            button.disabled = false;
          }
        }),
    );
  } catch (error) {
    if (panel.isConnected) panel.textContent = error.message;
  }
}
function voipPermissionsPage() {
  if (!['ceo', 'admin'].includes(hanAuth.role)) return;
  $('#content').innerHTML =
    settingsSectionTabs('permissions') +
    '<section class="panel"><div class="panelhead"><div><h2>Ses kayıtlarını dinleme yetkisi</h2><p>CEO ve yöneticiler tüm görüşme kayıtlarını dinleyebilir.</p></div></div><div class="formbody"><p>Yetki verilen personel yalnızca şu anda dosya sorumlusu olduğu föylerin kayıtlarını dinleyebilir. Başka personele devredilen dosyaların kayıtlarına erişemez.</p><div id="voipPermissionsRows" aria-live="polite">Yükleniyor…</div></div></section>';
  bindSettingsSectionTabs();
  const host = $('#voipPermissionsRows');
  voipExtensionsPanel(host.closest('section'));
  const refresh = async () => {
    try {
      const data = await voipApi('permissions');
      if (!host.isConnected) return;
      host.innerHTML =
        '<div class="overflow"><table><thead><tr><th>Personel</th><th>Dinleme yetkisi</th></tr></thead><tbody>' +
        data.users
          .map(
            (u) =>
              `<tr><td>${esc(u.name)}${u.assigned ? '' : '<small>Önce personel hesabını eşleştirin.</small>'}</td><td><label class="settings-check"><input type="checkbox" data-listening-user="${esc(u.id)}" ${u.allowed ? 'checked' : ''} ${u.assigned ? '' : 'disabled'}>Sorumlu olduğu dosyaların ses kayıtlarını dinleyebilir</label><p role="status"></p></td></tr>`,
          )
          .join('') +
        '</tbody></table></div>';
      if (!data.users.length) host.textContent = 'Yetkilendirilebilecek personel hesabı yok.';
      host.querySelectorAll('[data-listening-user]').forEach(
        (input) =>
          (input.onchange = async () => {
            input.disabled = true;
            try {
              await voipApi('permissions', 'PUT', {
                userId: input.dataset.listeningUser,
                allowed: input.checked,
              });
              await refresh();
            } catch (error) {
              input.closest('td').querySelector('[role="status"]').textContent = error.message;
              input.disabled = false;
            }
          }),
      );
    } catch (error) {
      host.textContent = error.message;
    }
  };
  refresh();
}
function voipTranscriptMarkup(call) {
  const job = call.transcription;
  if (job?.status === 'completed' && call.canListen)
    return (
      '<details class="voip-ai-transcript" data-voip-transcript="' +
      esc(call.id) +
      '"><summary>AI transkripti</summary><div data-transcript-content role="status"></div></details>'
    );
  const status =
    job?.status === 'queued'
      ? call.archivedAt
        ? 'Yazıya çevirme kuyruğunda'
        : 'Ses arşivi bekleniyor'
      : job?.status === 'processing'
        ? 'AI metni hazırlanıyor…'
        : job?.status === 'failed'
          ? 'Yazıya çevirme tamamlanamadı'
          : '';
  return (
    (status
      ? '<small class="voip-transcription-status">' +
        esc(status) +
        (job?.totalParts ? ' · ' + (job.completedParts || 0) + '/' + job.totalParts : '') +
        '</small>'
      : '') +
    (job?.status === 'failed'
      ? '<small class="voip-transcription-error">' + esc(job.error || '') + '</small>'
      : '') +
    (call.recordingPresent &&
    ['ceo', 'admin'].includes(hanAuth.role) &&
    !['queued', 'processing', 'completed'].includes(job?.status)
      ? '<button class="link voip-transcribe-button" type="button" data-voip-transcribe="' +
        esc(call.id) +
        '">' +
        (job?.status === 'failed' ? 'Yeniden yazıya çevir' : 'Yazıya çevir') +
        '</button>'
      : '')
  );
}
// What the phone exchange reported for the call, so an unexpected result can be explained.
function voipProviderLine(call) {
  const end = call.providerEnd;
  if (!end) return '';
  const parts = [
    end.answered === true ? 'cevaplandı' : end.answered === false ? 'cevaplanmadı' : '',
    Number.isFinite(end.talkSeconds) ? 'konuşma ' + end.talkSeconds + ' sn' : '',
    end.legAnswered === true ? 'karşı taraf açtı' : end.legAnswered === false ? 'karşı taraf açmadı' : '',
    end.result ? 'sonuç ' + end.result : '',
    end.cause ? 'neden ' + (end.reason ? end.reason + ' (' + end.cause + ')' : end.cause) : '',
    end.code ? 'kod ' + end.code : '',
    end.by === 'caller' ? 'kapatan arayan taraf' : end.by === 'callee' ? 'kapatan aranan taraf' : '',
    call.hangupRequestedAt || call.cancelRequested ? 'siz sonlandırdınız' : '',
  ].filter(Boolean);
  return parts.length
    ? '<p class="voip-provider-line">Santral yanıtı: ' + esc(parts.join(' · ')) + '</p>'
    : '';
}
function voipCallMarkup(call, results) {
  return `<article class="voip-call-entry" data-call-state="${esc(call.status)}"><div class="voip-call-top"><strong>${esc(voipDate(call.createdAt))}</strong>${call.direction === 'inbound' ? '<span class="voip-direction-badge">Gelen</span>' : ''}<span class="voip-status-pill">${esc(call.statusLabel)}</span></div>
    <div class="voip-history-meta"><strong>${esc(call.phone ? voipPhone(call.phone) : call.callerNumber || 'Gizli numara')}</strong><span>${esc(call.staffName || (call.direction === 'inbound' ? 'Cevaplanmadı' : ''))}</span>${window.testRecordBadge?.(call) || ''}<span>${esc(voipDuration(call.duration))}</span>${call.documentNumber ? '<span>Föy ' + esc(call.documentNumber) + '</span>' : ''}</div>
    <p class="voip-history-result"><span>Görüşme sonucu</span><b>${esc(call.result || 'Henüz girilmedi')}</b></p>${voipProviderLine(call)}
    <div class="toolbar">${call.canListen ? `<button class="secondary" type="button" data-voip-listen="${esc(call.id)}">▶ Dinle</button>` : ''}${call.archivedAt && call.canListen && ['ceo', 'admin'].includes(hanAuth.role) ? `<a class="link" href="/api/voip/media?id=${encodeURIComponent(call.id)}&download=1">İndir</a>` : ''}${call.recordingPresent && !call.archivedAt && ['ceo', 'admin'].includes(hanAuth.role) ? `<button class="link" type="button" data-voip-archive="${esc(call.id)}">Arşivlemeyi yeniden dene</button>` : ''}${call.direction !== 'inbound' && voipActiveStatuses.has(call.status) && (call.userId === hanAuth.id || ['ceo', 'admin'].includes(hanAuth.role)) ? `<button class="link" type="button" data-voip-sync="${esc(call.id)}">Durumu doğrula</button>` : ''}</div>
    ${call.archiveError ? '<p class="voip-notice">' + esc(call.archiveError) + '</p>' : ''}
    ${call.draftNote || call.note ? `<details class="voip-personal-note"><summary>Personel notu</summary><p class="voip-note">${esc(call.draftNote ?? call.note ?? '')}</p></details>` : ''}${voipTranscriptMarkup(call)}
    ${call.direction !== 'inbound' && !voipActiveStatuses.has(call.status) && (call.userId === hanAuth.id || ['ceo', 'admin'].includes(hanAuth.role)) ? `<details><summary>Sonuç / not düzenle</summary><form data-voip-result="${esc(call.id)}" data-voip-document="${esc(call.documentId)}" class="voip-result-form"><label class="field">Görüşme sonucu<select name="result" required><option value="">Seçin</option>${results.map((r) => `<option ${r === (call.result || (call.status === 'busy' ? 'Meşgul' : call.status === 'unanswered' ? 'Ulaşılamadı' : '')) ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label><label class="field">Görüşme notu<textarea data-optional="true" name="note" maxlength="3000" rows="3">${esc(call.draftNote ?? call.note ?? '')}</textarea></label><button class="primary" type="submit">Kaydet</button></form></details>` : ''}
    <div class="voip-entry-feedback" role="status"></div></article>`;
}
async function completeVoipConversation(call, values) {
  return sendVoipConversation(call, values, await prepareVoipConversation(call, values));
}
// The interactive part of saving a result: a callback plan or a payment promise is asked for here.
async function prepareVoipConversation(call, values) {
  if (!call.documentId) return null;
  const doc = (typeof db !== 'undefined' && db.docs.find((d) => d.id === call.documentId)) || {
    id: call.documentId,
    number: call.documentNumber,
    debtor: call.debtorName,
  };
  const collect = (id, open) =>
    new Promise((resolve) => {
      let saved = null;
      open((value) => {
        saved = value;
        resolve(value);
      });
      const dialog = document.getElementById(id);
      if (!dialog?.open) return resolve(saved);
      dialog.addEventListener('close', () => resolve(saved), { once: true });
    });
  const input = { ...values, documentId: call.documentId, voipCallId: call.id };
  if (values.result === 'Tekrar Aranacak') {
    input.callReminder = await collect('callReminderDialog', (saved) => openCallReminder(doc, saved));
    if (!input.callReminder) throw Error('Arama planı tamamlanmadı. Görüşme notunuz korunuyor.');
  }
  if (values.result === 'Ödeme Sözü Alındı') {
    const promise = await collect('paymentPromiseDialog', (saved) =>
      openPaymentPromise(doc.id, { onSaved: saved }),
    );
    if (!promise) throw Error('Ödeme sözü tamamlanmadı. Görüşme notunuz korunuyor.');
    input.paymentPromiseId = promise.id;
  }
  return input;
}
// The network part. For a borrower call the server also refreshes the conversation report (and
// asks the AI provider when one is set up), which can take a few seconds.
async function sendVoipConversation(call, values, input) {
  if (!call.documentId) {
    await voipApi('result', 'POST', { id: call.id, ...values });
    return;
  }
  const doc = (typeof db !== 'undefined' && db.docs.find((d) => d.id === call.documentId)) || {
    id: call.documentId,
  };
  const response = await fetch('/api/documents/conversations', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Görüşme kaydedilemedi.');
  doc.conversations = data.conversations;
  doc.conversationReport = data.report;
  document.dispatchEvent(
    new CustomEvent('voip-conversation-saved', {
      detail: { documentId: call.documentId, report: data.report },
    }),
  );
  return data;
}
function bindVoipHistory(host, refresh) {
  host.querySelectorAll('[data-voip-transcribe]').forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        await voipApi('transcriptions', 'POST', { mode: 'selected', ids: [button.dataset.voipTranscribe] });
        await refresh();
      } catch (error) {
        button.closest('[data-voip-entry],.voip-call-entry').querySelector('[role="status"]').textContent =
          error.message;
        button.disabled = false;
      }
    };
  });
  host.querySelectorAll('[data-voip-transcript]').forEach((details) => {
    details.ontoggle = async () => {
      if (!details.open || details.dataset.loaded || details.dataset.loading) return;
      details.dataset.loading = 'true';
      const content = details.querySelector('[data-transcript-content]');
      content.textContent = 'AI metni yükleniyor…';
      try {
        const result = await voipApi('transcript?id=' + encodeURIComponent(details.dataset.voipTranscript));
        content.textContent = result.text;
        const meta = document.createElement('small');
        meta.textContent = (result.model || '') + ' · ' + voipDate(result.completedAt);
        content.append(meta);
        details.dataset.loaded = 'true';
      } catch (error) {
        content.textContent = error.message;
      } finally {
        delete details.dataset.loading;
      }
    };
  });
  host.querySelectorAll('[data-voip-listen]').forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      const entry = button.closest('[data-voip-entry], .voip-call-entry');
      try {
        const result = await voipApi('recording', 'POST', { id: button.dataset.voipListen });
        host.querySelectorAll('audio').forEach((audio) => audio.pause());
        entry.querySelector('audio')?.remove();
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'none';
        audio.src = result.url;
        audio.setAttribute('aria-label', 'Görüşme ses kaydı');
        (entry.querySelector('[data-voip-player]') || entry).append(audio);
        audio.play().catch(() => {});
      } catch (error) {
        entry.querySelector('[role="status"]').textContent = error.message;
      } finally {
        button.disabled = false;
      }
    };
  });
  for (const action of ['archive', 'sync'])
    host.querySelectorAll('[data-voip-' + action + ']').forEach((button) => {
      button.onclick = async () => {
        button.disabled = true;
        try {
          await voipApi(action, 'POST', {
            id: button.dataset[action === 'archive' ? 'voipArchive' : 'voipSync'],
          });
          await refresh();
        } catch (error) {
          button.closest('.voip-call-entry').querySelector('[role="status"]').textContent = error.message;
          button.disabled = false;
        }
      };
    });
  host.querySelectorAll('[data-voip-result]').forEach((form) => {
    form.onsubmit = async (event) => {
      event.preventDefault();
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        await completeVoipConversation(
          { id: form.dataset.voipResult, documentId: form.dataset.voipDocument },
          Object.fromEntries(new FormData(form)),
        );
        await refresh();
      } catch (error) {
        form.closest('.voip-call-entry').querySelector('[role="status"]').textContent = error.message;
        button.disabled = false;
      }
    };
  });
}
function voipPhone(value) {
  const n = String(value || '');
  return /^90\d{10}$/.test(n)
    ? '0 (' + n.slice(2, 5) + ') ' + n.slice(5, 8) + ' ' + n.slice(8, 10) + ' ' + n.slice(10)
    : n;
}
function setupVoipConversations(dialog, doc) {
  const history = dialog.querySelector('.conversation-history');
  if (!history || history.dataset.voipUnified) return;
  history.dataset.voipUnified = 'true';
  const manualForm = dialog.querySelector('#borrowerConversationForm');
  if (manualForm) {
    const panel = history.parentElement,
      output = manualForm.querySelector('[data-conversation-report]'),
      generate = manualForm.querySelector('[data-generate-conversation-report]');
    if (output && generate) {
      const report = document.createElement('section');
      report.className = 'voip-report-panel';
      report.append(output.closest('label'), generate.closest('div'));
      panel.insertBefore(report, manualForm);
    }
    panel.insertBefore(history, manualForm);
    const add = document.createElement('details');
    add.className = 'voip-add-conversation';
    const title = document.createElement('summary');
    title.textContent = 'Elle görüşme ekle';
    add.append(title);
    panel.insertBefore(add, manualForm);
    add.append(manualForm);
  }
  history.innerHTML =
    '<div class="voip-conversation-heading"><h4>Görüşme geçmişi</h4><label class="field">Sonuç<select data-unified-result data-optional="true"><option value="">Tüm sonuçlar</option></select></label></div><p data-unified-count role="status"></p><div data-unified-rows></div><div class="toolbar"><button class="secondary" type="button" data-unified-prev>Önceki</button><button class="secondary" type="button" data-unified-next>Sonraki</button></div>';
  const select = history.querySelector('select'),
    host = history.querySelector('[data-unified-rows]');
  let offset = 0,
    request = 0,
    reportChecked = false;
  function applyReport(report) {
    if (!report || !history.isConnected) return;
    const output = dialog.querySelector('[data-conversation-report]');
    if (output) {
      output.value = report.text;
      output.maxLength = (report.maxChars || 300) + 50;
    }
    const status = dialog.querySelector('[data-conversation-report-status]');
    if (status) status.textContent = report.sourceCount + ' görüşme · Telefon görüşmeleri dahil';
  }
  async function refresh() {
    const seq = ++request;
    try {
      const data = await voipApi(
        'history?' + new URLSearchParams({ documentId: doc.id, result: select.value, offset }),
      );
      if (!history.isConnected || seq !== request) return;
      if (select.options.length === 1)
        select.insertAdjacentHTML(
          'beforeend',
          data.results.map((r) => '<option>' + esc(r) + '</option>').join(''),
        );
      const manual = dialog.querySelector('#borrowerConversationForm select[name="result"]');
      if (manual)
        data.results.forEach((result) => {
          if (!Array.from(manual.options).some((o) => o.value === result))
            manual.insertAdjacentHTML('beforeend', '<option>' + esc(result) + '</option>');
        });
      host.innerHTML =
        data.rows
          .map((row) =>
            row.call
              ? '<div class="voip-conversation-source">Telefon araması</div>' +
                voipCallMarkup(row.call, data.results)
              : '<article class="voip-call-entry"><div class="voip-call-top"><strong>' +
                esc(row.date + ' ' + row.time) +
                '</strong><span class="voip-status-pill">' +
                esc(row.result) +
                '</span></div><div class="voip-history-meta"><strong>' +
                esc(row.staffName || '—') +
                '</strong><span>Elle girilen görüşme</span></div><p class="voip-note">' +
                esc(row.note || '') +
                '</p></article>',
          )
          .join('') || '<p>Bu sonuç için görüşme kaydı bulunamadı.</p>';
      history.querySelector('[data-unified-count]').textContent =
        data.total + ' görüşme · ' + (data.total ? offset + 1 : 0) + '–' + Math.min(offset + 50, data.total);
      history.querySelector('[data-unified-prev]').disabled = offset === 0;
      history.querySelector('[data-unified-next]').disabled = offset + 50 >= data.total;
      bindVoipHistory(host, refresh);
      if (!reportChecked && data.total && typeof requestConversationReport === 'function') {
        reportChecked = true;
        requestConversationReport(doc.id)
          .then(applyReport)
          .catch((error) => {
            const status = dialog.querySelector('[data-conversation-report-status]');
            if (status) status.textContent = error.message;
          });
      }
    } catch (error) {
      if (history.isConnected && seq === request)
        history.querySelector('[data-unified-count]').textContent = error.message;
    }
  }
  select.onchange = () => {
    offset = 0;
    refresh();
  };
  history.querySelector('[data-unified-prev]').onclick = () => {
    offset = Math.max(0, offset - 50);
    refresh();
  };
  history.querySelector('[data-unified-next]').onclick = () => {
    offset += 50;
    refresh();
  };
  const saved = (event) => {
    if (!history.isConnected) {
      document.removeEventListener('voip-conversation-saved', saved);
      return;
    }
    if (event.detail.documentId === doc.id) {
      offset = 0;
      refresh();
      applyReport(event.detail.report);
    }
  };
  document.addEventListener('voip-conversation-saved', saved);
  dialog.addEventListener('close', () => document.removeEventListener('voip-conversation-saved', saved), {
    once: true,
  });
  refresh();
}
function setupBorrowerVoip(dialog, doc) {
  setupVoipConversations(dialog, doc);
  const header =
    dialog.querySelector('.sheet-header-actions') ||
    dialog.querySelector(':scope > .panelhead .toolbar') ||
    dialog.querySelector(':scope > .panelhead');
  if (!header || dialog.querySelector('[data-open-voip]')) return;
  const wrap = document.createElement('div');
  wrap.className = 'voip-dropdown';
  wrap.innerHTML =
    '<button type="button" class="primary" data-open-voip aria-expanded="false">☎ Ara</button><section class="voip-number-panel" data-modal-layer aria-label="Telefon numaraları ve son aramalar" hidden></section>';
  header.prepend(wrap);
  const panel = wrap.querySelector('section'),
    trigger = wrap.querySelector('button');
  let timer,
    version = 0,
    busy = false,
    feedback = '',
    tone = 'error',
    confirmation = '',
    trouble = '',
    addingPhone = false;
  let phoneOpening;
  function message(text, type = 'error') {
    feedback = text;
    tone = type;
    const area = panel.querySelector('[data-voip-feedback]');
    if (area) {
      area.textContent = text;
      area.hidden = !text;
      area.dataset.tone = type;
    }
  }
  function close() {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    clearInterval(timer);
    voipUi.panelOpen = false;
    const dock = document.getElementById('voipActiveCall');
    if (dock) dock.hidden = false;
  }
  function outside(event) {
    if (!wrap.isConnected) {
      dispose();
      return;
    }
    if (!panel.hidden && !wrap.contains(event.target)) close();
  }
  panel.addEventListener('modal-layer-dismiss', close);
  function dispose() {
    clearInterval(timer);
    document.removeEventListener('pointerdown', outside, true);
  }
  document.addEventListener('pointerdown', outside, true);
  async function refresh() {
    if (busy || addingPhone) return;
    const seq = ++version;
    try {
      const data = await voipApi('calls?documentId=' + encodeURIComponent(doc.id));
      if (!wrap.isConnected || seq !== version) return;
      voipUi.results = data.results || voipUi.results || [];
      if (data.webphone && !phoneOpening)
        phoneOpening = openVoipWebphone(
          {
            set textContent(text) {
              message(text);
            },
          },
          true,
        ).finally(() => {
          phoneOpening = null;
        });
      const scroll = panel.querySelector('.voip-number-list')?.scrollTop || 0;
      const lastFocused = document.activeElement?.dataset?.dialPhone;
      panel.innerHTML =
        '<div class="voip-panel-heading"><div><strong>Telefonla ara</strong><span>' +
        data.phones.length +
        ' numara · Verimor</span></div>' +
        '<button type="button" class="link" data-voip-diagnose>Bağlantı testi</button>' +
        (!hanAuth.readOnly
          ? '<button type="button" class="secondary" data-add-phone>＋ Numara ekle</button>'
          : '') +
        '</div>' +
        '<div class="voip-panel-messages"><div data-voip-feedback role="alert" aria-live="assertive" hidden></div><div data-voip-repeat hidden></div><div class="voip-mic-notice" data-voip-mic hidden></div><div data-voip-trouble ' +
        (trouble ? '' : 'hidden') +
        '>' +
        trouble +
        '</div></div>' +
        '<div class="voip-panel-columns" aria-hidden="true"><span>Numara</span><span>Son arama</span><span>İşlem</span></div><div class="voip-number-list">' +
        (data.phones
          .map((p) => {
            const calls = data.calls.filter((c) => c.phone === p.phone),
              last = calls[0],
              active = calls.find((c) => voipActiveStatuses.has(c.status) && c.direction !== 'inbound');
            const recent =
              last &&
              last.direction !== 'inbound' &&
              Date.now() - Date.parse(last.createdAt) < data.recentMinutes * 60000 &&
              !['unanswered', 'busy', 'failed'].includes(last.status);
            const state = active ? 'active' : last?.status || 'empty';
            const action =
              active && (active.userId === hanAuth.id || ['ceo', 'admin'].includes(hanAuth.role))
                ? '<button type="button" class="secondary" data-number-workspace="' +
                  esc(active.id) +
                  '">Görüşme notu</button><button type="button" class="voip-hangup" data-number-hangup="' +
                  esc(active.id) +
                  '">Sonlandır</button>'
                : '<button type="button" class="primary" data-dial-phone="' +
                  esc(p.phone) +
                  '" data-recent="' +
                  (recent ? '1' : '') +
                  '" ' +
                  (!data.enabled || !data.extension || active || hanAuth.readOnly ? 'disabled' : '') +
                  '>' +
                  (recent ? 'Tekrar ara' : 'Ara') +
                  '</button>';
            return (
              '<article class="voip-phone-row" data-call-state="' +
              state +
              '"><div class="voip-phone-identity"><small>' +
              esc(p.label) +
              '</small><strong>' +
              esc(voipPhone(p.phone)) +
              '</strong>' +
              (recent && !active ? '<span class="voip-recent-mark">Yakın zamanda görüşüldü</span>' : '') +
              '</div><div class="voip-phone-history">' +
              (last
                ? '<span class="voip-last-time">' +
                  (last.direction === 'inbound' ? '<span class="voip-direction-badge">Gelen</span>' : '') +
                  esc(voipDate(last.createdAt)) +
                  '</span><span class="voip-last-person">' +
                  esc(last.staffName || (last.direction === 'inbound' ? 'Cevaplanmadı' : '')) +
                  ' <span aria-hidden="true">·</span> ' +
                  esc(voipDuration(last.duration)) +
                  '</span><span class="voip-status-line"><span class="voip-status-pill">' +
                  esc(last.statusLabel) +
                  '</span>' +
                  (last.result ? '<span class="voip-result-label">' + esc(last.result) + '</span>' : '') +
                  '</span>'
                : '<span class="voip-empty-history">Henüz aranmadı</span>') +
              '<button type="button" class="link" data-number-history="' +
              esc(p.phone) +
              '">Geçmiş (' +
              calls.length +
              ')</button></div><div class="voip-phone-action">' +
              action +
              '</div></article>'
            );
          })
          .join('') || '<div class="voip-panel-empty">Aranabilecek geçerli bir telefon numarası yok.</div>') +
        '</div>';
      panel.querySelector('.voip-number-list').scrollTop = scroll;
      if (lastFocused)
        panel.querySelector('[data-dial-phone="' + lastFocused + '"]')?.focus({ preventScroll: true });
      if (feedback) message(feedback, tone);
      else if (!data.enabled)
        message(
          'VoIP bağlantısı kapalı. Ayarlar → Entegrasyonlar → VoIP bölümünden etkinleştirin.',
          'notice',
        );
      else if (!data.extension) message('Kullanıcınıza telefon dahilisi atanmalı.', 'notice');
      if (data.enabled && data.extension) {
        // Ask for the microphone before the first call, not in the middle of it.
        voipMicrophoneCheck().then((mic) => {
          const area = panel.querySelector('[data-voip-mic]');
          if (!area || mic.ok) {
            if (area) area.hidden = true;
            return;
          }
          area.hidden = false;
          area.innerHTML =
            '<span>' +
            esc(mic.message) +
            '</span>' +
            (['prompt', 'busy', 'nodevice'].includes(mic.kind)
              ? '<button type="button" class="secondary" data-voip-mic-allow>Mikrofona izin ver</button>'
              : '');
          area.querySelector('[data-voip-mic-allow]')?.addEventListener('click', async () => {
            const asked = await voipMicrophoneCheck({ ask: true });
            if (asked.ok) {
              area.hidden = true;
              message('Mikrofon hazır. Web telefonu "Hazır" olduğunda arayabilirsiniz.', 'notice');
              if (data.webphone && !phoneOpening)
                phoneOpening = openVoipWebphone(
                  {
                    set textContent(text) {
                      message(text);
                    },
                  },
                  true,
                ).finally(() => {
                  phoneOpening = null;
                });
            } else area.querySelector('span').textContent = asked.message;
          });
        });
      }
      panel.querySelector('[data-voip-diagnose]')?.addEventListener('click', async () => {
        trouble = await voipShowDiagnosis(panel.querySelector('[data-voip-trouble]'), { ask: true });
      });
      panel.querySelector('[data-add-phone]')?.addEventListener('click', () => {
        addingPhone = true;
        const form = document.createElement('form');
        form.className = 'voip-add-phone';
        form.innerHTML =
          '<label>Yeni telefon numarası<input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="05XX XXX XX XX" required></label><div><button class="primary" type="submit">Kaydet</button><button class="link" type="button" data-cancel-phone>Vazgeç</button></div><small>Numara bu borçlu föyüne eklenir; ardından listeden arayabilirsiniz.</small><span role="alert"></span>';
        panel.querySelector('.voip-panel-heading').after(form);
        panel.querySelector('[data-add-phone]').disabled = true;
        form.elements.phone.focus();
        form.querySelector('[data-cancel-phone]').onclick = () => {
          addingPhone = false;
          refresh();
        };
        form.onsubmit = async (event) => {
          event.preventDefault();
          const digits = form.elements.phone.value.replace(/[\s()+.\-]/g, '');
          const normalized = /^0[1-9]\d{9}$/.test(digits)
            ? '9' + digits
            : /^[1-9]\d{9}$/.test(digits)
              ? '90' + digits
              : digits;
          if (!/^90[1-9]\d{9}$/.test(normalized)) {
            form.querySelector('[role="alert"]').textContent = 'Geçerli bir Türkiye telefon numarası girin.';
            return;
          }
          if (data.phones.some((p) => p.phone === normalized)) {
            form.querySelector('[role="alert"]').textContent = 'Bu numara zaten föyde kayıtlı.';
            return;
          }
          form.querySelector('[type="submit"]').disabled = true;
          try {
            const saved = await saveRecordIntakeMetadata(doc, {
              ...doc,
              additionalPhones: [...(doc.additionalPhones || []), normalized],
            });
            Object.assign(doc, saved);
            addingPhone = false;
            message('Numara föye eklendi. Listeden arayabilirsiniz.', 'notice');
            await refresh();
          } catch (error) {
            form.querySelector('[role="alert"]').textContent = error.message;
            form.querySelector('[type="submit"]').disabled = false;
          }
        };
      });
      panel.querySelector('[data-open-webphone]')?.addEventListener('click', () =>
        openVoipWebphone({
          set textContent(text) {
            message(text);
          },
        }),
      );
      panel.querySelectorAll('[data-number-history]').forEach(
        (button) =>
          (button.onclick = () => {
            close();
            openVoipHistory(doc, button.dataset.numberHistory);
          }),
      );
      const dial = async (phone, confirmed) => {
        busy = true;
        confirmation = '';
        panel.querySelector('[data-voip-repeat]').hidden = true;
        trouble = '';
        message(
          'Arama başlatılıyor… Web telefonu yeni açıldıysa santrale bağlanması birkaç saniye sürebilir.',
          'notice',
        );
        panel.querySelectorAll('[data-dial-phone]').forEach((b) => (b.disabled = true));
        try {
          const result = await voipStartCancelable(
            {
              documentId: doc.id,
              phone,
              confirmRecent: confirmed,
              requestId: crypto.randomUUID(),
            },
            panel,
            (text) => message(text, 'notice'),
            [...panel.querySelectorAll('[data-dial-phone]')].find((b) => b.dataset.dialPhone === phone),
            { name: doc.debtor || '', detail: voipCallLabel(doc, { documentId: doc.id }) },
          );
          confirmation = '';
          feedback = '';
          trouble = '';
          voipUi.returnToDial = () => {
            if (wrap.isConnected && dialog.open && panel.hidden) trigger.click();
          };
          close();
          showVoipActive(doc, result.call);
        } catch (error) {
          message(error.message);
          if (voipNeedsDiagnosis(error)) {
            trouble = '<p class="voip-diagnosis-wait" role="status">Bağlantı kontrol ediliyor…</p>';
            voipDiagnose().then((rows) => {
              trouble = voipDiagnosisMarkup(rows);
              const area = panel.querySelector('[data-voip-trouble]');
              if (area) {
                area.innerHTML = trouble;
                area.hidden = false;
              }
            });
          }
        } finally {
          busy = false;
          await refresh();
        }
      };
      function repeatPrompt(phone) {
        confirmation = phone;
        const area = panel.querySelector('[data-voip-repeat]');
        area.hidden = false;
        area.innerHTML =
          '<span>Bu numara yakın zamanda arandı. Son görüşmeyi kontrol ettiniz mi?</span><div><button class="secondary" type="button" data-cancel-repeat>Vazgeç</button><button class="primary" type="button" data-confirm-repeat>Yine de ara</button></div>';
        area.querySelector('[data-cancel-repeat]').onclick = () => {
          confirmation = '';
          area.hidden = true;
        };
        area.querySelector('[data-confirm-repeat]').onclick = () => dial(phone, true);
      }
      panel.querySelectorAll('[data-dial-phone]').forEach(
        (button) =>
          (button.onclick = () => {
            if (button.dataset.recent) repeatPrompt(button.dataset.dialPhone);
            else dial(button.dataset.dialPhone, false);
          }),
      );
      if (confirmation) repeatPrompt(confirmation);
      panel.querySelectorAll('[data-number-workspace]').forEach((button) => {
        button.onclick = () => {
          voipUi.minimized = false;
          showVoipActive(
            doc,
            data.calls.find((call) => call.id === button.dataset.numberWorkspace),
          );
          close();
        };
      });
      panel.querySelectorAll('[data-number-hangup]').forEach(
        (button) =>
          (button.onclick = async () => {
            busy = true;
            button.disabled = true;
            message('Arama sonlandırılıyor…', 'notice');
            try {
              await voipApi('hangup', 'POST', { id: button.dataset.numberHangup });
              message('Sonlandırma istendi; santralden kapanış bilgisi bekleniyor.', 'notice');
              await voipUi.syncActive?.();
            } catch (error) {
              message(error.message);
            } finally {
              busy = false;
              await refresh();
            }
          }),
      );
      if (data.active[0]) showVoipActive(doc, data.active[0]);
    } catch (error) {
      if (!panel.querySelector('[data-voip-feedback]'))
        panel.innerHTML =
          '<div class="voip-panel-messages"><div data-voip-feedback role="alert"></div></div>';
      message(error.message);
    }
  }
  trigger.onclick = () => {
    const activeCall = document.getElementById('voipActiveCall');
    if (voipUi.minimized && activeCall && activeCall.dataset.ended !== 'true') {
      activeCall.hidden = false;
      if (!activeCall.open) activeCall.showModal();
      activeCall.querySelector('[data-current-hangup]')?.click();
      return;
    }
    if (!panel.hidden) return close();
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    voipUi.panelOpen = true;
    feedback = '';
    const dock = document.getElementById('voipActiveCall');
    if (dock) dock.hidden = false;
    panel.innerHTML = '<div class="voip-panel-empty" role="status">Son aramalar yükleniyor…</div>';
    refresh();
    timer = setInterval(() => {
      if (!dialog.open || !wrap.isConnected) {
        dispose();
        return;
      }
      refresh();
    }, 10000);
  };
  wrap.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
      trigger.focus();
    }
  });
  dialog.addEventListener(
    'close',
    () => {
      close();
      dispose();
    },
    { once: true },
  );
  const history = document.createElement('section');
  history.className = 'voip-sheet-history';
  history.innerHTML =
    '<h3>Telefon aramaları ve ses kayıtları</h3><button type="button" class="secondary">Arama Geçmişini Aç</button>';
  history.querySelector('button').onclick = () => openVoipHistory(doc);
  (dialog.querySelector('[data-borrower-panel="conversations"]') || dialog.querySelector('.formbody')).append(
    history,
  );
}
// The shared phone frame sits in the bottom-right corner, except when it is opened from the
// header's "Numara ara" button: then it opens right below that button, inside the viewport.
function voipPlaceDock(dock, anchor) {
  const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
  if (!rect || !rect.width) {
    for (const side of ['top', 'left', 'right', 'bottom', 'width', 'maxHeight']) dock.style[side] = '';
    delete dock.dataset.anchored;
    return;
  }
  const margin = 12,
    width = Math.min(460, window.innerWidth - margin * 2),
    left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin)),
    top = Math.round(rect.bottom + 8);
  Object.assign(dock.style, {
    top: top + 'px',
    left: Math.round(left) + 'px',
    right: 'auto',
    bottom: 'auto',
    width: width + 'px',
    maxHeight: 'calc(100dvh - ' + (top + margin) + 'px)',
  });
  dock.dataset.anchored = 'header';
}
function voipPhoneDock(reveal = true, anchor = null) {
  let dock = document.getElementById('voipPhoneDock');
  if (!dock) {
    dock = document.createElement('div');
    dock.id = 'voipPhoneDock';
    dock.className = 'voip-phone-dock';
    dock.setAttribute('popover', 'manual');
    dock.hidden = true;
    document.body.append(dock);
    // The header button moves when the window is resized; keep the frame under it.
    window.addEventListener('resize', () => {
      if (!dock.hidden && dock.dataset.anchored)
        voipPlaceDock(dock, document.querySelector('[data-standalone-voip]'));
    });
  }
  if (reveal) {
    // Placement is decided when the frame opens; later calls leave it where it is.
    if (dock.hidden || anchor) voipPlaceDock(dock, anchor);
    dock.hidden = false;
    if (dock.showPopover && !dock.matches(':popover-open')) dock.showPopover();
  }
  return dock;
}
async function openVoipWebphone(feedback, background = false) {
  // A pending idle teardown is canceled: the same registered web phone serves the next call.
  clearTimeout(voipUi.releaseTimer);
  voipUi.releaseTimer = null;
  const generation = voipUi.phoneGeneration || 0;
  try {
    const dock = voipPhoneDock(!background);
    if (!background) dock.classList.remove('voip-dock-minimized');
    const existing = document.getElementById('voipWebphone');
    if (existing?.open && existing.querySelector('iframe')?.src) {
      existing.style.visibility = 'visible';
      if (!background) existing.focus();
      return;
    }
    const result = await (voipUi.webphoneTokenRequest ||= voipApi('webphone', 'POST', {}).finally(() => {
      voipUi.webphoneTokenRequest = null;
    }));
    if (generation !== (voipUi.phoneGeneration || 0)) return;
    if (typeof result.url !== 'string' || !result.url.startsWith('https://'))
      throw Error('Web telefonu bağlantısı alınamadı. VoIP ayarlarını kontrol edin.');
    let phone = document.getElementById('voipWebphone');
    if (!phone) {
      phone = document.createElement('dialog');
      phone.id = 'voipWebphone';
      phone.className = 'voip-webphone';
      phone.innerHTML =
        '<div class="panelhead"><h2>HAN HUKUK WEB TELEFON</h2><div class="voip-phone-window-actions"><button type="button" class="secondary" data-phone-minimize>Küçült</button><button type="button" class="secondary" data-phone-close>Kapat</button></div></div><p class="voip-answer-hint" role="status">Gelen aramayı açmak için aşağıdaki telefonda yeşil düğmeye basın.</p><iframe title="HAN HUKUK web telefonu" allow="microphone; autoplay" referrerpolicy="no-referrer"></iframe>';
      dock.append(phone);
      // Esc must not close the phone while it waits to be answered: that would reload it.
      phone.addEventListener('cancel', (event) => {
        if (phone.dataset.answering) event.preventDefault();
      });
      phone.querySelector('button').onclick = () => {
        // While answering, both header buttons only put the phone back out of the way.
        if (phone.dataset.answering) return voipWebphoneAnswering(false);
        dock.classList.toggle('voip-dock-minimized');
        phone.querySelector('button').textContent = dock.classList.contains('voip-dock-minimized')
          ? 'Genişlet'
          : 'Küçült';
      };
      phone.querySelector('[data-phone-close]').onclick = () => {
        if (phone.dataset.answering) return voipWebphoneAnswering(false);
        const active = document.getElementById('voipActiveCall');
        if (active && active.dataset.ended !== 'true') {
          if (!voipUi.minimized) active.querySelector('[data-current-minimize]')?.click();
          return;
        }
        if (dock.hidePopover) dock.hidePopover();
        dock.hidden = true;
      };
    }
    phone.style.visibility = 'visible';
    if (phone.querySelector('iframe').getAttribute('src') !== result.url)
      phone.querySelector('iframe').src = result.url;
    if (!phone.open) phone.show();
  } catch (error) {
    feedback.textContent = error.message;
  }
}
// Removing Verimor's web phone (it unregisters and closes its audio) right as a call ends competes
// with the result window. Hide it now and remove it once the browser is idle; a new call before
// then simply keeps using it.
function releaseVoipWebphoneSoon() {
  clearTimeout(voipUi.releaseTimer);
  const phone = document.getElementById('voipWebphone');
  if (!phone) return;
  phone.style.visibility = 'hidden';
  // Staff who take inbound calls keep the web phone registered between calls.
  if (voipUi.alwaysOn) return;
  voipUi.releaseTimer = setTimeout(() => {
    voipUi.releaseTimer = null;
    const run = () => {
      const active = document.getElementById('voipActiveCall');
      if (voipUi.startPending || (active && active.dataset.ended !== 'true')) return;
      releaseVoipWebphone();
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 3000 });
    else run();
  }, 1500);
}
function releaseVoipWebphone() {
  clearTimeout(voipUi.releaseTimer);
  voipUi.releaseTimer = null;
  voipUi.phoneGeneration = (voipUi.phoneGeneration || 0) + 1;
  const phone = document.getElementById('voipWebphone');
  if (phone) {
    phone.querySelector('iframe')?.remove();
    phone.remove();
  }
}
function showVoipActive(doc, call) {
  let host = document.getElementById('voipActiveCall');
  if (host?.dataset.callId === call.id) {
    host.hidden = false;
    voipUi.updateActive(call);
    return;
  }
  voipUi.disposeActive?.();
  host?.remove();
  clearInterval(voipUi.timer);
  const returnToDial = voipUi.returnToDial;
  voipUi.returnToDial = null;
  voipUi.activeId = call.id;
  voipUi.minimized = false;
  host = document.createElement('dialog');
  host.id = 'voipActiveCall';
  host.className = 'voip-active-call';
  if (voipUi.callPlacement) {
    const place = voipUi.callPlacement;
    const left = Math.max(12, Math.min(place.left, window.innerWidth - 320));
    const top = Math.max(12, Math.min(place.top, window.innerHeight - 240));
    host.style.position = 'fixed';
    host.style.inset = top + 'px auto auto ' + left + 'px';
    host.style.width = Math.min(place.width, window.innerWidth - left - 12) + 'px';
    host.style.maxWidth = 'calc(100vw - 24px)';
    host.style.maxHeight = 'calc(100dvh - ' + (top + 12) + 'px)';
  }
  host.dataset.callId = call.id;
  voipPhoneDock().prepend(host);
  // The borrower sheet is modal: a plain dialog/popover above it is still inert.
  // Keep call controls in the modal top layer from the moment dialing starts.
  if (!host.open) {
    if (typeof host.showModal === 'function') host.showModal();
    else host.show();
  }
  host.hidden = false;
  host.innerHTML = `<div class="voip-workspace-heading"><div><span data-current-status></span><strong>${esc(voipPhone(call.phone))}</strong><small>${esc(call.documentNumber || doc.number || '')} · ${esc(call.debtorName || doc.debtor || '')}</small><time data-current-duration aria-label="Çağrı süresi">00:00</time></div><button type="button" class="link" data-current-minimize>Küçült</button></div>
    <div class="voip-workspace-feedback" data-current-feedback role="alert" hidden></div>
    <form data-current-form><div class="voip-workspace-actions"><button class="secondary" type="button" data-current-mute aria-pressed="false" title="Sessize al">🎙 Sessize al</button><button class="secondary" type="button" data-current-hold disabled title="Verimor’un harici bekletme kontrolü henüz doğrulanmadı.">Ⅱ Beklet</button><button class="link" type="button" data-current-sync hidden>Durumu doğrula</button><button class="secondary" type="button" data-current-transfer hidden title="Görüşmeyi başka personele aktar">⇄ Aktar</button><button class="voip-hangup" type="button" data-current-hangup title="Aramayı sonlandır">☎ Sonlandır</button><button class="primary" type="submit" data-current-save hidden>Tamam</button><span class="voip-outbound-line" data-outbound-line role="status"></span></div><label class="voip-live-note">Görüşme notu<textarea data-optional="true" name="note" maxlength="3000" rows="4" placeholder="Görüşme sürerken notunuzu yazabilirsiniz…"></textarea></label><span class="voip-draft-status" data-draft-status role="status"></span>
    <fieldset class="voip-outcomes" data-current-outcomes hidden><legend>Görüşme sonucu</legend><p data-current-suggestion hidden>Santral sonucu seçildi; gerekirse değiştirebilirsiniz.</p><div data-current-choices></div></fieldset>
</form>`;
  const form = host.querySelector('form'),
    note = form.elements.note,
    feedback = host.querySelector('[data-current-feedback]'),
    draftStatus = host.querySelector('[data-draft-status]'),
    outcomes = host.querySelector('[data-current-outcomes]');
  note.value = call.draftNote ?? call.note ?? '';
  let ended = false,
    draftTimer,
    draftRevision = 0,
    saveQueue = Promise.resolve(),
    syncing = false,
    lastProviderSync = 0,
    hangupPending = false,
    disposed = false;
  let muted = !!call.muted;
  const started = Date.parse(call.answeredAt || call.createdAt) || Date.now();
  const elapsed = setInterval(() => {
    if (!ended)
      host.querySelector('[data-current-duration]').textContent = voipDuration(
        Math.max(0, Math.floor((Date.now() - started) / 1000)),
      );
  }, 1000);
  const message = (text, tone = 'error') => {
    feedback.textContent = text;
    feedback.hidden = !text;
    feedback.dataset.tone = tone;
  };
  const saveDraft = () => {
    clearTimeout(draftTimer);
    const text = note.value,
      revision = ++draftRevision;
    draftStatus.textContent = 'Not kaydediliyor…';
    saveQueue = saveQueue
      .catch(() => {})
      .then(async () => {
        try {
          await voipApi('draft', 'POST', { id: call.id, note: text });
          if (!disposed && revision === draftRevision) draftStatus.textContent = 'Not taslağı kaydedildi';
        } catch (error) {
          if (!disposed && revision === draftRevision) {
            draftStatus.textContent = '';
            message('Not taslağı kaydedilemedi. ' + error.message);
          }
          throw error;
        }
      });
    return saveQueue;
  };
  note.oninput = () => {
    draftStatus.textContent = 'Kaydedilmemiş not';
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => saveDraft().catch(() => {}), 800);
  };
  const heartbeat = () => {
    if (!ended && !disposed) void voipApi('heartbeat', 'POST', { id: call.id }).catch(() => {});
  };
  const heartbeatTimer = setInterval(heartbeat, 15000);
  heartbeat();
  const getHeaderCallButton = () => document.querySelector('#borrowerDetail[open] [data-open-voip]');
  const resetHeaderCall = () => {
    const headerCallButton = getHeaderCallButton();
    if (!headerCallButton) return;
    headerCallButton.textContent = '☎ Ara';
    headerCallButton.classList.remove('voip-hangup');
  };
  voipUi.disposeActive = () => {
    resetHeaderCall();
    voipCallBarClose();
    clearInterval(heartbeatTimer);
    disposed = true;
    clearTimeout(draftTimer);
    clearInterval(elapsed);
  };
  host.querySelector('[data-current-minimize]').onclick = () => {
    voipUi.minimized = !voipUi.minimized;
    host.classList.toggle('voip-call-minimized', voipUi.minimized);
    const headerCallButton = getHeaderCallButton();
    if (headerCallButton && !ended) {
      if (voipUi.minimized) {
        headerCallButton.textContent = '☎ Sonlandır';
        headerCallButton.classList.add('voip-hangup');
        if (host.open) host.close();
        host.hidden = true;
      } else {
        resetHeaderCall();
        host.hidden = false;
        if (!host.open) host.showModal();
      }
    }
    document.getElementById('voipPhoneDock')?.classList.toggle('voip-dock-minimized', voipUi.minimized);
    host.querySelector('[data-current-minimize]').textContent = voipUi.minimized ? 'Genişlet' : 'Küçült';
    if (draftTimer) saveDraft().catch(() => {});
  };
  host.addEventListener('cancel', (event) => {
    event.preventDefault();
    host.querySelector('[data-current-minimize]').click();
  });
  host.addEventListener('close', () => {
    if (!ended && !disposed && !voipUi.minimized) host.querySelector('[data-current-minimize]').click();
  });
  const update = (next) => {
    const wasEnded = ended;
    ended = !voipActiveStatuses.has(next.status);
    host.querySelector('[data-current-status]').textContent =
      (next.statusLabel || 'Aranıyor') + (ended ? ' · ' + voipDuration(next.duration) : '');
    host.dataset.ended = String(ended);
    const line = host.querySelector('[data-outbound-line]');
    if (line) {
      line.hidden = ended;
      const digits = (next.outboundNumber || '').replace(/^90/, '0');
      const display =
        digits.length === 11
          ? digits.slice(0, 4) + ' ' + digits.slice(4, 7) + ' ' + digits.slice(7, 9) + ' ' + digits.slice(9)
          : digits;
      line.textContent =
        next.outboundLine && display ? next.outboundLine + '. hat · ' + display : 'Dış hat doğrulanıyor…';
    }
    const ending = !ended && !next.cancelError && (next.cancelRequested || hangupPending);
    if (ended) {
      resetHeaderCall();
      voipCallBarClose();
    } else
      voipCallBarUpdate({
        phase: { ringing: 'ringing', answered: 'answered', unknown: 'unknown' }[next.status] || 'dialing',
        status: next.statusLabel || 'Aranıyor…',
        line: line ? line.textContent : '',
        ending,
      });
    voipCancelWait(host, ending);
    // Busy/canceled calls keep the registered webphone ready for the next attempt.
    if (ended && !wasEnded && next.status === 'completed') releaseVoipWebphoneSoon();
    outcomes.hidden = !ended;
    host.querySelector('[data-current-hangup]').hidden = ended;
    host.querySelector('[data-current-sync]').hidden = true;
    host.querySelector('[data-current-hold]').hidden = ended;
    host.querySelector('[data-current-transfer]').hidden = ended || next.status !== 'answered';
    // An inbound call another extension took over (transfer or pick-up) belongs to that person now,
    // including its evaluation.
    if (next.direction === 'inbound' && next.userId && next.userId !== hanAuth.id) {
      clearInterval(voipUi.timer);
      voipUi.disposeActive?.();
      host.remove();
      voipUi.activeId = '';
      if (typeof toast === 'function')
        toast('Görüşme ' + (next.staffName || 'diğer personele') + ' aktarıldı.');
      return;
    }
    if (
      (next.resultAt &&
        (next.status === 'busy' ||
          (['Meşgul', 'Ulaşılamadı'].includes(next.result) && next.resultBy === 'Santral'))) ||
      (next.cancelRequested && ['unanswered', 'failed'].includes(next.status))
    ) {
      clearInterval(voipUi.timer);
      voipUi.disposeActive?.();
      host.remove();
      voipUi.activeId = '';
      const dock = document.getElementById('voipPhoneDock');
      if (dock?.hidePopover) dock.hidePopover();
      if (dock) dock.hidden = true;
      returnToDial?.();
      return;
    }
    host.querySelector('[data-current-save]').hidden = !ended;
    host.querySelector('[data-current-mute]').hidden = ended;
    if (ended) {
      clearInterval(elapsed);
      host.querySelector('[data-current-duration]').textContent = voipDuration(next.duration);
    }
    if (!ended) return;
    if (!host.querySelector('[name="result"]')) {
      host.querySelector('[data-current-choices]').innerHTML = (voipUi.results || [])
        .filter((result) => call.documentId || !['Tekrar Aranacak', 'Ödeme Sözü Alındı'].includes(result))
        .map(
          (result) =>
            '<label><input type="radio" name="result" required value="' +
            esc(result) +
            '"><span>' +
            esc(result) +
            '</span></label>',
        )
        .join('');
    }
    if (!form.querySelector('[name="result"]:checked')) {
      const suggested =
        next.result ||
        (next.status === 'busy' ? 'Meşgul' : next.status === 'unanswered' ? 'Ulaşılamadı' : '');
      Array.from(form.querySelectorAll('[name="result"]')).forEach((input) => {
        input.checked = input.value === suggested;
      });
      host.querySelector('[data-current-suggestion]').hidden = !suggested;
    }
    clearInterval(voipUi.timer);
    if (!wasEnded) {
      document
        .querySelector('.voip-number-panel:not([hidden])')
        ?.dispatchEvent(new Event('modal-layer-dismiss'));
      voipUi.minimized = false;
      host.classList.remove('voip-call-minimized');
      document.getElementById('voipPhoneDock')?.classList.remove('voip-dock-minimized');
      host.querySelector('[data-current-minimize]').textContent = 'Küçült';
      host.hidden = false;
      // A non-modal dialog inside a popover remains inert behind borrower.showModal().
      // Promote the result form to the top modal layer so notes and choices receive input.
      if (typeof host.showModal === 'function') {
        if (host.open) host.close();
        host.showModal();
      }
      message('Görüşme sona erdi. Sonucu seçip Tamam’a basın.', 'notice');
      if (document.activeElement !== note)
        host.querySelector('[name="result"]')?.focus({ preventScroll: true });
    }
  };
  voipUi.updateActive = update;
  // The top bar controls this call from any screen, even while the window below is hidden.
  const debtorName = call.debtorName || doc.debtor || '';
  voipCallBarOpen({
    phase: 'dialing',
    startedAt: started,
    name: debtorName || voipPhone(call.phone),
    detail: [debtorName ? voipPhone(call.phone) : '', voipCallLabel(doc, call)].filter(Boolean).join(' · '),
    muted,
    mute: () => host.querySelector('[data-current-mute]')?.click(),
    open: () => {
      if (voipUi.minimized) host.querySelector('[data-current-minimize]').click();
      else {
        host.hidden = false;
        if (!host.open && typeof host.showModal === 'function') host.showModal();
      }
      note.focus({ preventScroll: true });
    },
    hangup: () => {
      host.hidden = false;
      if (!host.open && typeof host.showModal === 'function') host.showModal();
      host.querySelector('[data-current-hangup]')?.click();
    },
  });
  update(call);
  if (call.cancelRequested)
    message(
      call.cancelError || 'İptal istendi. Santralden kapanış bilgisi bekleniyor.',
      call.cancelError ? 'error' : 'notice',
    );
  const muteButton = host.querySelector('[data-current-mute]');
  const muteLabel = () => {
    muteButton.setAttribute('aria-pressed', String(muted));
    muteButton.textContent = muted ? '🔇 Sesi aç' : '🎙 Sessize al';
    voipCallBarUpdate({ muted });
  };
  muteLabel();
  muteButton.onclick = async () => {
    muteButton.disabled = true;
    voipCallBarUpdate({ muteBusy: true });
    try {
      const result = await voipApi('mute', 'POST', { id: call.id, muted: !muted });
      muted = result.muted;
      muteLabel();
    } catch (error) {
      message(error.message);
    } finally {
      muteButton.disabled = false;
      voipCallBarUpdate({ muteBusy: false });
    }
  };
  host.querySelector('[data-current-transfer]').onclick = async (event) => {
    const button = event.currentTarget;
    if (host.querySelector('[data-transfer-box]')) return;
    button.disabled = true;
    try {
      const { targets } = await voipApi('transfer-targets');
      if (!targets.length) return message('Aktarılabilecek dahilisi olan başka personel yok.');
      const box = document.createElement('div');
      box.className = 'voip-transfer-box';
      box.dataset.transferBox = '';
      box.innerHTML =
        '<label>Kime aktarılsın?<select>' +
        targets
          .map(
            (t) =>
              '<option value="' +
              esc(t.id) +
              '">' +
              esc(t.name) +
              ' · ' +
              esc(t.extension) +
              (t.online ? ' · bağlı' : '') +
              '</option>',
          )
          .join('') +
        '</select></label><button type="button" class="primary" data-transfer-go>Aktar</button><button type="button" class="link" data-transfer-cancel>Vazgeç</button>';
      host.querySelector('.voip-workspace-actions').after(box);
      box.querySelector('[data-transfer-cancel]').onclick = () => box.remove();
      box.querySelector('[data-transfer-go]').onclick = async (go) => {
        const send = go.currentTarget;
        send.disabled = true;
        try {
          await voipApi('transfer', 'POST', { id: call.id, userId: box.querySelector('select').value });
          box.remove();
          message('Aktarma istendi. Karşı taraf açınca görüşme ve değerlendirmesi ona geçer.', 'notice');
        } catch (error) {
          message(error.message);
          send.disabled = false;
        }
      };
    } catch (error) {
      message(error.message);
    } finally {
      button.disabled = false;
    }
  };
  host.querySelector('[data-current-hangup]').onclick = async (event) => {
    event.target.disabled = true;
    hangupPending = true;
    voipCancelWait(host, true);
    voipCallBarUpdate({ ending: true });
    try {
      await voipApi('hangup', 'POST', { id: call.id });
      message('Sonlandırma istendi. Santralden kapanış bilgisi bekleniyor.', 'notice');
      lastProviderSync = 0;
      await sync();
    } catch (error) {
      hangupPending = false;
      voipCancelWait(host, false);
      voipCallBarUpdate({ ending: false });
      message(error.message);
    } finally {
      event.target.disabled = false;
    }
  };
  const sync = async () => {
    if (syncing || disposed || ended) return;
    syncing = true;
    try {
      if (Date.now() - lastProviderSync >= 15000) {
        lastProviderSync = Date.now();
        try {
          await voipApi('sync', 'POST', { id: call.id });
        } catch {
          /* CDR may not exist until hangup. */
        }
      }
      const data = await voipApi(
          'calls?' +
            (call.documentId
              ? 'documentId=' + encodeURIComponent(call.documentId)
              : 'phone=' + encodeURIComponent(call.phone)),
        ),
        current = data.calls.find((c) => c.id === call.id);
      voipUi.results = data.results;
      if (!disposed && current) update(current);
    } catch {
      /* Retain the last confirmed call state. */
    } finally {
      syncing = false;
    }
  };
  voipUi.syncActive = sync;
  host.querySelector('[data-current-sync]').onclick = async () => {
    try {
      await voipApi('sync', 'POST', { id: call.id });
      await sync();
    } catch (error) {
      message(error.message);
    }
  };
  let prepared = null;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const result = form.querySelector('[name="result"]:checked')?.value;
    if (!ended || !result) return message('Görüşme bittikten sonra bir sonuç seçin.');
    clearTimeout(draftTimer);
    const values = { result, note: note.value };
    // Only the extra questions (callback plan, payment promise) wait for the user. A retry after
    // a failed save reuses what was already answered for the same result.
    if (prepared?.result !== result) {
      try {
        prepared = { result, input: await prepareVoipConversation(call, values) };
      } catch (error) {
        return message(error.message);
      }
    }
    form.querySelectorAll('input,textarea,button').forEach((input) => {
      input.disabled = true;
    });
    // Close at once and give the screen back. A new call must not dispose this window while its
    // save is still running, so it leaves the active-call slot.
    voipUi.disposeActive();
    if (host.open) host.close();
    host.hidden = true;
    host.removeAttribute('id');
    voipUi.activeId = '';
    const dock = document.getElementById('voipPhoneDock');
    if (dock && !document.getElementById('voipActiveCall') && !voipUi.startPending) {
      if (dock.hidePopover) dock.hidePopover();
      dock.hidden = true;
    }
    try {
      await saveQueue.catch(() => {});
      await sendVoipConversation(call, values, prepared.input);
      host.remove();
      if (typeof toast === 'function') {
        const panel = document.querySelector('.voip-number-panel:not([hidden])');
        toast('Görüşme sonucu kaydedildi.', panel || undefined);
        const notice = panel?.querySelector('.local-feedback');
        if (notice) setTimeout(() => notice.remove(), 4000);
      }
    } catch (error) {
      // Nothing is lost: the same window returns with the chosen result and note.
      voipPhoneDock().prepend(host);
      host.hidden = false;
      if (typeof host.showModal === 'function') host.showModal();
      else host.show();
      form.querySelectorAll('input,textarea,button').forEach((input) => {
        input.disabled = false;
      });
      message('Görüşme sonucu kaydedilemedi: ' + error.message + ' Tekrar Tamam’a basın.');
    }
  };
  if (!ended) voipUi.timer = setInterval(sync, 2500);
  if (call.cancelRequested && !call.cancelError && !ended) {
    voipCancelWait(host, true);
    sync();
  }
}
async function openVoipHistory(doc, phone = '') {
  let dialog = document.getElementById('voipHistory');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'voipHistory';
    dialog.className = 'voip-history';
    document.body.append(dialog);
  }
  dialog.innerHTML =
    '<div class="panelhead"><h2>Arama geçmişi</h2><button class="secondary" type="button" data-close-history>Kapat</button></div><div class="formbody" data-history-content>Yükleniyor…</div>';
  dialog.querySelector('[data-close-history]').onclick = () => dialog.close();
  if (!dialog.open) dialog.showModal();
  const host = dialog.querySelector('[data-history-content]');
  const refresh = async () => {
    try {
      const data = await voipApi(
        'calls?' +
          (doc.id ? 'documentId=' + encodeURIComponent(doc.id) : 'phone=' + encodeURIComponent(phone)),
      );
      if (!host.isConnected) return;
      host.innerHTML =
        data.calls
          .filter((c) => !phone || c.phone === phone)
          .map((c) => voipCallMarkup(c, data.results))
          .join('') || '<p>Henüz arama yok.</p>';
      bindVoipHistory(host, refresh);
    } catch (error) {
      host.textContent = error.message;
    }
  };
  await refresh();
}
function voipRecordingsPage() {
  if (!['ceo', 'admin'].includes(hanAuth.role)) return;
  $('#content').innerHTML =
    '<section class="panel voip-archive">' +
    '<form id="voipArchiveSearch" class="voip-archive-filters"><label class="field voip-archive-query">Kayıtlarda ara<input data-optional="true" name="q" type="search" maxlength="100" placeholder="Müvekkil, föy, borçlu, numara veya personel"></label><label class="field">Tarih<input data-optional="true" name="date" type="date"></label><label class="field">Çağrı durumu<select data-optional="true" name="status"><option value="">Tüm durumlar</option><option value="completed">Görüşüldü</option><option value="unanswered">Ulaşılamadı</option><option value="busy">Meşgul</option><option value="failed">Başarısız</option><option value="active">Devam eden / doğrulanacak</option></select></label><label class="field">Yön<select data-optional="true" name="flow"><option value="">Tüm yönler</option><option value="outbound">Giden</option><option value="inbound">Gelen</option></select></label><label class="field">Görüşme sonucu<select data-optional="true" name="result"><option value="">Tüm sonuçlar</option></select></label><div class="voip-filter-actions"><button class="primary" type="submit">Filtrele</button><button class="link" type="button" data-clear-archive>Temizle</button></div></form>' +
    '<div class="voip-transcription-toolbar"><span data-selected-count>0 kayıt seçildi</span><button class="link" type="button" data-select-page>Bu sayfayı seç</button><select data-transcription-mode aria-label="Yazıya çevrilecek kayıtlar"><option value="selected">Seçilen ses kayıtları</option><option value="filtered">Filtrelenen ses kayıtları</option><option value="all">Tüm ses kayıtları</option></select><button class="primary" type="button" data-transcribe-bulk>Yazıya çevir</button><button class="link" type="button" data-refresh-archive>Yenile</button><span data-transcription-feedback role="status"></span></div><div class="voip-archive-summary"><strong id="voipArchiveTotal" role="status"></strong><span>Tarihler İstanbul saatindedir</span></div><div class="voip-archive-table" id="voipArchiveRows"></div>' +
    '<div class="actions voip-archive-pagination"><span id="voipArchiveCount"></span><div><button type="button" class="secondary" id="voipArchivePrevious">Önceki</button><button type="button" class="secondary" id="voipArchiveNext">Sonraki</button></div></div></section>';
  const form = $('#voipArchiveSearch'),
    host = $('#voipArchiveRows');
  let offset = 0,
    request = 0,
    sort = 'date',
    direction = 'desc';
  const selected = new Set();
  let currentCalls = [],
    appliedFilters = {},
    poll;
  const toolbar = document.querySelector('.voip-transcription-toolbar');
  const selectionCount = () => {
    toolbar.querySelector('[data-selected-count]').textContent = selected.size + ' kayıt seçildi';
  };

  const columns = [
    [
      ['date', 'Tarih'],
      ['duration', 'Süre'],
    ],
    [
      ['client', 'Müvekkil'],
      ['document', 'Dosya'],
    ],
    [['staff', 'Arayan']],
    [['phone', 'Telefon']],
    [
      ['status', 'Durum'],
      ['result', 'Sonuç'],
    ],
    [['recording', 'Ses kaydı']],
  ];
  function selectSort(key) {
    direction =
      key === sort
        ? direction === 'asc'
          ? 'desc'
          : 'asc'
        : ['date', 'duration', 'recording'].includes(key)
          ? 'desc'
          : 'asc';
    sort = key;
    offset = 0;
    refresh();
  }
  const refresh = async () => {
    const seq = ++request;
    $('#voipArchiveTotal').textContent = 'Kayıtlar yükleniyor…';
    try {
      const filters = Object.fromEntries(new FormData(form));
      const data = await voipApi(
        'recordings?' + new URLSearchParams({ ...filters, offset, sort, direction }),
      );
      if (!host.isConnected || seq !== request) return;
      currentCalls = data.calls;
      appliedFilters = filters;
      if (form.elements.result.options.length === 1) {
        form.elements.result.insertAdjacentHTML(
          'beforeend',
          data.results.map((result) => '<option>' + esc(result) + '</option>').join(''),
        );
      }
      host.innerHTML = data.calls.length
        ? '<div class="voip-mobile-sort"><label>Sırala <select data-archive-sort>' +
          columns
            .flat()
            .map(
              ([key, label]) =>
                '<option value="' + key + '" ' + (key === sort ? 'selected' : '') + '>' + label + '</option>',
            )
            .join('') +
          '</select></label><button type="button" class="link" data-sort-direction aria-label="Sıralama yönünü değiştir">' +
          (direction === 'asc' ? '↑ Artan' : '↓ Azalan') +
          '</button></div><table><thead><tr>' +
          columns
            .map(
              (group) =>
                '<th scope="col"' +
                (group.some(([key]) => key === sort)
                  ? ' aria-sort="' + (direction === 'asc' ? 'ascending' : 'descending') + '"'
                  : '') +
                '>' +
                group
                  .map(
                    ([key, label]) =>
                      '<button type="button" data-archive-sort-key="' +
                      key +
                      '" aria-label="' +
                      label +
                      ' sıralaması">' +
                      label +
                      '<span aria-hidden="true">' +
                      (key === sort ? (direction === 'asc' ? ' ↑' : ' ↓') : ' ↕') +
                      '</span></button>',
                  )
                  .join('<span class="voip-sort-divider"> / </span>') +
                '</th>',
            )
            .join('') +
          '</tr></thead><tbody>' +
          data.calls
            .map(
              (c) =>
                `<tr data-voip-entry data-call-state="${esc(c.status)}"><td><input class="voip-record-select" type="checkbox" data-select-call="${esc(c.id)}" aria-label="${esc(c.documentNumber || c.phone || c.callerNumber || '')} görüşmesini seç" ${selected.has(c.id) ? 'checked' : ''} ${!c.recordingPresent ? 'disabled' : ''}><strong>${esc(voipDate(c.createdAt))}</strong><small>${esc(voipDuration(c.duration))}</small></td><td class="voip-archive-file"><strong>${esc(c.clientName || 'Müvekkil belirtilmedi')}</strong><span>${esc(c.documentNumber || '—')} · ${esc(c.debtorName || '')}</span>${c.note || c.draftNote ? '<details class="voip-archive-notes"><summary>Personel notu</summary><p>' + esc(c.draftNote ?? c.note) + '</p></details>' : ''}${voipTranscriptMarkup(c)}</td><td>${esc(c.staffName || (c.direction === 'inbound' ? 'Cevaplanmadı' : '—'))}${window.testRecordBadge?.(c) || ''}</td><td class="voip-archive-phone">${esc(c.phone ? voipPhone(c.phone) : c.callerNumber || (c.direction === 'inbound' ? 'Gizli numara' : ''))}</td><td>${c.direction === 'inbound' ? '<span class="voip-direction-badge">Gelen</span>' : ''}<span class="voip-status-pill">${esc(c.statusLabel)}</span><small>${esc(c.result || (voipActiveStatuses.has(c.status) ? 'Görüşme sürüyor' : 'Sonuç girilmedi'))}</small>${voipProviderLine(c)}</td><td class="voip-archive-audio"><button class="secondary" type="button" data-voip-listen="${esc(c.id)}" ${!c.canListen ? 'disabled' : ''}>▶ Dinle</button>${!c.recordingPresent ? '<small>Kayıt yok / henüz hazır değil</small>' : !c.archivedAt ? '<small>Arşivden hazırlanacak</small>' : ''}<div data-voip-player></div><div class="voip-entry-feedback" role="status"></div></td></tr>`,
            )
            .join('') +
          '</tbody></table>'
        : '<div class="voip-archive-empty"><strong>Kayıt bulunamadı</strong><p>Arama metnini veya filtreleri değiştirin.</p></div>';
      $('#voipArchiveTotal').textContent = data.total + ' görüşme';
      $('#voipArchiveCount').textContent =
        data.total + ' arama · ' + (data.total ? offset + 1 : 0) + '–' + Math.min(offset + 50, data.total);
      $('#voipArchivePrevious').disabled = !offset;
      $('#voipArchiveNext').disabled = offset + 50 >= data.total;
      bindVoipHistory(host, refresh);
      host.querySelectorAll('[data-select-call]').forEach((input) => {
        input.onchange = () => {
          if (input.checked) selected.add(input.dataset.selectCall);
          else selected.delete(input.dataset.selectCall);
          selectionCount();
        };
      });
      host.querySelectorAll('[data-archive-sort-key]').forEach((button) => {
        button.onclick = () => selectSort(button.dataset.archiveSortKey);
      });
      host
        .querySelector('[data-archive-sort]')
        ?.addEventListener('change', (event) => selectSort(event.target.value));
      host.querySelector('[data-sort-direction]')?.addEventListener('click', () => selectSort(sort));
    } catch (error) {
      if (seq !== request || !host.isConnected) return;
      $('#voipArchiveTotal').textContent = 'Kayıtlar yüklenemedi';
      host.textContent = error.message;
    }
  };
  toolbar.querySelector('[data-select-page]').onclick = () => {
    const ids = currentCalls.filter((c) => c.recordingPresent).map((c) => c.id);
    const all = ids.every((id) => selected.has(id));
    ids.forEach((id) => (all ? selected.delete(id) : selected.add(id)));
    host.querySelectorAll('[data-select-call]').forEach((input) => {
      input.checked = selected.has(input.dataset.selectCall);
    });
    selectionCount();
  };
  toolbar.querySelector('[data-refresh-archive]').onclick = () => refresh();
  toolbar.querySelector('[data-transcribe-bulk]').onclick = async (event) => {
    const feedback = toolbar.querySelector('[data-transcription-feedback]');
    event.target.disabled = true;
    try {
      const mode = toolbar.querySelector('[data-transcription-mode]').value;
      const result = await voipApi('transcriptions', 'POST', {
        mode,
        ids: [...selected],
        filters: appliedFilters,
      });
      feedback.textContent = result.queued
        ? result.queued + ' ses kaydı kuyruğa alındı.'
        : 'İşlenecek yeni ses kaydı bulunamadı.';
      selected.clear();
      selectionCount();
      await refresh();
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      event.target.disabled = false;
    }
  };
  poll = setInterval(() => {
    if (!host.isConnected) {
      clearInterval(poll);
      return;
    }
    if (
      currentCalls.some((c) => ['queued', 'processing'].includes(c.transcription?.status)) &&
      !host.querySelector('details[open]') &&
      ![...host.querySelectorAll('audio')].some((a) => !a.paused)
    )
      refresh();
  }, 5000);
  form.querySelector('[data-clear-archive]').onclick = () => {
    form.reset();
    offset = 0;
    refresh();
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    offset = 0;
    refresh();
  };
  $('#voipArchivePrevious').onclick = () => {
    offset = Math.max(0, offset - 50);
    refresh();
  };
  $('#voipArchiveNext').onclick = () => {
    offset += 50;
    refresh();
  };
  refresh();
}
function openStandaloneVoip(anchor = document.querySelector('[data-standalone-voip]')) {
  // Opens right below the header's "Numara ara" button instead of the bottom-right corner.
  const dock = voipPhoneDock(true, anchor);
  let dialog = document.getElementById('voipStandalone');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'voipStandalone';
    dialog.className = 'voip-standalone';
    dock.prepend(dialog);
  }
  dialog.innerHTML =
    '<div class="panelhead"><div><h2>Numara ile arama</h2><p>Dosyasız arama · Telefon bağlantısı arka planda açılır.</p></div><div class="toolbar"><button type="button" class="link" data-voip-diagnose>Bağlantı testi</button><button type="button" class="secondary" data-close>Kapat</button></div></div><form class="voip-standalone-form" data-ignore-dirty><label class="field">Aranacak telefon numarası<input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="05XX XXX XX XX" required></label><button type="submit" class="primary">Geçmişi kontrol et</button></form><div data-feedback role="alert"></div><div data-voip-trouble hidden></div><div data-preview></div>';
  dialog.querySelector('[data-voip-diagnose]').onclick = () =>
    voipShowDiagnosis(dialog.querySelector('[data-voip-trouble]'), { ask: true });
  dialog.querySelector('[data-close]').onclick = () => {
    dialog.close();
    if (!document.getElementById('voipActiveCall') && !voipUi.startPending && !voipUi.alwaysOn) {
      releaseVoipWebphone();
      const dock = document.getElementById('voipPhoneDock');
      if (dock?.hidePopover) dock.hidePopover();
      if (dock) dock.hidden = true;
    }
  };
  const form = dialog.querySelector('form'),
    feedback = dialog.querySelector('[data-feedback]'),
    preview = dialog.querySelector('[data-preview]');
  form.elements.phone.oninput = () => {
    preview.replaceChildren();
    feedback.textContent = '';
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    feedback.textContent = '';
    preview.replaceChildren();
    const phone = form.elements.phone.value.replace(/[\s()+.\-]/g, '');
    if (!/^(?:90[1-9]\d{9}|0[1-9]\d{9}|[1-9]\d{9})$/.test(phone)) {
      feedback.textContent = 'Geçerli bir Türkiye telefon numarası girin.';
      return;
    }
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const data = await voipApi('calls?phone=' + encodeURIComponent(phone));
      voipUi.results = data.results || [];
      if (!data.enabled || !data.extension)
        throw Error(
          !data.enabled
            ? 'VoIP bağlantısı kapalı. Ayarlar → Entegrasyonlar → VoIP bölümünden etkinleştirin.'
            : 'Kullanıcınıza telefon dahilisi atanmalı.',
        );
      const normalized = phone.length === 10 ? '90' + phone : phone.length === 11 ? '9' + phone : phone;
      const calls = data.calls.filter((c) => c.phone === normalized);
      const last = calls[0];
      const recent =
        last &&
        last.direction !== 'inbound' &&
        Date.now() - Date.parse(last.createdAt) < data.recentMinutes * 60000 &&
        !['unanswered', 'busy', 'failed'].includes(last.status);
      preview.innerHTML =
        '<div class="voip-standalone-history"><strong>Son 5 arama</strong>' +
        (calls.length
          ? calls
              .slice(0, 5)
              .map(
                (c) =>
                  '<div class="voip-recent-call"><span>' +
                  (c.direction === 'inbound' ? '<span class="voip-direction-badge">Gelen</span>' : '') +
                  esc(voipDate(c.createdAt)) +
                  ' · ' +
                  esc(c.staffName || (c.direction === 'inbound' ? 'Cevaplanmadı' : '—')) +
                  ' · ' +
                  esc(voipDuration(c.duration)) +
                  '</span><small>' +
                  esc(c.statusLabel || c.status || '') +
                  (c.result ? ' · ' + esc(c.result) : '') +
                  '</small></div>',
              )
              .join('') +
            '<button type="button" class="link" data-more-phone-history>Ayrıntılı geçmişi gör' +
            (calls.length > 5 ? ' · Devamı' : '') +
            '</button>'
          : '<p>Bu numara için geçmiş arama bulunamadı.</p>') +
        (recent
          ? '<p class="voip-notice">Bu numara yakın zamanda arandı. Tekrar aramadan önce kontrol edin.</p>'
          : '') +
        '</div><button type="button" class="primary" data-dial>' +
        (recent ? 'Kontrol ettim, tekrar ara' : 'Ara') +
        '</button>';
      preview
        .querySelector('[data-more-phone-history]')
        ?.addEventListener('click', () => openVoipHistory({ id: '' }, normalized));
      preview.querySelector('[data-dial]').onclick = async (e) => {
        e.target.disabled = true;
        feedback.textContent = 'Arama başlatılıyor…';
        try {
          const result = await voipStartCancelable(
            {
              phone: normalized,
              confirmRecent: !!recent,
              requestId: crypto.randomUUID(),
            },
            preview,
            (text) => {
              feedback.textContent = text;
            },
            e.target,
          );
          voipUi.returnToDial = () => {
            if (!dialog.isConnected) return;
            e.target.disabled = false;
            feedback.textContent = '';
            voipPhoneDock();
            if (!dialog.open) dialog.show();
          };
          dialog.close();
          voipUi.minimized = false;
          showVoipActive({ id: '', number: 'Dosyasız arama', debtor: '' }, result.call);
        } catch (error) {
          feedback.textContent = error.message;
          e.target.disabled = false;
          if (voipNeedsDiagnosis(error)) voipShowDiagnosis(dialog.querySelector('[data-voip-trouble]'));
        }
      };
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
  voipPhoneDock().classList.remove('voip-dock-minimized');
  openVoipWebphone(feedback);
  if (!dialog.open) dialog.show();
  form.elements.phone.focus();
}
// Staff marked to take inbound calls: the web phone stays registered while the app is open, a
// check-in every few seconds tells the server this person is reachable, and a call ringing on
// their extension shows who is calling. Answering happens in Verimor's web phone window.
function voipInboundSchedule(ms) {
  clearTimeout(voipUi.inboundTimer);
  voipUi.inboundTimer = setTimeout(voipInboundPoll, ms);
}
async function voipInboundPoll() {
  let data;
  try {
    data = await voipApi('incoming');
  } catch {
    return voipInboundSchedule(20000);
  }
  // The page went away while the check-in was in flight.
  if (!globalThis.document?.body) return;
  voipUi.alwaysOn = data.alwaysOn === true;
  if (!voipUi.alwaysOn) {
    voipInboundShow(null);
    return voipInboundSchedule(60000);
  }
  if (data.results?.length && !voipUi.results?.length) voipUi.results = data.results;
  const notice = {
    set textContent(text) {
      voipInboundNotice(text);
    },
  };
  if (!document.getElementById('voipWebphone') && !voipUi.webphoneTokenRequest)
    openVoipWebphone(notice, true);
  if (!voipUi.inboundMicChecked) {
    voipUi.inboundMicChecked = true;
    voipMicrophoneCheck().then((mic) => {
      if (!mic.ok) voipInboundNotice('Gelen aramaları alabilmek için: ' + mic.message, mic.kind !== 'denied');
    });
  }
  voipInboundShow(data.call);
  voipInboundSchedule(document.hidden ? 10000 : 4000);
}
function voipInboundNotice(text, canAsk = false) {
  let note = document.getElementById('voipInboundNotice');
  if (!text) return note?.remove();
  if (!note) {
    note = document.createElement('div');
    note.id = 'voipInboundNotice';
    note.className = 'voip-mic-notice voip-inbound-notice';
    note.setAttribute('role', 'status');
    (document.querySelector('.shell') || document.body).prepend(note);
  }
  note.innerHTML =
    '<span>' +
    esc(text) +
    '</span>' +
    (canAsk ? '<button type="button" class="secondary" data-inbound-mic>Mikrofona izin ver</button>' : '') +
    '<button type="button" class="link" data-inbound-dismiss>Kapat</button>';
  note.querySelector('[data-inbound-dismiss]').onclick = () => note.remove();
  note.querySelector('[data-inbound-mic]')?.addEventListener('click', async () => {
    const mic = await voipMicrophoneCheck({ ask: true });
    if (mic.ok) note.remove();
    else note.querySelector('span').textContent = 'Gelen aramaları alabilmek için: ' + mic.message;
  });
}
// Verimor's web phone is normally kept hidden (the app has its own call controls), but an inbound
// call can only be answered with the green button inside it. While a call rings it is shown on top
// as a modal, so it stays clickable even when a borrower file (itself modal) is open.
function voipWebphoneAnswering(on) {
  const phone = document.getElementById('voipWebphone');
  const dock = document.getElementById('voipPhoneDock');
  if (!phone) return;
  if (on) {
    phone.dataset.answering = 'true';
    phone.classList.add('voip-answering');
    phone.style.visibility = 'visible';
    dock?.classList.add('voip-dock-answering');
    dock?.classList.remove('voip-dock-minimized');
    if (phone.dataset.modal !== 'true' && typeof phone.showModal === 'function') {
      if (phone.open) phone.close();
      phone.showModal();
      phone.dataset.modal = 'true';
    }
    return;
  }
  if (!phone.dataset.answering) return;
  delete phone.dataset.answering;
  phone.classList.remove('voip-answering');
  dock?.classList.remove('voip-dock-answering');
  if (phone.dataset.modal === 'true') {
    delete phone.dataset.modal;
    phone.close();
    phone.show();
  }
}
// Re-showing a popover puts it last in the top layer, i.e. above every dialog opened since.
function voipInboundRaise() {
  const strip = document.getElementById('voipIncoming');
  if (!strip || typeof strip.showPopover !== 'function') return;
  try {
    if (strip.matches(':popover-open')) strip.hidePopover();
    strip.showPopover();
  } catch {
    /* an unsupported browser keeps it as a plain banner */
  }
}
function voipInboundShow(call) {
  let strip = document.getElementById('voipIncoming');
  if (call?.status === 'answered') {
    strip?.remove();
    voipWebphoneAnswering(false);
    if (voipUi.activeId !== call.id) {
      voipUi.minimized = false;
      showVoipActive(
        { id: call.documentId, number: call.documentNumber || 'Gelen arama', debtor: call.debtorName || '' },
        call,
      );
    }
    return;
  }
  if (call?.status !== 'ringing') {
    strip?.remove();
    voipWebphoneAnswering(false);
    // The phone window was brought up for the ringing call; tuck it away again.
    if (voipUi.inboundRevealed && !document.getElementById('voipActiveCall')) {
      voipUi.inboundRevealed = false;
      const dock = document.getElementById('voipPhoneDock');
      if (dock?.hidePopover) dock.hidePopover();
      if (dock) dock.hidden = true;
    }
    return;
  }
  if (strip?.dataset.callId === call.id) return voipInboundRaise();
  strip?.remove();
  strip = document.createElement('div');
  strip.id = 'voipIncoming';
  strip.className = 'voip-incoming';
  strip.setAttribute('popover', 'manual');
  strip.dataset.callId = call.id;
  strip.setAttribute('role', 'alert');
  const who = call.debtorName || (call.phone ? voipPhone(call.phone) : call.callerNumber || 'Gizli numara');
  const detail = [
    call.debtorName && call.phone ? voipPhone(call.phone) : '',
    call.documentNumber ? 'Föy ' + call.documentNumber : '',
    call.clientName || '',
    call.ownerName ? 'Son arayan: ' + call.ownerName : '',
  ].filter(Boolean);
  strip.innerHTML =
    '<span class="voip-incoming-pulse" aria-hidden="true">☎</span><div><strong>Gelen arama: ' +
    esc(who) +
    '</strong><small>' +
    esc(detail.join(' · ') || 'Kayıtlı bir föyle eşleşmedi') +
    '</small><small>Açmak için sağ alttaki telefonda yeşil düğmeye basın.</small></div><button type="button" class="primary" data-incoming-open>Telefonu göster</button>';
  const showPhone = () =>
    openVoipWebphone({
      set textContent(text) {
        voipInboundNotice(text);
      },
    }).then(() => {
      if (document.getElementById('voipIncoming')?.dataset.callId !== call.id) return;
      voipWebphoneAnswering(true);
      voipInboundRaise();
    });
  strip.querySelector('[data-incoming-open]').onclick = showPhone;
  document.body.append(strip);
  voipInboundRaise();
  // Answering is done in Verimor's own web phone window, so bring it up.
  voipUi.inboundRevealed = true;
  voipPhoneDock().classList.remove('voip-dock-minimized');
  showPhone();
}
function setupVoipNavigation() {
  document.querySelector('[data-global-webphone]')?.remove();
  if (!document.querySelector('[data-standalone-voip]') && !hanAuth.readOnly) {
    const dial = document.createElement('button');
    dial.type = 'button';
    dial.className = 'secondary';
    dial.dataset.standaloneVoip = '';
    dial.textContent = '☎ Numara ara';
    dial.onclick = (event) => openStandaloneVoip(event.currentTarget);
    document.querySelector('.header-actions')?.prepend(dial);
    voipApi('calls')
      .then((data) => {
        if (voipUi.activeId || !data.active?.length) return;
        voipUi.results = data.results || [];
        const call = data.active[0];
        showVoipActive(
          { id: call.documentId, number: call.documentNumber || 'Dosyasız arama', debtor: call.debtorName },
          call,
        );
      })
      .catch(() => {});
  }
  if (!voipUi.inboundStarted && !hanAuth.readOnly) {
    voipUi.inboundStarted = true;
    voipInboundPoll();
  }
  if (!['ceo', 'admin'].includes(hanAuth.role) || document.querySelector('[data-page="callRecordings"]'))
    return;
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.page = 'callRecordings';
  button.textContent = '☎  Görüşme Kayıtları';
  button.onclick = () => {
    page = 'callRecordings';
    render();
  };
  document.querySelector('aside nav').append(button);
}
