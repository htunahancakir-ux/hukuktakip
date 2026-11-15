const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

// Loads login-recovery.js with minimal stand-ins for the login screen it plugs into.
function setup(replies) {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://buro.example.test/',
    runScripts: 'dangerously',
  });
  const w = dom.window;
  const requests = [];
  const logins = [];
  w.loginFrame = (html) => {
    w.document.body.innerHTML = html;
  };
  w.installPasswordVisibility = () => {};
  w.authGate = () => {
    w.document.body.innerHTML =
      '<form id="loginForm"><input id="login-username"><input id="login-password"><button type="submit">Giriş</button></form>';
    w.document.getElementById('loginForm').addEventListener('submit', (event) => {
      event.preventDefault();
      logins.push({
        username: w.document.getElementById('login-username').value,
        password: w.document.getElementById('login-password').value,
      });
    });
  };
  // The office's open ways; SMS only unless a test says otherwise.
  replies = { '/api/password-reset/channels': () => [200, { channels: ['sms'] }], ...replies };
  w.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push(body === undefined ? { url } : { url, body });
    const [status, json] = replies[url](body);
    return { ok: status < 400, status, json: async () => json };
  };
  // The "… gelmedi mi?" countdown runs on these instead of real seconds.
  const intervals = [];
  w.setInterval = (callback) => intervals.push(callback) - 1;
  w.clearInterval = (id) => {
    intervals[id] = null;
  };
  const ticks = (count) => {
    for (let i = 0; i < count; i++) intervals.forEach((callback) => callback?.());
  };
  w.eval(fs.readFileSync('outputs/icrapro/login-recovery.js', 'utf8'));
  return { w, requests: { filter: (f) => requests.filter(f), at: (i) => requests.filter((r) => r.body).at(i) }, logins, ticks };
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const submit = (w, id) =>
  w.document.getElementById(id).dispatchEvent(new w.Event('submit', { cancelable: true }));

test('marketing form requires a recipient classification, avoids double posts and distinguishes acceptance from delivery', async () => {
  const dom = new JSDOM('<!doctype html><div id="content"></div>', {
    url: 'https://buro.example.test/',
    runScripts: 'dangerously',
  });
  const w = dom.window;
  const requests = [];
  let release;
  w.hanAuth = { role: 'ceo' };
  w.$ = (selector) => w.document.querySelector(selector);
  w.esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  w.authApi = () => ({ configured: true, header: 'Av.HB.Patan' });
  w.toast = () => {};
  w.render = () => {};
  w.fetch = async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) });
    return new Promise((resolve) => {
      release = () =>
        resolve({ ok: true, json: async () => ({ sms: { accepted: true, campaignId: '4711' } }) });
    });
  };
  w.eval(fs.readFileSync('outputs/icrapro/workspace-sms.js', 'utf8'));
  try {
    w.marketingSmsPage();
    const form = w.document.getElementById('marketingSmsForm');
    form.elements.phone.value = '05321234567';
    form.elements.text.value = 'Tanıtım mesajı';
    submit(w, 'marketingSmsForm');
    assert.equal(requests.length, 0, 'No default recipient type or premature send');
    w.document.getElementById('marketingSmsIndividual').checked = true;
    submit(w, 'marketingSmsForm');
    submit(w, 'marketingSmsForm');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].headers['X-Han-Request'], '1');
    assert.equal(requests[0].body.recipientType, 'BIREYSEL');
    release();
    await settle();
    assert.match(w.document.getElementById('marketingSmsStatus').textContent, /isteği kabul etti.*4711/);
    assert.equal(form.elements.text.value, '');
    assert.equal(form.querySelector('[type="submit"]').disabled, false);
    w.hanAuth.role = 'staff';
    let denied = false;
    w.toast = () => {
      denied = true;
    };
    w.marketingSmsPage();
    assert.equal(denied, true);
  } finally {
    w.close();
  }
});

