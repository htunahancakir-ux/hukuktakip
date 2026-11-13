const settingsDefaults = {
  firm: {
    name: 'Hukuk Bürosu',
    legalName: '',
    taxOffice: '',
    taxNumber: '',
    registration: '',
    authorized: '',
  },
  contact: { phone: '', email: '', website: '', city: '', district: '', address: '' },
  preferences: { receiver: '', prefix: 'EVR', showContact: true },
};
let storedConfig;
try {
  storedConfig = JSON.parse(localStorage.getItem('icrapro-settings-v1'));
} catch {}
let config = Object.fromEntries(
  Object.entries(settingsDefaults).map(([k, v]) => [k, { ...v, ...storedConfig?.[k] }]),
);
let settingsTab = 'firm',
  settingsDraft = null;
function applySettings() {
  document
    .querySelectorAll('.workspace b')
    .forEach((e) => (e.textContent = config.firm.name || 'Hukuk Bürosu'));
  document.querySelector('.avatar').textContent = (config.firm.name || 'HB')
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toLocaleUpperCase('tr');
}

function refreshBackupIndicator() {
  const indicator = document.getElementById('backupIndicator');
  const assurance = document.getElementById('backupAssurance');
  if (!indicator || !assurance || !window.hanAuth) return;
  try {
    const status = authApi('/api/backup-indicator');
    const date = backupDate(status.lastSuccessAt);
    if (status.protected) {
      indicator.textContent = `Son yedek: ${date} · Veriler güvende`;
      indicator.dataset.state = 'safe';
      assurance.textContent =
        '◈ Verileriniz ana sistemde ve şifreli yedek kopyasında iki ayrı güvenli konumda korunur.';
      return;
    }
    indicator.textContent = status.lastSuccessAt
      ? `Son yedek: ${date} · Yedekleme kontrolü gerekiyor`
      : 'Henüz doğrulanmış yedek bulunmuyor';
    indicator.dataset.state = 'attention';
    assurance.textContent = '◈ Yedekleme durumu henüz doğrulanmadı.';
  } catch {
    indicator.textContent = 'Yedekleme durumu doğrulanamadı';
    indicator.dataset.state = 'attention';
    assurance.textContent = '◈ Yedekleme durumu henüz doğrulanmadı.';
  }
}
function firmReceipt() {
  return `<div style="border-bottom:1px solid #ddd;padding-bottom:15px;margin-bottom:20px"><b>${esc(config.firm.legalName || config.firm.name)}</b>${config.preferences.showContact ? `<div style="font-size:12px">${[config.contact.address, [config.contact.district, config.contact.city].filter(Boolean).join(' / '), config.contact.phone, config.contact.email].filter(Boolean).map(esc).join('<br>')}</div>` : ''}</div>`;
}
function settings() {
  if (settingsTab === 'staff') return personnelSettings();
  if (!settingsDraft) settingsDraft = structuredClone(config);
  const tabs = {
    firm: ['Firma Bilgileri', 'Firma kimliği ve yetkili bilgileri'],
    contact: ['İletişim ve Adres', 'Firmanızın iletişim kanalları'],
    preferences: ['Uygulama Tercihleri', 'Evrak kabul ve tutanak tercihleri'],
  };
  const v = settingsDraft[settingsTab];
  let fields = '';
  if (settingsTab === 'firm')
    fields = `${field('Firma / Büro Adı', 'name', 'text', v.name, true, true)}${field('Ticari Unvan', 'legalName', 'text', v.legalName, false, true)}${field('Vergi Dairesi', 'taxOffice', 'text', v.taxOffice)}<label class="field">Vergi / TC Kimlik Numarası<input name="taxNumber" value="${esc(v.taxNumber)}" inputmode="numeric" pattern="[0-9]{10,11}" title="10 veya 11 rakam girin"></label>${field('Sicil / Baro Numarası', 'registration', 'text', v.registration)}${field('Firma Yetkilisi', 'authorized', 'text', v.authorized)}${loginArtSetting()}`;
  else if (settingsTab === 'contact')
    fields = `${field('Telefon', 'phone', 'tel', v.phone)}${field('E-posta', 'email', 'email', v.email)}${field('Web Sitesi', 'website', 'url', v.website, false, true)}${field('İl', 'city', 'text', v.city)}${field('İlçe', 'district', 'text', v.district)}<label class="field full">Açık Adres<textarea name="address" rows="4">${esc(v.address)}</textarea></label>`;
  else
    fields = `${field('Varsayılan Teslim Alan', 'receiver', 'text', v.receiver, false, true)}<label class="field full">Evrak Numarası Ön Eki<input name="prefix" value="${esc(v.prefix)}" required maxlength="12" pattern="[A-Za-z0-9ÇĞİÖŞÜçğıöşü-]+" title="Harf, rakam ve tire kullanın"><small>Yeni kayıt örneği: ${esc(v.prefix || 'EVR')}-0001. Mevcut evrak numaraları korunur.</small></label><label class="settings-check full"><input type="checkbox" name="showContact" ${v.showContact ? 'checked' : ''}> Firma iletişim bilgilerini teslim tutanağında göster</label>`;
  $('#content').innerHTML =
    `${settingsSectionTabs(settingsTab)}<form class="panel" id="settingsForm"><section role="tabpanel" id="settingsPanel" aria-labelledby="tab-${settingsTab}"><div class="panelhead"><div><h2>${tabs[settingsTab][0]}</h2><p>${tabs[settingsTab][1]}</p></div><span class="badge" id="saveState">Kaydedildi</span></div><div class="formbody"><div class="notice">Firma adı menüde ve teslim tutanaklarında kullanılır. Ayarlar bu tarayıcıda saklanır.</div><div class="grid">${fields}</div></div></section><div class="actions"><button type="button" class="secondary" id="discardSettings">Değişiklikleri Geri Al</button><button type="submit" class="primary">Ayarları Kaydet</button></div></form>`;
  const form = $('#settingsForm');
  bindLoginArtSetting();
  function capture() {
    const data = Object.fromEntries(new FormData(form));
    if (settingsTab === 'preferences') data.showContact = form.elements.showContact.checked;
    settingsDraft[settingsTab] = { ...settingsDraft[settingsTab], ...data };
    $('#saveState').textContent =
      JSON.stringify(settingsDraft) === JSON.stringify(config) ? 'Kaydedildi' : 'Kaydedilmemiş değişiklikler';
  }
  form.oninput = capture;
  capture();
  document.querySelectorAll('[data-settings-tab]').forEach(
    (b) =>
      (b.onclick = () => {
        capture();
        settingsTab = b.dataset.settingsTab;
        settings();
      }),
  );
  $('#discardSettings').onclick = () => {
    settingsDraft = structuredClone(config);
    settings();
    toast('Kaydedilmiş ayarlara dönüldü.');
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    capture();
    if (!validateSettingsDraft()) return;
    settingsDraft.firm.name = settingsDraft.firm.name.trim();
    if (!settingsDraft.firm.name) {
      settingsTab = 'firm';
      settings();
      return toast('Firma / büro adını girin.');
    }
    const prefix = settingsDraft.preferences.prefix.trim();
    if (!/^[A-Za-z0-9ÇĞİÖŞÜçğıöşü-]{1,12}$/.test(prefix)) {
      settingsTab = 'preferences';
      settings();
      return toast('Geçerli bir evrak ön eki girin.');
    }
    settingsDraft.preferences.prefix = prefix;
    try {
      localStorage.setItem('icrapro-settings-v1', JSON.stringify(settingsDraft));
    } catch {
      return toast('Ayarlar kaydedilemedi. Tarayıcı depolama alanını kontrol edin.');
    }
    config = structuredClone(settingsDraft);
    applySettings();
    settings();
    toast('Tüm ayarlar kaydedildi.');
  };
}

