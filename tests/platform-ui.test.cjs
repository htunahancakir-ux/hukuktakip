const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '../outputs/icrapro');
const source = fs.readFileSync(path.join(root, 'platform.js'), 'utf8');
const { parseTl, formatTl, previewTotals, vatOf } = require(path.join(root, 'platform.js'));
const html = fs.readFileSync(path.join(root, 'platform.html'), 'utf8').replace(/<script[^>]*><\/script>/, '');
const hostile = '<img src=x onerror="window.pwned=1">Kötü Büro';

test('TL parsing is exact and strict', () => {
  assert.equal(parseTl('1250,50'), 125050);
  assert.equal(parseTl('1.250,50'), 125050);
  assert.equal(parseTl('1.250'), 125000, 'dot thousands separator');
  assert.equal(parseTl('199.99'), 19999);
  assert.equal(parseTl('200'), 20000);
  assert.equal(parseTl(' 0,5 '), 50);
  assert.equal(parseTl('12.345,6'), 1234560);
  for (const bad of ['', 'abc', '1,234', '1.2.3', '-5', '1e3', '9'.repeat(30)]) assert.ok(Number.isNaN(parseTl(bad)), bad);
  assert.match(formatTl(125050), /1\.250,50/);
  assert.deepEqual(previewTotals({ userCount: 5, userPriceKurus: 20000, termMonths: 12, modulePrices: [5000], discountKurus: 10000 }), {
    users: 1_200_000,
    modules: 60_000,
    total: 1_260_000,
    discount: 10_000,
    payable: 1_250_000,
    vat: 0,
    gross: 1_250_000,
  });
  // 5 users × 200,00 × 12 = 12.000,00 + module 50,00 × 12 = 600,00 − discount 100,00, at 20% KDV
  const withVat = previewTotals({ userCount: 5, userPriceKurus: 20000, termMonths: 12, modulePrices: [5000], discountKurus: 10000, vatRatePercent: 20 });
  assert.equal(withVat.vat, 240_000 + 12_000 - 2_000);
  assert.equal(withVat.gross, withVat.payable + withVat.vat);
  assert.equal(vatOf(5, 10), 1);
  assert.equal(vatOf(-5, 10), -1);
  assert.equal(vatOf(1005, 20), 201);
  assert.equal(previewTotals({ userCount: 1, userPriceKurus: 100, termMonths: 1, discountKurus: 999 }).payable, 0, 'discount is capped');
});

function office(extra = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111', slug: 'kotu', name: hostile, status: 'enabled', createdAt: '2026-11-01T00:00:00Z',
    subscription: { status: 'active', planCode: 'paid', accessUntil: '2027-11-01T00:00:00Z', expired: false, daysLeft: 355 },
    userLimit: 5, usersUsed: 2, userPriceKurus: 20000, modules: ['voip'], monthlyKurus: 105000, paidKurus: 0, pendingKurus: 1_260_000, legacy: false, ...extra,
  };
}
const dashboard = () => ({
  generatedAt: '2026-11-11T10:00:00Z',
  offices: { total: 1, provisioning: 0, enabled: 1, suspended: 0, closed: 0 },
  users: { sold: 5, used: 2 },
  revenue: { mrrKurus: 105000, paidKurus: 0, thisMonthKurus: 0, lastMonthKurus: 0, pendingKurus: 1_260_000, pendingCount: 1,
    months: Array.from({ length: 12 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}`, kurus: 0 })), byKind: [] },
  attention: { expiringSoon: 0, expired: 0, trials: 0, fullSeats: 0 },
  modules: [{ code: 'voip', name: 'Çağrı merkezi', offices: 1, monthlyKurus: 5000, paidKurus: 0 }],
  pendingSales: [{ id: '22222222-2222-4222-8222-222222222222', tenantId: office().id, tenantName: hostile, kind: 'new_office', description: hostile, amountKurus: 1_260_000, createdAt: '2026-11-01T00:00:00Z' }],
  officeList: [office()],
});
const modules = () => [
  { code: 'voip', name: 'Çağrı merkezi', description: '', monthlyPriceKurus: 5000, active: true, offices: 1, gated: true },
  { code: 'whatsapp', name: 'WhatsApp', description: '', monthlyPriceKurus: 3000, active: true, offices: 0, gated: false },
  { code: 'ai-assistant', name: 'Yapay zekâ asistanı', description: '', monthlyPriceKurus: 10000, active: false, kind: 'module', status: 'soon', trialDays: 14, features: ['Dilekçe taslağı'], offices: 0, monthlyKurus: 0, sold: 0, paidKurus: 0, gated: true },
  { code: 'sms-paket', name: 'SMS paketi', description: '', monthlyPriceKurus: 25000, active: true, kind: 'usage_pack', status: 'selling', packQuantity: 1000, packUnit: 'SMS', trialDays: 0, features: [], offices: 0, monthlyKurus: 0, sold: 3, paidKurus: 75000, gated: false },
];
const campaign = (extra = {}) => ({
  id: 'c1', name: 'Kasım fırsatı', productCodes: ['voip'], discountType: 'percent', discountValue: 20, applies: 'first_3_months', audience: 'all', tenantIds: [],
  startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-12-31T20:59:59Z', couponCode: 'KASIM20', maxUses: 100, usedCount: 3, status: 'active', live: true,
  revenueKurus: 300_000, discountKurus: 30_000, ...extra,
});
const announcement = (extra = {}) => ({
  id: 'n1', kind: 'new_product', title: hostile, body: 'Çağrı merkezi modülü yayında.', productCode: 'voip', productName: 'Çağrı merkezi', campaignId: null, campaignName: null,
  audience: 'without_product', tenantIds: [], roles: 'managers', startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-12-01T00:00:00Z', dismissible: true, priority: 50,
  status: 'published', live: true, stats: { offices: 4, shown: 9, clicked: 3, dismissed: 2, interested: 1 }, ...extra,
});
const prospect = (extra = {}) => ({
  id: 'p1', kind: 'new_office', tenantId: null, tenantName: null, officeName: 'Yıldız Hukuk', contactName: 'Av. Deniz', phone: '0532', email: null, city: 'İzmir',
  source: 'advertising', stage: 'contacted', expectedUsers: 4, productCodes: ['voip'], expectedMonthlyKurus: 90_000, ownerAdminId: 'a', ownerName: 'Operatör',
  nextActionAt: '2026-11-01T09:00:00Z', lostReason: null, wonTenantId: null, note: null, createdBy: 'a', createdLabel: 'Operatör',
  createdAt: '2026-10-20T09:00:00Z', updatedAt: '2026-10-21T09:00:00Z', closedAt: null, ...extra,
});
const officeRequest = () => prospect({ id: 'p2', kind: 'upsell', tenantId: office().id, tenantName: hostile, officeName: hostile, stage: 'new', source: 'request', createdBy: null, createdLabel: 'Ayşe (CEO)', nextActionAt: null, productCodes: ['sms-paket'] });
const prospects = () => ({
  prospects: [prospect(), officeRequest()],
  byStage: { new: { count: 1, monthlyKurus: 0 }, contacted: { count: 1, monthlyKurus: 90_000 }, demo: { count: 0, monthlyKurus: 0 }, offer: { count: 0, monthlyKurus: 0 }, won: { count: 1, monthlyKurus: 50_000 }, lost: { count: 1, monthlyKurus: 0 } },
  conversionPercent: 50,
  dueToday: 1,
});
const profitReport = () => ({
  from: '2025-12', to: '2026-11',
  unitCosts: { aiInputPerMillionKurus: 15_000, aiOutputPerMillionKurus: 60_000, smsSegmentKurus: 35, voipMinuteKurus: 50 },
  totals: { revenueKurus: 100_000, linkedExpenseKurus: 20_000, usageCostKurus: 3_000, smsUsageCostKurus: 500 },
  products: [
    { code: 'users', name: 'Kullanıcı lisansı', kind: null, revenueKurus: 80_000, expenseKurus: 0, usageCostKurus: 0, profitKurus: 80_000, marginPercent: 100 },
    { code: 'voip', name: 'Çağrı merkezi', kind: 'module', revenueKurus: 20_000, expenseKurus: 20_000, usageCostKurus: 3_000, profitKurus: -3_000, marginPercent: -15 },
  ],
  offices: [{ tenantId: office().id, name: hostile, slug: 'kotu', status: 'enabled', accessUntil: '2027-11-01T00:00:00Z', revenueKurus: 100_000, expenseKurus: 120_000,
    usage: { aiRequests: 12, aiInputTokens: 1000, aiOutputTokens: 500, smsSegments: 4, voipMinutes: 30 }, usageCostKurus: 3_000, usageCost: { ai: 1_000, sms: 500, voip: 1_500 }, profitKurus: -23_000, marginPercent: -23 }],
  indicators: { activeOffices: 1, expiredOffices: 0, lostOffices: 0, churnPercent: 0, renewalsThisMonth: 2, mrrKurus: 105_000, arpuKurus: 105_000, reach: [{ code: 'voip', name: 'Çağrı merkezi', offices: 1, percent: 100 }] },
});
const recurring = () => [{ id: 'r1', category: 'server', description: 'Sunucu kirası', vendor: 'Hetzner', amountKurus: 150_000, vatRatePercent: 20, tenantId: null, tenantName: null, moduleCode: 'voip', moduleName: 'Çağrı merkezi', dayOfMonth: 5, startsOn: '2026-01-01', endsOn: null, active: true, lastPeriod: '2026-11' }];
const ticket = (extra = {}) => ({
  id: '33333333-3333-4333-8333-333333333333', number: 7, tenantId: office().id, officeName: hostile, officeSlug: 'kotu',
  subject: hostile, category: 'technical', priority: 'urgent', status: 'open', channel: 'phone', contactName: 'Ayşe', contactInfo: '0532',
  assignedTo: null, createdAt: '2026-11-10T09:00:00Z', updatedAt: '2026-11-10T09:00:00Z', responseDueAt: '2026-11-10T13:00:00Z',
  firstResponseAt: null, resolvedAt: null, overdue: true, ...extra,
});
const support = () => ({
  tickets: [ticket()],
  summary: { open: 1, waitingCustomer: 0, urgent: 1, overdue: 1, resolvedLast30Days: 0, avgFirstResponseHours: null },
  access: {},
});
// Remote support access grants, as the platform API returns them (GET support/:id/access).
const grant = (extra = {}) => ({
  id: 'a1', ticketId: ticket().id, status: 'pending', state: 'pending', minutes: 15, allowEdit: false, grantedBy: 'Ayşe Yılmaz', grantedByUser: '5',
  offerUntil: '2026-11-12T14:30:00Z', startedAt: null, deadline: null, remainingSeconds: null, selfExtended: false, extensionRequest: null,
  endedAt: null, endedBy: null, connectedBy: null, ...extra,
});
const connectedGrant = (extra = {}) =>
  grant({ status: 'active', state: 'connected', startedAt: '2026-11-12T09:50:00Z', deadline: '2026-11-12T10:05:00Z', remainingSeconds: 840, connectedBy: 'Operatör', ...extra });
const overtimeGrant = (extra = {}) => connectedGrant({ state: 'overtime', remainingSeconds: 0, deadline: '2026-11-12T09:59:00Z', ...extra });
const closedGrant = (extra = {}) =>
  grant({ status: 'ended', state: 'closed', startedAt: '2026-11-12T09:00:00Z', deadline: '2026-11-12T09:15:00Z', remainingSeconds: 0, endedAt: '2026-11-12T09:12:00Z', endedBy: 'Ayşe Yılmaz', connectedBy: 'Operatör', ...extra });
const ACCESS_URL = 'https://kotu.han.example.com/api/support-access/enter?code=abc123';
const salesReport = () => ({
  month: '2026-11',
  sales: [
    { id: 's1', tenantId: office().id, tenantName: hostile, kind: 'new_office', description: hostile, status: 'paid', invoiceNo: null, amountKurus: 100_000, vatRatePercent: 20, vatKurus: 20_000, grossKurus: 120_000, createdAt: '2026-11-02T00:00:00Z', paidAt: '2026-11-03T00:00:00Z' },
    { id: 's2', tenantId: office().id, tenantName: hostile, kind: 'module', description: 'Modül', status: 'pending', invoiceNo: null, amountKurus: 50_000, vatRatePercent: 10, vatKurus: 5_000, grossKurus: 55_000, createdAt: '2026-11-04T00:00:00Z', paidAt: null },
  ],
  collected: { netKurus: 100_000, vatKurus: 20_000, grossKurus: 120_000, count: 1 },
  pending: { netKurus: 50_000, vatKurus: 5_000, grossKurus: 55_000, count: 1 },
  byRate: [{ ratePercent: 20, netKurus: 100_000, vatKurus: 20_000, grossKurus: 120_000, count: 1 }],
});
const expensesReport = () => ({
  month: '2026-11',
  expenses: [{ id: 'e1', spentOn: '2026-11-05', category: 'advertising', description: hostile, vendor: 'Google', invoiceNo: null, status: 'active', tenantId: null, tenantName: null, moduleCode: 'voip', moduleName: 'Çağrı merkezi', recurring: true, amountKurus: 50_000, vatRatePercent: 20, vatKurus: 10_000, grossKurus: 60_000, voidReason: null }],
  byCategory: [{ category: 'advertising', netKurus: 50_000, vatKurus: 10_000, grossKurus: 60_000, count: 1 }],
  total: { netKurus: 50_000, vatKurus: 10_000, grossKurus: 60_000, count: 1 },
});
const financeSummary = () => {
  const months = Array.from({ length: 12 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}`, salesNetKurus: 0, salesVatKurus: 0, salesGrossKurus: 0, costNetKurus: 0, costVatKurus: 0, costGrossKurus: 0, profitKurus: 0, vatPayableKurus: 0, acquisitionKurus: 0, newOffices: 0, costPerNewOfficeKurus: null }));
  months[10] = { ...months[10], salesNetKurus: 100_000, salesVatKurus: 20_000, salesGrossKurus: 120_000, costNetKurus: 50_000, costVatKurus: 10_000, costGrossKurus: 60_000, profitKurus: 50_000, vatPayableKurus: 10_000, acquisitionKurus: 50_000, newOffices: 1, costPerNewOfficeKurus: 50_000 };
  return { months, totals: { salesNetKurus: 100_000, salesVatKurus: 20_000, salesGrossKurus: 120_000, costNetKurus: 50_000, costVatKurus: 10_000, profitKurus: 50_000, vatPayableKurus: 10_000 } };
};

