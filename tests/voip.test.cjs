const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Writable } = require('node:stream');
const { createVoipHandler, configure, number, phones, updateEvent } = require('../lib/voip.cjs');
const { createRecordingStore, filename } = require('../lib/voip-recordings.cjs');
process.env.VOIP_ENCRYPTION_KEY = 'ab'.repeat(32);
// A browser that supports the web phone and where the microphone was already allowed.
function allowMicrophone(w, { state = 'granted', devices = [{ kind: 'audioinput' }], getUserMedia } = {}) {
  Object.defineProperty(w, 'isSecureContext', { value: true, configurable: true });
  w.RTCPeerConnection = function RTCPeerConnection() {};
  Object.defineProperty(w.navigator, 'permissions', {
    value: { query: async () => ({ state }) },
    configurable: true,
  });
  Object.defineProperty(w.navigator, 'mediaDevices', {
    value: {
      enumerateDevices: async () => devices,
      getUserMedia: getUserMedia || (async () => ({ getTracks: () => [{ stop() {} }] })),
    },
    configurable: true,
  });
}
function harness(fetcher, extra = {}) {
  let state = {
    users: [
      { id: 'u', active: true, name: 'CEO' },
      { id: 's', active: true, name: 'Personel', role: 'staff', staffId: 'p' },
    ],
    voipCalls: [],
    data: {
      'icrapro-v1': {
        docs: [
          {
            id: 'd',
            number: 'D-1',
            debtor: 'Test borçlu',
            client: 'c',
            relatedStaff: 'p',
            phone1: '05320000000',
            phone2: '05320000001',
          },
        ],
        clients: [{ id: 'c', name: 'Test müvekkil' }],
      },
    },
  };
  state.voipConfig = configure(
    {},
    {
      provider: 'verimor',
      enabled: true,
      apiKey: 'test-only-secret',
      domainId: '123',
      extensions: { u: '1001', s: '1002' },
    },
    state.users,
  );
  let actor = { id: 'u', name: 'CEO', role: 'ceo' },
    queue = Promise.resolve();
  const jobs = [];
  const h = createVoipHandler({
    transaction: (work) => {
      const next = queue.then(() =>
        work({
          state: structuredClone(state),
          saveState: (s) => {
            state = s;
          },
        }),
      );
      queue = next.catch(() => {});
      return next;
    },
    authenticatedUser: async () => ({ ...actor }),
    readBody: async (req) => Buffer.from(req.raw || '{}'),
    fetcher,
    background: (p) => jobs.push(p),
    recordings: { available: true, save: async () => {}, read: async () => Buffer.from('test') },
    ...extra,
  });
  return {
    get state() {
      return state;
    },
    set user(u) {
      actor = u;
    },
    jobs,
    async call(route, method = 'GET', input, parsedForm = false, headers = {}) {
      const req = {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        raw: JSON.stringify(input),
      };
      if (parsedForm) {
        req.headers['content-type'] = 'application/x-www-form-urlencoded';
        req.body = input;
      }
      const response = {
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
        },
        end(value) {
          this.body = value;
        },
      };
      await h(req, response, new URL('http://localhost/api/voip/' + route));
      return JSON.parse(response.body);
    },
  };
}
test('phone normalization deduplicates numbers and excludes invalid values', () => {
  assert.equal(number('+90 (532) 000-00-00'), '905320000000');
  assert.equal(number('X'), '');
  assert.equal(
    phones({ phone1: '05320000000', phone2: '905320000000', additionalPhones: ['05320000001'] }).length,
    2,
  );  // Numbers added earlier land in additionalPhones; they fill an empty Tel-2 first.
  assert.deepEqual(
    phones({ phone1: '05320000000', additionalPhones: ['05320000001', '05320000002'] }).map((p) => p.label),
    ['Tel-1', 'Tel-2', 'Tel-3'],
  );
});
test('known originate failures are actionable and unknown provider responses never expose secrets', async () => {
  const offline = harness(async () => new Response('extension 1001 is not registered', { status: 400 }));
  await assert.rejects(
    offline.call('start', 'POST', {
      documentId: 'd',
      phone: '05320000000',
      requestId: 'offline-request-001',
    }),
    /santrale bağlı değil/,
  );
  assert.match(offline.state.voipCalls[0].providerError, /santrale bağlı değil/);
  const unknown = harness(async () => new Response('secret-token-should-not-leak', { status: 400 }));
  await assert.rejects(
    unknown.call('start', 'POST', {
      documentId: 'd',
      phone: '05320000000',
      requestId: 'unknown-request-001',
    }),
    (e) => !e.message.includes('secret-token'),
  );
});
test('standalone calls use documented GET originate, retain privacy, and still prevent duplicate calls', async () => {
  let sent;
  const h = harness(async (url, options) => {
    sent = { url: new URL(url), options };
    return new Response('00000000-0000-0000-0000-000000000001');
  });
  const { call } = await h.call('start', 'POST', {
    phone: '05320000005',
    requestId: 'standalone-request-001',
  });
  assert.equal(call.documentId, '');
  assert.equal(sent.options.method, 'GET');
  assert.equal(sent.options.body, undefined);
  assert.equal(sent.url.searchParams.get('extension'), '1001');
  assert.equal(sent.url.searchParams.get('destination'), '905320000005');
  assert.equal(sent.url.searchParams.get('manual_answer'), 'false');
  assert.equal((await h.call('calls?phone=05320000005')).calls[0].id, call.id);
  await assert.rejects(
    h.call('start', 'POST', { phone: '05320000005', requestId: 'standalone-request-002' }),
    (e) => e.status === 409,
  );
  await assert.rejects(
    h.call('start', 'POST', { documentId: 'd', phone: '05320000006', requestId: 'standalone-request-003' }),
    /föyde kayıtlı değil/,
  );
  h.user = { id: 's', role: 'staff', staffId: 'p' };
  const other = (await h.call('calls?phone=05320000005')).calls[0];
  assert.equal(other.phone, '905320000005');
  assert.equal(other.id, undefined);
  assert.equal(other.note, undefined);
});
test('standalone dialer shows last call before allowing a repeated call', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div class="header-actions"></div><aside><nav></nav></aside>', {
    url: 'https://example.test',
    runScripts: 'dangerously',
  });
  try {
    const w = dom.window;
    let starts = 0;
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    w.HTMLDialogElement.prototype.show = w.HTMLDialogElement.prototype.showModal;
    w.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    Object.assign(w, {
      hanAuth: { id: 's', role: 'staff' },
      esc: (v) => String(v).replaceAll('<', '&lt;'),
      fetch: async (url) => ({
        ok: true,
        json: async () => {
          if (url.endsWith('/start')) {
            starts++;
            return {};
          }
          return {
            enabled: true,
            extension: '1000',
            recentMinutes: 1440,
            results: [],
            calls: Array.from({ length: 7 }, (_, index) => ({
              phone: '905320000009',
              createdAt: new Date(Date.now() - index * 1000).toISOString(),
              staffName: 'Örnek Personel',
              status: 'completed',
              statusLabel: 'Görüşüldü',
              duration: 12,
            })),
            active: [],
          };
        },
      }),
    });
    w.eval(await fs.readFile('outputs/icrapro/modal-dismissal.js', 'utf8'));
    w.eval(await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8'));
    allowMicrophone(w);
    w.setupVoipNavigation();
    w.document.querySelector('[data-standalone-voip]').click();
    const form = w.document.querySelector('.voip-standalone-form');
    await new Promise((resolve) => setImmediate(resolve));
    form.elements.phone.value = '05320000009';
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(w.document.querySelector('[data-preview]').textContent, /Örnek Personel/);
    assert.equal(w.document.querySelectorAll('.voip-recent-call').length, 5);
    assert(w.document.querySelector('[data-more-phone-history]'));
    w.document.querySelector('[data-more-phone-history]').click();
    await new Promise(setImmediate);
    assert.equal(w.document.querySelectorAll('#voipHistory .voip-call-entry').length, 7);
    assert.match(w.document.querySelector('[data-dial]').textContent, /tekrar ara/);
    assert.equal(w.modalDrafts(form.closest('dialog')).length, 0, 'Phone lookup is not an unsaved edit');
    assert.equal(starts, 0);
  } finally {
    dom.window.close();
  }
});
test('single dial entry opens the webphone and restoring it does not reload an ongoing session', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div class="header-actions"></div><aside><nav></nav></aside>', {
    url: 'https://example.test',
    runScripts: 'dangerously',
  });
  try {
    const w = dom.window;
    let tokens = 0;
    w.HTMLDialogElement.prototype.show = function () {
      this.open = true;
    };
    Object.assign(w, {
      hanAuth: { id: 'u', role: 'ceo' },
      esc: String,
      fetch: async (url) => {
        if (url.endsWith('/webphone')) tokens++;
        return {
          ok: true,
          json: async () =>
            url.endsWith('/webphone')
              ? { url: 'https://example.bulutsantralim.com/phone?token=preview' }
              : { active: [] },
        };
      },
    });
    w.eval(await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8'));
    allowMicrophone(w);
    w.setupVoipNavigation();
    assert.equal(w.document.querySelector('[data-global-webphone]'), null);
    w.document.querySelector('[data-standalone-voip]').click();
    await new Promise(setImmediate);
    const phone = w.document.querySelector('#voipWebphone');
    assert(phone.open);
    phone.querySelector('button').click();
    assert(w.document.getElementById('voipPhoneDock').classList.contains('voip-dock-minimized'));
    assert.equal(w.document.querySelector('[data-global-webphone]'), null);
    w.document.querySelector('[data-standalone-voip]').click();
    await new Promise(setImmediate);
    assert.equal(tokens, 1);
    assert(!w.document.getElementById('voipPhoneDock').classList.contains('voip-dock-minimized'));
    phone.querySelector('[data-phone-close]').click();
    assert.equal(w.document.getElementById('voipPhoneDock').hidden, true);
    w.document.querySelector('[data-standalone-voip]').click();
    await new Promise(setImmediate);
    assert.equal(w.document.getElementById('voipPhoneDock').hidden, false);
    assert.equal(tokens, 1, 'Closing the window preserves the phone session');
  } finally {
    dom.window.close();
  }
});
test('only managers change user extensions; provider secrets and other assignments remain protected', async () => {
  const h = harness();
  const original = structuredClone(h.state.voipConfig);
  h.user = { id: 's', role: 'staff', staffId: 'p' };
  await assert.rejects(h.call('extensions', 'PUT', { userId: 's', extension: '1000' }), /yalnızca CEO/);
  await assert.rejects(h.call('extensions'), /yalnızca CEO/);
  await assert.rejects(h.call('config', 'PUT', { extensions: { s: '1000' } }), /yalnızca CEO/);
  assert.deepEqual(h.state.voipConfig, original);
  h.user = { id: 'a', name: 'Yönetici', role: 'admin' };
  const listed = await h.call('extensions');
  assert.equal(listed.users.length, 2);
  assert(!JSON.stringify(listed).includes(original.sealedKey));
  await h.call('extensions', 'PUT', { userId: 's', extension: '1000' });
  assert.equal(h.state.voipConfig.extensions.s, '1000');
  assert.equal(h.state.voipConfig.extensions.u, '1001');
  assert.equal(h.state.voipConfig.sealedKey, original.sealedKey);
  assert.equal(h.state.voipConfig.webhookSecret, original.webhookSecret);
  await assert.rejects(
    h.call('extensions', 'PUT', { userId: 's', extension: '1001' }),
    /başka bir kullanıcı/,
  );
  await assert.rejects(h.call('extensions', 'PUT', { userId: 's', extension: 'abc' }), /2–8/);
  await assert.rejects(
    h.call('extensions', 'PUT', { userId: 's', extension: '1000', apiKey: 'forged' }),
    /yalnızca dahili/,
  );
  const updated = configure(h.state.voipConfig, { provider: 'verimor' }, h.state.users);
  assert.equal(
    updated.extensions.s,
    '1000',
    'Saving provider settings must preserve current manager assignments',
  );
  await h.call('extensions', 'PUT', { userId: 's', extension: '' });
  assert.equal(h.state.voipConfig.extensions.s, undefined);
});
test('configuration keeps keys encrypted and validates provider, host and duplicate extensions', () => {
  const cfg = configure({}, { provider: 'verimor', apiKey: 'secret', extensions: {} }, []);
  assert(!cfg.sealedKey.includes('secret'));
  assert.equal(cfg.webhookSecret.length, 64);
  assert.throws(() => configure(cfg, { provider: 'custom', extensions: {} }, []), /Verimor/);
  assert.throws(
    () =>
      configure(cfg, { provider: 'verimor', webphoneUrl: 'https://evil.example/phone', extensions: {} }, []),
    /HTTPS/,
  );
  assert.throws(
    () =>
      configure(cfg, { provider: 'verimor', extensions: { a: '1001', b: '1001' } }, [
        { id: 'a' },
        { id: 'b' },
      ]),
    /iki kullanıcı/,
  );
});
test('extension panel lists extensions and assigns a person picked by name', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<main><section id="permissions"></section></main>', { runScripts: 'outside-only' }),
    w = dom.window;
  w.esc = (value) => String(value ?? '');
  w.confirm = () => true;
  w.eval(await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8'));
  const users = [
    { id: 'u', name: 'Cihan Erol', username: 'cihan', role: 'staff', extension: '1000' },
    { id: 's', name: 'Ayşe Kaya', username: 'ayse', role: 'staff', extension: '' },
  ];
  const puts = [];
  const view = () => ({
    users,
    extensions: ['1000', '1001'].map((extension) => ({
      extension,
      userId: users.find((u) => u.extension === extension)?.id || '',
      fromSwitchboard: true,
    })),
    switchboardListed: true,
  });
  w.voipApi = async (path, method, value) => {
    assert.equal(path, 'extensions');
    if (method === 'PUT') {
      puts.push(value);
      if (value.replace) for (const u of users) if (u.extension === value.extension) u.extension = '';
      const target = users.find((u) => u.id === value.userId);
      if (target) target.extension = value.extension;
    }
    return view();
  };
  await w.voipExtensionsPanel(w.document.querySelector('#permissions'));
  const row = (ext) => w.document.querySelector('[data-extension-row="' + ext + '"]');
  assert.deepEqual(
    [...w.document.querySelectorAll('[data-extension-row]')].map((f) => f.dataset.extensionRow),
    ['1000', '1001'],
    'one row per extension',
  );
  assert.equal(row('1000').elements.person.value, 'Cihan Erol (cihan)');
  assert.equal(row('1001').elements.person.value, '');
  assert.equal(w.document.querySelectorAll('#voipExtensionPeople option').length, 2, 'name suggestions');

  row('1001').elements.person.value = 'Ayşe Kaya (ayse)';
  row('1001').requestSubmit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual({ ...puts.at(-1) }, { userId: 's', extension: '1001', replace: true });
  assert.equal(row('1001').elements.person.value, 'Ayşe Kaya (ayse)');
  assert.equal(row('1001').querySelector('[role="status"]').textContent, 'Kaydedildi.');

  // Typing a plain name works too; taking 1000 moves it from Cihan to Ayşe.
  row('1000').elements.person.value = 'ayşe kaya';
  row('1000').requestSubmit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual({ ...puts.at(-1) }, { userId: 's', extension: '1000', replace: true });

  row('1000').elements.person.value = 'Olmayan Kişi';
  row('1000').requestSubmit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(row('1000').querySelector('[role="status"]').textContent, /bulunamadı/);
  assert.equal(puts.length, 2, 'unknown names are not sent');

  row('1000').querySelector('[data-unassign]').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual({ ...puts.at(-1) }, { userId: 's', extension: '' });

  const add = w.document.querySelector('[data-extension-add]');
  add.elements.extension.value = '1002';
  add.requestSubmit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual({ ...puts.at(-1) }, { addExtension: '1002' });
  w.close();
});

test('extensions API: switchboard list, take-over with replace, and a kept list of added extensions', async () => {
  let statusCalls = 0;
  const h = harness(async (url) => {
    if (new URL(url).pathname === '/user_statuses') {
      statusCalls++;
      return new Response('[{"user":1000,"status":"AVAILABLE"},{"user":1001,"status":"UNREGISTERED"}]');
    }
    return new Response('[]');
  });
  h.state.voipConfig.extensions = { u: '1001' };
  const first = await h.call('extensions');
  assert.deepEqual(
    first.extensions.map((e) => [e.extension, e.userId, e.fromSwitchboard]),
    [
      ['1000', '', true],
      ['1001', 'u', true],
    ],
  );
  await h.call('extensions');
  assert.equal(statusCalls, 1, 'switchboard list cached');
  await assert.rejects(h.call('extensions', 'PUT', { userId: 's', extension: '1001' }), /başka bir kullanıcıya atanmış/);
  const moved = await h.call('extensions', 'PUT', { userId: 's', extension: '1001', replace: true });
  assert.deepEqual(h.state.voipConfig.extensions, { s: '1001' }, 'taken from u');
  assert.equal(moved.extensions.find((e) => e.extension === '1001').userId, 's');
  await h.call('extensions', 'PUT', { addExtension: '1002' });
  assert.ok((await h.call('extensions')).extensions.some((e) => e.extension === '1002' && !e.fromSwitchboard));
  await assert.rejects(h.call('extensions', 'PUT', { removeExtension: '1001' }), /Önce bu dahilinin/);
  await h.call('extensions', 'PUT', { removeExtension: '1002' });
  assert.ok(!(await h.call('extensions')).extensions.some((e) => e.extension === '1002'));
  h.user = { id: 's', name: 'Personel', role: 'staff', staffId: 'p' };
  await assert.rejects(h.call('extensions'), /yalnızca CEO ve yöneticiler/);
});

