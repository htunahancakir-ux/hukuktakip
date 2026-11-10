const turkeyCities = [
  'Adana',
  'Adıyaman',
  'Afyonkarahisar',
  'Ağrı',
  'Aksaray',
  'Amasya',
  'Ankara',
  'Antalya',
  'Ardahan',
  'Artvin',
  'Aydın',
  'Balıkesir',
  'Bartın',
  'Batman',
  'Bayburt',
  'Bilecik',
  'Bingöl',
  'Bitlis',
  'Bolu',
  'Burdur',
  'Bursa',
  'Çanakkale',
  'Çankırı',
  'Çorum',
  'Denizli',
  'Diyarbakır',
  'Düzce',
  'Edirne',
  'Elazığ',
  'Erzincan',
  'Erzurum',
  'Eskişehir',
  'Gaziantep',
  'Giresun',
  'Gümüşhane',
  'Hakkari',
  'Hatay',
  'Iğdır',
  'Isparta',
  'İstanbul',
  'İzmir',
  'Kahramanmaraş',
  'Karabük',
  'Karaman',
  'Kars',
  'Kastamonu',
  'Kayseri',
  'Kırıkkale',
  'Kırklareli',
  'Kırşehir',
  'Kilis',
  'Kocaeli',
  'Konya',
  'Kütahya',
  'Malatya',
  'Manisa',
  'Mardin',
  'Mersin',
  'Muğla',
  'Muş',
  'Nevşehir',
  'Niğde',
  'Ordu',
  'Osmaniye',
  'Rize',
  'Sakarya',
  'Samsun',
  'Siirt',
  'Sinop',
  'Sivas',
  'Şanlıurfa',
  'Şırnak',
  'Tekirdağ',
  'Tokat',
  'Trabzon',
  'Tunceli',
  'Uşak',
  'Van',
  'Yalova',
  'Yozgat',
  'Zonguldak',
];

document.addEventListener('click', (event) => {
  const box = document.getElementById('clientSuggestions');
  if (box && !event.target.closest('.client-search-wrap')) {
    box.hidden = true;
    document.getElementById('search')?.setAttribute('aria-expanded', 'false');
  }
});

const $ = (s) => document.querySelector(s),
  money = (n) =>
    new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + ' TL',
  esc = escapeHtml;
let db;
try {
  db = JSON.parse(localStorage.getItem('icrapro-v1'));
} catch {}
if (!db || !Array.isArray(db.clients) || !Array.isArray(db.docs)) db = { clients: [], docs: [] };
let page = 'home',
  selected = '',
  kind = 'Şahıs';
function save() {
  localStorage.setItem('icrapro-v1', JSON.stringify(db));
  // Scoped saves already merge the canonical records in authApi. A full read
  // here would expand the baseline without expanding the partial workspace.
  if (window.hanRecordsEnabled) return;
  try {
    const latest = JSON.parse(localStorage.getItem('icrapro-v1'));
    for (const d of db.docs) {
      const record = latest.docs.find((x) => x.id === d.id);
      if (!record) continue;
      for (const key of [
        'relatedStaff',
        'relatedStaffName',
        'assignmentVersion',
        'assignmentHistory',
        'noCallWarningKey',
        'trackingDate',
      ]) {
        if (record[key] !== undefined) d[key] = record[key];
        else delete d[key];
      }
    }
  } catch {}
}
let toastTimer;
function toast(t, scope) {
  const success = /kaydedildi|güncellendi|borca uygulandı/i.test(t);
  clearTimeout(toastTimer);
  const globalToast = document.getElementById('toast');
  if (globalToast) globalToast.style.display = 'none';
  document.querySelectorAll('.local-feedback').forEach((el) => el.remove());
  const dialogs = [...document.querySelectorAll('dialog[open]')];
  const focused = document.activeElement?.closest('dialog[open]');
  const root = scope || focused || dialogs.at(-1) || document.getElementById('content');
  if (!root) return;
  const panel = [...root.querySelectorAll('[role="tabpanel"]')].find((el) => !el.hidden);
  const target = panel || root;
  const el = document.createElement('div');
  el.className = 'local-feedback ' + (success ? 'local-feedback-success' : 'local-feedback-notice');
  el.setAttribute('role', success ? 'status' : 'alert');
  el.setAttribute('aria-live', success ? 'polite' : 'assertive');
  el.textContent = success ? '✓ ' + t : t;
  target.prepend(el);
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (!success) toastTimer = setTimeout(() => el.remove(), 7000);
}

