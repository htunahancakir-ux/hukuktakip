const financeCents = (value) => Math.round(Number(value || 0) * 100);
let financeEvents = [];
try {
  const stored = JSON.parse(localStorage.getItem('hanhukuk-finance-v1'));
  if (Array.isArray(stored)) financeEvents = stored;
} catch {}

const propertySections = [
  ['tapu', 'Tapu'],
  ['vehicle', 'Araç'],
  ['sgk', 'SGK'],
];

document.addEventListener(
  'click',
  (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.matches('[data-page]') || /close|cancel/i.test(button.id)) {
      if (blockIncompletePropertyClose()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }
  },
  true,
);
document.addEventListener(
  'cancel',
  (event) => {
    if (event.target.tagName === 'DIALOG' && blockIncompletePropertyClose(event.target))
      event.preventDefault();
  },
  true,
);
window.addEventListener('beforeunload', (event) => {
  if (incompletePropertyDescription()) {
    event.preventDefault();
    event.returnValue = '';
  }
});

let dashboardPeriod = 'day',
  dashboardDate = businessDate();

let financeOperationTab = 'payment';

let financeHistoryTab = 'all';

const legalRateVerifiedThrough = '2026-11-03';
const legalCalculationSupportedThrough = '2026-12-31';
const legalRatePeriods = [
  { start: '2006-01-01', end: '2024-06-01', rate: 9 },
  { start: '2024-06-01', end: '2026-07-31', rate: 24 },
  { start: '2026-07-31', end: '2027-01-01', rate: 31 },
];
const enforcementTariffBands = [
  [800000, 16],
  [800000, 15],
  [1600000, 14],
  [1600000, 13],
  [2400000, 11],
  [3200000, 8],
  [4000000, 5],
  [4800000, 3],
  [5600000, 2],
  [Infinity, 1],
];

let accounting = {
  accounts: [{ id: 'cash', name: 'Nakit Kasa', type: 'cash', bank: '', branch: '', holder: '', iban: '' }],
  entries: [],
};
try {
  const saved = JSON.parse(localStorage.getItem('hanhukuk-accounting-v1'));
  if (saved && Array.isArray(saved.accounts) && Array.isArray(saved.entries)) accounting = saved;
} catch {}

let accountingFilter = '',
  movementFilters = { start: '', end: '', type: '', operator: '', category: '', query: '' };

const accountingExpenseCategories = [
  'Masraf',
  'Faturalar',
  'Yakıt',
  'SGK',
  'Maaş',
  'Prim',
  'Kira',
  'Vergi',
  'Ofis Giderleri',
  'Yemek',
  'Ulaşım',
  'Diğer',
];