// accessList: the grants GET support/:id/access returns (mutate it between steps); accessReplies:
// per-action overrides (connect, extend, request-extension, end) as (reply, body) => response;
// fakeTime: manual setInterval/clearInterval and Date.now so a countdown can be stepped.
function setup({ session = { admin: { id: 'a', name: 'Operatör', username: 'root' } }, dashboardStatus = 200, login = null, accessList = [], accessReplies = {}, tickets = null, detailTicket = {}, fakeTime = false } = {}) {
  const dom = new JSDOM(html, { url: 'https://admin.han.example.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function (value) {
    if (value !== undefined) this.returnValue = value;
    this.open = false;
    this.dispatchEvent(new w.Event('close'));
  };
  const timers = { intervals: new Map(), next: 0, now: Date.parse('2026-11-12T10:00:00Z') };
  timers.tick = (seconds = 1) => {
    timers.now += seconds * 1000;
    for (const fn of [...timers.intervals.values()]) fn();
  };
  if (fakeTime) {
    w.setInterval = (fn) => (timers.intervals.set(++timers.next, fn), timers.next);
    w.clearInterval = (id) => void timers.intervals.delete(id);
    w.Date.now = () => timers.now;
  }
  const openGrants = () => Object.fromEntries(accessList.filter((a) => a.state !== 'closed').map((a) => [a.ticketId, a]));
  const requests = [];
  w.fetch = async (url, options = {}) => {
    const route = url.replace('/api/platform/', '');
    requests.push({ route, method: options.method || 'GET', headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : undefined });
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (route === 'session') return reply(200, session);
    if (route === 'dashboard') return dashboardStatus === 200 ? reply(200, dashboard()) : reply(dashboardStatus, { error: 'Oturum açmanız gerekiyor.' });
    if (route === 'modules' && options.method !== 'POST') return reply(200, modules());
    if (route === 'support' && options.method !== 'POST') return reply(200, { ...support(), ...(tickets ? { tickets } : {}), access: openGrants() });
    const accessGet = /^support\/([^/]+)\/access$/.exec(route);
    if (accessGet && options.method !== 'POST') return reply(200, { access: accessList.filter((a) => a.ticketId === accessGet[1]) });
    const accessAction = /^support\/[^/]+\/access\/(connect|extend|request-extension|end)$/.exec(route);
    if (accessAction && options.method === 'POST') {
      const body = JSON.parse(options.body || '{}');
      if (accessReplies[accessAction[1]]) return accessReplies[accessAction[1]](reply, body);
      return reply(200, { connect: { url: ACCESS_URL, expiresInSeconds: 120 }, extend: { deadline: '2026-11-12T10:20:00Z' }, 'request-extension': { requested: { minutes: body.minutes } }, end: { ended: true } }[accessAction[1]]);
    }
    if (route.startsWith('support/') && options.method !== 'POST')
      return reply(200, { ticket: ticket(detailTicket), messages: [{ id: '1', kind: 'customer', body: hostile, createdAt: '2026-11-10T09:00:00Z', author: 'Operatör' }, { id: '2', kind: 'internal', body: 'iç not', createdAt: '2026-11-10T09:05:00Z', author: 'Operatör' }, { id: '3', kind: 'system', body: 'Ayşe Yılmaz destek ekibine 15 dk erişim izni verdi (yalnızca görüntüleme).', createdAt: '2026-11-12T09:30:00Z', author: 'Ayşe Yılmaz' }] });
    if (route.startsWith('sales')) return reply(200, salesReport());
    if (route.startsWith('expenses') && options.method !== 'POST') return reply(200, expensesReport());
    if (route === 'finance') return reply(200, financeSummary());
    if (route.startsWith('profit')) return reply(200, profitReport());
    if (route === 'recurring-expenses' && options.method !== 'POST') return reply(200, { recurring: recurring() });
    if (route === 'campaigns' && options.method !== 'POST') return reply(200, { campaigns: [campaign(), campaign({ id: 'c2', name: 'Eski kampanya', status: 'paused', live: false, couponCode: null })] });
    if (route === 'campaigns/quote') {
      const body = JSON.parse(options.body);
      if (body.couponCode === 'BITTI') return reply(409, { error: 'Kampanyanın süresi doldu.' });
      return reply(200, { campaign: { id: 'c1', name: 'Kasım fırsatı' }, lines: body.lines.map((l) => ({ ...l, discountKurus: 5000 })), discountKurus: 5000 * body.lines.length });
    }
    if (route === 'announcements' && options.method !== 'POST') return reply(200, { announcements: [announcement()] });
    if (route.startsWith('prospects/') && options.method !== 'POST') {
      const id = route.split('/')[1];
      return reply(200, { prospect: id === 'p2' ? officeRequest() : prospect(), notes: [{ id: 1, body: 'Aşama: contacted', at: '2026-10-21T09:00:00Z', by: 'Operatör' }] });
    }
    if (route.startsWith('prospects') && options.method !== 'POST') return reply(200, prospects());
    if (route === `offices/${office().id}/products/sell`) return reply(200, { saleId: 's9', amountKurus: 50_000, campaignDiscountKurus: 5_000, payableKurus: 45_000, vatKurus: 9_000 });
    if (route === `offices/${office().id}/modules/trial`) return reply(200, { moduleCode: 'ai-assistant', days: 14, trialUntil: '2026-11-26T09:00:00Z' });
    if (options.method === 'POST' && /^(campaigns|announcements|prospects|recurring-expenses|modules)/.test(route)) return reply(200, { id: 'new' });
    if (route === 'settings/unit-costs') return reply(200, JSON.parse(options.body));
    if (options.method === 'POST' && /^(support|expenses)/.test(route)) return reply(200, { id: 'new', number: 8 });
    if (route === 'offices' && options.method === 'POST') return reply(200, { office: { id: 'x', name: 'Yeni' }, payableKurus: 1_250_000 });
    if (route === 'login') return login ? login(JSON.parse(options.body), reply) : reply(200, { admin: { id: 'a', name: 'Operatör', username: 'root' } });
    if (route === 'account' && options.method !== 'POST') return reply(200, { username: 'root', name: 'Operatör', totpEnabled: false, recoveryCodesLeft: 0, totpRequired: false });
    if (route === 'operators' && options.method !== 'POST')
      return reply(200, { operators: [{ id: 'a', username: 'root', name: 'Operatör', active: true, totpEnabled: false, createdAt: '2026-11-01T00:00:00Z' }, { id: 'b', username: 'kotu', name: hostile, active: true, totpEnabled: true, createdAt: '2026-11-02T00:00:00Z' }], audit: [{ id: '1', action: 'operator.add', target: hostile, by: 'root', createdAt: '2026-11-02T00:00:00Z' }] });
    if (route === 'account/totp/start') return reply(200, { secret: 'ABCD EFGH IJKL', uri: 'otpauth://totp/x' });
    if (route === 'account/totp/confirm') return reply(200, { recoveryCodes: ['AAAAA-BBBBB', 'CCCCC-DDDDD'] });
    if (route === 'settings/sms' && options.method !== 'POST')
      return reply(200, { configured: true, enabled: true, username: '908501234567', header: 'HANHUKUK', usage: { monthSent: 4, monthSegments: 5, failed30: 1, blocked30: 0 }, recent: [{ id: '1', purpose: 'password_recovery', dest: '90532*****67', status: 'sent', error: null, createdAt: '2026-11-10T09:00:00Z', office: hostile }], dailyLimitPerOffice: 30 });
    if (route === 'settings/sms/test') return reply(200, { ok: true, balance: 1250, headers: ['HANHUKUK'] });
    if (route === 'settings/sms' && options.method === 'POST') return reply(200, { configured: true, enabled: false, username: '908501234567', header: 'HANHUKUK' });
    if (route === `offices/${office().id}` && options.method !== 'POST')
      return reply(200, { office: office(), modules: [{ code: 'whatsapp', name: 'WhatsApp', priceKurus: 3000, status: 'trial', addedAt: '2026-11-01T00:00:00Z', trialUntil: '2099-01-15T09:00:00Z' }], sales: [], events: [{ action: 'manager_password_reset', createdAt: '2026-11-10T09:00:00Z', admin: 'root', detail: { mode: 'sms' } }], costKurus: 0, payments: [] });
    if (route === `offices/${office().id}/managers`) return reply(200, { managers: [{ id: 'm1', name: hostile, username: 'ceo', role: 'ceo', phone: '90555*****33' }] });
    if (route === `offices/${office().id}/managers/reset`) {
      const body = JSON.parse(options.body);
      return reply(200, body.mode === 'password' ? { mode: 'password', username: 'ceo', temporaryPassword: 'Tmp-Pass-1234' } : { mode: 'sms', username: 'ceo', phone: '90555*****33' });
    }
    if (options.method === 'POST' && /^(account|operators)/.test(route)) return reply(200, { ok: true });
    return reply(404, { error: 'yok' });
  };
  w.eval(source);
  return { w, requests, timers };
}
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const button = (w, text) => [...w.document.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const field = (w, label) => [...w.document.querySelectorAll('dialog label')].find((l) => l.textContent.includes(label)).querySelector('input,select,textarea');

test('console renders operator-typed text as text and shows totals', async () => {
  const { w } = setup();
  await settle();
  const doc = w.document;
  assert.match(doc.body.textContent, /Satış özeti/);
  assert.match(doc.body.textContent, /Aktif büro/);
  assert.equal(doc.querySelectorAll('svg rect.bar').length, 12);
  button(w, 'Bürolar').click();
  assert.ok(doc.body.textContent.includes(hostile), 'name is displayed literally');
  assert.equal(doc.querySelectorAll('img').length, 0, 'no element was created from the name');
  assert.equal(w.pwned, undefined);
  button(w, 'Satışlar').click();
  await settle();
  assert.equal(doc.querySelectorAll('img').length, 0);
  assert.ok(button(w, 'Tahsil et'));
});

test('selling an office sends integer kuruş and operator-typed values, never totals', async () => {
  const { w, requests } = setup();
  await settle();
  button(w, 'Yeni büro sat').click();
  const doc = w.document;
  const set = (label, value) => { field(w, label).value = value; };
  set('Büro adı', 'Yeni Hukuk');
  set('Büro kodu', 'yeni-hukuk');
  set('İlk yönetici adı', 'Ada Yönetici');
  set('İlk yönetici kullanıcı adı', 'ada');
  set('Geçici şifre', 'Gecici-Sifre-123');
  set('Kullanıcı (çalışan) sayısı', '5');
  set('Kullanıcı başı aylık fiyat', '200,00');
  set('İndirim', '100');
  field(w, 'Çağrı merkezi').checked = true;
  field(w, 'Tahsilat yapıldı').checked = true;
  doc.querySelector('dialog form').dispatchEvent(new w.Event('input', { bubbles: true }));
  const preview = doc.querySelector('.preview').textContent;
  assert.match(preview, /12\.600,00/, preview);
  assert.match(preview, /12\.500,00/, preview);
  assert.match(preview, /KDV \(%20\)/, preview);
  assert.match(preview, /15\.000,00/, 'KDV dahil: 12.500,00 + 2.500,00 KDV');
  doc.querySelector('dialog form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  const sale = requests.find((r) => r.route === 'offices' && r.method === 'POST');
  assert.equal(sale.headers['X-Han-Request'], '1');
  assert.deepEqual(sale.body, {
    slug: 'yeni-hukuk', name: 'Yeni Hukuk', userCount: 5, userPriceKurus: 20000, termMonths: 12,
    moduleCodes: ['voip'], discountKurus: 10000, vatRatePercent: 20, paid: true,
    admin: { name: 'Ada Yönetici', username: 'ada', password: 'Gecici-Sifre-123' },
  });
  assert.equal(doc.querySelectorAll('dialog').length, 0, 'dialog closes on success');
  assert.ok(requests.filter((r) => r.route === 'dashboard').length >= 2, 'data is reloaded after a sale');
});

test('invalid amounts are rejected in the browser before any request', async () => {
  const { w, requests } = setup();
  await settle();
  button(w, 'Yeni büro sat').click();
  const set = (label, value) => { field(w, label).value = value; };
  set('Büro adı', 'X Hukuk'); set('Büro kodu', 'x-hukuk'); set('İlk yönetici adı', 'A'); set('İlk yönetici kullanıcı adı', 'a');
  set('Geçici şifre', 'Gecici-Sifre-123'); set('Kullanıcı başı aylık fiyat', '12,345');
  w.document.querySelector('dialog form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.match(w.document.querySelector('.formerror').textContent, /geçersiz/);
  assert.equal(requests.filter((r) => r.method === 'POST').length, 0);
});

test('a missing or expired session shows the sign-in form', async () => {
  for (const options of [{ session: { admin: null } }, { dashboardStatus: 401 }]) {
    const { w } = setup(options);
    await settle();
    assert.ok(w.document.querySelector('input[type=password]'), JSON.stringify(options));
    assert.ok(!w.document.body.textContent.includes('Satış özeti'));
  }
});

test('sales tab shows KDV per row and the month-end totals; text stays text', async () => {
  const { w, requests } = setup();
  await settle();
  button(w, 'Satışlar').click();
  await settle();
  const doc = w.document;
  assert.ok(requests.some((r) => r.route.startsWith('sales')), 'sales are loaded for the selected month');
  const text = doc.body.textContent;
  for (const expected of [/Ay sonu tahsilat — KDV hariç/, /Ay sonu tahsilat — KDV dahil/, /1\.200,00/, /200,00/, /%20/, /%10/, /KDV oranına göre/, /Ay sonu toplam \(tahsil edilen\)/])
    assert.match(text, expected, String(expected));
  assert.ok(text.includes(hostile));
  assert.equal(doc.querySelectorAll('img').length, 0);
  assert.equal(w.pwned, undefined);
  const footer = doc.querySelector('tfoot tr.total').textContent;
  assert.match(footer, /1\.000,00/);
  assert.match(footer, /1\.200,00/);
});

test('expenses and finance tabs render totals; an expense is sent in kuruş with its own KDV rate', async () => {
  const { w, requests } = setup();
  await settle();
  button(w, 'Kârlılık').click();
  await settle();
  assert.match(w.document.body.textContent, /Ödenecek KDV/);
  assert.match(w.document.body.textContent, /Büro başına reklam-pazarlama/);
  button(w, 'Giderler').click();
  await settle();
  assert.match(w.document.body.textContent, /Aylık gider — KDV hariç/);
  assert.ok(w.document.body.textContent.includes(hostile));
  button(w, 'Gider ekle').click();
  const set = (label, value) => { field(w, label).value = value; };
  set('Tarih (YYYY-AA-GG)', '2026-11-05');
  set('Açıklama', 'Sunucu faturası');
  set('Tutar (TL, KDV hariç)', '1.250,50');
  set('KDV oranı (%)', '10');
  field(w, 'Kategori').value = 'server';
  w.document.querySelector('dialog form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  const sent = requests.find((r) => r.route === 'expenses' && r.method === 'POST');
  assert.equal(sent.headers['X-Han-Request'], '1');
  assert.deepEqual(sent.body, { spentOn: '2026-11-05', category: 'server', description: 'Sunucu faturası', amountKurus: 125050, vatRatePercent: 10 });
});

test('support tab lists tickets as text, flags overdue ones and sends a reply', async () => {
  const { w, requests } = setup();
  await settle();
  button(w, 'Destek').click();
  const doc = w.document;
  assert.match(doc.body.textContent, /Yanıt hedefi aşıldı/);
  assert.match(doc.body.textContent, /#7/);
  assert.ok(doc.body.textContent.includes(hostile));
  assert.equal(doc.querySelectorAll('img').length, 0);
  button(w, 'Aç').click();
  await settle();
  assert.ok(doc.querySelector('dialog .msg.internal'), 'internal notes are marked');
  assert.equal(doc.querySelectorAll('img').length, 0);
  assert.equal(w.pwned, undefined);
  doc.querySelector('dialog textarea').value = 'Sorunu inceliyoruz.';
  button(w, 'Gönder').click();
  await settle();
  const reply = requests.find((r) => r.route.endsWith('/messages') && r.method === 'POST');
  assert.equal(reply.route, 'support/33333333-3333-4333-8333-333333333333/messages');
  assert.deepEqual(reply.body, { kind: 'operator', body: 'Sorunu inceliyoruz.' });
});

test('products tab says which add-ons the application actually enforces', async () => {
  const { w } = setup();
  await settle();
  button(w, 'Ürünler').click();
  const text = w.document.body.textContent;
  assert.match(text, /Satılmayan büroda özellik kapalıdır/);
  assert.match(text, /Uygulamada henüz özellik kapısı yok/);
});

test('sign-in asks for the authenticator code only when the account has one, then sends it', async () => {
  const { w, requests } = setup({
    session: { admin: null },
    login: (body, reply) =>
      body.code
        ? reply(200, { admin: { id: 'a', name: 'Operatör', username: 'root' } })
        : reply(401, { error: 'Doğrulama kodunu girin.', totpRequired: true }),
  });
  await settle();
  const code = w.document.querySelector('input[autocomplete=one-time-code]');
  assert.ok(code.closest('label').hidden, 'the code field is hidden until the server asks for it');
  w.document.querySelector('input[type=text]').value = 'root';
  w.document.querySelector('input[type=password]').value = 'Synthetic-Password-123';
  w.document.querySelector('form').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  assert.equal(code.closest('label').hidden, false);
  assert.match(w.document.querySelector('.formerror').textContent, /Doğrulama kodunu girin/);
  code.value = '123456';
  w.document.querySelector('form').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  const logins = requests.filter((r) => r.route === 'login');
  assert.equal(logins.length, 2);
  assert.equal(logins[0].body.code, undefined);
  assert.equal(logins[1].body.code, '123456');
  assert.ok(requests.some((r) => r.route === 'dashboard'), 'console loads after the second factor');
});

test('Yönetim tab lists operators as text and walks through enabling two-factor', async () => {
  const { w, requests } = setup();
  await settle();
  button(w, 'Yönetim').click();
  await settle();
  const text = w.document.body.textContent;
  assert.match(text, /İki aşamalı doğrulama/);
  assert.match(text, /Kötü Büro/);
  assert.equal(w.document.querySelector('img'), null, 'operator-typed names never become markup');
  assert.equal(w.pwned, undefined);
  assert.match(text, /Operatör ekledi/);

  button(w, 'Etkinleştir').click();
  await settle();
  assert.match(w.document.body.textContent, /ABCD EFGH IJKL/);
  field(w, 'Doğrulama kodu').value = '654321';
  button(w, 'Doğrula ve aç').click();
  await settle();
  const confirm = requests.find((r) => r.route === 'account/totp/confirm');
  assert.deepEqual(confirm.body, { code: '654321' });
  assert.equal(w.document.querySelector('pre.recovery').textContent, 'AAAAA-BBBBB\nCCCCC-DDDDD');
});

test('when two-factor is required and missing, only the account page is reachable', async () => {
  const { w, requests } = setup({ session: { admin: { id: 'a', name: 'Operatör', username: 'root' }, totpSetupRequired: true } });
  await settle();
  assert.ok(!requests.some((r) => r.route === 'dashboard'), 'no console data is requested');
  const tabs = [...w.document.querySelectorAll('nav.tabs button')].map((b) => b.textContent);
  assert.deepEqual(tabs, ['Yönetim']);
  assert.match(w.document.body.textContent, /iki aşamalı doğrulama zorunludur/);
  assert.ok(!w.document.body.textContent.includes('Operatörler'), 'operator management stays locked');
});

test('office detail: an operator resets the office CEO and sees the temporary password once', async () => {
  const { w, requests } = setup();
  await settle();
  button(w, 'Bürolar').click();
  await settle();
  button(w, 'Yönet').click();
  await settle();
  assert.match(w.document.body.textContent, /Yönetici şifresi sıfırlandı/);
  button(w, 'Yönetici şifresi').click();
  await settle();
  const account = field(w, 'Hesap');
  assert.match(account.options[0].textContent, /Kötü Büro.*CEO.*tel 90555\*\*\*\*\*33/);
  assert.equal(w.document.querySelector('dialog img'), null, 'names stay text');
  field(w, 'Yöntem').value = 'password';
  button(w, 'Sıfırla').click();
  await settle();
  const reset = requests.find((r) => r.route.endsWith('/managers/reset'));
  assert.deepEqual(reset.body, { userId: 'm1', mode: 'password' });
  const shown = [...w.document.querySelectorAll('dialog input')].find((i) => i.value === 'Tmp-Pass-1234');
  assert.ok(shown, 'the temporary password is shown in a dialog');
  assert.match(w.document.body.textContent, /bir daha gösterilmez/);
});

test('Yönetim tab: platform SMS settings show usage as text, test the connection and never resend a blank password', async () => {
  const { w, requests } = setup();
  await settle();
  button(w, 'Yönetim').click();
  await settle();
  const text = w.document.body.textContent;
  assert.match(text, /SMS \(Verimor\) — platform hesabı/);
  assert.match(text, /Bu ay 4 SMS \(5 kredi\)/);
  assert.match(text, /90532\*\*\*\*\*67/);
  assert.match(text, /izin verilen sunucu IP/);
  assert.equal(w.document.querySelector('img'), null);
  button(w, 'Bağlantıyı test et').click();
  await settle();
  assert.match(w.document.body.textContent, /Kalan kredi: 1250/);
  const save = [...w.document.querySelectorAll('form.smsform button[type=submit]')][0];
  w.document.querySelector('form.smsform input[type=checkbox]').checked = false;
  save.click();
  await settle();
  const saved = requests.find((r) => r.route === 'settings/sms' && r.method === 'POST');
  assert.deepEqual(saved.body, { username: '908501234567', header: 'HANHUKUK', enabled: false }, 'blank password is not sent');
});

// ---------- sales screens: products, trials, campaigns, announcements, pipeline, profit ----------
const submitLast = (w) =>
  [...w.document.querySelectorAll('dialog form')].pop().dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
const change = (w, input, value) => {
  input.value = value;
  input.dispatchEvent(new w.Event('change', { bubbles: true }));
};
const typed = (w) => w.document.querySelector('dialog form').dispatchEvent(new w.Event('input', { bubbles: true }));
// The input whose label text is exactly `text` (a label's text also contains its select options).
const exact = (w, text) =>
  [...w.document.querySelectorAll('dialog label.field, dialog div.field')]
    .find((l) => l.querySelector(':scope > span')?.textContent === text)
    .querySelector('input,select,textarea');
const hiddenRow = (input) => input.closest('label, .field').hidden;
const posted = (requests, route) => requests.filter((r) => r.route === route && r.method === 'POST');

test('the console never builds markup from strings', () => {
  assert.doesNotMatch(source, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write|createContextualFragment/);
});

test('overview adds light sales cards: live campaigns and open office requests', async () => {
  const { w } = setup();
  await settle();
  const text = w.document.body.textContent;
  assert.match(text, /Yayındaki kampanya1/);
  assert.match(text, /Büro talepleri2/);
  const tabs = [...w.document.querySelectorAll('nav.tabs button')].map((b) => b.textContent);
  assert.deepEqual(tabs, ['Genel bakış', 'Bürolar', 'Satış hunisi', 'Satışlar', 'Ürünler', 'Kampanyalar', 'Duyurular', 'Giderler', 'Kârlılık', 'Destek', 'Yönetim']);
});

test('products: the kind decides which fields the form shows and what the price is called', async () => {
  const { w, requests } = setup();
  await settle();
  button(w, 'Ürünler').click();
  const text = w.document.body.textContent;
  assert.match(text, /Tüm fiyatlar KDV hariçtir/);
  assert.match(text, /Kullanım paketi/);
  assert.match(text, /Yakında/);
  assert.match(text, /250,00 \/ paket \(1\.000 SMS\)/);
  assert.match(text, /14 gün deneme/);
  button(w, 'Yeni ürün').click();
  const dialogText = () => w.document.querySelector('dialog').textContent;
  assert.equal(hiddenRow(exact(w, 'Paket miktarı')), true);
  assert.equal(hiddenRow(exact(w, 'Deneme süresi (gün, 0–60)')), false);
  assert.match(dialogText(), /Aylık fiyat \(TL, KDV hariç\)/);
  change(w, exact(w, 'Tür'), 'usage_pack');
  assert.equal(hiddenRow(exact(w, 'Paket miktarı')), false);
  assert.equal(hiddenRow(exact(w, 'Paket birimi')), false);
  assert.equal(hiddenRow(exact(w, 'Deneme süresi (gün, 0–60)')), true);
  assert.match(dialogText(), /Paket fiyatı \(TL, KDV hariç\)/);
  change(w, exact(w, 'Tür'), 'service');
  assert.match(dialogText(), /Birim fiyat \(TL, KDV hariç\)/);
  assert.equal(hiddenRow(exact(w, 'Paket miktarı')), true);
  change(w, exact(w, 'Tür'), 'usage_pack');
  exact(w, 'Kod').value = 'sms-5000';
  exact(w, 'Ad').value = 'Büyük SMS paketi';
  exact(w, 'Durum').value = 'selling';
  exact(w, 'Paket fiyatı (TL, KDV hariç)').value = '250';
  exact(w, 'Paket miktarı').value = '5000';
  exact(w, 'Paket birimi').value = 'SMS';
  exact(w, 'Deneme süresi (gün, 0–60)').value = '30';
  exact(w, 'Özellikler (her satıra bir madde, en fazla 12)').value = 'Hızlı gönderim\n\nRapor ';
  submitLast(w);
  await settle();
  assert.deepEqual(posted(requests, 'modules')[0].body, {
    code: 'sms-5000', name: 'Büyük SMS paketi', description: '', monthlyPriceKurus: 25000, kind: 'usage_pack', status: 'selling',
    features: ['Hızlı gönderim', 'Rapor'], packQuantity: 5000, packUnit: 'SMS', sortOrder: 100,
  }, 'a hidden field (trial days) is not sent');
});

test('office detail: a trial shows its end date; a product sale previews the coupon inline and sends it', async () => {
  const { w, requests } = setup();
  await settle();
  button(w, 'Bürolar').click();
  button(w, 'Yönet').click();
  await settle();
  assert.match(w.document.body.textContent, /WhatsApp Deneme · .+ tarihine kadar/);
  assert.ok(button(w, 'Deneme başlat'));
  button(w, 'Ürün sat').click();
  exact(w, 'Adet').value = '2';
  exact(w, 'veya kupon kodu').value = 'bitti';
  typed(w);
  await settle();
  const preview = () => [...w.document.querySelectorAll('dialog .preview')].pop().textContent;
  assert.match(preview(), /Kampanya uygulanamaz: Kampanyanın süresi doldu\./, 'a refused coupon is shown, not thrown');
  assert.match(preview(), /500,00/);
  exact(w, 'veya kupon kodu').value = 'kasim20';
  typed(w);
  await settle();
  assert.match(preview(), /Kampanya “Kasım fırsatı”: − ₺50,00 · kampanya sonrası KDV hariç ₺450,00/);
  assert.deepEqual(posted(requests, 'campaigns/quote').pop().body, {
    couponCode: 'KASIM20', tenantId: office().id, lines: [{ code: 'sms-paket', amountKurus: 50000, quantity: 2, oneOff: true }],
  });
  field(w, 'Tahsilat yapıldı').checked = true;
  submitLast(w);
  await settle();
  assert.deepEqual(posted(requests, `offices/${office().id}/products/sell`)[0].body, {
    code: 'sms-paket', quantity: 2, paid: true, vatRatePercent: 20, couponCode: 'KASIM20',
  });
  assert.match(w.document.getElementById('toast').textContent, /KDV hariç ₺450,00.*kampanya indirimi ₺50,00/);
});

test('office detail: starting a trial sends the module and leaves the days to the product default', async () => {
  const { w, requests } = setup();
  await settle();
  button(w, 'Bürolar').click();
  button(w, 'Yönet').click();
  await settle();
  button(w, 'Deneme başlat').click();
  const select = exact(w, 'Modül');
  assert.deepEqual([...select.options].map((o) => o.value), ['voip', 'ai-assistant'], 'the trialled module is not offered again');
  assert.match(select.options[1].textContent, /Yakında.*varsayılan 14 gün/);
  select.value = 'ai-assistant';
  submitLast(w);
  await settle();
  assert.deepEqual(posted(requests, `offices/${office().id}/modules/trial`)[0].body, { moduleCode: 'ai-assistant' });
});

test('campaigns: results and usage are listed; a new campaign is sent with exact values; pausing works', async () => {
  const { w, requests } = setup();
  await settle();
  button(w, 'Kampanyalar').click();
  await settle();
  const text = w.document.body.textContent;
  for (const expected of [/Kasım fırsatı/, /%20 indirim/, /İlk 3 ay/, /3 \/ 100/, /3\.000,00/, /300,00/, /Yayında/, /Durduruldu/, /KASIM20/, /Çağrı merkezi/])
    assert.match(text, expected, String(expected));
  button(w, 'Durdur').click();
  await settle();
  assert.deepEqual(posted(requests, 'campaigns/c1/status')[0].body, { status: 'paused' });

  button(w, 'Yeni kampanya').click();
  exact(w, 'Kampanya adı').value = 'Yılbaşı';
  change(w, exact(w, 'İndirim türü'), 'amount');
  assert.equal(hiddenRow(exact(w, 'İndirim yüzdesi (1–100)')), true);
  assert.equal(hiddenRow(exact(w, 'İndirim tutarı (TL, KDV hariç)')), false);
  change(w, exact(w, 'İndirim türü'), 'percent');
  exact(w, 'İndirim yüzdesi (1–100)').value = '25';
  change(w, exact(w, 'İndirim süresi'), 'first_3_months');
  field(w, 'Kullanıcı lisansı').checked = true;
  field(w, 'Çağrı merkezi (Aylık modül)').checked = true;
  assert.equal(field(w, 'Kötü Büro').closest('.field').hidden, true, 'offices are asked only for a selected audience');
  change(w, exact(w, 'Kimler kullanabilir?'), 'selected');
  field(w, 'Kötü Büro').checked = true;
  exact(w, 'Başlangıç').value = '2026-11-15';
  exact(w, 'Bitiş (bu gün dahil)').value = '2026-12-31';
  exact(w, 'Kupon kodu (isteğe bağlı)').value = 'yilbasi';
  exact(w, 'Toplam kullanım sınırı (isteğe bağlı)').value = '50';
  typed(w);
  assert.match(w.document.querySelector('dialog .preview').textContent, /%25 indirim · İlk 3 ay · Kullanıcı lisansı, Çağrı merkezi · Seçili bürolar/);
  submitLast(w);
  await settle();
  assert.deepEqual(posted(requests, 'campaigns')[0].body, {
    name: 'Yılbaşı', discountType: 'percent', discountValue: 25, applies: 'first_3_months', productCodes: ['users', 'voip'],
    audience: 'selected', tenantIds: [office().id], startsAt: new Date(2026, 10, 15).toISOString(),
    endsAt: new Date(2026, 11, 31, 23, 59, 59).toISOString(), couponCode: 'YILBASI', maxUses: 50,
  });
  assert.equal(w.document.querySelectorAll('dialog').length, 0);
});

test('announcements: stats are listed and the preview draws the office card as text, with the sales rules', async () => {
  const { w, requests } = setup();
  await settle();
  button(w, 'Duyurular').click();
  await settle();
  const row = w.document.querySelector('tbody tr').textContent;
  assert.ok(row.includes(hostile), 'title is shown literally');
  assert.match(row, /Yeni ürün/);
  assert.match(row, /Ürünü almamış bürolar/);
  assert.match(row, /Yayında/);
  assert.deepEqual([...w.document.querySelectorAll('tbody tr td.num')].map((td) => td.textContent), ['50', '4', '9', '3', '2', '1']);
  assert.equal(w.document.querySelector('img'), null);

  button(w, 'Yeni duyuru').click();
  change(w, exact(w, 'Tür'), 'campaign');
  assert.equal(hiddenRow(exact(w, 'Kampanya')), false);
  assert.equal(hiddenRow(exact(w, 'Büroda kimler görsün?')), true, 'sales announcements go to managers only');
  exact(w, 'Başlık (en fazla 80 karakter)').value = hostile;
  exact(w, 'Metin (en fazla 400 karakter)').value = 'Yılsonuna kadar geçerli.';
  exact(w, 'Kampanya').value = 'c1';
  typed(w);
  const card = w.document.querySelector('dialog .anncard');
  assert.ok(card.textContent.includes(hostile));
  assert.match(card.textContent, /Yılsonuna kadar geçerli\./);
  assert.match(card.textContent, /Kampanya: Kasım fırsatı — %20 indirim, ilk 3 ay, kupon KASIM20/);
  assert.deepEqual([...card.querySelectorAll('.fakebtn')].map((b) => b.textContent), ['İncele', 'İlgileniyorum', 'Kapat']);
  assert.equal(card.querySelector('button'), null, 'the preview buttons are inert');
  assert.equal(w.document.querySelector('dialog img'), null);
  assert.match(w.document.querySelector('dialog .preview').textContent, /Görecekler: CEO ve yöneticiler · Herkes/);

  change(w, exact(w, 'Tür'), 'maintenance');
  assert.equal(hiddenRow(exact(w, 'Büroda kimler görsün?')), false);
  assert.deepEqual([...w.document.querySelectorAll('dialog .anncard .fakebtn')].map((b) => b.textContent), ['Kapat']);
  change(w, exact(w, 'Tür'), 'campaign');
  exact(w, 'Kampanya').value = '';
  submitLast(w);
  await settle();
  assert.match(w.document.querySelector('dialog .formerror').textContent, /Kampanya duyurusu için kampanya seçin/);
  assert.equal(posted(requests, 'announcements').length, 0);
  change(w, exact(w, 'Kimlere gösterilsin?'), 'trialing');
  exact(w, 'Kampanya').value = 'c1';
  submitLast(w);
  await settle();
  assert.match(w.document.querySelector('dialog .formerror').textContent, /Bu hedef kitle için ürün seçin/);
  exact(w, 'Ürün').value = 'voip';
  submitLast(w);
  await settle();
  const sent = posted(requests, 'announcements')[0].body;
  assert.equal(sent.kind, 'campaign');
  assert.equal(sent.campaignId, 'c1');
  assert.equal(sent.productCode, 'voip');
  assert.equal(sent.audience, 'trialing');
  assert.equal(sent.roles, 'managers');
  assert.equal(sent.title, hostile);
  assert.equal(sent.dismissible, true);
  assert.equal(sent.priority, 50);
});

test('pipeline: the board marks office requests; a prospect moves stage and is lost only with a reason', async () => {
  const { w, requests } = setup();
  await settle();
  button(w, 'Satış hunisi').click();
  await settle();
  const doc = w.document;
  assert.equal(doc.querySelectorAll('.stagecol').length, 6);
  const text = doc.body.textContent;
  assert.match(text, /Bugün aranacaklar1/);
  assert.match(text, /Dönüşüm oranı%50/);
  assert.match(doc.querySelector('.stagecol.contacted header').textContent, /Görüşüldü1₺900,00 \/ ay/);
  const request = doc.querySelector('.stagecol.new .pcard');
  assert.ok(request.textContent.includes(hostile));
  assert.match(request.textContent, /Büro talebi/);
  assert.match(request.textContent, /Ek satış/);
  assert.equal(doc.querySelector('img'), null);
  assert.ok(doc.querySelector('.stagecol.contacted .pcard.due'), 'an overdue next step is flagged');

  doc.querySelector('.stagecol.contacted .pcard').click();
  await settle();
  assert.match(doc.querySelector('dialog').textContent, /Aşama: Görüşüldü/, 'stage notes are shown in Turkish');
  button(w, '→ Demo').click();
  await settle();
  assert.deepEqual(posted(requests, 'prospects/p1/stage')[0].body, { stage: 'demo' });

  button(w, 'Kaybedildi').click();
  await settle();
  submitLast(w);
  await settle();
  assert.match([...doc.querySelectorAll('dialog .formerror')].pop().textContent, /Kaybetme nedeni gerekli/);
  assert.equal(posted(requests, 'prospects/p1/stage').length, 1);
  exact(w, 'Kaybetme nedeni').value = 'Fiyatı yüksek buldu';
  submitLast(w);
  await settle();
  assert.deepEqual(posted(requests, 'prospects/p1/stage')[1].body, { stage: 'lost', lostReason: 'Fiyatı yüksek buldu' });
});

test('pipeline: an office request shows who asked; a new-office prospect opens the prefilled sale with prospectId', async () => {
  const { w, requests } = setup();
  await settle();
  button(w, 'Satış hunisi').click();
  await settle();
  w.document.querySelector('.stagecol.new .pcard').click();
  await settle();
  assert.match(w.document.querySelector('dialog').textContent, /büronun kendi talebi: Ayşe \(CEO\)/);
  assert.ok(button(w, 'Modül ekle') && button(w, 'Ürün sat'), 'an upsell is sold on its office');
  assert.equal(button(w, 'Büro aç'), undefined);
  w.document.querySelector('dialog').close();

  w.document.querySelector('.stagecol.contacted .pcard').click();
  await settle();
  button(w, 'Büro aç').click();
  await settle();
  assert.equal(field(w, 'Büro adı').value, 'Yıldız Hukuk');
  assert.equal(field(w, 'Büro kodu').value, 'yildiz-hukuk');
  assert.equal(field(w, 'Kullanıcı (çalışan) sayısı').value, '4');
  assert.equal(field(w, 'İlk yönetici adı').value, 'Av. Deniz');
  assert.equal(field(w, 'Çağrı merkezi').checked, true);
  field(w, 'İlk yönetici kullanıcı adı').value = 'deniz';
  field(w, 'Geçici şifre').value = 'Gecici-Sifre-123';
  field(w, 'Kullanıcı başı aylık fiyat').value = '200';
  submitLast(w);
  await settle();
  const sale = posted(requests, 'offices')[0].body;
  assert.equal(sale.prospectId, 'p1');
  assert.equal(sale.name, 'Yıldız Hukuk');
  assert.deepEqual(sale.moduleCodes, ['voip']);
  assert.equal(sale.userCount, 4);
});

test('Kârlılık: product and office profit, the estimate note, recurring expenses and unit costs in kuruş', async () => {
  const { w, requests } = setup();
  await settle();
  button(w, 'Kârlılık').click();
  await settle();
  const doc = w.document;
  const text = doc.body.textContent;
  for (const expected of [
    /Ürün kârlılığı/, /Büro kârlılığı/, /Modül yaygınlığı/, /Aylık kâr \/ zarar ve KDV/, /Kayıp oranı/, /bu ay 2 yenileme/,
    /Kullanım maliyeti tahminidir; büro ve ürün kârını paylaştırmak için kullanılır\. Aylık kâr\/zarar yalnızca girilen giderlerle hesaplanır\./,
    /12 istek/, /1\.500 token/, /4 parça/, /30 dk/, /%-23/, /Sunucu kirası/, /Sunucu \/ altyapı/,
  ])
    assert.match(text, expected, String(expected));
  assert.ok(text.includes(hostile));
  assert.equal(doc.querySelector('img'), null);
  assert.equal(doc.querySelectorAll('tr.loss').length, 2, 'loss-making product and office are marked');

  button(w, 'Birim maliyetler').click();
  assert.equal(exact(w, 'Yapay zekâ: 1 milyon girdi token (TL)').value, '150,00');
  exact(w, 'Yapay zekâ: 1 milyon girdi token (TL)').value = '200';
  exact(w, 'SMS parçası (TL)').value = '0,40';
  submitLast(w);
  await settle();
  assert.deepEqual(posted(requests, 'settings/unit-costs')[0].body, {
    aiInputPerMillionKurus: 20000, aiOutputPerMillionKurus: 60000, smsSegmentKurus: 40, voipMinuteKurus: 50,
  });
  assert.ok(requests.filter((r) => r.route.startsWith('profit')).length >= 2, 'the report is reloaded with the new costs');

  button(w, 'Durdur').click();
  submitLast(w);
  await settle();
  assert.equal(posted(requests, 'recurring-expenses/r1/stop').length, 1);
});

test('expenses: an expense can be tied to a product; recurring rows are badged', async () => {
  const { w, requests } = setup();
  await settle();
  button(w, 'Giderler').click();
  await settle();
  const row = w.document.querySelectorAll('tbody tr')[1].textContent;
  assert.match(row, /Tekrarlayan/);
  assert.match(row, /Çağrı merkezi/);
  button(w, 'Gider ekle').click();
  exact(w, 'Açıklama').value = 'Yapay zekâ faturası';
  exact(w, 'Tutar (TL, KDV hariç)').value = '100';
  exact(w, 'Ürün (isteğe bağlı)').value = 'voip';
  submitLast(w);
  await settle();
  assert.equal(posted(requests, 'expenses')[0].body.moduleCode, 'voip');
});

// ---------- remote support access ----------
const TID = ticket().id;
const openFirstTicket = async (w) => {
  button(w, 'Destek').click();
  button(w, 'Aç').click();
  await settle();
};
const accessBox = (w) => w.document.querySelector('dialog .accessbox');
const boxButtons = (w) => [...accessBox(w).querySelectorAll('button')].map((b) => b.textContent);
const gets = (requests, route) => requests.filter((r) => r.route === route && r.method === 'GET').length;
const toastText = (w) => w.document.getElementById('toast')?.textContent;
const lastDialog = (w) => [...w.document.querySelectorAll('dialog')].pop();

test('access box: a pending grant shows duration, permission, who granted and until when; only connect and end are offered', async () => {
  const { w, requests } = setup({ accessList: [grant()] });
  await settle();
  await openFirstTicket(w);
  assert.equal(accessBox(w).hidden, false);
  const text = accessBox(w).textContent;
  assert.match(text, /Erişim izni/);
  assert.match(text, /Süre15 dk/);
  assert.match(text, /YetkiYalnızca görüntüleme/);
  assert.match(text, /İzni verenAyşe Yılmaz/);
  assert.match(text, /Bağlantı bekliyor · .+ saatine kadar/);
  assert.deepEqual(boxButtons(w), ['Büroya bağlan', 'Bağlantıyı bitir']);
  assert.ok(button(w, 'Çözüldü, test edin'));
  assert.equal(gets(requests, `support/${TID}/access`), 1, 'the grants are read when the detail opens');
  const system = w.document.querySelector('dialog .msg.system');
  assert.ok(system, 'access events written by the server are shown as system lines');
  assert.match(system.textContent, /Sistem/);
  assert.match(system.textContent, /destek ekibine 15 dk erişim izni verdi/);
});

test('access box: hidden without a grant, but "Çözüldü, test edin" stays on open tickets only', async () => {
  const { w } = setup();
  await settle();
  await openFirstTicket(w);
  assert.equal(accessBox(w).hidden, true);
  assert.ok(button(w, 'Çözüldü, test edin'));
  for (const status of ['resolved', 'closed']) {
    const other = setup({ detailTicket: { status } });
    await settle();
    await openFirstTicket(other.w);
    assert.equal(button(other.w, 'Çözüldü, test edin'), undefined, status);
  }
});

test('access box: connected shows a live mm:ss countdown, offers +15 dk only in the last five minutes, and ends in "Süre doldu"', async () => {
  const accessList = [connectedGrant({ remainingSeconds: 305, allowEdit: true })];
  const { w, timers } = setup({ fakeTime: true, accessList });
  await settle();
  await openFirstTicket(w);
  assert.match(accessBox(w).textContent, /Bağlı · kalan 05:05/);
  assert.match(accessBox(w).textContent, /Değişiklik yapabilir/);
  assert.match(accessBox(w).textContent, /BağlananOperatör/);
  assert.deepEqual(boxButtons(w), ['Büroya bağlan', 'Ek süre iste', 'Bağlantıyı bitir']);
  assert.equal(timers.intervals.size, 1);
  timers.tick(1);
  assert.match(accessBox(w).textContent, /Bağlı · kalan 05:04/);
  timers.tick(4);
  assert.match(accessBox(w).textContent, /Bağlı · kalan 05:00/);
  assert.deepEqual(boxButtons(w), ['Büroya bağlan', '+15 dk uzat', 'Ek süre iste', 'Bağlantıyı bitir'], 'the extension appears at five minutes');
  assert.equal(timers.intervals.size, 1, 'repainting does not stack timers');
  timers.tick(60);
  assert.match(accessBox(w).textContent, /Bağlı · kalan 04:00/);

  accessList.splice(0, 1, overtimeGrant({ allowEdit: true }));
  timers.tick(240);
  await settle();
  assert.match(accessBox(w).textContent, /Süre doldu/);
  assert.doesNotMatch(accessBox(w).textContent, /kalan/);
  assert.deepEqual(boxButtons(w), ['+15 dk uzat', 'Ek süre iste', 'Bağlantıyı bitir'], 'no connect once time is up');
  assert.equal(timers.intervals.size, 0, 'the countdown stops at zero');
});

test('access box: the self-extension is offered once, and a pending extension request replaces "Ek süre iste"', async () => {
  let ui = setup({ fakeTime: true, accessList: [connectedGrant({ remainingSeconds: 100, selfExtended: true })] });
  await settle();
  await openFirstTicket(ui.w);
  assert.deepEqual(boxButtons(ui.w), ['Büroya bağlan', 'Ek süre iste', 'Bağlantıyı bitir'], 'already extended once');

  ui = setup({ accessList: [overtimeGrant({ selfExtended: true })] });
  await settle();
  await openFirstTicket(ui.w);
  assert.deepEqual(boxButtons(ui.w), ['Ek süre iste', 'Bağlantıyı bitir']);

  ui = setup({ accessList: [overtimeGrant({ extensionRequest: { minutes: 30, note: 'Rapor bitmedi', at: '2026-11-12T10:00:00Z' } })] });
  await settle();
  await openFirstTicket(ui.w);
  assert.match(accessBox(ui.w).textContent, /Büro onayı bekleniyor: 30 dk/);
  assert.match(accessBox(ui.w).textContent, /Not: Rapor bitmedi/);
  assert.deepEqual(boxButtons(ui.w), ['+15 dk uzat', 'Bağlantıyı bitir']);
});

test('access box: the last closed grant is shown greyed with who ended it and no actions', async () => {
  const { w, timers } = setup({ fakeTime: true, accessList: [closedGrant()] });
  await settle();
  await openFirstTicket(w);
  assert.equal(accessBox(w).hidden, false);
  assert.ok(accessBox(w).classList.contains('closed'));
  assert.match(accessBox(w).textContent, /Kapandı: Ayşe Yılmaz/);
  assert.match(accessBox(w).textContent, /Son erişim izni/);
  assert.deepEqual(boxButtons(w), []);
  assert.ok(button(w, 'Çözüldü, test edin'), 'the ticket itself is still open');
  assert.equal(timers.intervals.size, 0);
  // a closed grant never shows on the list or the overview
  w.document.querySelector('dialog').close();
  assert.doesNotMatch(w.document.body.textContent, /Şu an bağlı|Erişim izni var/);
});

test('connect opens the one-time link in a new tab; refusals are shown as the server wrote them', async () => {
  const opened = [];
  const refusals = {
    403: 'Büroya bağlanmak için hesabınızda iki aşamalı doğrulamayı açın (Yönetim → Hesabım).',
    409: 'Erişim süresi doldu. Süreyi uzatın veya büroya ek süre talebi gönderin.',
  };
  for (const status of [200, 403, 409]) {
    const { w, requests } = setup({
      accessList: [grant()],
      accessReplies: status === 200 ? {} : { connect: (reply) => reply(status, { error: refusals[status] }) },
    });
    w.open = (...args) => opened.push(args);
    await settle();
    await openFirstTicket(w);
    opened.length = 0;
    button(w, 'Büroya bağlan').click();
    await settle();
    const sent = posted(requests, `support/${TID}/access/connect`);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].headers['X-Han-Request'], '1');
    if (status === 200) {
      assert.deepEqual(opened, [[ACCESS_URL, '_blank', 'noopener']]);
      assert.match(toastText(w), /yeni sekmede açılıyor/);
      assert.equal(gets(requests, `support/${TID}/access`), 2, 'the box is reloaded');
      assert.equal(gets(requests, `support/${TID}`), 2, 'and so are the messages');
    } else {
      assert.deepEqual(opened, [], 'nothing opens on a refusal');
      assert.equal(toastText(w), refusals[status]);
      assert.ok(w.document.getElementById('toast').classList.contains('error'));
    }
    assert.ok(button(w, 'Büroya bağlan') && !button(w, 'Büroya bağlan').disabled, 'the button works again');
  }
});

test('connect: a relative link from a local preview is opened as given', async () => {
  const opened = [];
  const { w } = setup({ accessList: [grant()], accessReplies: { connect: (reply) => reply(200, { url: '/api/support-access/enter?code=zzz', expiresInSeconds: 120 }) } });
  w.open = (...args) => opened.push(args);
  await settle();
  await openFirstTicket(w);
  button(w, 'Büroya bağlan').click();
  await settle();
  assert.deepEqual(opened, [['/api/support-access/enter?code=zzz', '_blank', 'noopener']]);
});

test('+15 dk uzat posts to extend and reloads; a refusal is shown', async () => {
  const { w, requests } = setup({ accessList: [overtimeGrant()] });
  await settle();
  await openFirstTicket(w);
  button(w, '+15 dk uzat').click();
  await settle();
  const sent = posted(requests, `support/${TID}/access/extend`);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, {});
  assert.match(toastText(w), /15 dakika uzatıldı/);
  assert.equal(gets(requests, `support/${TID}/access`), 2);

  const refused = setup({ accessList: [overtimeGrant()], accessReplies: { extend: (reply) => reply(409, { error: 'Ek 15 dakika zaten kullanıldı. Büroya ek süre talebi gönderin.' }) } });
  await settle();
  await openFirstTicket(refused.w);
  button(refused.w, '+15 dk uzat').click();
  await settle();
  assert.equal(toastText(refused.w), 'Ek 15 dakika zaten kullanıldı. Büroya ek süre talebi gönderin.');
});

test('"Ek süre iste" asks for 15, 30 or 60 minutes and an optional note, and sends exactly that', async () => {
  const { w, requests } = setup({ fakeTime: true, accessList: [connectedGrant()] });
  await settle();
  await openFirstTicket(w);
  button(w, 'Ek süre iste').click();
  const minutes = exact(w, 'Ek süre');
  assert.deepEqual([...minutes.options].map((o) => o.textContent), ['15 dk', '30 dk', '60 dk']);
  assert.equal(minutes.value, '15');
  minutes.value = '30';
  exact(w, 'Büroya not (isteğe bağlı)').value = 'Rapor bitmedi';
  submitLast(w);
  await settle();
  const route = `support/${TID}/access/request-extension`;
  assert.deepEqual(posted(requests, route)[0].body, { minutes: 30, note: 'Rapor bitmedi' });
  assert.match(toastText(w), /Ek süre isteği büroya iletildi/);
  assert.equal(gets(requests, `support/${TID}/access`), 2, 'the box is reloaded after the request');
  assert.equal(w.document.querySelectorAll('dialog').length, 1, 'the form closed; the ticket detail is still open');

  button(w, 'Ek süre iste').click();
  submitLast(w);
  await settle();
  assert.deepEqual(posted(requests, route)[1].body, { minutes: 15 }, 'a blank note is not sent');

  button(w, 'Ek süre iste').click();
  lastDialog(w).querySelector('button[type=button]').click(); // Vazgeç
  await settle();
  assert.equal(posted(requests, route).length, 2, 'cancelling sends nothing');
});

test('"Bağlantıyı bitir" asks first; confirming posts to end', async () => {
  const { w, requests } = setup({ fakeTime: true, accessList: [connectedGrant()] });
  const questions = [];
  let answer = false;
  w.confirm = (question) => (questions.push(question), answer);
  await settle();
  await openFirstTicket(w);
  button(w, 'Bağlantıyı bitir').click();
  await settle();
  assert.equal(questions.length, 1);
  assert.match(questions[0], /sonlandırılsın mı/);
  assert.equal(posted(requests, `support/${TID}/access/end`).length, 0, 'declined: nothing is sent');
  answer = true;
  button(w, 'Bağlantıyı bitir').click();
  await settle();
  const sent = posted(requests, `support/${TID}/access/end`);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, {});
  assert.match(toastText(w), /Bağlantı sonlandırıldı/);
});

test('"Çözüldü, test edin" sends an editable operator message and waits for the office', async () => {
  const { w, requests, timers } = setup({ fakeTime: true, accessList: [connectedGrant()] });
  await settle();
  await openFirstTicket(w);
  button(w, 'Çözüldü, test edin').click();
  assert.equal(lastDialog(w).querySelector('textarea').value, 'Sorun çözüldü, lütfen test edin. Sorun devam ederse bu kayda yazın.', 'prefilled');
  submitLast(w);
  await settle();
  const messages = posted(requests, `support/${TID}/messages`);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].body, {
    kind: 'operator', body: 'Sorun çözüldü, lütfen test edin. Sorun devam ederse bu kayda yazın.', status: 'waiting_customer',
  });
  assert.equal(w.document.querySelectorAll('dialog').length, 1, 'the ticket is reopened with fresh data');
  assert.equal(timers.intervals.size, 1, 'the old detail released its countdown when it reopened');

  button(w, 'Çözüldü, test edin').click();
  lastDialog(w).querySelector('textarea').value = 'Ayarı düzelttik, bir deneyin.';
  submitLast(w);
  await settle();
  assert.equal(posted(requests, `support/${TID}/messages`)[1].body.body, 'Ayarı düzelttik, bir deneyin.');

  button(w, 'Çözüldü, test edin').click();
  lastDialog(w).querySelector('textarea').value = '';
  submitLast(w);
  await settle();
  assert.match(lastDialog(w).querySelector('.formerror').textContent, /Mesaj gerekli/);
  assert.equal(posted(requests, `support/${TID}/messages`).length, 2, 'an empty message is not sent');
});