function stats() {
  updateActiveDebtorCount();
  if (window.hanRecordsEnabled && page === 'clients') return renderRecordClientStats(null);
  if (window.hanRecordsEnabled && page === 'intake') return renderRecordIntakeStats();
  if (window.hanRecordsEnabled && !window.hanWorkspaceComplete) return renderRecordStats();
  const scoped = page === 'intake' && selected;
  const docs = scoped ? db.docs.filter((d) => d.client === selected) : db.docs;
  docs.forEach((d) => {
    if (typeof applyParkingFee === 'function') applyParkingFee(d, businessDate());
  });
  $('#count').textContent = db.clients.length;
  let cards = [
    [
      scoped ? 'Seçili müvekkil' : 'Toplam müvekkil',
      scoped ? 1 : db.clients.length,
      scoped ? db.clients.find((c) => c.id === selected)?.name || '' : 'Kayıtlı müvekkil',
      '◉',
    ],
    ['Kabul Edilen Evrak', docs.length, 'Teslim alınan toplam evrak', '▤'],
    [
      'Toplam Evrak Tutarı',
      money(docs.reduce((a, d) => a + Number(d.amount), 0)),
      'Kayıtlı evrakların toplamı',
      '₺',
    ],
  ];
  if (page === 'clients') {
    const t = clientDocumentTotals(docs);
    cards = [
      cards[0],
      ['Kabul Edilen Evrak', t.accepted, 'Teslim alınan toplam evrak', '▤'],
      [
        'Toplam Tutar',
        money(docs.reduce((sum, d) => sum + Math.round(Number(d.amount || 0) * 100), 0) / 100),
        'Kayıtlı tüm evrakların toplam tutarı',
        '₺',
      ],
      ['İnfaz Edilen Evrak', t.closed, 'İnfaz durumundaki evraklar', '✓'],
      ['İade Edilen Evrak', t.returned, 'İade durumundaki evraklar', '↩'],
      ['İnfaz Edilen Tutar', money(t.closedAmount), 'İnfaz edilen evrakların tutarı', '₺'],
      ['Müvekkile Ödenen Tutar', money(t.paidAmount), 'Kaydedilmiş müvekkil ödemeleri', '₺'],
    ];
  }
  $('#stats').innerHTML = cards
    .map(
      (x) =>
        `<div class="stat"><div><small>${esc(x[0])}</small><strong>${esc(x[1])}</strong><small>${esc(x[2])}</small></div><span class="icon">${esc(x[3])}</span></div>`,
    )
    .join('');
}

