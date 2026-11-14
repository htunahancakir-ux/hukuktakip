'use strict';
// Platform (super admin) console. All text is inserted with textContent / DOM nodes,
// never innerHTML: values such as office names are operator-typed but still untrusted.
// Money is integer kuruş everywhere; the server recomputes every total, the figures
// shown while typing are previews only.

const LABELS = {
  office: { provisioning: 'Hazırlanıyor', enabled: 'Aktif', suspended: 'Pasif', closed: 'Kapalı' },
  subscription: { trialing: 'Deneme', active: 'Ödemeli', past_due: 'Gecikmiş', canceled: 'İptal' },
  kind: {
    new_office: 'Yeni büro',
    users: 'Kullanıcı artışı',
    module: 'Modül',
    renewal: 'Yenileme',
    adjustment: 'İndirim / düzeltme',
    refund: 'İade',
    usage_pack: 'Kullanım paketi',
    service: 'Hizmet',
  },
  productKind: { module: 'Aylık modül', usage_pack: 'Kullanım paketi', service: 'Hizmet' },
  productStatus: { draft: 'Taslak', soon: 'Yakında', selling: 'Satışta', retired: 'Satıştan kalktı' },
  applies: { first_month: 'İlk ay', first_3_months: 'İlk 3 ay', whole_term: 'Tüm süre' },
  campaignAudience: {
    all: 'Herkes',
    new_offices: 'Yalnızca yeni bürolar',
    without_product: 'Ürünü almamış bürolar',
    trialing: 'Denemedeki bürolar',
    selected: 'Seçili bürolar',
  },
  campaignStatus: { active: 'Aktif', paused: 'Durduruldu', ended: 'Bitti' },
  annKind: {
    new_product: 'Yeni ürün',
    campaign: 'Kampanya',
    price_change: 'Fiyat değişikliği',
    maintenance: 'Planlı bakım',
  },
  annStatus: { draft: 'Taslak', published: 'Yayında', archived: 'Arşiv' },
  annAudience: {
    all: 'Herkes',
    without_product: 'Ürünü almamış bürolar',
    trialing: 'Denemedeki bürolar',
    selected: 'Seçili bürolar',
  },
  roles: { managers: 'CEO ve yöneticiler', everyone: 'Tüm kullanıcılar' },
  stage: {
    new: 'Yeni',
    contacted: 'Görüşüldü',
    demo: 'Demo',
    offer: 'Teklif',
    won: 'Kazanıldı',
    lost: 'Kaybedildi',
  },
  source: {
    advertising: 'Reklam',
    referral: 'Tavsiye',
    web: 'Web',
    announcement: 'Duyuru',
    request: 'Büro talebi',
    other: 'Diğer',
  },
  sale: { pending: 'Bekliyor', paid: 'Tahsil edildi', void: 'İptal' },
  payment: {
    initiated: 'Ödeme bekleniyor',
    paid: 'Ödendi',
    failed: 'Başarısız',
    review: 'İnceleme gerekli',
    superseded: 'Yenilendi',
  },
  ticketStatus: {
    open: 'Açık',
    waiting_customer: 'Müşteri bekleniyor',
    resolved: 'Çözüldü',
    closed: 'Kapalı',
  },
  priority: { low: 'Düşük', normal: 'Normal', high: 'Yüksek', urgent: 'Acil' },
  category: {
    technical: 'Teknik',
    billing: 'Ödeme / fatura',
    how_to: 'Kullanım',
    feature_request: 'Özellik isteği',
    other: 'Diğer',
  },
  channel: { phone: 'Telefon', email: 'E-posta', whatsapp: 'WhatsApp', portal: 'Portal', other: 'Diğer' },
  messageKind: { operator: 'Yanıt', customer: 'Müşteri', internal: 'İç not', system: 'Sistem' },
  expense: {
    advertising: 'Reklam',
    marketing: 'Pazarlama',
    server: 'Sunucu / altyapı',
    ai: 'Yapay zekâ kullanımı',
    telephony: 'Telefon / santral',
    software: 'Yazılım / abonelik',
    personnel: 'Personel',
    other: 'Diğer',
  },
  event: {
    office_opened: 'Büro açıldı',
    manager_password_reset: 'Yönetici şifresi sıfırlandı',
    users_changed: 'Kullanıcı sayısı değişti',
    module_added: 'Modül eklendi',
    module_removed: 'Modül çıkarıldı',
    renewed: 'Abonelik yenilendi',
    sale_paid: 'Tahsilat işlendi',
    sale_voided: 'Satış iptal edildi',
    refunded: 'İade yapıldı',
    status_enabled: 'Büro aktifleştirildi',
    status_suspended: 'Büro pasife alındı',
    status_closed: 'Büro kapatıldı',
    trial_started: 'Deneme başlatıldı',
    product_sold: 'Ürün satıldı',
  },
};
const PRICE_LABEL = { module: 'Aylık fiyat', usage_pack: 'Paket fiyatı', service: 'Birim fiyat' };
const OPEN_STAGES = ['new', 'contacted', 'demo', 'offer'];

function parseTl(text) {
  const raw = String(text ?? '').replace(/\s/g, '');
  if (!raw) return NaN;
  let normalized = raw;
  if (raw.includes(',')) normalized = raw.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(raw)) normalized = raw.replace(/\./g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return NaN;
  const [whole, fraction = ''] = normalized.split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(value) ? value : NaN;
}
function formatTl(kurus) {
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format((kurus || 0) / 100);
}
// KDV per ledger line, rounded half away from zero in integer kuruş (the server uses the same rule).
function vatOf(net, rate) {
  const value = Math.floor((Math.abs(net) * rate + 50) / 100);
  return net < 0 ? -value : value;
}
// Amounts are KDV-exclusive; `vat` and `gross` (KDV-inclusive) follow from the rate.
function previewTotals({
  userCount = 0,
  userPriceKurus = 0,
  termMonths = 0,
  modulePrices = [],
  discountKurus = 0,
  vatRatePercent = 0,
}) {
  const users = userCount * userPriceKurus * termMonths;
  const modules = modulePrices.reduce((sum, price) => sum + price * termMonths, 0);
  const total = users + modules;
  const discount = Math.min(Math.max(discountKurus || 0, 0), total);
  const payable = total - discount;
  const vat =
    vatOf(users, vatRatePercent) +
    modulePrices.reduce((sum, price) => sum + vatOf(price * termMonths, vatRatePercent), 0) -
    vatOf(discount, vatRatePercent);
  return { users, modules, total, discount, payable, vat, gross: payable + vat };
}
const monthText = (month) => {
  const [y, m] = month.split('-');
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('tr-TR', {
    month: 'long',
    year: 'numeric',
  });
};
const dateText = (value) => (value ? new Date(value).toLocaleDateString('tr-TR') : '—');
const dateTimeText = (value) => (value ? new Date(value).toLocaleString('tr-TR') : '—');
// Kuruş as the operator types TL ("1250,50"), for prefilled amount fields.
const tlText = (kurus) => ((kurus || 0) / 100).toFixed(2).replace('.', ',');
const pad2 = (n) => String(n).padStart(2, '0');
// A day as YYYY-MM-DD in the operator's local time (date inputs); today when empty.
function isoDay(value) {
  const d = value === undefined || value === null ? new Date() : new Date(value);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const addDays = (days) => isoDay(Date.now() + days * 86400000);
// A typed YYYY-MM-DD shown the Turkish way (GG.AA.YYYY).
const dayText = (text) =>
  /^\d{4}-\d{2}-\d{2}$/.test(text || '') ? text.split('-').reverse().join('.') : '—';
// Start (or end) of a typed day in local time, as an ISO timestamp for the server.
function dayBound(text, label, end = false) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''));
  const date = match
    ? end
      ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59)
      : new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : null;
  if (!date || Number.isNaN(date.getTime()) || date.getDate() !== Number(match[3]))
    throw new Error(`${label} geçersiz. Örnek: 2026-11-30`);
  return date.toISOString();
}

if (typeof module !== 'undefined') module.exports = { parseTl, formatTl, previewTotals, vatOf };