test('reservation prevents concurrent dialing and replays request without another provider call', async () => {
  let release,
    started = 0;
  const h = harness(async () => {
    started++;
    await new Promise((r) => {
      release = r;
    });
    return new Response('00000000-0000-0000-0000-000000000001');
  });
  const first = h.call('start', 'POST', {
    documentId: 'd',
    phone: '05320000000',
    requestId: 'request-000000001',
  });
  while (!release) await new Promise((r) => setImmediate(r));
  await assert.rejects(
    h.call('start', 'POST', { documentId: 'd', phone: '05320000000', requestId: 'request-000000002' }),
    (e) => e.status === 409,
  );
  release();
  const one = await first;
  const again = await h.call('start', 'POST', {
    documentId: 'd',
    phone: '05320000000',
    requestId: 'request-000000001',
  });
  assert.equal(one.call.id, again.call.id);
  assert.equal(started, 1);
  assert.equal(h.state.voipCalls[0].clientName, 'Test müvekkil');
});
test('verified webhook updates call; duplicates and late ringing do not reopen a completed call', async () => {
  const h = harness(async () => new Response('00000000-0000-0000-0000-000000000001'));
  const { call } = await h.call('start', 'POST', {
    documentId: 'd',
    phone: '05320000000',
    requestId: 'request-000000001',
  });
  const event = {
    domain_id: '123',
    call_uuid: '00000000-0000-0000-0000-000000000001',
    event_type: 'hangup',
    answered: 'true',
    duration: '125',
    recording_present: 'false',
  };
  await assert.rejects(h.call('webhook?token=' + '0'.repeat(64), 'POST', event), (e) => e.status === 401);
  const url = 'webhook?token=' + h.state.voipConfig.webhookSecret;
  assert.deepEqual(await h.call(url, 'POST', {}, true), { ok: true });
  await assert.rejects(h.call('webhook?token=' + '0'.repeat(64), 'POST', {}, true), (e) => e.status === 401);
  await assert.rejects(h.call(url, 'POST', { event_type: 'hangup' }, true), (e) => e.status === 400);
  await h.call(url, 'POST', event, true);
  await h.call(url, 'POST', event);
  await h.call(url, 'POST', { ...event, event_type: 'ringing' });
  assert.equal(h.state.voipCalls[0].status, 'completed');
  assert.equal(h.state.voipCalls[0].duration, 125);
  assert.equal((await h.call('calls?documentId=d')).calls[0].canListen, false);
  await h.call('result', 'POST', { id: call.id, result: 'Olumlu', note: 'Test notu' });
  await assert.rejects(
    h.call('start', 'POST', { documentId: 'd', phone: '05320000000', requestId: 'request-000000003' }),
    (e) => e.status === 409,
  );
  await h.call('start', 'POST', { documentId: 'd', phone: '05320000001', requestId: 'request-000000004' });
});
test('hangup of an already closed channel verifies CDR instead of leaving a stuck active call', async () => {
  let complete = true;
  const h = harness(async (url) => {
    const path = new URL(url).pathname;
    if (path === '/originate') return new Response('00000000-0000-0000-0000-000000000001');
    if (path.startsWith('/hangup/')) return new Response('No such channel!', { status: 400 });
    return new Response(
      JSON.stringify({
        cdr: {
          end_stamp: complete ? '2026-11-10 18:00:00 +0300' : null,
          answer_stamp: '2026-11-10 17:59:48 +0300',
          talk_duration: '00:00:12',
          recording_present: false,
        },
      }),
    );
  });
  const { call } = await h.call('start', 'POST', {
    documentId: 'd',
    phone: '05320000000',
    requestId: 'closed-channel-001',
  });
  complete = false;
  await assert.rejects(h.call('hangup', 'POST', { id: call.id }), (e) => e.status === 409);
  assert.equal(h.state.voipCalls[0].status, 'ringing');
  complete = true;
  await h.call('hangup', 'POST', { id: call.id });
  assert.equal(h.state.voipCalls[0].status, 'completed');
  assert.equal(h.state.voipCalls[0].duration, 12);
});
test('recordings require manager or explicit current-assignee grant; reassignment revokes access', async () => {
  const h = harness();
  h.state.voipCalls.push({
    id: crypto.randomUUID(),
    documentId: 'd',
    phone: '905320000000',
    createdAt: new Date().toISOString(),
    status: 'completed',
    recordingPresent: true,
    archivedAt: '2026-01-01',
    userId: 'u',
  });
  h.user = { id: 's', name: 'Personel', role: 'staff', staffId: 'p' };
  await assert.rejects(h.call('transcript?id=' + h.state.voipCalls[0].id), (e) => e.status === 403);
  await assert.rejects(h.call('transcriptions', 'POST', { mode: 'all' }), (e) => e.status === 403);
  assert.equal((await h.call('calls?documentId=d')).calls[0].canListen, false);
  await assert.rejects(h.call('recording', 'POST', { id: h.state.voipCalls[0].id }), (e) => e.status === 403);
  await assert.rejects(h.call('recordings'), (e) => e.status === 403);
  await assert.rejects(h.call('permissions', 'PUT', { userId: 's', allowed: true }), (e) => e.status === 403);
  h.user = { id: 'u', name: 'CEO', role: 'admin' };
  await h.call('permissions', 'PUT', { userId: 's', allowed: true });
  h.user = { id: 's', name: 'Personel', role: 'staff', staffId: 'p' };
  assert.equal((await h.call('calls?documentId=d')).calls[0].canListen, true);
  h.state.data['icrapro-v1'].docs[0].relatedStaff = 'p2';
  await assert.rejects(h.call('recording', 'POST', { id: h.state.voipCalls[0].id }), (e) => e.status === 403);
});
test('live notes survive confirmed termination and final results reject premature or unauthorized changes', async () => {
  const id = '00000000-0000-0000-0000-000000000001';
  const h = harness(async () => new Response(id));
  const { call } = await h.call('start', 'POST', {
    documentId: 'd',
    phone: '05320000000',
    requestId: 'request-live-draft',
  });
  await h.call('draft', 'POST', { id: call.id, note: 'Görüşme sürerken alınan not' });
  await assert.rejects(
    h.call('result', 'POST', { id: call.id, result: 'Olumlu', note: 'x' }),
    (e) => e.status === 409,
  );
  h.user = { id: 's', role: 'staff', staffId: 'p' };
  await assert.rejects(
    h.call('draft', 'POST', { id: call.id, note: 'Başka personel' }),
    (e) => e.status === 403,
  );
  h.user = { id: 'u', role: 'ceo' };
  await h.call('webhook?token=' + h.state.voipConfig.webhookSecret, 'POST', {
    domain_id: '123',
    call_uuid: id,
    event_type: 'answer',
  });
  await h.call('webhook?token=' + h.state.voipConfig.webhookSecret, 'POST', {
    domain_id: '123',
    call_uuid: id,
    event_type: 'hangup',
    answered: false,
    hangup_cause: 'USER_BUSY',
    duration: 0,
  });
  assert.equal(h.state.voipCalls[0].status, 'busy');
  assert.equal(h.state.voipCalls[0].result, 'Meşgul');
  assert.match(h.state.voipCalls[0].note, /Görüşme sürerken alınan not/);
  assert.match(h.state.voipCalls[0].note, /Meşgul/);
  assert(h.state.voipCalls[0].resultAt);
  assert.equal(h.state.voipCalls[0].draftNote, undefined);
  assert.equal((await h.call('recordings?status=busy&result=' + encodeURIComponent('Meşgul'))).total, 1);
  assert.equal((await h.call('recordings?status=completed')).total, 0);
  await assert.rejects(
    h.call('draft', 'POST', { id: call.id, note: 'Geç kalan taslak' }),
    (e) => e.status === 409,
  );
});
test('mute requires call ownership, confirms provider success and rejects ended calls', async () => {
  const requests = [];
  let rejectMute = false;
  const h = harness(async (url, init) => {
    const target = new URL(url);
    if (target.pathname === '/originate') return new Response('00000000-0000-0000-0000-000000000001');
    requests.push({ path: target.pathname, state: target.searchParams.get('state'), method: init.method });
    return new Response(rejectMute ? 'Unavailable' : 'OK', { status: rejectMute ? 400 : 200 });
  });
  const { call } = await h.call('start', 'POST', {
    documentId: 'd',
    phone: '05320000000',
    requestId: 'mute-ownership-request',
  });
  h.user = { id: 's', role: 'staff', staffId: 'p' };
  await assert.rejects(h.call('mute', 'POST', { id: call.id, muted: true }), (e) => e.status === 403);
  assert.equal(requests.length, 0);
  h.user = { id: 'u', role: 'ceo' };
  await h.call('mute', 'POST', { id: call.id, muted: true });
  assert.equal(h.state.voipCalls[0].muted, true);
  assert.deepEqual(requests[0], {
    path: '/mute/00000000-0000-0000-0000-000000000001',
    state: 'on',
    method: 'GET',
  });
  rejectMute = true;
  await assert.rejects(h.call('mute', 'POST', { id: call.id, muted: false }));
  assert.equal(h.state.voipCalls[0].muted, true);
  h.state.voipCalls[0].status = 'completed';
  await assert.rejects(h.call('mute', 'POST', { id: call.id, muted: false }), (e) => e.status === 409);
  assert.equal(requests.length, 2);
});

test('absent provider recordings remain retryable and are distinguished from archive failures', async () => {
  const h = harness(async () => new Response(JSON.stringify({ cdr: { recording_present: false } })));
  const id = crypto.randomUUID();
  h.state.voipCalls.push({
    id,
    providerId: crypto.randomUUID(),
    documentId: 'd',
    createdAt: new Date().toISOString(),
    status: 'completed',
    duration: 0,
    recordingPresent: false,
  });
  await h.call('archive', 'POST', { id });
  const saved = h.state.voipCalls[0];
  assert.match(saved.archiveError, /Verimor bu çağrı için henüz ses kaydı sağlamadı/);
  assert(!saved.archiveError.includes('depolama'));
  assert(saved.nextArchiveAt);
  assert.equal(saved.recordingMissing, undefined);
  assert.equal(saved.archivedAt, undefined);
});