function render() {
  if (typeof recordPageNeedsCompatibility === 'function' && recordPageNeedsCompatibility()) {
    const requestedPage = page;
    $('#content').textContent = 'Çalışma verileri yükleniyor…';
    return ensureRecordWorkspace(() => {
      if (page === requestedPage) render();
    });
  }
  document.getElementById('newIntakeDocument')?.remove();
  updateActiveDebtorCount();
  if (window.hanAuth && !hanPageAllowed(page)) page = staffHome();
  renderActiveOperator();
  applySettings();
  renderClientScope();
  if (['ceo', 'admin'].includes(hanAuth.role)) stats();
  else $('#stats').innerHTML = '';
  document.getElementById('stats').hidden =
    !['ceo', 'admin'].includes(hanAuth.role) ||
    page === 'users' ||
    page === 'messages' ||
    page === 'reminders' ||
    page === 'reports' ||
    page === 'callRecordings' ||
    page === 'accounting' ||
    page === 'home' ||
    page === 'settings' ||
    page === 'personnel' ||
    page === 'marketing';
  document
    .querySelectorAll('nav button')
    .forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  const titles = {
    marketing: ['Pazarlama', 'Potansiyel müvekkil ve ziyaret takibi.'],
    callRecordings: ['Görüşme Kayıtları', 'Arama geçmişi, görüşme sonuçları ve şifreli ses arşivi.'],
    messages: ['Mesajlar / İş Emirleri', 'Kullanıcılara tek tek veya toplu mesaj gönderin.'],
    reminders: ['Hatırlatmalar', 'Dosyaya bağlı veya kişisel hatırlatmalarınızı zamanlayın.'],
    users: ['Kullanıcı Yönetimi', 'Hesapları ve yetkileri yönetin.'],
    noAccess: ['Yetki Bekleniyor', 'Yöneticinizin size işlem yetkisi ataması gerekiyor.'],
    reports: ['Raporlar', 'İşlemleri süzün, toplamları inceleyin ve dışa aktarın.'],
    accounting: ['Muhasebe', 'Nakit kasa ve banka hesaplarını yönetin.'],
    home: ['Ana Sayfa', 'Tahsilat, ciro, kâr ve infaz durumunu dönemlere göre izleyin.'],
    personnel: ['Personel', 'Personel kayıtları, maaş ve prim bilgilerini yönetin.'],
    settings: ['Ayarlar', 'Firma bilgilerinizi ve çalışma tercihlerinizi yönetin.'],
    clients: ['Müvekkiller', 'Müvekkil bilgilerinizi ve bağlı evrakları tek yerden yönetin.'],
    intake: [
      'Evrak Kabul',
      'Senet, çek, sözleşme, cari ekstre, ilam, yediemin park ücreti, fatura ve diğer evrakları kaydedin ve teslim tutanağı oluşturun.',
    ],
    documents: ['Borçlu Listesi', 'Teslim alınan evraklara ve evrak detaylarına ulaşın.'],
  };
  $('#title').textContent = $('#crumb').textContent = titles[page][0];
  $('#subtitle').textContent = titles[page][1];
  $('#newClient').hidden = page !== 'clients';
  $('#clientSearchBar').hidden = page !== 'clients';
  $('#clientSearchBar').replaceChildren();
  if (page === 'clients') {
    $('#content').innerHTML =
      `<div class="panel"><div class="panelhead"><div><h2>Müvekkil kayıtları</h2><p>Tüm müvekkiller ve iletişim bilgileri</p></div><div class="client-search-wrap"><input class="search" id="search" type="search" maxlength="200" placeholder="Müvekkil adının başlangıcını yazın (ör. sak)…" aria-label="Müvekkil ara" autocomplete="off" aria-controls="clientSuggestions" aria-expanded="false"><div id="clientSuggestions" class="client-suggestions" hidden></div></div></div><div class="overflow"><table><thead><tr><th>MÜVEKKİL / UNVAN</th><th>TÜR</th><th>İLETİŞİM</th><th>EVRAK</th><th>İŞLEMLER</th></tr></thead><tbody id="rows"></tbody></table></div><div class="tablefoot" id="total"></div></div>`;
    $('#clientSearchBar').append($('#content .panelhead'));
    if (window.hanRecordsEnabled) $('#search').value = recordClientList.q;
    clientRows();
    bindClientSearch();
  } else if (page === 'callRecordings') voipRecordingsPage();
  else if (page === 'messages') messagesPage();
  else if (page === 'reminders') scheduledRemindersPage();
  else if (page === 'users') userManagement();
  else if (page === 'noAccess')
    $('#content').innerHTML = '<div class="panel formbody">Hesabınıza henüz işlem yetkisi atanmadı.</div>';
  else if (page === 'reports') reportsPage();
  else if (page === 'accounting') accountingPage();
  else if (page === 'home') dashboard();
  else if (page === 'intake') {
    intake();
    window.scrollTo({ top: 0, behavior: 'instant' });
  } else if (page === 'marketing') {
    document.getElementById('content').innerHTML = `
      <section class="panel">
        <div class="panelhead"><div><h2>Pazarlama</h2><p>Potansiyel müvekkil bilgileri</p></div>
          <div class="toolbar"><button class="primary" type="button" id="addProspect" aria-expanded="false" aria-controls="prospectForm">＋ Potansiyel Müvekkil Ekle</button><button class="secondary" type="button" id="marketingBack">← Geri</button></div>
        </div>
        <form id="prospectForm" class="formbody" hidden>
          <h3>Potansiyel Müvekkil Bilgileri</h3>
          <div class="grid">
            <label class="field">Tarih<input name="date" type="date" required></label>
            <label class="field">Saat<input name="time" type="time"></label>
            ${staffSelect('Personel', 'staffId')}
            <label class="field">Durum<select name="status" required><option value="">Durum seçin</option><option value="Potansiyel Müvekkil">Potansiyel Müvekkil</option><option value="Mevcut Müvekkil">Mevcut Müvekkil</option></select></label>
            <label class="field">Firma Adı<input name="company" type="text" maxlength="200" required></label>
            <label class="field">Görüşülen Kişi<input name="contact" type="text" maxlength="200"></label>
            <label class="field">Telefon Numarası<input name="phone" type="tel" maxlength="30"></label>
            ${clientCityField({}, 'prospect')}
            <label class="field full">Adres<textarea name="address" rows="2" maxlength="1000"></textarea></label>
            <label class="field full">Açıklama<textarea name="notes" rows="3" maxlength="3000"></textarea></label>
          </div>
          <div class="actions"><button class="primary" type="submit">Kaydet</button><button class="secondary" type="button" id="convertProspect">Müvekkile Çevir</button></div>
        </form>
        <div class="formbody"><div class="grid"><label class="field">Başlangıç Tarihi<input id="prospectFrom" type="date"></label><label class="field">Bitiş Tarihi<input id="prospectTo" type="date"></label><label class="field">Personel<input id="prospectStaffFilter" type="search" placeholder="Personel adı"></label><label class="field">Firma / İl / İlçe Ara<input id="prospectQuery" type="search"></label></div></div><div class="formbody" id="prospectList"></div>
      </section>`;
    setupClientCity('prospect');
    setupClientDistrict('prospect');
    const button = document.getElementById('addProspect');
    const form = document.getElementById('prospectForm');
    document.getElementById('marketingBack').onclick = () => {
      if (!form.hidden) {
        editingProspectId = null;
        form.reset();
        updateProspectFields();
        form.hidden = true;
        button.setAttribute('aria-expanded', 'false');
      } else {
        page = 'home';
        render();
      }
    };
    const updateProspectFields = () => {
      const existing = form.elements.status.value === 'Mevcut Müvekkil';
      for (const name of ['staffId', 'contact', 'phone', 'city', 'district', 'address']) {
        const input = form.elements[name];
        const container = input?.closest('.field');
        if (container) container.style.display = existing ? 'none' : '';
        if (input && ['date', 'city', 'district'].includes(name)) input.required = !existing;
        if (input && existing) input.setCustomValidity('');
      }
      document.getElementById('convertProspect').style.display = existing ? 'none' : '';
    };
    form.elements.status.addEventListener('change', updateProspectFields);
    updateProspectFields();
    button.onclick = () => {
      form.hidden = !form.hidden;
      button.setAttribute('aria-expanded', String(!form.hidden));
      if (!form.hidden) form.elements.company.focus();
    };
    let editingProspectId = null;
    const loadProspects = () => {
      try {
        const result = authApi('/api/marketing-prospects');
        const from = document.getElementById('prospectFrom').value;
        const to = document.getElementById('prospectTo').value;
        const staff = document.getElementById('prospectStaffFilter').value.trim().toLocaleLowerCase('tr');
        const query = document.getElementById('prospectQuery').value.trim().toLocaleLowerCase('tr');
        result.items = result.items.filter((item) =>
          (!from || item.date >= from) && (!to || item.date <= to) &&
          (!staff || String(item.staffName || '').toLocaleLowerCase('tr').includes(staff)) &&
          (!query || [item.company, item.city, item.district].some((v) => String(v || '').toLocaleLowerCase('tr').includes(query)))
        );
        document.getElementById('prospectList').innerHTML = '<h3>Potansiyel Müvekkiller</h3><div class="overflow"><table><thead><tr><th>TARİH</th><th>FİRMA</th><th>İL / İLÇE</th><th>PERSONEL</th><th>DURUM</th><th>İŞLEM</th></tr></thead><tbody>' +
          result.items.map((item) => `<tr><td>${esc(item.date)} ${esc(item.time)}</td><td>${esc(item.company)}</td><td>${esc(item.city)} / ${esc(item.district)}</td><td>${esc(item.staffName)}</td><td>${esc(item.status)}</td><td>${['ceo', 'admin'].includes(hanAuth.role) ? `<button type="button" class="link" data-edit-prospect="${esc(item.id)}">Düzenle</button>` : ''}</td></tr>`).join('') +
          (result.items.length ? '' : '<tr><td colspan="6" class="empty">Henüz kayıt yok.</td></tr>') + '</tbody></table></div>';
        document.querySelectorAll('[data-edit-prospect]').forEach((editButton) => {
          editButton.onclick = () => {
            const item = result.items.find (entry => entry.id === editButton.dataset.editProspect);
            if (!item) return;
            editingProspectId = item.id;
            for (const key of ['date', 'time', 'staffId', 'status', 'company', 'contact', 'phone', 'city', 'district', 'address', 'notes'])
              if (form.elements[key]) form.elements[key].value = item[key] || '';
            updateProspectFields();
            form.hidden = false;
            button.setAttribute('aria-expanded', 'true');
            form.elements.company.focus();
          };
        });
      } catch (error) { document.getElementById('prospectList').textContent = error.message; }
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      try {
        const values = Object.fromEntries(new FormData(form));
        if (!('district' in values)) values.district = form.elements.district.value;
        if (values.status === 'Mevcut Müvekkil' && !values.date) values.date = businessDate();
        if (editingProspectId) values.id = editingProspectId;
        authApi('/api/marketing-prospects', editingProspectId ? 'PUT' : 'POST', values);
        editingProspectId = null;
        form.reset();
        updateProspectFields();
        loadProspects();
        toast('Potansiyel müvekkil kaydedildi.');
      } catch (error) { toast(error.message); }
    };
    for (const id of ['prospectFrom', 'prospectTo', 'prospectStaffFilter', 'prospectQuery']) document.getElementById(id).addEventListener('input', loadProspects);
    loadProspects();
    document.getElementById('convertProspect').onclick = () => {
      if (!hanCan('clients')) return toast('Müvekkil ekleme yetkiniz yok.');
      const prospect = Object.fromEntries(new FormData(form));
      if (!prospect.company.trim()) {
        form.elements.company.setCustomValidity('Firma adını girin.');
        form.elements.company.reportValidity();
        form.elements.company.setCustomValidity('');
        return;
      }
      clientModal(null, {
        type: 'Şirket',
        tradeName: prospect.company.trim(),
        fullName: prospect.contact.trim(),
        phone: prospect.phone.trim(),
        city: prospect.city.trim(),
        district: prospect.district.trim(),
        address: prospect.address.trim(),
        notes: prospect.notes.trim(),
      });
    };
  }
  else if (page === 'personnel') personnelSettings();
  else if (page === 'settings') settings();
  else documents();
}