test('Şifremi unuttum with platform SMS: request, enter the temporary password, set a new one, signed in', async () => {
  const { w, requests, logins } = setup({
    '/api/password-reset/request': () => [200, { ok: true, channel: 'sms', alternatives: [] }],
    '/api/password-reset/sms-complete': (body) =>
      body.code === '12345678'
        ? [200, { ok: true, username: 'mehmet' }]
        : [200, { ok: false, error: 'Geçici şifre hatalı veya süresi dolmuş. Yeni şifre isteyin.' }],
  });
  w.passwordRecoveryGate();
  await settle();
  assert.match(w.document.body.textContent, /tek kullanımlık kod/);
  assert.equal(w.document.getElementById('haveSmsCode').hidden, false, 'SMS is open: its shortcut shows');
  assert.equal(w.document.getElementById('haveEmailCode').hidden, true);
  w.document.getElementById('recovery-account').value = '0532 123 45 67';
  submit(w, 'recoveryForm');
  await settle();
  const form = w.document.getElementById('codeRecoveryForm');
  assert.equal(form?.dataset.channel, 'sms', 'SMS channel goes straight to the temporary-password step');
  assert.equal(w.document.getElementById('code-account').value, '0532 123 45 67', 'account carried over');
  const code = w.document.getElementById('code-value');
  assert.deepEqual(
    [code.type, code.inputMode, code.autocomplete],
    ['text', 'numeric', 'one-time-code'],
    'one text field with a numeric keypad and code autofill',
  );

  const fill = (value, password, confirm = password) => {
    code.value = value;
    w.document.getElementById('code-password').value = password;
    w.document.getElementById('code-confirm').value = confirm;
    submit(w, 'codeRecoveryForm');
  };
  fill('12345678', 'New-Password-123', 'Different-Password-1');
  await settle();
  assert.match(w.document.getElementById('codeRecoveryStatus').textContent, /aynı olmalıdır/);
  assert.equal(requests.filter((r) => r.body).length, 1, 'mismatch is caught before any request');

  fill('0000 0000', 'New-Password-123');
  await settle();
  assert.match(w.document.getElementById('codeRecoveryStatus').textContent, /hatalı veya süresi dolmuş/);
  assert.equal(requests.at(-1).body.code, '00000000', 'spaces removed');

  fill('12345678', 'New-Password-123');
  await settle();
  assert.equal(requests.at(-1).url, '/api/password-reset/sms-complete');
  assert.deepEqual(requests.at(-1).body, {
    account: '0532 123 45 67',
    code: '12345678',
    password: 'New-Password-123',
  });
  assert.deepEqual(
    logins,
    [{ username: 'mehmet', password: 'New-Password-123' }],
    'signed in with the new password',
  );
});

test('E-mail recovery: the 8-digit code from a verified address and a new password sign the user in', async () => {
  const { w, requests, logins } = setup({
    '/api/password-reset/channels': () => [200, { channels: ['email', 'sms'] }],
    '/api/password-reset/request': () => [200, { ok: true, channel: 'email', alternatives: ['sms'] }],
    '/api/password-reset/email-complete': (body) =>
      body.code === '12345678'
        ? [200, { ok: true, username: 'mehmet' }]
        : [200, { ok: false, error: 'Kod hatalı veya süresi dolmuş. Yeni kod isteyin.' }],
  });
  w.passwordRecoveryGate();
  await settle();
  assert.equal(w.document.getElementById('haveEmailCode').hidden, false);
  w.document.getElementById('recovery-account').value = 'mehmet';
  submit(w, 'recoveryForm');
  await settle();
  assert.equal(w.document.getElementById('codeRecoveryForm').dataset.channel, 'email');
  // Nothing is sent to an address the user never verified; the screen says where to go then.
  assert.match(w.document.body.textContent, /yalnızca Hesabım bölümünde doğruladığınız adrese/);
  const code = w.document.getElementById('code-value');
  assert.equal(code.pattern, '[0-9 ]{8,9}');
  assert.equal(code.autocomplete, 'one-time-code');
  w.document.getElementById('code-password').value = 'New-Password-123';
  w.document.getElementById('code-confirm').value = 'New-Password-123';
  code.value = '0000 0000';
  submit(w, 'codeRecoveryForm');
  await settle();
  assert.equal(requests.at(-1).url, '/api/password-reset/email-complete');
  assert.equal(requests.at(-1).body.code, '00000000');
  assert.match(w.document.getElementById('codeRecoveryStatus').textContent, /Kod hatalı/);
  assert.equal(w.document.getElementById('code-password').value, 'New-Password-123', 'the new password stays');
  assert.deepEqual(logins, []);
  code.value = '1234 5678';
  submit(w, 'codeRecoveryForm');
  await settle();
  assert.deepEqual(logins, [{ username: 'mehmet', password: 'New-Password-123' }]);
});

test('a WhatsApp live-test link asks for an explicit confirmation and never for a password', async () => {
  const { w, requests } = setup({
    '/api/password-reset/channel-test-link': (body) => [
      200,
      body.confirm ? { ok: true, test: true } : { test: true, usable: true },
    ],
  });
  w.passwordRecoveryGate('a'.repeat(43));
  await settle();
  assert.equal(w.document.querySelector('input[type="password"]'), null);
  assert.deepEqual(requests.at(-1).body, { token: 'a'.repeat(43) });
  assert.match(w.document.body.textContent, /Hesap şifreniz değişmez/);
  const confirm = w.document.getElementById('channelTestConfirm');
  confirm.click();
  await settle();
  assert.equal(requests.at(-1).body.confirm, true);
  assert.match(w.document.getElementById('channelTestStatus').textContent, /doğrulandı/);
  assert.equal(confirm.hidden, true, 'confirmed once');

  // An expired test link, or one from before the settings changed, offers nothing to confirm.
  const stale = setup({ '/api/password-reset/channel-test-link': () => [200, { test: true, usable: false }] });
  stale.w.passwordRecoveryGate('c'.repeat(43));
  await settle();
  assert.equal(stale.w.document.getElementById('channelTestConfirm'), null);
  assert.match(stale.w.document.body.textContent, /süresi dolmuş/);
});

