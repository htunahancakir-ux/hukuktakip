const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { createPlatformAdmin } = require('../lib/saas/platform-auth.cjs');
const { createOfficeSupport, MAX_OPEN } = require('../lib/saas/office-support.cjs');
const support = require('../lib/saas/support.cjs');
const platform = require('../lib/saas/platform.cjs');

const secret = 'Synthetic-Office-Support-Test!';
const hostile = '<img src=x onerror="window.pwned=1">';

async function twoOffices(pool) {
  const op = (await createPlatformAdmin(pool, { username: 'root', name: 'Ayşe Operatör', password: secret })).id;
  const open = async (slug) =>
    (
      await platform.openOffice(pool, op, {
        slug,
        name: slug.toUpperCase() + ' Hukuk',
        admin: { name: 'Y', username: slug, password: secret },
        userCount: 2,
        userPriceKurus: 1000,
        termMonths: 1,
        moduleCodes: [],
        paid: true,
      })
    ).office.id;
  return { op, a: await open('buro-a'), b: await open('buro-b') };
}

test('an office opens a ticket, the operator answers, and neither side sees what it should not', async () => {
  const { pg, pool } = await database();
  try {
    const { op, a, b } = await twoOffices(pool);
    const deskA = createOfficeSupport(pool, { tenantId: a });
    const deskB = createOfficeSupport(pool, { tenantId: b });
    const user = { id: 'u-mehmet', name: 'Mehmet Avukat', username: 'mehmet', role: 'ceo' };

    const opened = await deskA.open(user, { subject: 'Rapor açılmıyor ' + hostile, body: 'Aylık rapor boş geliyor.', category: 'technical', priority: 'high' });
    assert.ok(opened.id && opened.number >= 1);

    // The operator console sees it as a portal ticket from that office, with the customer message.
    const console_ = await support.listTickets(pool);
    const seen = console_.tickets.find((t) => t.id === opened.id);
    assert.equal(seen.channel, 'portal');
    assert.equal(seen.tenantId, a);
    assert.equal(seen.contactName, 'Mehmet Avukat');
    assert.equal(seen.priority, 'high');
    const operatorView = await support.ticketDetail(pool, { ticketId: opened.id });
    assert.equal(operatorView.messages[0].kind, 'customer');
    assert.equal(operatorView.messages[0].author, 'Mehmet Avukat', 'portal messages carry the office user name');

    // Operator replies, writes an internal note and changes the priority (a system line).
    await support.addMessage(pool, op, { ticketId: opened.id, kind: 'operator', body: 'Sorunu inceliyoruz.' });
    await support.addMessage(pool, op, { ticketId: opened.id, kind: 'internal', body: 'GİZLİ iç not' });
    await support.setPriority(pool, op, { ticketId: opened.id, priority: 'urgent' });

    const view = await deskA.detail(opened.id);
    assert.deepEqual(view.messages.map((m) => [m.from, m.author, m.body]), [
      ['office', 'Mehmet Avukat', 'Aylık rapor boş geliyor.'],
      ['support', 'Destek ekibi', 'Sorunu inceliyoruz.'],
    ]);
    assert.ok(!JSON.stringify(view).match(/GİZLİ|Ayşe|Öncelik:|internal|system/), 'no internal note, audit line or operator name');
    assert.equal(view.ticket.status, 'waiting_customer');
    assert.equal(view.ticket.answered, true);

    // Another office can neither read nor write to it, nor list it.
    await assert.rejects(() => deskB.detail(opened.id), (e) => e.status === 404);
    await assert.rejects(() => deskB.reply(user, opened.id, { body: 'x' }), (e) => e.status === 404);
    assert.deepEqual((await deskB.list()).tickets, []);
    assert.equal((await deskA.list()).tickets.length, 1);

    // A reply from the office reopens a resolved ticket; a closed one stays closed.
    await support.setStatus(pool, op, { ticketId: opened.id, status: 'resolved' });
    await deskA.reply(user, opened.id, { body: 'Hâlâ aynı.' });
    assert.equal((await deskA.detail(opened.id)).ticket.status, 'open');
    await support.setStatus(pool, op, { ticketId: opened.id, status: 'closed' });
    await assert.rejects(() => deskA.reply(user, opened.id, { body: 'x' }), (e) => e.status === 409);
  } finally {
    await pg.close();
  }
});

