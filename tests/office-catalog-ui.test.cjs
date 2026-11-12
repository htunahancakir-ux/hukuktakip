const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '../outputs/icrapro');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const year = new Date().getFullYear();

// Loads the real home-news and modules scripts with the few globals the workspace provides.
// `routes` maps "METHOD /path" to a response object or a function; an Error value is thrown
// the way the real authApi throws on a failed request.
function browser(t, { role = 'ceo', catalog = true, routes = {} } = {}) {
  const dom = new JSDOM('<div id="content"></div>', {
    url: 'https://local-test.invalid/',
    runScripts: 'dangerously',
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.eval(read('html-safety.js'));
  const calls = [];
  const toasts = [];
  Object.assign(w, {
    $: (selector) => w.document.querySelector(selector),
    esc: w.escapeHtml,
    toast: (message) => toasts.push(message),
    hanAuth: { role },
    hanModules: catalog ? { catalog: true } : {},
    page: 'home',
    settingsTab: 'firm',
    renders: 0,
    render() {
      w.renders++;
    },
    settingsSectionTabs: () => '<div class="settings-tabs"></div>',
    bindSettingsSectionTabs() {},
    authApi(url, method = 'GET', data) {
      calls.push({ url, method, data });
      const route = routes[`${method} ${url}`];
      if (route === undefined) throw Error('Beklenmeyen istek: ' + method + ' ' + url);
      const value = typeof route === 'function' ? route(data) : route;
      if (value instanceof Error) throw value;
      return value;
    },
  });
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  w.eval(read('workspace-news.js'));
  w.eval(read('workspace-modules.js'));
  return { w, calls, toasts };
}

const managerCard = {
  id: 'n1',
  kind: 'campaign',
  title: 'Bahar kampanyası',
  body: 'WhatsApp modülünde indirim var.',
  endsAt: `${year}-11-30`,
  dismissible: true,
  interested: false,
  product: {
    code: 'whatsapp',
    name: 'WhatsApp Business',
    kind: 'module',
    available: true,
    priceKurus: 125000,
    packQuantity: null,
    packUnit: null,
    owned: null,
  },
  campaign: {
    name: 'Bahar',
    discountType: 'percent',
    discountValue: 20,
    applies: 'first_3_months',
    couponCode: 'BAHAR20',
    endsAt: `${year}-11-30`,
  },
};

const text = (w, selector) => w.document.querySelector(selector)?.textContent.replace(/\s+/g, ' ').trim();
const buttons = (w) => [...w.document.querySelectorAll('#platformNewsHome button')].map((b) => b.textContent);

test('manager sees the card with price, campaign terms, coupon and both buttons', (t) => {
  const { w } = browser(t, { routes: { 'GET /api/platform-news': { card: managerCard } } });
  w.loadPlatformNewsHome();
  const host = w.document.querySelector('#content').firstElementChild;
  assert.equal(host.id, 'platformNewsHome');
  const shown = text(w, '#platformNewsHome');
  assert.match(shown, /^Kampanya/);
  assert.ok(shown.includes('Bahar kampanyası'));
  assert.ok(shown.includes('WhatsApp modülünde indirim var.'));
  assert.ok(shown.includes('WhatsApp Business · ₺1.250 / ay · KDV hariç'));
  assert.ok(shown.includes("İlk 3 ay %20 indirim · 30 Kasım'a kadar"));
  assert.ok(shown.includes('Kupon kodu: BAHAR20'));
  assert.deepEqual(buttons(w), ['İncele', 'İlgileniyorum', 'Kapat']);
});

test('price and campaign wording for packs, services and amount discounts', (t) => {
  const { w } = browser(t);
  assert.equal(
    w.catalogPriceText({ kind: 'usage_pack', priceKurus: 25000, packQuantity: 1000, packUnit: 'SMS' }),
    '₺250 / paket (1000 SMS) · KDV hariç',
  );
  assert.equal(
    w.catalogPriceText({ kind: 'service', priceKurus: 9990 }),
    '₺99,90 (tek seferlik) · KDV hariç',
  );
  assert.equal(
    w.catalogCampaignText({
      discountType: 'amount',
      discountValue: 10000,
      applies: 'whole_term',
      endsAt: `${year}-10-05`,
    }),
    "Abonelik boyunca ayda ₺100 indirim · 5 Ekim'e kadar",
  );
  assert.equal(
    w.catalogCampaignText({ discountType: 'percent', discountValue: 10, applies: 'first_month' }),
    'İlk ay %10 indirim',
  );
});

test('İncele records the click and opens Ayarlar → Modüller', (t) => {
  const { w, calls } = browser(t, {
    routes: {
      'GET /api/platform-news': { card: managerCard },
      'POST /api/platform-news/n1/click': { ok: true },
    },
  });
  w.loadPlatformNewsHome();
  w.document.querySelector('[data-news-open]').click();
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    ['GET /api/platform-news', 'POST /api/platform-news/n1/click'],
  );
  assert.equal(w.page, 'settings');
  assert.equal(w.settingsTab, 'modules');
  assert.equal(w.renders, 1);
});

test('İlgileniyorum posts once and swaps in the thank-you text, also when already requested', (t) => {
  for (const already of [false, true]) {
    const { w, calls } = browser(t, {
      routes: {
        'GET /api/platform-news': { card: managerCard },
        'POST /api/platform-news/n1/interest': { requested: true, already },
      },
    });
    w.loadPlatformNewsHome();
    w.document.querySelector('[data-news-interest]').click();
    assert.equal(calls.filter((c) => c.url.endsWith('/interest')).length, 1);
    assert.equal(w.document.querySelector('[data-news-interest]'), null);
    assert.equal(text(w, '.news-thanks'), 'Talebiniz alındı, sizi arayacağız.');
  }
});

test('interest button is absent when the module is already active; earlier interest shows thanks', (t) => {
  const owned = { ...managerCard, product: { ...managerCard.product, owned: 'active' } };
  const a = browser(t, { routes: { 'GET /api/platform-news': { card: owned } } });
  a.w.loadPlatformNewsHome();
  assert.equal(a.w.document.querySelector('[data-news-interest]'), null);
  const b = browser(t, {
    routes: { 'GET /api/platform-news': { card: { ...managerCard, interested: true } } },
  });
  b.w.loadPlatformNewsHome();
  assert.equal(b.w.document.querySelector('[data-news-interest]'), null);
  assert.equal(text(b.w, '.news-thanks'), 'Talebiniz alındı, sizi arayacağız.');
});

test('staff only get a maintenance notice: no prices, no İlgileniyorum, no İncele', (t) => {
  const card = {
    id: 'm1',
    kind: 'maintenance',
    title: 'Planlı bakım',
    body: 'Cumartesi 02:00-04:00 arası hizmet verilemeyecek.',
    endsAt: `${year}-11-14`,
    dismissible: false,
    product: null,
    campaign: null,
    interested: false,
  };
  const { w } = browser(t, { role: 'staff', routes: { 'GET /api/platform-news': { card } } });
  w.loadPlatformNewsHome();
  const shown = text(w, '#platformNewsHome');
  assert.match(shown, /^Planlı bakım/);
  assert.ok(shown.includes('Cumartesi 02:00-04:00'));
  assert.ok(shown.includes("14 Kasım'a kadar"));
  assert.ok(!shown.includes('₺'));
  assert.deepEqual(buttons(w), []);
});

test('Kapat posts dismiss and removes the card; a failed dismiss keeps it', (t) => {
  const ok = browser(t, {
    routes: {
      'GET /api/platform-news': { card: managerCard },
      'POST /api/platform-news/n1/dismiss': { ok: true },
    },
  });
  ok.w.loadPlatformNewsHome();
  ok.w.document.querySelector('[data-news-dismiss]').click();
  assert.equal(ok.calls.at(-1).url, '/api/platform-news/n1/dismiss');
  assert.equal(ok.w.document.getElementById('platformNewsHome'), null);

  const failing = browser(t, {
    routes: {
      'GET /api/platform-news': { card: managerCard },
      'POST /api/platform-news/n1/dismiss': Error('Bu duyuru kapatılamaz.'),
    },
  });
  failing.w.loadPlatformNewsHome();
  failing.w.document.querySelector('[data-news-dismiss]').click();
  assert.ok(failing.w.document.getElementById('platformNewsHome'));
  assert.deepEqual(failing.toasts, ['Bu duyuru kapatılamaz.']);
});

test('non-dismissible card has no Kapat button', (t) => {
  const { w } = browser(t, {
    routes: { 'GET /api/platform-news': { card: { ...managerCard, dismissible: false } } },
  });
  w.loadPlatformNewsHome();
  assert.equal(w.document.querySelector('[data-news-dismiss]'), null);
  assert.deepEqual(buttons(w), ['İncele', 'İlgileniyorum']);
});

test('nothing is rendered when the request fails, the card is null, or the catalog flag is off', (t) => {
  const failing = browser(t, { routes: { 'GET /api/platform-news': Error('Sunucuya ulaşılamadı.') } });
  failing.w.loadPlatformNewsHome();
  assert.equal(failing.w.document.getElementById('platformNewsHome'), null);
  assert.deepEqual(failing.toasts, []);

  const empty = browser(t, { routes: { 'GET /api/platform-news': { card: null } } });
  empty.w.loadPlatformNewsHome();
  assert.equal(empty.w.document.getElementById('platformNewsHome'), null);

  const off = browser(t, { catalog: false, routes: { 'GET /api/platform-news': { card: managerCard } } });
  off.w.loadPlatformNewsHome();
  assert.equal(off.calls.length, 0);
  assert.equal(off.w.document.getElementById('platformNewsHome'), null);
});

test('a second call does not add a second card, and other pages are untouched', (t) => {
  const { w, calls } = browser(t, { routes: { 'GET /api/platform-news': { card: managerCard } } });
  w.loadPlatformNewsHome();
  w.loadPlatformNewsHome();
  assert.equal(w.document.querySelectorAll('#platformNewsHome').length, 1);
  assert.equal(calls.length, 1);
  w.document.getElementById('platformNewsHome').remove();
  w.page = 'users';
  w.loadPlatformNewsHome();
  assert.equal(calls.length, 1);
});

test('server text in the card is never interpreted as markup', (t) => {
  const attack = '<img src=x onerror="window.__xss=1">';
  const card = {
    ...managerCard,
    title: attack,
    body: attack,
    product: { ...managerCard.product, name: attack },
    campaign: { ...managerCard.campaign, name: attack, couponCode: attack },
  };
  const { w } = browser(t, { routes: { 'GET /api/platform-news': { card } } });
  w.loadPlatformNewsHome();
  assert.equal(w.document.querySelectorAll('#platformNewsHome img').length, 0);
  assert.ok(text(w, '.news-title').includes(attack));
});

const modulesData = {
  legacy: false,
  subscription: { seatLimit: 10, used: 4, accessUntil: `${year}-12-31`, status: 'active' },
  owned: [
    {
      code: 'voip',
      name: 'VoIP / Telefon',
      status: 'active',
      priceKurus: 50000,
      trialUntil: null,
      since: `${year}-01-05`,
    },
    {
      code: 'ai-assistant',
      name: 'Yapay Zekâ',
      status: 'trial',
      priceKurus: 90000,
      trialUntil: `${year}-11-30`,
      since: `${year}-11-01`,
    },
  ],
  products: [
    {
      code: 'whatsapp',
      name: 'WhatsApp Business',
      description: 'Borçlulara WhatsApp üzerinden yazın.',
      kind: 'module',
      status: 'selling',
      features: ['Toplu mesaj', 'Şablon yönetimi'],
      trialDays: 14,
      packQuantity: null,
      packUnit: null,
      priceKurus: 125000,
      trialUntil: null,
      campaign: {
        name: 'Bahar',
        discountType: 'percent',
        discountValue: 20,
        applies: 'first_3_months',
        couponCode: null,
        endsAt: `${year}-11-30`,
      },
      requested: false,
    },
    {
      code: 'sms-pack',
      name: 'SMS Paketi',
      description: '',
      kind: 'usage_pack',
      status: 'soon',
      features: [],
      trialDays: 0,
      packQuantity: 1000,
      packUnit: 'SMS',
      priceKurus: 25000,
      trialUntil: null,
      campaign: null,
      requested: true,
    },
  ],
};

test('Modüller page shows subscription, owned modules (trial dated) and purchasable cards', (t) => {
  const { w } = browser(t, { routes: { 'GET /api/office-modules': () => structuredClone(modulesData) } });
  w.modulesSettingsPage();
  const sub = text(w, '#modulesSubscription');
  assert.ok(sub.includes('4 / 10'));
  assert.ok(sub.includes('31 Aralık'));
  const owned = text(w, '#modulesOwned');
  assert.ok(owned.includes('VoIP / Telefon'));
  assert.ok(owned.includes('Aktif'));
  assert.ok(owned.includes("Deneme · 30 Kasım'a kadar"));
  const whatsapp = w.document.querySelector('[data-module-code="whatsapp"]');
  assert.ok(whatsapp.textContent.includes('₺1.250 / ay · KDV hariç'));
  assert.deepEqual(
    [...whatsapp.querySelectorAll('.module-features li')].map((li) => li.textContent),
    ['Toplu mesaj', 'Şablon yönetimi'],
  );
  assert.ok(whatsapp.textContent.includes("İlk 3 ay %20 indirim · 30 Kasım'a kadar"));
  assert.ok(whatsapp.querySelector('[data-module-request]'));
  assert.equal(whatsapp.querySelector('.module-soon'), null);
  const pack = w.document.querySelector('[data-module-code="sms-pack"]');
  assert.equal(text(w, '[data-module-code="sms-pack"] .module-soon'), 'Yakında');
  assert.ok(pack.textContent.includes('₺250 / paket (1000 SMS) · KDV hariç'));
  assert.ok(pack.textContent.includes('Talep edildi — satış ekibimiz sizi arayacak'));
  assert.equal(pack.querySelector('[data-module-request]'), null);
});

test('Talep et posts {code, note} and the card flips to the requested text', (t) => {
  const { w, calls } = browser(t, {
    routes: {
      'GET /api/office-modules': () => structuredClone(modulesData),
      'POST /api/office-modules/request': { requested: true, already: false },
    },
  });
  w.modulesSettingsPage();
  w.document.querySelector('[data-module-code="whatsapp"] [data-module-request]').click();
  const dialog = w.document.getElementById('moduleRequestDialog');
  assert.equal(dialog.open, true);
  assert.equal(text(w, '#moduleRequestDialog h2'), 'WhatsApp Business');
  const form = dialog.querySelector('form');
  form.elements.note.value = ' Yarın 10:00 uygundur ';
  form.dispatchEvent(new w.Event('submit', { cancelable: true }));
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.url, '/api/office-modules/request');
  assert.deepEqual(JSON.parse(JSON.stringify(post.data)), { code: 'whatsapp', note: 'Yarın 10:00 uygundur' });
  assert.equal(dialog.open, false);
  const card = w.document.querySelector('[data-module-code="whatsapp"]');
  assert.equal(card.querySelector('[data-module-request]'), null);
  assert.equal(
    text(w, '[data-module-code="whatsapp"] .module-requested'),
    'Talep edildi — satış ekibimiz sizi arayacak',
  );
});

