const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '../outputs/icrapro');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const INJECTION = '<img src=x onerror="window.pwned=1">';

// Loads the real support screen and the support-access strip with the few globals the workspace
// provides. `routes` maps "METHOD /path" to a response (or a function of the request body); an
// Error value is thrown the way the real authApi throws. The strip polls with fetch, so
// `env.status` / `env.statusCode` stand in for GET /api/support-access/status.
function browser(
  t,
  { user = { role: 'ceo' }, supportDesk = true, status, routes = {}, hiddenDom = '' } = {},
) {
  const dom = new JSDOM(
    `<div class="shell"><header><div class="header-actions"><button id="notificationBell"></button><button id="signOut"></button></div></header><main><div id="content"></div></main></div>${hiddenDom}`,
    { url: 'https://local-test.invalid/', runScripts: 'dangerously', pretendToBeVisual: true },
  );
  t.after(() => dom.window.close());
  const w = dom.window;
  w.eval(read('html-safety.js'));
  const env = {
    calls: [],
    toasts: [],
    fetches: [],
    timers: [],
    reloads: 0,
    now: 1_000_000,
    confirmAnswer: true,
    hidden: false,
    statusCode: 200,
    fetchError: null,
    status: status || { access: null, self: null, answered: [] },
    routes,
  };
  Object.assign(w, {
    $: (selector) => w.document.querySelector(selector),
    esc: w.escapeHtml,
    toast: (message) => env.toasts.push(message),
    hanAuth: { name: 'Ayşe', username: 'ayse', ...user },
    hanModules: supportDesk ? { supportDesk: true } : {},
    page: 'home',
    settingsTab: 'firm',
    settingsSectionTabs: () => '<div class="settings-tabs"></div>',
    bindSettingsSectionTabs() {},
    authApi(url, method = 'GET', data) {
      // Copied out of the page's realm so deepStrictEqual compares plain objects.
      env.calls.push({
        url,
        method,
        data: data === undefined ? undefined : JSON.parse(JSON.stringify(data)),
      });
      const route = env.routes[`${method} ${url}`];
      if (route === undefined) throw Error('Beklenmeyen istek: ' + method + ' ' + url);
      const value = typeof route === 'function' ? route(data) : route;
      if (value instanceof Error) throw value;
      return value;
    },
    confirm: () => env.confirmAnswer,
    async fetch(url, init) {
      env.fetches.push({ url, init });
      if (env.fetchError) throw env.fetchError;
      return {
        ok: env.statusCode >= 200 && env.statusCode < 300,
        status: env.statusCode,
        json: async () => JSON.parse(JSON.stringify(env.status)),
      };
    },
    setTimeout(fn, ms) {
      env.timers.push({ fn, ms, kind: 'timeout', cleared: false });
      return env.timers.length;
    },
    clearTimeout(id) {
      if (env.timers[id - 1]) env.timers[id - 1].cleared = true;
    },
    setInterval(fn, ms) {
      env.timers.push({ fn, ms, kind: 'interval', cleared: false });
      return env.timers.length;
    },
  });
  Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => env.hidden });
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  w.eval(read('workspace-support.js'));
  w.eval(read('workspace-support-access.js'));
  w.supportAccessNow = () => env.now;
  w.supportAccessReload = () => {
    env.reloads++;
  };
  return { w, env };
}

const view = (extra = {}) => ({
  id: 'a1',
  ticketId: 't1',
  status: 'active',
  state: 'connected',
  minutes: 30,
  allowEdit: false,
  grantedBy: 'Ayşe',
  offerUntil: null,
  startedAt: null,
  deadline: null,
  remainingSeconds: 1770,
  selfExtended: false,
  extensionRequest: null,
  endedAt: null,
  endedBy: null,
  canDecide: true,
  ...extra,
});
const statusOf = (access = null, extra = {}) => ({ access, self: null, answered: [], ...extra });

const clean = (value) => value?.replace(/\s+/g, ' ').trim();
const strip = (w) => w.document.getElementById('supportAccessStrip');
// Each row as "text [Button|Button]".
const rows = (w) =>
  [...strip(w).querySelectorAll('.support-strip-row')].map((row) => {
    const labels = [...row.querySelectorAll('button')].map((button) => button.textContent);
    return (
      clean(row.querySelector('.support-strip-text').textContent) +
      (labels.length ? ` [${labels.join('|')}]` : '')
    );
  });
const buttonsOf = (w, selector = '.support-strip-row') =>
  [...strip(w).querySelectorAll(`${selector} button`)].map((button) => button.textContent);
const click = (w, label) =>
  [...strip(w).querySelectorAll('button')].find((button) => button.textContent === label).click();