const embeddedIntake = window.parent !== window && new URLSearchParams(location.search).has('embeddedIntake');

let debtorStatusFilter = 'Derdest',
  borrowerFilters = {
    client: '',
    type: '',
    number: '',
    debtor: '',
    identity: '',
    staff: '',
    minAmount: '',
    maxAmount: '',
    minCents: '',
    maxCents: '',
    dueStart: '',
    dueEnd: '',
  };

const debtorColumnFilters = {};
let debtorEntryDateSort = 0;

document.querySelectorAll('[data-page]').forEach(
  (b) =>
    (b.onclick = () => {
      page = b.dataset.page;
      render();
    }),
);
$('#newClient').onclick = () => clientModal();
if (embeddedIntake) {
  page = 'intake';
  selected = new URLSearchParams(location.search).get('client') || '';
  const style = document.createElement('style');
  style.textContent =
    'body{display:block;min-height:0}.shell{margin:0;width:100%}.shell main{padding:0;margin:0;max-width:none}aside,.shell>header,.shell .heading,.shell footer,#stats,#clientScopeBar{display:none!important}';
  document.head.append(style);
  if (window.hanRecordsEnabled && selected)
    ensureIntakeClient(selected)
      .then(() => intake(undefined, true))
      .catch((error) => toast(error.message));
  else intake(undefined, true);
  const resize = () => {
    if (window.frameElement)
      window.frameElement.style.height =
        Math.max(420, document.querySelector('.shell').offsetHeight + 8) + 'px';
  };
  new ResizeObserver(resize).observe(document.querySelector('.shell'));
} else render();