// The login screen's picture (lib/office-images.cjs). It is saved on its own, not with the
// settings form, and the file input has no name so the form never picks it up.
function loginArtSetting() {
  if (!['ceo', 'admin'].includes(hanAuth.role) || (hanAuth.role !== 'ceo' && hanAuth.readOnly)) return '';
  return `<div class="full login-art-setting"><div class="login-art-mini" aria-hidden="true"><img id="loginArtPreview" alt=""><div class="lte-shade"></div><div class="login-art-mini-texts"></div></div><div><b>Giriş Ekranı</b><p>Giriş sayfasının sol tarafındaki görsel ve üzerindeki yazılar. Görsel JPG, PNG veya WebP olabilir; yatay ya da kare, en az 1200 piksel genişliğinde bir görsel önerilir ve yüklenince kendiliğinden küçültülür. Yazıları düzenleyicide tutup taşıyabilir, büyütüp küçültebilir, yeni yazı ekleyebilirsiniz.</p><div class="login-art-actions"><input type="file" id="loginArtFile" accept="image/jpeg,image/png,image/webp" hidden><button type="button" class="secondary" id="loginArtChoose">Görsel Seç</button><button type="button" class="secondary" id="loginTextsEdit" disabled>Yazıları Düzenle</button><button type="button" class="link" id="loginArtReset" hidden>Varsayılan Görsele Dön</button></div><small id="loginArtState" role="status"></small><small id="loginTextsState"></small></div></div>`;
}

