const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { createBrevoEmail, maskEmail } = require('../lib/brevo-email.cjs');
const platformEmail = require('../lib/saas/platform-email.cjs');
const { createPlatformAdmin } = require('../lib/saas/platform-auth.cjs');
const platform = require('../lib/saas/platform.cjs');

process.env.PLATFORM_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('hex');
const API_KEY = 'xkeysib-synthetic-brevo-key-for-tests';
const opPassword = 'Synthetic-Platform-Email-Test!';

// A stand-in for api.brevo.com that records every call.
function fakeBrevo({ status = 200, body, domains = [{ domain_name: 'hanhukuktakip.com', authenticated: true, verified: true }] } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const path = new URL(url).pathname;
    const reply = (s, json) => ({ ok: s < 400, status: s, text: async () => JSON.stringify(json) });
    if (status !== 200) return reply(status, body || {});
    if (path === '/v3/account') return reply(200, { email: 'ops@example.test', plan: [{ type: 'free', creditsType: 'sendLimit', credits: 297 }] });
    if (path === '/v3/senders/domains') return reply(200, { domains, count: domains.length });
    if (path === '/v3/smtp/email') return reply(201, { messageId: '<2026.1@smtp-relay.example>' });
    return reply(404, {});
  };
  return { calls, fetcher, sent: () => calls.filter((c) => c.url.endsWith('/smtp/email')) };
}

