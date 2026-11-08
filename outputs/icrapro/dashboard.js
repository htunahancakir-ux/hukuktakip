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

const accountingExpenseCategories = hanAccountingRules.expenseCategories;

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
  ['financial', 'Finansal İşlemler'],
  ['document', 'Evrak Bilgileri'],
  ['payout', 'Müvekkile Ödeme'],
];

let insPeriod = 'day',
  insDate = '',
  insEndDate = '',
  insSort = 'collected';

let reportDataSnapshot = null;

let monthlyPayrollReportMonth = '';