const settle = (w) => w.refreshSupportAccess();

// Pushes one status through the strip, the way a poll would.
async function show(w, env, status) {
  env.status = status;
  await w.pollSupportAccess();
}

test('countdown formatting', (t) => {
  const { w } = browser(t);
  assert.equal(w.supportAccessClock(0), '00:00');
  assert.equal(w.supportAccessClock(5), '00:05');
  assert.equal(w.supportAccessClock(125), '02:05');
  assert.equal(w.supportAccessClock(1770), '29:30');
  assert.equal(w.supportAccessClock(3600), '60:00');
  assert.equal(w.supportAccessClock(-4), '00:00');
  assert.equal(w.supportAccessClock(null), '00:00');
});

test('nothing to show: the strip stays hidden and the header is not shifted', async (t) => {
  const { w, env } = browser(t);
  await show(w, env, statusOf());
  assert.equal(strip(w).hidden, true);
  assert.equal(w.document.body.classList.contains('has-support-strip'), false);
  assert.equal(w.document.documentElement.style.getPropertyValue('--support-strip-h'), '0px');
});

test('pending grant: waiting text and İzni geri al ends it after confirmation', async (t) => {
  const { w, env } = browser(t, {
    routes: { 'POST /api/support-access/a1/end': { ended: true } },
  });
  await show(
    w,
    env,
    statusOf(view({ state: 'pending', status: 'pending', minutes: 15, remainingSeconds: null })),
  );
  assert.deepEqual(rows(w), [
    'Destek ekibine 15 dk erişim izni verildi · bağlantı bekleniyor [İzni geri al]',
  ]);
  assert.equal(strip(w).hidden, false);
  assert.ok(w.document.body.classList.contains('has-support-strip'));
  assert.equal(strip(w).parentElement.className, 'shell');
  assert.equal(strip(w).parentElement.firstElementChild, strip(w));

  env.confirmAnswer = false;
  click(w, 'İzni geri al');
  assert.equal(env.calls.length, 0);

  env.confirmAnswer = true;
  const before = env.fetches.length;
  env.status = statusOf();
  click(w, 'İzni geri al');
  assert.deepEqual(env.calls, [{ url: '/api/support-access/a1/end', method: 'POST', data: {} }]);
  await settle(w);
  assert.ok(env.fetches.length > before, 'status is polled again right after the action');
  assert.equal(strip(w).hidden, true);
});

test('connected: remaining time counts down locally and is re-synced by every poll', async (t) => {
  const { w, env } = browser(t);
  await show(w, env, statusOf(view({ remainingSeconds: 1770 })));
  assert.deepEqual(rows(w), [
    'Destek ekibi şu an bağlı · kalan 29:30 · Yalnızca görüntüleme [Erişimi sonlandır]',
  ]);
  env.now += 30_000;
  w.tickSupportAccess();
  assert.equal(strip(w).querySelector('.support-strip-clock').textContent, '29:00');
  env.now += 59_000;
  w.tickSupportAccess();
  assert.equal(strip(w).querySelector('.support-strip-clock').textContent, '28:01');

  // The server says something else (the office added time): the clock follows the server.
  await show(w, env, statusOf(view({ remainingSeconds: 3000, allowEdit: true })));
  assert.deepEqual(rows(w), [
    'Destek ekibi şu an bağlı · kalan 50:00 · Değişiklik yapabilir [Erişimi sonlandır]',
  ]);
  env.now += 1000;
  w.tickSupportAccess();
  assert.equal(strip(w).querySelector('.support-strip-clock').textContent, '49:59');
});

test('Erişimi sonlandır asks first, then posts end and polls again', async (t) => {
  const { w, env } = browser(t, {
    routes: { 'POST /api/support-access/a1/end': { ended: true } },
  });
  await show(w, env, statusOf(view()));
  let asked = '';
  w.confirm = (message) => {
    asked = message;
    return false;
  };
  click(w, 'Erişimi sonlandır');
  assert.match(asked, /sonlandırılsın mı/);
  assert.equal(env.calls.length, 0);
  w.confirm = () => true;
  env.status = statusOf(null);
  click(w, 'Erişimi sonlandır');
  assert.deepEqual(
    env.calls.map((c) => `${c.method} ${c.url}`),
    ['POST /api/support-access/a1/end'],
  );
  await settle(w);
  assert.equal(strip(w).hidden, true);
});