test('office input is validated and an office cannot flood the queue', async () => {
  const { pg, pool } = await database();
  try {
    const { a } = await twoOffices(pool);
    const desk = createOfficeSupport(pool, { tenantId: a });
    const user = { id: 'u-m', name: 'Mehmet', username: 'm', role: 'admin' };
    for (const bad of [
      { subject: 'a', body: 'x' },
      { subject: 'Geçerli konu', body: '' },
      { subject: 'Geçerli konu', body: 'x', priority: 'urgent' },
      { subject: 'Geçerli konu', body: 'x', category: 'sales' },
      { subject: 'x'.repeat(161), body: 'x' },
      { subject: 'Geçerli konu', body: 'x'.repeat(5001) },
    ])
      await assert.rejects(() => desk.open(user, bad), (e) => e.status === 400, JSON.stringify(bad).slice(0, 60));
    for (let i = 0; i < MAX_OPEN; i++) await desk.open(user, { subject: 'Kayıt ' + i, body: 'x' });
    await assert.rejects(() => desk.open(user, { subject: 'Bir tane daha', body: 'x' }), (e) => e.status === 429);
    await assert.rejects(() => desk.detail('not-a-uuid'), (e) => e.status === 404);
  } finally {
    await pg.close();
  }
});

test('the application serves /api/support (staff: own tickets) and tells the screen the desk exists', async (t) => {
  const { pg, pool } = await database();
  const { a } = await twoOffices(pool);
  const state = fixture();
  state.users.push({ ...state.users[0], id: 'test-staff', username: 'personel', name: 'Personel', role: 'staff' });
  await importState(pool, state);
  const app = await serve(createApplication({ store: createStore(pool), officeSupport: createOfficeSupport(pool, { tenantId: a }) }));
  const bare = await serve(createApplication({ store: createStore(pool) }));
  t.after(async () => {
    await app.close();
    await bare.close();
    await pg.close();
  });
  const headers = { 'X-Han-Request': '1', 'Content-Type': 'application/json' };
  const signIn = async (base, username) => {
    const login = await fetch(base.url + '/api/login', { method: 'POST', headers, body: JSON.stringify({ username, password }) });
    assert.equal(login.status, 200, username);
    return { ...headers, cookie: login.headers.get('set-cookie').split(';')[0] };
  };
  const call = async (base, auth, route, init = {}) => {
    const res = await fetch(base.url + route, { headers: auth, ...init });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const ceo = await signIn(app, 'test');
  const staff = await signIn(app, 'personel');

  assert.equal((await call(app, headers, '/api/support')).status, 401, 'no session');
  // Staff may open tickets too, and see only their own.
  const own = await call(app, staff, '/api/support', { method: 'POST', body: JSON.stringify({ subject: 'Personel sorusu', body: 'x' }) });
  assert.equal(own.status, 200);
  assert.deepEqual((await call(app, staff, '/api/support')).body.tickets.map((t) => t.id), [own.body.id]);

  assert.equal((await call(app, ceo, '/api/modules')).body.supportDesk, true);
  assert.equal((await call(bare, ceo, '/api/modules')).body.supportDesk, undefined, 'absent without a desk');

  const created = await call(app, ceo, '/api/support', { method: 'POST', body: JSON.stringify({ subject: 'Merhaba destek', body: 'Yardım lazım', category: 'how_to' }) });
  assert.equal(created.status, 200);
  const list = await call(app, ceo, '/api/support');
  assert.equal(list.body.tickets.length, 2, 'managers see every ticket');
  assert.ok(list.body.tickets.some((t) => t.subject === 'Merhaba destek'));
  assert.equal((await call(app, staff, '/api/support/' + created.body.id)).status, 404, "staff cannot open others' tickets");
  const reply = await call(app, ceo, `/api/support/${created.body.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Teşekkürler' }) });
  assert.equal(reply.status, 200);
  const detail = await call(app, ceo, '/api/support/' + created.body.id);
  assert.deepEqual(detail.body.messages.map((m) => m.body), ['Yardım lazım', 'Teşekkürler']);
  assert.equal((await call(app, ceo, '/api/support/' + created.body.id, { method: 'DELETE' })).status, 405);
  assert.equal((await call(app, ceo, '/api/support', { method: 'POST', body: '{bad' })).status, 400);
  assert.equal((await call(app, ceo, '/api/support/00000000-0000-4000-8000-000000000000')).status, 404);
});