test('recordings are encrypted on disk, authenticate tampering and preserve original bytes', async () => {
  const dir = path.resolve('work/voip-test-' + crypto.randomUUID());
  const env = {};
  for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']) {
    env[k] = process.env[k];
    delete process.env[k];
  }
  try {
    const store = createRecordingStore({ cloud: false, directory: dir }),
      id = crypto.randomUUID(),
      audio = Buffer.from('ID3' + 'synthetic audio'.repeat(100));
    await store.save(id, audio);
    assert.deepEqual(await store.read(id), audio);
    const target = path.join(dir, 'gorusme-kayitlari', id + '.enc'),
      raw = await fs.readFile(target);
    assert(!raw.includes(Buffer.from('synthetic audio')));
    raw[35] ^= 1;
    await fs.writeFile(target, raw);
    await assert.rejects(store.read(id));
    assert.match(
      filename({
        clientName: 'Test / Müvekkil',
        documentNumber: 'D-1',
        createdAt: '2026-01-01T10:00:00Z',
        phone: '905320000000',
        staffName: 'Staff',
        id,
      }),
      /D-1_2026-01-01-13-00-00/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    for (const k of Object.keys(env)) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  }
});
test('UI keeps numbers, history and role-controlled audio together without preloading audio', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(
    '<div id="content"></div><dialog open><div class="sheet-header-actions"></div><section data-borrower-panel="conversations"></section></dialog>',
    { url: 'https://example.test', runScripts: 'dangerously' },
  );
  try {
    const w = dom.window;
    let startCount = 0,
      savedPhone;
    Object.assign(w, {
      hanAuth: { id: 's', role: 'staff' },
      esc: (v) => String(v).replaceAll('<', '&lt;'),
      saveRecordIntakeMetadata: async (_before, next) => {
        savedPhone = JSON.parse(JSON.stringify([next.phone1, next.phone2, next.additionalPhones]));
        return next;
      },
      fetch: async (url) =>
        url.endsWith('/start')
          ? (startCount++,
            {
              ok: false,
              json: async () => ({ error: 'Verimor isteği reddetti (HTTP 400).' }),
            })
          : {
              ok: true,
              json: async () => ({
                enabled: true,
                extension: '1002',
                recentMinutes: 1440,
                phones: [{ label: 'Tel-1', phone: '905320000000' }],
                calls: [
                  {
                    id: 'c',
                    phone: '905320000000',
                    staffName: 'Other Staff',
                    createdAt: new Date().toISOString(),
                    duration: 90,
                    status: 'completed',
                    statusLabel: 'Görüşüldü',
                    result: 'Olumlu',
                  },
                ],
                active: [],
              }),
            },
    });
    w.eval(await fs.readFile('outputs/icrapro/phone-format.js', 'utf8'));
    w.eval(await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8'));
    allowMicrophone(w);
    w.eval(await fs.readFile('outputs/icrapro/modal-dismissal.js', 'utf8'));
    w.setupBorrowerVoip(w.document.querySelector('dialog'), {
      id: 'd',
      phone1: '0 (532) 000 00 00',
      additionalPhones: ['05320000001'],
    });
    w.document.querySelector('[data-open-voip]').click();
    await new Promise((r) => setImmediate(r));
    assert.match(w.document.body.textContent, /Other Staff/);
    assert.match(w.document.body.textContent, /01:30/);
    assert(w.document.querySelector('[data-dial-phone]'));
    assert(w.document.querySelector('[data-number-history]'));
    w.document.querySelector('[data-add-phone]').click();
    const add = w.document.querySelector('.voip-add-phone');
    add.elements.phone.value = '05320000009';
    add.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setImmediate(r));
    // An older extra number moves up into the empty Tel-2; the new one follows as Tel-3.
    assert.deepEqual(savedPhone, ['0 (532) 000 00 00', '05320000001', ['0 (532) 000 00 09']]);
    assert.match(w.document.body.textContent, /Tel-3 alanına eklendi/);
    assert.equal(w.document.querySelectorAll('audio').length, 0);
    const panel = w.document.querySelector('.voip-number-panel');
    assert.equal(panel.querySelectorAll('[data-close-voip]').length, 0);
    panel.querySelector('[data-dial-phone]').click();
    assert.equal(startCount, 0, 'recent calls require an explicit repeat confirmation');
    assert.equal(panel.querySelector('[data-voip-repeat]').hidden, false);
    panel.querySelector('[data-cancel-repeat]').click();
    assert.equal(panel.querySelector('[data-voip-repeat]').hidden, true);
    assert.equal(
      w.document.querySelector('dialog').open,
      true,
      'canceling a repeat keeps the borrower sheet open',
    );
    panel.querySelector('[data-dial-phone]').click();
    panel.querySelector('[data-confirm-repeat]').click();
    await new Promise((r) => setImmediate(r));
    const alert = panel.querySelector('[role="alert"]');
    assert.match(alert.textContent, /HTTP 400/);
    assert.equal(alert.hidden, false);
    assert.equal(alert.closest('.voip-number-list'), null, 'errors stay above the scrolling phone list');
    assert.equal(panel.querySelector('[data-voip-repeat]').hidden, true);
    assert.equal(panel.querySelector('[data-dial-phone]').disabled, false, 'failure permits another action');
    w.document.body.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true }));
    assert.equal(panel.hidden, true, 'outside pointer closes the panel');
    const trigger = w.document.querySelector('[data-open-voip]');
    trigger.click();
    await new Promise((r) => setImmediate(r));
    trigger.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(panel.hidden, true);
    assert.equal(w.document.querySelector('dialog').open, true, 'Escape closes only the call panel');
    trigger.click();
    w.document.querySelector('dialog').dispatchEvent(new w.Event('cancel', { cancelable: true }));
    assert.equal(panel.hidden, true);
    assert.equal(
      w.document.querySelector('dialog').open,
      true,
      'native dialog cancel closes the nested panel first',
    );
  } finally {
    dom.window.close();
  }
});
test('live call workspace preserves typed notes across polling, then saves the chosen result after hangup', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<dialog id="borrowerDetail" open><button data-open-voip>☎ Ara</button></dialog>', {
    url: 'https://example.test',
    runScripts: 'dangerously',
  });
  const w = dom.window;
  let ended = false,
    draft,
    saved;
  const call = {
    id: 'live',
    documentId: 'd',
    userId: 'u',
    phone: '905320000000',
    status: 'answered',
    statusLabel: 'Görüşülüyor',
    staffName: 'Test',
    duration: 0,
  };
  const results = ['Olumlu', 'Olumsuz', 'Meşgul', 'Ulaşılamadı'];
  try {
    w.HTMLDialogElement.prototype.show = function () {
      this.open = true;
    };
    w.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
      this.dataset.modalPromoted = 'true';
    };
    Object.assign(w, {
      hanAuth: { id: 'u', role: 'staff' },
      esc: (v) => String(v).replaceAll('<', '&lt;'),
      fetch: async (url, options) => {
        const body = options.body && JSON.parse(options.body);
        if (url.endsWith('/draft')) draft = body.note;
        if (url.endsWith('/hangup')) ended = true;
        if (url.endsWith('/conversations')) saved = body;
        return {
          ok: true,
          json: async () =>
            url.includes('calls?')
              ? {
                  calls: [
                    {
                      ...call,
                      status: ended ? 'completed' : 'answered',
                      statusLabel: ended ? 'Görüşüldü' : 'Görüşülüyor',
                      duration: ended ? 34 : 0,
                    },
                  ],
                  results,
                }
              : { ok: true },
        };
      },
    });
    w.eval(
      (await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8')) +
        '\nvoipUi.results=' +
        JSON.stringify(results),
    );
    w.showVoipActive({ id: 'd' }, call);
    assert.equal(
      w.document.getElementById('voipActiveCall').dataset.modalPromoted,
      'true',
      'live controls escape borrower modal inertness before hangup',
    );
    const phone = w.document.createElement('dialog');
    phone.id = 'voipWebphone';
    phone.innerHTML = '<iframe></iframe>';
    w.document.getElementById('voipPhoneDock').append(phone);
    const textarea = w.document.querySelector('[data-current-form] textarea');
    textarea.value = 'Müşteri yarın dönüş yapacak.';
    textarea.dispatchEvent(new w.Event('input'));
    w.showVoipActive({ id: 'd' }, { ...call, duration: 10 });
    assert.equal(w.document.querySelector('textarea'), textarea, 'poll updates never replace the note input');
    assert.equal(textarea.value, 'Müşteri yarın dönüş yapacak.');
    w.document.querySelector('[data-current-minimize]').click();
    assert.equal(w.document.querySelector('#voipActiveCall').hidden, true);
    assert.equal(w.document.querySelector('[data-open-voip]').textContent, '☎ Sonlandır');
    assert.equal(w.document.querySelector('[data-current-hangup]').hidden, false);
    await new Promise((r) => setImmediate(r));
    assert.equal(draft, textarea.value);
    w.document.querySelector('[data-current-hangup]').click();
    await new Promise((r) => setImmediate(r));
    assert.equal(w.document.querySelector('[data-current-outcomes]').hidden, false);
    assert.equal(textarea.value, draft);
    assert.equal(
      w.document.getElementById('voipWebphone').style.visibility,
      'hidden',
      'ended call hides the web phone at once; its teardown waits so the result form stays fast',
    );
    assert.equal(
      w.document.getElementById('voipActiveCall').dataset.modalPromoted,
      'true',
      'result form escapes borrower modal inertness',
    );
    w.document.querySelector('[name="result"][value="Olumlu"]').checked = true;
    w.document
      .querySelector('form')
      .dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setImmediate(r));
    assert.equal(w.document.getElementById('voipActiveCall'), null, 'the result window closes at once');
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(saved.result, 'Olumlu');
    assert.equal(saved.note, draft);
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal(w.document.getElementById('voipWebphone'), null, 'ended call releases microphone iframe');
    w.showVoipActive({ id: 'd' }, { ...call, id: 'busy', status: 'busy', statusLabel: 'Meşgul' });
    assert.equal(w.document.querySelector('[name="result"]:checked').value, 'Meşgul');
  } finally {
    dom.window.close();
  }
});
test('recovering an active call never nests its controls inside the minimized webphone', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(
    '<div class="header-actions"></div><aside><nav></nav></aside><dialog class="voip-webphone" open style="visibility:hidden"></dialog>',
    { url: 'https://example.test', runScripts: 'dangerously' },
  );
  try {
    const w = dom.window;
    w.HTMLDialogElement.prototype.show = function () {
      this.open = true;
    };
    Object.assign(w, {
      hanAuth: { id: 'u', role: 'staff' },
      esc: String,
      fetch: async () => ({
        ok: true,
        json: async () => ({
          active: [
            {
              id: 'recovered',
              phone: '905320000000',
              status: 'ringing',
              statusLabel: 'Çalıyor',
              documentId: '',
            },
          ],
          results: [],
        }),
      }),
    });
    w.eval(await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8'));
    allowMicrophone(w);
    w.setupVoipNavigation();
    await new Promise(setImmediate);
    const host = w.document.querySelector('#voipActiveCall');
    assert.equal(host.parentElement.id, 'voipPhoneDock');
    assert.equal(host.hidden, false);
    host.querySelector('[data-current-minimize]').click();
    assert.equal(host.hidden, false);
    assert.equal(host.querySelector('[data-current-hangup]').hidden, false);
    host.querySelector('[data-current-minimize]').click();
    assert.equal(host.classList.contains('voip-call-minimized'), false);
  } finally {
    dom.window.close();
  }
});
test('recordings archive filters status and result, plays on demand and offers no result editing', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="content"></div>', {
    url: 'https://example.test',
    runScripts: 'dangerously',
  });
  const w = dom.window,
    requests = [];
  try {
    w.HTMLMediaElement.prototype.play = async function () {};
    w.HTMLMediaElement.prototype.pause = function () {};
    Object.assign(w, {
      hanAuth: { id: 'u', role: 'ceo' },
      $: (s) => w.document.querySelector(s),
      esc: (v) => String(v).replaceAll('<', '&lt;'),
      fetch: async (url, options) => {
        requests.push(url);
        if (url.endsWith('/transcriptions')) {
          const body = JSON.parse(options.body);
          assert.equal(body.mode, 'selected');
          assert.deepEqual(body.ids, ['c']);
          return { ok: true, json: async () => ({ queued: 0 }) };
        }
        if (url.includes('/transcript?id='))
          return {
            ok: true,
            json: async () => ({
              text: 'AI metni <script>alert(1)</script>',
              model: 'openai/gpt-transcribe',
              completedAt: '2026-11-09T10:00:00Z',
            }),
          };
        return {
          ok: true,
          json: async () =>
            url.endsWith('/recording')
              ? { url: '/api/voip/media?id=c' }
              : {
                  total: 1,
                  results: ['Olumlu', 'Olumsuz'],
                  calls: [
                    {
                      id: 'c',
                      documentId: 'd',
                      createdAt: '2026-11-09T10:00:00Z',
                      phone: '905320000000',
                      staffName: 'Ayşe',
                      status: 'completed',
                      statusLabel: 'Görüşüldü',
                      result: 'Olumlu',
                      duration: 50,
                      note: 'Görüşme notu',
                      recordingPresent: true,
                      archivedAt: '2026-11-09',
                      canListen: true,
                      providerEnd: { answered: true, talkSeconds: 50, by: 'callee', result: 'Cevaplandı' },
                      transcription: { status: 'completed' },
                    },
                  ],
                },
        };
      },
    });
    w.eval(await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8'));
    allowMicrophone(w);
    w.voipRecordingsPage();
    await new Promise((r) => setImmediate(r));
    // The recordings list shows what the exchange answered next to the status and the result.
    assert.match(
      w.document.querySelector('tr[data-voip-entry] .voip-provider-line').textContent,
      /Santral yanıtı: cevaplandı · konuşma 50 sn · sonuç Cevaplandı · kapatan aranan taraf/,
    );
    assert.equal(w.document.querySelectorAll('[data-voip-result]').length, 0);
    assert.equal(w.document.querySelectorAll('audio').length, 0);
    const form = w.document.querySelector('form');
    form.elements.status.value = 'completed';
    form.elements.result.value = 'Olumlu';
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setImmediate(r));
    assert.match(requests.at(-1), /status=completed/);
    assert.match(requests.at(-1), /result=Olumlu/);
    w.document.querySelector('[data-archive-sort-key="duration"]').click();
    await new Promise((r) => setImmediate(r));
    assert.match(requests.at(-1), /sort=duration&direction=desc/);
    assert.match(requests.at(-1), /status=completed/);
    assert.equal(w.document.querySelector('th[aria-sort]').getAttribute('aria-sort'), 'descending');
    w.document.querySelector('[data-archive-sort-key="duration"]').click();
    await new Promise((r) => setImmediate(r));
    assert.match(requests.at(-1), /direction=asc/);
    assert.equal(requests.filter((url) => url.includes('/transcript?id=')).length, 0);
    const details = w.document.querySelector('[data-voip-transcript]');
    details.open = true;
    details.dispatchEvent(new w.Event('toggle'));
    await new Promise((r) => setImmediate(r));
    assert.match(details.textContent, /AI metni/);
    assert.equal(w.document.querySelectorAll('script').length, 0);
    assert.match(w.document.querySelector('.voip-archive-notes').textContent, /Görüşme notu/);
    const checked = w.document.querySelector('[data-select-call]');
    checked.checked = true;
    checked.dispatchEvent(new w.Event('change'));
    w.document.querySelector('[data-transcribe-bulk]').click();
    await new Promise((r) => setImmediate(r));
    w.document.querySelector('[data-voip-listen]').click();
    await new Promise((r) => setImmediate(r));
    const audio = w.document.querySelector('[data-voip-player] audio');
    assert.equal(audio.preload, 'none');
    assert.match(audio.src, /media\?id=c/);
  } finally {
    dom.window.close();
  }
});
test('transcription queue filters records, preserves manual notes and encrypts separate AI text without repeat billing', async () => {
  const { createTranscription } = require('../lib/voip-transcription.cjs');
  const dir = path.resolve('work/transcription-test-' + crypto.randomUUID());
  const previous = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = 'synthetic-test-only';
  const store = createRecordingStore({ cloud: false, directory: dir });
  const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
  let state = {
    aiConfig: { provider: 'vercel-ai-gateway', enabled: true, transcriptionModel: 'openai/gpt-transcribe' },
    data: { 'icrapro-v1': { docs: [{ id: 'd', status: 'Derdest' }] } },
    voipCalls: ids.map((id, i) => ({
      id,
      documentId: 'd',
      createdAt: new Date().toISOString(),
      status: 'completed',
      result: i === 0 ? 'Olumlu' : 'Olumsuz',
      recordingPresent: true,
      archivedAt: i === 2 ? undefined : new Date().toISOString(),
      note: 'Personelin özgün notu',
    })),
  };
  let queue = Promise.resolve(),
    runs = 0;
  const jobs = [];
  const scoped = (work) => {
    const next = queue.then(() =>
      work(structuredClone(state), (next) => {
        state = next;
      }),
    );
    queue = next.catch(() => {});
    return next;
  };
  const service = createTranscription({
    scoped,
    recordings: store,
    background: (p) => jobs.push(p),
    transcriber: async (bytes) => {
      runs++;
      assert.equal(bytes.subarray(0, 3).toString(), 'ID3');
      return { text: 'Yalnızca AI transkriptinde bulunan metin.', language: 'tr' };
    },
  });
  try {
    for (const id of ids) await store.save(id, Buffer.from('ID3 synthetic audio'));
    assert.equal(
      (await service.enqueue({ mode: 'filtered', filters: { result: 'Olumlu' } }, { id: 'u' })).queued,
      1,
    );
    await Promise.all(jobs);
    assert.equal(runs, 1);
    assert.equal(state.voipCalls[0].note, 'Personelin özgün notu');
    const call = state.voipCalls[0];
    assert.equal(call.transcription.status, 'completed');
    assert.match((await service.read(call)).text, /AI transkriptinde/);
    const raw = await fs.readFile(path.join(dir, 'gorusme-kayitlari', call.transcription.objectId + '.enc'));
    assert(!raw.includes(Buffer.from('AI transkriptinde')));
    assert.equal((await service.enqueue({ mode: 'selected', ids: [ids[0]] }, { id: 'u' })).queued, 0);
    assert.equal((await service.enqueue({ mode: 'all' }, { id: 'u' })).queued, 2);
    await Promise.all(jobs);
    assert.equal(runs, 2);
    assert.equal(
      state.voipCalls[2].transcription.status,
      'queued',
      'unarchived audio waits without reaching the AI provider',
    );
    state.voipCalls[2].archivedAt = new Date().toISOString();
    await service.work();
    assert.equal(runs, 3);
    await assert.rejects(
      service.enqueue({ mode: 'filtered', filters: { status: 'FORGED' } }, { id: 'u' }),
      /filtreleri/,
    );
  } finally {
    if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previous;
    assert(dir.startsWith(path.resolve('work') + path.sep));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('large MP3 recordings split at frame boundaries without re-encoding; hot cache is bounded and Infaz bypasses it', async () => {
  const { chunks } = require('../lib/voip-transcription.cjs'),
    { createHotCache, isHot } = require('../lib/voip-hot-cache.cjs');
  const frame = Buffer.alloc(417);
  frame.set([255, 251, 144, 0]);
  const audio = Buffer.concat(Array.from({ length: 20 }, () => frame));
  const parts = chunks(audio, 1000);
  assert(parts.length > 1);
  assert.deepEqual(Buffer.concat(parts), audio);
  assert(parts.every((p) => p.length <= 1000));
  const dir = path.resolve('work/cache-test-' + crypto.randomUUID());
  try {
    const cache = createHotCache(dir, { maxBytes: 5, maxEntries: 1 });
    const one = crypto.randomUUID(),
      two = crypto.randomUUID();
    await cache.put(one, Buffer.from('1234'));
    await cache.put(two, Buffer.from('5678'));
    assert.equal(await cache.get(one), null);
    assert.equal((await cache.get(two)).toString(), '5678');
    await cache.drop(two);
    assert.equal(await cache.get(two), null);
    assert.equal(isHot({ createdAt: new Date().toISOString() }, 'Derdest'), true);
    assert.equal(isHot({ createdAt: new Date().toISOString() }, 'İnfaz'), false);
  } finally {
    assert(dir.startsWith(path.resolve('work') + path.sep));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('installed AI SDK uses the configured Gateway transcription model and uploads audio only to that provider', async () => {
  const { transcribe } = require('../lib/voip-transcription.cjs');
  let sent;
  const result = await transcribe(
    Buffer.from('ID3 synthetic'),
    { provider: 'vercel-ai-gateway', authorization: 'Bearer test-only', model: 'openai/gpt-transcribe' },
    {
      fetcher: async (url, options) => {
        sent = { url: String(url), body: JSON.parse(options.body) };
        return new Response(JSON.stringify({ text: 'Örnek AI metni', language: 'tr', segments: [] }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
      signal: AbortSignal.timeout(5000),
    },
  );
  assert.match(sent.url, /^https:\/\/ai-gateway\.vercel\.sh\//);
  assert.equal(Buffer.from(sent.body.audio, 'base64').toString(), 'ID3 synthetic');
  assert.equal(result.text, 'Örnek AI metni');
});

test('canceling an in-flight originate persists intent and hangs up as soon as the provider ID arrives', async () => {
  let release;
  const requests = [];
  const h = harness(async (url) => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path === '/originate')
      return await new Promise((resolve) => {
        release = () => resolve(new Response('00000000-0000-0000-0000-000000000001'));
      });
    return new Response('OK');
  });
  const input = { documentId: 'd', phone: '05320000000', requestId: 'cancel-during-start-001' };
  const starting = h.call('start', 'POST', input);
  while (!release) await new Promise(setImmediate);
  h.user = { id: 's', role: 'staff' };
  await assert.rejects(
    h.call('cancel-start', 'POST', { requestId: input.requestId }),
    (e) => e.status === 409,
  );
  h.user = { id: 'u', role: 'ceo' };
  await h.call('cancel-start', 'POST', { requestId: input.requestId });
  assert.equal(h.state.voipCalls[0].cancelRequested, true);
  release();
  const result = await starting;
  assert.equal(result.call.cancelRequested, true);
  assert(requests.includes('/hangup/00000000-0000-0000-0000-000000000001'));
  assert.equal(
    result.call.status,
    'ringing',
    'Wait for confirmed provider termination instead of inventing an ended state',
  );
});

test('cancel control is immediately visible while originate is pending', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(
    '<div class="shell"><header><div class="header-actions"></div></header></div><div id="area"><span id="slot"><button id="launch">Ara</button></span></div>',
    {
      url: 'https://example.test',
      runScripts: 'dangerously',
    },
  );
  try {
    const w = dom.window;
    let release,
      cancellations = 0;
    w.fetch = async (url) => {
      if (url.endsWith('/start'))
        return await new Promise((resolve) => {
          release = () =>
            resolve({ ok: true, json: async () => ({ call: { id: 'call', status: 'ringing' } }) });
        });
      cancellations++;
      return { ok: true, json: async () => ({ ok: true }) };
    };
    w.eval(await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8'));
    allowMicrophone(w);
    const pending = w.voipStartCancelable(
      { requestId: 'cancel-ui-start-001' },
      w.document.getElementById('area'),
      () => {},
      w.document.getElementById('launch'),
    );
    const button = w.document.querySelector('[data-cancel-starting]');
    assert(button && !button.disabled);
    assert.equal(button.parentElement.id, 'slot', 'cancel replaces Ara in its original cell');
    assert.equal(w.document.getElementById('launch'), null);
    await assert.rejects(
      w.voipStartCancelable({ requestId: 'second' }, w.document.getElementById('area'), () => {}),
    );
    const bar = w.document.getElementById('voipCallBar');
    assert(bar, 'call bar exists before originate completes');
    assert.equal(bar.parentElement.className, 'shell', 'the bar is part of the page shell');
    assert.equal(bar.nextElementSibling.tagName, 'HEADER', 'the bar sits above the app header');
    assert(w.document.body.classList.contains('voip-call-bar-open'));
    assert.match(bar.querySelector('[data-bar-status]').textContent, /Aranıyor/);
    assert.equal(bar.querySelector('[data-bar-mute]').hidden, true, 'no mute before a call exists');
    const globalHangup = bar.querySelector('[data-global-hangup]');
    assert(globalHangup, 'global hangup exists before originate completes');
    // Wait until the microphone check passed and the start request is with the switchboard.
    while (!release) await new Promise(setImmediate);
    globalHangup.click();
    await new Promise(setImmediate);
    assert.equal(cancellations, 1);
    assert.match(
      w.document.querySelector('.voip-cancel-wait').textContent,
      /Kapanana kadar lütfen bekleyiniz/,
    );
    assert.equal(globalHangup.disabled, true);
    assert.match(bar.querySelector('[data-bar-status]').textContent, /İptal ediliyor/);
    release();
    assert.equal((await pending).call.cancelRequested, true);
    assert.equal(w.document.querySelector('[data-cancel-starting]'), null);
    assert.equal(w.document.getElementById('voipCallBar'), null, 'the bar closes with the dial attempt');
    assert.equal(w.document.body.classList.contains('voip-call-bar-open'), false);
  } finally {
    dom.window.close();
  }
});

test('provider busy termination overrides an answered announcement and closes the active state', () => {
  const call = {
    status: 'answered',
    createdAt: new Date().toISOString(),
    answeredAt: new Date().toISOString(),
  };
  updateEvent(call, {
    event_type: 'hangup',
    answered: true,
    failure_status: '486',
    hangup_cause: 'USER_BUSY',
    duration: 0,
  });
  assert.equal(call.status, 'busy');
  assert(call.endedAt);
});

test('borrower calling initializes the shared background webphone without requiring standalone dialing', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(
    '<dialog open><div class="sheet-header-actions"></div><section data-borrower-panel="conversations"></section></dialog>',
    {
      url: 'https://example.test',
      runScripts: 'dangerously',
    },
  );
  try {
    const w = dom.window;
    let tokens = 0;
    w.HTMLDialogElement.prototype.show = function () {
      this.open = true;
    };
    Object.assign(w, {
      hanAuth: { id: 'u', role: 'ceo' },
      esc: String,
      fetch: async (url) => ({
        ok: true,
        json: async () => {
          if (url.endsWith('/webphone')) {
            tokens++;
            return { url: 'https://example.test/webphone?token=test' };
          }
          return {
            webphone: true,
            enabled: true,
            extension: '1001',
            phones: [],
            calls: [],
            active: [],
            results: [],
          };
        },
      }),
    });
    w.eval(await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8'));
    allowMicrophone(w);
    w.setupBorrowerVoip(w.document.querySelector('dialog'), { id: 'd' });
    w.document.querySelector('[data-open-voip]').click();
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    assert.equal(tokens, 1);
    const frame = w.document.querySelector('#voipWebphone iframe');
    assert(frame);
    assert.equal(w.document.getElementById('voipPhoneDock').hidden, true);
    assert.equal(w.document.querySelector('[data-open-webphone]'), null);
    w.document.querySelector('[data-open-voip]').click();
    w.document.querySelector('[data-open-voip]').click();
    await new Promise(setImmediate);
    assert.equal(tokens, 1);
    assert.equal(w.document.querySelector('#voipWebphone iframe'), frame);
    w.document.getElementById('voipWebphone').remove();
    w.document.querySelector('[data-open-voip]').click();
    w.document.querySelector('[data-open-voip]').click();
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    assert.equal(tokens, 2, 'removed phone reconnects instead of reusing a completed initialization');
  } finally {
    dom.window.close();
  }
});

test('confirmed automatically saved busy calls close without a second evaluation', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('', { url: 'https://example.test', runScripts: 'dangerously' });
  try {
    const w = dom.window;
    w.HTMLDialogElement.prototype.show = function () {
      this.open = true;
    };
    Object.assign(w, { esc: String });
    w.eval(
      (await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8')) +
        '\nvoipUi.returnToDial = () => { window.returnedToDial = true; };',
    );
    const phone = w.document.createElement('dialog');
    phone.id = 'voipWebphone';
    phone.innerHTML = '<iframe></iframe>';
    w.document.body.append(phone);
    const call = {
      id: 'busy-auto',
      phone: '905320000000',
      status: 'ringing',
      createdAt: new Date().toISOString(),
    };
    w.showVoipActive({}, call);
    assert(w.document.getElementById('voipActiveCall'));
    assert(w.document.getElementById('voipCallBar'), 'the bar shows while the call rings');
    w.showVoipActive(
      {},
      {
        ...call,
        status: 'busy',
        result: 'Meşgul',
        resultAt: new Date().toISOString(),
        duration: 0,
      },
    );
    assert.equal(w.document.getElementById('voipActiveCall'), null);
    assert.equal(w.document.getElementById('voipCallBar'), null, 'busy closes the bar without a prompt');
    assert.equal(w.returnedToDial, true, 'busy returns to the originating dial screen');
    assert(w.document.querySelector('#voipWebphone iframe'), 'busy preserves registered webphone');
    assert.equal(w.document.getElementById('voipPhoneDock').hidden, true);
  } finally {
    dom.window.close();
  }
});

test('server recovery requires its job credential and only closes a canceled call from completed CDR evidence', async () => {
  const prior = process.env.VOIP_CRON_SECRET;
  process.env.VOIP_CRON_SECRET = 'test-recovery-secret';
  try {
    let done = false;
    const paths = [];
    const h = harness(async (url) => {
      const p = new URL(url).pathname;
      paths.push(p);
      if (p.startsWith('/hangup/')) return new Response('OK');
      return new Response(
        JSON.stringify({
          cdr: {
            end_stamp: done ? '2026-11-10 19:43:00 +0300' : null,
            answer_stamp: null,
            talk_duration: '00:00:00',
            recording_present: false,
          },
        }),
      );
    });
    h.state.voipCalls.push({
      id: 'recovery-call',
      providerId: 'provider-call',
      userId: 'u',
      status: 'ringing',
      cancelRequested: true,
      createdAt: new Date().toISOString(),
      phone: '905320000000',
    });
    await assert.rejects(h.call('recover-call', 'POST', { id: 'recovery-call' }), (e) => e.status === 401);
    const headers = { authorization: 'Bearer test-recovery-secret' };
    await assert.rejects(
      h.call('recover-call', 'POST', { id: 'recovery-call' }, false, headers),
      (e) => e.status === 409,
    );
    assert.equal(h.state.voipCalls[0].status, 'ringing');
    assert(paths.includes('/hangup/provider-call'));
    done = true;
    assert.equal(
      (await h.call('recover-call', 'POST', { id: 'recovery-call' }, false, headers)).confirmed,
      true,
    );
    assert.equal(h.state.voipCalls[0].status, 'unanswered');
  } finally {
    if (prior === undefined) delete process.env.VOIP_CRON_SECRET;
    else process.env.VOIP_CRON_SECRET = prior;
  }
});

test('canceled call recovery clears active state only on explicit provider channel-absent evidence', async () => {
  const previous = process.env.VOIP_CRON_SECRET;
  process.env.VOIP_CRON_SECRET = 'recovery-test-secret';
  try {
    let absent = false;
    const h = harness(
      async (url) =>
        new Response(
          new URL(url).pathname.startsWith('/hangup/') && absent
            ? 'No such channel!'
            : 'Unknown provider error',
          { status: 400 },
        ),
    );
    h.state.voipCalls.push({
      id: 'recover-absent',
      providerId: 'provider-id',
      userId: 'u',
      cancelRequested: true,
      status: 'ringing',
      createdAt: new Date().toISOString(),
      draftNote: 'Korunacak not',
      phone: '905320000000',
    });
    const headers = { authorization: 'Bearer recovery-test-secret' };
    await assert.rejects(h.call('recover-call', 'POST', { id: 'recover-absent' }, false, headers));
    assert.equal(h.state.voipCalls[0].status, 'unknown');
    absent = true;
    const result = await h.call('recover-call', 'POST', { id: 'recover-absent' }, false, headers);
    assert.equal(result.confirmed, true);
    assert.equal(result.detailsPending, true);
    const saved = h.state.voipCalls[0];
    assert.equal(saved.status, 'failed');
    assert.equal(saved.endSource, 'provider-channel-missing');
    assert.equal(saved.endedAt, undefined, 'Do not invent a provider end time');
    assert.equal(saved.endDetailsPending, true);
    assert.match(saved.note, /Korunacak not/);
    assert(saved.closedConfirmedAt);
    assert.equal((await h.call('calls?phone=05320000000')).active.length, 0);
  } finally {
    if (previous === undefined) delete process.env.VOIP_CRON_SECRET;
    else process.env.VOIP_CRON_SECRET = previous;
  }
});

test('watchdog closes only stale browser calls and retains provider uncertainty', async () => {
  process.env.VOIP_CRON_SECRET = 'watchdog-test';
  const h = harness(async (url) => {
    if (new URL(url).pathname.startsWith('/hangup/'))
      return new Response('No such channel!', { status: 400 });
    return new Response('{}');
  });
  const old = new Date(Date.now() - 180000).toISOString();
  h.state.voipCalls.push(
    {
      id: 'stale-web',
      userId: 'u',
      status: 'ringing',
      providerId: 'web',
      browserManaged: true,
      browserSeenAt: old,
      createdAt: old,
      draftNote: 'Notum',
    },
    {
      id: 'fresh-web',
      userId: 'u',
      status: 'answered',
      providerId: 'fresh',
      browserManaged: true,
      browserSeenAt: new Date().toISOString(),
      createdAt: old,
    },
    { id: 'mobile', userId: 'u', status: 'answered', providerId: 'mobile', createdAt: old },
  );
  await assert.rejects(h.call('watchdog'), (e) => e.status === 401);
  await h.call('watchdog', 'GET', undefined, false, { authorization: 'Bearer watchdog-test' });
  assert.equal(h.state.voipCalls[0].status, 'failed');
  assert.match(h.state.voipCalls[0].note, /Notum/);
  assert.equal(h.state.voipCalls[0].endedAt, undefined);
  assert.equal(h.state.voipCalls[1].status, 'answered');
  assert.equal(h.state.voipCalls[2].status, 'answered');
  delete process.env.VOIP_CRON_SECRET;
});

test('heartbeat renews only owner browser call and watchdog retries provider errors', async () => {
  process.env.VOIP_CRON_SECRET = 'watchdog-test';
  const h = harness(async () => new Response('error', { status: 400 }));
  const old = new Date(Date.now() - 180000).toISOString();
  h.state.voipCalls.push({
    id: 'browser',
    userId: 'u',
    status: 'ringing',
    providerId: 'web',
    browserManaged: true,
    browserSeenAt: old,
    createdAt: old,
  });
  h.user = { id: 's', role: 'staff' };
  await assert.rejects(h.call('heartbeat', 'POST', { id: 'browser' }), (e) => e.status === 403);
  h.user = { id: 'u', role: 'ceo' };
  await h.call('heartbeat', 'POST', { id: 'browser' });
  assert(Date.parse(h.state.voipCalls[0].browserSeenAt) > Date.parse(old));
  h.state.voipCalls[0].browserSeenAt = old;
  await h.call('watchdog', 'GET', undefined, false, { authorization: 'Bearer watchdog-test' });
  assert.equal(h.state.voipCalls[0].status, 'unknown');
  assert.equal(h.state.voipCalls[0].endedAt, undefined);
  delete process.env.VOIP_CRON_SECRET;
});

test('closing standalone dialer releases phone and ignores a late webphone token', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('', { url: 'https://example.test', runScripts: 'dangerously' });
  const w = dom.window;
  let resolveToken;
  try {
    w.HTMLDialogElement.prototype.show = function () {
      this.open = true;
    };
    w.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    Object.assign(w, {
      esc: String,
      fetch: () =>
        new Promise((resolve) => {
          resolveToken = resolve;
        }),
    });
    w.eval(await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8'));
    allowMicrophone(w);
    w.openStandaloneVoip();
    w.document.querySelector('#voipStandalone [data-close]').click();
    resolveToken({ ok: true, json: async () => ({ url: 'https://example.test/phone' }) });
    await new Promise(setImmediate);
    assert.equal(w.document.querySelector('#voipWebphone iframe'), null);
  } finally {
    dom.window.close();
  }
});

test('late hangup does not overwrite a provider-confirmed busy result', () => {
  const call = { status: 'ringing', createdAt: new Date().toISOString() };
  updateEvent(call, { event_type: 'hangup', failure_status: '486', answered: false });
  updateEvent(call, { event_type: 'hangup', answered: true, duration: 0 });
  assert.equal(call.status, 'busy');
  assert.equal(call.result, 'Meşgul');
});

test('outbound caller numbers receive stable line numbers and reject internal/destination numbers', () => {
  const config = {};
  const a = {},
    b = {},
    c = {};
  updateEvent(
    a,
    { event_type: 'ringing', direction: 'outbound', outbound_caller_id_number: '02161234567' },
    config,
  );
  updateEvent(
    b,
    { event_type: 'ringing', direction: 'outbound', outbound_caller_id_number: '+90 216 234 56 78' },
    config,
  );
  updateEvent(
    c,
    { event_type: 'ringing', direction: 'outbound', outbound_caller_id_number: '902161234567' },
    config,
  );
  assert.equal(a.outboundLine, 1);
  assert.equal(b.outboundLine, 2);
  assert.equal(c.outboundLine, 1);
  assert.equal(a.outboundNumber, '902161234567');
  const invalid = {};
  updateEvent(
    invalid,
    { event_type: 'ringing', outbound_caller_id_number: '1001', destination_number: '905321234567' },
    config,
  );
  assert.equal(invalid.outboundNumber, undefined);
  const inbound = {};
  updateEvent(
    inbound,
    { event_type: 'ringing', direction: 'inbound', outbound_caller_id_number: '902161234567' },
    config,
  );
  assert.equal(inbound.outboundLine, undefined);
});

test('unanswered call saves its outcome automatically and preserves live note', () => {
  const call = {
    status: 'ringing',
    draftNote: 'Sonra tekrar kontrol et',
    createdAt: new Date().toISOString(),
  };
  updateEvent(call, { event_type: 'hangup', answered: false, hangup_cause: 'NO_ANSWER' });
  assert.equal(call.result, 'Ulaşılamadı');
  assert.equal(call.resultBy, 'Santral');
  assert(call.resultAt);
  assert.match(call.note, /Sonra tekrar kontrol et/);
  assert.equal(call.draftNote, undefined);
});

// Browser harness shared by the call bar tests: dialog methods behave like a modal-capable browser.
async function callBarWindow(extra = {}) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(
    '<div class="shell"><header><div class="header-actions"></div></header><main id="content">Sayfa</main></div><dialog id="borrowerDetail" open><button data-open-voip>☎ Ara</button></dialog>',
    { url: 'https://example.test', runScripts: 'dangerously' },
  );
  const w = dom.window;
  const calls = [];
  w.HTMLDialogElement.prototype.show = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  Object.assign(w, {
    hanAuth: { id: 'u', role: 'staff' },
    esc: (v) => String(v).replaceAll('<', '&lt;'),
    fetch: async (url, options = {}) => {
      const body = options.body && JSON.parse(options.body);
      calls.push({ url: url.replace(/^\/api\/voip\//, ''), body });
      if (extra.fetch) return extra.fetch(url, body);
      return {
        ok: true,
        json: async () =>
          url.endsWith('/mute')
            ? { muted: body.muted }
            : url.includes('calls?')
              ? { calls: [], results: ['Olumlu'] }
              : { ok: true },
      };
    },
  });
  // Top-level const values stay local to eval, so hand the UI state to the test explicitly.
  w.eval(
    (await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8')) + '\nwindow.voipUiForTest = voipUi;',
  );
  allowMicrophone(w);
  return { dom, w, calls };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const ui = (w) => w.voipUiForTest;

test('call bar follows an active call on every screen and controls it while the call window is hidden', async () => {
  const { dom, w, calls } = await callBarWindow();
  try {
    const call = {
      id: 'bar-call',
      documentId: 'd',
      documentNumber: 'E-12',
      phone: '905320000000',
      status: 'ringing',
      statusLabel: 'Çalıyor',
      createdAt: new Date(Date.now() - 65000).toISOString(),
      outboundLine: 2,
      outboundNumber: '908501234567',
    };
    w.showVoipActive({ id: 'd', number: 'E-12', debtor: 'Ayşe Yılmaz' }, call);
    const bar = w.document.getElementById('voipCallBar');
    const field = (name) => bar.querySelector('[data-bar-' + name + ']');
    assert(bar, 'the bar opens with the call');
    assert.equal(bar.parentElement.className, 'shell');
    assert.equal(bar.parentElement.firstElementChild, bar, 'above the header, at the very top of the shell');
    assert.equal(field('name').textContent, 'Ayşe Yılmaz');
    assert.equal(field('avatar').textContent, 'AY');
    assert.match(field('detail').textContent, /0 \(532\) 000 00 00 · Föy E-12/);
    assert.equal(field('status').textContent, 'Çalıyor');
    assert.equal(bar.dataset.phase, 'ringing');
    assert.match(field('time').textContent, /^01:0\d$/, 'timer counts from the dial moment');
    assert.match(field('line').textContent, /2\. hat/);

    // Changing menus or scrolling replaces page content only; the bar belongs to the shell.
    w.document.getElementById('content').innerHTML = '<p>Başka menü</p>';
    assert.equal(w.document.getElementById('voipCallBar'), bar);

    // The provider answers: the same bar reflects it.
    ui(w).updateActive({ ...call, status: 'answered', statusLabel: 'Görüşülüyor' });
    assert.equal(bar.dataset.phase, 'answered');
    assert.equal(field('status').textContent, 'Görüşülüyor');

    // Muting from the bar goes through the confirmed provider call and mirrors on both controls.
    const mute = bar.querySelector('[data-bar-mute]');
    assert.equal(mute.hidden, false);
    mute.click();
    assert.equal(mute.disabled, true, 'busy while the provider confirms');
    await settle();
    assert(calls.some((entry) => entry.url === 'mute' && entry.body.muted === true));
    assert.equal(mute.disabled, false);
    assert.equal(mute.getAttribute('aria-pressed'), 'true');
    assert.equal(w.document.querySelector('[data-current-mute]').getAttribute('aria-pressed'), 'true');

    // Minimize hides the call window; the bar stays and can reopen it.
    w.document.querySelector('[data-current-minimize]').click();
    const host = w.document.getElementById('voipActiveCall');
    assert.equal(host.hidden, true);
    assert.equal(w.document.getElementById('voipCallBar'), bar, 'minimizing never removes the bar');
    bar.querySelector('[data-bar-open]').click();
    assert.equal(host.hidden, false);
    assert.equal(host.open, true);
    assert.equal(ui(w).minimized, false);
    assert.equal(w.document.activeElement, host.querySelector('textarea'), 'notes receive focus');

    // Hang up from the bar while the window is minimized again.
    w.document.querySelector('[data-current-minimize]').click();
    assert.equal(host.hidden, true);
    bar.querySelector('[data-global-hangup]').click();
    await settle();
    assert(calls.some((entry) => entry.url === 'hangup' && entry.body.id === 'bar-call'));
    assert.equal(field('status').textContent, 'Sonlandırılıyor…');
    assert.equal(bar.dataset.phase, 'ending');
    assert.equal(bar.querySelector('[data-global-hangup]').disabled, true);

    // The provider confirms termination: the bar goes away and the result form takes over.
    ui(w).updateActive({ ...call, status: 'completed', statusLabel: 'Görüşüldü', duration: 34 });
    assert.equal(w.document.getElementById('voipCallBar'), null);
    assert.equal(w.document.body.classList.contains('voip-call-bar-open'), false);
    assert.equal(host.querySelector('[data-current-outcomes]').hidden, false);
  } finally {
    dom.window.close();
  }
});

test('call bar closes without a prompt for busy and unreachable calls and survives a rejected second dial', async () => {
  const { dom, w } = await callBarWindow({
    fetch: async (url) =>
      url.endsWith('/start')
        ? { ok: false, status: 409, json: async () => ({ error: 'Zaten etkin bir aramanız var.' }) }
        : { ok: true, json: async () => ({ ok: true }) },
  });
  try {
    const call = { id: 'a', phone: '905320000000', status: 'ringing', createdAt: new Date().toISOString() };
    w.showVoipActive({}, call);
    const bar = w.document.getElementById('voipCallBar');
    assert(bar);
    // A second, rejected dial attempt must neither replace nor close the running call's bar.
    await assert.rejects(
      w.voipStartCancelable(
        { requestId: 'second-dial-0001', phone: '905321111111' },
        w.document.body,
        () => {},
      ),
      /etkin bir aramanız var/,
    );
    assert.equal(w.document.getElementById('voipCallBar'), bar);
    assert.match(bar.querySelector('[data-bar-name]').textContent, /0 \(532\) 000 00 00/);
    assert.equal(bar.querySelector('[data-global-hangup]').hidden, false);

    // Unreachable: the exchange reports the result itself, so no result form is shown.
    ui(w).updateActive({
      ...call,
      status: 'unanswered',
      result: 'Ulaşılamadı',
      resultBy: 'Santral',
      resultAt: new Date().toISOString(),
      duration: 0,
    });
    assert.equal(w.document.getElementById('voipCallBar'), null);
    assert.equal(
      w.document.getElementById('voipActiveCall'),
      null,
      'no "choose a result and press OK" window',
    );
    assert.equal(w.document.body.classList.contains('voip-call-bar-open'), false);
  } finally {
    dom.window.close();
  }
});

test('call bar writes names, details and statuses as text only', async () => {
  const { dom, w } = await callBarWindow({
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  });
  try {
    w.voipStartCancelable(
      { requestId: 'xss-dial-0001', phone: '905320000000' },
      w.document.body,
      () => {},
      null,
      { name: '<img src=x onerror="window.hacked=1">', detail: '<script>window.hacked=2</script>' },
    ).catch(() => {});
    const bar = w.document.getElementById('voipCallBar');
    assert(bar);
    assert.equal(bar.querySelector('[data-bar-name]').textContent, '<img src=x onerror="window.hacked=1">');
    assert.match(bar.querySelector('[data-bar-detail]').textContent, /<script>/);
    assert.equal(bar.querySelectorAll('img, script').length, 0);
    assert.equal(w.hacked, undefined);
    assert.match(
      bar.querySelector('[data-bar-avatar]').textContent,
      /^[\p{L}☎]{1,2}$/u,
      'plain letters only',
    );
  } finally {
    dom.window.close();
  }
});

test('call bar stays pinned at the top while the page scrolls and keeps the header below it', async () => {
  const css = await fs.readFile('outputs/icrapro/voip.css', 'utf8');
  const rule = (selector) =>
    css.match(
      new RegExp('(?:^|\\n)' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'),
    )?.[1];
  assert.match(rule('.voip-call-bar'), /position:\s*sticky/);
  assert.match(rule('.voip-call-bar'), /top:\s*0/);
  assert.match(rule('.voip-call-bar'), /height:\s*var\(--voip-bar-h\)/);
  assert.match(rule('body.voip-call-bar-open .shell > header'), /top:\s*var\(--voip-bar-h\)/);
  assert.match(rule('body.voip-call-bar-open'), /--voip-bar-h:\s*58px/);
  assert.match(rule(':root'), /--voip-bar-h:\s*0px/);
});

test('a leg that connected for zero seconds is no conversation: unreachable is saved without asking', () => {
  const base = () => ({ status: 'ringing', createdAt: new Date().toISOString() });
  const silent = base();
  updateEvent(silent, {
    event_type: 'hangup',
    answered: true,
    duration: 0,
    hangup_cause: 'NORMAL_CLEARING',
  });
  assert.equal(silent.status, 'unanswered', 'never "Görüşüldü" for a zero-second call');
  assert.equal(silent.result, 'Ulaşılamadı');
  assert.equal(silent.resultBy, 'Santral');
  assert(silent.resultAt);
  assert.equal(silent.note, 'Ulaşılamadı (santral bildirimi).');
  assert.deepEqual(silent.providerEnd, {
    answered: true,
    talkSeconds: 0,
    cause: 'NORMAL_CLEARING',
    reason: 'Cevaplandı',
  });

  // Form-encoded webhooks send every value as a string.
  const form = base();
  updateEvent(form, { event_type: 'hangup', answered: 'true', duration: '0', failure_status: '480' });
  assert.equal(form.status, 'unanswered');
  assert.equal(form.providerEnd.code, '480');

  // The person ended it themselves before anyone talked: their live note is kept and the reason is said.
  const own = { ...base(), hangupRequestedAt: new Date().toISOString(), draftNote: 'Yazılmış not' };
  updateEvent(own, { event_type: 'hangup', answered: true, duration: 0 });
  assert.equal(own.status, 'unanswered');
  assert.match(own.note, /^Yazılmış not\nUlaşılamadı: arama görüşme olmadan sonlandırıldı/);

  // Only an explicit zero counts: a missing or empty duration, or a real one, stays a conversation.
  for (const event of [
    { answered: true },
    { answered: true, duration: '' },
    { answered: true, duration: null },
    { answered: true, duration: 34 },
  ]) {
    const call = base();
    updateEvent(call, { event_type: 'hangup', ...event });
    assert.equal(call.status, 'completed', JSON.stringify(event));
    assert.equal(call.result, undefined, 'the person still chooses the result');
  }

  // Late or repeated events never downgrade a recorded conversation or replace a saved result.
  const talked = { ...base(), duration: 34 };
  updateEvent(talked, { event_type: 'hangup', answered: true, duration: 0 });
  assert.equal(talked.status, 'completed');
  assert.equal(talked.duration, 34);
  const saved = { ...base(), resultAt: '2026-11-10T10:00:00.000Z', result: 'Olumlu', resultBy: 'Personel' };
  updateEvent(saved, { event_type: 'hangup', answered: true, duration: 0 });
  assert.equal(saved.status, 'completed');
  assert.equal(saved.result, 'Olumlu');

  // Hostile or oversized provider text is never stored.
  const odd = base();
  updateEvent(odd, {
    event_type: 'hangup',
    answered: false,
    hangup_cause: '<script>alert(1)</script>',
    failure_status: 'x'.repeat(200),
  });
  assert.deepEqual(odd.providerEnd, { answered: false });
});

test('webhook and call-record checks save zero-talk calls as unreachable and remember who hung up', async () => {
  const webhook = harness(async () => new Response('00000000-0000-0000-0000-000000000001'));
  await webhook.call('start', 'POST', {
    documentId: 'd',
    phone: '05320000000',
    requestId: 'zero-talk-hook-01',
  });
  await webhook.call(
    'webhook?token=' + webhook.state.voipConfig.webhookSecret,
    'POST',
    {
      domain_id: '123',
      call_uuid: '00000000-0000-0000-0000-000000000001',
      event_type: 'hangup',
      answered: 'true',
      duration: '0',
      recording_present: 'false',
    },
    true,
  );
  const hooked = webhook.state.voipCalls[0];
  assert.equal(hooked.status, 'unanswered');
  assert.equal(hooked.result, 'Ulaşılamadı');
  assert.equal(hooked.resultBy, 'Santral');
  assert.equal(hooked.note, 'Ulaşılamadı (santral bildirimi).');

  const closedByRecord = async (cdr, requestId) => {
    const h = harness(async (url) => {
      const path = new URL(url).pathname;
      if (path === '/originate') return new Response('00000000-0000-0000-0000-000000000001');
      if (path.startsWith('/hangup/')) return new Response('No such channel!', { status: 400 });
      return new Response(
        JSON.stringify({
          cdr: {
            end_stamp: '2026-11-10 18:00:00 +0300',
            answer_stamp: '2026-11-10 17:59:48 +0300',
            recording_present: false,
            ...cdr,
          },
        }),
      );
    });
    const { call } = await h.call('start', 'POST', { documentId: 'd', phone: '05320000000', requestId });
    await h.call('hangup', 'POST', { id: call.id });
    return h.state.voipCalls[0];
  };
  const none = await closedByRecord(
    { talk_duration: '00:00:00', hangup_cause: 'NORMAL_CLEARING' },
    'zero-talk-cdr-0001',
  );
  assert.equal(none.status, 'unanswered');
  assert.equal(none.result, 'Ulaşılamadı');
  assert(none.hangupRequestedAt, 'pressing Sonlandır is remembered');
  assert.match(none.note, /görüşme olmadan sonlandırıldı/);
  assert.deepEqual(none.providerEnd, {
    answered: true,
    talkSeconds: 0,
    cause: 'NORMAL_CLEARING',
    reason: 'Cevaplandı',
  });

  const unknown = await closedByRecord({}, 'zero-talk-cdr-0002');
  assert.equal(unknown.status, 'completed', 'a record without talk time is not treated as zero');
  assert.equal(unknown.result || '', '', 'the person still chooses the result');
  const spoken = await closedByRecord({ talk_duration: '00:00:12' }, 'zero-talk-cdr-0003');
  assert.equal(spoken.status, 'completed');
  assert.equal(spoken.duration, 12);
});

test('call history shows what the exchange reported and escapes it', async () => {
  const { dom, w } = await callBarWindow();
  try {
    const call = {
      id: 'history-call',
      documentId: 'd',
      userId: 'u',
      phone: '905320000000',
      staffName: 'Personel',
      status: 'unanswered',
      statusLabel: 'Ulaşılamadı',
      createdAt: new Date().toISOString(),
      duration: 0,
      result: 'Ulaşılamadı',
      hangupRequestedAt: new Date().toISOString(),
      providerEnd: { answered: true, talkSeconds: 0, cause: 'NORMAL_CLEARING', code: '480' },
    };
    const html = w.voipCallMarkup(call, ['Olumlu']);
    assert.match(
      html,
      /Santral yanıtı: cevaplandı · konuşma 0 sn · neden NORMAL_CLEARING · kod 480 · siz sonlandırdınız/,
    );
    assert.equal(
      w.voipCallMarkup({ ...call, providerEnd: undefined }, ['Olumlu']).includes('Santral yanıtı'),
      false,
    );
    const hostile = w.voipCallMarkup({ ...call, providerEnd: { cause: '<img src=x>' } }, ['Olumlu']);
    assert.equal(hostile.includes('<img'), false);
  } finally {
    dom.window.close();
  }
});

test('"Numara ara" opens its frame right below the header button; other calls keep the corner', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div class="shell"><header><div class="header-actions"></div></header></div>', {
    url: 'https://example.test',
    runScripts: 'dangerously',
  });
  try {
    const w = dom.window;
    w.HTMLDialogElement.prototype.show = function () {
      this.open = true;
    };
    w.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    Object.assign(w, {
      hanAuth: { id: 'u', role: 'staff' },
      esc: String,
      fetch: async () => ({ ok: true, json: async () => ({ url: 'https://example.test/webphone?token=x' }) }),
    });
    const width = (value) =>
      Object.defineProperty(w, 'innerWidth', { value, configurable: true, writable: true });
    w.eval(await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8'));
    allowMicrophone(w);
    // The real header button, created by the app, passes itself as the anchor when clicked.
    w.setupVoipNavigation();
    const button = w.document.querySelector('[data-standalone-voip]');
    assert(button, 'the header button exists');
    const place = (right) => {
      button.getBoundingClientRect = () => ({
        left: right - 180,
        right,
        top: 8,
        bottom: 52,
        width: 180,
        height: 44,
      });
    };
    width(1400);
    place(1180);
    button.click();
    const dock = w.document.getElementById('voipPhoneDock');
    assert.equal(dock.hidden, false);
    assert.equal(dock.dataset.anchored, 'header');
    // Eight pixels below the button, its right edge aligned with the button's right edge.
    assert.deepEqual(
      ['top', 'left', 'right', 'bottom', 'width'].map((side) => dock.style[side]),
      ['60px', '720px', 'auto', 'auto', '460px'],
    );
    assert.equal(w.document.getElementById('voipStandalone').parentElement, dock);

    // A narrow window keeps the frame inside the viewport.
    width(700);
    place(400);
    w.dispatchEvent(new w.Event('resize'));
    assert.deepEqual(
      ['top', 'left', 'width'].map((side) => dock.style[side]),
      ['60px', '12px', '460px'],
    );
    width(360);
    place(340);
    w.dispatchEvent(new w.Event('resize'));
    assert.deepEqual(
      ['left', 'width'].map((side) => dock.style[side]),
      ['12px', '336px'],
    );

    // Closing hides the frame; any other call opens it in the default bottom-right corner again.
    w.document.querySelector('#voipStandalone [data-close]').click();
    assert.equal(dock.hidden, true);
    w.voipPhoneDock();
    assert.equal(dock.hidden, false);
    assert.equal(dock.dataset.anchored, undefined);
    assert.deepEqual(
      ['top', 'left', 'right', 'bottom', 'width', 'maxHeight'].map((side) => dock.style[side]),
      ['', '', '', '', '', ''],
    );

    // Opening it again from the header anchors it again, even after another call placed it.
    place(1180);
    width(1400);
    button.click();
    assert.equal(dock.style.top, '60px');
    assert.equal(dock.style.left, '720px');
  } finally {
    dom.window.close();
  }
});

test('"Vazgeçildi", "Cevapsız" or "Reddedildi" is no conversation, even though the extension answered', () => {
  const base = () => ({ status: 'ringing', createdAt: new Date().toISOString() });
  // The exchange connects the extension first, so "answered" is true while the customer's phone rings.
  const cases = [
    [
      'ORIGINATOR_CANCEL',
      'Vazgeçildi',
      'Ulaşılamadı: arama görüşme olmadan sonlandırıldı (santral bildirimi).',
    ],
    ['NO_ANSWER', 'Cevapsız', 'Ulaşılamadı: arama cevaplanmadı (santral bildirimi).'],
    ['ALLOTTED_TIMEOUT', 'Cevapsız', 'Ulaşılamadı: arama cevaplanmadı (santral bildirimi).'],
    ['NO_USER_RESPONSE', 'Ulaşılamıyor', 'Ulaşılamadı: arama cevaplanmadı (santral bildirimi).'],
    ['RECOVERY_ON_TIMER_EXPIRE', 'Zamanaşımı', 'Ulaşılamadı: arama cevaplanmadı (santral bildirimi).'],
    ['CALL_REJECTED', 'Reddedildi', 'Ulaşılamadı: arama reddedildi (santral bildirimi).'],
  ];
  for (const [cause, reason, note] of cases) {
    const call = base();
    updateEvent(call, { event_type: 'hangup', answered: true, hangup_cause: cause });
    assert.equal(call.status, 'unanswered', cause);
    assert.equal(call.result, 'Ulaşılamadı', cause);
    assert.equal(call.resultBy, 'Santral', cause);
    assert.equal(call.note, note, cause);
    assert.deepEqual(call.providerEnd, { answered: true, cause, reason }, cause);
  }

  // A busy line stays "Meşgul".
  const busy = base();
  updateEvent(busy, { event_type: 'hangup', answered: true, hangup_cause: 'USER_BUSY' });
  assert.equal(busy.status, 'busy');
  assert.equal(busy.result, 'Meşgul');
  assert.equal(busy.note, 'Meşgul (santral bildirimi).');

  // The call record words the same outcomes in Turkish.
  const worded = base();
  updateEvent(worded, { event_type: 'hangup', answered: true, result: 'Vazgeçildi' });
  assert.equal(worded.status, 'unanswered');
  assert.equal(worded.providerEnd.result, 'Vazgeçildi', 'Turkish letters are kept');

  // A normal ending alone decides nothing: the person still chooses the result.
  for (const event of [
    { hangup_cause: 'NORMAL_CLEARING' },
    { hangup_cause: 'NORMAL_UNSPECIFIED' },
    { result: 'Cevaplandı' },
    { hangup_cause: 'constructor', result: '__proto__' },
  ]) {
    const call = base();
    updateEvent(call, { event_type: 'hangup', answered: true, ...event });
    assert.equal(call.status, 'completed', JSON.stringify(event));
    assert.equal(call.result, undefined, JSON.stringify(event));
  }

  // A real conversation is never downgraded by a conflicting cause, and neither is a saved result.
  const talked = base();
  updateEvent(talked, {
    event_type: 'hangup',
    answered: true,
    hangup_cause: 'ORIGINATOR_CANCEL',
    duration: 12,
  });
  assert.equal(talked.status, 'completed');
  assert.equal(talked.duration, 12);
  const saved = { ...base(), result: 'Olumlu', resultBy: 'Personel', resultAt: '2026-11-10T10:00:00.000Z' };
  updateEvent(saved, { event_type: 'hangup', answered: true, hangup_cause: 'NO_ANSWER' });
  assert.equal(saved.status, 'completed');
  assert.equal(saved.result, 'Olumlu');

  // The live note and the Sonlandır press are kept, whatever wording the exchange used.
  const own = { ...base(), hangupRequestedAt: new Date().toISOString(), draftNote: 'Not' };
  updateEvent(own, { event_type: 'hangup', answered: true, hangup_cause: 'NO_ANSWER' });
  assert.match(own.note, /^Not\nUlaşılamadı: arama görüşme olmadan sonlandırıldı/);
});

test("the customer's leg of the call record decides, not the extension the exchange connects first", () => {
  const extension = {
    destination_number: '1001',
    answer_stamp: '2026-11-10 17:59:40 +0300',
    result: 'Cevaplandı',
  };
  const customer = (leg) => ({
    destination_number: '905447427442',
    answer_stamp: '',
    result: 'Cevaplandı',
    ...leg,
  });
  const run = (flow, event = {}) => {
    const call = { status: 'ringing', createdAt: new Date().toISOString(), phone: '905447427442' };
    updateEvent(call, { event_type: 'hangup', answered: true, call_flow: flow, ...event });
    return call;
  };

  // The person hung up while it rang: the extension answered, the customer never did.
  const cancelled = run([extension, customer({ result: 'Vazgeçildi' })]);
  assert.equal(cancelled.status, 'unanswered');
  assert.equal(cancelled.result, 'Ulaşılamadı');
  assert.equal(cancelled.note, 'Ulaşılamadı: arama görüşme olmadan sonlandırıldı (santral bildirimi).');
  assert.deepEqual(cancelled.providerEnd, { answered: true, legAnswered: false, legResult: 'Vazgeçildi' });

  // Never answered, no reason given: still no conversation.
  const quiet = run([extension, customer({ result: '' })]);
  assert.equal(quiet.status, 'unanswered');
  assert.equal(quiet.note, 'Ulaşılamadı (santral bildirimi).');

  // The customer picked up: a conversation, with or without a talk time.
  const stamp = '2026-11-10 17:59:52 +0300';
  const spoken = run([extension, customer({ answer_stamp: stamp })], { duration: 34 });
  assert.equal(spoken.status, 'completed');
  assert.equal(spoken.duration, 34);
  assert.equal(spoken.providerEnd.legAnswered, true);
  assert.equal(run([extension, customer({ answer_stamp: stamp })]).status, 'completed');

  // Phone formats differ between the app and the exchange; the last ten digits match.
  for (const destination of ['05447427442', '+90 544 742 74 42', '0090 544 742 74 42']) {
    const call = run([extension, customer({ destination_number: destination, result: 'Cevapsız' })]);
    assert.equal(call.status, 'unanswered', destination);
  }

  // Without a customer leg in the record, nothing is concluded from it.
  const only = run([extension]);
  assert.equal(only.status, 'completed');
  assert.equal(only.providerEnd.legAnswered, undefined);
  assert.equal(run('not a list').status, 'completed');
  assert.equal(run([null, 7, 'x', { destination_number: null }]).status, 'completed');
  assert.equal(run([], { result: 'Vazgeçildi' }).status, 'unanswered');

  // A zeroed stamp means "never answered", like an empty one.
  assert.equal(
    run([extension, customer({ answer_stamp: '1970-01-01 03:00:00 +0300' })]).status,
    'unanswered',
  );

  // Who ended the call is kept as the exchange words it; anything else is dropped.
  assert.equal(run([extension], { sip_hangup_disposition: 'caller' }).providerEnd.by, 'caller');
  const hostile = run([extension], {
    sip_hangup_disposition: '<img src=x>',
    result: '<b>x</b>',
    hangup_cause: 'Vazgeçildi!',
  });
  assert.equal(hostile.providerEnd.by, undefined);
  assert.equal(hostile.providerEnd.result, undefined);
  assert.equal(hostile.providerEnd.cause, undefined);
});

test("Sonlandır while it rings: the call record's customer leg says nobody answered", async () => {
  const closed = async (record, requestId) => {
    const h = harness(async (url) => {
      const path = new URL(url).pathname;
      if (path === '/originate') return new Response('00000000-0000-0000-0000-000000000001');
      if (path.startsWith('/hangup/')) return new Response('No such channel!', { status: 400 });
      return new Response(JSON.stringify(record));
    });
    const { call } = await h.call('start', 'POST', { documentId: 'd', phone: '05320000000', requestId });
    await h.call('hangup', 'POST', { id: call.id });
    return h.state.voipCalls[0];
  };
  const extension = {
    destination_number: '1001',
    answer_stamp: '2026-11-10 17:59:48 +0300',
    result: 'Cevaplandı',
  };
  const record = (legs, cdr = {}) => ({
    cdr: {
      end_stamp: '2026-11-10 18:00:00 +0300',
      answer_stamp: '2026-11-10 17:59:48 +0300',
      result: 'Cevaplandı',
      sip_hangup_disposition: 'caller',
      recording_present: false,
      ...cdr,
    },
    ...(legs ? { call_flow: legs } : {}),
  });

  // Hung up while it rang: the call itself says "answered" (the extension), the customer leg does not.
  const rang = await closed(
    record([extension, { destination_number: '905320000000', answer_stamp: '', result: 'Vazgeçildi' }]),
    'ring-cancel-record-0001',
  );
  assert.equal(rang.status, 'unanswered');
  assert.equal(rang.result, 'Ulaşılamadı');
  assert.equal(rang.resultBy, 'Santral');
  assert(rang.hangupRequestedAt, 'pressing Sonlandır is remembered');
  assert.match(rang.note, /görüşme olmadan sonlandırıldı/);
  assert.equal(rang.providerEnd.by, 'caller');
  assert.equal(rang.providerEnd.legAnswered, false);
  assert.equal(rang.providerEnd.legResult, 'Vazgeçildi');

  // The customer talked: a conversation, and the person still chooses the result.
  const talk = await closed(
    record(
      [
        extension,
        {
          destination_number: '905320000000',
          answer_stamp: '2026-11-10 17:59:55 +0300',
          result: 'Cevaplandı',
        },
      ],
      { talk_duration: '00:00:41' },
    ),
    'ring-talk-record-0002',
  );
  assert.equal(talk.status, 'completed');
  assert.equal(talk.duration, 41);
  assert.equal(talk.result || '', '');

  // A record without per-leg details keeps working as before.
  const plain = await closed(record(null), 'ring-plain-record-0003');
  assert.equal(plain.status, 'completed');
});

test('a web phone that is still registering gets a few more tries; nothing else is retried', async () => {
  let originates = 0;
  const waits = [];
  const h = harness(
    async (url) => {
      if (new URL(url).pathname === '/originate') {
        originates++;
        return originates < 3
          ? new Response('extension 1001 is not registered', { status: 400 })
          : new Response('call-0000000001');
      }
      return new Response('[]');
    },
    { wait: async (ms) => waits.push(ms) },
  );
  h.state.voipConfig.webphoneUrl = 'https://oim.verimor.com.tr/webphone';
  const started = await h.call('start', 'POST', {
    documentId: 'd',
    phone: '05320000000',
    requestId: 'register-wait-001',
    browserManaged: true,
    waitForPhone: true,
  });
  assert.equal(started.call.status, 'ringing');
  assert.equal(originates, 3);
  assert.deepEqual(waits, [3000, 3000]);
  assert.equal(h.state.voipCalls.length, 1, 'one call record however many tries');
  assert.equal(h.state.voipCalls[0].providerError, undefined);

  // Still offline after every try: one failed record, and a machine-readable reason.
  let offlineTries = 0;
  const offline = harness(
    async () => {
      offlineTries++;
      return new Response('extension 1001 is not registered', { status: 400 });
    },
    { wait: async () => {} },
  );
  offline.state.voipConfig.webphoneUrl = 'https://oim.verimor.com.tr/webphone';
  await assert.rejects(
    offline.call('start', 'POST', { documentId: 'd', phone: '05320000001', requestId: 'register-wait-002', browserManaged: true, waitForPhone: true }),
    (e) => /santrale bağlı değil/.test(e.message) && e.reason === 'extension_unregistered',
  );
  assert.equal(offlineTries, 4);
  assert.equal(offline.state.voipCalls.length, 1);
  assert.equal(offline.state.voipCalls[0].status, 'failed');

  // Other refusals (e.g. a wrong caller id) are never retried.
  let other = 0;
  const strict = harness(
    async () => {
      other++;
      return new Response('invalid caller_id: 902120000000', { status: 400 });
    },
    { wait: async () => assert.fail('must not wait') },
  );
  strict.state.voipConfig.webphoneUrl = 'https://oim.verimor.com.tr/webphone';
  await assert.rejects(
    strict.call('start', 'POST', { documentId: 'd', phone: '05320000000', requestId: 'caller-id-request-0001', browserManaged: true, waitForPhone: true }),
    /Dış arama numarası/,
  );
  assert.equal(other, 1);
});

test('phone-status asks Verimor about the user\'s own extension and respects its 2-per-minute limit', async () => {
  const asked = [];
  let reply = () => new Response('[{"user":1001,"status":"UNREGISTERED"}]');
  const h = harness(async (url) => {
    const u = new URL(url);
    asked.push(u.pathname + '?user=' + u.searchParams.get('user'));
    return reply();
  });
  assert.deepEqual(await h.call('phone-status'), { extension: '1001', status: 'UNREGISTERED' });
  assert.deepEqual(asked, ['/user_statuses?user=1001']);
  assert.equal((await h.call('phone-status')).cached, true, 'answered from cache within 30 s');
  assert.equal(asked.length, 1);

  const limited = harness(async () => new Response('Too Many Requests', { status: 429 }));
  assert.equal((await limited.call('phone-status')).status, 'RATE_LIMITED');
  const dnd = harness(async () => new Response('[{"user":1001,"status":"SS_DND"}]'));
  assert.equal((await dnd.call('phone-status')).status, 'SS_DND');
});

test('before dialing the browser checks the microphone and explains each problem; nothing reaches Verimor', async () => {
  const { JSDOM } = require('jsdom');
  const script = await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8');
  const run = async (mic) => {
    const dom = new JSDOM('<div class="header-actions"></div><div id="area"><button id="launch">Ara</button></div>', {
      url: 'https://example.test',
      runScripts: 'dangerously',
    });
    const w = dom.window;
    const requests = [];
    w.fetch = async (url) => {
      requests.push(url);
      return { ok: true, json: async () => ({ call: { id: 'call', status: 'ringing' } }) };
    };
    w.eval(script);
    allowMicrophone(w, mic);
    try {
      const result = await w.voipStartCancelable({ requestId: 'microphone-check-01' }, w.document.getElementById('area'), () => {}, w.document.getElementById('launch'));
      return { result, requests, launch: !!w.document.getElementById('launch') };
    } catch (error) {
      return { error, requests, launch: !!w.document.getElementById('launch') };
    } finally {
      w.close();
    }
  };
  const denied = await run({ state: 'denied' });
  assert.match(denied.error.message, /Mikrofon izni engellenmiş.*kilit.*İzin ver/);
  assert.equal(denied.error.reason, 'microphone_denied');
  assert.deepEqual(denied.requests, [], 'no call is started without a microphone');
  assert.equal(denied.launch, true, 'the Ara button comes back');

  let asked = 0;
  const firstTime = await run({ state: 'prompt', getUserMedia: async () => (asked++, { getTracks: () => [{ stop() {} }] }) });
  assert.equal(asked, 1, 'the permission is asked from the Ara click');
  assert.equal(firstTime.result.call.status, 'ringing');
  assert.deepEqual(firstTime.requests, ['/api/voip/start']);

  const fail = (name) => async () => {
    throw Object.assign(new Error(name), { name });
  };
  assert.match((await run({ state: 'prompt', getUserMedia: fail('NotAllowedError') })).error.message, /engellenmiş/);
  assert.match((await run({ state: 'prompt', getUserMedia: fail('NotFoundError') })).error.message, /mikrofon veya kulaklık bulunamadı/);
  assert.match((await run({ state: 'prompt', getUserMedia: fail('NotReadableError') })).error.message, /Teams, Zoom/);
  assert.match((await run({ state: 'granted', devices: [] })).error?.message || '', /^$/, 'granted + asking uses getUserMedia, not the device list');
});

test('connection test lists microphone, firewall and Verimor extension status in plain words', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="host" hidden></div>', { url: 'https://example.test', runScripts: 'dangerously' });
  const w = dom.window;
  try {
    w.esc = (v) => String(v).replaceAll('<', '&lt;');
    w.fetch = async (url) => {
      if (String(url).startsWith('https://oim.verimor.com.tr/')) throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => ({ extension: '1001', status: 'UNREGISTERED' }) };
    };
    w.eval(await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8'));
    allowMicrophone(w, { state: 'denied' });
    await w.voipShowDiagnosis(w.document.getElementById('host'));
    const items = [...w.document.querySelectorAll('.voip-diagnosis li')].map((li) => [li.dataset.ok, li.textContent]);
    assert.equal(items[0][0], 'no');
    assert.match(items[0][1], /Mikrofon izni engellenmiş/);
    assert.equal(items[1][0], 'no');
    assert.match(items[1][1], /güvenlik duvarı.*oim\.verimor\.com\.tr.*443/);
    assert.equal(items[2][0], 'no');
    assert.match(items[2][1], /çevrimdışı/);
    assert.match(items[3][1], /tek bilgisayarda/);
    assert.equal(w.document.getElementById('host').hidden, false);
  } finally {
    w.close();
  }
});

test('the result window closes before the server answers and comes back unchanged if the save fails', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div class="header-actions"></div>', { url: 'https://example.test', runScripts: 'dangerously' });
  const w = dom.window;
  try {
    w.HTMLDialogElement.prototype.show = function () {
      this.open = true;
    };
    w.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    let answer;
    const saves = [];
    Object.assign(w, {
      hanAuth: { id: 'u', role: 'staff' },
      esc: (v) => String(v).replaceAll('<', '&lt;'),
      fetch: async (url, options) => {
        if (url.endsWith('/result')) {
          saves.push(JSON.parse(options.body));
          return await new Promise((resolve) => (answer = resolve));
        }
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });
    w.eval(
      (await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8')) + '\nvoipUi.results=["Olumlu","Olumsuz"]',
    );
    const call = { id: 'c1', userId: 'u', phone: '905320000000', status: 'completed', statusLabel: 'Görüşüldü', duration: 20 };
    w.showVoipActive({ id: '' }, call);
    const host = w.document.getElementById('voipActiveCall');
    host.querySelector('[name="note"]').value = 'Önemli not';
    host.querySelector('[name="result"][value="Olumsuz"]').checked = true;
    host.querySelector('form').dispatchEvent(new w.Event('submit', { cancelable: true }));
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(saves.length, 1, 'the save is on its way');
    assert.equal(host.open, false, 'the window is already closed while the server works');
    assert.equal(w.document.getElementById('voipActiveCall'), null, 'a new call can start meanwhile');

    answer({ ok: false, status: 503, json: async () => ({ error: 'Sunucu hazır değil.' }) });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(host.open, true, 'a failed save brings the window back');
    assert.equal(host.querySelector('[name="note"]').value, 'Önemli not');
    assert.equal(host.querySelector('[name="result"]:checked').value, 'Olumsuz');
    assert.match(host.querySelector('[data-current-feedback]').textContent, /kaydedilemedi: Sunucu hazır değil/);
    assert.equal(host.querySelector('[data-current-save]').disabled, false);

    host.querySelector('form').dispatchEvent(new w.Event('submit', { cancelable: true }));
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    answer({ ok: true, status: 200, json: async () => ({ ok: true }) });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(saves.length, 2);
    assert.deepEqual(saves[1], { id: 'c1', result: 'Olumsuz', note: 'Önemli not' });
    assert.equal(host.isConnected, false, 'a successful retry removes the window');
  } finally {
    dom.window.close();
  }
});
// ---- Inbound calls (a debtor calling the office) ----
const inbound = (extra = {}) => ({
  domain_id: '123',
  event_type: 'ringing',
  direction: 'inbound',
  call_uuid: 'in-uuid-0001',
  caller_id_number: '05320000000',
  destination_number: '908501234567',
  dialed_user: '1002',
  ...extra,
});
const hookUrl = (h) => 'webhook?token=' + h.state.voipConfig.webhookSecret;
const noRecording = async () => new Response('not found', { status: 404 });
function seedOutbound(h, extra = {}) {
  h.state.voipCalls.push({
    id: crypto.randomUUID(),
    requestId: 'seed-outbound-0001',
    provider: 'verimor',
    providerId: 'out-uuid-0001',
    documentId: 'd',
    documentNumber: 'D-1',
    clientName: 'Test müvekkil',
    debtorName: 'Test borçlu',
    phone: '905320000000',
    userId: 's',
    staffName: 'Personel',
    extension: '1002',
    createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    endedAt: new Date(Date.now() - 3 * 86400000 + 60000).toISOString(),
    status: 'completed',
    duration: 30,
    result: 'Olumlu',
    note: '',
    recordingPresent: false,
    ...extra,
  });
}
const inboundCalls = (h) => h.state.voipCalls.filter((c) => c.direction === 'inbound');
test('inbound call from a number called before joins its file and earlier caller; answer and hangup complete it once', async () => {
  const h = harness(noRecording);
  seedOutbound(h);
  const url = hookUrl(h);
  assert.deepEqual(await h.call(url, 'POST', inbound()), { ok: true });
  let [c] = inboundCalls(h);
  assert.equal(inboundCalls(h).length, 1);
  assert.equal(c.direction, 'inbound');
  assert.equal(c.phone, '905320000000');
  assert.equal(c.status, 'ringing');
  assert.equal(c.requestId, 'in:in-uuid-0001');
  assert.equal(c.documentId, 'd');
  assert.equal(c.documentNumber, 'D-1');
  assert.equal(c.debtorName, 'Test borçlu');
  assert.equal(c.clientName, 'Test müvekkil');
  assert.equal(c.ownerUserId, 's');
  assert.equal(c.ownerName, 'Personel');
  assert.equal(c.userId, '');
  await h.call(url, 'POST', inbound({ event_type: 'answer', connected_user: '1002' }));
  [c] = inboundCalls(h);
  assert.equal(c.status, 'answered');
  assert.equal(c.userId, 's');
  assert.equal(c.staffName, 'Personel');
  assert.equal(c.extension, '1002');
  const hangup = inbound({
    event_type: 'hangup',
    answered: 'true',
    duration: '42',
    recording_present: 'true',
  });
  await h.call(url, 'POST', hangup);
  await Promise.allSettled(h.jobs);
  await h.call(url, 'POST', hangup);
  await Promise.allSettled(h.jobs);
  assert.equal(inboundCalls(h).length, 1);
  assert.equal(h.state.voipCalls.length, 2);
  [c] = inboundCalls(h);
  assert.equal(c.status, 'completed');
  assert.equal(c.duration, 42);
  assert.equal(c.recordingPresent, true);
  assert.equal(c.userId, 's');
});
test('missed inbound call is unanswered, labelled as incoming and not active for anyone', async () => {
  const h = harness(noRecording);
  const url = hookUrl(h);
  await h.call(url, 'POST', inbound());
  await h.call(url, 'POST', inbound({ event_type: 'hangup', answered: 'false', duration: '0' }));
  const [c] = inboundCalls(h);
  assert.equal(c.status, 'unanswered');
  assert.equal(c.userId, '');
  const view = await h.call('calls?documentId=d');
  const listed = view.calls.find((x) => x.id === c.id);
  assert.ok(listed, 'inbound call is listed on its file');
  assert.equal(listed.statusLabel, 'Gelen arama – cevapsız');
  assert.equal(listed.direction, 'inbound');
  assert.equal(view.active.length, 0);
});
test('inbound caller matching: single file falls back to its staff; unknown and foreign/hidden numbers stay unattached', async () => {
  const h = harness(noRecording);
  const url = hookUrl(h);
  await h.call(url, 'POST', inbound({ call_uuid: 'in-uuid-0031', caller_id_number: '05320000001' }));
  await h.call(url, 'POST', inbound({ call_uuid: 'in-uuid-0032', caller_id_number: '05559998877' }));
  await h.call(url, 'POST', inbound({ call_uuid: 'in-uuid-0033', caller_id_number: '004930123456' }));
  await h.call(url, 'POST', inbound({ call_uuid: 'in-uuid-0034', caller_id_number: '' }));
  const by = (uuid) => h.state.voipCalls.find((c) => c.providerId === uuid);
  assert.equal(by('in-uuid-0031').documentId, 'd');
  assert.equal(by('in-uuid-0031').ownerUserId, 's');
  assert.equal(by('in-uuid-0031').phone, '905320000001');
  assert.equal(by('in-uuid-0032').documentId, '');
  assert.equal(by('in-uuid-0032').ownerUserId, '');
  assert.equal(by('in-uuid-0032').phone, '905559998877');
  assert.equal(by('in-uuid-0033').phone, '');
  assert.equal(by('in-uuid-0033').callerNumber, '004930123456');
  assert.equal(by('in-uuid-0033').documentId, '');
  assert.equal(by('in-uuid-0034').phone, '');
  assert.equal(by('in-uuid-0034').documentId, '');
  assert.ok(!by('in-uuid-0034').callerNumber, 'no caller number is invented for a hidden caller');
});
test('transferred inbound call moves to the extension that answered last and keeps both handlers', async () => {
  const h = harness(noRecording);
  const url = hookUrl(h);
  await h.call(url, 'POST', inbound());
  await h.call(url, 'POST', inbound({ event_type: 'answer', connected_user: '1001' }));
  assert.equal(inboundCalls(h)[0].userId, 'u');
  await h.call(url, 'POST', inbound({ event_type: 'answer', connected_user: '1002' }));
  await h.call(url, 'POST', inbound({ event_type: 'hangup', answered: 'true', duration: '20' }));
  const [c] = inboundCalls(h);
  assert.equal(c.status, 'completed');
  assert.equal(c.userId, 's');
  assert.equal(c.extension, '1002');
  assert.deepEqual(c.handlers, ['u', 's']);
});
test('an answered inbound call never blocks starting an outbound call, and active lists only the outbound one', async () => {
  const h = harness(async () => new Response('00000000-0000-0000-0000-000000000005'));
  const url = hookUrl(h);
  await h.call(url, 'POST', inbound({ dialed_user: '1001' }));
  await h.call(url, 'POST', inbound({ event_type: 'answer', connected_user: '1001' }));
  assert.equal(inboundCalls(h)[0].status, 'answered');
  assert.equal(inboundCalls(h)[0].userId, 'u');
  const { call } = await h.call('start', 'POST', {
    documentId: 'd',
    phone: '05320000001',
    requestId: 'request-inbound-005',
  });
  assert.ok(call.id);
  const { active } = await h.call('calls?documentId=d');
  assert.deepEqual(
    active.map((c) => c.id),
    [call.id],
  );
  assert.notEqual(active[0].direction, 'inbound');
});
test('user_hangup is acknowledged and changes neither outbound nor inbound calls', async () => {
  const h = harness(async () => new Response('00000000-0000-0000-0000-000000000006'));
  const url = hookUrl(h);
  const { call } = await h.call('start', 'POST', {
    documentId: 'd',
    phone: '05320000000',
    requestId: 'request-inbound-006',
  });
  const outboundBefore = structuredClone(h.state.voipCalls.find((c) => c.id === call.id));
  assert.deepEqual(
    await h.call(url, 'POST', {
      domain_id: '123',
      event_type: 'user_hangup',
      call_uuid: '00000000-0000-0000-0000-000000000006',
    }),
    { ok: true },
  );
  assert.deepEqual(
    h.state.voipCalls.find((c) => c.id === call.id),
    outboundBefore,
  );
  await h.call(url, 'POST', inbound({ call_uuid: 'in-uuid-0006', caller_id_number: '05559998877' }));
  const inboundBefore = structuredClone(inboundCalls(h)[0]);
  assert.deepEqual(
    await h.call(
      url,
      'POST',
      inbound({ event_type: 'user_hangup', call_uuid: 'in-uuid-0006', caller_id_number: '05559998877' }),
    ),
    { ok: true },
  );
  assert.deepEqual(inboundCalls(h)[0], inboundBefore);
  assert.equal(inboundCalls(h)[0].status, 'ringing');
  // A user_hangup for an unknown call creates nothing.
  await h.call(url, 'POST', inbound({ event_type: 'user_hangup', call_uuid: 'in-uuid-0099' }));
  assert.equal(inboundCalls(h).length, 1);
});
test('the extension leg of a call the app is still dialing does not create an inbound record', async () => {
  let release;
  const h = harness(async () => {
    await new Promise((r) => {
      release = r;
    });
    return new Response('00000000-0000-0000-0000-000000000007');
  });
  const url = hookUrl(h);
  const pending = h.call('start', 'POST', {
    documentId: 'd',
    phone: '05320000000',
    requestId: 'request-inbound-007',
  });
  while (!release) await new Promise((r) => setImmediate(r));
  const dialing = h.state.voipCalls[0];
  assert.equal(dialing.status, 'starting');
  assert.ok(!dialing.providerId);
  assert.deepEqual(await h.call(url, 'POST', inbound({ call_uuid: 'in-uuid-0007', dialed_user: '1001' })), {
    ok: true,
  });
  assert.equal(inboundCalls(h).length, 0);
  release();
  await pending;
  assert.equal(inboundCalls(h).length, 0);
  assert.equal(h.state.voipCalls.length, 1);
});
test('conversation merge shows finished inbound calls with incoming labels and skips ringing ones', () => {
  const { merge } = require('../lib/voip-conversations.cjs');
  const base = {
    phone: '905320000000',
    staffName: '',
    userId: '',
    duration: 0,
    createdAt: '2026-11-10T09:00:00Z',
  };
  const rows = merge(
    [],
    [
      { ...base, id: 'in-done', direction: 'inbound', status: 'completed', userId: 's', duration: 42 },
      { ...base, id: 'in-missed', direction: 'inbound', status: 'unanswered' },
      { ...base, id: 'in-ringing', direction: 'inbound', status: 'ringing' },
    ],
  );
  assert.deepEqual(
    rows.map((r) => r.voipCallId),
    ['in-done', 'in-missed'],
  );
  assert.equal(rows[0].direction, 'inbound');
  assert.equal(rows[0].result, 'Gelen arama – görüşüldü');
  assert.equal(rows[1].direction, 'inbound');
  assert.equal(rows[1].result, 'Gelen arama – cevapsız');
});
test('inbound webhook with a wrong token is rejected and records nothing', async () => {
  const h = harness(noRecording);
  await assert.rejects(h.call('webhook?token=' + 'a'.repeat(64), 'POST', inbound()), (e) => e.status === 401);
  await assert.rejects(h.call('webhook', 'POST', inbound()), (e) => e.status === 401);
  assert.equal(h.state.voipCalls.length, 0);
});
test('recordings archive filters by call direction', async () => {
  const h = harness(noRecording);
  seedOutbound(h);
  const url = hookUrl(h);
  await h.call(url, 'POST', inbound());
  await h.call(url, 'POST', inbound({ event_type: 'hangup', answered: 'false', duration: '0' }));
  const inboundOnly = await h.call('recordings?flow=inbound');
  assert.equal(inboundOnly.calls.length, 1);
  assert.equal(inboundOnly.calls[0].direction, 'inbound');
  const outboundOnly = await h.call('recordings?flow=outbound');
  assert.equal(outboundOnly.calls.length, 1);
  assert.notEqual(outboundOnly.calls[0].direction, 'inbound');
  assert.equal((await h.call('recordings')).calls.length, 2);
});
// ---- Inbound routing, check-ins, incoming strip and transfer ----
const WEBPHONE = 'https://oim.verimor.com.tr/webphone';
function inboundHarness(fetcher = noRecording, inboundUsers = ['u', 's'], extra = {}) {
  const h = harness(fetcher);
  Object.assign(h.state.voipConfig, { webphoneUrl: WEBPHONE, inboundUsers, ...extra });
  return h;
}
const CEO = { id: 'u', name: 'CEO', role: 'ceo' };
const STAFF = { id: 's', name: 'Personel', role: 'staff', staffId: 'p' };
const routeUrl = (h, cli = '05320000000', token = h.state.voipConfig.webhookSecret) =>
  'route?token=' + token + '&uuid=route-uuid-0001&cli=' + cli + '&cld=908501234567&step=1';
async function checkIn(h, user) {
  h.user = user;
  const value = await h.call('incoming');
  h.user = CEO;
  return value;
}

test('configure keeps only inbound users with an extension, validates the fallback and exposes the routing address', async () => {
  const h = harness(noRecording);
  const base = { provider: 'verimor', enabled: true, domainId: '123', extensions: { u: '1001' } };
  await h.call('config', 'PUT', {
    ...base,
    inboundUsers: ['u', 's', 'ghost', 'u'],
    inboundFallback: 'queue/201',
  });
  assert.deepEqual(h.state.voipConfig.inboundUsers, ['u'], 's has no extension now; ghost is unknown');
  assert.equal(h.state.voipConfig.inboundFallback, 'queue/201');
  const config = await h.call('config');
  assert.equal(config.routePath, '/api/voip/route?token=' + h.state.voipConfig.webhookSecret);
  assert.match(config.routePath, /^\/api\/voip\/route\?token=[a-f0-9]{64}$/);
  assert.deepEqual(config.inboundUsers, ['u']);
  assert.equal(config.inboundFallback, 'queue/201');
  assert.equal(config.sealedKey, undefined);
  assert.equal(config.webhookSecret, undefined);
  for (const fallback of [
    'queue/abc',
    'queue/',
    'user/1001;drop',
    'external/5321234567',
    'external/053212345678',
    'http://x',
  ])
    await assert.rejects(
      h.call('config', 'PUT', { ...base, inboundFallback: fallback }),
      (e) => e.status === 400,
      fallback,
    );
  await assert.rejects(h.call('config', 'PUT', { ...base, inboundUsers: 'u' }), (e) => e.status === 400);
  for (const fallback of ['group/700', 'user/1001', 'ivr/1', 'voicemail/1001', 'external/05321234567']) {
    await h.call('config', 'PUT', { ...base, inboundFallback: fallback });
    assert.equal(h.state.voipConfig.inboundFallback, fallback);
  }
  // Omitted values keep what was saved.
  await h.call('config', 'PUT', { ...base, extensions: { u: '1001', s: '1002' }, inboundUsers: ['s', 'u'] });
  await h.call('config', 'PUT', { ...base, extensions: { u: '1001', s: '1002' } });
  assert.deepEqual(h.state.voipConfig.inboundUsers, ['s', 'u']);
  assert.equal(h.state.voipConfig.inboundFallback, 'external/05321234567');
  // Removing an extension drops that user from inbound users.
  await h.call('config', 'PUT', { ...base, extensions: { s: '1002' } });
  assert.deepEqual(h.state.voipConfig.inboundUsers, ['s']);
  h.user = STAFF;
  await assert.rejects(h.call('config'), (e) => e.status === 403);
});

test('route sends a call to the last caller when reachable, else another reachable inbound user, else the fallback', async () => {
  const h = inboundHarness(noRecording, ['u', 's']);
  seedOutbound(h); // s called 0532 000 00 00 three days ago
  await assert.rejects(h.call(routeUrl(h, '05320000000', 'a'.repeat(64))), (e) => e.status === 401);
  await assert.rejects(h.call('route?cli=05320000000'), (e) => e.status === 401);
  // Nobody checked in and no fallback: still the last caller's extension.
  assert.deepEqual(await h.call(routeUrl(h)), { transfer: { target: 'user/1002' } });
  h.state.voipConfig.inboundFallback = 'queue/201';
  assert.deepEqual(await h.call(routeUrl(h)), { transfer: { target: 'queue/201' } });
  // Both check in; the last caller wins even though u comes first in the list.
  assert.equal((await checkIn(h, STAFF)).alwaysOn, true);
  assert.equal((await checkIn(h, CEO)).alwaysOn, true);
  assert.deepEqual(await h.call(routeUrl(h)), { transfer: { target: 'user/1002' } });
  // s is on another (outbound) call: the other reachable inbound user takes it.
  h.state.voipCalls.push({
    id: 'busy-s',
    requestId: 'busy-s-request',
    providerId: 'busy-s-uuid',
    documentId: '',
    phone: '905559998877',
    userId: 's',
    createdAt: new Date().toISOString(),
    status: 'answered',
  });
  assert.deepEqual(await h.call(routeUrl(h)), { transfer: { target: 'user/1001' } });
  // An unknown number goes to whoever is reachable.
  assert.deepEqual(await h.call(routeUrl(h, '05551112233')), { transfer: { target: 'user/1001' } });
  // u is talking to an inbound caller: nobody is reachable, the fallback answers.
  h.state.voipCalls.push({
    id: 'busy-u',
    requestId: 'in:busy-u',
    providerId: 'busy-u-uuid',
    direction: 'inbound',
    documentId: '',
    phone: '905551110000',
    userId: 'u',
    createdAt: new Date().toISOString(),
    status: 'answered',
  });
  assert.deepEqual(await h.call(routeUrl(h)), { transfer: { target: 'queue/201' } });
});

test('route only counts check-ins from inbound users, uses the first inbound user without a fallback and 409s when nothing is set', async () => {
  const h = inboundHarness(noRecording, ['u']);
  // s is not an inbound user: checking in does nothing and the call is never routed to s.
  assert.deepEqual(await checkIn(h, STAFF), { alwaysOn: false, call: null });
  seedOutbound(h);
  assert.deepEqual(await h.call(routeUrl(h)), { transfer: { target: 'user/1001' } });
  await checkIn(h, CEO);
  assert.deepEqual(await h.call(routeUrl(h, '05551112233')), { transfer: { target: 'user/1001' } });
  const none = inboundHarness(noRecording, []);
  await assert.rejects(none.call(routeUrl(none)), (e) => e.status === 409);
  none.state.voipConfig.inboundFallback = 'group/700';
  assert.deepEqual(await none.call(routeUrl(none)), { transfer: { target: 'group/700' } });
});

test('incoming returns the call ringing on or answered by the user and records the check-in', async () => {
  const h = inboundHarness(noRecording, ['u', 's']);
  seedOutbound(h);
  const url = hookUrl(h);
  // Not an inbound user (or no web phone) → no always-on phone.
  h.state.voipConfig.inboundUsers = ['s'];
  assert.deepEqual(await checkIn(h, CEO), { alwaysOn: false, call: null });
  h.state.voipConfig.inboundUsers = ['u', 's'];
  h.state.voipConfig.webphoneUrl = '';
  assert.deepEqual(await checkIn(h, STAFF), { alwaysOn: false, call: null });
  h.state.voipConfig.webphoneUrl = WEBPHONE;
  let staff = await checkIn(h, STAFF);
  assert.equal(staff.alwaysOn, true);
  assert.equal(staff.call, null);
  assert.ok(staff.results.includes('Olumlu'));
  await h.call(url, 'POST', inbound({ dialed_user: '1002' }));
  staff = await checkIn(h, STAFF);
  assert.equal(staff.call.status, 'ringing');
  assert.equal(staff.call.direction, 'inbound');
  assert.equal(staff.call.debtorName, 'Test borçlu');
  assert.equal(staff.call.documentNumber, 'D-1');
  assert.equal(staff.call.ownerName, 'Personel');
  assert.equal(staff.call.providerId, undefined, 'provider ids stay on the server');
  assert.equal(staff.call.requestId, undefined);
  assert.equal((await checkIn(h, CEO)).call, null, 'not ringing on 1001');
  await h.call(url, 'POST', inbound({ event_type: 'answer', connected_user: '1002' }));
  staff = await checkIn(h, STAFF);
  assert.equal(staff.call.status, 'answered');
  assert.equal(staff.call.userId, 's');
  assert.equal((await checkIn(h, CEO)).call, null);
  // Transfer targets list everyone else with an extension and who is checked in.
  h.user = STAFF;
  assert.deepEqual((await h.call('transfer-targets')).targets, [
    { id: 'u', extension: '1001', name: 'CEO', online: true },
  ]);
  // Ended calls are no longer offered.
  await h.call(url, 'POST', inbound({ event_type: 'hangup', answered: 'true', duration: '5' }));
  assert.equal((await checkIn(h, STAFF)).call, null);
});

test('transfer hands an answered call to another extension and refuses everything else', async () => {
  const requests = [];
  const h = inboundHarness(async (url) => {
    requests.push(new URL(url));
    if (new URL(url).pathname.startsWith('/transfer/')) return new Response('OK');
    return new Response('not found', { status: 404 });
  });
  h.state.users.push({ id: 'x', active: true, name: 'Diğer', role: 'staff', staffId: 'q' });
  const url = hookUrl(h);
  await h.call(url, 'POST', inbound({ dialed_user: '1002' }));
  const [c] = inboundCalls(h);
  // A ringing call belongs to nobody yet: staff may not act on it; a manager learns it is not answered.
  h.user = STAFF;
  await assert.rejects(h.call('transfer', 'POST', { id: c.id, userId: 'u' }), (e) => e.status === 403);
  h.user = CEO;
  await assert.rejects(h.call('transfer', 'POST', { id: c.id, userId: 's' }), (e) => e.status === 409);
  h.user = STAFF;
  await h.call(url, 'POST', inbound({ event_type: 'answer', connected_user: '1002' }));
  await assert.rejects(h.call('transfer', 'POST', { id: c.id, userId: 's' }), (e) => e.status === 400);
  await assert.rejects(h.call('transfer', 'POST', { id: c.id, userId: 'x' }), (e) => e.status === 400);
  await assert.rejects(h.call('transfer', 'POST', { id: c.id, userId: '' }), (e) => e.status === 400);
  h.user = { id: 'x', name: 'Diğer', role: 'staff', staffId: 'q' };
  await assert.rejects(h.call('transfer', 'POST', { id: c.id, userId: 'u' }), (e) => e.status === 403);
  assert.equal(requests.length, 0, 'nothing reached Verimor');
  h.user = STAFF;
  assert.deepEqual(await h.call('transfer', 'POST', { id: c.id, userId: 'u' }), { ok: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname, '/transfer/in-uuid-0001');
  assert.equal(requests[0].searchParams.get('user_number'), '1001');
  assert.ok(requests[0].searchParams.get('key'), 'the API key is sent');
  assert.deepEqual(
    { ...inboundCalls(h)[0].transferredTo, at: undefined },
    { userId: 'u', extension: '1001', at: undefined },
  );
  // The next answer by 1001 moves the call (and its evaluation) to u.
  await h.call(url, 'POST', inbound({ event_type: 'answer', connected_user: '1001' }));
  assert.equal(inboundCalls(h)[0].userId, 'u');
  assert.deepEqual(inboundCalls(h)[0].handlers, ['s', 'u']);
  // A manager may transfer someone else's call.
  h.user = CEO;
  assert.deepEqual(await h.call('transfer', 'POST', { id: c.id, userId: 's' }), { ok: true });
  assert.equal(requests.at(-1).searchParams.get('user_number'), '1002');
});

test('checking an inbound call against its call record keeps the incoming labels', async () => {
  const h = inboundHarness(async (url) => {
    if (new URL(url).pathname === '/cdrs/in-uuid-0001')
      return new Response(
        JSON.stringify({
          cdr: {
            direction: 'Gelen',
            caller_id_number: '905320000000',
            end_stamp: '2026-11-10 18:00:00 +0300',
            answer_stamp: '2026-11-10 17:59:30 +0300',
            talk_duration: '00:00:30',
            hangup_cause: 'NORMAL_CLEARING',
            recording_present: false,
          },
        }),
      );
    return new Response('not found', { status: 404 });
  });
  const url = hookUrl(h);
  await h.call(url, 'POST', inbound());
  await h.call(url, 'POST', inbound({ event_type: 'answer', connected_user: '1002' }));
  h.user = STAFF;
  const [c] = inboundCalls(h);
  assert.deepEqual(await h.call('sync', 'POST', { id: c.id }), { ok: true });
  await Promise.allSettled(h.jobs);
  const [after] = inboundCalls(h);
  assert.equal(after.status, 'completed');
  assert.equal(after.duration, 30);
  assert.equal(after.userId, 's');
  assert.equal(after.outboundNumber, undefined, 'no outbound line is assigned to an incoming call');
  assert.equal(after.result, '', 'no automatic outbound outcome');
  const listed = (await h.call('calls?documentId=d')).calls.find((x) => x.id === c.id);
  assert.equal(listed.statusLabel, 'Gelen arama – görüşüldü');
  assert.equal(listed.direction, 'inbound');
});

test('always-on phone shows the incoming strip, opens the call window when I answer and closes it after a transfer', async () => {
  let current = null;
  const ringing = {
    id: 'in-call-1',
    direction: 'inbound',
    documentId: 'd',
    documentNumber: 'D-1',
    debtorName: 'Test borçlu',
    clientName: 'Test müvekkil',
    ownerName: 'Personel',
    phone: '905320000000',
    userId: '',
    status: 'ringing',
    statusLabel: 'Gelen arama – çalıyor',
    createdAt: new Date().toISOString(),
  };
  const { dom, w, calls } = await callBarWindow({
    fetch: (url) => ({
      ok: true,
      json: async () =>
        url.endsWith('/incoming')
          ? { alwaysOn: true, call: current, results: ['Olumlu'] }
          : url.endsWith('/webphone')
            ? { url: WEBPHONE + '?token=W' + 'a1'.repeat(15) }
            : url.endsWith('/transfer-targets')
              ? { targets: [{ id: 's', extension: '1002', name: 'Personel', online: true }] }
              : { ok: true },
    }),
  });
  try {
    await w.voipInboundPoll();
    await settle();
    assert.equal(w.document.getElementById('voipIncoming'), null, 'no call, no strip');
    assert.equal(ui(w).alwaysOn, true);
    const phone = w.document.getElementById('voipWebphone');
    assert(phone, 'the web phone is registered in the background');
    assert.match(phone.querySelector('iframe').src, /^https:\/\/oim\.verimor\.com\.tr\/webphone\?token=W/);

    current = ringing;
    await w.voipInboundPoll();
    await settle();
    const strip = w.document.getElementById('voipIncoming');
    assert(strip, 'the strip shows the ringing call');
    assert.match(strip.textContent, /Gelen arama: Test borçlu/);
    assert.match(strip.textContent, /Föy D-1/);
    assert.match(strip.textContent, /Son arayan: Personel/);
    assert.equal(w.document.getElementById('voipPhoneDock').hidden, false, 'the web phone is revealed');
    assert.equal(strip.querySelector('[data-incoming-open]').textContent, 'Telefonu göster');
    assert.equal(phone.dataset.answering, 'true', 'the web phone is raised for answering');
    assert.equal(phone.classList.contains('voip-answering'), true);
    // Polling again with the same call keeps the same strip.
    await w.voipInboundPoll();
    assert.equal(w.document.getElementById('voipIncoming'), strip);

    current = {
      ...ringing,
      status: 'answered',
      statusLabel: 'Gelen arama – görüşülüyor',
      userId: 'u',
      staffName: 'CEO',
      answeredAt: new Date().toISOString(),
    };
    await w.voipInboundPoll();
    await settle();
    assert.equal(w.document.getElementById('voipIncoming'), null);
    const host = w.document.getElementById('voipActiveCall');
    assert(host, 'the call window opens for the answered call');
    assert.equal(phone.dataset.answering, undefined, 'the answering modal is released');
    assert.equal(host.dataset.callId, 'in-call-1');
    const transfer = host.querySelector('[data-current-transfer]');
    assert.equal(transfer.hidden, false, 'Aktar is offered while answered');

    // Aktar lists colleagues and asks the server to transfer.
    transfer.click();
    await settle();
    const box = host.querySelector('[data-transfer-box]');
    assert(box);
    assert.match(box.textContent, /Personel · 1002 · bağlı/);
    box.querySelector('[data-transfer-go]').click();
    await settle();
    assert(calls.some((c) => c.url === 'transfer' && c.body.id === 'in-call-1' && c.body.userId === 's'));
    assert.equal(host.querySelector('[data-transfer-box]'), null);

    // The call disappears from the check-in: no strip; the call window stays until the call ends.
    current = null;
    await w.voipInboundPoll();
    await settle();
    assert.equal(w.document.getElementById('voipIncoming'), null);

    // The colleague answers: the call belongs to them now and my window closes.
    ui(w).updateActive({ ...ringing, status: 'answered', userId: 's', staffName: 'Personel' });
    assert.equal(w.document.getElementById('voipActiveCall'), null);
    assert.equal(ui(w).activeId, '');
  } finally {
    try {
      w.clearTimeout(ui(w).inboundTimer);
      await settle();
    } finally {
      dom.window.close();
    }
  }
});

test('always-on phone stays registered after a call; a ringing call that stops ringing removes the strip', async () => {
  let current = null;
  let alwaysOn = true;
  const ringing = {
    id: 'in-call-2',
    direction: 'inbound',
    documentId: '',
    phone: '905551112233',
    userId: '',
    status: 'ringing',
    statusLabel: 'Gelen arama – çalıyor',
    createdAt: new Date().toISOString(),
  };
  const { dom, w } = await callBarWindow({
    fetch: (url) => ({
      ok: true,
      json: async () =>
        url.endsWith('/incoming')
          ? alwaysOn
            ? { alwaysOn: true, call: current, results: ['Olumlu'] }
            : { alwaysOn: false, call: null }
          : url.endsWith('/webphone')
            ? { url: WEBPHONE + '?token=W' + 'b2'.repeat(15) }
            : { ok: true },
    }),
  });
  try {
    current = ringing;
    await w.voipInboundPoll();
    await settle();
    const strip = w.document.getElementById('voipIncoming');
    assert.match(strip.textContent, /Gelen arama: 0 \(555\) 111 22 33/);
    assert.match(strip.textContent, /Kayıtlı bir föyle eşleşmedi/);
    current = null;
    await w.voipInboundPoll();
    await settle();
    assert.equal(w.document.getElementById('voipIncoming'), null);
    assert.equal(w.document.getElementById('voipPhoneDock').hidden, true, 'the revealed phone is tucked away');
    assert(w.document.getElementById('voipWebphone'), 'but stays registered');

    // A finished call does not tear the web phone down for always-on staff.
    current = { ...ringing, status: 'answered', userId: 'u', answeredAt: new Date().toISOString() };
    await w.voipInboundPoll();
    await settle();
    assert(w.document.getElementById('voipActiveCall'));
    ui(w).updateActive({ ...current, status: 'completed', statusLabel: 'Gelen arama – görüşüldü', duration: 12 });
    assert.equal(ui(w).releaseTimer ?? null, null, 'no teardown is scheduled');
    assert(w.document.getElementById('voipWebphone'));

    // Leaving the inbound list turns the always-on phone off.
    alwaysOn = false;
    await w.voipInboundPoll();
    assert.equal(ui(w).alwaysOn, false);
  } finally {
    try {
      w.clearTimeout(ui(w).inboundTimer);
      await settle();
    } finally {
      dom.window.close();
    }
  }
});

test('Sonlandır closes an inbound call whose channel is gone even when the exchange has no call record', async () => {
  const h = inboundHarness(async (url) => {
    const path = new URL(url).pathname;
    if (path.startsWith('/hangup/')) return new Response('No such channel!', { status: 400 });
    if (path.startsWith('/cdrs/')) return new Response('not found', { status: 404 });
    return new Response('[]');
  });
  h.user = { id: 's', name: 'Personel', role: 'staff', staffId: 'p' };
  await h.call(hookUrl(h), 'POST', inbound());
  await h.call(hookUrl(h), 'POST', inbound({ event_type: 'answer', connected_user: '1002' }));
  // The hangup event never arrives; the person presses Sonlandır.
  const call = inboundCalls(h)[0];
  assert.equal(call.status, 'answered');
  assert.deepEqual(await h.call('hangup', 'POST', { id: call.id }), { ok: true });
  const closed = inboundCalls(h)[0];
  assert.equal(closed.status, 'completed', 'answered, so it ends as a finished conversation');
  assert.equal(closed.endSource, 'channel-gone');
  assert.ok(closed.endedAt);
  const listed = await h.call('calls?documentId=d');
  assert.deepEqual(listed.active, [], 'nothing stays "in progress"');
});

test('an inbound call left ringing for minutes is closed as unanswered at the next check-in', async () => {
  const h = inboundHarness();
  h.user = { id: 's', name: 'Personel', role: 'staff', staffId: 'p' };
  await h.call(hookUrl(h), 'POST', inbound());
  inboundCalls(h)[0].createdAt = new Date(Date.now() - 4 * 60000).toISOString();
  const polled = await h.call('incoming');
  assert.equal(polled.call, null, 'not offered as ringing any more');
  const call = inboundCalls(h)[0];
  assert.equal(call.status, 'unanswered');
  assert.equal(call.endSource, 'ring-timeout');
});

test('answered inbound calls the exchange no longer shows as talking are closed automatically', async () => {
  let talking = true;
  const asked = [];
  const h = inboundHarness(async (url) => {
    const u = new URL(url);
    asked.push(u.pathname);
    if (u.pathname === '/user_statuses')
      return new Response(JSON.stringify([{ user: 1002, status: talking ? 'TALKING' : 'AVAILABLE' }]));
    if (u.pathname.startsWith('/cdrs/')) return new Response('not found', { status: 404 });
    return new Response('[]');
  });
  h.user = { id: 's', name: 'Personel', role: 'staff', staffId: 'p' };
  await h.call(hookUrl(h), 'POST', inbound());
  await h.call(hookUrl(h), 'POST', inbound({ event_type: 'answer', connected_user: '1002' }));
  // Younger than a minute: not checked yet.
  assert.equal((await h.call('incoming')).call.status, 'answered');
  assert.ok(!asked.includes('/user_statuses'));
  inboundCalls(h)[0].answeredAt = new Date(Date.now() - 2 * 60000).toISOString();
  // Still talking: stays open.
  assert.equal((await h.call('incoming')).call.status, 'answered');
  assert.equal(asked.filter((p) => p === '/user_statuses').length, 1);
  // Checked at most every 30 s from the screen.
  await h.call('incoming');
  assert.equal(asked.filter((p) => p === '/user_statuses').length, 1);
  // The hangup event is lost and the extension is free again: the next check closes it.
  talking = false;
  inboundCalls(h)[0].statusCheckedAt = new Date(Date.now() - 60000).toISOString();
  assert.equal((await h.call('incoming')).call, null);
  const call = inboundCalls(h)[0];
  assert.equal(call.status, 'completed');
  assert.equal(call.endSource, 'extension-idle');
});

test('the background job closes inbound calls stuck as answered and ringing calls over two minutes', async () => {
  process.env.VOIP_CRON_SECRET ||= 'test-cron-secret-0123456789';
  const h = inboundHarness(async (url) => {
    const u = new URL(url);
    if (u.pathname === '/user_statuses') return new Response('[{"user":1002,"status":"UNREGISTERED"}]');
    return new Response('not found', { status: 404 });
  });
  await h.call(hookUrl(h), 'POST', inbound());
  await h.call(hookUrl(h), 'POST', inbound({ event_type: 'answer', connected_user: '1002' }));
  await h.call(hookUrl(h), 'POST', inbound({ call_uuid: 'in-uuid-0002', caller_id_number: '05320000001' }));
  const [answered, ringing] = inboundCalls(h);
  answered.answeredAt = new Date(Date.now() - 5 * 60000).toISOString();
  ringing.createdAt = new Date(Date.now() - 150000).toISOString();
  const result = await h.call('cron', 'POST', {}, false, { authorization: 'Bearer ' + process.env.VOIP_CRON_SECRET });
  assert.equal(result.inboundClosed, 1);
  const [a, r] = inboundCalls(h);
  assert.deepEqual([a.status, a.endSource], ['completed', 'extension-idle']);
  assert.deepEqual([r.status, r.endSource], ['unanswered', 'ring-timeout']);
});

test('a call the exchange cannot confirm (no call id) can be closed by its person; nothing is sent to the exchange', async () => {
  const asked = [];
  const h = harness(async (url) => {
    asked.push(new URL(url).pathname);
    return new Response('[]');
  });
  h.user = { id: 's', name: 'Personel', role: 'staff', staffId: 'p' };
  const base = {
    provider: 'verimor',
    documentId: 'd',
    phone: '905320000000',
    staffName: 'Personel',
    extension: '1002',
    createdAt: new Date(Date.now() - 600000).toISOString(),
    status: 'unknown',
    duration: 0,
    result: '',
    note: '',
    recordingPresent: false,
  };
  const id = crypto.randomUUID();
  h.state.voipCalls.push({ ...base, id, requestId: 'stuck-request-0001', userId: 's' });
  await assert.rejects(h.call('hangup', 'POST', { id }), /Çağrı kimliği henüz alınamadı/);
  const closed = await h.call('close', 'POST', { id });
  assert.equal(closed.ok, true);
  assert.equal(closed.call.status, 'failed', 'never answered');
  const call = h.state.voipCalls.find((c) => c.id === id);
  assert.equal(call.endSource, 'manual-close');
  assert.equal(call.closedBy, 'Personel');
  assert.deepEqual(asked, [], 'the exchange is not contacted');
  assert.deepEqual((await h.call('calls?documentId=d')).active, [], 'no longer in progress');
  const other = crypto.randomUUID();
  h.state.voipCalls.push({ ...base, id: other, requestId: 'stuck-request-0002', userId: 'u' });
  await assert.rejects(h.call('close', 'POST', { id: other }), /yetkiniz yok/, "staff cannot close someone else's call");
});

test('a recent outbound conversation is reported as recent_call even when an inbound call came after it', async () => {
  const h = harness(async () => new Response('call-0000000099'));
  h.user = { id: 's', name: 'Personel', role: 'staff', staffId: 'p' };
  const base = { provider: 'verimor', documentId: 'd', phone: '905320000000', staffName: 'Personel', extension: '1002', duration: 30, result: '', note: '', recordingPresent: false };
  h.state.voipCalls.push(
    { ...base, id: crypto.randomUUID(), requestId: 'recent-out-0001', userId: 's', status: 'completed', createdAt: new Date(Date.now() - 600000).toISOString() },
    { ...base, id: crypto.randomUUID(), requestId: 'in:recent-in-0001', userId: '', direction: 'inbound', status: 'unanswered', createdAt: new Date(Date.now() - 60000).toISOString() },
  );
  await assert.rejects(
    h.call('start', 'POST', { documentId: 'd', phone: '05320000000', requestId: 'recent-check-0001' }),
    (e) => e.reason === 'recent_call' && /yakın zamanda arandı/.test(e.message),
  );
  const ok = await h.call('start', 'POST', { documentId: 'd', phone: '05320000000', requestId: 'recent-check-0002', confirmRecent: true });
  assert.equal(ok.call.status, 'ringing', 'confirming lets the call go out');
});

test('the fallback target is chosen from a list with an explanation and saved as a Verimor target', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<form><select name="fallbackType"></select><input name="fallbackNumber"><select name="fallbackUser"><option value="1001">CEO · dahili 1001</option><option value="1002">Personel · dahili 1002</option></select><small data-fallback-help></small></form>', { url: 'https://example.test', runScripts: 'dangerously' });
  const w = dom.window;
  try {
    w.esc = (v) => String(v);
    w.eval(await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8'));
    const form = w.document.querySelector('form');
    form.elements.fallbackType.innerHTML = ['', 'group', 'queue', 'user', 'voicemail', 'external'].map((id) => `<option value="${id}">${id}</option>`).join('');
    w.voipBindFallback(form, 'group/700');
    assert.equal(form.elements.fallbackType.value, 'group');
    assert.equal(form.elements.fallbackNumber.value, '700');
    assert.equal(form.elements.fallbackUser.hidden, true);
    assert.match(form.querySelector('[data-fallback-help]').textContent, /bütün dahililer aynı anda çalar/);
    assert.equal(w.voipFallbackValue(form), 'group/700');

    form.elements.fallbackType.value = 'voicemail';
    form.elements.fallbackType.onchange();
    assert.equal(form.elements.fallbackNumber.hidden, true);
    assert.equal(form.elements.fallbackUser.hidden, false);
    form.elements.fallbackUser.value = '1002';
    assert.equal(w.voipFallbackValue(form), 'voicemail/1002');

    form.elements.fallbackType.value = 'external';
    form.elements.fallbackNumber.value = '+90 532 123 45 67';
    assert.equal(w.voipFallbackValue(form), 'external/05321234567');
    form.elements.fallbackNumber.value = '123';
    assert.throws(() => w.voipFallbackValue(form), /geçerli bir telefon/);

    form.elements.fallbackType.value = 'queue';
    form.elements.fallbackNumber.value = '';
    assert.throws(() => w.voipFallbackValue(form), /kuyruk numarasını/);

    form.elements.fallbackType.value = '';
    assert.equal(w.voipFallbackValue(form), '');
    w.voipBindFallback(form, 'user/1001');
    assert.equal(form.elements.fallbackUser.value, '1001');
    assert.equal(w.voipFallbackValue(form), 'user/1001');
  } finally {
    w.close();
  }
});

test('a call from a debtor rings the file assignee first, then the last caller, then anyone reachable', async () => {
  // File d is assigned to staff p (user s, ext 1002); the last call to the number was made by u (1001).
  const h = inboundHarness();
  seedOutbound(h, { userId: 'u', staffName: 'CEO', extension: '1001', requestId: 'seed-outbound-by-ceo' });
  h.user = CEO;
  await checkIn(h, STAFF);
  await checkIn(h, CEO);
  assert.deepEqual(await h.call(routeUrl(h)), { transfer: { target: 'user/1002' } }, 'assignee before last caller');

  // The assignee is on another call: the last caller is next.
  h.state.voipCalls.push({ id: crypto.randomUUID(), requestId: 'busy-0001', userId: 's', phone: '905559990000', status: 'answered', createdAt: new Date().toISOString() });
  assert.deepEqual(await h.call(routeUrl(h)), { transfer: { target: 'user/1001' } }, 'last caller when the assignee is busy');

  // A number on no file with no previous call: anyone reachable.
  h.state.voipCalls = h.state.voipCalls.filter((c) => c.requestId !== 'busy-0001');
  assert.deepEqual(await h.call(routeUrl(h, '05551112233')), { transfer: { target: 'user/1001' } });
});

test('VoIP settings: connection settings and "Dahililer ve yetkiler" are two tabs under Entegrasyonlar → VoIP', async () => {
  const { JSDOM } = require('jsdom');
  const src = await fs.readFile('outputs/icrapro/settings.js', 'utf8');
  const tabs = src.slice(src.indexOf('// VoIP has two pages'), src.indexOf('function bindSettingsSectionTabs'));
  const render = (role, active) => {
    const dom = new JSDOM('', { runScripts: 'outside-only' });
    const w = dom.window;
    w.hanAuth = { role };
    w.esc = (v) => String(v);
    w.eval(tabs);
    w.document.body.innerHTML = w.settingsSectionTabs(active);
    const rows = [...w.document.querySelectorAll('.settings-tabs')].map((row) =>
      [...row.querySelectorAll('button')].map((b) => (b.classList.contains('selected') ? '*' : '') + b.textContent),
    );
    w.close();
    return rows;
  };
  const ceo = render('ceo', 'permissions');
  assert.ok(!ceo[0].some((t) => t.includes('Yetkilendirme')), 'no top-level Yetkilendirme tab');
  assert.ok(ceo[0].includes('*Entegrasyonlar'));
  assert.ok(ceo[1].includes('*VoIP / Telefon'));
  assert.deepEqual(ceo[2], ['Bağlantı ayarları', '*Dahililer ve yetkiler']);
  assert.deepEqual(render('ceo', 'voip')[2], ['*Bağlantı ayarları', 'Dahililer ve yetkiler']);
  assert.equal(render('ceo', 'sms').length, 2, 'no VoIP row on other integrations');

  const admin = render('admin', 'permissions');
  assert.ok(admin[0].includes('*Entegrasyonlar'), 'admins keep access to extensions and recording rights');
  assert.deepEqual(admin[1], ['*VoIP / Telefon']);
  assert.deepEqual(admin[2], ['*Dahililer ve yetkiler'], 'admins do not see the CEO-only connection settings');

  assert.ok(!render('staff', 'firm')[0].includes('Entegrasyonlar'));
});