test('a failing end request shows the message and leaves the strip alone', async (t) => {
  const { w, env } = browser(t, {
    routes: {
      'POST /api/support-access/a1/end': Error('Erişimi CEO, yönetici veya izni veren sonlandırır.'),
    },
  });
  await show(w, env, statusOf(view()));
  click(w, 'Erişimi sonlandır');
  await settle(w);
  assert.deepEqual(env.toasts, ['Erişimi CEO, yönetici veya izni veren sonlandırır.']);
  assert.equal(strip(w).hidden, false);
});

test('overtime shows the expiry text; a clock that runs out asks the server again', async (t) => {
  const { w, env } = browser(t);
  await show(w, env, statusOf(view({ state: 'overtime', remainingSeconds: 0 })));
  assert.deepEqual(rows(w), ['Destek ekibinin süresi doldu. [Erişimi sonlandır]']);

  await show(w, env, statusOf(view({ remainingSeconds: 3 })));
  const polls = env.fetches.length;
  env.now += 2000;
  w.tickSupportAccess();
  assert.equal(env.fetches.length, polls, 'one second left: no extra request yet');
  env.now += 6000;
  env.status = statusOf(view({ state: 'overtime', remainingSeconds: 0 }));
  w.tickSupportAccess();
  assert.equal(strip(w).querySelector('.support-strip-clock').textContent, '00:00');
  assert.equal(env.fetches.length, polls + 1);
  await w.pollSupportAccess();
  assert.deepEqual(rows(w), ['Destek ekibinin süresi doldu. [Erişimi sonlandır]']);
});

test('extension request: text with and without a note, Onayla and Reddet post the decision', async (t) => {
  const { w, env } = browser(t, {
    routes: { 'POST /api/support-access/a1/extension': { approved: true } },
  });
  await show(w, env, statusOf(view({ extensionRequest: { minutes: 15, note: 'Aktarım sürüyor', at: 'x' } })));
  assert.deepEqual(rows(w), [
    'Destek ekibi şu an bağlı · kalan 29:30 · Yalnızca görüntüleme [Erişimi sonlandır]',
    'Destek ekibi 15 dk ek süre istiyor: Aktarım sürüyor [Onayla|Reddet]',
  ]);
  click(w, 'Onayla');
  click(w, 'Reddet');
  assert.deepEqual(env.calls, [
    { url: '/api/support-access/a1/extension', method: 'POST', data: { approve: true } },
    { url: '/api/support-access/a1/extension', method: 'POST', data: { approve: false } },
  ]);
  await settle(w);

  await show(w, env, statusOf(view({ extensionRequest: { minutes: 30, note: null, at: 'x' } })));
  assert.equal(rows(w)[1], 'Destek ekibi 30 dk ek süre istiyor [Onayla|Reddet]');
});

test('a user who may not decide sees the state but no buttons', async (t) => {
  const { w, env } = browser(t, { user: { role: 'staff' } });
  await show(
    w,
    env,
    statusOf(view({ canDecide: false, extensionRequest: { minutes: 15, note: null, at: 'x' } })),
  );
  assert.deepEqual(rows(w), [
    'Destek ekibi şu an bağlı · kalan 29:30 · Yalnızca görüntüleme',
    'Destek ekibi 15 dk ek süre istiyor',
  ]);
  assert.equal(strip(w).querySelectorAll('button').length, 0);
});

test('answered ticket: one item at a time with Çözüldü, Hâlâ sorun var and Kaydı aç', async (t) => {
  const { w, env } = browser(t, {
    user: { role: 'staff' },
    routes: {
      'POST /api/support/t9/resolved': { status: 'resolved' },
      'POST /api/support/t9/messages': { ok: true },
      'GET /api/support/t9': {
        ticket: {
          id: 't9',
          number: 12,
          subject: 'Fatura sorunu',
          category: 'billing',
          status: 'waiting_customer',
        },
        messages: [],
      },
    },
  });
  const answered = [
    { ticketId: 't9', number: 12, subject: 'Fatura sorunu', reply: 'Sorun çözüldü, test edin.' },
    { ticketId: 't10', number: 13, subject: 'Başka kayıt', reply: 'Ikinci yanıt' },
  ];
  await show(w, env, statusOf(null, { answered }));
  assert.deepEqual(rows(w), [
    'Destek yanıt verdi (#12 Fatura sorunu): Sorun çözüldü, test edin. [Çözüldü|Hâlâ sorun var|Kaydı aç]',
  ]);

  click(w, 'Çözüldü');
  assert.deepEqual(env.calls.pop(), { url: '/api/support/t9/resolved', method: 'POST', data: {} });
  click(w, 'Hâlâ sorun var');
  assert.deepEqual(env.calls.pop(), {
    url: '/api/support/t9/messages',
    method: 'POST',
    data: { body: 'Sorun devam ediyor.' },
  });
  await settle(w);

  click(w, 'Kaydı aç');
  assert.deepEqual(env.calls.pop(), { url: '/api/support/t9', method: 'GET', data: undefined });
  assert.ok(w.document.getElementById('supportDialog').open);

  // The next poll shows the following item.
  await show(w, env, statusOf(null, { answered: answered.slice(1) }));
  assert.ok(rows(w)[0].startsWith('Destek yanıt verdi (#13 Başka kayıt): Ikinci yanıt'));
});