// Longest side 1800 px, WebP (JPEG where the browser cannot write WebP).
async function shrinkLoginArt(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw Error('Görsel açılamadı. JPG, PNG veya WebP biçiminde başka bir görsel seçin.');
  }
  try {
    if (bitmap.width < 800 || bitmap.height < 500)
      throw Error('Görsel çok küçük. En az 800 × 500 piksel bir görsel seçin.');
    const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const encode = (type) => new Promise((resolve) => canvas.toBlob(resolve, type, 0.86));
    let blob = await encode('image/webp');
    if (!blob || blob.type !== 'image/webp') blob = await encode('image/jpeg');
    if (!blob) throw Error('Görsel hazırlanamadı. Başka bir görsel seçin.');
    return blob;
  } finally {
    bitmap.close();
  }
}

function bindLoginArtSetting() {
  const box = document.querySelector('.login-art-setting');
  if (!box) return;
  const preview = box.querySelector('#loginArtPreview'),
    file = box.querySelector('#loginArtFile'),
    choose = box.querySelector('#loginArtChoose'),
    reset = box.querySelector('#loginArtReset'),
    state = box.querySelector('#loginArtState'),
    edit = box.querySelector('#loginTextsEdit'),
    textsState = box.querySelector('#loginTextsState'),
    miniTexts = box.querySelector('.login-art-mini-texts');
  let artDigest = null,
    texts = null;
  // The small preview shows the picture with the texts as the login screen places them.
  const drawTexts = () => {
    loginTextLayer(texts || LOGIN_TEXT_DEFAULTS, miniTexts);
    textsState.textContent = texts
      ? `Büroya özel yazılar (${texts.length} yazı).`
      : 'Varsayılan yazılar kullanılıyor.';
  };
  fetch('/api/login-texts', { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : Promise.reject()))
    .then((data) => {
      texts = Array.isArray(data.texts) ? data.texts : null;
      drawTexts();
      edit.disabled = false;
    })
    .catch(() => {
      drawTexts();
      textsState.textContent = 'Yazılar alınamadı. Sayfayı yenileyip tekrar deneyin.';
    });
  edit.onclick = () =>
    openLoginTextsEditor({
      saved: texts,
      artVersion: artDigest,
      onSaved: (next) => {
        texts = next;
        drawTexts();
      },
    });
  const show = (status) => {
    artDigest = status.digest || null;
    preview.src = '/api/login-art?v=' + encodeURIComponent(status.digest || 'varsayilan');
    reset.hidden = !status.custom;
    state.textContent = status.custom
      ? `Büroya özel görsel${status.updatedBy ? ' · ' + status.updatedBy : ''}${status.updatedAt ? ' · ' + displayDate(status.updatedAt.slice(0, 10)) : ''}`
      : 'Varsayılan terazi görseli kullanılıyor.';
  };
  const request = async (method, body) => {
    const response = await fetch(method === 'GET' ? '/api/login-art/status' : '/api/login-art', {
      method,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(result.error || 'Giriş ekranı görseli kaydedilemedi.');
    return result;
  };
  const busy = (on, text) => {
    choose.disabled = reset.disabled = on;
    if (text) state.textContent = text;
  };
  request('GET')
    .then(show)
    .catch(() => show({ custom: false }));
  choose.onclick = () => file.click();
  file.onchange = async () => {
    const picked = file.files[0];
    file.value = '';
    if (!picked) return;
    busy(true, 'Görsel hazırlanıyor…');
    try {
      const blob = await shrinkLoginArt(picked);
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
        reader.onerror = () => reject(Error('Görsel okunamadı. Başka bir dosya deneyin.'));
        reader.readAsDataURL(blob);
      });
      busy(true, 'Yükleniyor…');
      await request('PUT', { data });
      show(await request('GET'));
      toast('Giriş ekranı görseli güncellendi.');
    } catch (error) {
      toast(error.message || 'Giriş ekranı görseli kaydedilemedi.');
      request('GET')
        .then(show)
        .catch(() => {});
    } finally {
      busy(false);
    }
  };
  reset.onclick = async () => {
    if (!confirm('Giriş ekranında varsayılan terazi görseli kullanılsın mı?')) return;
    busy(true, 'Varsayılana dönülüyor…');
    try {
      await request('DELETE');
      show({ custom: false });
      toast('Büroya özel görsel kaldırıldı; giriş ekranında varsayılan görsel kullanılacak.');
    } catch (error) {
      toast(error.message);
    } finally {
      busy(false);
    }
  };
}