test('Brevo client sends the documented JSON and explains key, IP, credit and sender errors', async () => {
  const ok = fakeBrevo();
  const client = createBrevoEmail({ apiKey: API_KEY, fetcher: ok.fetcher });
  assert.deepEqual(
    await client.send({
      sender: { email: 'NoReply@HanHukukTakip.com', name: 'Deneme <Hukuk>\nBürosu' },
      to: ' Ali@Example.com ',
      toName: 'Ali',
      subject: 'Konu',
      html: '<p>x</p>',
      text: 'x',
      tags: ['test'],
    }),
    { messageId: '<2026.1@smtp-relay.example>' },
  );
  const sent = ok.sent()[0];
  assert.equal(sent.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(sent.method, 'POST');
  assert.equal(sent.headers['api-key'], API_KEY);
  assert.deepEqual(sent.body, {
    sender: { email: 'noreply@hanhukuktakip.com', name: 'Deneme  Hukuk  Bürosu'.replace(/\s+/g, ' ') },
    to: [{ email: 'ali@example.com', name: 'Ali' }],
    subject: 'Konu',
    htmlContent: '<p>x</p>',
    textContent: 'x',
    tags: ['test'],
  });
  assert.deepEqual(await client.account(), { email: 'ops@example.test', plan: 'free', credits: 297 });
  assert.deepEqual(await client.domains(), [{ name: 'hanhukuktakip.com', authenticated: true, verified: true }]);
  await assert.rejects(() => client.send({ sender: { email: 'noreply@hanhukuktakip.com' }, to: 'not-an-address' }), (e) => e.status === 400);
  assert.equal(maskEmail('Ali.Veli@Example.com'), 'al***@example.com');

  const ip = createBrevoEmail({ apiKey: API_KEY, fetcher: fakeBrevo({ status: 401, body: { code: 'unauthorized', message: 'unrecognised IP address 185.0.0.1' } }).fetcher });
  await assert.rejects(() => ip.account(), (e) => e.code === 'UNAUTHORIZED' && /IP adresine izin/.test(e.message));
  const key = createBrevoEmail({ apiKey: 'x', fetcher: fakeBrevo({ status: 401, body: { code: 'unauthorized', message: 'Key not found' } }).fetcher });
  await assert.rejects(() => key.account(), (e) => e.code === 'UNAUTHORIZED' && /anahtar/.test(e.message));
  const credits = createBrevoEmail({ apiKey: API_KEY, fetcher: fakeBrevo({ status: 400, body: { code: 'not_enough_credits', message: 'Not enough credits' } }).fetcher });
  await assert.rejects(() => credits.send({ sender: { email: 'a@b.co' }, to: 'c@d.co', subject: 's', html: 'h', text: 't' }), (e) => e.code === 'NO_CREDITS');
  const sender = createBrevoEmail({ apiKey: API_KEY, fetcher: fakeBrevo({ status: 400, body: { code: 'invalid_parameter', message: 'Sender is invalid / inactive' } }).fetcher });
  await assert.rejects(() => sender.send({ sender: { email: 'a@b.co' }, to: 'c@d.co', subject: 's', html: 'h', text: 't' }), (e) => e.code === 'SENDER');
  const down = createBrevoEmail({ apiKey: API_KEY, fetcher: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(() => down.account(), (e) => e.status === 502);
  assert.throws(() => createBrevoEmail({ apiKey: '' }), (e) => e.status === 412);
});

test('platform e-mail settings are sealed, testable before saving, logged masked and capped per office', async () => {
  const { pg, pool } = await database();
  try {
    const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Op', password: opPassword })).id;
    const fake = fakeBrevo();
    const empty = await platformEmail.getSettings(pool);
    assert.deepEqual([empty.configured, empty.enabled, empty.senderEmail], [false, false, 'noreply@hanhukuktakip.com']);
    await assert.rejects(() => platformEmail.sendEmail(pool, { to: 'a@b.co', subject: 's', html: 'h', text: 't', purpose: 'test' }, { fetcher: fake.fetcher }), (e) => e.status === 412);
    await assert.rejects(() => platformEmail.saveSettings(pool, op, { apiKey: 'xsmtpsib-wrong-kind' }), (e) => e.status === 400 && /SMTP/.test(e.message));

    // Test with the typed key before anything is saved; an unauthenticated domain is reported.
    const tested = await platformEmail.testSettings(pool, { apiKey: API_KEY }, { fetcher: fake.fetcher });
    assert.deepEqual(tested.domain, { name: 'hanhukuktakip.com', authenticated: true, verified: true });
    const pending = await platformEmail.testSettings(pool, { apiKey: API_KEY }, { fetcher: fakeBrevo({ domains: [{ domain_name: 'hanhukuktakip.com', authenticated: false }] }).fetcher });
    assert.equal(pending.domain.authenticated, false);
    const absent = await platformEmail.testSettings(pool, { apiKey: API_KEY, senderEmail: 'noreply@baska.example' }, { fetcher: fake.fetcher });
    assert.equal(absent.domain.missing, true);

    const saved = await platformEmail.saveSettings(pool, op, { apiKey: API_KEY, enabled: true });
    assert.deepEqual([saved.configured, saved.enabled, saved.senderEmail], [true, true, 'noreply@hanhukuktakip.com']);
    const raw = JSON.stringify((await pool.query("SELECT value FROM han_saas.platform_settings WHERE key = 'email'")).rows[0].value);
    assert.ok(!raw.includes(API_KEY), 'API key is sealed at rest');
    assert.ok(!JSON.stringify(await platformEmail.getSettings(pool)).includes(API_KEY), 'and never returned');

    const office = (
      await platform.openOffice(pool, op, {
        slug: 'eposta-buro', name: 'E-posta Büro', admin: { name: 'Y', username: 'y', password: opPassword },
        userCount: 2, userPriceKurus: 1000, termMonths: 1, moduleCodes: [], paid: true,
      })
    ).office;
    const sender = platformEmail.createPlatformEmail(pool, { tenantId: office.id, fetcher: fake.fetcher, cacheMs: 0 });
    assert.equal(await sender.available(), true);
    await sender.send({ to: 'kisi@example.com', subject: 'Kod', html: '<p>12345678</p>', text: '12345678', fromName: 'E-posta Büro' });
    const last = fake.sent().at(-1).body;
    assert.deepEqual(last.sender, { email: 'noreply@hanhukuktakip.com', name: 'E-posta Büro' }, "the office's own name");
    const settings = await platformEmail.getSettings(pool);
    assert.equal(settings.usage.monthSent, 1);
    assert.equal(settings.recent[0].dest, 'ki***@example.com', 'addresses are stored masked');
    assert.equal(settings.recent[0].office, 'E-posta Büro');
    const stored = JSON.stringify((await pool.query('SELECT * FROM han_saas.email_log')).rows);
    assert.ok(!stored.includes('12345678') && !stored.includes('kisi@example.com'), 'no message text or full address stored');

    for (let i = 1; i < platformEmail.DAILY_LIMIT_PER_OFFICE; i++)
      await sender.send({ to: 'kisi@example.com', subject: 's', html: 'h', text: 't' });
    await assert.rejects(() => sender.send({ to: 'kisi@example.com', subject: 's', html: 'h', text: 't' }), (e) => e.status === 429);
    assert.equal(fake.sent().length, platformEmail.DAILY_LIMIT_PER_OFFICE, 'the blocked one never reached Brevo');

    await platformEmail.saveSettings(pool, op, { enabled: false });
    assert.equal(await sender.available(), false, 'switching it off stops recovery e-mail');
    await platformEmail.saveSettings(pool, op, { clear: true });
    assert.equal((await platformEmail.getSettings(pool)).configured, false);
  } finally {
    await pg.close();
  }
});

// One office on PostgreSQL with stand-ins for the platform's SMS and e-mail services.
async function office(t, { state = fixture(), sms = false, email = true, smtp } = {}) {
  const { pg, pool } = await database();
  await importState(pool, state);
  const mails = [];
  const texts = [];
  const pending = [];
  const app = await serve(
    createApplication({
      store: createStore(pool),
      platformSms: { available: async () => sms, send: async (job) => texts.push(job) },
      platformEmail: { available: async () => email, send: async (job) => mails.push(job) },
      // The server's own SMTP sender (lib/recovery-email.cjs); none unless a test passes one.
      recoveryEmail: smtp ? { send: async (job) => smtp.push(job) } : null,
      background: (promise) => pending.push(promise),
    }),
  );
  t.after(async () => {
    await app.close();
    await pg.close();
  });
  const call = async (route, body, { cookie, method = body === undefined ? 'GET' : 'POST' } = {}) => {
    const res = await fetch(app.url + route, {
      method,
      headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json', ...(cookie && { cookie }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await res.json().catch(() => ({}));
    await Promise.all(pending);
    return { status: res.status, body: json, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = async (username, secret = password) =>
    (await call('/api/login', { username, password: secret, replaceSessions: true })).cookie;
  const readState = async () => createStore(pool).readState();
  return { call, login, mails, texts, readState };
}
const codeIn = (mail, digits) => new RegExp(`\\b(\\d{${digits}})\\b`).exec(mail.text)[1];
// A staff account with the fixture's password and no contact details of its own.
const staffUser = (base, extra = {}) => ({
  id: 'staff-ali',
  name: 'Ali Veli',
  username: 'ali',
  role: 'staff',
  active: true,
  permissions: [],
  salt: base.salt,
  hash: base.hash,
  ...extra,
});

test('Şifremi unuttum by e-mail: a reset code goes only to an address verified in a signed-in session', async (t) => {
  const state = fixture();
  state.users[0].email = 'Test@Example.com';
  const o = await office(t, { state });
  const newPassword = 'New-Synthetic-Password-1';

  // Only e-mail is open. An address nobody verified gets nothing, by address or by username;
  // the answer is the same as for any other account.
  const byAddress = await o.call('/api/password-reset/request', { account: 'test@example.com' });
  assert.deepEqual(byAddress.body, { ok: true, channel: 'email', alternatives: [] });
  const byName = await o.call('/api/password-reset/request', { account: 'test' });
  assert.deepEqual(byName.body, byAddress.body, 'the answer never reveals whether the account exists');
  assert.equal(o.mails.length, 0, 'saving an address does not make it a recovery address');

  // The owner verifies it in Hesabım: a 6-digit code to the address, entered with the current password.
  const ceo = await o.login('test');
  const sent = await o.call('/api/email-verification/send', {}, { cookie: ceo });
  assert.deepEqual(sent.body, { ok: true, sentTo: 'te***@example.com', email: { sent: true } });
  const verifyMail = o.mails[0];
  assert.deepEqual([verifyMail.to, verifyMail.purpose, verifyMail.fromName], ['test@example.com', 'email_verification', 'Han Hukuk']);
  assert.match(verifyMail.subject, /E-posta doğrulama kodu/);
  const verifyCode = codeIn(verifyMail, 6);
  assert.ok(!JSON.stringify(await o.readState()).includes(verifyCode), 'only a hash is stored');
  // The verification code is worth nothing on the sign-in screen.
  const onLogin = await o.call('/api/password-reset/email-complete', { account: 'test', code: verifyCode, password: newPassword });
  assert.equal(onLogin.body.ok, false);
  assert.equal((await o.readState()).users[0].emailVerified, undefined);
  // An open session alone is not enough: the current password is asked.
  assert.equal((await o.call('/api/email-verification/confirm', { code: verifyCode }, { cookie: ceo })).status, 403);
  assert.equal((await o.call('/api/email-verification/confirm', { code: verifyCode, password: 'Wrong-Synthetic-Pass-0' }, { cookie: ceo })).status, 403);
  const confirmed = await o.call('/api/email-verification/confirm', { code: verifyCode, password }, { cookie: ceo });
  assert.deepEqual([confirmed.body.ok, confirmed.body.emailVerified], [true, true]);
  assert.equal((await o.readState()).users[0].emailVerified.address, 'test@example.com');

  // Verified now: the address names the account and gets the 8-digit reset code.
  await o.call('/api/password-reset/request', { account: 'TEST@example.com' });
  assert.equal(o.mails.length, 2);
  assert.equal(o.mails[1].purpose, 'password_recovery');
  assert.match(o.mails[1].subject, /Şifre yenileme kodu/);
  const wrong = await o.call('/api/password-reset/email-complete', { account: 'test', code: '00000000', password: newPassword });
  assert.equal(wrong.body.ok, false);
  const done = await o.call('/api/password-reset/email-complete', { account: 'test', code: codeIn(o.mails[1], 8), password: newPassword });
  assert.deepEqual(done.body, { ok: true, username: 'test' });
  assert.equal((await o.call('/api/login', { username: 'test', password })).status, 401, 'old password is gone');
  assert.equal((await o.call('/api/login', { username: 'test', password: newPassword })).status, 200);
  const reused = await o.call('/api/password-reset/email-complete', { account: 'test', code: codeIn(o.mails[1], 8), password: 'Another-Synthetic-Pass-2' });
  assert.equal(reused.body.ok, false, 'a code works once');
});

test('an address verified by the first e-mail recovery release stays verified; a changed one does not', async (t) => {
  const state = fixture();
  state.users[0].email = 'test@example.com';
  state.users[0].recoveryEmail = 'test@example.com';
  const o = await office(t, { state });
  const ceo = await o.login('test');
  assert.equal((await o.call('/api/account/contact', undefined, { cookie: ceo })).body.emailVerified, true);
  await o.call('/api/password-reset/request', { account: 'test@example.com' });
  assert.equal(o.mails.at(-1).purpose, 'password_recovery');
  const changed = await o.call('/api/account/contact', { email: 'yeni@example.com', mobilePhone: '' }, { cookie: ceo, method: 'PUT' });
  assert.equal(changed.body.emailVerified, false);
  const before = o.mails.length;
  await o.call('/api/password-reset/request', { account: 'test' });
  assert.equal(o.mails.length, before, 'the new address has to be verified first');
});

test('while the platform account is off, the server’s own SMTP sender carries the same e-mails', async (t) => {
  const state = fixture();
  state.users[0].email = 'test@example.com';
  state.users[0].emailVerified = { address: 'test@example.com', at: new Date().toISOString() };
  const smtp = [];
  const o = await office(t, { state, email: false, smtp });
  assert.deepEqual((await o.call('/api/password-reset/channels')).body.channels, ['email']);
  await o.call('/api/password-reset/request', { account: 'test' });
  assert.equal(o.mails.length, 0, 'the platform account is switched off');
  assert.equal(smtp.length, 1);
  assert.deepEqual([smtp[0].to, smtp[0].fromName], ['test@example.com', 'Han Hukuk'], 'under the office’s own name');
  assert.match(smtp[0].text, /\b\d{8}\b/);

  // Neither sender: e-mail is not offered at all.
  const none = await office(t, { state: structuredClone(state), email: false });
  assert.deepEqual((await none.call('/api/password-reset/channels')).body.channels, []);
});

test('the office picks the first way; the others stay offered; a channel that is not open is refused', async (t) => {
  const state = fixture();
  state.users[0].email = 'test@example.com';
  state.users[0].emailVerified = { address: 'test@example.com', at: new Date().toISOString() };
  state.users[0].mobilePhone = '905321234567';
  state.users.push(staffUser(state.users[0]));
  const o = await office(t, { state, sms: true, email: true });
  // SMS here is the platform's service; the office has no SMS or WhatsApp of its own.
  assert.deepEqual((await o.call('/api/password-reset/channels')).body, {
    channels: ['sms', 'email'],
    tested: { sms: false, whatsapp: false },
  });

  const first = await o.call('/api/password-reset/request', { account: 'test' });
  assert.deepEqual(first.body, { ok: true, channel: 'sms', alternatives: ['email'] }, 'SMS before e-mail by default');
  assert.equal(o.texts.length, 1);
  const chosen = await o.call('/api/password-reset/request', { account: 'test', channel: 'email' });
  assert.deepEqual(chosen.body, { ok: true, channel: 'email', alternatives: ['sms'] }, '"SMS gelmedi": the user picks e-mail');
  assert.equal(o.mails.length, 1);
  assert.equal((await o.call('/api/password-reset/request', { account: 'test', channel: 'whatsapp' })).status, 409);

  const ceo = await o.login('test');
  const staff = await o.login('ali');
  assert.equal((await o.call('/api/recovery/settings', { primary: 'email' }, { cookie: staff, method: 'PUT' })).status, 403);
  assert.equal((await o.call('/api/recovery/settings', { primary: 'whatsapp' }, { cookie: ceo, method: 'PUT' })).status, 409, 'not set up');
  const saved = await o.call('/api/recovery/settings', { primary: 'email' }, { cookie: ceo, method: 'PUT' });
  assert.deepEqual(saved.body.order, ['email', 'sms']);
  assert.deepEqual(saved.body.accounts, { total: 2, verified: 1, unverified: 0, missing: 1 });
  assert.deepEqual(
    [saved.body.officeSms, saved.body.configured, saved.body.tested],
    [false, { sms: false, whatsapp: false }, { sms: false, whatsapp: false }],
  );
  assert.deepEqual((await o.call('/api/password-reset/channels')).body.channels, ['email', 'sms']);
  assert.equal((await o.call('/api/password-reset/request', { account: 'test' })).body.channel, 'email');
});

test('e-mail verification from the account screen: a 6-digit code, a tick, gone again when the address changes', async (t) => {
  const state = fixture();
  state.users.push(staffUser(state.users[0], { email: 'ali@example.com' }));
  const o = await office(t, { state });
  const ceo = await o.login('test');
  const ali = await o.login('ali');

  const before = await o.call('/api/account/contact', undefined, { cookie: ali });
  assert.deepEqual([before.body.emailVerified, before.body.emailVerification], [false, true]);
  assert.equal((await o.call('/api/email-verification/send', {}, { cookie: ceo })).status, 409, 'the CEO has no address yet');
  assert.equal((await o.call('/api/email-verification/send', { userId: 'test-ceo' }, { cookie: ali })).status, 403, 'staff verify only their own');

  // A manager starts it for a staff account; the person reads out or enters the code.
  const sent = await o.call('/api/email-verification/send', { userId: 'staff-ali' }, { cookie: ceo });
  assert.deepEqual(sent.body, { ok: true, sentTo: 'al***@example.com', email: { sent: true } });
  const code = codeIn(o.mails.at(-1), 6);
  assert.equal(o.mails.at(-1).purpose, 'email_verification');
  assert.equal((await o.call('/api/email-verification/confirm', { code: '111111', password }, { cookie: ali })).body.ok, false);
  assert.equal((await o.call('/api/email-verification/confirm', { code }, { cookie: ali })).status, 403, 'the owner’s password is asked');
  const confirmed = await o.call('/api/email-verification/confirm', { code, password }, { cookie: ali });
  assert.deepEqual([confirmed.body.ok, confirmed.body.emailVerified, confirmed.body.emailVerification], [true, true, true]);
  const users = (await o.call('/api/users', undefined, { cookie: ceo })).body;
  assert.equal(users.find((u) => u.id === 'staff-ali').emailVerified, true, 'the tick on Kullanıcı Yönetimi');
  assert.equal((await o.call('/api/email-verification/send', {}, { cookie: ali })).status, 409, 'already verified');

  const changed = await o.call('/api/account/contact', { email: 'yeni@example.com', mobilePhone: '' }, { cookie: ali, method: 'PUT' });
  assert.equal(changed.body.emailVerified, false, 'a new address must be verified again');

  // Bulk: every unverified address gets one code; a second run within a day sends nothing.
  const bulk = await o.call('/api/email-verification/send-all', {}, { cookie: ceo });
  assert.deepEqual([bulk.body.queued, bulk.body.missing], [1, 1]);
  const again = await o.call('/api/email-verification/send-all', {}, { cookie: ceo });
  assert.deepEqual([again.body.queued, again.body.recent], [0, 1]);
  // The manager enters the code the person reads out, without that person's password.
  const read = await o.call('/api/email-verification/confirm', { userId: 'staff-ali', code: codeIn(o.mails.at(-1), 6) }, { cookie: ceo });
  assert.deepEqual([read.body.ok, read.body.emailVerified], [true, true]);
  assert.equal((await o.call('/api/email-verification/send-all', {}, { cookie: ali })).status, 403);
});

test('Yöneticiden iste: the request reaches the managers, who set a password and send it', async (t) => {
  const state = fixture();
  state.users.push(staffUser(state.users[0]));
  const o = await office(t, { state, sms: true });
  const unknown = await o.call('/api/password-reset/ask-manager', { account: 'nobody', note: '' });
  const asked = await o.call('/api/password-reset/ask-manager', { account: 'ali', note: 'Telefonum değişti: 0555 000 00 00' });
  assert.deepEqual(unknown.body, asked.body, 'same answer for every account');
  assert.equal((await o.call('/api/password-reset/ask-manager', { account: 'ali', note: 'x'.repeat(301) })).status, 400);
  await o.call('/api/password-reset/ask-manager', { account: 'ali' });

  const saved = await o.readState();
  assert.equal(saved.passwordHelp.length, 1, 'one open request per account');
  const message = saved.messages.find((m) => m.systemType === 'passwordHelp');
  assert.deepEqual(message.recipientIds, ['test-ceo']);
  assert.equal(message.senderId, 'staff-ali');
  assert.match(message.text, /Telefonum değişti/);
  assert.equal(saved.workflowNotices.find((n) => n.type === 'passwordHelp').helpUserId, 'staff-ali');

  const ceo = await o.login('test');
  const list = (await o.call('/api/password-help', undefined, { cookie: ceo })).body;
  assert.equal(list.requests.length, 1);
  assert.deepEqual([list.requests[0].username, list.delivery], ['ali', { sms: true, email: true }]);

  const temporary = 'Manager-Set-Password-9';
  const noPhone = await o.call('/api/users/password', { id: 'staff-ali', password: temporary, deliver: 'sms' }, { cookie: ceo });
  assert.equal(noPhone.status, 409, 'no registered mobile: nothing changes');
  await o.call('/api/users/contact', { id: 'staff-ali', email: 'ali@example.com', mobilePhone: '' }, { cookie: ceo, method: 'PUT' });
  const delivered = await o.call('/api/users/password', { id: 'staff-ali', password: temporary, deliver: 'email' }, { cookie: ceo });
  assert.deepEqual(delivered.body.email, { sent: true });
  const mail = o.mails.at(-1);
  assert.deepEqual([mail.to, mail.purpose], ['ali@example.com', 'password_delivery']);
  assert.ok(mail.text.includes(temporary) && mail.text.includes('ali'), 'the new password and the username');
  assert.equal((await o.call('/api/password-help', undefined, { cookie: ceo })).body.requests.length, 0, 'the request closed');
  assert.equal((await o.call('/api/login', { username: 'ali', password: temporary })).status, 200);
});
