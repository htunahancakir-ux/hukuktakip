const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Writable } = require('node:stream');
const { createVoipHandler, configure, number, phones, updateEvent } = require('../lib/voip.cjs');
const { createRecordingStore, filename } = require('../lib/voip-recordings.cjs');
process.env.VOIP_ENCRYPTION_KEY = 'ab'.repeat(32);
function harness(fetcher) {
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
  });
  return {
    get state() {
      return state;
    },
    set user(u) {
      actor = u;
    },
    jobs,
    async call(route, method = 'GET', input) {
      const req = { method, headers: { 'content-type': 'application/json' }, raw: JSON.stringify(input) };
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
  );
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
test('manager extension panel saves a single user and shows the saved value', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<main><section id="permissions"></section></main>', { runScripts: 'outside-only' }),
    w = dom.window;
  w.esc = (value) => String(value || '');
  w.eval(await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8'));
  let input;
  w.voipApi = async (path, method, value) => {
    assert.equal(path, 'extensions');
    if (method === 'PUT') input = value;
    return {
      users: [
        {
          id: 's',
          name: 'Personel',
          username: 'staff',
          role: 'staff',
          extension: input ? input.extension : '1002',
        },
      ],
    };
  };
  await w.voipExtensionsPanel(w.document.querySelector('#permissions'));
  const form = w.document.querySelector('form');
  const personnelSource = await fs.readFile('outputs/icrapro/personnel.js', 'utf8');
  w.eval(
    personnelSource.slice(
      personnelSource.indexOf('function mandatoryControls('),
      personnelSource.indexOf('function validateSettingsDraft('),
    ),
  );
  w.enforceRequired(form);
  form.elements.extension.value = '1000';
  form.requestSubmit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(input.userId, 's');
  assert.equal(input.extension, '1000');
  assert.equal(form.querySelector('[role="status"]').textContent, 'Kaydedildi.');
  assert.equal(form.elements.extension.defaultValue, '1000');
  form.elements.extension.value = '';
  assert.equal(
    form.checkValidity(),
    true,
    'Blank extensions remain optional after the application form upgrader',
  );
  form.requestSubmit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(input.extension, '');
  assert.equal(form.elements.extension.defaultValue, '');
  assert.equal(form.querySelector('[role="status"]').textContent, 'Kaydedildi.');
  form.elements.extension.value = 'abc';
  assert.equal(form.checkValidity(), false, 'Nonempty extensions still require digits');
  dom.window.close();
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
  await h.call(url, 'POST', event);
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
  assert.equal(h.state.voipCalls[0].draftNote, 'Görüşme sürerken alınan not');
  await h.call('result', 'POST', { id: call.id, result: 'Meşgul', note: 'Görüşme sürerken alınan not' });
  assert.equal(h.state.voipCalls[0].draftNote, undefined);
  assert.equal((await h.call('recordings?status=busy&result=' + encodeURIComponent('Meşgul'))).total, 1);
  assert.equal((await h.call('recordings?status=completed')).total, 0);
  await assert.rejects(
    h.call('draft', 'POST', { id: call.id, note: 'Geç kalan taslak' }),
    (e) => e.status === 409,
  );
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
    let startCount = 0;
    Object.assign(w, {
      hanAuth: { id: 's', role: 'staff' },
      esc: (v) => String(v).replaceAll('<', '&lt;'),
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
    w.eval(await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8'));
    w.eval(await fs.readFile('outputs/icrapro/modal-dismissal.js', 'utf8'));
    w.setupBorrowerVoip(w.document.querySelector('dialog'), { id: 'd' });
    w.document.querySelector('[data-open-voip]').click();
    await new Promise((r) => setImmediate(r));
    assert.match(w.document.body.textContent, /Other Staff/);
    assert.match(w.document.body.textContent, /01:30/);
    assert(w.document.querySelector('[data-dial-phone]'));
    assert(w.document.querySelector('[data-number-history]'));
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
  const dom = new JSDOM('<dialog id="borrowerDetail" open></dialog>', {
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
    const textarea = w.document.querySelector('[data-current-form] textarea');
    textarea.value = 'Müşteri yarın dönüş yapacak.';
    textarea.dispatchEvent(new w.Event('input'));
    w.showVoipActive({ id: 'd' }, { ...call, duration: 10 });
    assert.equal(w.document.querySelector('textarea'), textarea, 'poll updates never replace the note input');
    assert.equal(textarea.value, 'Müşteri yarın dönüş yapacak.');
    w.document.querySelector('[data-current-minimize]').click();
    await new Promise((r) => setImmediate(r));
    assert.equal(draft, textarea.value);
    w.document.querySelector('[data-current-hangup]').click();
    await new Promise((r) => setImmediate(r));
    assert.equal(w.document.querySelector('[data-current-outcomes]').hidden, false);
    assert.equal(textarea.value, draft);
    w.document.querySelector('[name="result"][value="Olumlu"]').checked = true;
    w.document
      .querySelector('form')
      .dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setImmediate(r));
    assert.equal(saved.result, 'Olumlu');
    assert.equal(saved.note, draft);
    assert.equal(w.document.getElementById('voipActiveCall'), null);
    w.showVoipActive({ id: 'd' }, { ...call, id: 'busy', status: 'busy', statusLabel: 'Meşgul' });
    assert.equal(w.document.querySelector('[name="result"]:checked').value, 'Meşgul');
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
                      transcription: { status: 'completed' },
                    },
                  ],
                },
        };
      },
    });
    w.eval(await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8'));
    w.voipRecordingsPage();
    await new Promise((r) => setImmediate(r));
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
