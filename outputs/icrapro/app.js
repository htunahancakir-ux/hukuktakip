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
    page === 'accounting' ||
    page === 'home' ||
    page === 'settings' ||
    page === 'personnel';
  document
    .querySelectorAll('nav button')
    .forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  const titles = {
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
      `<div class="panel"><div class="panelhead"><div><h2>Müvekkil kayıtları</h2><p>Tüm müvekkiller ve iletişim bilgileri</p></div><div class="client-search-wrap"><input class="search" id="search" placeholder="İsim, unvan veya kimlik numarasının başlangıcını yazın…" aria-label="Müvekkil ara" autocomplete="off" aria-controls="clientSuggestions" aria-expanded="false"><div id="clientSuggestions" class="client-suggestions" hidden></div></div></div><div class="overflow"><table><thead><tr><th>MÜVEKKİL / UNVAN</th><th>TÜR</th><th>İLETİŞİM</th><th>EVRAK</th><th>İŞLEMLER</th></tr></thead><tbody id="rows"></tbody></table></div><div class="tablefoot" id="total"></div></div>`;
    $('#clientSearchBar').append($('#content .panelhead'));
    clientRows();
    $('#search').oninput = clientRows;
  } else if (page === 'messages') messagesPage();
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
  } else if (page === 'personnel') personnelSettings();
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
  if (window.hanRecordsEnabled && !window.hanWorkspaceComplete)
    ensureRecordWorkspace(() => intake(undefined, true));
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
