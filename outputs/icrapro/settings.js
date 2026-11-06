const settingsDefaults={firm:{name:'Hukuk Bürosu',legalName:'',taxOffice:'',taxNumber:'',registration:'',authorized:''},contact:{phone:'',email:'',website:'',city:'',district:'',address:''},preferences:{receiver:'',prefix:'EVR',showContact:true}};
let storedConfig;try{storedConfig=JSON.parse(localStorage.getItem('icrapro-settings-v1'))}catch{}
let config=Object.fromEntries(Object.entries(settingsDefaults).map(([k,v])=>[k,{...v,...storedConfig?.[k]}]));
let settingsTab='firm',settingsDraft=null;
function applySettings(){document.querySelectorAll('.workspace b,.sidebottom b').forEach(e=>e.textContent=config.firm.name||'Hukuk Bürosu');document.querySelector('.avatar').textContent=(config.firm.name||'HB').split(/\s+/).slice(0,2).map(s=>s[0]).join('').toLocaleUpperCase('tr')}
function firmReceipt(){return `<div style="border-bottom:1px solid #ddd;padding-bottom:15px;margin-bottom:20px"><b>${esc(config.firm.legalName||config.firm.name)}</b>${config.preferences.showContact?`<div style="font-size:12px">${[config.contact.address,[config.contact.district,config.contact.city].filter(Boolean).join(' / '),config.contact.phone,config.contact.email].filter(Boolean).map(esc).join('<br>')}</div>`:''}</div>`}
function settings(){if(settingsTab==='staff')return personnelSettings();if(!settingsDraft)settingsDraft=structuredClone(config);const tabs={firm:['Firma Bilgileri','Firma kimliği ve yetkili bilgileri'],contact:['İletişim ve Adres','Firmanızın iletişim kanalları'],preferences:['Uygulama Tercihleri','Evrak kabul ve tutanak tercihleri']};const v=settingsDraft[settingsTab];let fields='';if(settingsTab==='firm')fields=`${field('Firma / Büro Adı','name','text',v.name,true,true)}${field('Ticari Unvan','legalName','text',v.legalName,false,true)}${field('Vergi Dairesi','taxOffice','text',v.taxOffice)}<label class="field">Vergi / TC Kimlik Numarası<input name="taxNumber" value="${esc(v.taxNumber)}" inputmode="numeric" pattern="[0-9]{10,11}" title="10 veya 11 rakam girin"></label>${field('Sicil / Baro Numarası','registration','text',v.registration)}${field('Firma Yetkilisi','authorized','text',v.authorized)}`;else if(settingsTab==='contact')fields=`${field('Telefon','phone','tel',v.phone)}${field('E-posta','email','email',v.email)}${field('Web Sitesi','website','url',v.website,false,true)}${field('İl','city','text',v.city)}${field('İlçe','district','text',v.district)}<label class="field full">Açık Adres<textarea name="address" rows="4">${esc(v.address)}</textarea></label>`;else fields=`${field('Varsayılan Teslim Alan','receiver','text',v.receiver,false,true)}<label class="field full">Evrak Numarası Ön Eki<input name="prefix" value="${esc(v.prefix)}" required maxlength="12" pattern="[A-Za-z0-9ÇĞİÖŞÜçğıöşü-]+" title="Harf, rakam ve tire kullanın"><small>Yeni kayıt örneği: ${esc(v.prefix||'EVR')}-0001. Mevcut evrak numaraları korunur.</small></label><label class="settings-check full"><input type="checkbox" name="showContact" ${v.showContact?'checked':''}> Firma iletişim bilgilerini teslim tutanağında göster</label>`;
$('#content').innerHTML=`<div class="settings-tabs" role="tablist" aria-label="Ayar sekmeleri">${Object.entries(tabs).map(([key,t])=>`<button type="button" id="tab-${key}" role="tab" aria-selected="${settingsTab===key}" aria-controls="settingsPanel" data-settings-tab="${key}" class="${settingsTab===key?'selected':''}">${t[0]}</button>`).join('')}<button type="button" role="tab" aria-selected="false" id="staffTab">Personel</button></div><form class="panel" id="settingsForm"><section role="tabpanel" id="settingsPanel" aria-labelledby="tab-${settingsTab}"><div class="panelhead"><div><h2>${tabs[settingsTab][0]}</h2><p>${tabs[settingsTab][1]}</p></div><span class="badge" id="saveState">Kaydedildi</span></div><div class="formbody"><div class="notice">Firma adı menüde ve teslim tutanaklarında kullanılır. Ayarlar bu tarayıcıda saklanır.</div><div class="grid">${fields}</div></div></section><div class="actions"><button type="button" class="secondary" id="discardSettings">Değişiklikleri Geri Al</button><button type="submit" class="primary">Ayarları Kaydet</button></div></form>`;
const form=$('#settingsForm');function capture(){const data=Object.fromEntries(new FormData(form));if(settingsTab==='preferences')data.showContact=form.elements.showContact.checked;settingsDraft[settingsTab]={...settingsDraft[settingsTab],...data};$('#saveState').textContent=JSON.stringify(settingsDraft)===JSON.stringify(config)?'Kaydedildi':'Kaydedilmemiş değişiklikler'}form.oninput=capture;capture();$('#staffTab').onclick=()=>{capture();settingsTab='staff';settings()};document.querySelectorAll('[data-settings-tab]').forEach(b=>b.onclick=()=>{capture();settingsTab=b.dataset.settingsTab;settings()});$('#discardSettings').onclick=()=>{settingsDraft=structuredClone(config);settings();toast('Kaydedilmiş ayarlara dönüldü.')};form.onsubmit=e=>{e.preventDefault();capture();if(!validateSettingsDraft())return;settingsDraft.firm.name=settingsDraft.firm.name.trim();if(!settingsDraft.firm.name){settingsTab='firm';settings();return toast('Firma / büro adını girin.')}const prefix=settingsDraft.preferences.prefix.trim();if(!/^[A-Za-z0-9ÇĞİÖŞÜçğıöşü-]{1,12}$/.test(prefix)){settingsTab='preferences';settings();return toast('Geçerli bir evrak ön eki girin.')}settingsDraft.preferences.prefix=prefix;try{localStorage.setItem('icrapro-settings-v1',JSON.stringify(settingsDraft))}catch{return toast('Ayarlar kaydedilemedi. Tarayıcı depolama alanını kontrol edin.')}config=structuredClone(settingsDraft);applySettings();settings();toast('Tüm ayarlar kaydedildi.')}}