const dateUiObserver = new MutationObserver(upgradeDateInputs);
dateUiObserver.observe(document.body, { childList: true, subtree: true });
upgradeDateInputs();
document.addEventListener(
  'change',
  (event) => {
    if (event.target._dateProxy) return;
    queueMicrotask(() =>
      document.querySelectorAll('input[data-date-ui]').forEach((original) => {
        if (original._dateProxy && document.activeElement !== original._dateProxy)
          original._dateProxy.value = displayDate(original.value);
      }),
    );
  },
  true,
);

const moneyUiObserver = new MutationObserver(upgradeMoneyInputs);
moneyUiObserver.observe(document.body, { childList: true, subtree: true });
upgradeMoneyInputs();
document.addEventListener(
  'change',
  (event) => {
    if (event.target._moneyProxy) return;
    queueMicrotask(() =>
      document.querySelectorAll('input[data-money-ui]').forEach((original) => {
        if (original._moneyProxy && document.activeElement !== original._moneyProxy)
          original._moneyProxy.value = formatAmountInput(original.value);
      }),
    );
  },
  true,
);

let parkingLastDay = businessDate();
setInterval(() => {
  const today = businessDate();
  if (today === parkingLastDay) return;
  parkingLastDay = today;
  db.docs.forEach((d) => applyParkingFee(d, today));
  if (page === 'intake') document.getElementById('intakeForm')?._refreshParkingFee?.();
  else if (!document.querySelector('dialog[open]') && ['home', 'clients', 'documents'].includes(page))
    render();
}, 60000);

const closeButtonObserver = new MutationObserver(alignCloseButtons);
closeButtonObserver.observe(document.body, { childList: true, subtree: true });
alignCloseButtons();

const phoneFormatObserver = new MutationObserver(upgradePhoneInputs);
phoneFormatObserver.observe(document.body, { childList: true, subtree: true });
document.addEventListener(
  'submit',
  (e) => {
    e.target
      .querySelectorAll('input[data-phone-format]')
      .forEach((input) => (input.value = formatPhoneNumber(input.value)));
  },
  true,
);
upgradePhoneInputs();

const ibanFormatObserver = new MutationObserver(upgradeIbanInputs);
ibanFormatObserver.observe(document.body, { childList: true, subtree: true });
upgradeIbanInputs();