test('a user’s own WhatsApp password link keeps its new-password form', async () => {
  const { w, requests } = setup({
    '/api/password-reset/channel-test-link': () => [200, { test: false }],
    '/api/password-reset/complete': () => [200, { ok: true }],
  });
  w.passwordRecoveryGate('b'.repeat(43));
  await settle();
  assert.ok(w.document.getElementById('recovery-password'));
  assert.equal(w.document.getElementById('channelTestConfirm'), null);
  w.document.getElementById('recovery-password').value = 'New-Password-123';
  w.document.getElementById('recovery-confirm').value = 'New-Password-123';
  submit(w, 'recoveryForm');
  await settle();
  assert.deepEqual(requests.at(-1), {
    url: '/api/password-reset/complete',
    body: { token: 'b'.repeat(43), password: 'New-Password-123' },
  });
});

test('"SMS gelmedi mi?" offers e-mail after the wait, and "Yöneticiden iste" reaches the managers', async () => {
  const { w, requests, ticks } = setup({
    '/api/password-reset/request': (body) => [
      200,
      body.channel === 'email'
        ? { ok: true, channel: 'email', alternatives: ['sms'] }
        : { ok: true, channel: 'sms', alternatives: ['email'] },
    ],
    '/api/password-reset/ask-manager': () => [200, { ok: true }],
  });
  w.passwordRecoveryGate();
  await settle();
  w.document.getElementById('recovery-account').value = 'mehmet';
  submit(w, 'recoveryForm');
  await settle();
  const open = w.document.querySelector('[data-fallback-open]');
  assert.equal(open.disabled, true, 'other ways are offered only after a short wait');
  assert.match(open.textContent, /SMS gelmedi mi\? \(30 sn\)/);
  ticks(30);
  assert.equal(open.disabled, false);
  assert.equal(open.textContent, 'SMS gelmedi mi?');
  open.click();
  const choices = [...w.document.querySelectorAll('[data-fallback-choices] button')];
  assert.deepEqual(
    choices.map((b) => b.textContent),
    ['E-posta ile gönder', 'Kodu yeniden gönder', 'Yöneticiden iste'],
  );
  choices[0].click();
  await settle();
  assert.deepEqual(requests.at(-1).body, { account: 'mehmet', channel: 'email' }, 'the user picked e-mail');
  assert.equal(w.document.getElementById('codeRecoveryForm').dataset.channel, 'email');

  ticks(30);
  w.document.querySelector('[data-fallback-open]').click();
  const last = [...w.document.querySelectorAll('[data-fallback-choices] button')].at(-1);
  assert.equal(last.textContent, 'Yöneticiden iste');
  last.click();
  await settle();
  assert.equal(w.document.getElementById('help-account').value, 'mehmet', 'account carried over');
  assert.equal(w.document.getElementById('help-note').dataset.optional, 'true', 'the note is optional');
  w.document.getElementById('help-note').value = 'Telefonum değişti';
  submit(w, 'managerHelpForm');
  await settle();
  assert.deepEqual(requests.at(-1), {
    url: '/api/password-reset/ask-manager',
    body: { account: 'mehmet', note: 'Telefonum değişti' },
  });
  assert.match(w.document.getElementById('managerHelpStatus').textContent, /iletildi/);
});

test('WhatsApp shows the link message; with no channel at all the request goes to the managers', async () => {
  const sent = setup({
    '/api/password-reset/channels': () => [200, { channels: ['whatsapp', 'email'] }],
    '/api/password-reset/request': () => [200, { ok: true, channel: 'whatsapp', alternatives: ['email'] }],
  });
  sent.w.passwordRecoveryGate();
  await settle();
  assert.equal(sent.w.document.getElementById('haveSmsCode').hidden, true, 'no SMS here: no SMS shortcut');
  sent.w.document.getElementById('haveEmailCode').click();
  assert.equal(sent.w.document.getElementById('codeRecoveryForm').dataset.channel, 'email');
  sent.w.passwordRecoveryGate();
  await settle();
  sent.w.document.getElementById('recovery-account').value = 'mehmet';
  submit(sent.w, 'recoveryForm');
  await settle();
  assert.match(sent.w.document.getElementById('whatsappSentForm').textContent, /WhatsApp numaranıza/);
  assert.match(sent.w.document.querySelector('[data-fallback-open]').textContent, /WhatsApp mesajı gelmedi mi/);

  const none = setup({
    '/api/password-reset/channels': () => [200, { channels: [] }],
    '/api/password-reset/request': () => [200, { ok: true, channel: 'none', alternatives: [] }],
  });
  none.w.passwordRecoveryGate();
  await settle();
  assert.equal(none.w.document.querySelector('#recoveryForm [type="submit"]').textContent, 'Yöneticiden yeni şifre iste');
  none.w.document.getElementById('recovery-account').value = 'mehmet';
  submit(none.w, 'recoveryForm');
  await settle();
  assert.ok(none.w.document.getElementById('managerHelpForm'));
  assert.match(none.w.document.body.textContent, /henüz açık değil/);
});