function backupDate(value, precise = false) {
  return value
    ? new Intl.DateTimeFormat('tr-TR', {
        timeZone: 'Europe/Istanbul',
        dateStyle: 'medium',
        timeStyle: precise ? 'medium' : 'short',
      }).format(new Date(value))
    : 'Henüz yok';
}

function backupFileSize(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const [amount, unit] = bytes >= 1048576 ? [bytes / 1048576, 'MB'] : [bytes / 1024, 'KB'];
  return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }).format(amount) + ' ' + unit;
}

function backupLastDownload(download) {
  if (!download) return 'Henüz indirme kaydı yok.';
  return `<b>Dosya:</b> <span style="overflow-wrap:anywhere">${esc(download.filename)}</span><br>
    <b>Yedek tarihi:</b> ${backupDate(download.backupAt)}<br>
    <b>İndirme zamanı:</b> ${backupDate(download.downloadedAt, true)}<br>
    <b>İndiren:</b> ${esc(download.name)} (${esc(download.username)})`;
}

function bindBackupFiles(lastDownload) {
  const panel = $('#backupFiles');
  if (!panel) return;
  const month = panel.querySelector('#backupMonth');
  const result = panel.querySelector('#backupFileList');
  const summary = panel.querySelector('#lastBackupDownload');
  let latestRequest = 0;
  let followDownload = 0;
  async function refreshSummary() {
    try {
      const response = await fetch('/api/backups', { cache: 'no-store' });
      if (!response.ok || !panel.isConnected) return;
      const { lastDownload: current } = await response.json();
      if (current && (!lastDownload || current.downloadedAt >= lastDownload.downloadedAt)) {
        lastDownload = current;
        const markup = backupLastDownload(current);
        if (summary.innerHTML !== markup) summary.innerHTML = markup;
      }
    } catch {
      /* Keep the last confirmed record visible if the refresh fails. */
    }
  }
  async function refresh() {
    const request = ++latestRequest;
    if (!month.value) {
      result.textContent = 'Yedekleri görmek için bir ay seçin.';
      return;
    }
    result.textContent = 'Yedekler yükleniyor…';
    try {
      const response = await fetch('/api/backups/files?month=' + encodeURIComponent(month.value), {
        cache: 'no-store',
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Yedekler listelenemedi.');
      if (request !== latestRequest || !panel.isConnected) return;
      if (!data.backups.length) {
        result.textContent = 'Bu ay için yedek bulunamadı.';
        return;
      }
      result.innerHTML = `<div class="overflow"><table><thead><tr><th>Yedek tarihi</th><th>Boyut</th><th>Dosya</th></tr></thead><tbody>${data.backups
        .map(
          (backup) =>
            `<tr><td>${backupDate(backup.createdAt)}</td><td>${backupFileSize(backup.size)}</td><td><a class="link" href="/api/backups/download?key=${encodeURIComponent(backup.key)}" aria-label="${esc(backupDate(backup.createdAt))} tarihli yedeği indir">İndir (.hnb)</a></td></tr>`,
        )
        .join('')}</tbody></table></div>`;
    } catch (error) {
      if (request === latestRequest && panel.isConnected)
        result.textContent = error.message || 'Yedekler listelenemedi.';
    }
  }
  month.onchange = refresh;
  panel.querySelector('#refreshBackupFiles').onclick = () => {
    refresh();
    refreshSummary();
  };
  result.addEventListener('click', (event) => {
    if (!event.target.closest('a[href]')) return;
    const request = ++followDownload;
    const previous = lastDownload?.downloadedAt;
    const delays = [1500, 3500, 7000, 15000];
    const check = () => {
      const delay = delays.shift();
      if (!delay || !panel.isConnected || request !== followDownload) return;
      setTimeout(async () => {
        if (!panel.isConnected || request !== followDownload) return;
        await refreshSummary();
        if (lastDownload?.downloadedAt === previous) check();
      }, delay);
    };
    check();
  });
  refresh();
}

// Add-on modules this office was sold. Anything not listed in `hanModules` stays visible
// (the answer may not have arrived yet; the server enforces the real rule).
const INTEGRATION_MODULE = {
  ai: 'ai-assistant',
  voip: 'voip',
  permissions: 'voip',
  whatsapp: 'whatsapp',
  // Either product opens Rota Bulma: the module (own map keys) or the map service subscription.
  maps: ['marketing-routes', 'marketing-routes-service'],
};
function integrationAvailable(id) {
  const codes = [INTEGRATION_MODULE[id]].flat().filter(Boolean);
  return !codes.length || codes.some((code) => globalThis.hanModules?.[code] !== false);
}
function firstIntegrationTab() {
  if (hanAuth.role !== 'ceo') return integrationAvailable('permissions') ? 'permissions' : 'firm';
  return ['voip', 'whatsapp', 'ai', 'sms', 'maps', 'iyzico'].find(integrationAvailable) || 'iyzico';
}

// VoIP has two pages: the connection settings (CEO only) and "Dahililer ve yetkiler" (phone
// extensions and recording access, CEO and admins). Admins see only the second one under
// Entegrasyonlar → VoIP.
function settingsSectionTabs(active) {
  const ceo = hanAuth.role === 'ceo';
  const manager = ['ceo', 'admin'].includes(hanAuth.role);
  const integration = ['ai', 'voip', 'whatsapp', 'sms', 'maps', 'iyzico', 'permissions'].includes(active);
  const voipPage = ['voip', 'permissions'].includes(active);
  const tabs = [
    ['firm', 'Firma Bilgileri'],
    ['contact', 'İletişim ve Adres'],
    ['preferences', 'Uygulama Tercihleri'],
    ['staff', 'Personel'],
    ['audit', 'İşlem Kayıtları'],
    ['employeeTerms', 'Gizlilik Sözleşmesi'],
    ...(ceo || (manager && integrationAvailable('permissions')) ? [['integrations', 'Entegrasyonlar']] : []),
    ...(manager && globalThis.hanModules?.['supportDesk'] === true ? [['support', 'Destek']] : []),
    ...(manager && globalThis.hanModules?.['catalog'] === true ? [['modules', 'Modüller']] : []),
    ['backup', 'Yedekleme'],
  ];
  const integrationTabs = (
    ceo
      ? [
          ['ai', 'Yapay Zekâ'],
          ['voip', 'VoIP / Telefon'],
          ['whatsapp', 'WhatsApp Business'],
          ['sms', 'SMS (Verimor)'],
          ['maps', 'Google Haritalar'],
          ['iyzico', 'iyzico Ödeme'],
        ]
      : [['permissions', 'VoIP / Telefon']]
  ).filter(([id]) => integrationAvailable(id));
  const voipTabs = ceo
    ? [
        ['voip', 'Bağlantı ayarları'],
        ['permissions', 'Dahililer ve yetkiler'],
      ]
    : [['permissions', 'Dahililer ve yetkiler']];
  return `<div class="settings-tabs" role="tablist" aria-label="Ayar sekmeleri">${tabs
    .map(
      ([key, label]) =>
        `<button type="button" id="tab-${key}" role="tab" aria-selected="${key === active || (integration && key === 'integrations')}" data-settings-tab="${key}" class="${key === active || (integration && key === 'integrations') ? 'selected' : ''}">${esc(label)}</button>`,
    )
    .join('')}</div>${
    integration
      ? `<div class="settings-tabs integration-tabs" role="tablist" aria-label="Entegrasyonlar">${integrationTabs
          .map(([id, label]) => {
            const selected = id === active || (voipPage && ['voip', 'permissions'].includes(id));
            return `<button type="button" id="tab-${id}" role="tab" aria-selected="${selected}" data-settings-tab="${id}" class="${selected ? 'selected' : ''}">${label}</button>`;
          })
          .join('')}</div>${
          voipPage
            ? `<div class="settings-tabs integration-tabs voip-tabs" role="tablist" aria-label="VoIP / Telefon">${voipTabs
                .map(
                  ([id, label]) =>
                    `<button type="button" id="tab-voip-${id}" role="tab" aria-selected="${id === active}" data-settings-tab="${id}" class="${id === active ? 'selected' : ''}">${label}</button>`,
                )
                .join('')}</div>`
            : ''
        }`
      : ''
  }`;
}

function bindSettingsSectionTabs() {
  document.querySelectorAll('[data-settings-tab]').forEach(
    (button) =>
      (button.onclick = () => {
        settingsTab = button.dataset.settingsTab;
        settings();
      }),
  );
}

// Yedekleme sıklığı: daily at chosen hours, weekly on a chosen day (no hour asked), or every
// 30 days. Times are Istanbul time.
const BACKUP_WEEKDAYS = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
function backupScheduleFields(schedule = { type: 'interval', days: 1 }) {
  const type =
    schedule.type === 'interval'
      ? schedule.days === 7
        ? 'weekly'
        : schedule.days === 30
          ? 'monthly'
          : 'daily'
      : schedule.type;
  const times = schedule.type === 'daily' ? schedule.times : ['03:00'];
  const weekday = schedule.type === 'weekly' ? schedule.weekday : 1;
  return `<div class="field full backup-schedule"><span>Yedekleme sıklığı</span>
    <select name="frequency" aria-label="Yedekleme sıklığı">
      <option value="daily" ${type === 'daily' ? 'selected' : ''}>Günlük — belirlediğim saatlerde</option>
      <option value="weekly" ${type === 'weekly' ? 'selected' : ''}>Haftalık — belirlediğim günde</option>
      <option value="monthly" ${type === 'monthly' ? 'selected' : ''}>Her 30 günde bir</option>
    </select>
    <div data-backup-daily><span>Saatler</span><div class="backup-times">${times
      .map((t) => backupTimeField(t))
      .join('')}</div><button type="button" class="link" data-backup-add-time>＋ Saat ekle</button>
      <small>Günde en fazla 6 saat, aralarında en az 1 saat olmalı.</small></div>
    <label data-backup-weekly>Gün<select name="weekday">${BACKUP_WEEKDAYS.map(
      (day, i) => `<option value="${i + 1}" ${weekday === i + 1 ? 'selected' : ''}>${day}</option>`,
    ).join('')}</select><small>O gün içinde alınır; saat seçmeniz gerekmez.</small></label>
    <small>Saatler Türkiye saatidir. Bulutta yedek zamanı uygulama kullanılırken birkaç dakikada bir ve her sabah 06.00 civarında kontrol edilir; seçilen saat gelince ilk kontrolde alınır. Kimsenin uygulamayı kullanmadığı gece saatlerinin yedeği sabah 06.00 civarında alınır.</small>
  </div>`;
}
function backupTimeField(value) {
  return `<span class="backup-time"><input type="time" name="backupTime" value="${esc(value)}" required aria-label="Yedek saati"><button type="button" class="link" data-backup-remove-time aria-label="Saati kaldır">✕</button></span>`;
}
function bindBackupSchedule(form) {
  const show = () => {
    const kind = form.elements.frequency.value;
    form.querySelector('[data-backup-daily]').hidden = kind !== 'daily';
    form.querySelector('[data-backup-weekly]').hidden = kind !== 'weekly';
    form.querySelectorAll('[name="backupTime"]').forEach((input) => (input.disabled = kind !== 'daily'));
    const removable = form.querySelectorAll('[data-backup-remove-time]');
    removable.forEach((button) => (button.hidden = removable.length < 2));
    form.querySelector('[data-backup-add-time]').hidden = removable.length >= 6;
  };
  const wire = () =>
    form.querySelectorAll('[data-backup-remove-time]').forEach(
      (button) =>
        (button.onclick = () => {
          button.closest('.backup-time').remove();
          show();
        }),
    );
  form.elements.frequency.onchange = show;
  form.querySelector('[data-backup-add-time]').onclick = () => {
    // Suggest an hour that is not in the list yet: an hour after the last one.
    const taken = [...form.querySelectorAll('[name="backupTime"]')].map((input) => input.value);
    let minutes = taken.length
      ? (Number(taken.at(-1).slice(0, 2)) * 60 + Number(taken.at(-1).slice(3, 5)) + 60) % 1440
      : 540;
    const label = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    for (let i = 0; i < 24 && taken.includes(label(minutes)); i++) minutes = (minutes + 60) % 1440;
    form.querySelector('.backup-times').insertAdjacentHTML('beforeend', backupTimeField(label(minutes)));
    wire();
    show();
  };
  wire();
  show();
}
function readBackupSchedule(form) {
  const kind = form.elements.frequency.value;
  if (kind === 'weekly') return { type: 'weekly', weekday: Number(form.elements.weekday.value) };
  if (kind === 'monthly') return { type: 'interval', days: 30 };
  const times = [...form.querySelectorAll('[name="backupTime"]')].map((input) => input.value).filter(Boolean);
  if (!times.length) throw Error('En az bir yedek saati girin.');
  if (new Set(times).size !== times.length) throw Error('Aynı saat iki kez girilmiş.');
  return { type: 'daily', times };
}
function backupSettingsPage() {
  let status;
  try {
    status = authApi('/api/backups');
  } catch (error) {
    $('#content').textContent = error.message;
    return;
  }
  const latestMonth = (status.lastObjectKey?.split('/').at(-1) || new Date().toISOString()).slice(0, 7);
  $('#content').innerHTML = `${settingsSectionTabs('backup')}
    <div class="panel"><div class="panelhead"><div><h2>Yedekleme</h2><p>Uygulama verilerinin şifreli kopyasını Cloudflare R2'ye kaydedin.</p></div></div>
    <div class="formbody"><form id="backupSettingsForm" class="grid">
      <label class="settings-check full"><input name="enabled" type="checkbox" ${status.enabled ? 'checked' : ''}> Otomatik yedeklemeyi aç</label>
      ${backupScheduleFields(status.schedule)}
      <div class="full"><p><b>Cloudflare R2:</b> ${status.r2Configured && status.encryptionConfigured ? 'Bağlantı ayarları hazır' : 'Erişim ve şifreleme anahtarları bekleniyor'} · <b>Kova:</b> ${esc(status.bucket)}</p>
      <p><b>Son başarılı yedek:</b> ${backupDate(status.lastSuccessAt)} · <b>Son R2 kopyası:</b> ${backupDate(status.lastR2At)}</p>
      ${!status.scheduleConfigured ? '<p role="alert">Bulut zamanlayıcısı henüz yapılandırılmadı.</p>' : ''}
      ${status.localAvailable ? `<p><b>Son yerel kopya:</b> ${backupDate(status.lastLocalAt)}</p>` : ''}
      <p><b>Sonraki yedek:</b> ${status.enabled ? (status.nextDueAt ? backupDate(status.nextDueAt) : 'İlk zamanlı kontrolde') : 'Otomatik yedekleme kapalı'}</p>
      ${status.lastError ? `<p role="alert">${esc(status.lastError)}</p>` : ''}
      <small>Yerel sürümde aynı şifreli dosya bilgisayarın yedek klasörüne de kaydedilir. Vercel'de kalıcı kopya R2'de tutulur. Yedekler kullanıcı ve parola kayıtlarını içerir; şifreleme anahtarını güvenli yerde saklayın.</small></div>
      <div class="actions full"><button class="primary" type="submit">Yedekleme Ayarlarını Kaydet</button><button class="secondary" type="button" id="backupNow">Şimdi Yedekle</button></div>
    </form></div></div>
    <section class="panel" id="backupFiles" style="margin-top:18px">
      <div class="panelhead"><div><h2>Yedek Dosyaları</h2><p>Şifreli yedeği bilgisayarınıza indirin.</p></div></div>
      <div class="formbody"><div class="toolbar">
        <label class="field">Yedek ayı (UTC)<input id="backupMonth" type="month" placeholder="YYYY-AA" value="${esc(latestMonth)}"></label>
        <button type="button" class="secondary" id="refreshBackupFiles">Listeyi Yenile</button>
      </div><div id="backupFileList" aria-live="polite"></div>
      <h3>Son indirilen yedek</h3>
      <p id="lastBackupDownload" aria-live="polite">${backupLastDownload(status.lastDownload)}</p>
      ${
        hanAuth.role === 'ceo'
          ? `<details><summary>İndirilen dosya nasıl geri yüklenir?</summary>
        <p>Proje klasöründeki terminalde aşağıdaki komutu çalıştırın. YEDEK.hnb yerine indirilen dosyanın yolunu yazın.</p>
        <p><code>npm run backup:restore -- "YEDEK.hnb" --local "work/kurtarma/hanhukuk-state.json"</code></p>
        <p>Yedeğin şifreleme anahtarı ve yedek tarihindeki etkin CEO hesabı gerekir. Bu komut yeni bir yerel dosya oluşturur.</p>
      </details>`
          : ''
      }</div>
    </section>`;
  bindSettingsSectionTabs();
  bindBackupSchedule($('#backupSettingsForm'));
  bindBackupFiles(status.lastDownload);
  $('#backupSettingsForm').onsubmit = (event) => {
    event.preventDefault();
    try {
      const form = event.target;
      authApi('/api/backups', 'PUT', {
        enabled: form.elements.enabled.checked,
        schedule: readBackupSchedule(form),
      });
      refreshBackupIndicator();
      settings();
      toast('Yedekleme ayarları kaydedildi.');
    } catch (error) {
      toast(error.message);
    }
  };
  $('#backupNow').onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Yedekleniyor…';
    try {
      const response = await fetch('/api/backups/run', {
        method: 'POST',
        headers: { 'X-Han-Request': '1' },
        credentials: 'same-origin',
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || 'Yedekleme başarısız.');
      refreshBackupIndicator();
      settings();
      toast(result.ok ? 'Şifreli yedek Cloudflare R2’ye kaydedildi.' : result.skipped);
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Şimdi Yedekle';
      toast(error.message);
    }
  };
}

const originalSettings = settings;
let settingsRenderId = 0;
settings = async function () {
  const renderId = ++settingsRenderId;
  // Admins have only the VoIP extensions and recording access page under Entegrasyonlar.
  if (['integrations', 'voip'].includes(settingsTab) && hanAuth.role !== 'ceo') settingsTab = 'permissions';
  const requestedTab = settingsTab;
  const pinScope = ['integrations', 'voip', 'ai', 'whatsapp', 'sms', 'maps', 'iyzico'].includes(settingsTab)
    ? 'integrations'
    : settingsTab === 'permissions'
      ? 'permissions'
      : null;
  if (pinScope && typeof requireCeoPin === 'function') {
    $('#content').textContent = 'Güvenlik doğrulaması bekleniyor…';
    if (!(await requireCeoPin(pinScope))) return;
    if (renderId !== settingsRenderId || requestedTab !== settingsTab || page !== 'settings') return;
  }
  if (settingsTab === 'integrations') settingsTab = firstIntegrationTab();
  // A tab for an add-on this office does not have is never reachable, even from a stale link.
  if (INTEGRATION_MODULE[settingsTab] && !integrationAvailable(settingsTab))
    settingsTab = firstIntegrationTab();
  if (settingsTab === 'voip') return voipSettingsPage();
  if (settingsTab === 'permissions') return voipPermissionsPage();
  if (settingsTab === 'backup') return backupSettingsPage();
  if (settingsTab === 'audit') return auditSettingsPage();
  if (settingsTab === 'whatsapp') return whatsappSettingsPage();
  if (settingsTab === 'sms') return smsSettingsPage();
  if (settingsTab === 'ai') return aiSettingsPage();
  if (settingsTab === 'maps') return mapsSettingsPage();
  if (settingsTab === 'iyzico') return iyzicoSettingsPage();
  if (settingsTab === 'support') return supportSettingsPage();
  if (settingsTab === 'modules' && globalThis.hanModules?.['catalog'] !== true) settingsTab = 'firm';
  if (settingsTab === 'modules') return modulesSettingsPage();
  if (settingsTab === 'employeeTerms') return employeeTermsSettingsPage();
  originalSettings();
  const notice = document.querySelector('#settingsForm .notice');
  if (notice)
    notice.textContent =
      'Firma adı menüde ve teslim tutanaklarında kullanılır. Ayarlar uygulama verilerinde saklanır.';
};