test('support list and overview: grants show as badges and a count of grants waiting for a connection', async () => {
  const other = (n, extra) => ticket({ id: `4444444${n}-4444-4444-8444-444444444444`, number: 10 + n, subject: 'Konu ' + n, ...extra });
  const tickets = [ticket(), other(1), other(2), other(3)];
  const accessList = [
    grant({ ticketId: tickets[0].id }),
    connectedGrant({ id: 'a2', ticketId: tickets[1].id }),
    overtimeGrant({ id: 'a3', ticketId: tickets[2].id }),
    closedGrant({ id: 'a4', ticketId: tickets[3].id }),
  ];
  const { w } = setup({ tickets, accessList });
  await settle();
  assert.match(w.document.body.textContent, /Bağlantı bekleyen izinler1/, 'overview card counts only pending grants');
  button(w, 'Destek').click();
  const rows = [...w.document.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('.badges').textContent);
  assert.equal(rows.length, 4);
  assert.match(rows[0], /Açık.*Erişim izni var/);
  assert.match(rows[1], /Şu an bağlı/);
  assert.match(rows[2], /Süre doldu/);
  assert.doesNotMatch(rows[3], /Erişim|bağlı|Süre/, 'a closed grant has no badge');

  const quiet = setup({ accessList: [connectedGrant()] });
  await settle();
  assert.doesNotMatch(quiet.w.document.body.textContent, /Bağlantı bekleyen izinler/, 'no card when nothing is waiting');
});

