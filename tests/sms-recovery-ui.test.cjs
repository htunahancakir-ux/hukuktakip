const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

// Loads login-recovery.js with minimal stand-ins for the login screen it plugs into.
function setup(replies) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://buro.example.test/', runScripts: 'dangerously' });
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
  w.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    const [status, json] = replies[url](body);
    return { ok: status < 400, status, json: async () => json };
  };
  w.eval(fs.readFileSync('outputs/icrapro/login-recovery.js', 'utf8'));
  return { w, requests, logins };
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const submit = (w, id) => w.document.getElementById(id).dispatchEvent(new w.Event('submit', { cancelable: true }));

test('Şifremi unuttum with platform SMS: request, enter the temporary password, set a new one, signed in', async () => {
  const { w, requests, logins } = setup({
    '/api/password-reset/request': () => [200, { ok: true, channel: 'sms' }],
    '/api/password-reset/sms-complete': (body) =>
      body.code === '12345678' ? [200, { ok: true, username: 'mehmet' }] : [200, { ok: false, error: 'Geçici şifre hatalı veya süresi dolmuş. Yeni şifre isteyin.' }],
  });
  w.passwordRecoveryGate();
  assert.match(w.document.body.textContent, /SMS ile tek kullanımlık geçici şifre/);
  w.document.getElementById('recovery-account').value = '0532 123 45 67';
  submit(w, 'recoveryForm');
  await settle();
  assert.ok(w.document.getElementById('smsRecoveryForm'), 'SMS channel goes straight to the temporary-password step');
  assert.equal(w.document.getElementById('sms-account').value, '0532 123 45 67', 'account carried over');

  const fill = (code, password, confirm = password) => {
    w.document.getElementById('sms-code').value = code;
    w.document.getElementById('sms-password').value = password;
    w.document.getElementById('sms-confirm').value = confirm;
    submit(w, 'smsRecoveryForm');
  };
  fill('12345678', 'New-Password-123', 'Different-Password-1');
  await settle();
  assert.match(w.document.getElementById('smsRecoveryStatus').textContent, /aynı olmalıdır/);
  assert.equal(requests.length, 1, 'mismatch is caught before any request');

  fill('0000 0000', 'New-Password-123');
  await settle();
  assert.match(w.document.getElementById('smsRecoveryStatus').textContent, /hatalı veya süresi dolmuş/);
  assert.equal(requests.at(-1).body.code, '00000000', 'spaces removed');

  fill('12345678', 'New-Password-123');
  await settle();
  assert.deepEqual(requests.at(-1).body, { account: '0532 123 45 67', code: '12345678', password: 'New-Password-123' });
  assert.deepEqual(logins, [{ username: 'mehmet', password: 'New-Password-123' }], 'signed in with the new password');
});

test('WhatsApp channel keeps the link message; "SMS ile geçici şifre aldım" opens the code step directly', async () => {
  const { w } = setup({ '/api/password-reset/request': () => [200, { ok: true, channel: 'whatsapp' }] });
  w.passwordRecoveryGate();
  w.document.getElementById('recovery-account').value = 'mehmet';
  submit(w, 'recoveryForm');
  await settle();
  assert.match(w.document.getElementById('recoveryStatus').textContent, /WhatsApp/);
  assert.equal(w.document.getElementById('smsRecoveryForm'), null);
  w.document.getElementById('haveSmsCode').click();
  assert.ok(w.document.getElementById('smsRecoveryForm'));
  assert.equal(w.document.getElementById('sms-account').value, '');
});