const reportDefinitions = {
  excel: {
    label: 'Excel Raporu',
    dateHeader: 'TARİH',
    columns: [
      ['account', 'HESAP'],
      ['number', 'FÖY NO'],
      ['trackingDate', 'TKP. TARİHİ'],
      ['principal', 'ASILALACAK', 'money'],
      ['collection', 'CİRO', 'money'],
      ['gross', 'BRÜT', 'money'],
      ['debtor', 'BORÇLU'],
      ['creditor', 'ALACAKLI'],
      ['staff', 'PERSONEL'],
      ['status', 'DURUM'],
      ['department', 'BÖLÜM'],
    ],
  },
  clientDebtorInfo: {
    label: 'Müvekkil Borçlu Bilgi Raporu',
    hideDate: true,
    columns: [
      ['status', 'Föy Durumu'],
      ['debtor', 'Karşı Yan İsmi'],
      ['due', 'Alacak Tarihi'],
      ['principal', 'Asıl Alacak', 'money'],
      ['enforcement', 'İcra Durumu'],
      ['identity', 'T.C.'],
      ['sgk', 'SSK'],
      ['vehicle', 'ARAÇ'],
      ['tapu', 'TAPU'],
      ['received', 'ÖDEME', 'money'],
      ['note', 'AÇIKLAMA'],
    ],
  },
  clientPayouts: {
    label: 'Müvekkil Ödemeleri',
    columns: [
      ['number', 'Evrak No'],
      ['client', 'Müvekkil'],
      ['debtor', 'Borçlu'],
      ['account', 'Kasa / Banka'],
      ['staff', 'İşlemi Yapan'],
      ['amount', 'Ödenen Anapara', 'money'],
      ['note', 'Açıklama'],
    ],
  },
  documents: {
    label: 'Evrak ve Borçlu Durumları',
    columns: [
      ['number', 'Evrak No'],
      ['client', 'Müvekkil'],
      ['debtor', 'Borçlu'],
      ['type', 'Evrak Türü'],
      ['status', 'Durum'],
      ['original', 'Evrak Aslı'],
      ['staff', 'Dosya Sorumlusu'],
      ['principal', 'Anapara', 'money'],
      ['total', 'Toplam Borç', 'money'],
      ['received', 'Tahsilat', 'money'],
      ['remaining', 'Kalan', 'money'],
      ['profit', 'Kâr', 'money'],
    ],
  },
  finance: {
    label: 'Tahsilat, Gider, Ciro ve Kâr',
    columns: [
      ['number', 'Evrak No'],
      ['client', 'Müvekkil'],
      ['debtor', 'Borçlu'],
      ['kind', 'İşlem'],
      ['account', 'Kasa / Banka'],
      ['staff', 'İşlemi Yapan'],
      ['category', 'Gider Kalemi'],
      ['collection', 'Tahsilat', 'money'],
      ['revenue', 'Ciro', 'money'],
      ['expense', 'Gider', 'money'],
      ['profit', 'Kâr', 'money'],
      ['note', 'Açıklama'],
    ],
  },
  accounts: {
    label: 'Kasa / Banka Hareketleri',
    columns: [
      ['account', 'Hesap'],
      ['kind', 'İşlem'],
      ['category', 'Gider Kalemi'],
      ['staff', 'İşlemi Yapan'],
      ['incoming', 'Giriş', 'money'],
      ['outgoing', 'Çıkış', 'money'],
      ['note', 'Açıklama'],
    ],
  },
  calls: {
    label: 'Görüşme ve Personel Faaliyetleri',
    columns: [
      ['number', 'Evrak No'],
      ['client', 'Müvekkil'],
      ['debtor', 'Borçlu'],
      ['time', 'Saat'],
      ['staff', 'Görüşen'],
      ['result', 'Sonuç'],
      ['note', 'Görüşme Notu'],
    ],
  },
  installments: {
    label: 'Yapılandırma ve Taksitler',
    columns: [
      ['number', 'Evrak No'],
      ['client', 'Müvekkil'],
      ['debtor', 'Borçlu'],
      ['sequence', 'Taksit No'],
      ['method', 'Plan'],
      ['amount', 'Taksit Tutarı', 'money'],
      ['paid', 'Ödenen', 'money'],
      ['remaining', 'Kalan', 'money'],
      ['status', 'Taksit Durumu'],
    ],
  },
  discounts: {
    label: 'Borç İndirimleri',
    columns: [
      ['number', 'Evrak No'],
      ['client', 'Müvekkil'],
      ['debtor', 'Borçlu'],
      ['before', 'İndirim Öncesi', 'money'],
      ['discount', 'İndirim', 'money'],
      ['after', 'İndirim Sonrası', 'money'],
      ['note', 'Gerekçe'],
    ],
  },
  guarantors: {
    label: 'Kefiller',
    columns: [
      ['number', 'Evrak No'],
      ['debtor', 'Borçlu'],
      ['name', 'Kefil'],
      ['identity', 'TC Kimlik'],
      ['phone', 'Tel-1'],
      ['phone2', 'Tel-2'],
      ['city', 'İl'],
      ['district', 'İlçe'],
      ['address', 'Adres'],
      ['tapu', 'Tapu'],
      ['vehicle', 'Araç'],
      ['sgk', 'SGK'],
    ],
  },
  clients: {
    label: 'Müvekkil Kayıtları',
    columns: [
      ['name', 'Ad / Unvan'],
      ['category', 'Müvekkil Türü'],
      ['type', 'Şahıs / Şirket'],
      ['identity', 'Kimlik / Vergi No'],
      ['phone', 'Telefon'],
      ['city', 'İl'],
      ['district', 'İlçe'],
      ['count', 'Evrak Adedi'],
      ['principal', 'Toplam Anapara', 'money'],
      ['paid', 'Müvekkile Ödenen', 'money'],
    ],
  },
  personnel: {
    label: 'Personel Maaş ve Prim',
    columns: [
      ['name', 'Ad Soyad'],
      ['department', 'Birim'],
      ['status', 'Durum'],
      ['phone', 'Telefon'],
      ['official', 'Resmî Maaş', 'money'],
      ['unofficial', 'Gayriresmî Maaş', 'money'],
      ['salary', 'Toplam Maaş', 'money'],
      ['bonus', 'Prim', 'money'],
      ['total', 'Genel Toplam', 'money'],
    ],
  },
};
let reportFilters = {
  type: 'finance',
  from: businessDate().slice(0, 7) + '-01',
  to: businessDate(),
  client: '',
  staff: '',
  status: '',
  account: '',
  query: '',
  undated: true,
};

let clientPayoutFilter = '',
  clientPayoutStart = '',
  clientPayoutEnd = '';

const borrowerSheetTabs = [
  ['personal', 'Kimlik ve İletişim'],
  ['assets', 'Tapu / Araç / SGK'],
  ['guarantors', 'Kefiller'],
  ['conversations', 'Görüşmeler'],
  ['document', 'Evrak Bilgileri'],
  ['payout', 'Müvekkile Ödeme'],
];

let insPeriod = 'day',
  insDate = '',
  insEndDate = '',
  insSort = 'collected';

let reportDataSnapshot = null;

let monthlyPayrollReportMonth = '';