test('read-only accounts see the answer but get no buttons that would be refused', async (t) => {
  const { w, env } = browser(t, { user: { role: 'staff', readOnly: true } });
  await show(
    w,
    env,
    statusOf(null, { answered: [{ ticketId: 't9', number: 4, subject: 'Konu', reply: 'Yanıt' }] }),
  );
  assert.ok(rows(w)[0].startsWith('Destek yanıt verdi (#4 Konu): Yanıt'));
  assert.ok(!buttonsOf(w).includes('Çözüldü'));
});

test('the support account sees its own strip with the countdown and no office controls', async (t) => {
  const { w, env } = browser(t, { user: { role: 'admin', platformSupport: true } });
  const self = view({ remainingSeconds: 600, canDecide: undefined });
  await show(
    w,
    env,
    statusOf(view({ remainingSeconds: 600 }), {
      self,
      answered: [{ ticketId: 'x', number: 1, subject: 's', reply: 'r' }],
    }),
  );
  assert.deepEqual(rows(w), ['Hukuk Takip Platformu destek oturumu · kalan 10:00 · Salt okunur']);
  assert.equal(strip(w).querySelectorAll('button').length, 0);
  env.now += 60_000;
  w.tickSupportAccess();
  assert.equal(strip(w).querySelector('.support-strip-clock').textContent, '09:00');

  await show(w, env, statusOf(null, { self: { ...self, allowEdit: true } }));
  assert.deepEqual(rows(w), ['Hukuk Takip Platformu destek oturumu · kalan 10:00 · Düzenleme açık']);
});

test('support account: at zero it polls again and reloads the page once the session has ended', async (t) => {
  const { w, env } = browser(t, { user: { role: 'admin', platformSupport: true } });
  await show(w, env, statusOf(null, { self: view({ remainingSeconds: 5 }) }));
  assert.equal(env.reloads, 0);
  const polls = env.fetches.length;
  env.now += 5000;
  env.status = statusOf(null, { self: null });
  w.tickSupportAccess();
  assert.equal(env.fetches.length, polls + 1);
  await w.pollSupportAccess();
  assert.equal(env.reloads, 1);

  // Time added in the meantime: no reload, the clock simply continues.
  const other = browser(t, { user: { role: 'admin', platformSupport: true } });
  await show(other.w, other.env, statusOf(null, { self: view({ remainingSeconds: 5 }) }));
  other.env.now += 5000;
  other.env.status = statusOf(null, { self: view({ remainingSeconds: 900 }) });
  other.w.tickSupportAccess();
  await other.w.pollSupportAccess();
  assert.equal(other.env.reloads, 0);
  assert.match(rows(other.w)[0], /kalan 15:00/);
});

test('support account: a 401 means the session ended; a first empty answer does not reload', async (t) => {
  const { w, env } = browser(t, { user: { role: 'admin', platformSupport: true } });
  await show(w, env, statusOf());
  assert.equal(env.reloads, 0);
  env.statusCode = 401;
  await w.pollSupportAccess();
  assert.equal(env.reloads, 1);

  const office = browser(t);
  office.env.statusCode = 401;
  await office.w.pollSupportAccess();
  assert.equal(office.env.reloads, 0, 'office users are signed out by the notification poll, not here');
});

test('polling: 5 minutes when idle, 30 seconds while there is something to watch', async (t) => {
  const { w, env } = browser(t);
  w.startSupportAccess();
  await w.pollSupportAccess();
  assert.equal(env.fetches.length, 1);
  assert.equal(env.fetches[0].url, '/api/support-access/status');
  assert.equal(env.fetches[0].init.headers['X-Han-Request'], '1');
  const timeouts = () => env.timers.filter((timer) => timer.kind === 'timeout' && !timer.cleared);
  assert.equal(timeouts().at(-1).ms, 300_000);
  assert.ok(env.timers.some((timer) => timer.kind === 'interval' && timer.ms === 1000));

  env.status = statusOf(view());
  await timeouts().at(-1).fn();
  assert.equal(env.fetches.length, 2);
  assert.equal(timeouts().at(-1).ms, 30_000);

  env.status = statusOf(null, { answered: [{ ticketId: 't', number: 1, subject: 's', reply: 'r' }] });
  await timeouts().at(-1).fn();
  assert.equal(timeouts().at(-1).ms, 30_000);

  env.status = statusOf();
  await timeouts().at(-1).fn();
  assert.equal(timeouts().at(-1).ms, 300_000);
});