test('a refused request (read-only manager, already owned) shows the error and keeps the button', (t) => {
  const { w } = browser(t, {
    routes: {
      'GET /api/office-modules': () => structuredClone(modulesData),
      'POST /api/office-modules/request': Error('Bu hesap salt okunurdur.'),
    },
  });
  w.modulesSettingsPage();
  w.document.querySelector('[data-module-request]').click();
  const form = w.document.querySelector('#moduleRequestForm');
  form.dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.equal(text(w, '#moduleRequestError'), 'Bu hesap salt okunurdur.');
  assert.ok(w.document.querySelector('[data-module-code="whatsapp"] [data-module-request]'));
});

test('legacy offices get a short note and no catalog', (t) => {
  const { w } = browser(t, {
    routes: { 'GET /api/office-modules': { legacy: true, subscription: null, owned: [], products: [] } },
  });
  w.modulesSettingsPage();
  assert.match(text(w, '#modulesLegacy'), /platform tarafından yönetilir/);
  assert.equal(w.document.querySelector('[data-module-request]'), null);
  assert.equal(w.document.getElementById('modulesAvailable'), null);
});

test('Modüller page is for managers only and survives a failing request', (t) => {
  const staff = browser(t, { role: 'staff' });
  staff.w.modulesSettingsPage();
  assert.equal(staff.calls.length, 0);
  assert.equal(staff.toasts.length, 1);
  const failing = browser(t, { routes: { 'GET /api/office-modules': Error('Sunucuya ulaşılamadı.') } });
  failing.w.modulesSettingsPage();
  assert.deepEqual(failing.toasts, ['Sunucuya ulaşılamadı.']);
});

test('wiring: the tab is gated by the catalog flag and the scripts load before the dashboards', () => {
  const settings = read('settings.js');
  assert.match(settings, /hanModules\?\.\['catalog'\] === true\s*\?\s*\[\['modules', 'Modüller'\]\]/);
  assert.match(settings, /settingsTab === 'modules'\) return modulesSettingsPage\(\)/);
  const scripts = require(path.join(root, 'workspace-assets.js'));
  const at = (name) => scripts.indexOf(name);
  assert.ok(at('workspace-news.js') > -1 && at('workspace-modules.js') > -1);
  assert.ok(at('workspace-news.js') < at('finance-operations.js'));
  assert.match(
    read('workspace-reminders.js'),
    /function loadPaymentPromisesHome\(\) \{\s*if \(typeof loadPlatformNewsHome/,
  );
});