test('support list badges follow the grant when it changes inside the ticket detail', async () => {
  const accessList = [grant()];
  const { w } = setup({ fakeTime: true, accessList });
  w.open = () => {};
  await settle();
  button(w, 'Destek').click();
  assert.match(w.document.querySelector('tbody tr').textContent, /Erişim izni var/);
  button(w, 'Aç').click();
  await settle();
  accessList.splice(0, 1, connectedGrant());
  button(w, 'Büroya bağlan').click();
  await settle();
  assert.match(w.document.querySelector('tbody tr').textContent, /Şu an bağlı/);
  assert.doesNotMatch(w.document.querySelector('tbody tr').textContent, /Erişim izni var/);
  accessList.splice(0, 1, closedGrant());
  w.confirm = () => true;
  button(w, 'Bağlantıyı bitir').click();
  await settle();
  assert.doesNotMatch(w.document.querySelector('tbody tr').textContent, /Şu an bağlı|Erişim izni var/);
});

test('timers and listeners are released when the detail closes or reopens', async () => {
  const { w, requests, timers } = setup({ fakeTime: true, accessList: [connectedGrant()] });
  w.open = () => {};
  await settle();
  await openFirstTicket(w);
  assert.equal(timers.intervals.size, 1);

  // repainting through an action never stacks a second countdown
  button(w, 'Büroya bağlan').click();
  await settle();
  assert.equal(timers.intervals.size, 1);

  // coming back from the office tab refreshes the open box and messages quietly
  const before = gets(requests, `support/${TID}/access`);
  const messagesBefore = gets(requests, `support/${TID}`);
  w.dispatchEvent(new w.Event('focus'));
  await settle();
  assert.equal(gets(requests, `support/${TID}/access`), before + 1);
  assert.equal(gets(requests, `support/${TID}`), messagesBefore + 1);

  w.document.querySelector('dialog').close();
  assert.equal(timers.intervals.size, 0, 'closing the detail clears the countdown');
  w.dispatchEvent(new w.Event('focus'));
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  await settle();
  assert.equal(gets(requests, `support/${TID}/access`), before + 1, 'no listener survives the detail');

  // opening it again starts exactly one countdown, and closing clears it again
  await openFirstTicket(w);
  assert.equal(timers.intervals.size, 1);
  w.document.querySelector('dialog').close();
  assert.equal(timers.intervals.size, 0);
  assert.equal(w.document.querySelectorAll('dialog').length, 0);
});