test('polling pauses while the tab is hidden and resumes when it is shown again', async (t) => {
  const { w, env } = browser(t);
  env.hidden = true;
  w.startSupportAccess();
  assert.equal(await w.pollSupportAccess(), false);
  assert.equal(env.fetches.length, 0);
  env.hidden = false;
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  await w.pollSupportAccess();
  assert.equal(env.fetches.length, 1);
});

test('a failing request never throws; the next round simply tries again', async (t) => {
  const { w, env } = browser(t);
  env.fetchError = new Error('network down');
  w.startSupportAccess();
  assert.equal(await w.pollSupportAccess(), false);
  assert.ok(
    env.timers.some((timer) => timer.kind === 'timeout' && !timer.cleared),
    'a retry is scheduled',
  );
  env.fetchError = null;
  env.statusCode = 500;
  assert.equal(await w.pollSupportAccess(), false);
  env.statusCode = 200;
  env.status = statusOf(view());
  assert.equal(await w.pollSupportAccess(), true);
  assert.equal(rows(w).length, 1);
});

test('nothing starts without the support desk flag or a signed-in user', async (t) => {
  const off = browser(t, { supportDesk: false });
  off.w.startSupportAccess();
  assert.equal(off.env.fetches.length, 0);
  assert.equal(off.env.timers.length, 0);
  const out = browser(t);
  out.w.hanAuth = null;
  out.w.startSupportAccess();
  assert.equal(out.env.fetches.length, 0);
});

test('server text is shown as text only, never as markup', async (t) => {
  const { w, env } = browser(t, { user: { role: 'ceo' } });
  w.pwned = undefined;
  await show(
    w,
    env,
    statusOf(view({ extensionRequest: { minutes: 15, note: INJECTION, at: 'x' } }), {
      answered: [{ ticketId: 't9', number: 3, subject: INJECTION, reply: INJECTION }],
    }),
  );
  assert.equal(strip(w).querySelector('img'), null);
  assert.equal(w.pwned, undefined);
  const text = clean(strip(w).textContent);
  assert.ok(text.includes(`ek süre istiyor: ${INJECTION}`));
  assert.ok(text.includes(`(#3 ${INJECTION}): ${INJECTION}`));
});

test('support screens escape ticket text too', async (t) => {
  const { w, env } = browser(t, {
    routes: {
      'GET /api/support': {
        manager: true,
        tickets: [
          {
            id: 't1',
            number: 1,
            subject: INJECTION,
            category: 'technical',
            status: 'open',
            updatedAt: '2026-11-12T10:00:00Z',
          },
        ],
      },
      'GET /api/support/t1': {
        ticket: { id: 't1', number: 1, subject: INJECTION, category: 'technical', status: 'open' },
        messages: [
          { from: 'support', author: INJECTION, body: INJECTION, createdAt: '2026-11-12T10:00:00Z' },
        ],
      },
      'GET /api/support-access/status': statusOf(),
    },
  });
  w.supportListDialog();
  w.supportTicketDialog('t1');
  assert.equal(w.document.querySelector('#supportDialog img'), null);
  assert.equal(w.pwned, undefined);
  assert.ok(env.calls.length > 0);
});

// ------------------------------------------------------------------ the support screen

const ticketRoutes = {
  'POST /api/support': { id: 't-new', number: 7 },
  'POST /api/support-access/grant': { ok: true, accessId: 'a9', minutes: 60, allowEdit: true },
  'GET /api/support': { manager: true, tickets: [] },
};
const fillNew = (w, { grant = null } = {}) => {
  const form = w.document.getElementById('supportNewForm');
  form.elements.subject.value = 'Yazıcı çalışmıyor';
  form.elements.body.value = 'Çıktı alamıyoruz.';
  if (grant) {
    form.elements.grantAccess.checked = true;
    form.elements.grantAccess.dispatchEvent(new w.Event('change'));
    form.elements.grantMinutes.value = String(grant.minutes);
    form.elements.grantEdit.checked = grant.allowEdit;
  }
  return form;
};
const submit = (w, form) => form.dispatchEvent(new w.Event('submit', { cancelable: true }));