function boot() {
  const app = document.getElementById('app');
  const state = {
    admin: null,
    tab: 'overview',
    dash: null,
    modules: [],
    q: '',
    filter: 'all',
    support: null,
    ticketFilter: 'active',
    ticketQ: '',
    month: null,
    sales: null,
    expenses: null,
    finance: null,
    account: null,
    operators: null,
    audit: null,
    setupRequired: false,
    sms: null,
    maps: null,
    campaigns: null,
    announcements: null,
    prospects: null,
    pipe: { stage: '', source: '', q: '' },
    officeRequests: null,
    profit: null,
    profitFrom: null,
    profitTo: null,
    recurring: null,
  };

  // ---------- DOM helpers ----------
  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'value') node.value = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }
  const badge = (text, tone = '') => h('span', { class: 'badge ' + tone, text });
  function toast(message, error = false) {
    document.getElementById('toast')?.remove();
    const node = h('div', { id: 'toast', class: error ? 'error' : '', role: 'status', text: message });
    document.body.append(node);
    setTimeout(() => node.remove(), 4500);
  }

  // ---------- API ----------
  async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch('/api/platform/' + path, {
      method,
      credentials: 'same-origin',
      headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-Han-Request': '1' } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = {};
    try {
      json = await response.json();
    } catch {}
    if (!response.ok) {
      const error = new Error(json.error || 'İşlem başarısız.');
      error.status = response.status;
      error.totpRequired = json.totpRequired === true;
      if (json.totpSetupRequired === true && !state.setupRequired) {
        state.setupRequired = true;
        state.tab = 'admin';
        loadTabData().then(renderApp);
      }
      if (response.status === 401 && path !== 'login') {
        state.admin = null;
        renderLogin();
      }
      throw error;
    }
    return json;
  }
  async function refresh() {
    if (state.setupRequired) {
      state.tab = 'admin';
      renderApp();
      return loadTabData();
    }
    const [dash, modules, support] = await Promise.all([api('dashboard'), api('modules'), api('support')]);
    state.dash = dash;
    state.modules = modules;
    state.support = support;
    state.sales = state.expenses = state.finance = null;
    state.profit = state.recurring = state.campaigns = state.announcements = state.prospects = null;
    state.officeRequests = null;
    renderApp();
    await loadTabData();
  }
  async function ensureCampaigns() {
    if (!state.campaigns) state.campaigns = (await api('campaigns')).campaigns;
    return state.campaigns;
  }
  // Sale forms work without the campaign list (a coupon can still be typed).
  const campaignsQuiet = () => ensureCampaigns().catch(() => []);
  async function loadProspects() {
    const query = new URLSearchParams();
    for (const key of ['stage', 'source', 'q']) if (state.pipe[key]) query.set(key, state.pipe[key]);
    const [list] = await Promise.all([
      api('prospects' + (query.toString() ? '?' + query : '')),
      state.operators
        ? null
        : api('operators')
            .then((r) => {
              state.operators = r.operators;
              state.audit = r.audit;
            })
            .catch(() => {}),
    ]);
    state.prospects = list;
  }
  // Sales, expenses and finance are loaded when their tab is open; a sale, expense or month
  // change clears them so a stale total is never shown next to a fresh action.
  async function loadTabData() {
    try {
      const month = state.month ? '?month=' + state.month : '';
      if (state.tab === 'overview' && state.officeRequests === null) {
        // Two light calls for the overview cards; a failure only hides the cards.
        state.officeRequests = undefined;
        const [, requests] = await Promise.all([
          campaignsQuiet(),
          api('prospects?stage=new&source=request').catch(() => null),
        ]);
        state.officeRequests = requests ? requests.prospects.length : undefined;
        if (state.tab === 'overview') renderApp();
      } else if (state.tab === 'campaigns' && !state.campaigns) {
        await ensureCampaigns();
        renderApp();
      } else if (state.tab === 'announcements' && !state.announcements) {
        const [list] = await Promise.all([api('announcements'), campaignsQuiet()]);
        state.announcements = list.announcements;
        renderApp();
      } else if (state.tab === 'pipeline' && !state.prospects) {
        await loadProspects();
        renderApp();
      } else if (state.tab === 'finance' && (!state.finance || !state.profit || !state.recurring)) {
        const range = state.profitFrom ? `?from=${state.profitFrom}&to=${state.profitTo}` : '';
        const [finance, profit, recurring] = await Promise.all([
          state.finance || api('finance'),
          state.profit || api('profit' + range).catch((e) => ({ error: e.message })),
          state.recurring || api('recurring-expenses').then((r) => r.recurring),
        ]);
        state.finance = finance;
        state.profit = profit;
        state.recurring = recurring;
        if (!profit.error) {
          state.profitFrom = profit.from;
          state.profitTo = profit.to;
        }
        renderApp();
      } else if (state.tab === 'sales' && !state.sales) {
        state.sales = await api('sales' + month);
        state.month = state.sales.month;
        renderApp();
      } else if (state.tab === 'expenses' && !state.expenses) {
        state.expenses = await api('expenses' + month);
        state.month = state.expenses.month;
        renderApp();
      } else if (state.tab === 'admin' && !state.account) {
        state.account = await api('account');
        if (!state.setupRequired) {
          const [list, sms, maps, backups] = await Promise.all([
            api('operators'),
            api('settings/sms'),
            api('settings/maps'),
            // The page stays usable when the backup state cannot be read.
            api('backups').catch(() => null),
          ]);
          state.operators = list.operators;
          state.audit = list.audit;
          state.sms = sms;
          state.maps = maps;
          state.backups = backups;
        }
        renderApp();
      }
    } catch (error) {
      if (error.status !== 401) toast(error.message, true);
    }
  }

  // ---------- generic form dialog ----------
  // Field options: `showIf(raw)` hides a field (and skips it when reading) unless it returns
  // true; `labelFor(raw)` replaces the label as other fields change; `fill(input)` runs once
  // after the input is created (e.g. to append options loaded later). `raw` holds the typed
  // values before validation. Type `checks` is a checkbox list of {value, label} options.
  function formDialog({
    title,
    intro,
    fields: given,
    submitLabel = 'Kaydet',
    danger = false,
    preview,
    rawPreview = false,
    wide = false,
    submit,
  }) {
    const fields = given.filter(Boolean);
    return new Promise((resolve) => {
      const inputs = {};
      const rowOf = {};
      const labelOf = {};
      const error = h('p', { class: 'formerror', role: 'alert' });
      const previewBox = preview ? h('div', { class: 'preview' }) : null;
      const checkList = (f, items, empty) => {
        const list = h('div', { class: 'modulepick' + (f.type === 'checks' ? ' checks' : '') });
        const chosen = new Set(f.value || []);
        inputs[f.name] = items.map((item) => {
          const box = h('input', { type: 'checkbox' });
          box.checked = chosen.has(item.value);
          list.append(h('label', { class: 'check' }, box, item.label));
          return { box, code: item.value };
        });
        if (!items.length) list.append(h('small', { text: empty }));
        labelOf[f.name] = h('span', { text: f.label });
        return h(
          'div',
          { class: 'field' },
          labelOf[f.name],
          list,
          f.hint ? h('small', { text: f.hint }) : null,
        );
      };
      const rows = fields.map((f) => {
        let row;
        if (f.type === 'modules')
          row = checkList(
            f,
            f.options.map((m) => ({
              value: m.code,
              label: `${m.name} — ${formatTl(m.priceKurus ?? m.monthlyPriceKurus)} / ay`,
            })),
            'Satışa açık modül yok. Ürünler sekmesinden fiyat girip satışa açın.',
          );
        else if (f.type === 'checks') row = checkList(f, f.options, f.empty || 'Seçenek yok.');
        else {
          let input;
          if (f.type === 'select')
            input = h(
              'select',
              {},
              f.options.map((o) => h('option', { value: o.value, text: o.label })),
            );
          else if (f.type === 'textarea')
            input = h('textarea', { rows: f.rows || 3, maxlength: f.maxlength });
          else if (f.type === 'checkbox') input = h('input', { type: 'checkbox' });
          else
            input = h('input', {
              type:
                f.type === 'password'
                  ? 'password'
                  : f.type === 'number'
                    ? 'number'
                    : f.type === 'date'
                      ? 'date'
                      : 'text',
              inputmode: f.type === 'tl' ? 'decimal' : undefined,
              autocomplete: f.type === 'password' ? 'new-password' : 'off',
              min: f.min,
              max: f.max,
              maxlength: f.maxlength,
              disabled: f.disabled,
            });
          if (f.value !== undefined && f.value !== null) {
            if (f.type === 'checkbox') input.checked = !!f.value;
            else input.value = f.value;
          }
          inputs[f.name] = input;
          f.fill?.(input);
          labelOf[f.name] = h('span', { text: f.label });
          if (f.type === 'checkbox') row = h('label', { class: 'check' }, input, labelOf[f.name]);
          else
            row = h(
              'label',
              { class: 'field' },
              labelOf[f.name],
              input,
              f.hint ? h('small', { text: f.hint }) : null,
            );
        }
        rowOf[f.name] = row;
        return row;
      });
      function raw() {
        const values = {};
        for (const f of fields) {
          const input = inputs[f.name];
          if (f.type === 'modules' || f.type === 'checks')
            values[f.name] = input.filter((m) => m.box.checked).map((m) => m.code);
          else if (f.type === 'checkbox') values[f.name] = input.checked;
          else values[f.name] = input.value.trim();
        }
        return values;
      }
      const shown = (f, typed) => !f.showIf || f.showIf(typed);
      const labelText = (f, typed) => (f.labelFor ? f.labelFor(typed) : f.label);
      function read() {
        const typed = raw();
        const values = {};
        for (const f of fields) {
          const value = typed[f.name];
          const label = labelText(f, typed);
          if (!shown(f, typed)) values[f.name] = undefined;
          else if (f.type === 'modules' || f.type === 'checks' || f.type === 'checkbox')
            values[f.name] = value;
          else if (!value) {
            if (f.required) throw new Error(`${label} gerekli.`);
            values[f.name] = undefined;
          } else if (f.type === 'tl') {
            const parsed = parseTl(value);
            if (Number.isNaN(parsed)) throw new Error(`${label} geçersiz. Örnek: 1250,50`);
            values[f.name] = parsed;
          } else if (f.type === 'number' || (f.type === 'select' && f.numeric)) {
            const n = Number(value);
            if (!Number.isInteger(n)) throw new Error(`${label} tam sayı olmalıdır.`);
            values[f.name] = n;
          } else values[f.name] = value;
        }
        return values;
      }
      function update() {
        const typed = raw();
        for (const f of fields) {
          rowOf[f.name].hidden = !shown(f, typed);
          if (f.labelFor) labelOf[f.name].textContent = f.labelFor(typed);
        }
        if (!previewBox) return;
        try {
          previewBox.replaceChildren(...preview(rawPreview ? typed : read()).filter(Boolean));
        } catch {
          previewBox.replaceChildren(h('span', { text: 'Tutarı görmek için alanları doldurun.' }));
        }
      }
      const dialog = h('dialog', { class: wide ? 'wide' : '' });
      const form = h('form', { novalidate: true });
      const save = h('button', {
        class: 'btn ' + (danger ? 'danger' : 'primary'),
        type: 'submit',
        text: submitLabel,
      });
      const cancel = h('button', {
        class: 'btn',
        type: 'button',
        text: 'Vazgeç',
        onclick: () => dialog.close(),
      });
      form.append(
        h(
          'div',
          { class: 'dialog-head' },
          h('div', {}, h('h3', { text: title }), intro ? h('p', { text: intro }) : null),
        ),
        h('div', { class: 'dialog-body' }, rows, previewBox, error),
        h('div', { class: 'dialog-foot' }, cancel, save),
      );
      form.addEventListener('input', update);
      form.addEventListener('change', update);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        error.textContent = '';
        save.disabled = true;
        try {
          await submit(read());
          dialog.close('done');
        } catch (e) {
          error.textContent = e.message;
        } finally {
          save.disabled = false;
        }
      });
      dialog.append(form);
      dialog.addEventListener('close', () => {
        dialog.remove();
        resolve(dialog.returnValue === 'done');
      });
      document.body.append(dialog);
      update();
      dialog.showModal();
      dialog.querySelector('input,select,textarea')?.focus();
    });
  }

  // ---------- login ----------
  function renderLogin() {
    const error = h('p', { class: 'formerror', role: 'alert' });
    const user = h('input', { type: 'text', autocomplete: 'username', required: true });
    const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const code = h('input', {
      type: 'text',
      inputmode: 'text',
      autocomplete: 'one-time-code',
      maxlength: '12',
      'aria-label': 'Doğrulama kodu',
    });
    const codeField = h(
      'label',
      { class: 'field', hidden: true },
      h('span', { text: 'Doğrulama kodu' }),
      code,
      h('small', {
        text: 'Authenticator uygulamasındaki 6 haneli kod. Telefonunuz yoksa bir kurtarma kodu girin.',
      }),
    );
    const form = h(
      'form',
      {
        onsubmit: async (event) => {
          event.preventDefault();
          error.textContent = '';
          try {
            const result = await api('login', {
              method: 'POST',
              body: { username: user.value, password: pass.value, code: code.value.trim() || undefined },
            });
            state.admin = result.admin;
            state.account = state.operators = state.audit = null;
            state.setupRequired = false;
            await refresh();
          } catch (e) {
            error.textContent = e.message;
            if (e.totpRequired) {
              codeField.hidden = false;
              code.value = '';
              code.focus();
            }
          }
        },
      },
      h('div', {}, h('p', { class: 'eyebrow', text: 'Hukuk Takip Platformu' }), h('h1', { text: 'Yönetim' })),
      h('label', { class: 'field' }, h('span', { text: 'Kullanıcı adı' }), user),
      h('label', { class: 'field' }, h('span', { text: 'Şifre' }), pass),
      codeField,
      error,
      h('button', { class: 'btn primary', type: 'submit', text: 'Giriş yap' }),
    );
    app.replaceChildren(h('div', { class: 'login' }, form));
    user.focus();
  }

  // ---------- shell ----------
  const TABS = [
    ['overview', 'Genel bakış'],
    ['offices', 'Bürolar'],
    ['pipeline', 'Satış hunisi'],
    ['sales', 'Satışlar'],
    ['modules', 'Ürünler'],
    ['campaigns', 'Kampanyalar'],
    ['announcements', 'Duyurular'],
    ['expenses', 'Giderler'],
    ['finance', 'Kârlılık'],
    ['support', 'Destek'],
    ['admin', 'Yönetim'],
  ];
  function renderApp() {
    const content = {
      overview: renderOverview,
      offices: renderOffices,
      pipeline: renderPipeline,
      sales: renderSales,
      modules: renderModules,
      campaigns: renderCampaigns,
      announcements: renderAnnouncements,
      expenses: renderExpenses,
      finance: renderFinance,
      support: renderSupport,
      admin: renderAdmin,
    }[state.tab]();
    app.replaceChildren(
      h(
        'header',
        { class: 'topbar' },
        h('div', { class: 'brand' }, 'Hukuk Takip Platformu ', h('span', { text: 'Yönetim' })),
        h(
          'nav',
          { class: 'tabs', role: 'tablist' },
          TABS.filter(([id]) => !state.setupRequired || id === 'admin').map(([id, label]) =>
            h('button', {
              role: 'tab',
              'aria-selected': String(state.tab === id),
              text: label,
              onclick: () => {
                state.tab = id;
                renderApp();
                loadTabData();
              },
            }),
          ),
        ),
        h(
          'div',
          { class: 'who' },
          h('span', { text: state.admin?.name }),
          h('button', {
            class: 'link',
            text: 'Çıkış',
            onclick: async () => {
              await api('logout', { method: 'POST' }).catch(() => {});
              state.admin = null;
              renderLogin();
            },
          }),
        ),
      ),
      h('main', {}, content),
    );
  }

  // ---------- overview ----------
  function chart(months) {
    const W = 640,
      H = 230,
      left = 8,
      bottom = 28,
      top = 16;
    const max = Math.max(...months.map((m) => m.kurus), 1);
    const slot = (W - left * 2) / months.length;
    const svgNS = 'http://www.w3.org/2000/svg';
    const el = (name, attrs, text) => {
      const node = document.createElementNS(svgNS, name);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const svg = el('svg', {
      class: 'bars',
      viewBox: `0 0 ${W} ${H}`,
      role: 'img',
      'aria-label': 'Son 12 ayın tahsilatı',
    });
    svg.append(el('line', { class: 'axis', x1: left, x2: W - left, y1: H - bottom, y2: H - bottom }));
    months.forEach((m, i) => {
      const height = Math.round(((H - bottom - top) * Math.max(m.kurus, 0)) / max);
      const x = left + i * slot + slot * 0.16;
      const bar = el('rect', {
        class: 'bar' + (i === months.length - 1 ? ' current' : ''),
        x,
        y: H - bottom - height,
        width: slot * 0.68,
        height: Math.max(height, m.kurus > 0 ? 2 : 0),
        rx: 3,
      });
      bar.append(el('title', {}, `${m.month}: ${formatTl(m.kurus)}`));
      svg.append(
        bar,
        el('text', { x: x + slot * 0.34, y: H - 10, 'text-anchor': 'middle' }, m.month.slice(5)),
      );
    });
    return svg;
  }
  function kpi(label, value, note, { alert = false, tone = '' } = {}) {
    return h(
      'div',
      { class: 'kpi' + (alert ? ' alert' : '') },
      h('small', { text: label }),
      h('strong', { text: value }),
      h('span', { class: tone, text: note }),
    );
  }
  function renderOverview() {
    const d = state.dash;
    const change =
      d.revenue.lastMonthKurus > 0
        ? Math.round(((d.revenue.thisMonthKurus - d.revenue.lastMonthKurus) / d.revenue.lastMonthKurus) * 100)
        : null;
    const attention = d.attention.expiringSoon + d.attention.expired;
    return h(
      'div',
      {},
      h(
        'div',
        { class: 'heading' },
        h(
          'div',
          {},
          h('p', { class: 'eyebrow', text: 'Genel durum' }),
          h('h2', { text: 'Satış özeti' }),
          h('p', { text: 'Güncelleme: ' + dateTimeText(d.generatedAt) }),
        ),
        h(
          'div',
          { class: 'toolbar' },
          h('button', { class: 'btn primary', text: 'Yeni büro sat', onclick: () => openOfficeDialog() }),
        ),
      ),
      h(
        'div',
        { class: 'kpis' },
        kpi(
          'Aktif büro',
          String(d.offices.enabled),
          `${d.offices.total} toplam · ${d.offices.suspended} pasif · ${d.offices.closed} kapalı`,
        ),
        kpi('Kullanıcı', `${d.users.used} / ${d.users.sold}`, 'kullanılan / satılan (aktif bürolar)'),
        kpi(
          'Aylık yinelenen gelir',
          formatTl(d.revenue.mrrKurus),
          'KDV hariç · ödemeli, süresi dolmamış bürolar',
        ),
        kpi(
          'Bu ay tahsilat (KDV hariç)',
          formatTl(d.revenue.thisMonthKurus),
          change === null ? 'geçen ay tahsilat yok' : `geçen aya göre %${change}`,
          { tone: change === null ? '' : change >= 0 ? 'up' : 'down' },
        ),
        kpi(
          'Bekleyen alacak (KDV hariç)',
          formatTl(d.revenue.pendingKurus),
          `${d.revenue.pendingCount} satış tahsil bekliyor`,
          { alert: d.revenue.pendingCount > 0 },
        ),
        state.support
          ? kpi(
              'Açık destek',
              String(state.support.summary.open),
              `${state.support.summary.urgent} acil · ${state.support.summary.overdue} yanıt gecikmiş`,
              { alert: state.support.summary.overdue > 0 || state.support.summary.urgent > 0 },
            )
          : null,
        pendingAccessCount() > 0
          ? kpi('Bağlantı bekleyen izinler', String(pendingAccessCount()), 'büronun verdiği, henüz kullanılmamış erişim izni (Destek)', {
              alert: true,
            })
          : null,
        kpi(
          'Dikkat',
          String(attention),
          `${d.attention.expiringSoon} yakında bitiyor · ${d.attention.expired} süresi doldu · ${d.attention.fullSeats} büro dolu`,
          { alert: attention > 0 },
        ),
        state.campaigns
          ? kpi(
              'Yayındaki kampanya',
              String(state.campaigns.filter((c) => c.live).length),
              `${state.campaigns.filter((c) => c.status === 'paused').length} durdurulmuş`,
            )
          : null,
        typeof state.officeRequests === 'number'
          ? kpi('Büro talepleri', String(state.officeRequests), 'yanıt bekleyen yeni talep (Satış hunisi)', {
              alert: state.officeRequests > 0,
            })
          : null,
        state.profit && !state.profit.error
          ? kpi(
              'Bu ay yenileme',
              String(state.profit.indicators.renewalsThisMonth),
              `kayıp oranı ${state.profit.indicators.churnPercent === null ? '—' : '%' + state.profit.indicators.churnPercent}`,
            )
          : null,
      ),
      h(
        'div',
        { class: 'grid2' },
        h(
          'section',
          { class: 'panel' },
          h(
            'div',
            { class: 'panelhead' },
            h(
              'div',
              {},
              h('h3', { text: 'Aylık tahsilat' }),
              h('p', { text: 'Son 12 ay, tahsil edilen satışlar (KDV hariç)' }),
            ),
          ),
          h('div', { class: 'panelbody' }, chart(d.revenue.months)),
        ),
        h(
          'section',
          { class: 'panel' },
          h(
            'div',
            { class: 'panelhead' },
            h('h3', { text: 'Gelir türleri' }),
            h('span', { class: 'badge', text: 'toplam ' + formatTl(d.revenue.paidKurus) }),
          ),
          h(
            'div',
            { class: 'panelbody list' },
            d.revenue.byKind.length
              ? d.revenue.byKind.map((k) =>
                  h('div', {}, h('span', { text: LABELS.kind[k.kind] }), h('b', { text: formatTl(k.kurus) })),
                )
              : h('p', { class: 'empty', text: 'Henüz tahsilat yok.' }),
          ),
        ),
      ),
      h(
        'section',
        { class: 'panel' },
        h('div', { class: 'panelhead' }, h('h3', { text: 'Modül satışları' })),
        h(
          'div',
          { class: 'overflow' },
          h(
            'table',
            {},
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                h('th', { text: 'Modül' }),
                h('th', { class: 'num', text: 'Aktif büro' }),
                h('th', { class: 'num', text: 'Aylık gelir' }),
                h('th', { class: 'num', text: 'Toplam tahsilat' }),
              ),
            ),
            h(
              'tbody',
              {},
              d.modules.map((m) =>
                h(
                  'tr',
                  {},
                  h('td', { text: m.name }),
                  h('td', { class: 'num', text: String(m.offices) }),
                  h('td', { class: 'num', text: formatTl(m.monthlyKurus) }),
                  h('td', { class: 'num', text: formatTl(m.paidKurus) }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  // ---------- offices ----------
  function statusBadge(o) {
    if (o.status === 'enabled') return badge(LABELS.office.enabled, 'ok');
    if (o.status === 'suspended') return badge(LABELS.office.suspended, 'warn');
    if (o.status === 'closed') return badge(LABELS.office.closed, 'bad');
    return badge(LABELS.office.provisioning);
  }
  function subscriptionCell(o) {
    if (!o.subscription) return h('td', {}, '—', h('small', { text: 'Mevcut büro (abonelik tanımsız)' }));
    const s = o.subscription;
    const tone = s.expired ? 'bad' : s.daysLeft <= 14 ? 'warn' : 'ok';
    return h(
      'td',
      {},
      badge(s.expired ? 'Süresi doldu' : LABELS.subscription[s.status], tone),
      h('small', { text: `${dateText(s.accessUntil)}${s.expired ? '' : ` · ${s.daysLeft} gün`}` }),
    );
  }
  function renderOffices() {
    const q = state.q.trim().toLocaleLowerCase('tr');
    const list = state.dash.officeList.filter(
      (o) =>
        (state.filter === 'all' || o.status === state.filter) &&
        (!q || (o.name + ' ' + o.slug).toLocaleLowerCase('tr').includes(q)),
    );
    return h(
      'div',
      {},
      h(
        'div',
        { class: 'heading' },
        h('div', {}, h('p', { class: 'eyebrow', text: 'Müşteriler' }), h('h2', { text: 'Bürolar' })),
        h(
          'div',
          { class: 'toolbar' },
          h('input', {
            class: 'search',
            type: 'search',
            placeholder: 'Büro adı veya kodu',
            value: state.q,
            'aria-label': 'Büro ara',
            oninput: (e) => {
              state.q = e.target.value;
              const pos = e.target.selectionStart;
              renderApp();
              const box = app.querySelector('input.search');
              box.focus();
              box.setSelectionRange(pos, pos);
            },
          }),
          h(
            'select',
            {
              class: 'search',
              'aria-label': 'Durum',
              onchange: (e) => {
                state.filter = e.target.value;
                renderApp();
              },
            },
            [['all', 'Tümü'], ...Object.entries(LABELS.office)].map(([v, l]) =>
              h('option', { value: v, text: l, selected: state.filter === v }),
            ),
          ),
          h('button', { class: 'btn primary', text: 'Yeni büro sat', onclick: () => openOfficeDialog() }),
        ),
      ),
      h(
        'section',
        { class: 'panel' },
        list.length
          ? h(
              'div',
              { class: 'overflow' },
              h(
                'table',
                {},
                h(
                  'thead',
                  {},
                  h(
                    'tr',
                    {},
                    ['Büro', 'Durum', 'Abonelik', 'Kullanıcı', 'Aylık', 'Modüller', 'Tahsil edilen', ''].map(
                      (t, i) => h('th', { class: i >= 3 && i !== 5 && i !== 7 ? 'num' : '', text: t }),
                    ),
                  ),
                ),
                h(
                  'tbody',
                  {},
                  list.map((o) =>
                    h(
                      'tr',
                      { class: o.status === 'closed' || o.status === 'suspended' ? 'dim' : '' },
                      h('td', {}, h('strong', { text: o.name }), h('small', { text: o.slug })),
                      h('td', {}, statusBadge(o)),
                      subscriptionCell(o),
                      h('td', {
                        class: 'num',
                        text: o.userLimit === null ? '—' : `${o.usersUsed} / ${o.userLimit}`,
                      }),
                      h('td', { class: 'num', text: o.monthlyKurus ? formatTl(o.monthlyKurus) : '—' }),
                      h('td', { text: o.modules.length ? o.modules.join(', ') : '—' }),
                      h(
                        'td',
                        { class: 'num' },
                        formatTl(o.paidKurus),
                        o.pendingKurus ? h('small', { text: 'Bekleyen ' + formatTl(o.pendingKurus) }) : null,
                      ),
                      h(
                        'td',
                        {},
                        h('button', { class: 'btn small', text: 'Yönet', onclick: () => openDetail(o.id) }),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty', text: 'Kayıtlı büro yok.' }),
      ),
    );
  }

  // ---------- products, campaigns: shared helpers for the sale forms ----------
  const kindOf = (m) => m?.kind || 'module';
  const statusOf = (m) => m?.status || (m?.active ? 'selling' : 'draft');
  const sellingModules = () => state.modules.filter((m) => kindOf(m) === 'module' && m.active);
  function priceText(m) {
    if (!m.monthlyPriceKurus) return 'Fiyat girilmedi';
    const price = formatTl(m.monthlyPriceKurus);
    if (kindOf(m) === 'module') return `${price} / ay`;
    if (kindOf(m) === 'usage_pack')
      return `${price} / paket${m.packQuantity ? ` (${m.packQuantity.toLocaleString('tr-TR')} ${m.packUnit || ''})` : ''}`;
    return `${price} / adet`;
  }
  const productName = (code) =>
    code === 'users' ? 'Kullanıcı lisansı' : state.modules.find((m) => m.code === code)?.name || code;
  function discountText(c) {
    return c.discountType === 'percent'
      ? `%${c.discountValue} indirim`
      : `${formatTl(c.discountValue)} indirim`;
  }
  // Campaign choice on a sale form: a live campaign from the list, or a typed coupon code.
  function campaignFields() {
    return [
      {
        name: 'campaignId',
        label: 'Kampanya (isteğe bağlı)',
        type: 'select',
        options: [{ value: '', label: '— Kampanya yok —' }],
        fill: (select) =>
          campaignsQuiet().then((list) =>
            select.append(
              ...list
                .filter((c) => c.live)
                .map((c) =>
                  h('option', {
                    value: c.id,
                    text: `${c.name} · ${discountText(c)}, ${LABELS.applies[c.applies].toLocaleLowerCase('tr')}`,
                  }),
                ),
            ),
          ),
      },
      {
        name: 'couponCode',
        label: 'veya kupon kodu',
        type: 'text',
        hint: 'Kampanya seçmediyseniz büronun ilettiği kupon kodunu yazın. Uygunluğu sunucu denetler.',
      },
    ];
  }
  function campaignBody(v) {
    if (v.campaignId && v.couponCode) throw new Error('Kampanya veya kupon kodundan yalnızca birini girin.');
    return {
      campaignId: v.campaignId || undefined,
      couponCode: v.campaignId ? undefined : v.couponCode ? v.couponCode.toUpperCase() : undefined,
    };
  }
  const campaignNote = (r) =>
    r.campaignDiscountKurus ? ` · kampanya indirimi ${formatTl(r.campaignDiscountKurus)}` : '';
  // Live preview of a campaign or coupon (POST campaigns/quote). Answers are cached per input so
  // re-rendering the preview does not repeat the request; a refusal (expired, not eligible…)
  // is shown in the form instead of failing it.
  const quotes = new Map();
  function campaignPreview(v, { tenantId, lines, payableKurus }) {
    if (!v.campaignId && !v.couponCode) return null;
    const node = h('div', { class: 'quote' }, 'Kampanya indirimi hesaplanıyor…');
    let body;
    try {
      body = { ...campaignBody(v), tenantId: tenantId || undefined, lines };
    } catch (e) {
      node.replaceChildren(h('span', { class: 'neg', text: e.message }));
      return node;
    }
    if (!lines.length || !lines.some((l) => l.amountKurus > 0)) {
      node.textContent = 'Kampanya indirimini görmek için tutarları girin.';
      return node;
    }
    const show = (r) => {
      if (r.error)
        node.replaceChildren(h('span', { class: 'neg', text: 'Kampanya uygulanamaz: ' + r.error }));
      else if (!r.discountKurus)
        node.replaceChildren(
          h('span', { class: 'neg', text: `“${r.campaign.name}” bu satıştaki ürünlere uygulanmıyor.` }),
        );
      else
        node.replaceChildren(
          `Kampanya “${r.campaign.name}”: `,
          h('b', { text: '− ' + formatTl(r.discountKurus) }),
          payableKurus === undefined
            ? ' (KDV hariç)'
            : ` · kampanya sonrası KDV hariç ${formatTl(Math.max(payableKurus - r.discountKurus, 0))}`,
        );
    };
    const key = JSON.stringify(body);
    let answer = quotes.get(key);
    if (!answer) {
      answer = api('campaigns/quote', { method: 'POST', body }).catch((e) => ({ error: e.message }));
      quotes.set(key, answer);
    }
    answer.then(show);
    return node;
  }
  const slugOf = (name) =>
    String(name || '')
      .toLocaleLowerCase('tr')
      .replace(/[çğıöşü]/g, (c) => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' })[c])
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);

  // `prospect`: a new-office opportunity from the sales pipeline; its details prefill the form
  // and the sale marks it won.
  function openOfficeDialog(prospect = null) {
    const catalog = sellingModules();
    const priceOf = (codes) => catalog.filter((m) => codes.includes(m.code)).map((m) => m.monthlyPriceKurus);
    return formDialog({
      title: 'Yeni büro sat',
      intro:
        'Büro, ilk yönetici hesabı, abonelik ve satış kaydı birlikte oluşturulur.' +
        (prospect ? ` Satış hunisindeki “${prospect.officeName}” fırsatı kazanıldı olarak kapanır.` : ''),
      submitLabel: 'Satışı tamamla',
      wide: true,
      fields: [
        { name: 'name', label: 'Büro adı', type: 'text', required: true, value: prospect?.officeName },
        {
          name: 'slug',
          label: 'Büro kodu (alt alan adı)',
          type: 'text',
          required: true,
          value: prospect ? slugOf(prospect.officeName) : undefined,
          hint: 'Küçük harf, rakam, tire. Örn: ornek-hukuk → ornek-hukuk.alanadiniz.com',
        },
        {
          name: 'adminName',
          label: 'İlk yönetici adı',
          type: 'text',
          required: true,
          value: prospect?.contactName || undefined,
        },
        { name: 'adminUsername', label: 'İlk yönetici kullanıcı adı', type: 'text', required: true },
        {
          name: 'adminPassword',
          label: 'Geçici şifre',
          type: 'password',
          required: true,
          hint: 'En az 10 karakter. Yöneticiye güvenli bir kanaldan iletin.',
        },
        {
          name: 'userCount',
          label: 'Kullanıcı (çalışan) sayısı',
          type: 'number',
          required: true,
          value: prospect?.expectedUsers || 3,
          min: 1,
          max: 10000,
        },
        {
          name: 'userPrice',
          label: 'Kullanıcı başı aylık fiyat (TL, KDV hariç)',
          type: 'tl',
          required: true,
        },
        {
          name: 'termMonths',
          label: 'Süre',
          type: 'select',
          numeric: true,
          value: '12',
          options: [1, 3, 6, 12, 24, 36].map((n) => ({ value: String(n), label: n + ' ay' })),
        },
        {
          name: 'moduleCodes',
          label: 'Ek modüller (KDV hariç)',
          type: 'modules',
          options: catalog,
          value: prospect?.productCodes,
        },
        { name: 'discount', label: 'İndirim (TL, KDV hariç, toplam üzerinden)', type: 'tl' },
        ...campaignFields(),
        vatField(),
        { name: 'invoiceNo', label: 'Fatura no (isteğe bağlı)', type: 'text' },
        { name: 'paid', label: 'Tahsilat yapıldı', type: 'checkbox' },
      ],
      preview: (v) => {
        const t = previewTotals({
          userCount: v.userCount,
          userPriceKurus: v.userPrice,
          termMonths: v.termMonths,
          modulePrices: priceOf(v.moduleCodes),
          discountKurus: v.discount,
          vatRatePercent: v.vat,
        });
        return [
          h('div', {}, `Kullanıcılar: ${formatTl(t.users)} · Modüller: ${formatTl(t.modules)}`),
          h(
            'div',
            {},
            'Toplam: ',
            h('b', { text: formatTl(t.total) }),
            t.discount ? ` − indirim ${formatTl(t.discount)}` : '',
          ),
          h(
            'div',
            {},
            'KDV hariç: ',
            h('b', { text: formatTl(t.payable) }),
            ` · KDV (%${v.vat}): ${formatTl(t.vat)}`,
          ),
          h(
            'div',
            {},
            'KDV dahil ödenecek: ',
            h('b', { text: formatTl(t.gross) }),
            ' (nihai tutarı sunucu hesaplar)',
          ),
          campaignPreview(v, {
            lines: [
              {
                code: 'users',
                monthlyKurus: v.userCount * v.userPrice,
                months: v.termMonths,
                amountKurus: t.users,
              },
              ...catalog
                .filter((m) => v.moduleCodes.includes(m.code))
                .map((m) => ({
                  code: m.code,
                  monthlyKurus: m.monthlyPriceKurus,
                  months: v.termMonths,
                  amountKurus: m.monthlyPriceKurus * v.termMonths,
                })),
            ],
            payableKurus: t.payable,
          }),
        ];
      },
      submit: async (v) => {
        const result = await api('offices', {
          method: 'POST',
          body: {
            slug: v.slug,
            name: v.name,
            userCount: v.userCount,
            userPriceKurus: v.userPrice,
            termMonths: v.termMonths,
            moduleCodes: v.moduleCodes,
            discountKurus: v.discount ?? 0,
            vatRatePercent: v.vat,
            paid: v.paid,
            invoiceNo: v.invoiceNo,
            admin: { name: v.adminName, username: v.adminUsername, password: v.adminPassword },
            ...campaignBody(v),
            prospectId: prospect?.id,
          },
        });
        toast(
          `Büro açıldı: ${result.office.name} — KDV hariç ${formatTl(result.payableKurus)}, KDV dahil ${formatTl(result.payableKurus + (result.vatKurus || 0))}${campaignNote(result)}`,
        );
      },
    }).then((done) => done && refresh());
  }

  // ---------- office detail ----------
  async function openDetail(tenantId) {
    let detail;
    try {
      [detail] = await Promise.all([api('offices/' + tenantId), campaignsQuiet()]);
    } catch (e) {
      return toast(e.message, true);
    }
    const o = detail.office;
    const dialog = h('dialog', { class: 'wide' });
    const reopen = async () => {
      dialog.close();
      await refresh();
      openDetail(tenantId);
    };
    const act = (open) => async () => {
      if (await open(detail)) await reopen();
    };
    const sub = o.subscription;
    const live = o.status !== 'closed' && !!sub;
    const activeMods = detail.modules.filter((m) => m.status === 'active' || m.status === 'trial');
    const buttons = [];
    if (live) {
      buttons.push(
        h('button', { class: 'btn', text: 'Kullanıcı sayısı', onclick: act(changeUsersDialog) }),
        h('button', { class: 'btn', text: 'Modül ekle', onclick: act(addModuleDialog) }),
        trialOptions(detail).length
          ? h('button', { class: 'btn', text: 'Deneme başlat', onclick: act(trialDialog) })
          : null,
        oneOffProducts().length
          ? h('button', { class: 'btn', text: 'Ürün sat', onclick: act(sellProductDialog) })
          : null,
        h('button', { class: 'btn primary', text: 'Yenile / uzat', onclick: act(renewDialog) }),
        h('button', { class: 'btn', text: 'İade', onclick: act(refundDialog) }),
      );
      if (o.status === 'enabled')
        buttons.push(
          h('button', {
            class: 'btn danger',
            text: 'Pasife al',
            onclick: act((d) => statusDialog(d, 'suspended')),
          }),
        );
      if (o.status === 'suspended' || o.status === 'provisioning')
        buttons.push(
          h('button', {
            class: 'btn primary',
            text: 'Aktifleştir',
            onclick: act((d) => statusDialog(d, 'enabled')),
          }),
        );
      if (!o.legacy)
        buttons.push(
          h('button', { class: 'btn danger', text: 'Kapat', onclick: act((d) => statusDialog(d, 'closed')) }),
        );
      buttons.push(h('button', { class: 'btn', text: 'Yönetici şifresi', onclick: act(managerResetDialog) }));
      if (o.pendingKurus > 0 && state.dash.onlinePaymentsConfigured)
        buttons.push(
          h('button', { class: 'btn primary', text: 'Online ödeme linki', onclick: act(paymentLinkDialog) }),
        );
    }
    if (o.legacy) buttons.push(badge('Mevcut büro: kök alan adıyla çalışır, buradan pasife alınamaz'));
    dialog.append(
      h(
        'div',
        { class: 'dialog-head' },
        h(
          'div',
          {},
          h('h3', { text: o.name }),
          h('p', { text: `${o.slug} · oluşturulma ${dateText(o.createdAt)}` }),
        ),
        h(
          'div',
          { class: 'toolbar' },
          statusBadge(o),
          h('button', { class: 'btn small', text: 'Kapat', onclick: () => dialog.close() }),
        ),
      ),
      h(
        'div',
        { class: 'dialog-body' },
        h(
          'div',
          { class: 'facts' },
          h(
            'div',
            {},
            h('small', { text: 'Abonelik' }),
            h('b', {
              text: sub ? (sub.expired ? 'Süresi doldu' : LABELS.subscription[sub.status]) : 'Tanımsız',
            }),
          ),
          h(
            'div',
            {},
            h('small', { text: 'Bitiş' }),
            h('b', { text: sub ? dateText(sub.accessUntil) : '—' }),
          ),
          h(
            'div',
            {},
            h('small', { text: 'Kullanıcı' }),
            h('b', { text: o.userLimit === null ? '—' : `${o.usersUsed} / ${o.userLimit}` }),
          ),
          h(
            'div',
            {},
            h('small', { text: 'Birim fiyat / ay' }),
            h('b', { text: o.userPriceKurus === null ? '—' : formatTl(o.userPriceKurus) }),
          ),
          h('div', {}, h('small', { text: 'Aylık değer' }), h('b', { text: formatTl(o.monthlyKurus) })),
          h(
            'div',
            {},
            h('small', { text: 'Tahsil edilen / bekleyen (KDV hariç)' }),
            h('b', { text: `${formatTl(o.paidKurus)} / ${formatTl(o.pendingKurus)}` }),
          ),
          detail.costKurus !== undefined
            ? h(
                'div',
                {},
                h('small', { text: 'Bu büroya ait gider / net katkı' }),
                h('b', {
                  text: `${formatTl(detail.costKurus)} / ${formatTl(o.paidKurus - detail.costKurus)}`,
                }),
              )
            : null,
        ),
        h(
          'div',
          { class: 'actions' },
          buttons,
          h('button', {
            class: 'btn',
            text: 'Destek kaydı aç',
            onclick: async () => {
              dialog.close();
              await newTicketDialog(tenantId);
            },
          }),
        ),
        officeTickets(tenantId, dialog),
        detail.payments?.length
          ? h(
              'div',
              {},
              h('p', { class: 'section-title', text: 'Online ödemeler' }),
              h(
                'div',
                { class: 'list' },
                detail.payments.map((x) =>
                  h(
                    'div',
                    {},
                    h(
                      'span',
                      {},
                      `${formatTl(x.amountKurus)} (KDV dahil) · ${dateTimeText(x.createdAt)}`,
                      x.note ? h('small', { text: x.note }) : null,
                    ),
                    badge(
                      LABELS.payment[x.status],
                      x.status === 'paid'
                        ? 'ok'
                        : x.status === 'review' || x.status === 'failed'
                          ? 'bad'
                          : x.status === 'initiated'
                            ? 'warn'
                            : '',
                    ),
                  ),
                ),
              ),
            )
          : null,
        h(
          'div',
          {},
          h('p', { class: 'section-title', text: 'Modüller' }),
          activeMods.length
            ? h(
                'div',
                { class: 'list' },
                activeMods.map((m) =>
                  h(
                    'div',
                    {},
                    m.status === 'trial'
                      ? h(
                          'span',
                          {},
                          `${m.name} `,
                          new Date(m.trialUntil).getTime() > Date.now()
                            ? badge(`Deneme · ${dateText(m.trialUntil)} tarihine kadar`, 'warn')
                            : badge(`Deneme bitti · ${dateText(m.trialUntil)}`, 'bad'),
                          h('small', { text: 'Satışa çevirmek için “Modül ekle”yi kullanın.' }),
                        )
                      : h('span', { text: `${m.name} — ${formatTl(m.priceKurus)} / ay (KDV hariç)` }),
                    live
                      ? h('button', {
                          class: 'link',
                          text: 'Çıkar',
                          onclick: act((d) => removeModuleDialog(d, m)),
                        })
                      : null,
                  ),
                ),
              )
            : h('p', { class: 'empty', text: 'Ek modül yok.' }),
        ),
        h('div', {}, h('p', { class: 'section-title', text: 'Satışlar' }), salesTable(detail.sales, act)),
        h(
          'div',
          {},
          h('p', { class: 'section-title', text: 'İşlem geçmişi' }),
          detail.events.length
            ? h(
                'div',
                { class: 'events' },
                detail.events.map((e) =>
                  h(
                    'div',
                    {},
                    `${LABELS.event[e.action] || e.action} `,
                    h('small', {
                      text: `${dateTimeText(e.createdAt)} · ${e.admin}${e.detail?.reason ? ' · ' + e.detail.reason : ''}`,
                    }),
                  ),
                ),
              )
            : h('p', { class: 'empty', text: 'Kayıt yok.' }),
        ),
      ),
    );
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  function officeTickets(tenantId, dialog) {
    const list = (state.support?.tickets || []).filter((k) => k.tenantId === tenantId).slice(0, 8);
    return h(
      'div',
      {},
      h('p', { class: 'section-title', text: 'Destek kayıtları' }),
      list.length
        ? h(
            'div',
            { class: 'list' },
            list.map((k) =>
              h(
                'div',
                {},
                h('button', {
                  class: 'link',
                  text: `#${k.number} ${k.subject}`,
                  onclick: () => {
                    dialog.close();
                    openTicket(k.id);
                  },
                }),
                ticketBadge(k.status),
              ),
            ),
          )
        : h('p', { class: 'empty', text: 'Destek kaydı yok.' }),
    );
  }

  function salesTable(sales, act) {
    if (!sales.length) return h('p', { class: 'empty', text: 'Satış kaydı yok.' });
    return h(
      'div',
      { class: 'overflow' },
      h(
        'table',
        {},
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            ['Tarih', 'Tür', 'Açıklama', 'KDV hariç', 'KDV', 'KDV dahil', 'Durum', ''].map((t, i) =>
              h('th', { class: i >= 3 && i <= 5 ? 'num' : '', text: t }),
            ),
          ),
        ),
        h(
          'tbody',
          {},
          sales.map((s) =>
            h(
              'tr',
              { class: s.status === 'void' ? 'dim' : '' },
              h('td', { text: dateText(s.createdAt) }),
              h('td', { text: LABELS.kind[s.kind] }),
              h(
                'td',
                {},
                s.description,
                s.invoiceNo ? h('small', { text: 'Fatura: ' + s.invoiceNo }) : null,
                s.voidReason ? h('small', { text: 'İptal: ' + s.voidReason }) : null,
              ),
              h('td', { class: 'num', text: formatTl(s.amountKurus) }),
              h('td', {
                class: 'num',
                text: s.vatKurus === undefined ? '—' : `${formatTl(s.vatKurus)} (%${s.vatRatePercent})`,
              }),
              h('td', { class: 'num', text: s.grossKurus === undefined ? '—' : formatTl(s.grossKurus) }),
              h(
                'td',
                {},
                badge(
                  LABELS.sale[s.status],
                  s.status === 'paid' ? 'ok' : s.status === 'pending' ? 'warn' : 'bad',
                ),
                s.paidAt ? h('small', { text: dateText(s.paidAt) }) : null,
              ),
              h(
                'td',
                {},
                s.status === 'pending'
                  ? h('button', { class: 'btn small', text: 'Tahsil et', onclick: act(() => payDialog(s)) })
                  : null,
                s.status !== 'void' && s.kind !== 'refund'
                  ? h('button', { class: 'link', text: 'İptal', onclick: act(() => voidDialog(s)) })
                  : null,
              ),
            ),
          ),
        ),
      ),
    );
  }

  const money = (v) => (v === undefined ? undefined : v);
  // Every sale form carries its own KDV rate; 20% is only the starting value.
  const vatField = () => ({
    name: 'vat',
    label: 'KDV oranı (%)',
    type: 'number',
    required: true,
    value: 20,
    min: 0,
    max: 100,
    hint: 'Tutarlar KDV hariç girilir; KDV bu orana göre eklenir.',
  });
  const changeUsersDialog = ({ office: o }) =>
    formDialog({
      title: 'Kullanıcı sayısını değiştir',
      intro: `Şu an ${o.userLimit} kullanıcı, ${o.usersUsed} kullanılıyor. Azaltma kullanılan sayının altına inemez.`,
      fields: [
        {
          name: 'userCount',
          label: 'Yeni kullanıcı sayısı',
          type: 'number',
          required: true,
          value: o.userLimit,
          min: Math.max(o.usersUsed, 1),
          max: 10000,
        },
        {
          name: 'price',
          label: 'Kullanıcı başı aylık fiyat (TL)',
          type: 'tl',
          required: true,
          value: (o.userPriceKurus / 100).toFixed(2).replace('.', ','),
        },
        {
          name: 'charge',
          label: 'Tutar (TL, KDV hariç) — isteğe bağlı',
          type: 'tl',
          hint: 'Boş bırakırsanız artış, kalan süreye oranlanarak sunucuda hesaplanır. Azaltmada iade yapılmaz.',
        },
        vatField(),
        { name: 'paid', label: 'Tahsilat yapıldı', type: 'checkbox' },
        { name: 'invoiceNo', label: 'Fatura no', type: 'text' },
      ],
      submit: async (v) => {
        const r = await api(`offices/${o.id}/users`, {
          method: 'POST',
          body: {
            userCount: v.userCount,
            userPriceKurus: v.price,
            chargeKurus: money(v.charge),
            vatRatePercent: v.vat,
            paid: v.paid,
            invoiceNo: v.invoiceNo,
          },
        });
        toast(r.chargeKurus ? `Kaydedildi. Tutar: ${formatTl(r.chargeKurus)}` : 'Kaydedildi.');
      },
    });
  // Remaining months of the subscription, for the campaign preview of a pro-rata module sale
  // (the server uses the exact figure).
  const remainingMonths = (o) => Math.max(o.subscription?.daysLeft || 0, 0) / 30.4375;
  // `extra.prospectId`: an upsell opportunity this sale closes; `extra.preselect`: product codes.
  const addModuleDialog = ({ office: o, modules }, extra = {}) => {
    const owned = new Set(modules.filter((m) => m.status === 'active').map((m) => m.code));
    const options = sellingModules().filter((m) => !owned.has(m.code));
    if (!options.length) {
      toast('Eklenebilecek satışa açık modül yok.', true);
      return Promise.resolve(false);
    }
    const first = options.find((m) => (extra.preselect || []).includes(m.code));
    return formDialog({
      title: 'Modül ekle',
      intro:
        'Modül, aboneliğin kalan süresi kadar oranlı ücretlendirilir. Denemedeki bir modül bu satışla ücretli olur.' +
        (extra.prospectId ? ' Satış hunisindeki fırsat kazanıldı olarak kapanır.' : ''),
      fields: [
        {
          name: 'moduleCode',
          label: 'Modül',
          type: 'select',
          value: first?.code,
          options: options.map((m) => ({
            value: m.code,
            label: `${m.name} — ${formatTl(m.monthlyPriceKurus)} / ay (KDV hariç)${modules.some((x) => x.code === m.code && x.status === 'trial') ? ' · denemede' : ''}`,
          })),
        },
        {
          name: 'charge',
          label: 'Tutar (TL, KDV hariç) — isteğe bağlı',
          type: 'tl',
          hint: 'Boş bırakırsanız kalan süreye oranlı hesaplanır.',
        },
        ...campaignFields(),
        vatField(),
        { name: 'paid', label: 'Tahsilat yapıldı', type: 'checkbox' },
        { name: 'invoiceNo', label: 'Fatura no', type: 'text' },
      ],
      preview: (v) => {
        const m = options.find((x) => x.code === v.moduleCode);
        const months = remainingMonths(o);
        const amount = v.charge ?? Math.round(m.monthlyPriceKurus * months);
        return [
          h(
            'div',
            {},
            v.charge === undefined
              ? `Kalan yaklaşık ${months.toFixed(1)} ay için tahmini tutar: `
              : 'Tutar: ',
            h('b', { text: formatTl(amount) }),
            ` (KDV hariç) · KDV (%${v.vat}): ${formatTl(vatOf(amount, v.vat))}`,
          ),
          campaignPreview(v, {
            tenantId: o.id,
            lines: [{ code: m.code, monthlyKurus: m.monthlyPriceKurus, months, amountKurus: amount }],
            payableKurus: amount,
          }),
        ];
      },
      submit: async (v) => {
        const r = await api(`offices/${o.id}/modules/add`, {
          method: 'POST',
          body: {
            moduleCode: v.moduleCode,
            chargeKurus: money(v.charge),
            vatRatePercent: v.vat,
            paid: v.paid,
            invoiceNo: v.invoiceNo,
            ...campaignBody(v),
            prospectId: extra.prospectId,
          },
        });
        toast(
          r.chargeKurus
            ? `Modül eklendi. Tutar: ${formatTl(r.chargeKurus)} (KDV hariç)${campaignNote(r)}`
            : 'Modül eklendi.',
        );
      },
    });
  };
  // Monthly modules this office can try: on sale or "Yakında", not active and never tried.
  const trialOptions = ({ modules }) => {
    const used = new Set(modules.filter((m) => m.status === 'active' || m.trialUntil).map((m) => m.code));
    return state.modules.filter(
      (m) => kindOf(m) === 'module' && ['selling', 'soon'].includes(statusOf(m)) && !used.has(m.code),
    );
  };
  const trialDialog = (detail) => {
    const o = detail.office;
    const options = trialOptions(detail);
    return formDialog({
      title: 'Deneme başlat',
      intro:
        'Modül seçilen gün kadar ücretsiz açılır ve süre bitince kendiliğinden kapanır. Her büro bir modülü bir kez deneyebilir; denemeyi satışa çevirmek için “Modül ekle”yi kullanın.',
      fields: [
        {
          name: 'moduleCode',
          label: 'Modül',
          type: 'select',
          options: options.map((m) => ({
            value: m.code,
            label: `${m.name}${statusOf(m) === 'soon' ? ' (Yakında)' : ''} — ${m.trialDays ? `varsayılan ${m.trialDays} gün` : 'varsayılan süre yok'}`,
          })),
        },
        {
          name: 'days',
          label: 'Süre (gün, 1–60)',
          type: 'number',
          min: 1,
          max: 60,
          hint: 'Boş bırakırsanız ürünün varsayılan deneme süresi kullanılır.',
        },
      ],
      submitLabel: 'Denemeyi başlat',
      submit: async (v) => {
        const product = options.find((m) => m.code === v.moduleCode);
        if (v.days === undefined && !product.trialDays)
          throw new Error('Bu ürünün varsayılan deneme süresi yok; gün sayısı girin.');
        if (v.days !== undefined && (v.days < 1 || v.days > 60))
          throw new Error('Deneme süresi 1–60 gün olmalıdır.');
        const r = await api(`offices/${o.id}/modules/trial`, {
          method: 'POST',
          body: { moduleCode: v.moduleCode, days: v.days },
        });
        toast(`Deneme başladı: ${product.name}, ${dateText(r.trialUntil)} tarihine kadar.`);
      },
    });
  };
  // One-off products (usage packages, services) that are on sale.
  const oneOffProducts = () => state.modules.filter((m) => kindOf(m) !== 'module' && m.active);
  const sellProductDialog = ({ office: o }, extra = {}) => {
    const products = oneOffProducts();
    if (!products.length) {
      toast('Satışa açık kullanım paketi veya hizmet yok.', true);
      return Promise.resolve(false);
    }
    const first = products.find((m) => (extra.preselect || []).includes(m.code));
    return formDialog({
      title: 'Ürün sat',
      intro:
        'Kullanım paketi veya hizmet tek seferlik satılır. Tutar, fiyat × adettir (KDV hariç); isterseniz elle girin.' +
        (extra.prospectId ? ' Satış hunisindeki fırsat kazanıldı olarak kapanır.' : ''),
      fields: [
        {
          name: 'code',
          label: 'Ürün',
          type: 'select',
          value: first?.code,
          options: products.map((m) => ({
            value: m.code,
            label: `${m.name} (${LABELS.productKind[kindOf(m)]}) — ${priceText(m)}`,
          })),
        },
        { name: 'quantity', label: 'Adet', type: 'number', required: true, value: 1, min: 1, max: 10000 },
        {
          name: 'charge',
          label: 'Tutar (TL, KDV hariç) — isteğe bağlı',
          type: 'tl',
          hint: 'Boş bırakırsanız fiyat × adet kullanılır.',
        },
        ...campaignFields(),
        vatField(),
        { name: 'paid', label: 'Tahsilat yapıldı', type: 'checkbox' },
        { name: 'invoiceNo', label: 'Fatura no', type: 'text' },
      ],
      preview: (v) => {
        const m = products.find((x) => x.code === v.code);
        const listed = m.monthlyPriceKurus * v.quantity;
        const amount = v.charge ?? listed;
        return [
          h(
            'div',
            {},
            `Liste: ${formatTl(m.monthlyPriceKurus)} × ${v.quantity} = ${formatTl(listed)} · Tutar: `,
            h('b', { text: formatTl(amount) }),
            ` (KDV hariç) · KDV (%${v.vat}): ${formatTl(vatOf(amount, v.vat))}`,
          ),
          campaignPreview(v, {
            tenantId: o.id,
            lines: [{ code: m.code, amountKurus: amount, quantity: v.quantity, oneOff: true }],
            payableKurus: amount,
          }),
        ];
      },
      submit: async (v) => {
        const r = await api(`offices/${o.id}/products/sell`, {
          method: 'POST',
          body: {
            code: v.code,
            quantity: v.quantity,
            chargeKurus: money(v.charge),
            paid: v.paid,
            invoiceNo: v.invoiceNo,
            vatRatePercent: v.vat,
            ...campaignBody(v),
            prospectId: extra.prospectId,
          },
        });
        toast(
          `Satış kaydedildi: KDV hariç ${formatTl(r.payableKurus ?? r.amountKurus)}, KDV ${formatTl(r.vatKurus || 0)}${campaignNote(r)}`,
        );
      },
    });
  };
  const removeModuleDialog = ({ office: o }, m) =>
    formDialog({
      title: 'Modülü çıkar',
      intro: `${m.name} bu büroda hemen devre dışı kalır. Otomatik iade yapılmaz.`,
      fields: [],
      submitLabel: 'Çıkar',
      danger: true,
      submit: async () => {
        await api(`offices/${o.id}/modules/remove`, { method: 'POST', body: { moduleCode: m.code } });
        toast('Modül çıkarıldı.');
      },
    });
  const renewDialog = ({ office: o, modules }) => {
    const paidModules = modules.filter((m) => m.status === 'active');
    const monthly = o.userLimit * o.userPriceKurus + paidModules.reduce((s, m) => s + m.priceKurus, 0);
    return formDialog({
      title: 'Aboneliği yenile / uzat',
      intro:
        'Süre, mevcut bitiş tarihinden (geçmişse bugünden) itibaren uzar. Anlaşılan birim fiyatlar kullanılır.',
      fields: [
        {
          name: 'termMonths',
          label: 'Süre',
          type: 'select',
          numeric: true,
          value: '12',
          options: [1, 3, 6, 12, 24, 36].map((n) => ({ value: String(n), label: n + ' ay' })),
        },
        { name: 'discount', label: 'İndirim (TL, KDV hariç)', type: 'tl' },
        ...campaignFields(),
        vatField(),
        { name: 'paid', label: 'Tahsilat yapıldı', type: 'checkbox' },
        { name: 'invoiceNo', label: 'Fatura no', type: 'text' },
      ],
      preview: (v) => {
        const total = monthly * v.termMonths;
        const quote = campaignPreview(v, {
          tenantId: o.id,
          lines: [
            {
              code: 'users',
              monthlyKurus: o.userLimit * o.userPriceKurus,
              months: v.termMonths,
              amountKurus: o.userLimit * o.userPriceKurus * v.termMonths,
            },
            ...paidModules.map((m) => ({
              code: m.code,
              monthlyKurus: m.priceKurus,
              months: v.termMonths,
              amountKurus: m.priceKurus * v.termMonths,
            })),
          ],
          payableKurus: total - Math.min(v.discount || 0, total),
        });
        const t = previewTotals({
          userCount: 1,
          userPriceKurus: total / v.termMonths,
          termMonths: v.termMonths,
          discountKurus: v.discount,
          vatRatePercent: v.vat,
        });
        return [
          h(
            'div',
            {},
            `Aylık değer ${formatTl(monthly)} × ${v.termMonths} ay = `,
            h('b', { text: formatTl(total) }),
          ),
          h(
            'div',
            {},
            'KDV hariç: ',
            h('b', { text: formatTl(t.payable) }),
            ` · KDV (%${v.vat}): ${formatTl(t.vat)} · KDV dahil: `,
            h('b', { text: formatTl(t.gross) }),
          ),
          quote,
        ];
      },
      submit: async (v) => {
        const r = await api(`offices/${o.id}/renew`, {
          method: 'POST',
          body: {
            termMonths: v.termMonths,
            discountKurus: v.discount ?? 0,
            vatRatePercent: v.vat,
            paid: v.paid,
            invoiceNo: v.invoiceNo,
            ...campaignBody(v),
          },
        });
        toast(
          `Yenilendi. Yeni bitiş: ${dateText(r.accessUntil)}${r.payableKurus !== undefined ? ` · KDV hariç ${formatTl(r.payableKurus)}` : ''}${campaignNote(r)}`,
        );
      },
    });
  };
  const refundDialog = ({ office: o }) =>
    formDialog({
      title: 'İade kaydet',
      intro: `Bu büronun tahsil edilen toplamı: ${formatTl(o.paidKurus)}. İade bunu aşamaz.`,
      fields: [
        { name: 'amount', label: 'İade tutarı (TL, KDV hariç)', type: 'tl', required: true },
        vatField(),
        { name: 'description', label: 'Açıklama', type: 'text', required: true },
        { name: 'invoiceNo', label: 'Belge no', type: 'text' },
      ],
      submitLabel: 'İadeyi kaydet',
      danger: true,
      submit: async (v) => {
        await api(`offices/${o.id}/refund`, {
          method: 'POST',
          body: {
            amountKurus: v.amount,
            vatRatePercent: v.vat,
            description: v.description,
            invoiceNo: v.invoiceNo,
          },
        });
        toast('İade kaydedildi.');
      },
    });
  const statusDialog = ({ office: o }, status) => {
    const texts = {
      suspended: [
        'Büroyu pasife al',
        'Büronun tüm kullanıcıları hemen erişemez olur. Veriler silinmez; tekrar aktifleştirilebilir.',
      ],
      enabled: ['Büroyu aktifleştir', 'Geçerli bir abonelik gerekir; süresi dolduysa önce yenileyin.'],
      closed: [
        'Büroyu kapat',
        'Kalıcıdır: kapatılan büro yeniden açılamaz ve satış yapılamaz. Veriler silinmez.',
      ],
    }[status];
    return formDialog({
      title: texts[0],
      intro: texts[1],
      fields: [
        {
          name: 'reason',
          label: status === 'enabled' ? 'Gerekçe (isteğe bağlı)' : 'Gerekçe',
          type: 'text',
          required: status !== 'enabled',
        },
        status === 'closed'
          ? {
              name: 'confirm',
              label: `Onaylamak için büro kodunu yazın (${o.slug})`,
              type: 'text',
              required: true,
            }
          : null,
      ].filter(Boolean),
      submitLabel: texts[0],
      danger: status !== 'enabled',
      submit: async (v) => {
        if (status === 'closed' && v.confirm !== o.slug) throw new Error('Büro kodu eşleşmiyor.');
        await api(`offices/${o.id}/status`, { method: 'POST', body: { status, reason: v.reason } });
        toast('Büro durumu güncellendi.');
      },
    });
  };
  // A locked-out office CEO/admin: send a one-time SMS code, or create a temporary password
  // that is shown once here and read out to the verified person.
  function showTemporaryPassword(result) {
    return new Promise((resolve) => {
      const dialog = h('dialog', {});
      const field = h('input', { type: 'text', readonly: true, 'aria-label': 'Geçici şifre' });
      field.value = result.temporaryPassword;
      dialog.append(
        h(
          'div',
          { class: 'dialog-head' },
          h(
            'div',
            {},
            h('h3', { text: 'Geçici şifre oluşturuldu' }),
            h('p', {
              text: `${result.username} hesabının açık oturumları kapatıldı. Şifreyi kimliğini doğruladığınız kişiye iletin; bu pencere kapanınca bir daha gösterilmez. Kişi giriş yaptıktan sonra Ayarlar'dan kendi şifresini belirlemeli.`,
            }),
          ),
        ),
        h(
          'div',
          { class: 'dialog-body' },
          h('label', { class: 'field' }, h('span', { text: 'Geçici şifre' }), field),
        ),
        h(
          'div',
          { class: 'dialog-foot' },
          h('button', {
            class: 'btn primary',
            type: 'button',
            text: 'İlettim',
            onclick: () => dialog.close(),
          }),
        ),
      );
      dialog.addEventListener('close', () => {
        dialog.remove();
        resolve();
      });
      document.body.append(dialog);
      dialog.showModal();
      field.select();
    });
  }
  const managerResetDialog = async ({ office: o }) => {
    let managers;
    try {
      managers = (await api(`offices/${o.id}/managers`)).managers;
    } catch (e) {
      toast(e.message, true);
      return false;
    }
    if (!managers.length) {
      toast('Bu büroda etkin yönetici hesabı bulunamadı.', true);
      return false;
    }
    let result = null;
    const done = await formDialog({
      title: 'Yönetici şifresi sıfırla',
      intro: `${o.name}: önce arayan kişinin kimliğini doğrulayın. SMS kodu, hesabın kayıtlı cep telefonuna platform SMS hesabından gider; kişi "Şifremi unuttum" ekranında kendi şifresini belirler. Geçici şifre ise burada bir kez gösterilir ve hesabın açık oturumlarını kapatır.`,
      fields: [
        {
          name: 'userId',
          label: 'Hesap',
          type: 'select',
          options: managers.map((m) => ({
            value: m.id,
            label: `${m.name} (${m.username}) · ${m.role === 'ceo' ? 'CEO' : 'Yönetici'} · ${m.phone ? 'tel ' + m.phone : 'telefon yok'}`,
          })),
        },
        {
          name: 'mode',
          label: 'Yöntem',
          type: 'select',
          options: [
            { value: 'sms', label: 'Kayıtlı cep telefonuna SMS ile geçici şifre gönder' },
            { value: 'password', label: 'Geçici şifre oluştur (burada gösterilir)' },
          ],
        },
      ],
      submitLabel: 'Sıfırla',
      submit: async (v) => {
        result = await api(`offices/${o.id}/managers/reset`, { method: 'POST', body: v });
      },
    });
    if (!done) return false;
    if (result.mode === 'password') await showTemporaryPassword(result);
    else toast(`Geçici şifre ${result.phone} numarasına SMS ile gönderildi.`);
    return false;
  };
  // Creates an iyzico checkout for everything this office still owes (KDV included) and shows the link.
  const paymentLinkDialog = async ({ office: o }) => {
    let result = null;
    const done = await formDialog({
      title: 'Online ödeme linki',
      intro: `${o.name}: bekleyen satışların KDV dahil toplamı için iyzico ödeme sayfası oluşturulur. Ödeme alınınca satışlar kendiliğinden tahsil edilmiş olur. Yeni link oluşturunca eskisi geçersiz sayılır.`,
      wide: true,
      fields: [
        { name: 'name', label: 'Ödemeyi yapacak kişinin adı', type: 'text', required: true },
        { name: 'surname', label: 'Soyadı', type: 'text', required: true },
        { name: 'email', label: 'E-posta', type: 'text', required: true },
        { name: 'gsmNumber', label: 'Telefon (isteğe bağlı)', type: 'text', hint: 'Örn: +905320000000' },
        {
          name: 'identityNumber',
          label: 'TC kimlik / vergi no (isteğe bağlı)',
          type: 'text',
          hint: 'Canlı ödemede gerçek numara girin; boşsa iyzico deneme değeri gönderilir.',
        },
        { name: 'address', label: 'Adres', type: 'text', required: true },
        { name: 'city', label: 'Şehir', type: 'text', required: true },
      ],
      submitLabel: 'Link oluştur',
      submit: async (v) => {
        result = await api(`offices/${o.id}/payment-link`, { method: 'POST', body: { buyer: v } });
      },
    });
    if (!done || !result) return false;
    await showLink(result);
    return true;
  };
  function showLink(result) {
    return new Promise((resolve) => {
      const dialog = h('dialog', {});
      const field = h('input', {
        type: 'text',
        readonly: true,
        value: result.url,
        'aria-label': 'Ödeme linki',
      });
      field.value = result.url;
      const copy = h('button', {
        class: 'btn',
        type: 'button',
        text: 'Kopyala',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(result.url);
            toast('Link kopyalandı.');
          } catch {
            field.select();
          }
        },
      });
      dialog.append(
        h(
          'div',
          { class: 'dialog-head' },
          h(
            'div',
            {},
            h('h3', { text: 'Ödeme linki hazır' }),
            h('p', { text: `Tutar (KDV dahil): ${formatTl(result.amountKurus)}` }),
          ),
        ),
        h(
          'div',
          { class: 'dialog-body' },
          h('label', { class: 'field' }, h('span', { text: 'Müşteriye gönderin' }), field),
          h('div', { class: 'actions' }, copy),
        ),
        h(
          'div',
          { class: 'dialog-foot' },
          h('button', { class: 'btn primary', type: 'button', text: 'Tamam', onclick: () => dialog.close() }),
        ),
      );
      dialog.addEventListener('close', () => {
        dialog.remove();
        resolve();
      });
      document.body.append(dialog);
      dialog.showModal();
    });
  }
  const payDialog = (s) =>
    formDialog({
      title: 'Tahsilatı işle',
      intro: `${s.description} — KDV hariç ${formatTl(s.amountKurus)}${s.grossKurus !== undefined ? ', KDV dahil ' + formatTl(s.grossKurus) : ''}`,
      fields: [{ name: 'invoiceNo', label: 'Fatura no (isteğe bağlı)', type: 'text' }],
      submitLabel: 'Tahsil edildi',
      submit: async (v) => {
        await api(`sales/${s.id}/paid`, { method: 'POST', body: { invoiceNo: v.invoiceNo } });
        toast('Tahsilat işlendi.');
      },
    });
  const voidDialog = (s) =>
    formDialog({
      title: 'Satışı iptal et',
      intro:
        'Kayıt silinmez, gelirden düşülür. Verilen hizmet (kullanıcı, modül, süre) geri alınmaz; gerekiyorsa ayrıca değiştirin.',
      fields: [{ name: 'reason', label: 'Gerekçe', type: 'text', required: true }],
      submitLabel: 'İptal et',
      danger: true,
      submit: async (v) => {
        await api(`sales/${s.id}/void`, { method: 'POST', body: { reason: v.reason } });
        toast('Satış iptal edildi.');
      },
    });

  // ---------- month selector shared by sales and expenses ----------
  function monthSelect() {
    const months = state.dash.revenue.months.map((m) => m.month).reverse();
    return h(
      'select',
      {
        class: 'search',
        'aria-label': 'Ay',
        onchange: (e) => {
          state.month = e.target.value;
          state.sales = null;
          state.expenses = null;
          renderApp();
          loadTabData();
        },
      },
      months.map((m) => h('option', { value: m, text: monthText(m), selected: m === state.month })),
    );
  }
  const loading = () => h('p', { class: 'empty', text: 'Yükleniyor…' });
  const th = (labels, numFrom = []) =>
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        labels.map((t, i) => h('th', { class: numFrom.includes(i) ? 'num' : '', text: t })),
      ),
    );
  const num = (value) => h('td', { class: 'num', text: formatTl(value) });

  // ---------- sales (with KDV) ----------
  function totalsCards(title, t, note) {
    return h(
      'div',
      { class: 'kpis' },
      kpi(title + ' — KDV hariç', formatTl(t.netKurus), note),
      kpi(title + ' — KDV', formatTl(t.vatKurus), 'ay boyunca toplanan KDV'),
      kpi(title + ' — KDV dahil', formatTl(t.grossKurus), `${t.count} kayıt`),
    );
  }
  function renderSales() {
    const r = state.sales;
    const head = h(
      'div',
      { class: 'heading' },
      h(
        'div',
        {},
        h('p', { class: 'eyebrow', text: 'Satış ve KDV' }),
        h('h2', { text: 'Satışlar' }),
        h('p', {
          text: 'Tutarlar KDV hariç girilir; KDV, satış anındaki orana göre hesaplanır. Tahsil edilenler tahsilat ayına yazılır.',
        }),
      ),
      h(
        'div',
        { class: 'toolbar' },
        monthSelect(),
        h('button', { class: 'btn primary', text: 'Yeni büro sat', onclick: () => openOfficeDialog() }),
      ),
    );
    if (!r) return h('div', {}, head, loading());
    const sales = h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'panelhead' },
        h(
          'div',
          {},
          h('h3', { text: monthText(r.month) + ' satışları' }),
          h('p', { text: 'Tahsil edilen, bekleyen ve iptal edilen kayıtlar' }),
        ),
      ),
      r.sales.length
        ? h(
            'div',
            { class: 'overflow' },
            h(
              'table',
              {},
              th(
                ['Tarih', 'Büro', 'Tür', 'Açıklama', 'KDV hariç', 'KDV %', 'KDV', 'KDV dahil', 'Durum', ''],
                [4, 5, 6, 7],
              ),
              h(
                'tbody',
                {},
                r.sales.map((s) =>
                  h(
                    'tr',
                    { class: s.status === 'void' ? 'dim' : '' },
                    h('td', { text: dateText(s.paidAt || s.createdAt) }),
                    h(
                      'td',
                      {},
                      h('button', {
                        class: 'link',
                        text: s.tenantName,
                        onclick: () => openDetail(s.tenantId),
                      }),
                    ),
                    h('td', { text: LABELS.kind[s.kind] }),
                    h(
                      'td',
                      {},
                      s.description,
                      s.invoiceNo ? h('small', { text: 'Fatura: ' + s.invoiceNo }) : null,
                    ),
                    num(s.amountKurus),
                    h('td', { class: 'num', text: '%' + s.vatRatePercent }),
                    num(s.vatKurus),
                    num(s.grossKurus),
                    h(
                      'td',
                      {},
                      badge(
                        LABELS.sale[s.status],
                        s.status === 'paid' ? 'ok' : s.status === 'pending' ? 'warn' : 'bad',
                      ),
                    ),
                    h(
                      'td',
                      {},
                      s.status === 'pending'
                        ? [
                            h('button', {
                              class: 'btn small',
                              text: 'Tahsil et',
                              onclick: async () => (await payDialog(s)) && refresh(),
                            }),
                            h('button', {
                              class: 'link',
                              text: 'İptal',
                              onclick: async () => (await voidDialog(s)) && refresh(),
                            }),
                          ]
                        : null,
                    ),
                  ),
                ),
              ),
              h(
                'tfoot',
                {},
                h(
                  'tr',
                  { class: 'total' },
                  h('td', { colspan: '4', text: 'Ay sonu toplam (tahsil edilen)' }),
                  num(r.collected.netKurus),
                  h('td', {}),
                  num(r.collected.vatKurus),
                  num(r.collected.grossKurus),
                  h('td', {}),
                  h('td', {}),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty', text: 'Bu ay satış kaydı yok.' }),
    );
    const rates = r.byRate.length
      ? h(
          'section',
          { class: 'panel' },
          h(
            'div',
            { class: 'panelhead' },
            h(
              'div',
              {},
              h('h3', { text: 'KDV oranına göre' }),
              h('p', { text: 'Beyanname hazırlığı için tahsil edilen satışların oran dökümü' }),
            ),
          ),
          h(
            'div',
            { class: 'overflow' },
            h(
              'table',
              {},
              th(['KDV oranı', 'Kayıt', 'KDV hariç', 'KDV', 'KDV dahil'], [1, 2, 3, 4]),
              h(
                'tbody',
                {},
                r.byRate.map((x) =>
                  h(
                    'tr',
                    {},
                    h('td', { text: '%' + x.ratePercent }),
                    h('td', { class: 'num', text: String(x.count) }),
                    num(x.netKurus),
                    num(x.vatKurus),
                    num(x.grossKurus),
                  ),
                ),
              ),
            ),
          ),
        )
      : null;
    const pending = state.dash.pendingSales;
    const receivable = pending.length
      ? h(
          'section',
          { class: 'panel' },
          h(
            'div',
            { class: 'panelhead' },
            h(
              'div',
              {},
              h('h3', { text: 'Bekleyen alacaklar (tüm aylar)' }),
              h('p', {
                text: `${pending.length} kayıt · toplam ${formatTl(state.dash.revenue.pendingKurus)} (KDV hariç)`,
              }),
            ),
          ),
          h(
            'div',
            { class: 'overflow' },
            h(
              'table',
              {},
              th(['Tarih', 'Büro', 'Açıklama', 'KDV hariç', 'KDV', 'KDV dahil', ''], [3, 4, 5]),
              h(
                'tbody',
                {},
                pending.map((s) =>
                  h(
                    'tr',
                    {},
                    h('td', { text: dateText(s.createdAt) }),
                    h(
                      'td',
                      {},
                      h('button', {
                        class: 'link',
                        text: s.tenantName,
                        onclick: () => openDetail(s.tenantId),
                      }),
                    ),
                    h('td', { text: s.description }),
                    num(s.amountKurus),
                    num(s.vatKurus),
                    num(s.grossKurus),
                    h(
                      'td',
                      {},
                      h('button', {
                        class: 'btn small',
                        text: 'Tahsil et',
                        onclick: async () => (await payDialog(s)) && refresh(),
                      }),
                    ),
                  ),
                ),
              ),
            ),
          ),
        )
      : null;
    return h(
      'div',
      {},
      head,
      totalsCards('Ay sonu tahsilat', r.collected, monthText(r.month)),
      totalsCards('Bekleyen', r.pending, 'henüz tahsil edilmedi'),
      sales,
      rates,
      receivable,
    );
  }

  // ---------- expenses ----------
  function expenseDialog() {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    return formDialog({
      title: 'Gider ekle',
      intro:
        'Reklam, sunucu, yapay zekâ kullanımı gibi maliyetleri KDV hariç tutarla girin. Yabancı para faturalarını TL karşılığıyla yazın.',
      wide: true,
      fields: [
        { name: 'spentOn', label: 'Tarih (YYYY-AA-GG)', type: 'text', required: true, value: iso },
        {
          name: 'category',
          label: 'Kategori',
          type: 'select',
          value: 'advertising',
          options: Object.entries(LABELS.expense).map(([value, label]) => ({ value, label })),
        },
        {
          name: 'description',
          label: 'Açıklama',
          type: 'text',
          required: true,
          hint: 'Örn: Google Ads kasım kampanyası',
        },
        { name: 'vendor', label: 'Tedarikçi', type: 'text' },
        { name: 'amount', label: 'Tutar (TL, KDV hariç)', type: 'tl', required: true },
        {
          name: 'vat',
          label: 'KDV oranı (%)',
          type: 'number',
          required: true,
          value: 20,
          min: 0,
          max: 100,
          hint: 'Faturadaki oran; indirilecek KDV hesabında kullanılır.',
        },
        {
          name: 'tenantId',
          label: 'Belirli bir büroya ait mi? (isteğe bağlı)',
          type: 'select',
          options: [
            { value: '', label: '— Genel gider —' },
            ...state.dash.officeList.map((o) => ({ value: o.id, label: o.name })),
          ],
          hint: 'Örn. bir büronun yapay zekâ kullanımı; o büronun gerçek kârını görmek için.',
        },
        {
          name: 'moduleCode',
          label: 'Ürün (isteğe bağlı)',
          type: 'select',
          options: [{ value: '', label: '— Ürüne bağlı değil —' }, ...productChoices(false)],
          hint: 'Ürüne bağlanan gider, Kârlılık sekmesinde o ürünün kârından düşülür.',
        },
        { name: 'invoiceNo', label: 'Fatura no', type: 'text' },
      ],
      preview: (v) => {
        const vat = vatOf(v.amount, v.vat);
        return [
          h(
            'div',
            {},
            `KDV hariç: ${formatTl(v.amount)} · KDV (%${v.vat}): ${formatTl(vat)} · `,
            h('b', { text: 'KDV dahil: ' + formatTl(v.amount + vat) }),
          ),
        ];
      },
      submit: async (v) => {
        await api('expenses', {
          method: 'POST',
          body: {
            spentOn: v.spentOn,
            category: v.category,
            description: v.description,
            vendor: v.vendor,
            amountKurus: v.amount,
            vatRatePercent: v.vat,
            tenantId: v.tenantId || undefined,
            moduleCode: v.moduleCode || undefined,
            invoiceNo: v.invoiceNo,
          },
        });
        toast('Gider kaydedildi.');
      },
    }).then((done) => done && refresh());
  }
  const voidExpenseDialog = (x) =>
    formDialog({
      title: 'Gideri iptal et',
      intro: `${x.description} — ${formatTl(x.amountKurus)} (KDV hariç). Kayıt silinmez, toplamlardan düşer.`,
      fields: [{ name: 'reason', label: 'Gerekçe', type: 'text', required: true }],
      submitLabel: 'İptal et',
      danger: true,
      submit: async (v) => {
        await api(`expenses/${x.id}/void`, { method: 'POST', body: { reason: v.reason } });
        toast('Gider iptal edildi.');
      },
    });
  function renderExpenses() {
    const r = state.expenses;
    const head = h(
      'div',
      { class: 'heading' },
      h(
        'div',
        {},
        h('p', { class: 'eyebrow', text: 'Maliyetler' }),
        h('h2', { text: 'Giderler' }),
        h('p', {
          text: 'Reklam, pazarlama, sunucu, yapay zekâ ve telefon maliyetleri. Ürün ve büro kârını Kârlılık sekmesinde görürsünüz. Her ay tekrarlanan giderleri bir kez tanımlayın.',
        }),
      ),
      h(
        'div',
        { class: 'toolbar' },
        monthSelect(),
        h('button', { class: 'btn', text: 'Tekrarlayan gider', onclick: recurringDialog }),
        h('button', { class: 'btn primary', text: 'Gider ekle', onclick: expenseDialog }),
      ),
    );
    if (!r) return h('div', {}, head, loading());
    return h(
      'div',
      {},
      head,
      totalsCards('Aylık gider', r.total, monthText(r.month)),
      h(
        'section',
        { class: 'panel' },
        h('div', { class: 'panelhead' }, h('h3', { text: 'Kategoriye göre' })),
        r.byCategory.length
          ? h(
              'div',
              { class: 'overflow' },
              h(
                'table',
                {},
                th(['Kategori', 'Kayıt', 'KDV hariç', 'KDV', 'KDV dahil'], [1, 2, 3, 4]),
                h(
                  'tbody',
                  {},
                  r.byCategory.map((c) =>
                    h(
                      'tr',
                      {},
                      h('td', { text: LABELS.expense[c.category] }),
                      h('td', { class: 'num', text: String(c.count) }),
                      num(c.netKurus),
                      num(c.vatKurus),
                      num(c.grossKurus),
                    ),
                  ),
                ),
                h(
                  'tfoot',
                  {},
                  h(
                    'tr',
                    { class: 'total' },
                    h('td', { text: 'Toplam' }),
                    h('td', { class: 'num', text: String(r.total.count) }),
                    num(r.total.netKurus),
                    num(r.total.vatKurus),
                    num(r.total.grossKurus),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty', text: 'Bu ay gider kaydı yok.' }),
      ),
      r.expenses.length
        ? h(
            'section',
            { class: 'panel' },
            h('div', { class: 'panelhead' }, h('h3', { text: monthText(r.month) + ' giderleri' })),
            h(
              'div',
              { class: 'overflow' },
              h(
                'table',
                {},
                th(
                  [
                    'Tarih',
                    'Kategori',
                    'Açıklama',
                    'Büro / ürün',
                    'KDV hariç',
                    'KDV %',
                    'KDV',
                    'KDV dahil',
                    '',
                  ],
                  [4, 5, 6, 7],
                ),
                h(
                  'tbody',
                  {},
                  r.expenses.map((x) =>
                    h(
                      'tr',
                      { class: x.status === 'void' ? 'dim' : '' },
                      h('td', { text: dateText(x.spentOn) }),
                      h('td', { text: LABELS.expense[x.category] }),
                      h(
                        'td',
                        {},
                        x.description,
                        x.recurring ? [' ', badge('Tekrarlayan')] : null,
                        x.vendor
                          ? h('small', { text: x.vendor + (x.invoiceNo ? ' · Fatura: ' + x.invoiceNo : '') })
                          : x.invoiceNo
                            ? h('small', { text: 'Fatura: ' + x.invoiceNo })
                            : null,
                        x.voidReason ? h('small', { text: 'İptal: ' + x.voidReason }) : null,
                      ),
                      h('td', { text: [x.tenantName, x.moduleName].filter(Boolean).join(' · ') || '—' }),
                      num(x.amountKurus),
                      h('td', { class: 'num', text: '%' + x.vatRatePercent }),
                      num(x.vatKurus),
                      num(x.grossKurus),
                      h(
                        'td',
                        {},
                        x.status === 'active'
                          ? h('button', {
                              class: 'link',
                              text: 'İptal',
                              onclick: async () => (await voidExpenseDialog(x)) && refresh(),
                            })
                          : badge('İptal', 'bad'),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
        : null,
    );
  }

  // ---------- profitability: products, offices, unit costs, recurring expenses, monthly summary ----------
  const UNIT_FIELDS = [
    ['aiInputPerMillionKurus', 'Yapay zekâ: 1 milyon girdi token (TL)'],
    ['aiOutputPerMillionKurus', 'Yapay zekâ: 1 milyon çıktı token (TL)'],
    ['smsSegmentKurus', 'SMS parçası (TL)'],
    ['voipMinuteKurus', 'Telefon dakikası (TL)'],
    ['mapsSearchKurus', 'Harita servisi: bir arama (TL)'],
    ['mapsDetailKurus', 'Harita servisi: rota yenilemede bir firma (TL)'],
  ];
  const reloadProfit = async () => {
    state.profit = null;
    renderApp();
    await loadTabData();
  };
  function unitCostsDialog() {
    const units = state.profit?.unitCosts || {};
    return formDialog({
      title: 'Birim maliyetler',
      intro:
        'Büro ve ürün kârını paylaştırmak için kullanılan tahmini kullanım maliyeti bu birimlerle hesaplanır. KDV hariç girin; yabancı para fiyatları TL karşılığıyla yazın.',
      fields: UNIT_FIELDS.map(([name, label]) => ({
        name,
        label,
        type: 'tl',
        required: true,
        value: tlText(units[name] || 0),
      })),
      submit: async (v) => {
        await api('settings/unit-costs', { method: 'POST', body: v });
        toast('Birim maliyetler kaydedildi.');
      },
    }).then((done) => done && reloadProfit());
  }
  function recurringDialog() {
    return formDialog({
      title: 'Tekrarlayan gider ekle',
      intro:
        'Sunucu, yazılım aboneliği gibi her ay aynı tutarla gelen giderler. Her ay seçilen günde gider kaydı kendiliğinden oluşur (KDV hariç tutar).',
      wide: true,
      fields: [
        {
          name: 'category',
          label: 'Kategori',
          type: 'select',
          value: 'server',
          options: Object.entries(LABELS.expense).map(([value, label]) => ({ value, label })),
        },
        { name: 'description', label: 'Açıklama', type: 'text', required: true, hint: 'Örn: Sunucu kirası' },
        { name: 'vendor', label: 'Tedarikçi', type: 'text' },
        { name: 'amount', label: 'Aylık tutar (TL, KDV hariç)', type: 'tl', required: true },
        { name: 'vat', label: 'KDV oranı (%)', type: 'number', required: true, value: 20, min: 0, max: 100 },
        {
          name: 'dayOfMonth',
          label: 'Ayın günü (1–28)',
          type: 'number',
          required: true,
          value: 1,
          min: 1,
          max: 28,
        },
        { name: 'startsOn', label: 'Başlangıç', type: 'date', required: true, value: isoDay() },
        { name: 'endsOn', label: 'Bitiş (isteğe bağlı)', type: 'date' },
        {
          name: 'tenantId',
          label: 'Belirli bir büroya ait mi? (isteğe bağlı)',
          type: 'select',
          options: [
            { value: '', label: '— Genel gider —' },
            ...state.dash.officeList.map((o) => ({ value: o.id, label: o.name })),
          ],
        },
        {
          name: 'moduleCode',
          label: 'Ürün (isteğe bağlı)',
          type: 'select',
          options: [{ value: '', label: '— Ürüne bağlı değil —' }, ...productChoices(false)],
          hint: 'Ürüne bağlanan gider, o ürünün kârından düşülür.',
        },
      ],
      preview: (v) => {
        const vat = vatOf(v.amount, v.vat);
        return [
          h(
            'div',
            {},
            `Her ay ${v.dayOfMonth}. gün: KDV hariç ${formatTl(v.amount)} · KDV (%${v.vat}): ${formatTl(vat)} · `,
            h('b', { text: 'KDV dahil: ' + formatTl(v.amount + vat) }),
          ),
        ];
      },
      submit: async (v) => {
        if (v.dayOfMonth < 1 || v.dayOfMonth > 28) throw new Error('Ayın günü 1–28 olmalıdır.');
        if (v.endsOn && v.endsOn < v.startsOn) throw new Error('Bitiş başlangıçtan önce olamaz.');
        await api('recurring-expenses', {
          method: 'POST',
          body: {
            category: v.category,
            description: v.description,
            vendor: v.vendor,
            amountKurus: v.amount,
            vatRatePercent: v.vat,
            tenantId: v.tenantId || undefined,
            moduleCode: v.moduleCode || undefined,
            dayOfMonth: v.dayOfMonth,
            startsOn: v.startsOn,
            endsOn: v.endsOn,
          },
        });
        toast('Tekrarlayan gider kaydedildi.');
      },
    }).then(async (done) => {
      if (!done) return;
      state.recurring = state.profit = state.finance = state.expenses = null;
      renderApp();
      await loadTabData();
    });
  }
  const stopRecurringDialog = (x) =>
    formDialog({
      title: 'Tekrarlayan gideri durdur',
      intro: `${x.description} — ${formatTl(x.amountKurus)} / ay (KDV hariç). Bundan sonra yeni ay kaydı oluşmaz; geçmiş kayıtlar kalır.`,
      fields: [],
      submitLabel: 'Durdur',
      danger: true,
      submit: () => api(`recurring-expenses/${x.id}/stop`, { method: 'POST', body: {} }),
    }).then(async (done) => {
      if (!done) return;
      toast('Tekrarlayan gider durduruldu.');
      state.recurring = null;
      renderApp();
      await loadTabData();
    });
  const marginCell = (value) =>
    h('td', {
      class: 'num' + (value !== null && value < 0 ? ' neg' : ''),
      text: value === null ? '—' : '%' + value,
    });
  const profitCell = (value) => h('td', { class: 'num' + (value < 0 ? ' neg' : ''), text: formatTl(value) });
  function monthRange() {
    const months = state.dash.revenue.months.map((m) => m.month).reverse();
    const pick = (key, label) =>
      h(
        'select',
        {
          class: 'search',
          'aria-label': label,
          onchange: (e) => {
            state[key] = e.target.value;
            if (state.profitFrom > state.profitTo)
              [state.profitFrom, state.profitTo] = [state.profitTo, state.profitFrom];
            reloadProfit();
          },
        },
        months.map((m) => h('option', { value: m, text: monthText(m), selected: m === state[key] })),
      );
    return [
      pick('profitFrom', 'Başlangıç ayı'),
      h('span', { class: 'muted', text: '–' }),
      pick('profitTo', 'Bitiş ayı'),
    ];
  }
  function profitSections(p) {
    if (!p) return [loading()];
    if (p.error) return [h('p', { class: 'empty formerror', text: 'Kârlılık raporu alınamadı: ' + p.error })];
    const k = p.indicators;
    const usage = (o) => o.usage || {};
    const unitLine = UNIT_FIELDS.map(
      ([key, label]) => `${label.replace(' (TL)', '')}: ${formatTl(p.unitCosts[key])}`,
    ).join(' · ');
    return [
      h(
        'div',
        { class: 'kpis' },
        kpi(
          'Dönem geliri (KDV hariç)',
          formatTl(p.totals.revenueKurus),
          `${monthText(p.from)} – ${monthText(p.to)}`,
        ),
        kpi('Ürünlere bağlı gider', formatTl(p.totals.linkedExpenseKurus), 'KDV hariç, girilen giderler'),
        kpi(
          'Tahmini kullanım maliyeti',
          formatTl(p.totals.usageCostKurus),
          `yapay zekâ, SMS, telefon, harita · platform SMS ${formatTl(p.totals.smsUsageCostKurus)}`,
        ),
        kpi(
          'Aylık yinelenen gelir',
          formatTl(k.mrrKurus),
          `KDV hariç · büro başına ${k.arpuKurus === null ? '—' : formatTl(k.arpuKurus)}`,
        ),
        kpi(
          'Aktif büro',
          String(k.activeOffices),
          `${k.expiredOffices} süresi dolmuş · ${k.lostOffices} kayıp`,
        ),
        kpi(
          'Kayıp oranı',
          k.churnPercent === null ? '—' : '%' + k.churnPercent,
          `bu ay ${k.renewalsThisMonth} yenileme`,
          {
            alert: (k.churnPercent || 0) > 10,
          },
        ),
      ),
      h(
        'section',
        { class: 'panel' },
        h(
          'div',
          { class: 'panelhead' },
          h(
            'div',
            {},
            h('h3', { text: 'Ürün kârlılığı' }),
            h('p', { text: 'Tahsil edilen gelir, KDV hariç' }),
          ),
        ),
        p.products.length
          ? h(
              'div',
              { class: 'overflow' },
              h(
                'table',
                {},
                th(
                  ['Ürün', 'Tür', 'Gelir', 'Bağlı gider', 'Kullanım maliyeti (tahmini)', 'Kâr', 'Marj'],
                  [2, 3, 4, 5, 6],
                ),
                h(
                  'tbody',
                  {},
                  p.products.map((x) =>
                    h(
                      'tr',
                      { class: x.profitKurus < 0 ? 'loss' : '' },
                      h('td', {}, h('strong', { text: x.name || productName(x.code) })),
                      h('td', {
                        text: x.code === 'users' ? 'Abonelik' : LABELS.productKind[x.kind] || '—',
                      }),
                      num(x.revenueKurus),
                      num(x.expenseKurus),
                      num(x.usageCostKurus),
                      profitCell(x.profitKurus),
                      marginCell(x.marginPercent),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty', text: 'Bu dönemde ürün geliri yok.' }),
      ),
      h(
        'section',
        { class: 'panel' },
        h(
          'div',
          { class: 'panelhead' },
          h(
            'div',
            {},
            h('h3', { text: 'Büro kârlılığı' }),
            h('p', {
              text: 'Zarar eden bürolar üstte. Kullanım, dönem içindeki yapay zekâ, SMS ve telefon tüketimidir.',
            }),
          ),
        ),
        p.offices.length
          ? h(
              'div',
              { class: 'overflow' },
              h(
                'table',
                {},
                th(
                  [
                    'Büro',
                    'Durum',
                    'Gelir',
                    'Gider',
                    'Yapay zekâ',
                    'SMS',
                    'Telefon',
                    'Harita',
                    'Kullanım maliyeti (tahmini)',
                    'Kâr',
                    'Marj',
                  ],
                  [2, 3, 4, 5, 6, 7, 8, 9, 10],
                ),
                h(
                  'tbody',
                  {},
                  p.offices.map((o) =>
                    h(
                      'tr',
                      { class: o.profitKurus < 0 ? 'loss' : '' },
                      h(
                        'td',
                        {},
                        h('button', { class: 'link', text: o.name, onclick: () => openDetail(o.tenantId) }),
                        h('small', { text: o.slug }),
                      ),
                      h(
                        'td',
                        {},
                        statusBadge(o),
                        o.accessUntil ? h('small', { text: 'Bitiş ' + dateText(o.accessUntil) }) : null,
                      ),
                      num(o.revenueKurus),
                      num(o.expenseKurus),
                      h(
                        'td',
                        { class: 'num' },
                        `${(usage(o).aiRequests || 0).toLocaleString('tr-TR')} istek`,
                        h('small', {
                          text: `${((usage(o).aiInputTokens || 0) + (usage(o).aiOutputTokens || 0)).toLocaleString('tr-TR')} token`,
                        }),
                      ),
                      h('td', {
                        class: 'num',
                        text: `${(usage(o).smsSegments || 0).toLocaleString('tr-TR')} parça`,
                      }),
                      h('td', {
                        class: 'num',
                        text: `${(usage(o).voipMinutes || 0).toLocaleString('tr-TR')} dk`,
                      }),
                      h(
                        'td',
                        { class: 'num' },
                        `${(usage(o).mapsSearches || 0).toLocaleString('tr-TR')} arama`,
                        usage(o).mapsDetails
                          ? h('small', {
                              text: `${usage(o).mapsDetails.toLocaleString('tr-TR')} firma yenileme`,
                            })
                          : null,
                      ),
                      h(
                        'td',
                        { class: 'num' },
                        formatTl(o.usageCostKurus),
                        o.usageCost
                          ? h('small', {
                              text: `YZ ${formatTl(o.usageCost.ai)} · SMS ${formatTl(o.usageCost.sms)} · Tel ${formatTl(o.usageCost.voip)} · Harita ${formatTl(o.usageCost.maps || 0)}`,
                            })
                          : null,
                      ),
                      profitCell(o.profitKurus),
                      marginCell(o.marginPercent),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty', text: 'Büro yok.' }),
        h(
          'p',
          { class: 'tablenote' },
          'Kullanım maliyeti tahminidir; büro ve ürün kârını paylaştırmak için kullanılır. Aylık kâr/zarar yalnızca girilen giderlerle hesaplanır.',
        ),
        h('p', { class: 'tablenote', text: 'Birim maliyetler (KDV hariç): ' + unitLine }),
      ),
      k.reach.length
        ? h(
            'section',
            { class: 'panel' },
            h(
              'div',
              { class: 'panelhead' },
              h(
                'div',
                {},
                h('h3', { text: 'Modül yaygınlığı' }),
                h('p', { text: 'Aktif büroların kaçı modülü kullanıyor' }),
              ),
            ),
            h(
              'div',
              { class: 'panelbody list' },
              k.reach.map((x) =>
                h(
                  'div',
                  {},
                  h('span', { text: x.name }),
                  h('b', { text: `${x.offices} büro${x.percent === null ? '' : ' · %' + x.percent}` }),
                ),
              ),
            ),
          )
        : null,
    ];
  }
  function recurringPanel() {
    const list = state.recurring;
    return h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'panelhead' },
        h(
          'div',
          {},
          h('h3', { text: 'Tekrarlayan giderler' }),
          h('p', { text: 'Her ay seçilen günde Giderler sekmesine kendiliğinden yazılır (KDV hariç).' }),
        ),
        h('button', { class: 'btn small primary', text: 'Tekrarlayan gider ekle', onclick: recurringDialog }),
      ),
      !list
        ? loading()
        : list.length
          ? h(
              'div',
              { class: 'overflow' },
              h(
                'table',
                {},
                th(
                  [
                    'Açıklama',
                    'Kategori',
                    'Büro / ürün',
                    'Aylık (KDV hariç)',
                    'KDV %',
                    'Gün',
                    'Dönem',
                    'Son kayıt',
                    'Durum',
                    '',
                  ],
                  [3, 4, 5],
                ),
                h(
                  'tbody',
                  {},
                  list.map((x) =>
                    h(
                      'tr',
                      { class: x.active ? '' : 'dim' },
                      h(
                        'td',
                        {},
                        h('strong', { text: x.description }),
                        x.vendor ? h('small', { text: x.vendor }) : null,
                      ),
                      h('td', { text: LABELS.expense[x.category] || x.category }),
                      h('td', { text: [x.tenantName, x.moduleName].filter(Boolean).join(' · ') || 'Genel' }),
                      num(x.amountKurus),
                      h('td', { class: 'num', text: '%' + x.vatRatePercent }),
                      h('td', { class: 'num', text: String(x.dayOfMonth) }),
                      h('td', {
                        text: `${dateText(x.startsOn)} → ${x.endsOn ? dateText(x.endsOn) : 'süresiz'}`,
                      }),
                      h('td', { text: x.lastPeriod ? monthText(x.lastPeriod) : '—' }),
                      h('td', {}, badge(x.active ? 'Aktif' : 'Durduruldu', x.active ? 'ok' : '')),
                      h(
                        'td',
                        {},
                        x.active
                          ? h('button', {
                              class: 'link',
                              text: 'Durdur',
                              onclick: () => stopRecurringDialog(x),
                            })
                          : null,
                      ),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty', text: 'Tekrarlayan gider yok.' }),
    );
  }
  function renderFinance() {
    const f = state.finance;
    const p = state.profit;
    const head = h(
      'div',
      { class: 'heading' },
      h(
        'div',
        {},
        h('p', { class: 'eyebrow', text: 'Kâr ve zarar' }),
        h('h2', { text: 'Kârlılık' }),
        h('p', {
          text: 'Ürün ve büro bazında kârlılık, birim maliyetler, tekrarlayan giderler ve son 12 ayın kâr/zarar–KDV özeti. Tutarlar KDV hariçtir.',
        }),
      ),
      h(
        'div',
        { class: 'toolbar' },
        p && !p.error ? monthRange() : null,
        h('button', { class: 'btn', text: 'Birim maliyetler', onclick: unitCostsDialog }),
      ),
    );
    if (!f) return h('div', {}, head, loading());
    const t = f.totals;
    const margin = t.salesNetKurus > 0 ? Math.round((t.profitKurus / t.salesNetKurus) * 100) : null;
    return h(
      'div',
      {},
      head,
      profitSections(p),
      recurringPanel(),
      h(
        'section',
        { class: 'panel' },
        h(
          'div',
          { class: 'panelhead' },
          h(
            'div',
            {},
            h('h3', { text: 'Aylık kâr / zarar ve KDV' }),
            h('p', {
              text: 'Son 12 ay: satış geliri, girilen gider, kâr ve ödenecek KDV. Tahsilat ve harcama tarihine göredir; resmî beyan için mali müşavirinize danışın.',
            }),
          ),
        ),
        h(
          'div',
          { class: 'kpis inset' },
          kpi(
            '12 ay satış (KDV hariç)',
            formatTl(t.salesNetKurus),
            `KDV dahil ${formatTl(t.salesGrossKurus)}`,
          ),
          kpi('12 ay gider (KDV hariç)', formatTl(t.costNetKurus), 'reklam, sunucu, yapay zekâ …'),
          kpi('Kâr', formatTl(t.profitKurus), margin === null ? 'satış yok' : `kâr marjı %${margin}`, {
            alert: t.profitKurus < 0,
          }),
          kpi(
            'Ödenecek KDV',
            formatTl(t.vatPayableKurus),
            `hesaplanan ${formatTl(t.salesVatKurus)} − indirilecek ${formatTl(t.costVatKurus)}`,
          ),
        ),
        h(
          'div',
          { class: 'overflow' },
          h(
            'table',
            {},
            th(
              [
                'Ay',
                'Satış (hariç)',
                'Hesaplanan KDV',
                'Gider (hariç)',
                'İndirilecek KDV',
                'Kâr',
                'Ödenecek KDV',
                'Yeni büro',
                'Büro başına reklam-pazarlama',
              ],
              [1, 2, 3, 4, 5, 6, 7, 8],
            ),
            h(
              'tbody',
              {},
              f.months.map((m) =>
                h(
                  'tr',
                  {},
                  h('td', { text: monthText(m.month) }),
                  num(m.salesNetKurus),
                  num(m.salesVatKurus),
                  num(m.costNetKurus),
                  num(m.costVatKurus),
                  h('td', {
                    class: 'num ' + (m.profitKurus < 0 ? 'neg' : ''),
                    text: formatTl(m.profitKurus),
                  }),
                  num(m.vatPayableKurus),
                  h('td', { class: 'num', text: String(m.newOffices) }),
                  h('td', {
                    class: 'num',
                    text: m.costPerNewOfficeKurus === null ? '—' : formatTl(m.costPerNewOfficeKurus),
                  }),
                ),
              ),
            ),
            h(
              'tfoot',
              {},
              h(
                'tr',
                { class: 'total' },
                h('td', { text: '12 ay toplam' }),
                num(t.salesNetKurus),
                num(t.salesVatKurus),
                num(t.costNetKurus),
                num(t.costVatKurus),
                num(t.profitKurus),
                num(t.vatPayableKurus),
                h('td', {}),
                h('td', {}),
              ),
            ),
          ),
        ),
      ),
    );
  }

  // ---------- support ----------
  const ACTIVE = ['open', 'waiting_customer'];
  function ticketBadge(status) {
    return badge(
      LABELS.ticketStatus[status],
      status === 'open' ? 'warn' : status === 'waiting_customer' ? '' : status === 'resolved' ? 'ok' : '',
    );
  }
  const priorityBadge = (p) => badge(LABELS.priority[p], p === 'urgent' ? 'bad' : p === 'high' ? 'warn' : '');

  // ---------- remote support access ----------
  // An office grants the support team a time-limited access on a ticket. state: pending (waiting
  // for the team), connected (inside the office now), overtime (time is up, more can be added),
  // closed. `state.support.access` maps ticket id -> the open grant.
  const ACCESS_BADGE = {
    pending: ['Erişim izni var', 'warn'],
    connected: ['Şu an bağlı', 'ok'],
    overtime: ['Süre doldu', 'bad'],
  };
  const accessBadge = (grant) => {
    const entry = grant && ACCESS_BADGE[grant.state];
    return entry ? badge(entry[0], entry[1]) : null;
  };
  const pendingAccessCount = () =>
    Object.values(state.support?.access || {}).filter((grant) => grant.state === 'pending').length;
  const EXTEND_WINDOW_SECONDS = 5 * 60;
  const RESOLVED_NOTE = 'Sorun çözüldü, lütfen test edin. Sorun devam ederse bu kayda yazın.';
  const clockText = (seconds) => `${pad2(Math.floor(seconds / 60))}:${pad2(seconds % 60)}`;
  // Time of day when the moment is today, otherwise the date too; no seconds.
  function whenText(value) {
    if (!value) return '—';
    const d = new Date(value);
    const options = { hour: '2-digit', minute: '2-digit' };
    if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString('tr-TR', options);
    return d.toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', ...options });
  }
  // The "Erişim izni" box of a ticket. `reloadThread` re-fetches the messages, `onGrant(grant)` is
  // told the open grant (or null) so the list badges stay current. The one-second countdown runs
  // only while connected; dispose() stops everything and must run when the detail closes.
  function accessPanel(ticketId, { reloadThread, onGrant }) {
    const base = `support/${ticketId}/access`;
    const node = h('section', { class: 'accessbox', 'aria-label': 'Erişim izni', hidden: true });
    let grant = null;
    let deadlineAt = 0;
    let timer = null;
    let offeredExtend = false;
    let busy = false;
    let loading = false;
    let disposed = false;
    const isOpen = (g) => !!g && g.state !== 'closed';
    const secondsLeft = () => Math.max(0, Math.round((deadlineAt - Date.now()) / 1000));
    const stopTimer = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const canExtend = (left) =>
      (grant.state === 'connected' || grant.state === 'overtime') &&
      !grant.selfExtended &&
      (grant.state === 'overtime' || left <= EXTEND_WINDOW_SECONDS);

    function paint() {
      stopTimer();
      if (disposed) return;
      node.hidden = !grant;
      node.classList.toggle('closed', !!grant && !isOpen(grant));
      if (!grant) return node.replaceChildren();
      let left = grant.state === 'connected' ? secondsLeft() : 0;
      if (grant.state === 'connected' && left === 0) grant = { ...grant, state: 'overtime', remainingSeconds: 0 };
      const countdown = h('span', { class: 'countdown', text: clockText(left) });
      const status = {
        pending: h('b', { class: 'warn', text: `Bağlantı bekliyor · ${whenText(grant.offerUntil)} saatine kadar` }),
        connected: h('b', { class: 'ok' }, 'Bağlı · kalan ', countdown),
        overtime: h('b', { class: 'neg', text: 'Süre doldu' }),
        closed: h('b', { text: 'Kapandı' + (grant.endedBy ? ': ' + grant.endedBy : '') }),
      }[grant.state];
      const tile = (label, value) => h('div', {}, h('small', { text: label }), value);
      const buttons = [];
      if (grant.state === 'pending' || grant.state === 'connected')
        buttons.push(h('button', { class: 'btn primary', type: 'button', text: 'Büroya bağlan', onclick: act(connect) }));
      offeredExtend = canExtend(left);
      if (offeredExtend)
        buttons.push(h('button', { class: 'btn', type: 'button', text: '+15 dk uzat', onclick: act(extend) }));
      if ((grant.state === 'connected' || grant.state === 'overtime') && !grant.extensionRequest)
        buttons.push(h('button', { class: 'btn', type: 'button', text: 'Ek süre iste', onclick: act(requestMore) }));
      if (isOpen(grant))
        buttons.push(h('button', { class: 'btn danger', type: 'button', text: 'Bağlantıyı bitir', onclick: act(end) }));
      node.replaceChildren(
        h(
          'div',
          { class: 'accesshead' },
          h('h3', { class: 'section-title', text: 'Erişim izni' }),
          h('p', {
            text: isOpen(grant)
              ? 'Büronun destek ekibine verdiği süreli izin. Süre, ekip ilk kez bağlandığında başlar.'
              : 'Son erişim izni · kapanış ' + dateTimeText(grant.endedAt),
          }),
        ),
        h(
          'div',
          { class: 'facts' },
          tile('Süre', h('b', { text: `${grant.minutes} dk` })),
          tile('Yetki', h('b', { text: grant.allowEdit ? 'Değişiklik yapabilir' : 'Yalnızca görüntüleme' })),
          tile('İzni veren', h('b', { text: grant.grantedBy || '—' })),
          grant.connectedBy ? tile('Bağlanan', h('b', { text: grant.connectedBy })) : null,
          tile('Durum', status),
        ),
        isOpen(grant) && grant.extensionRequest
          ? h(
              'p',
              { class: 'accessnote' },
              h('b', { text: `Büro onayı bekleniyor: ${grant.extensionRequest.minutes} dk` }),
              grant.extensionRequest.note ? ` · Not: ${grant.extensionRequest.note}` : null,
            )
          : null,
        buttons.length ? h('div', { class: 'actions' }, buttons) : null,
      );
      if (grant.state === 'connected')
        timer = setInterval(() => {
          left = secondsLeft();
          if (left <= 0) {
            grant = { ...grant, state: 'overtime', remainingSeconds: 0 };
            paint();
            onGrant(grant);
            fetchAccess().catch(() => {});
          } else if (canExtend(left) !== offeredExtend) paint();
          else countdown.textContent = clockText(left);
        }, 1000);
    }
    function setList(list) {
      grant = list.find(isOpen) || list[0] || null;
      deadlineAt = Date.now() + (grant?.remainingSeconds || 0) * 1000;
      paint();
      onGrant(isOpen(grant) ? grant : null);
    }
    async function fetchAccess() {
      const r = await api(base);
      if (!disposed && Array.isArray(r.access)) setList(r.access);
    }
    async function reload() {
      await Promise.all([fetchAccess(), reloadThread()]);
    }
    // Runs one button action: one at a time, errors shown as a toast, box and messages reloaded.
    function act(work) {
      return async () => {
        if (busy) return;
        busy = true;
        node.querySelectorAll('button').forEach((b) => (b.disabled = true));
        try {
          if ((await work()) !== false) await reload();
        } catch (e) {
          toast(e.message, true);
        } finally {
          busy = false;
          if (!disposed) paint();
        }
      };
    }
    async function connect() {
      const r = await api(`${base}/connect`, { method: 'POST', body: {} });
      if (!r.url) throw new Error('Bağlantı adresi alınamadı.');
      window.open(r.url, '_blank', 'noopener');
      toast('Büro yeni sekmede açılıyor. Açılmazsa tarayıcının açılır pencere engelini kaldırıp yeniden deneyin.');
    }
    async function extend() {
      await api(`${base}/extend`, { method: 'POST', body: {} });
      toast('Süre 15 dakika uzatıldı.');
    }
    async function end() {
      if (!window.confirm('Büronun bağlantısı hemen sonlandırılsın mı? Büro yeniden izin vermedikçe tekrar bağlanılamaz.'))
        return false;
      await api(`${base}/end`, { method: 'POST', body: {} });
      toast('Bağlantı sonlandırıldı.');
    }
    async function requestMore() {
      const sent = await formDialog({
        title: 'Ek süre iste',
        intro: 'İstek büroya iletilir; büro onaylamadan süre eklenmez.',
        fields: [
          {
            name: 'minutes',
            label: 'Ek süre',
            type: 'select',
            numeric: true,
            value: '15',
            options: ['15', '30', '60'].map((value) => ({ value, label: value + ' dk' })),
          },
          {
            name: 'note',
            label: 'Büroya not (isteğe bağlı)',
            type: 'textarea',
            maxlength: 300,
            hint: 'Neden ek süre gerektiğini kısaca yazın.',
          },
        ],
        submitLabel: 'İste',
        submit: (v) => api(`${base}/request-extension`, { method: 'POST', body: { minutes: v.minutes, note: v.note } }),
      });
      if (!sent) return false;
      toast('Ek süre isteği büroya iletildi.');
    }
    return {
      node,
      set: (list) => setList(list),
      // Back in the console (e.g. from the office tab): pick up the connection quietly.
      refreshQuietly: async () => {
        if (loading || busy || disposed || !isOpen(grant)) return;
        loading = true;
        try {
          await reload();
        } catch {
          // the next focus or action tries again
        } finally {
          loading = false;
        }
      },
      dispose: () => {
        disposed = true;
        stopTimer();
      },
    };
  }

  function renderSupport() {
    const s = state.support;
    const q = state.ticketQ.trim().toLocaleLowerCase('tr');
    const list = s.tickets.filter(
      (k) =>
        (state.ticketFilter === 'all' ||
          (state.ticketFilter === 'active' ? ACTIVE.includes(k.status) : k.status === state.ticketFilter)) &&
        (!q || (k.subject + ' ' + k.officeName + ' #' + k.number).toLocaleLowerCase('tr').includes(q)),
    );
    const sum = s.summary;
    return h(
      'div',
      {},
      h(
        'div',
        { class: 'heading' },
        h(
          'div',
          {},
          h('p', { class: 'eyebrow', text: 'Müşteri desteği' }),
          h('h2', { text: 'Destek kayıtları' }),
          h('p', {
            text: 'Telefon, WhatsApp veya e-postayla gelen talepleri kaydedin, yanıtlayın ve çözülene kadar izleyin.',
          }),
        ),
        h(
          'div',
          { class: 'toolbar' },
          h('input', {
            class: 'search',
            type: 'search',
            placeholder: 'Konu, büro veya no',
            value: state.ticketQ,
            'aria-label': 'Destek ara',
            oninput: (e) => {
              state.ticketQ = e.target.value;
              const pos = e.target.selectionStart;
              renderApp();
              const box = app.querySelector('input.search');
              box.focus();
              box.setSelectionRange(pos, pos);
            },
          }),
          h(
            'select',
            {
              class: 'search',
              'aria-label': 'Durum',
              onchange: (e) => {
                state.ticketFilter = e.target.value;
                renderApp();
              },
            },
            [['active', 'Aktif'], ['all', 'Tümü'], ...Object.entries(LABELS.ticketStatus)].map(([v, l]) =>
              h('option', { value: v, text: l, selected: state.ticketFilter === v }),
            ),
          ),
          h('button', { class: 'btn primary', text: 'Yeni destek kaydı', onclick: () => newTicketDialog() }),
        ),
      ),
      h(
        'div',
        { class: 'kpis' },
        kpi('Açık', String(sum.open), `${sum.waitingCustomer} müşteri yanıtı bekleniyor`),
        kpi('Acil', String(sum.urgent), 'aktif acil kayıt', { alert: sum.urgent > 0 }),
        kpi('Yanıt gecikmiş', String(sum.overdue), 'ilk yanıt hedefini aştı', { alert: sum.overdue > 0 }),
        kpi(
          'Ortalama ilk yanıt',
          sum.avgFirstResponseHours === null ? '—' : sum.avgFirstResponseHours + ' sa',
          `son 30 gün · ${sum.resolvedLast30Days} çözüldü`,
        ),
      ),
      h(
        'section',
        { class: 'panel' },
        list.length
          ? h(
              'div',
              { class: 'overflow' },
              h(
                'table',
                {},
                th(['No', 'Büro', 'Konu', 'Öncelik', 'Durum', 'Kanal', 'Üstlenen', 'Son işlem', '']),
                h(
                  'tbody',
                  {},
                  list.map((k) =>
                    h(
                      'tr',
                      { class: ACTIVE.includes(k.status) ? '' : 'dim' },
                      h('td', { text: '#' + k.number }),
                      h('td', { text: k.officeName }),
                      h(
                        'td',
                        {},
                        h('strong', { text: k.subject }),
                        k.overdue
                          ? h('small', {
                              class: 'neg',
                              text: 'Yanıt hedefi aşıldı: ' + dateTimeText(k.responseDueAt),
                            })
                          : null,
                      ),
                      h('td', {}, priorityBadge(k.priority)),
                      h('td', {}, h('div', { class: 'badges' }, ticketBadge(k.status), accessBadge(s.access?.[k.id]))),
                      h('td', { text: LABELS.channel[k.channel] }),
                      h('td', { text: k.assignedTo ? k.assignedTo.name : '—' }),
                      h('td', { text: dateTimeText(k.updatedAt) }),
                      h(
                        'td',
                        {},
                        h('button', { class: 'btn small', text: 'Aç', onclick: () => openTicket(k.id) }),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty', text: 'Bu görünümde destek kaydı yok.' }),
      ),
    );
  }
  function newTicketDialog(tenantId) {
    return formDialog({
      title: 'Yeni destek kaydı',
      intro:
        'Müşteriden gelen talebi kaydedin. İlk yanıt hedefi önceliğe göre belirlenir (acil 4, yüksek 8, normal 24, düşük 72 saat).',
      wide: true,
      fields: [
        {
          name: 'tenantId',
          label: 'Büro',
          type: 'select',
          required: true,
          value: tenantId,
          options: state.dash.officeList.map((o) => ({ value: o.id, label: o.name })),
        },
        { name: 'subject', label: 'Konu', type: 'text', required: true },
        {
          name: 'category',
          label: 'Kategori',
          type: 'select',
          value: 'technical',
          options: Object.entries(LABELS.category).map(([value, label]) => ({ value, label })),
        },
        {
          name: 'priority',
          label: 'Öncelik',
          type: 'select',
          value: 'normal',
          options: Object.entries(LABELS.priority).map(([value, label]) => ({ value, label })),
        },
        {
          name: 'channel',
          label: 'Talep nereden geldi?',
          type: 'select',
          value: 'phone',
          options: Object.entries(LABELS.channel).map(([value, label]) => ({ value, label })),
        },
        { name: 'contactName', label: 'Bildiren kişi', type: 'text' },
        { name: 'contactInfo', label: 'Telefon / e-posta', type: 'text' },
        {
          name: 'body',
          label: 'Talep',
          type: 'textarea',
          required: true,
          hint: 'Müvekkil veya dosya bilgisi yazmayın; yalnızca sorunu anlatın.',
        },
      ],
      submitLabel: 'Kaydı aç',
      submit: async (v) => {
        const r = await api('support', { method: 'POST', body: v });
        toast(`Destek kaydı #${r.number} açıldı.`);
      },
    }).then((done) => done && refresh());
  }
  async function openTicket(ticketId) {
    let detail;
    let grants = null;
    try {
      // The access list is optional: if it cannot be read the box falls back to the list data.
      [detail, grants] = await Promise.all([
        api('support/' + ticketId),
        api(`support/${ticketId}/access`).then(
          (r) => (Array.isArray(r.access) ? r.access : null),
          () => null,
        ),
      ]);
    } catch (e) {
      return toast(e.message, true);
    }
    const k = detail.ticket;
    const dialog = h('dialog', { class: 'wide' });
    const thread = h('div', { class: 'thread' });
    const paintThread = (messages) =>
      thread.replaceChildren(
        ...messages.map((m) =>
          h(
            'div',
            { class: 'msg ' + m.kind },
            h(
              'div',
              { class: 'msghead' },
              badge(
                LABELS.messageKind[m.kind],
                m.kind === 'internal' ? 'warn' : m.kind === 'operator' ? 'ok' : '',
              ),
              h('small', {
                text: `${m.kind === 'customer' ? (k.contactName || 'Müşteri') + ' (kaydeden: ' + (m.author || '—') + ')' : m.author || ''} · ${dateTimeText(m.createdAt)}`,
              }),
            ),
            h('p', { class: 'msgbody', text: m.body }),
          ),
        ),
      );
    paintThread(detail.messages);
    let gone = false;
    const reloadThread = async () => {
      const fresh = await api('support/' + ticketId);
      if (!gone) paintThread(fresh.messages);
    };
    // Keep the ticket list's "Erişim izni var / Şu an bağlı" badges and the overview card current.
    const onGrant = (grant) => {
      if (!state.support) return;
      const map = (state.support.access = state.support.access || {});
      const before = map[ticketId]?.state;
      if (grant) map[ticketId] = grant;
      else delete map[ticketId];
      if (before !== map[ticketId]?.state) renderApp();
    };
    const access = accessPanel(ticketId, { reloadThread, onGrant });
    const comeBack = () => {
      if (!document.hidden) access.refreshQuietly();
    };
    const reopen = async () => {
      dialog.close();
      await refresh();
      openTicket(ticketId);
    };
    const run = (path, body) => async () => {
      try {
        await api(`support/${ticketId}/${path}`, { method: 'POST', body });
        await reopen();
      } catch (e) {
        toast(e.message, true);
      }
    };
    const kind = h(
      'select',
      {},
      [
        ['operator', 'Müşteriye yanıt'],
        ['internal', 'İç not (müşteri görmez)'],
        ['customer', 'Müşteri mesajını kaydet'],
      ].map(([v, l]) => h('option', { value: v, text: l })),
    );
    const after = h(
      'select',
      { 'aria-label': 'Yanıttan sonra durum' },
      [
        ['', 'Durum otomatik'],
        ['waiting_customer', 'Müşteri bekleniyor'],
        ['resolved', 'Çözüldü'],
        ['open', 'Açık'],
      ].map(([v, l]) => h('option', { value: v, text: l })),
    );
    const text = h('textarea', { rows: 4, 'aria-label': 'Mesaj', maxlength: '5000' });
    const error = h('p', { class: 'formerror', role: 'alert' });
    const send = h('button', { class: 'btn primary', type: 'button', text: 'Gönder' });
    send.onclick = async () => {
      error.textContent = '';
      if (!text.value.trim()) {
        error.textContent = 'Mesaj boş olamaz.';
        return;
      }
      send.disabled = true;
      try {
        await api(`support/${ticketId}/messages`, {
          method: 'POST',
          body: {
            kind: kind.value,
            body: text.value,
            status: kind.value === 'internal' ? undefined : after.value || undefined,
          },
        });
        await reopen();
      } catch (e) {
        error.textContent = e.message;
        send.disabled = false;
      }
    };
    const closed = k.status === 'closed';
    // After remote work: tell the office to test; the ticket then waits for their answer.
    const askToTest = async () => {
      const sent = await formDialog({
        title: 'Çözüldü, test edin',
        intro: 'Bu mesaj büroya gider ve kayıt “Müşteri bekleniyor” durumuna geçer. Göndermeden önce metni düzenleyebilirsiniz.',
        fields: [
          { name: 'body', label: 'Mesaj', type: 'textarea', rows: 4, maxlength: 5000, required: true, value: RESOLVED_NOTE },
        ],
        submitLabel: 'Gönder',
        submit: (v) =>
          api(`support/${ticketId}/messages`, {
            method: 'POST',
            body: { kind: 'operator', body: v.body, status: 'waiting_customer' },
          }),
      });
      if (sent) {
        toast('Mesaj büroya gönderildi.');
        await reopen();
      }
    };
    const statusButtons = [];
    if (ACTIVE.includes(k.status))
      statusButtons.push(h('button', { class: 'btn', type: 'button', text: 'Çözüldü, test edin', onclick: askToTest }));
    if (k.status !== 'resolved' && !closed)
      statusButtons.push(
        h('button', {
          class: 'btn',
          text: 'Çözüldü olarak işaretle',
          onclick: run('status', { status: 'resolved' }),
        }),
      );
    if (k.status === 'resolved' || closed)
      statusButtons.push(
        h('button', { class: 'btn', text: 'Yeniden aç', onclick: run('status', { status: 'open' }) }),
      );
    if (!closed)
      statusButtons.push(
        h('button', { class: 'btn danger', text: 'Kapat', onclick: run('status', { status: 'closed' }) }),
      );
    statusButtons.push(
      h('button', {
        class: 'btn',
        text: k.assignedTo ? 'Atamayı kaldır' : 'Üstlen',
        onclick: run('assign', { assignTo: k.assignedTo ? null : 'me' }),
      }),
    );
    const priority = h(
      'select',
      {
        class: 'search',
        'aria-label': 'Öncelik',
        onchange: (e) => run('priority', { priority: e.target.value })(),
      },
      Object.entries(LABELS.priority).map(([v, l]) =>
        h('option', { value: v, text: l, selected: v === k.priority }),
      ),
    );
    dialog.append(
      h(
        'div',
        { class: 'dialog-head' },
        h(
          'div',
          {},
          h('h3', { text: `#${k.number} · ${k.subject}` }),
          h('p', { text: `${k.officeName} · ${LABELS.category[k.category]} · ${LABELS.channel[k.channel]}` }),
        ),
        h(
          'div',
          { class: 'toolbar' },
          ticketBadge(k.status),
          priorityBadge(k.priority),
          h('button', { class: 'btn small', text: 'Kapat', onclick: () => dialog.close() }),
        ),
      ),
      h(
        'div',
        { class: 'dialog-body' },
        h(
          'div',
          { class: 'facts' },
          h(
            'div',
            {},
            h('small', { text: 'Bildiren' }),
            h('b', { text: [k.contactName, k.contactInfo].filter(Boolean).join(' · ') || '—' }),
          ),
          h('div', {}, h('small', { text: 'Açılış' }), h('b', { text: dateTimeText(k.createdAt) })),
          h(
            'div',
            {},
            h('small', { text: 'İlk yanıt hedefi' }),
            h('b', { class: k.overdue ? 'neg' : '', text: dateTimeText(k.responseDueAt) }),
          ),
          h(
            'div',
            {},
            h('small', { text: 'İlk yanıt' }),
            h('b', { text: k.firstResponseAt ? dateTimeText(k.firstResponseAt) : 'Henüz yok' }),
          ),
          h(
            'div',
            {},
            h('small', { text: 'Üstlenen' }),
            h('b', { text: k.assignedTo ? k.assignedTo.name : '—' }),
          ),
        ),
        access.node,
        h('div', { class: 'actions' }, statusButtons, h('label', { class: 'check' }, 'Öncelik: ', priority)),
        thread,
        closed
          ? h('p', { class: 'empty', text: 'Kayıt kapalı. Mesaj eklemek için yeniden açın.' })
          : h(
              'div',
              { class: 'reply' },
              h(
                'div',
                { class: 'cols' },
                h('label', { class: 'field' }, h('span', { text: 'Tür' }), kind),
                h('label', { class: 'field' }, h('span', { text: 'Gönderince durum' }), after),
              ),
              h('label', { class: 'field' }, h('span', { text: 'Mesaj' }), text),
              error,
              h('div', { class: 'actions' }, send),
            ),
      ),
    );
    dialog.addEventListener('close', () => {
      // Stop the countdown and the come-back listeners so nothing outlives the detail.
      gone = true;
      access.dispose();
      window.removeEventListener('focus', comeBack);
      document.removeEventListener('visibilitychange', comeBack);
      dialog.remove();
    });
    document.body.append(dialog);
    window.addEventListener('focus', comeBack);
    document.addEventListener('visibilitychange', comeBack);
    access.set(grants || (state.support?.access?.[ticketId] ? [state.support.access[ticketId]] : []));
    dialog.showModal();
  }

  // ---------- products (monthly modules, usage packages, services) ----------
  function moduleDialog(m) {
    return formDialog({
      title: m ? 'Ürünü düzenle' : 'Yeni ürün',
      intro:
        'Fiyatlar KDV hariç girilir. Fiyat değişikliği yalnızca yeni satışları etkiler; mevcut bürolar anlaştıkları fiyatta kalır.',
      wide: true,
      fields: [
        {
          name: 'code',
          label: 'Kod',
          type: 'text',
          required: true,
          value: m?.code,
          disabled: !!m,
          hint: m ? 'Kod değiştirilemez.' : 'Küçük harf, rakam, tire. Sonradan değiştirilemez.',
        },
        { name: 'name', label: 'Ad', type: 'text', required: true, value: m?.name },
        {
          name: 'kind',
          label: 'Tür',
          type: 'select',
          value: kindOf(m),
          options: Object.entries(LABELS.productKind).map(([value, label]) => ({ value, label })),
          hint: m?.sold
            ? 'Satılmış bir ürünün türü değiştirilemez; gerekirse yeni ürün açın.'
            : 'Aylık modül aboneliğe eklenir; kullanım paketi ve hizmet tek seferlik satılır.',
        },
        {
          name: 'status',
          label: 'Durum',
          type: 'select',
          value: m ? statusOf(m) : 'draft',
          options: Object.entries(LABELS.productStatus).map(([value, label]) => ({ value, label })),
          hint: 'Taslak ve Yakında satılamaz (Yakında olan modül denemeye açılabilir). Satıştan kalkan ürün, alan bürolarda kalır.',
        },
        {
          name: 'price',
          label: 'Aylık fiyat (TL, KDV hariç)',
          labelFor: (r) => `${PRICE_LABEL[r.kind] || 'Fiyat'} (TL, KDV hariç)`,
          type: 'tl',
          value: m ? tlText(m.monthlyPriceKurus) : '',
        },
        {
          name: 'packQuantity',
          label: 'Paket miktarı',
          type: 'number',
          required: true,
          min: 1,
          value: m?.packQuantity,
          showIf: (r) => r.kind === 'usage_pack',
          hint: 'Bir pakette kaç birim var? Örn: 1000',
        },
        {
          name: 'packUnit',
          label: 'Paket birimi',
          type: 'text',
          required: true,
          maxlength: 30,
          value: m?.packUnit,
          showIf: (r) => r.kind === 'usage_pack',
          hint: 'Örn: SMS, dakika, sorgu',
        },
        {
          name: 'trialDays',
          label: 'Deneme süresi (gün, 0–60)',
          type: 'number',
          min: 0,
          max: 60,
          value: m?.trialDays ?? 0,
          showIf: (r) => r.kind === 'module',
          hint: '0 = deneme yok. Büro detayındaki “Deneme başlat” bu süreyi önerir.',
        },
        { name: 'description', label: 'Açıklama', type: 'textarea', value: m?.description },
        {
          name: 'features',
          label: 'Özellikler (her satıra bir madde, en fazla 12)',
          type: 'textarea',
          rows: 4,
          value: (m?.features || []).join('\n'),
        },
        {
          name: 'sortOrder',
          label: 'Sıra',
          type: 'number',
          min: 0,
          max: 1000,
          value: m?.sortOrder ?? 100,
          hint: 'Küçük sayı önce gösterilir.',
        },
      ],
      submit: async (v) => {
        const features = (v.features || '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        if (features.length > 12) throw new Error('En fazla 12 özellik girin.');
        const price = v.price ?? 0;
        if (v.status === 'selling' && !price) throw new Error('Satışa açmak için fiyat girin.');
        if (v.kind === 'module' && (v.trialDays ?? 0) > 60)
          throw new Error('Deneme süresi 0–60 gün olmalıdır.');
        await api('modules', {
          method: 'POST',
          body: {
            code: m?.code ?? v.code,
            name: v.name,
            description: v.description ?? '',
            monthlyPriceKurus: price,
            kind: v.kind,
            status: v.status,
            features,
            trialDays: v.kind === 'module' ? (v.trialDays ?? 0) : undefined,
            packQuantity: v.packQuantity,
            packUnit: v.packUnit,
            sortOrder: v.sortOrder ?? 100,
          },
        });
        toast('Ürün kaydedildi.');
      },
    }).then((done) => done && refresh());
  }
  const productStatusBadge = (m) => {
    const status = statusOf(m);
    return badge(
      LABELS.productStatus[status],
      status === 'selling' ? 'ok' : status === 'soon' ? 'warn' : status === 'retired' ? 'bad' : '',
    );
  };
  function renderModules() {
    return h(
      'div',
      {},
      h(
        'div',
        { class: 'heading' },
        h(
          'div',
          {},
          h('p', { class: 'eyebrow', text: 'Katalog' }),
          h('h2', { text: 'Ürünler' }),
          h('p', {
            text: 'Aylık modüller, kullanım paketleri ve hizmetler. Tüm fiyatlar KDV hariçtir.',
          }),
        ),
        h(
          'div',
          { class: 'toolbar' },
          h('button', { class: 'btn primary', text: 'Yeni ürün', onclick: () => moduleDialog(null) }),
        ),
      ),
      h(
        'section',
        { class: 'panel' },
        state.modules.length
          ? h(
              'div',
              { class: 'overflow' },
              h(
                'table',
                {},
                th(
                  [
                    'Ürün',
                    'Tür',
                    'Durum',
                    'Fiyat (KDV hariç)',
                    'Kullanan büro',
                    'Aylık yinelenen',
                    'Satış',
                    'Tahsil edilen',
                    '',
                  ],
                  [3, 4, 5, 6, 7],
                ),
                h(
                  'tbody',
                  {},
                  state.modules.map((m) =>
                    h(
                      'tr',
                      { class: statusOf(m) === 'selling' || statusOf(m) === 'soon' ? '' : 'dim' },
                      h(
                        'td',
                        {},
                        h('strong', { text: m.name }),
                        h('small', { text: m.code + (m.description ? ' · ' + m.description : '') }),
                        m.features?.length ? h('small', { text: m.features.join(' · ') }) : null,
                      ),
                      h('td', { text: LABELS.productKind[kindOf(m)] }),
                      h(
                        'td',
                        {},
                        productStatusBadge(m),
                        kindOf(m) === 'module' && m.trialDays
                          ? h('small', { text: `${m.trialDays} gün deneme` })
                          : null,
                        kindOf(m) !== 'module'
                          ? null
                          : m.gated === false
                            ? h('small', {
                                class: 'neg',
                                text: 'Uygulamada henüz özellik kapısı yok: satış yalnızca kayıt altına alınır.',
                              })
                            : m.gated === true
                              ? h('small', { text: 'Satılmayan büroda özellik kapalıdır.' })
                              : null,
                      ),
                      h('td', { class: 'num' }, priceText(m), h('small', { text: PRICE_LABEL[kindOf(m)] })),
                      h('td', { class: 'num', text: String(m.offices ?? 0) }),
                      h('td', {
                        class: 'num',
                        text: kindOf(m) === 'module' ? formatTl(m.monthlyKurus || 0) : '—',
                      }),
                      h('td', { class: 'num', text: String(m.sold ?? 0) }),
                      num(m.paidKurus || 0),
                      h(
                        'td',
                        {},
                        h('button', { class: 'btn small', text: 'Düzenle', onclick: () => moduleDialog(m) }),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty', text: 'Henüz ürün yok. “Yeni ürün” ile ekleyin.' }),
      ),
    );
  }

  // ---------- campaigns ----------
  const officeChoices = () =>
    state.dash.officeList.filter((o) => o.status !== 'closed').map((o) => ({ value: o.id, label: o.name }));
  const productChoices = (withUsers) => [
    ...(withUsers ? [{ value: 'users', label: 'Kullanıcı lisansı' }] : []),
    ...state.modules
      .filter((m) => statusOf(m) !== 'retired')
      .map((m) => ({ value: m.code, label: `${m.name} (${LABELS.productKind[kindOf(m)]})` })),
  ];
  const productsText = (codes) => (codes?.length ? codes.map(productName).join(', ') : 'Tüm ürünler');
  function campaignBadge(c) {
    if (c.status === 'paused') return badge(LABELS.campaignStatus.paused, 'warn');
    if (c.status === 'ended') return badge(LABELS.campaignStatus.ended);
    if (c.maxUses !== null && c.maxUses !== undefined && c.usedCount >= c.maxUses)
      return badge('Kullanım sınırı doldu', 'bad');
    if (c.live) return badge('Yayında', 'ok');
    if (new Date(c.startsAt).getTime() > Date.now()) return badge('Başlamadı', 'warn');
    return badge('Süresi doldu');
  }
  function campaignDialog(c) {
    const used = c?.usedCount > 0;
    return formDialog({
      title: c ? 'Kampanyayı düzenle' : 'Yeni kampanya',
      intro: used
        ? 'Bu kampanya kullanıldı: indirim türü, değeri, süresi ve ürünleri değiştirilemez. Ad, tarihler, hedef, kupon ve kullanım sınırı değiştirilebilir.'
        : 'İndirim, KDV hariç tutar üzerinden hesaplanır. Ürün seçmezseniz tüm ürünlere uygulanır. Her büro bir kampanyayı bir kez kullanabilir.',
      wide: true,
      fields: [
        { name: 'name', label: 'Kampanya adı', type: 'text', required: true, value: c?.name },
        {
          name: 'discountType',
          label: 'İndirim türü',
          type: 'select',
          value: c?.discountType ?? 'percent',
          options: [
            { value: 'percent', label: 'Yüzde (%)' },
            { value: 'amount', label: 'Tutar (TL)' },
          ],
        },
        {
          name: 'percent',
          label: 'İndirim yüzdesi (1–100)',
          type: 'number',
          required: true,
          min: 1,
          max: 100,
          value: c?.discountType === 'percent' ? c.discountValue : undefined,
          showIf: (r) => r.discountType === 'percent',
        },
        {
          name: 'amount',
          label: 'İndirim tutarı (TL, KDV hariç)',
          type: 'tl',
          required: true,
          value: c?.discountType === 'amount' ? tlText(c.discountValue) : undefined,
          showIf: (r) => r.discountType === 'amount',
          hint: 'Aylık ürünlerde ay başına, tek seferlik ürünlerde adet başına düşülür.',
        },
        {
          name: 'applies',
          label: 'İndirim süresi',
          type: 'select',
          value: c?.applies ?? 'first_month',
          options: Object.entries(LABELS.applies).map(([value, label]) => ({ value, label })),
          hint: 'Aylık ürünlerde kaç ay indirim yapılacağı. Tek seferlik ürünlerde dikkate alınmaz.',
        },
        {
          name: 'productCodes',
          label: 'Ürünler (hiçbirini seçmezseniz tüm ürünler)',
          type: 'checks',
          options: productChoices(true),
          value: c?.productCodes,
        },
        {
          name: 'audience',
          label: 'Kimler kullanabilir?',
          type: 'select',
          value: c?.audience ?? 'all',
          options: Object.entries(LABELS.campaignAudience).map(([value, label]) => ({ value, label })),
          hint: '“Ürünü almamış” ve “Denemedeki” hedefler kampanyanın ürünlerine göre denetlenir.',
        },
        {
          name: 'tenantIds',
          label: 'Bürolar',
          type: 'checks',
          options: officeChoices(),
          value: c?.tenantIds,
          showIf: (r) => r.audience === 'selected',
          empty: 'Açık büro yok.',
        },
        { name: 'startsAt', label: 'Başlangıç', type: 'date', required: true, value: isoDay(c?.startsAt) },
        {
          name: 'endsAt',
          label: 'Bitiş (bu gün dahil)',
          type: 'date',
          required: true,
          value: c ? isoDay(c.endsAt) : addDays(30),
        },
        {
          name: 'couponCode',
          label: 'Kupon kodu (isteğe bağlı)',
          type: 'text',
          maxlength: 30,
          value: c?.couponCode,
          hint: '3–30 karakter; harf, rakam ve tire. Büro bu kodu iletince satış formuna yazarsınız.',
        },
        {
          name: 'maxUses',
          label: 'Toplam kullanım sınırı (isteğe bağlı)',
          type: 'number',
          min: 1,
          value: c?.maxUses,
          hint: c ? `Şimdiye kadar ${c.usedCount} kez kullanıldı.` : 'Boş = sınırsız.',
        },
      ],
      rawPreview: true,
      preview: (r) => {
        const value =
          r.discountType === 'percent'
            ? r.percent
              ? `%${r.percent} indirim`
              : '—'
            : parseTl(r.amount) > 0
              ? `${formatTl(parseTl(r.amount))} indirim (KDV hariç)`
              : '—';
        return [
          h(
            'div',
            {},
            'Özet: ',
            h('b', { text: value }),
            ` · ${LABELS.applies[r.applies]} · ${productsText(r.productCodes)} · ${LABELS.campaignAudience[r.audience]}`,
          ),
          h(
            'div',
            {},
            `${dayText(r.startsAt)} – ${dayText(r.endsAt)}${r.couponCode ? ' · kupon ' + r.couponCode.toUpperCase() : ''}`,
          ),
        ];
      },
      submit: async (v) => {
        const value = v.discountType === 'percent' ? v.percent : v.amount;
        if (v.discountType === 'percent' && (value < 1 || value > 100))
          throw new Error('İndirim yüzdesi 1–100 olmalıdır.');
        if (v.discountType === 'amount' && !(value > 0)) throw new Error('İndirim tutarı girin.');
        if (v.audience === 'selected' && !v.tenantIds.length) throw new Error('En az bir büro seçin.');
        if (v.maxUses !== undefined && v.maxUses < 1) throw new Error('Kullanım sınırı en az 1 olmalıdır.');
        const startsAt = dayBound(v.startsAt, 'Başlangıç');
        const endsAt = dayBound(v.endsAt, 'Bitiş', true);
        if (endsAt <= startsAt) throw new Error('Bitiş başlangıçtan sonra olmalıdır.');
        await api('campaigns', {
          method: 'POST',
          body: {
            id: c?.id,
            name: v.name,
            discountType: v.discountType,
            discountValue: value,
            applies: v.applies,
            productCodes: v.productCodes,
            audience: v.audience,
            tenantIds: v.audience === 'selected' ? v.tenantIds : [],
            startsAt,
            endsAt,
            couponCode: v.couponCode ? v.couponCode.toUpperCase() : undefined,
            maxUses: v.maxUses ?? null,
          },
        });
        toast(c ? 'Kampanya güncellendi.' : 'Kampanya oluşturuldu.');
      },
    }).then(async (done) => {
      if (!done) return;
      state.campaigns = null;
      renderApp();
      await loadTabData();
    });
  }
  const STATUS_ACTIONS = {
    paused: ['Durdur', 'Durduruldu'],
    active: ['Devam', 'Devam ediyor'],
    ended: ['Bitir', 'Bitti'],
  };
  async function setCampaignStatus(c, status) {
    if (status === 'ended') {
      const ok = await formDialog({
        title: 'Kampanyayı bitir',
        intro: `“${c.name}” kalıcı olarak kapanır; satışlarda seçilemez ve kuponu çalışmaz. Geçmiş satışlar değişmez.`,
        fields: [],
        submitLabel: 'Bitir',
        danger: true,
        submit: () => api(`campaigns/${c.id}/status`, { method: 'POST', body: { status } }),
      });
      if (!ok) return;
    } else {
      try {
        await api(`campaigns/${c.id}/status`, { method: 'POST', body: { status } });
      } catch (e) {
        return toast(e.message, true);
      }
    }
    toast(`Kampanya: ${STATUS_ACTIONS[status][1]}.`);
    state.campaigns = null;
    renderApp();
    await loadTabData();
  }
  function renderCampaigns() {
    const list = state.campaigns;
    const head = h(
      'div',
      { class: 'heading' },
      h(
        'div',
        {},
        h('p', { class: 'eyebrow', text: 'Pazarlama' }),
        h('h2', { text: 'Kampanyalar' }),
        h('p', {
          text: 'İndirim kampanyaları ve kupon kodları. Satış formlarında seçilir; indirim KDV hariç tutardan düşülür ve her büro bir kampanyayı bir kez kullanır.',
        }),
      ),
      h(
        'div',
        { class: 'toolbar' },
        h('button', { class: 'btn primary', text: 'Yeni kampanya', onclick: () => campaignDialog(null) }),
      ),
    );
    if (!list) return h('div', {}, head, loading());
    const live = list.filter((c) => c.live);
    return h(
      'div',
      {},
      head,
      h(
        'div',
        { class: 'kpis' },
        kpi('Yayındaki kampanya', String(live.length), `${list.length} kampanya toplam`),
        kpi(
          'Kampanyalı satış geliri',
          formatTl(list.reduce((s, c) => s + c.revenueKurus, 0)),
          'KDV hariç, iptal edilmemiş satışlar',
        ),
        kpi('Verilen indirim', formatTl(list.reduce((s, c) => s + c.discountKurus, 0)), 'KDV hariç'),
      ),
      h(
        'section',
        { class: 'panel' },
        list.length
          ? h(
              'div',
              { class: 'overflow' },
              h(
                'table',
                {},
                th(
                  [
                    'Kampanya',
                    'İndirim',
                    'Ürünler',
                    'Hedef',
                    'Tarih',
                    'Kupon',
                    'Kullanım',
                    'Getirdiği gelir',
                    'Verilen indirim',
                    'Durum',
                    '',
                  ],
                  [6, 7, 8],
                ),
                h(
                  'tbody',
                  {},
                  list.map((c) =>
                    h(
                      'tr',
                      { class: c.live ? '' : 'dim' },
                      h('td', {}, h('strong', { text: c.name })),
                      h(
                        'td',
                        {},
                        discountText(c),
                        h('small', {
                          text: `${LABELS.applies[c.applies]}${c.discountType === 'amount' ? ' · KDV hariç' : ''}`,
                        }),
                      ),
                      h('td', { text: productsText(c.productCodes) }),
                      h('td', {
                        text:
                          c.audience === 'selected'
                            ? `${LABELS.campaignAudience.selected} (${c.tenantIds.length})`
                            : LABELS.campaignAudience[c.audience],
                      }),
                      h('td', {}, dateText(c.startsAt), h('small', { text: '→ ' + dateText(c.endsAt) })),
                      h('td', { text: c.couponCode || '—' }),
                      h('td', {
                        class: 'num',
                        text: `${c.usedCount} / ${c.maxUses === null || c.maxUses === undefined ? '∞' : c.maxUses}`,
                      }),
                      num(c.revenueKurus),
                      num(c.discountKurus),
                      h('td', {}, campaignBadge(c)),
                      h(
                        'td',
                        { class: 'rowactions' },
                        c.status !== 'ended'
                          ? h('button', {
                              class: 'btn small',
                              text: 'Düzenle',
                              onclick: () => campaignDialog(c),
                            })
                          : null,
                        c.status === 'active'
                          ? h('button', {
                              class: 'btn small',
                              text: 'Durdur',
                              onclick: () => setCampaignStatus(c, 'paused'),
                            })
                          : null,
                        c.status === 'paused'
                          ? h('button', {
                              class: 'btn small',
                              text: 'Devam',
                              onclick: () => setCampaignStatus(c, 'active'),
                            })
                          : null,
                        c.status !== 'ended'
                          ? h('button', {
                              class: 'btn small danger',
                              text: 'Bitir',
                              onclick: () => setCampaignStatus(c, 'ended'),
                            })
                          : null,
                      ),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty', text: 'Henüz kampanya yok.' }),
      ),
    );
  }

  // ---------- announcements ----------
  // The card the office sees on its home page, drawn from the typed (raw) form values. The
  // buttons are inert pictures of the office's buttons.
  function announcementCard(r) {
    const product = state.modules.find((m) => m.code === r.productCode);
    const campaign =
      r.kind === 'campaign' ? (state.campaigns || []).find((c) => c.id === r.campaignId) : null;
    const sales = r.kind !== 'maintenance';
    return h(
      'div',
      { class: 'anncard ' + (r.kind || '') },
      h(
        'div',
        { class: 'annhead' },
        badge(LABELS.annKind[r.kind] || '', r.kind === 'maintenance' ? 'warn' : 'ok'),
        r.dismissible ? h('span', { class: 'annx', 'aria-hidden': 'true', text: '×' }) : null,
      ),
      h('strong', { class: 'anntitle', text: r.title || 'Başlık' }),
      h('p', { class: 'annbody', text: r.body || 'Duyuru metni burada görünür.' }),
      product
        ? h('p', { class: 'annmeta', text: `${product.name} — ${priceText(product)} (KDV hariç)` })
        : null,
      campaign
        ? h('p', {
            class: 'annmeta',
            text: `Kampanya: ${campaign.name} — ${discountText(campaign)}, ${LABELS.applies[campaign.applies].toLocaleLowerCase('tr')}${campaign.couponCode ? ', kupon ' + campaign.couponCode : ''} · son gün ${dateText(campaign.endsAt)}`,
          })
        : null,
      h(
        'div',
        { class: 'annactions', 'aria-hidden': 'true' },
        sales ? h('span', { class: 'fakebtn primary', text: 'İncele' }) : null,
        sales ? h('span', { class: 'fakebtn', text: 'İlgileniyorum' }) : null,
        r.dismissible ? h('span', { class: 'fakebtn', text: 'Kapat' }) : null,
      ),
    );
  }
  function announcementDialog(a) {
    const campaigns = (state.campaigns || []).filter((c) => c.status !== 'ended' || c.id === a?.campaignId);
    return formDialog({
      title: a ? 'Duyuruyu düzenle' : 'Yeni duyuru',
      intro:
        'Duyuru, büroların ana sayfasında kart olarak görünür. Satış duyuruları (yeni ürün, kampanya, fiyat değişikliği) yalnızca CEO ve yöneticilere gider; tüm kullanıcılara gösterim yalnızca planlı bakımda seçilebilir.',
      wide: true,
      fields: [
        {
          name: 'kind',
          label: 'Tür',
          type: 'select',
          value: a?.kind ?? 'new_product',
          options: Object.entries(LABELS.annKind).map(([value, label]) => ({ value, label })),
        },
        {
          name: 'title',
          label: 'Başlık (en fazla 80 karakter)',
          type: 'text',
          required: true,
          maxlength: 80,
          value: a?.title,
        },
        {
          name: 'body',
          label: 'Metin (en fazla 400 karakter)',
          type: 'textarea',
          required: true,
          maxlength: 400,
          value: a?.body,
        },
        {
          name: 'productCode',
          label: 'Ürün',
          type: 'select',
          value: a?.productCode ?? '',
          options: [{ value: '', label: '— Ürün yok —' }, ...productChoices(false)],
          hint: '“Ürünü almamış” ve “Denemedeki” hedefler için gereklidir.',
        },
        {
          name: 'campaignId',
          label: 'Kampanya',
          type: 'select',
          value: a?.campaignId ?? '',
          options: [
            {
              value: '',
              label: campaigns.length
                ? '— Kampanya seçin —'
                : '— Kampanya yok; önce Kampanyalar sekmesinden açın —',
            },
            ...campaigns.map((c) => ({ value: c.id, label: `${c.name} · ${discountText(c)}` })),
          ],
          showIf: (r) => r.kind === 'campaign',
        },
        {
          name: 'audience',
          label: 'Kimlere gösterilsin?',
          type: 'select',
          value: a?.audience ?? 'all',
          options: Object.entries(LABELS.annAudience).map(([value, label]) => ({ value, label })),
        },
        {
          name: 'tenantIds',
          label: 'Bürolar',
          type: 'checks',
          options: officeChoices(),
          value: a?.tenantIds,
          showIf: (r) => r.audience === 'selected',
          empty: 'Açık büro yok.',
        },
        {
          name: 'roles',
          label: 'Büroda kimler görsün?',
          type: 'select',
          value: a?.roles ?? 'managers',
          options: Object.entries(LABELS.roles).map(([value, label]) => ({ value, label })),
          showIf: (r) => r.kind === 'maintenance',
          hint: 'Satış duyuruları yalnızca CEO ve yöneticilere gider.',
        },
        {
          name: 'startsAt',
          label: 'Yayın başlangıcı',
          type: 'date',
          required: true,
          value: isoDay(a?.startsAt),
        },
        {
          name: 'endsAt',
          label: 'Yayın bitişi (bu gün dahil)',
          type: 'date',
          required: true,
          value: a ? isoDay(a.endsAt) : addDays(14),
        },
        {
          name: 'priority',
          label: 'Öncelik (0–100)',
          type: 'number',
          min: 0,
          max: 100,
          value: a?.priority ?? 50,
          hint: 'Büyük sayı önce gösterilir.',
        },
        {
          name: 'dismissible',
          label: 'Büro duyuruyu kapatabilsin',
          type: 'checkbox',
          value: a ? a.dismissible : true,
        },
      ],
      rawPreview: true,
      preview: (r) => [
        h('small', { class: 'previewlabel', text: 'Büronun ana sayfasında böyle görünür:' }),
        announcementCard(r),
        h('small', {
          class: 'previewlabel',
          text: `Görecekler: ${LABELS.roles[r.kind === 'maintenance' ? r.roles : 'managers']} · ${LABELS.annAudience[r.audience]}`,
        }),
      ],
      submit: async (v) => {
        if (v.kind === 'campaign' && !v.campaignId) throw new Error('Kampanya duyurusu için kampanya seçin.');
        if (['without_product', 'trialing'].includes(v.audience) && !v.productCode)
          throw new Error('Bu hedef kitle için ürün seçin.');
        if (v.audience === 'selected' && !v.tenantIds.length) throw new Error('En az bir büro seçin.');
        if (v.priority !== undefined && (v.priority < 0 || v.priority > 100))
          throw new Error('Öncelik 0–100 olmalıdır.');
        const startsAt = dayBound(v.startsAt, 'Yayın başlangıcı');
        const endsAt = dayBound(v.endsAt, 'Yayın bitişi', true);
        if (endsAt <= startsAt) throw new Error('Bitiş başlangıçtan sonra olmalıdır.');
        await api('announcements', {
          method: 'POST',
          body: {
            id: a?.id,
            kind: v.kind,
            title: v.title,
            body: v.body,
            productCode: v.productCode || undefined,
            campaignId: v.kind === 'campaign' ? v.campaignId : undefined,
            audience: v.audience,
            tenantIds: v.audience === 'selected' ? v.tenantIds : [],
            roles: v.kind === 'maintenance' ? v.roles : 'managers',
            startsAt,
            endsAt,
            dismissible: v.dismissible,
            priority: v.priority ?? 50,
          },
        });
        toast(
          a ? 'Duyuru güncellendi.' : 'Duyuru taslak olarak kaydedildi. Yayınlamak için “Yayınla”ya basın.',
        );
      },
    }).then(async (done) => {
      if (!done) return;
      state.announcements = null;
      renderApp();
      await loadTabData();
    });
  }
  async function setAnnouncementStatus(a, status) {
    try {
      await api(`announcements/${a.id}/status`, { method: 'POST', body: { status } });
      toast(
        status === 'published'
          ? 'Duyuru yayında.'
          : status === 'archived'
            ? 'Duyuru arşivlendi.'
            : 'Duyuru taslağa alındı.',
      );
    } catch (e) {
      return toast(e.message, true);
    }
    state.announcements = null;
    renderApp();
    await loadTabData();
  }
  function announcementBadge(a) {
    if (a.status === 'published')
      return a.live ? badge('Yayında', 'ok') : badge('Yayında · süre dışında', 'warn');
    return badge(LABELS.annStatus[a.status], a.status === 'archived' ? '' : 'warn');
  }
  function renderAnnouncements() {
    const list = state.announcements;
    const head = h(
      'div',
      { class: 'heading' },
      h(
        'div',
        {},
        h('p', { class: 'eyebrow', text: 'Pazarlama' }),
        h('h2', { text: 'Duyurular' }),
        h('p', {
          text: 'Büroların ana sayfasında görünen kartlar: yeni ürün, kampanya, fiyat değişikliği ve planlı bakım. Yeni duyuru taslak olarak kaydedilir.',
        }),
      ),
      h(
        'div',
        { class: 'toolbar' },
        h('button', { class: 'btn primary', text: 'Yeni duyuru', onclick: () => announcementDialog(null) }),
      ),
    );
    if (!list) return h('div', {}, head, loading());
    return h(
      'div',
      {},
      head,
      h(
        'section',
        { class: 'panel' },
        list.length
          ? h(
              'div',
              { class: 'overflow' },
              h(
                'table',
                {},
                th(
                  [
                    'Duyuru',
                    'Tür',
                    'Ürün / kampanya',
                    'Hedef',
                    'Yayın aralığı',
                    'Öncelik',
                    'Durum',
                    'Gören büro',
                    'Gösterim',
                    'Tıklama',
                    'Kapatma',
                    'İlgileniyorum',
                    '',
                  ],
                  [5, 7, 8, 9, 10, 11],
                ),
                h(
                  'tbody',
                  {},
                  list.map((a) =>
                    h(
                      'tr',
                      { class: a.status === 'archived' ? 'dim' : '' },
                      h(
                        'td',
                        {},
                        h('strong', { text: a.title }),
                        h('small', { text: a.body.length > 90 ? a.body.slice(0, 90) + '…' : a.body }),
                      ),
                      h('td', { text: LABELS.annKind[a.kind] }),
                      h(
                        'td',
                        {},
                        a.productName || (a.productCode ? a.productCode : '—'),
                        a.campaignName ? h('small', { text: 'Kampanya: ' + a.campaignName }) : null,
                      ),
                      h(
                        'td',
                        {},
                        a.audience === 'selected'
                          ? `${LABELS.annAudience.selected} (${a.tenantIds.length})`
                          : LABELS.annAudience[a.audience],
                        h('small', { text: LABELS.roles[a.roles] }),
                      ),
                      h('td', {}, dateText(a.startsAt), h('small', { text: '→ ' + dateText(a.endsAt) })),
                      h('td', { class: 'num', text: String(a.priority) }),
                      h('td', {}, announcementBadge(a)),
                      h('td', { class: 'num', text: String(a.stats.offices) }),
                      h('td', { class: 'num', text: String(a.stats.shown) }),
                      h('td', { class: 'num', text: String(a.stats.clicked) }),
                      h('td', { class: 'num', text: String(a.stats.dismissed) }),
                      h('td', { class: 'num', text: String(a.stats.interested) }),
                      h(
                        'td',
                        { class: 'rowactions' },
                        h('button', {
                          class: 'btn small',
                          text: 'Düzenle',
                          onclick: () => announcementDialog(a),
                        }),
                        a.status === 'published'
                          ? h('button', {
                              class: 'btn small',
                              text: 'Arşivle',
                              onclick: () => setAnnouncementStatus(a, 'archived'),
                            })
                          : h('button', {
                              class: 'btn small primary',
                              text: 'Yayınla',
                              onclick: () => setAnnouncementStatus(a, 'published'),
                            }),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'empty', text: 'Henüz duyuru yok.' }),
      ),
    );
  }

  // ---------- sales pipeline ----------
  // Office requests ("Talep et", "İlgileniyorum") are created by an office user, not an operator.
  const isRequest = (p) => !p.createdBy;
  const endOfToday = () => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59).getTime();
  };
  const isDue = (p) =>
    OPEN_STAGES.includes(p.stage) && p.nextActionAt && new Date(p.nextActionAt).getTime() <= endOfToday();
  const stageBadge = (stage) =>
    badge(
      LABELS.stage[stage],
      stage === 'won' ? 'ok' : stage === 'lost' ? 'bad' : stage === 'new' ? 'warn' : '',
    );
  // Stage notes are written by the server as "Aşama: <code> — reason"; show the Turkish name.
  const noteText = (body) =>
    String(body).replace(/^Aşama: ([a-z]+)/, (all, code) =>
      LABELS.stage[code] ? 'Aşama: ' + LABELS.stage[code] : all,
    );
  async function reloadPipeline() {
    state.prospects = null;
    renderApp();
    await loadTabData();
  }
  function prospectDialog(p) {
    const offices = state.dash.officeList.filter((o) => o.status !== 'closed');
    return formDialog({
      title: p ? 'Fırsatı düzenle' : 'Yeni fırsat',
      intro: p
        ? 'Aşamayı fırsat penceresindeki düğmelerle değiştirin. Kazanıldı, satış yapılınca kendiliğinden işaretlenir.'
        : 'Yeni büro adayı veya mevcut bir büroya ek satış fırsatı. Beklenen tutarlar KDV hariçtir.',
      wide: true,
      fields: [
        p
          ? null
          : {
              name: 'tenantId',
              label: 'Fırsat türü',
              type: 'select',
              options: [
                { value: '', label: 'Yeni büro adayı' },
                ...offices.map((o) => ({ value: o.id, label: 'Ek satış: ' + o.name })),
              ],
            },
        {
          name: 'officeName',
          label: 'Büro adı',
          type: 'text',
          value: p?.officeName,
          hint: p ? undefined : 'Ek satışta boş bırakırsanız büronun adı kullanılır.',
        },
        { name: 'contactName', label: 'Yetkili kişi', type: 'text', value: p?.contactName },
        { name: 'phone', label: 'Telefon', type: 'text', value: p?.phone },
        { name: 'email', label: 'E-posta', type: 'text', value: p?.email },
        { name: 'city', label: 'Şehir', type: 'text', value: p?.city },
        {
          name: 'source',
          label: 'Kaynak',
          type: 'select',
          value: p?.source ?? 'advertising',
          options: Object.entries(LABELS.source).map(([value, label]) => ({ value, label })),
        },
        {
          name: 'expectedUsers',
          label: 'Beklenen kullanıcı sayısı',
          type: 'number',
          min: 1,
          max: 10000,
          value: p?.expectedUsers,
        },
        {
          name: 'productCodes',
          label: 'İlgilendiği ürünler',
          type: 'checks',
          options: productChoices(false),
          value: p?.productCodes,
        },
        {
          name: 'expectedMonthly',
          label: 'Beklenen aylık tutar (TL, KDV hariç)',
          type: 'tl',
          value: p?.expectedMonthlyKurus ? tlText(p.expectedMonthlyKurus) : undefined,
        },
        {
          name: 'nextActionAt',
          label: 'Sonraki adım tarihi',
          type: 'date',
          value: p?.nextActionAt ? isoDay(p.nextActionAt) : undefined,
          hint: 'Bu tarihte “Bugün aranacaklar” listesine düşer.',
        },
        state.operators
          ? {
              name: 'ownerAdminId',
              label: 'Sorumlu',
              type: 'select',
              value: p ? (p.ownerAdminId ?? '') : state.admin?.id,
              options: [
                { value: '', label: '— Atanmamış —' },
                ...state.operators.filter((x) => x.active).map((x) => ({ value: x.id, label: x.name })),
              ],
            }
          : null,
        { name: 'note', label: 'Not', type: 'textarea', value: p?.note },
      ],
      submit: async (v) => {
        const tenant = offices.find((o) => o.id === v.tenantId);
        const officeName = v.officeName || tenant?.name;
        if (!officeName) throw new Error('Büro adı gerekli.');
        const result = await api(p ? `prospects/${p.id}` : 'prospects', {
          method: 'POST',
          body: {
            tenantId: p ? undefined : v.tenantId || undefined,
            officeName,
            contactName: v.contactName ?? null,
            phone: v.phone ?? null,
            email: v.email ?? null,
            city: v.city ?? null,
            source: v.source,
            expectedUsers: v.expectedUsers ?? null,
            productCodes: v.productCodes,
            expectedMonthlyKurus: v.expectedMonthly ?? 0,
            nextActionAt: v.nextActionAt ? dayBound(v.nextActionAt, 'Sonraki adım tarihi') : null,
            ownerAdminId: state.operators ? v.ownerAdminId || null : (p?.ownerAdminId ?? undefined),
            note: v.note ?? null,
          },
        });
        toast(p ? 'Fırsat güncellendi.' : 'Fırsat eklendi.');
        return result;
      },
    });
  }
  async function openProspect(id) {
    let detail;
    try {
      detail = await api('prospects/' + id);
    } catch (e) {
      return toast(e.message, true);
    }
    const p = detail.prospect;
    const open = OPEN_STAGES.includes(p.stage);
    const dialog = h('dialog', { class: 'wide' });
    const reopen = async () => {
      dialog.close();
      await reloadPipeline();
      openProspect(id);
    };
    const move = (stage) => async () => {
      if (stage === 'lost') {
        const ok = await formDialog({
          title: 'Kaybedildi olarak işaretle',
          intro: `${p.officeName}: neden kaybedildiğini yazın; raporlarda ve fırsat geçmişinde görünür.`,
          fields: [
            { name: 'reason', label: 'Kaybetme nedeni', type: 'textarea', required: true, maxlength: 300 },
          ],
          submitLabel: 'Kaybedildi',
          danger: true,
          submit: (v) =>
            api(`prospects/${id}/stage`, { method: 'POST', body: { stage, lostReason: v.reason } }),
        });
        if (ok) await reopen();
        return;
      }
      try {
        await api(`prospects/${id}/stage`, { method: 'POST', body: { stage } });
        await reopen();
      } catch (e) {
        toast(e.message, true);
      }
    };
    // Sales on an existing office (upsell) close the prospect through prospectId.
    const sellToOffice = (dialogFor) => async () => {
      let office;
      try {
        [office] = await Promise.all([api('offices/' + p.tenantId), campaignsQuiet()]);
      } catch (e) {
        return toast(e.message, true);
      }
      dialog.close();
      if (await dialogFor(office, { prospectId: p.id, preselect: p.productCodes })) await refresh();
    };
    const actions = [];
    if (open) {
      for (const stage of OPEN_STAGES)
        if (stage !== p.stage)
          actions.push(h('button', { class: 'btn', text: '→ ' + LABELS.stage[stage], onclick: move(stage) }));
      actions.push(h('button', { class: 'btn danger', text: 'Kaybedildi', onclick: move('lost') }));
      if (p.kind === 'new_office')
        actions.push(
          h('button', {
            class: 'btn primary',
            text: 'Büro aç',
            onclick: () => {
              dialog.close();
              openOfficeDialog(p);
            },
          }),
        );
      else if (p.tenantId)
        actions.push(
          h('button', { class: 'btn primary', text: 'Modül ekle', onclick: sellToOffice(addModuleDialog) }),
          h('button', { class: 'btn primary', text: 'Ürün sat', onclick: sellToOffice(sellProductDialog) }),
        );
    } else if (p.stage === 'lost')
      actions.push(h('button', { class: 'btn', text: 'Yeniden aç', onclick: move('new') }));
    actions.push(
      h('button', {
        class: 'btn',
        text: 'Düzenle',
        onclick: async () => {
          if (await prospectDialog(p)) await reopen();
        },
      }),
    );
    if (p.wonTenantId)
      actions.push(
        h('button', {
          class: 'btn',
          text: 'Büroyu aç',
          onclick: () => {
            dialog.close();
            openDetail(p.wonTenantId);
          },
        }),
      );
    const fact = (label, value) => h('div', {}, h('small', { text: label }), h('b', { text: value || '—' }));
    const note = h('textarea', { rows: 3, maxlength: '2000', 'aria-label': 'Not' });
    const noteError = h('p', { class: 'formerror', role: 'alert' });
    const addNote = h('button', { class: 'btn primary', type: 'button', text: 'Not ekle' });
    addNote.onclick = async () => {
      noteError.textContent = '';
      if (!note.value.trim()) {
        noteError.textContent = 'Not boş olamaz.';
        return;
      }
      addNote.disabled = true;
      try {
        await api(`prospects/${id}/notes`, { method: 'POST', body: { body: note.value } });
        await reopen();
      } catch (e) {
        noteError.textContent = e.message;
        addNote.disabled = false;
      }
    };
    dialog.append(
      h(
        'div',
        { class: 'dialog-head' },
        h(
          'div',
          {},
          h('h3', { text: p.officeName }),
          h('p', {
            text:
              (p.kind === 'upsell' ? `Ek satış · ${p.tenantName || ''}` : 'Yeni büro adayı') +
              ` · oluşturulma ${dateText(p.createdAt)}`,
          }),
        ),
        h(
          'div',
          { class: 'toolbar' },
          stageBadge(p.stage),
          isRequest(p) ? badge('Büro talebi', 'warn') : badge(LABELS.source[p.source]),
          h('button', { class: 'btn small', text: 'Kapat', onclick: () => dialog.close() }),
        ),
      ),
      h(
        'div',
        { class: 'dialog-body' },
        isRequest(p)
          ? h('p', {
              class: 'requestnote',
              text: `Bu kayıt büronun kendi talebi: ${p.createdLabel || 'büro kullanıcısı'} uygulamadan iletti.`,
            })
          : null,
        h(
          'div',
          { class: 'facts' },
          fact('Yetkili', p.contactName),
          fact('Telefon', p.phone),
          fact('E-posta', p.email),
          fact('Şehir', p.city),
          fact('Beklenen kullanıcı', p.expectedUsers ? String(p.expectedUsers) : null),
          fact(
            'Beklenen aylık (KDV hariç)',
            p.expectedMonthlyKurus ? formatTl(p.expectedMonthlyKurus) : null,
          ),
          fact('Ürünler', p.productCodes?.length ? p.productCodes.map(productName).join(', ') : null),
          fact('Sorumlu', p.ownerName),
          fact('Sonraki adım', p.nextActionAt ? dateText(p.nextActionAt) : null),
          fact('Kaynak', isRequest(p) ? `Büro talebi · ${p.createdLabel || ''}` : LABELS.source[p.source]),
          p.stage === 'lost' ? fact('Kaybetme nedeni', p.lostReason) : null,
          p.closedAt ? fact('Kapanış', dateText(p.closedAt)) : null,
        ),
        p.note ? h('p', { class: 'msgbody', text: p.note }) : null,
        h('div', { class: 'actions' }, actions),
        h('p', { class: 'section-title', text: 'Notlar' }),
        detail.notes.length
          ? h(
              'div',
              { class: 'thread' },
              detail.notes.map((n) =>
                h(
                  'div',
                  { class: 'msg' + (n.by === 'Büro talebi' ? ' internal' : '') },
                  h('div', { class: 'msghead' }, h('small', { text: `${n.by} · ${dateTimeText(n.at)}` })),
                  h('p', { class: 'msgbody', text: noteText(n.body) }),
                ),
              ),
            )
          : h('p', { class: 'empty', text: 'Henüz not yok.' }),
        h(
          'div',
          { class: 'reply' },
          h('label', { class: 'field' }, h('span', { text: 'Yeni not' }), note),
          noteError,
          h('div', { class: 'actions' }, addNote),
        ),
      ),
    );
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }
  function prospectCard(p) {
    const due = isDue(p);
    return h(
      'button',
      { class: 'pcard' + (due ? ' due' : ''), type: 'button', onclick: () => openProspect(p.id) },
      h('strong', { text: p.officeName }),
      h('span', { class: 'pmeta', text: [p.contactName, p.city].filter(Boolean).join(' · ') || '—' }),
      h(
        'span',
        { class: 'ptags' },
        isRequest(p) ? badge('Büro talebi', 'warn') : badge(LABELS.source[p.source]),
        p.kind === 'upsell' ? badge('Ek satış') : null,
      ),
      p.expectedMonthlyKurus
        ? h('span', { class: 'pmoney', text: formatTl(p.expectedMonthlyKurus) + ' / ay' })
        : null,
      p.nextActionAt && OPEN_STAGES.includes(p.stage)
        ? h('span', { class: due ? 'pmeta neg' : 'pmeta', text: 'Sonraki adım: ' + dateText(p.nextActionAt) })
        : null,
      p.stage === 'lost' && p.lostReason
        ? h('span', { class: 'pmeta', text: 'Neden: ' + p.lostReason })
        : null,
    );
  }
  function renderPipeline() {
    const r = state.prospects;
    const f = state.pipe;
    const setFilter = (key) => (e) => {
      f[key] = e.target.value.trim();
      reloadPipeline();
    };
    const head = h(
      'div',
      { class: 'heading' },
      h(
        'div',
        {},
        h('p', { class: 'eyebrow', text: 'Satış' }),
        h('h2', { text: 'Satış hunisi' }),
        h('p', {
          text: 'Yeni büro adayları, mevcut bürolara ek satış fırsatları ve büroların kendi talepleri. Kazanıldı, büro açılınca veya satış yapılınca kendiliğinden işaretlenir.',
        }),
      ),
      h(
        'div',
        { class: 'toolbar' },
        h('input', {
          class: 'search',
          type: 'search',
          placeholder: 'Büro veya yetkili (Enter)',
          value: f.q,
          'aria-label': 'Fırsat ara',
          onchange: setFilter('q'),
        }),
        h(
          'select',
          { class: 'search', 'aria-label': 'Aşama', onchange: setFilter('stage') },
          [['', 'Tüm aşamalar'], ...Object.entries(LABELS.stage)].map(([v, l]) =>
            h('option', { value: v, text: l, selected: f.stage === v }),
          ),
        ),
        h(
          'select',
          { class: 'search', 'aria-label': 'Kaynak', onchange: setFilter('source') },
          [['', 'Tüm kaynaklar'], ...Object.entries(LABELS.source)].map(([v, l]) =>
            h('option', { value: v, text: l, selected: f.source === v }),
          ),
        ),
        h('button', {
          class: 'btn primary',
          text: 'Yeni fırsat',
          onclick: async () => {
            if (await prospectDialog(null)) await reloadPipeline();
          },
        }),
      ),
    );
    if (!r) return h('div', {}, head, loading());
    const openCount = OPEN_STAGES.reduce((s, k) => s + r.byStage[k].count, 0);
    const openMonthly = OPEN_STAGES.reduce((s, k) => s + r.byStage[k].monthlyKurus, 0);
    const requests = r.prospects.filter((p) => isRequest(p) && OPEN_STAGES.includes(p.stage)).length;
    const stages = f.stage ? [f.stage] : Object.keys(LABELS.stage);
    return h(
      'div',
      {},
      head,
      h(
        'div',
        { class: 'kpis' },
        kpi('Bugün aranacaklar', String(r.dueToday), 'sonraki adımı bugün veya geçmiş', {
          alert: r.dueToday > 0,
        }),
        kpi(
          'Dönüşüm oranı',
          r.conversionPercent === null ? '—' : '%' + r.conversionPercent,
          'son 12 ay · kazanılan / kapanan',
        ),
        kpi('Açık fırsat', String(openCount), `beklenen ${formatTl(openMonthly)} / ay (KDV hariç)`),
        kpi('Büro talepleri', String(requests), 'bu listede açık talep', { alert: requests > 0 }),
      ),
      h(
        'div',
        { class: 'board' + (stages.length === 1 ? ' single' : '') },
        stages.map((stage) => {
          const cards = r.prospects.filter((p) => p.stage === stage);
          return h(
            'section',
            { class: 'stagecol ' + stage, 'aria-label': LABELS.stage[stage] },
            h(
              'header',
              {},
              h(
                'h3',
                {},
                LABELS.stage[stage],
                h('span', { class: 'count', text: String(r.byStage[stage].count) }),
              ),
              h('small', { text: `${formatTl(r.byStage[stage].monthlyKurus)} / ay` }),
            ),
            cards.length ? cards.map(prospectCard) : h('p', { class: 'colempty', text: 'Fırsat yok' }),
          );
        }),
      ),
    );
  }

  // ---------- admin: my account, operators, audit ----------
  const AUDIT_LABELS = {
    'password.change': 'Şifresini değiştirdi',
    'totp.enable': 'İki aşamalı doğrulamayı açtı',
    'totp.disable': 'İki aşamalı doğrulamayı kapattı',
    'operator.add': 'Operatör ekledi',
    'operator.enable': 'Operatörü etkinleştirdi',
    'operator.disable': 'Operatörü pasife aldı',
    'operator.reset_password': 'Operatörün şifresini sıfırladı',
    'operator.reset_totp': 'Operatörün iki aşamalı doğrulamasını sıfırladı',
    'settings.sms': 'SMS ayarlarını kaydetti',
    'settings.sms_clear': 'SMS ayarlarını sildi',
    'settings.sms_test': 'Deneme SMS gönderdi',
    'settings.maps': 'Harita servisi ayarlarını kaydetti',
    'settings.maps_clear': 'Harita servisi ayarlarını sildi',
  };
  const SMS_PURPOSE = {
    password_recovery: 'Şifremi unuttum',
    operator_reset: 'Konsoldan sıfırlama',
    test: 'Deneme',
  };
  const SMS_STATUS = { sent: 'Gönderildi', failed: 'Hata', blocked: 'Sınır' };
  function smsPanel() {
    const sms = state.sms;
    if (!sms) return null;
    const result = h('p', { class: 'muted', role: 'status' });
    const form = h('form', { class: 'smsform', novalidate: true });
    const username = h('input', {
      type: 'text',
      inputmode: 'numeric',
      autocomplete: 'off',
      value: sms.username,
    });
    username.value = sms.username;
    const password = h('input', {
      type: 'password',
      autocomplete: 'new-password',
      placeholder: sms.configured ? 'Kayıtlı — değiştirmek için yazın' : 'Verimor API şifresi',
    });
    const header = h('input', { type: 'text', maxlength: '20', autocomplete: 'off' });
    header.value = sms.header;
    const enabled = h('input', { type: 'checkbox' });
    enabled.checked = sms.enabled;
    const typed = () => ({
      username: username.value.trim(),
      password: password.value.trim() || undefined,
      header: header.value.trim(),
    });
    const run = async (button, work) => {
      button.disabled = true;
      result.textContent = '';
      try {
        await work();
      } catch (e) {
        result.textContent = '✕ ' + e.message;
      } finally {
        button.disabled = false;
      }
    };
    const testButton = h('button', { class: 'btn', type: 'button', text: 'Bağlantıyı test et' });
    testButton.onclick = () =>
      run(testButton, async () => {
        const r = await api('settings/sms/test', { method: 'POST', body: typed() });
        result.textContent = `✓ Bağlandı. Kalan kredi: ${r.balance}. Tanımlı başlıklar: ${r.headers.join(', ') || '—'}`;
      });
    const sendButton = h('button', { class: 'btn', type: 'button', text: 'Deneme SMS gönder' });
    sendButton.onclick = () =>
      formDialog({
        title: 'Deneme SMS',
        intro: 'Kayıtlı ayarlarla bu numaraya kısa bir deneme mesajı gönderilir.',
        fields: [{ name: 'phone', label: 'Cep telefonu', type: 'text', required: true }],
        submitLabel: 'Gönder',
        submit: (v) => api('settings/sms/send-test', { method: 'POST', body: { phone: v.phone } }),
      }).then((ok) => ok && (toast('Deneme SMS gönderildi.'), reloadAdmin()));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const save = form.querySelector('button[type=submit]');
      run(save, async () => {
        state.sms = {
          ...state.sms,
          ...(await api('settings/sms', { method: 'POST', body: { ...typed(), enabled: enabled.checked } })),
        };
        toast('SMS ayarları kaydedildi.');
        await reloadAdmin();
      });
    });
    form.append(
      h(
        'div',
        { class: 'smsgrid' },
        h('label', { class: 'field' }, h('span', { text: 'Verimor kullanıcı adı (hesap no)' }), username),
        h('label', { class: 'field' }, h('span', { text: 'API şifresi' }), password),
        h('label', { class: 'field' }, h('span', { text: 'SMS başlığı' }), header),
      ),
      h(
        'label',
        { class: 'check' },
        enabled,
        'Bürolar WhatsApp kurana kadar "Şifremi unuttum" SMS ile çalışsın',
      ),
      h(
        'p',
        { class: 'muted' },
        'Verimor, API isteklerini yalnızca izin verilen sunucu IP adreslerinden kabul eder. Test "IP izni" hatası verirse Verimor panelinde sunucunun çıkış IP adresini izinli listeye ekleyin.',
      ),
      result,
      h(
        'div',
        { class: 'toolbar' },
        testButton,
        sms.configured ? sendButton : null,
        h('button', { class: 'btn primary', type: 'submit', text: 'Kaydet' }),
      ),
    );
    const u = sms.usage;
    return h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'panelhead' },
        h('h3', { text: 'SMS (Verimor) — platform hesabı' }),
        badge(sms.enabled ? 'Açık' : sms.configured ? 'Kapalı' : 'Ayarlanmadı', sms.enabled ? 'ok' : 'warn'),
      ),
      h(
        'div',
        { class: 'accountbody' },
        h('p', {
          class: 'muted',
          text: `Bu ay ${u.monthSent} SMS (${u.monthSegments} kredi). Son 30 günde ${u.failed30} hata, ${u.blocked30} sınıra takılan. Büro başına günlük sınır: ${sms.dailyLimitPerOffice}.`,
        }),
        form,
      ),
      sms.recent.length
        ? h(
            'div',
            { class: 'overflow' },
            h(
              'table',
              {},
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  ['Zaman', 'Büro', 'Amaç', 'Numara', 'Durum'].map((t) => h('th', { text: t })),
                ),
              ),
              h(
                'tbody',
                {},
                sms.recent.map((r) =>
                  h(
                    'tr',
                    {},
                    h('td', { text: dateTimeText(r.createdAt) }),
                    h('td', { text: r.office || '—' }),
                    h('td', { text: SMS_PURPOSE[r.purpose] || r.purpose }),
                    h('td', { text: r.dest }),
                    h('td', { text: (SMS_STATUS[r.status] || r.status) + (r.error ? ' · ' + r.error : '') }),
                  ),
                ),
              ),
            ),
          )
        : null,
    );
  }
  // The selling company's own Google Maps account: offices subscribed to "Rota Bulma harita
  // servisi" search with it and need no key of their own.
  function mapsPanel() {
    const maps = state.maps;
    if (!maps) return null;
    const result = h('p', { class: 'muted', role: 'status' });
    const form = h('form', { class: 'smsform mapsform', novalidate: true });
    const apiKey = h('input', {
      type: 'password',
      maxlength: '39',
      autocomplete: 'new-password',
      placeholder: maps.configured ? 'Kayıtlı — değiştirmek için yazın' : 'AIza ile başlayan anahtar',
    });
    const browserKey = h('input', {
      type: 'text',
      maxlength: '39',
      autocomplete: 'off',
      placeholder: 'İsteğe bağlı — Google haritası için',
    });
    browserKey.value = maps.browserKey;
    const searches = h('input', { type: 'number', min: '1', max: '1000000', step: '1' });
    searches.value = String(maps.monthlySearches);
    const details = h('input', { type: 'number', min: '1', max: '1000000', step: '1' });
    details.value = String(maps.monthlyDetails);
    const enabled = h('input', { type: 'checkbox' });
    enabled.checked = maps.enabled;
    const run = async (button, work) => {
      button.disabled = true;
      result.textContent = '';
      try {
        await work();
      } catch (e) {
        result.textContent = '✕ ' + e.message;
      } finally {
        button.disabled = false;
      }
    };
    const testButton = h('button', { class: 'btn', type: 'button', text: 'Anahtarı test et' });
    testButton.onclick = () =>
      run(testButton, async () => {
        await api('settings/maps/test', { method: 'POST', body: { apiKey: apiKey.value.trim() || undefined } });
        result.textContent = '✓ Bağlandı. Google bu anahtarla aramayı kabul etti.';
      });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const save = form.querySelector('button[type=submit]');
      run(save, async () => {
        state.maps = {
          ...state.maps,
          ...(await api('settings/maps', {
            method: 'POST',
            body: {
              apiKey: apiKey.value.trim() || undefined,
              browserKey: browserKey.value.trim(),
              monthlySearches: Number(searches.value),
              monthlyDetails: Number(details.value),
              enabled: enabled.checked,
            },
          })),
        };
        toast('Harita servisi ayarları kaydedildi.');
        await reloadAdmin();
      });
    });
    form.append(
      h(
        'div',
        { class: 'smsgrid' },
        h('label', { class: 'field' }, h('span', { text: 'Google Places API anahtarı (gizli)' }), apiKey),
        h('label', { class: 'field' }, h('span', { text: 'Harita anahtarı (tarayıcı)' }), browserKey),
        h('label', { class: 'field' }, h('span', { text: 'Büro başına aylık arama' }), searches),
        h('label', { class: 'field' }, h('span', { text: 'Büro başına aylık rota yenileme (firma)' }), details),
      ),
      h('label', { class: 'check' }, enabled, 'Abone bürolar hazır harita servisini kullansın'),
      h(
        'p',
        { class: 'muted' },
        'Places anahtarı şifrelenerek saklanır ve hiçbir büroya gönderilmez; yalnızca Places API (New) ile sınırlayın. Harita anahtarı büroların tarayıcısına gönderilir: ayrı bir anahtar oluşturup yalnızca Maps JavaScript API’ye ve kendi alan adınıza (HTTP yönlendiren) sınırlayın. Harita anahtarı girilmezse ekranda OpenStreetMap haritası kullanılır. Her arama Google’a ücretli bir istektir; sınırlar büro başına aylıktır ve ay başında sıfırlanır.',
      ),
      result,
      h(
        'div',
        { class: 'toolbar' },
        testButton,
        h('button', { class: 'btn primary', type: 'submit', text: 'Kaydet' }),
      ),
    );
    const u = maps.usage;
    return h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'panelhead' },
        h('h3', { text: 'Harita servisi (Rota Bulma aboneliği) — platform hesabı' }),
        badge(maps.enabled ? 'Açık' : maps.configured ? 'Kapalı' : 'Ayarlanmadı', maps.enabled ? 'ok' : 'warn'),
      ),
      h(
        'div',
        { class: 'accountbody' },
        h('p', {
          class: 'muted',
          text: `Bu ay ${u.monthSearches.toLocaleString('tr-TR')} arama, ${u.monthDetails.toLocaleString('tr-TR')} firma yenileme. “Rota Bulma harita servisi” ürününü alan bürolar bu hesapla arar; “Pazarlama ve rota” modülünü alan bürolar kendi anahtarını girer.`,
        }),
        form,
      ),
      u.offices.length
        ? h(
            'div',
            { class: 'overflow' },
            h(
              'table',
              {},
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  ['Büro', 'Bu ay arama', 'Kalan hak', 'Firma yenileme'].map((t) => h('th', { text: t })),
                ),
              ),
              h(
                'tbody',
                {},
                u.offices.map((o) =>
                  h(
                    'tr',
                    {},
                    h('td', { text: o.name }),
                    h('td', { text: o.searches.toLocaleString('tr-TR') }),
                    h('td', { text: Math.max(0, maps.monthlySearches - o.searches).toLocaleString('tr-TR') }),
                    h('td', { text: o.details.toLocaleString('tr-TR') }),
                  ),
                ),
              ),
            ),
          )
        : null,
    );
  }
  // ---------- Yedekleme: every office and the console's own data ----------
  const sizeText = (bytes) =>
    !bytes
      ? '—'
      : bytes < 1048576
        ? Math.max(1, Math.round(bytes / 1024)).toLocaleString('tr-TR') + ' KB'
        : (bytes / 1048576).toLocaleString('tr-TR', { maximumFractionDigits: 1 }) + ' MB';
  function backupOfficeBadge(office) {
    if (!office.hasData) return badge('Veri yok');
    if (office.lastError) return badge('Hata', 'bad');
    if (!office.lastSuccessAt) return badge('Hiç alınmadı', 'warn');
    return Date.now() - Date.parse(office.lastSuccessAt) > 36 * 3600000
      ? badge('Eski', 'warn')
      : badge('Yedekli', 'ok');
  }
  function backupRunText(run) {
    const parts = [`${run.saved} büro yedeklendi`];
    if (run.fresh) parts.push(`${run.fresh} büro zaten güncel`);
    if (run.failed) parts.push(`${run.failed} büro alınamadı`);
    if (run.waiting) parts.push(`${run.waiting} büro sıraya kaldı (yeniden başlatın)`);
    if (run.empty) parts.push(`${run.empty} büroda veri yok`);
    parts.push(run.platform ? 'yönetim yedeği alındı' : 'yönetim yedeği alınamadı');
    return parts.join(', ') + '.';
  }
  function backupPanel() {
    const backups = state.backups;
    if (!backups) return null;
    const usable = backups.r2Configured && backups.encryptionConfigured;
    const result = h('p', { class: 'muted backupnote', role: 'status', text: state.backupNote || '' });
    const runButton = h('button', {
      class: 'btn primary',
      type: 'button',
      text: 'Şimdi tümünü yedekle',
      disabled: !usable,
    });
    runButton.onclick = async () => {
      runButton.disabled = true;
      runButton.textContent = 'Yedekleniyor…';
      result.textContent =
        'Tüm bürolar ve yönetim yedekleniyor. Büro sayısına göre bir-iki dakika sürebilir; sayfayı kapatmayın.';
      try {
        state.backups = await api('backups/run', { method: 'POST', body: {} });
        state.backupNote = (state.backups.ok ? '✓ ' : '✕ ') + backupRunText(state.backups.lastRun);
        state.backupFiles = null;
      } catch (e) {
        state.backupNote = '✕ ' + e.message;
      }
      renderApp();
    };
    const automatic = h('input', { type: 'checkbox', disabled: !usable || !backups.scheduleConfigured });
    automatic.checked = backups.enabled;
    automatic.onchange = async () => {
      automatic.disabled = true;
      try {
        state.backups = await api('backups', { method: 'POST', body: { enabled: automatic.checked } });
        state.backupNote = automatic.checked
          ? '✓ Otomatik yedekleme açıldı: her sabah 06:00’da çalışır.'
          : '✓ Otomatik toplu yedekleme kapatıldı.';
      } catch (e) {
        state.backupNote = '✕ ' + e.message;
      }
      renderApp();
    };
    const filesButton = h('button', {
      class: 'btn',
      type: 'button',
      text: 'Yönetim yedeği dosyaları',
      disabled: !backups.r2Configured,
    });
    filesButton.onclick = async () => {
      filesButton.disabled = true;
      try {
        state.backupFiles = (await api('backups/files')).backups;
        state.backupNote = '';
      } catch (e) {
        state.backupNote = '✕ ' + e.message;
      }
      renderApp();
    };
    const run = backups.lastRun;
    const table = (heads, rows, empty) =>
      h(
        'div',
        { class: 'overflow' },
        h(
          'table',
          {},
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              heads.map((t) => h('th', { text: t })),
            ),
          ),
          h(
            'tbody',
            {},
            rows.length
              ? rows
              : h('tr', {}, h('td', { colspan: String(heads.length), class: 'empty', text: empty })),
          ),
        ),
      );
    return h(
      'section',
      { class: 'panel backuppanel' },
      h(
        'div',
        { class: 'panelhead' },
        h('h3', { text: 'Yedekleme — tüm bürolar ve yönetim' }),
        badge(
          !usable ? 'Ayarlanmadı' : backups.enabled ? 'Otomatik açık' : 'Otomatik kapalı',
          usable && backups.enabled ? 'ok' : 'warn',
        ),
      ),
      h(
        'div',
        { class: 'accountbody' },
        h('p', {
          class: 'muted',
          text: run
            ? `Son toplu yedek: ${dateTimeText(run.at)} (${run.scheduled ? 'otomatik' : 'elle'}) — ${backupRunText(run)} Yönetim yedeği: ${sizeText(backups.lastSize)}.`
            : 'Henüz toplu yedek alınmadı.',
        }),
        backups.lastError
          ? h('p', { class: 'muted backuperror', text: 'Son hata: ' + backups.lastError })
          : null,
        !usable
          ? h('p', {
              class: 'muted backuperror',
              text: 'Yedek deposu (R2) veya şifreleme anahtarı sunucuda ayarlı değil; yedek alınamaz.',
            })
          : null,
        h('label', { class: 'check' }, automatic, 'Her sabah 06:00’da tüm büroları ve yönetimi otomatik yedekle'),
        h('div', { class: 'toolbar' }, runButton, filesButton),
        result,
        h('p', {
          class: 'muted',
          text: 'Her büronun yedeği kendi klasörüne şifreli yazılır; büro yöneticisi aynı dosyayı kendi Ayarlar → Yedekleme ekranında görür. Yönetim yedeği büroları, abonelikleri, satışları, giderleri, destek kayıtlarını ve operatör hesaplarını içerir; SMS şifresi ve harita anahtarı gibi sağlayıcı bilgileri yedeğe girmez. Buradan yalnızca yönetim yedeği indirilebilir. Otomatik yedekleme, son 12 saatte yedeği alınmış büroyu atlar.',
        }),
      ),
      table(
        ['Büro', 'Adres', 'Son yedek', 'Boyut', 'Durum', 'Büronun kendi zamanlaması'],
        backups.offices.map((o) =>
          h(
            'tr',
            {},
            h('td', { text: o.name }),
            h('td', { text: o.slug === 'existing-office' ? 'ana adres' : o.slug }),
            h('td', { text: dateTimeText(o.lastSuccessAt) }),
            h('td', { text: sizeText(o.lastSize) }),
            h('td', {}, backupOfficeBadge(o)),
            h('td', { text: o.automatic ? 'Açık' : 'Kapalı' }),
          ),
        ),
        'Büro yok.',
      ),
      state.backupFiles
        ? table(
            ['Yönetim yedeği', 'Boyut', ''],
            state.backupFiles.map((file) =>
              h(
                'tr',
                {},
                h('td', { text: dateTimeText(file.createdAt) }),
                h('td', { text: sizeText(file.size) }),
                h(
                  'td',
                  { class: 'rowactions' },
                  h('a', {
                    class: 'btn small',
                    href: '/api/platform/backups/download?key=' + encodeURIComponent(file.key),
                    download: true,
                    text: 'İndir',
                  }),
                ),
              ),
            ),
            'Henüz yönetim yedeği yok.',
          )
        : null,
    );
  }
  function showRecoveryCodes(codes) {
    return new Promise((resolve) => {
      const dialog = h('dialog', {});
      const text = codes.join('\n');
      dialog.append(
        h(
          'div',
          { class: 'dialog-head' },
          h(
            'div',
            {},
            h('h3', { text: 'Kurtarma kodlarınız' }),
            h('p', {
              text: 'Telefonunuzu kaybederseniz her biri bir kez kullanılabilir. Güvenli bir yere kaydedin; bu kodlar bir daha gösterilmez.',
            }),
          ),
        ),
        h(
          'div',
          { class: 'dialog-body' },
          h('pre', { class: 'recovery', text }),
          h(
            'div',
            { class: 'actions' },
            h('button', {
              class: 'btn',
              type: 'button',
              text: 'Kopyala',
              onclick: async () => {
                try {
                  await navigator.clipboard.writeText(text);
                  toast('Kodlar kopyalandı.');
                } catch {
                  toast('Kopyalanamadı; kodları elle kaydedin.', true);
                }
              },
            }),
          ),
        ),
        h(
          'div',
          { class: 'dialog-foot' },
          h('button', {
            class: 'btn primary',
            type: 'button',
            text: 'Kaydettim',
            onclick: () => dialog.close(),
          }),
        ),
      );
      dialog.addEventListener('close', () => {
        dialog.remove();
        resolve();
      });
      document.body.append(dialog);
      dialog.showModal();
    });
  }
  async function enableTotpFlow() {
    let start;
    try {
      start = await api('account/totp/start', { method: 'POST', body: {} });
    } catch (e) {
      return toast(e.message, true);
    }
    let codes = null;
    const done = await formDialog({
      title: 'İki aşamalı doğrulamayı aç',
      intro: `Authenticator uygulamanızda (Google Authenticator, Microsoft Authenticator, Authy…) "Anahtar gir" ile yeni hesap ekleyin. Hesap: ${state.admin.username} · Anahtar: ${start.secret} · Tür: zamana dayalı. Sonra uygulamadaki 6 haneli kodu girin.`,
      fields: [{ name: 'code', label: 'Doğrulama kodu', type: 'text', required: true }],
      submitLabel: 'Doğrula ve aç',
      submit: async (v) => {
        codes = (await api('account/totp/confirm', { method: 'POST', body: { code: v.code } })).recoveryCodes;
      },
    });
    if (!done) return;
    await showRecoveryCodes(codes);
    state.account = null;
    if (state.setupRequired) {
      state.setupRequired = false;
      state.tab = 'overview';
      return refresh();
    }
    await loadTabData();
    renderApp();
  }
  const reloadAdmin = async () => {
    state.account = null;
    await loadTabData();
  };
  function operatorRow(o) {
    const self = o.id === state.admin?.id;
    return h(
      'tr',
      { class: o.active ? '' : 'dim' },
      h('td', {}, h('strong', { text: o.name }), h('small', { text: o.username + (self ? ' · siz' : '') })),
      h('td', {}, badge(o.active ? 'Etkin' : 'Pasif', o.active ? 'ok' : '')),
      h('td', {}, badge(o.totpEnabled ? 'Açık' : 'Kapalı', o.totpEnabled ? 'ok' : 'warn')),
      h('td', { text: dateTimeText(o.createdAt) }),
      h(
        'td',
        { class: 'rowactions' },
        self
          ? null
          : [
              h('button', {
                class: 'btn small',
                text: o.active ? 'Pasife al' : 'Etkinleştir',
                onclick: async () => {
                  try {
                    await api(`operators/${o.id}/active`, { method: 'POST', body: { active: !o.active } });
                    await reloadAdmin();
                  } catch (e) {
                    toast(e.message, true);
                  }
                },
              }),
              h('button', {
                class: 'btn small',
                text: 'Şifre sıfırla',
                onclick: () =>
                  formDialog({
                    title: `${o.name} — şifre sıfırla`,
                    intro: 'Yeni şifreyi kişiye güvenli bir yoldan iletin. Açık oturumları hemen kapanır.',
                    fields: [
                      {
                        name: 'password',
                        label: 'Yeni şifre (en az 12 karakter)',
                        type: 'password',
                        required: true,
                      },
                    ],
                    submit: (v) =>
                      api(`operators/${o.id}/reset-password`, {
                        method: 'POST',
                        body: { password: v.password },
                      }),
                  }).then((ok) => ok && (toast('Şifre sıfırlandı.'), reloadAdmin())),
              }),
              o.totpEnabled
                ? h('button', {
                    class: 'btn small',
                    text: '2 aşamalıyı sıfırla',
                    onclick: async () => {
                      if (
                        !window.confirm(
                          `${o.name} için iki aşamalı doğrulama kapatılsın mı? Açık oturumları da kapanır.`,
                        )
                      )
                        return;
                      try {
                        await api(`operators/${o.id}/reset-totp`, { method: 'POST', body: {} });
                        toast('İki aşamalı doğrulama sıfırlandı.');
                        await reloadAdmin();
                      } catch (e) {
                        toast(e.message, true);
                      }
                    },
                  })
                : null,
            ],
      ),
    );
  }
  function renderAdmin() {
    const a = state.account;
    if (!a) return h('p', { class: 'empty', text: 'Yükleniyor…' });
    const myAccount = h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'panelhead' },
        h('h3', { text: 'Hesabım' }),
        h('small', { text: `${a.name} · ${a.username}` }),
      ),
      h(
        'div',
        { class: 'accountbody' },
        state.setupRequired
          ? h('p', {
              class: 'formerror',
              text: 'Bu sunucuda iki aşamalı doğrulama zorunludur. Devam etmek için aşağıdan etkinleştirin.',
            })
          : null,
        h(
          'div',
          { class: 'accountrow' },
          h(
            'div',
            {},
            h('strong', { text: 'İki aşamalı doğrulama' }),
            h('p', {
              text: a.totpEnabled
                ? `Açık. Kalan kurtarma kodu: ${a.recoveryCodesLeft}.`
                : 'Kapalı. Şimdilik isteğe bağlı; Yönetim → SMS açıldığında tüm operatörler için zorunlu olur.',
            }),
          ),
          a.totpEnabled
            ? a.totpRequired
              ? badge('Zorunlu', 'ok')
              : h('button', {
                  class: 'btn',
                  text: 'Kapat',
                  onclick: () =>
                    formDialog({
                      title: 'İki aşamalı doğrulamayı kapat',
                      intro: 'Şifrenizi ve uygulamadaki güncel kodu (veya bir kurtarma kodunu) girin.',
                      fields: [
                        { name: 'password', label: 'Şifre', type: 'password', required: true },
                        { name: 'code', label: 'Doğrulama veya kurtarma kodu', type: 'text', required: true },
                      ],
                      danger: true,
                      submitLabel: 'Kapat',
                      submit: (v) => api('account/totp/disable', { method: 'POST', body: v }),
                    }).then((ok) => ok && (toast('İki aşamalı doğrulama kapatıldı.'), reloadAdmin())),
                })
            : h('button', { class: 'btn primary', text: 'Etkinleştir', onclick: enableTotpFlow }),
        ),
        h(
          'div',
          { class: 'accountrow' },
          h(
            'div',
            {},
            h('strong', { text: 'Şifre' }),
            h('p', { text: 'Değiştirince diğer açık oturumlarınız kapanır.' }),
          ),
          h('button', {
            class: 'btn',
            text: 'Şifre değiştir',
            onclick: () =>
              formDialog({
                title: 'Şifre değiştir',
                fields: [
                  { name: 'current', label: 'Mevcut şifre', type: 'password', required: true },
                  { name: 'next', label: 'Yeni şifre (en az 12 karakter)', type: 'password', required: true },
                ],
                submit: (v) => api('account/password', { method: 'POST', body: v }),
              }).then((ok) => ok && toast('Şifre değiştirildi.')),
          }),
        ),
      ),
    );
    if (state.setupRequired || !state.operators) return h('div', {}, myAccount);
    const operators = h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'panelhead' },
        h('h3', { text: 'Operatörler' }),
        h('button', {
          class: 'btn primary small',
          text: 'Operatör ekle',
          onclick: () =>
            formDialog({
              title: 'Operatör ekle',
              intro:
                'Operatörler tüm büroları, satışları ve finansı görür. Şifreyi kişiye güvenli bir yoldan iletin.',
              fields: [
                { name: 'name', label: 'Ad soyad', type: 'text', required: true },
                { name: 'username', label: 'Kullanıcı adı', type: 'text', required: true },
                {
                  name: 'password',
                  label: 'Geçici şifre (en az 12 karakter)',
                  type: 'password',
                  required: true,
                },
              ],
              submit: (v) => api('operators', { method: 'POST', body: v }),
            }).then((ok) => ok && (toast('Operatör eklendi.'), reloadAdmin())),
        }),
      ),
      h(
        'div',
        { class: 'overflow' },
        h(
          'table',
          {},
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              ['Operatör', 'Durum', 'İki aşamalı', 'Eklenme', ''].map((t) => h('th', { text: t })),
            ),
          ),
          h('tbody', {}, state.operators.map(operatorRow)),
        ),
      ),
    );
    const audit = h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'panelhead' },
        h('h3', { text: 'Hesap işlem kayıtları' }),
        h('small', { text: 'Son 100 işlem' }),
      ),
      h(
        'div',
        { class: 'overflow' },
        h(
          'table',
          {},
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              ['Zaman', 'Operatör', 'İşlem', 'Hedef'].map((t) => h('th', { text: t })),
            ),
          ),
          h(
            'tbody',
            {},
            state.audit.length
              ? state.audit.map((e) =>
                  h(
                    'tr',
                    {},
                    h('td', { text: dateTimeText(e.createdAt) }),
                    h('td', { text: e.by }),
                    h('td', { text: AUDIT_LABELS[e.action] || e.action }),
                    h('td', { text: e.target || '—' }),
                  ),
                )
              : h('tr', {}, h('td', { colspan: '4', class: 'empty', text: 'Kayıt yok.' })),
          ),
        ),
      ),
    );
    return h(
      'div',
      {},
      h(
        'div',
        { class: 'heading' },
        h('div', {}, h('p', { class: 'eyebrow', text: 'Güvenlik' }), h('h2', { text: 'Yönetim' })),
      ),
      myAccount,
      operators,
      smsPanel(),
      mapsPanel(),
      backupPanel(),
      audit,
    );
  }

  // ---------- start ----------
  api('session')
    .then(async (result) => {
      const { admin } = result;
      if (!admin) return renderLogin();
      state.admin = admin;
      state.setupRequired = result.totpSetupRequired === true;
      await refresh();
    })
    .catch((error) => {
      if (error.status === 401) return; // api() already showed the sign-in form
      app.replaceChildren(h('p', { class: 'empty', text: 'Platform konsoluna ulaşılamıyor.' }));
    });
}
if (typeof document !== 'undefined') boot();
