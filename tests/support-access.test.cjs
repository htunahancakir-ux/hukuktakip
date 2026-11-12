const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { createPlatformAdmin } = require('../lib/saas/platform-auth.cjs');
const { createOfficeSupport } = require('../lib/saas/office-support.cjs');
const { LEGACY_TENANT_ID } = require('../lib/saas/tenant-pool.cjs');
const { activeUsers } = require('../lib/seat-limit.cjs');
const access = require('../lib/saas/support-access.cjs');
const support = require('../lib/saas/support.cjs');

const operatorPassword = 'Synthetic-Support-Access-Test!';

async function setup(t) {
  const { pg, pool } = await database();
  const state = fixture();
  const base = state.users[0];
  state.users.push(
    { ...base, id: 'u-admin', username: 'yonetici', name: 'Yönetici', role: 'admin' },
    { ...base, id: 'u-staff', username: 'personel', name: 'Personel', role: 'staff' },
  );
  await importState(pool, state);
  const app = await serve(
    createApplication({
      store: createStore(pool),
      officeSupport: createOfficeSupport(pool, { tenantId: LEGACY_TENANT_ID }),
      supportAccess: access.createSupportAccess(pool, { tenantId: LEGACY_TENANT_ID }),
    }),
  );
  t.after(async () => {
    await app.close();
    await pg.close();
  });
  const operator = await createPlatformAdmin(pool, { username: 'root', name: 'Ayşe Operatör', password: operatorPassword });
  const headers = { 'X-Han-Request': '1', 'Content-Type': 'application/json' };
  const signIn = async (username) => {
    const login = await fetch(app.url + '/api/login', { method: 'POST', headers, body: JSON.stringify({ username, password }) });
    assert.equal(login.status, 200, username);
    return { ...headers, cookie: login.headers.get('set-cookie').split(';')[0] };
  };
  const call = async (auth, route, init = {}) => {
    const res = await fetch(app.url + route, { headers: auth, redirect: 'manual', ...init });
    const text = await res.text();
    let body = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
    return { status: res.status, body, headers: res.headers };
  };
  const post = (auth, route, data) => call(auth, route, { method: 'POST', body: JSON.stringify(data ?? {}) });
  // The console's "Büroya bağlan" → the office's entry link → a session cookie.
  const enter = async (ticketId, admin = { id: operator.id, totpEnabled: true }) => {
    const link = await access.connect(pool, admin, { ticketId });
    const res = await call(headers, link.path);
    return { res, link, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  return { pg, pool, app, operator, headers, signIn, call, post, enter };
}

test('support access: grant, connect once, read-only by default, time limits, extensions, ending', async (t) => {
  const { pool, operator, headers, signIn, call, post, enter } = await setup(t);
  const ceo = await signIn('test');
  const staff = await signIn('personel');

  const ticket = (await post(ceo, '/api/support', { subject: 'Rapor açılmıyor', body: 'Aylık rapor boş.' })).body;
  assert.ok(ticket.id);
  // Only CEO and admins may let the support team in.
  assert.equal((await post(staff, '/api/support-access/grant', { ticketId: ticket.id, minutes: 15 })).status, 403);
  assert.equal((await post(ceo, '/api/support-access/grant', { ticketId: ticket.id, minutes: 45 })).status, 400);
  const granted = await post(ceo, '/api/support-access/grant', { ticketId: ticket.id, minutes: 15 });
  assert.equal(granted.status, 200);
  assert.equal(granted.body.allowEdit, false);
  assert.ok(granted.body.accessId);

  // The support account is hidden from the office's users and its user count.
  const users = (await call(ceo, '/api/users')).body;
  assert.ok(!users.some((u) => u.id === access.SUPPORT_ACCOUNT_ID));
  const { rows: saved } = await pool.query('SELECT payload FROM han_private.han_state WHERE id = 1');
  const supportUser = saved[0].payload.users.find((u) => u.id === access.SUPPORT_ACCOUNT_ID);
  assert.equal(supportUser.platformSupport, true);
  assert.equal(supportUser.readOnly, true);
  assert.equal(activeUsers(saved[0].payload), 3);
  // It can never sign in with a password.
  assert.equal((await post(headers, '/api/login', { username: 'hukuktakip-destek', password })).status, 401);

  let status = (await call(ceo, '/api/support-access/status')).body;
  assert.equal(status.access.state, 'pending');
  assert.equal(status.access.canDecide, true);
  assert.equal((await call(staff, '/api/support-access/status')).body.access, null, 'staff do not see it');

  // Operators need two-step sign-in to connect.
  await assert.rejects(access.connect(pool, { id: operator.id, totpEnabled: false }, { ticketId: ticket.id }), (e) => e.status === 403);
  assert.equal((await call(headers, '/api/support-access/enter?code=' + 'a'.repeat(64))).status, 403);
  const first = await enter(ticket.id);
  assert.equal(first.res.status, 302);
  assert.equal(first.res.headers.get('location'), '/');
  const team = { ...headers, cookie: first.cookie };
  assert.equal((await call(headers, first.link.path)).status, 403, 'a code works once');

  const session = (await call(team, '/api/session')).body.user;
  assert.equal(session.platformSupport, true);
  assert.equal(session.readOnly, true);
  assert.equal(session.name, 'Hukuk Takip Platformu Destek');
  // Read-only: it can look but not change anything, and never opens tickets or grants.
  assert.equal((await call(team, '/api/users')).status, 200);
  assert.equal((await post(team, '/api/users', { name: 'X', username: 'xx', password: 'Uzun-Sifre-12345', role: 'staff' })).status, 403);
  assert.equal((await post(team, '/api/support', { subject: 'abc', body: 'x' })).status, 403);
  assert.equal((await post(team, '/api/support-access/grant', { ticketId: ticket.id, minutes: 60, allowEdit: true })).status, 403);
  assert.equal((await call(team, '/api/support-access/status')).body.self.state, 'connected');

  status = (await call(ceo, '/api/support-access/status')).body;
  assert.equal(status.access.state, 'connected');
  assert.ok(status.access.remainingSeconds > 800 && status.access.remainingSeconds <= 900);

  // +15 minutes once, and only near the end.
  await assert.rejects(access.extend(pool, operator.id, { ticketId: ticket.id }), (e) => e.status === 409);
  await pool.query("UPDATE han_saas.support_access SET deadline = CURRENT_TIMESTAMP + interval '2 minutes' WHERE id = $1", [granted.body.accessId]);
  const extended = await access.extend(pool, operator.id, { ticketId: ticket.id });
  assert.ok(new Date(extended.deadline).getTime() > Date.now() + 16 * 60000);
  await assert.rejects(access.extend(pool, operator.id, { ticketId: ticket.id }), (e) => e.status === 409);
  const { rows: sessions } = await pool.query('SELECT expires_at FROM han_private.han_sessions WHERE account_id = $1', [access.SUPPORT_ACCOUNT_ID]);
  assert.equal(Number(sessions[0].expires_at), new Date(extended.deadline).getTime(), 'the session follows the deadline');

  // Time is up: the session is gone by itself.
  await pool.query("UPDATE han_saas.support_access SET deadline = CURRENT_TIMESTAMP - interval '1 minute' WHERE id = $1", [granted.body.accessId]);
  await pool.query('UPDATE han_private.han_sessions SET expires_at = $2 WHERE account_id = $1', [access.SUPPORT_ACCOUNT_ID, Date.now() - 60000]);
  assert.equal((await call(team, '/api/session')).body.user ?? null, null);
  assert.equal((await call(ceo, '/api/support-access/status')).body.access.state, 'overtime');

  // More time is asked of the office; the person who decides sees it and approves.
  await access.requestExtension(pool, operator.id, { ticketId: ticket.id, minutes: 30, note: 'Rapor kuralını düzeltiyorum' });
  status = (await call(ceo, '/api/support-access/status')).body;
  assert.deepEqual([status.access.extensionRequest.minutes, status.access.extensionRequest.note], [30, 'Rapor kuralını düzeltiyorum']);
  assert.equal((await post(staff, `/api/support-access/${granted.body.accessId}/extension`, { approve: true })).status, 403);
  assert.equal((await post(ceo, `/api/support-access/${granted.body.accessId}/extension`, { approve: true })).status, 200);
  assert.equal((await call(team, '/api/session')).body.user?.platformSupport, true, 'the same session is valid again');
  status = (await call(ceo, '/api/support-access/status')).body;
  assert.equal(status.access.extensionRequest, null);
  assert.ok(status.access.remainingSeconds > 28 * 60);

  // "Sorun çözüldü, test edin" reaches the office; the office confirms.
  await support.addMessage(pool, operator.id, { ticketId: ticket.id, kind: 'operator', body: 'Sorun çözüldü, lütfen test edin.', status: 'waiting_customer' });
  status = (await call(ceo, '/api/support-access/status')).body;
  assert.equal(status.answered[0].ticketId, ticket.id);
  assert.equal(status.answered[0].reply, 'Sorun çözüldü, lütfen test edin.');
  assert.equal((await post(ceo, `/api/support/${ticket.id}/resolved`)).body.status, 'resolved');

  // "Erişimi sonlandır": out at once, and the link no longer opens.
  assert.equal((await post(ceo, `/api/support-access/${granted.body.accessId}/end`)).status, 200);
  assert.equal((await call(team, '/api/session')).body.user ?? null, null);
  await assert.rejects(access.connect(pool, { id: operator.id, totpEnabled: true }, { ticketId: ticket.id }), (e) => e.status === 409);
  const history = (await access.ticketAccess(pool, ticket.id)).access;
  assert.equal(history[0].status, 'revoked');
  assert.equal(history[0].connectedBy, 'Ayşe Operatör');

  // The office's audit names the support team.
  const { rows: audit } = await pool.query("SELECT actor_name, category FROM han_private.han_audit WHERE actor_name LIKE 'Hukuk Takip%'");
  assert.ok(audit.some((r) => r.category === 'login'));
});

test('support access: edit permission, staff tickets, lapsed offers and wrong office', async (t) => {
  const { pool, operator, headers, signIn, call, post, enter } = await setup(t);
  const ceo = await signIn('test');
  const staff = await signIn('personel');

  // Staff open tickets and see only their own; managers see all.
  const mine = (await post(staff, '/api/support', { subject: 'Şifremi değiştiremiyorum', body: 'Hata veriyor.' })).body;
  const theirs = (await post(ceo, '/api/support', { subject: 'Yönetim sorusu', body: 'Soru.' })).body;
  assert.deepEqual((await call(staff, '/api/support')).body.tickets.map((x) => x.id), [mine.id]);
  assert.equal((await call(staff, '/api/support/' + theirs.id)).status, 404);
  assert.equal((await call(ceo, '/api/support')).body.tickets.length, 2);

  // With "değişiklik yapabilir" the team can write (an admin, never a deleter).
  const granted = (await post(ceo, '/api/support-access/grant', { ticketId: mine.id, minutes: 30, allowEdit: true })).body;
  const { cookie } = await enter(mine.id);
  const team = { ...headers, cookie };
  const session = (await call(team, '/api/session')).body.user;
  assert.equal(session.readOnly, false);
  assert.equal(session.canDelete, false);
  assert.equal(session.role, 'admin');

  // A new grant replaces the open one and ends its connection.
  const again = (await post(ceo, '/api/support-access/grant', { ticketId: theirs.id, minutes: 15 })).body;
  assert.notEqual(again.accessId, granted.accessId);
  assert.equal((await call(team, '/api/session')).body.user ?? null, null);
  assert.equal((await access.ticketAccess(pool, mine.id)).access[0].endedBy, 'Yeni izin verildi');

  // An offer nobody used lapses after 24 hours.
  await pool.query("UPDATE han_saas.support_access SET offer_until = CURRENT_TIMESTAMP - interval '1 minute' WHERE id = $1", [again.accessId]);
  assert.equal((await call(ceo, '/api/support-access/status')).body.access, null);
  await assert.rejects(access.connect(pool, { id: operator.id, totpEnabled: true }, { ticketId: theirs.id }), (e) => e.status === 409);

  // A code for one office does not open another.
  const grant3 = (await post(ceo, '/api/support-access/grant', { ticketId: theirs.id, minutes: 15 })).body;
  assert.ok(grant3.accessId);
  const link = await access.connect(pool, { id: operator.id, totpEnabled: true }, { ticketId: theirs.id });
  const other = access.createSupportAccess(pool, { tenantId: '00000000-0000-4000-8000-0000000000aa' });
  await assert.rejects(other.enter(link.code), (e) => e.status === 403);
  // An expired code does not open either.
  await pool.query("UPDATE han_saas.support_access_codes SET expires_at = CURRENT_TIMESTAMP - interval '1 second'");
  assert.equal((await call(headers, link.path)).status, 403);
});