test('manager: new-ticket form offers the access options, hidden until the box is ticked', (t) => {
  const { w } = browser(t, { routes: ticketRoutes });
  w.supportNewDialog();
  const form = w.document.getElementById('supportNewForm');
  const detail = w.document.getElementById('supportAccessDetail');
  assert.ok(clean(form.textContent).includes('Destek ekibinin büroma bağlanmasına izin ver'));
  assert.equal(form.elements.grantAccess.checked, false);
  assert.equal(detail.hidden, true);
  assert.deepEqual(
    [...form.elements.grantMinutes.options].map((o) => `${o.value}:${o.textContent}`),
    ['15:15 dk', '30:30 dk', '60:1 saat'],
  );
  assert.equal(form.elements.grantEdit.checked, false, 'view-only unless ticked');
  assert.ok(
    clean(detail.textContent).includes(
      'İşaretlemezseniz yalnızca görüntüler. Silme işlemi hiçbir zaman yapamaz.',
    ),
  );
  assert.ok(clean(detail.textContent).includes('Destek ekibi değişiklik yapabilsin'));
  form.elements.grantAccess.checked = true;
  form.elements.grantAccess.dispatchEvent(new w.Event('change'));
  assert.equal(detail.hidden, false);
  form.elements.grantAccess.checked = false;
  form.elements.grantAccess.dispatchEvent(new w.Event('change'));
  assert.equal(detail.hidden, true);
});