function backupDate(value) {
  return value ? new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Henüz yok';
}

function backupSettingsPage() {
  let status;
  try { status = authApi('/api/backups'); }
  catch (error) { $('#content').textContent = error.message; return; }
  const tabs = [['firm','Firma Bilgileri'],['contact','İletişim ve Adres'],['preferences','Uygulama Tercihleri'],['backup','Yedekleme']];
  $('#content').innerHTML = `<div class="settings-tabs" role="tablist" aria-label="Ayar sekmeleri">${tabs.map(([key,label]) => `<button type="button" role="tab" aria-selected="${key==='backup'}" data-settings-tab="${key}" class="${key==='backup'?'selected':''}">${label}</button>`).join('')}<button type="button" role="tab" aria-selected="false" id="staffTab">Personel</button></div>
    <div class="panel"><div class="panelhead"><div><h2>Yedekleme</h2><p>Uygulama verilerinin şifreli kopyasını Cloudflare R2'ye kaydedin.</p></div></div>
    <div class="formbody"><form id="backupSettingsForm" class="grid">
      <label class="settings-check full"><input name="enabled" type="checkbox" ${status.enabled?'checked':''}> Otomatik yedeklemeyi aç</label>
      <label class="field">Yedekleme aralığı<select name="intervalDays"><option value="1" ${status.intervalDays===1?'selected':''}>Her gün</option><option value="7" ${status.intervalDays===7?'selected':''}>Her 7 günde bir</option><option value="30" ${status.intervalDays===30?'selected':''}>Her 30 günde bir</option></select><small>Bulutta her gün 06.00 civarında kontrol edilir; seçilen aralık dolunca yedek alınır.</small></label>
      <div class="full"><p><b>Cloudflare R2:</b> ${status.r2Configured&&status.encryptionConfigured?'Bağlantı ayarları hazır':'Erişim ve şifreleme anahtarları bekleniyor'} · <b>Kova:</b> ${esc(status.bucket)}</p>
      <p><b>Son başarılı yedek:</b> ${backupDate(status.lastSuccessAt)} · <b>Son R2 kopyası:</b> ${backupDate(status.lastR2At)}</p>
      ${!status.scheduleConfigured?'<p role="alert">Bulut zamanlayıcısı henüz yapılandırılmadı.</p>':''}
      ${status.localAvailable?`<p><b>Son yerel kopya:</b> ${backupDate(status.lastLocalAt)}</p>`:''}
      <p><b>Sonraki yedek:</b> ${status.enabled?(status.nextDueAt?backupDate(status.nextDueAt):'İlk zamanlı kontrolde'):'Otomatik yedekleme kapalı'}</p>
      ${status.lastError?`<p role="alert">${esc(status.lastError)}</p>`:''}
      <small>Yerel sürümde aynı şifreli dosya bilgisayarın yedek klasörüne de kaydedilir. Vercel'de kalıcı kopya R2'de tutulur. Yedekler kullanıcı ve parola kayıtlarını içerir; şifreleme anahtarını güvenli yerde saklayın.</small></div>
      <div class="actions full"><button class="primary" type="submit">Yedekleme Ayarlarını Kaydet</button><button class="secondary" type="button" id="backupNow">Şimdi Yedekle</button></div>
    </form></div></div>`;
  document.querySelectorAll('[data-settings-tab]').forEach(button => button.onclick = () => { settingsTab = button.dataset.settingsTab; settings(); });
  $('#staffTab').onclick = () => { settingsTab = 'staff'; settings(); };
  $('#backupSettingsForm').onsubmit = event => {
    event.preventDefault();
    try {
      const form = event.target;
      authApi('/api/backups', 'PUT', { enabled: form.elements.enabled.checked, intervalDays: Number(form.elements.intervalDays.value) });
      settings(); toast('Yedekleme ayarları kaydedildi.');
    } catch (error) { toast(error.message); }
  };
  $('#backupNow').onclick = async event => {
    const button = event.currentTarget;
    button.disabled = true; button.textContent = 'Yedekleniyor…';
    try {
      const response = await fetch('/api/backups/run', { method: 'POST', headers: { 'X-Han-Request': '1' }, credentials: 'same-origin' });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || 'Yedekleme başarısız.');
      settings(); toast(result.ok ? 'Şifreli yedek Cloudflare R2’ye kaydedildi.' : result.skipped);
    } catch (error) { button.disabled = false; button.textContent = 'Şimdi Yedekle'; toast(error.message); }
  };
}

const originalSettings = settings;
settings = function() {
  if (settingsTab === 'backup') return backupSettingsPage();
  originalSettings();
  const staff = document.getElementById('staffTab');
  const notice = document.querySelector('#settingsForm .notice');
  if (notice) notice.textContent = 'Firma adı menüde ve teslim tutanaklarında kullanılır. Ayarlar uygulama verilerinde saklanır.';
  if (!staff || document.getElementById('backupTab')) return;
  const button = document.createElement('button');
  button.type = 'button'; button.id = 'backupTab'; button.textContent = 'Yedekleme';
  button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', 'false');
  button.onclick = () => { settingsTab = 'backup'; settings(); };
  staff.before(button);
};