test('manager: after the ticket is created the grant is posted with the chosen options', (t) => {
  const { w, env } = browser(t, { routes: ticketRoutes });
  w.supportNewDialog();
  const form = fillNew(w, { grant: { minutes: 60, allowEdit: true } });
  submit(w, form);
  assert.deepEqual(
    env.calls.map((c) => `${c.method} ${c.url}`),
    ['POST /api/support', 'POST /api/support-access/grant'],
  );
  assert.deepEqual(env.calls[1].data, { ticketId: 't-new', minutes: 60, allowEdit: true });
  assert.equal(env.calls[0].data.subject, 'Yazıcı çalışmıyor');
  assert.equal(w.document.getElementById('supportDialog').open, false);
  assert.match(env.toasts[0], /#7/);
  assert.match(env.toasts[0], /1 saat erişim izni verildi \(değişiklik yapabilir\)/);
  assert.ok(env.fetches.length > 0, 'the strip is refreshed');
});

test('manager: default grant is view-only; without the box ticked no grant is posted', (t) => {
  const a = browser(t, { routes: ticketRoutes });
  a.w.supportNewDialog();
  const form = fillNew(a.w);
  submit(a.w, form);
  assert.deepEqual(
    a.env.calls.map((c) => c.url),
    ['/api/support'],
  );

  const b = browser(t, { routes: ticketRoutes });
  b.w.supportNewDialog();
  const f = fillNew(b.w);
  f.elements.grantAccess.checked = true;
  f.elements.grantAccess.dispatchEvent(new b.w.Event('change'));
  submit(b.w, f);
  assert.deepEqual(b.env.calls[1].data, { ticketId: 't-new', minutes: 30, allowEdit: false });
});

test('manager: a refused grant keeps the created ticket and says so', (t) => {
  const { w, env } = browser(t, {
    routes: { ...ticketRoutes, 'POST /api/support-access/grant': Error('Erişim izni verilemedi (sunucu).') },
  });
  w.supportNewDialog();
  submit(w, fillNew(w, { grant: { minutes: 15, allowEdit: false } }));
  assert.equal(env.calls.filter((c) => c.url === '/api/support').length, 1);
  assert.match(env.toasts[0], /#7/);
  assert.match(env.toasts[0], /Erişim izni verilemedi: Erişim izni verilemedi \(sunucu\)\./);
  assert.equal(w.document.getElementById('supportDialog').open, false);
});

test('a failing ticket request shows its error in the form and posts no grant', (t) => {
  const { w, env } = browser(t, {
    routes: { ...ticketRoutes, 'POST /api/support': Error('Konu çok kısa.') },
  });
  w.supportNewDialog();
  submit(w, fillNew(w, { grant: { minutes: 15, allowEdit: false } }));
  assert.equal(w.document.getElementById('supportNewError').textContent, 'Konu çok kısa.');
  assert.deepEqual(
    env.calls.map((c) => c.url),
    ['/api/support'],
  );
});

test('staff never see the access options and never post a grant', (t) => {
  const { w, env } = browser(t, { user: { role: 'staff' }, routes: ticketRoutes });
  w.supportNewDialog();
  const form = fillNew(w);
  assert.equal(form.elements.grantAccess, undefined);
  assert.equal(form.elements.grantMinutes, undefined);
  assert.equal(form.elements.grantEdit, undefined);
  assert.equal(w.document.getElementById('supportAccessDetail'), null);
  assert.ok(!clean(form.textContent).includes('büroma bağlanmasına'));
  submit(w, form);
  assert.deepEqual(
    env.calls.map((c) => c.url),
    ['/api/support'],
  );
});

const ticket = (extra = {}) => ({
  ticket: { id: 't1', number: 5, subject: 'Konu', category: 'technical', status: 'open', ...extra },
  messages: [],
});

test('ticket detail (manager, no grant): Erişim izni ver posts the chosen options', (t) => {
  const { w, env } = browser(t, {
    routes: {
      'GET /api/support/t1': ticket(),
      'GET /api/support-access/status': statusOf(),
      'POST /api/support-access/grant': { ok: true, accessId: 'a2', minutes: 15, allowEdit: true },
    },
  });
  w.supportTicketDialog('t1');
  const dialog = w.document.getElementById('supportDialog');
  assert.ok(clean(dialog.textContent).includes('Destek erişimi'));
  const button = dialog.querySelector('[data-support-access-grant]');
  assert.equal(button.textContent, 'Erişim izni ver');
  assert.equal(dialog.querySelector('[data-support-access-end]'), null);
  const form = dialog.querySelector('form');
  form.elements.grantMinutes.value = '15';
  form.elements.grantEdit.checked = true;
  env.calls.length = 0;
  button.click();
  assert.deepEqual(env.calls[0], {
    url: '/api/support-access/grant',
    method: 'POST',
    data: { ticketId: 't1', minutes: 15, allowEdit: true },
  });
  assert.match(env.toasts.at(-1), /15 dk erişim izni verildi/);
  assert.ok(env.fetches.length > 0, 'the strip is refreshed');
});

test('ticket detail (manager, open grant on this ticket): state text and Erişimi sonlandır', (t) => {
  const open = (extra) => ({
    'GET /api/support/t1': ticket(),
    'GET /api/support-access/status': statusOf(view({ ticketId: 't1', ...extra })),
    'POST /api/support-access/a1/end': { ended: true },
  });
  const pending = browser(t, { routes: open({ state: 'pending', minutes: 15 }) });
  pending.w.supportTicketDialog('t1');
  const text = clean(pending.w.document.getElementById('supportDialog').textContent);
  assert.ok(text.includes('15 dk erişim izni verildi (yalnızca görüntüleme)'));
  assert.ok(text.includes('süre ilk bağlantıda başlar'));
  assert.equal(pending.w.document.querySelector('[data-support-access-grant]'), null);

  const connected = browser(t, { routes: open({ allowEdit: true }) });
  connected.w.supportTicketDialog('t1');
  const connectedText = clean(connected.w.document.getElementById('supportDialog').textContent);
  assert.ok(connectedText.includes('Destek ekibi şu an bağlı (değişiklik yapabilir)'));
  connected.env.confirmAnswer = false;
  connected.w.document.querySelector('[data-support-access-end]').click();
  assert.equal(connected.env.calls.filter((c) => c.method === 'POST').length, 0);
  connected.env.confirmAnswer = true;
  connected.w.document.querySelector('[data-support-access-end]').click();
  assert.deepEqual(connected.env.calls.at(-3), {
    url: '/api/support-access/a1/end',
    method: 'POST',
    data: {},
  });
  assert.match(connected.env.toasts.at(-1), /sonlandırıldı/);
});

test('ticket detail: a grant for another ticket is mentioned and can be replaced', (t) => {
  const { w } = browser(t, {
    routes: {
      'GET /api/support/t1': ticket(),
      'GET /api/support-access/status': statusOf(view({ ticketId: 'other' })),
    },
  });
  w.supportTicketDialog('t1');
  const dialog = w.document.getElementById('supportDialog');
  assert.ok(clean(dialog.textContent).includes('başka bir kayıt için açık bir erişim izni var'));
  assert.ok(dialog.querySelector('[data-support-access-grant]'));
});

test('ticket detail: staff, closed tickets and a failing status request get no access section', (t) => {
  const staff = browser(t, { user: { role: 'staff' }, routes: { 'GET /api/support/t1': ticket() } });
  staff.w.supportTicketDialog('t1');
  assert.ok(!staff.env.calls.some((c) => c.url.includes('support-access')));
  assert.ok(!clean(staff.w.document.getElementById('supportDialog').textContent).includes('Destek erişimi'));
  assert.ok(staff.w.document.querySelector('#supportReplyForm textarea'));

  const closed = browser(t, {
    routes: { 'GET /api/support/t1': ticket({ status: 'closed' }) },
  });
  closed.w.supportTicketDialog('t1');
  assert.ok(!closed.env.calls.some((c) => c.url.includes('support-access')));
  assert.ok(!clean(closed.w.document.getElementById('supportDialog').textContent).includes('Destek erişimi'));

  const failing = browser(t, {
    routes: {
      'GET /api/support/t1': ticket(),
      'GET /api/support-access/status': Error('Sunucuya ulaşılamadı.'),
    },
  });
  failing.w.supportTicketDialog('t1');
  assert.ok(failing.w.document.getElementById('supportDialog').open);
  assert.equal(failing.w.document.querySelector('[data-support-access-grant]'), null);
  assert.deepEqual(failing.env.toasts, []);
});

test('header button: every signed-in user gets it, the support account and a missing flag do not', (t) => {
  for (const user of [{ role: 'staff' }, { role: 'admin' }, { role: 'ceo' }]) {
    const { w } = browser(t, { user });
    w.setupSupportButton();
    w.setupSupportButton();
    const buttons = w.document.querySelectorAll('#supportButton');
    assert.equal(buttons.length, 1, user.role);
    assert.equal(clean(buttons[0].textContent), 'Destek');
    assert.equal(buttons[0].nextElementSibling.id, 'notificationBell');
  }
  const support = browser(t, { user: { role: 'admin', platformSupport: true } });
  support.w.setupSupportButton();
  assert.equal(support.w.document.getElementById('supportButton'), null);
  const off = browser(t, { supportDesk: false });
  off.w.setupSupportButton();
  assert.equal(off.w.document.getElementById('supportButton'), null);
});

test('staff open the support list from the header, write a record and come back with Geri', (t) => {
  const { w, env } = browser(t, {
    user: { role: 'staff' },
    routes: {
      'GET /api/support': {
        manager: false,
        tickets: [
          {
            id: 't1',
            number: 5,
            subject: 'Yazıcı',
            category: 'technical',
            status: 'waiting_customer',
            updatedAt: '2026-11-12T10:00:00Z',
          },
        ],
      },
      'POST /api/support': { id: 't-new', number: 6 },
      'GET /api/support/t1': ticket(),
    },
  });
  w.setupSupportButton();
  w.document.getElementById('supportButton').click();
  const dialog = w.document.getElementById('supportDialog');
  assert.ok(dialog.open);
  const text = clean(dialog.textContent);
  assert.ok(text.includes('Açtığınız destek kayıtları'));
  assert.ok(text.includes('#5'));
  assert.ok(text.includes('Yanıtınız bekleniyor'));

  dialog.querySelector('#supportListNew').click();
  const form = dialog.querySelector('#supportNewForm');
  assert.equal(form.querySelector('[data-support-close]').textContent, 'Geri');
  form.querySelector('[data-support-close]').click();
  assert.ok(dialog.querySelector('#supportListNew'), 'back on the list');
  assert.ok(dialog.open);

  dialog.querySelector('[data-support-open]').click();
  assert.equal(dialog.querySelector('[data-support-close]').textContent, 'Geri');
  dialog.querySelector('[data-support-close]').click();
  assert.ok(dialog.querySelector('#supportListNew'));

  dialog.querySelector('#supportListNew').click();
  const filled = fillNew(w);
  submit(w, filled);
  assert.ok(env.calls.some((c) => c.method === 'POST' && c.url === '/api/support'));
  assert.ok(dialog.open, 'the list is shown again after sending');
  assert.ok(dialog.querySelector('#supportListNew'));
  assert.match(env.toasts.at(-1), /#6/);
});

test('settings page: the Destek tab no longer refuses non-managers inside the page itself', (t) => {
  const { w, env } = browser(t, {
    routes: {
      'GET /api/support': { manager: true, tickets: [] },
    },
  });
  w.supportSettingsPage();
  assert.ok(clean(w.document.getElementById('content').textContent).includes('Henüz destek kaydınız yok.'));
  assert.ok(w.document.getElementById('supportNew'));
  assert.deepEqual(env.toasts, []);
});

test('wiring: scripts, launch hooks and styles', () => {
  const scripts = require(path.join(root, 'workspace-assets.js'));
  assert.equal(scripts.indexOf('workspace-support-access.js'), scripts.indexOf('workspace-support.js') + 1);
  const auth = read('auth.js');
  assert.match(auth, /setupSupportButton === 'function'\) setupSupportButton\(\)/);
  assert.match(
    auth,
    /startMessageNotifications\(\);\s*if \(typeof startSupportAccess === 'function'\) startSupportAccess\(\);/,
  );
  const css = read('style.css');
  assert.match(css, /\.support-strip \{[^}]*position: sticky/);
  assert.match(css, /body\.has-support-strip \.shell > header \{[^}]*--support-strip-h/);
  const source = read('workspace-support-access.js');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(source), 'the strip never builds HTML');
});
