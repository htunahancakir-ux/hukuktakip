const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, serve } = require('./support/postgres.cjs');
const { createPlatformAdmin, login } = require('../lib/saas/platform-auth.cjs');
const { createPlatformHandler } = require('../lib/platform-app.cjs');
const platform = require('../lib/saas/platform.cjs');
const support = require('../lib/saas/support.cjs');

const secret = 'Synthetic-Support-Test-Only';
const status = (code) => (error) => error.status === code;

test('support tickets: lifecycle, response target, audit trail and validation', async (t) => {
  const { pg, pool } = await database();
  try {
    const a = (await createPlatformAdmin(pool, { username: 'ada', name: 'Ada Operatör', password: secret + '!' })).id;
    const b = (await createPlatformAdmin(pool, { username: 'bora', name: 'Bora Operatör', password: secret + '?' })).id;
    const office = (
      await platform.openOffice(pool, a, {
        slug: 'destek-buro', name: 'Destek Büro', admin: { name: 'Y', username: 'y', password: secret },
        userCount: 2, userPriceKurus: 1000, termMonths: 1, moduleCodes: [], paid: true,
      })
    ).office;
    const base = { tenantId: office.id, subject: 'Giriş yapamıyoruz', body: 'Sabahtan beri şifre kabul etmiyor.' };
    const messages = async (id) => (await support.ticketDetail(pool, { ticketId: id })).messages;
    const ticketOf = async (id) => (await support.ticketDetail(pool, { ticketId: id })).ticket;

    await t.test('opening records the customer message and a priority-based response target', async () => {
      const opened = await support.openTicket(pool, a, { ...base, priority: 'urgent', channel: 'phone', category: 'technical', contactName: 'Ayşe' });
      assert.equal(opened.number, 1);
      const ticket = await ticketOf(opened.id);
      assert.equal(ticket.status, 'open');
      assert.equal(ticket.officeName, 'Destek Büro');
      assert.equal(ticket.contactName, 'Ayşe');
      const hours = (new Date(ticket.responseDueAt) - new Date(ticket.createdAt)) / 3600000;
      assert.ok(Math.abs(hours - support.RESPONSE_HOURS.urgent) < 0.01, String(hours));
      assert.deepEqual((await messages(opened.id)).map((m) => m.kind), ['customer']);
      const second = await support.openTicket(pool, a, base);
      assert.equal(second.number, 2, 'numbers are sequential');
      assert.equal((await ticketOf(second.id)).priority, 'normal');
      await pool.query('DELETE FROM han_saas.support_tickets WHERE id = $1', [second.id]);
    });

    const id = (await support.listTickets(pool)).tickets[0].id;

    await t.test('an internal note changes nothing; a reply answers and awaits the customer', async () => {
      const before = await ticketOf(id);
      await support.addMessage(pool, a, { ticketId: id, kind: 'internal', body: 'Şifre sıfırlama denendi.' });
      const noted = await ticketOf(id);
      assert.equal(noted.status, 'open');
      assert.equal(noted.firstResponseAt, null, 'a note is not a response');
      assert.equal(noted.updatedAt.getTime?.() ?? noted.updatedAt, before.updatedAt.getTime?.() ?? before.updatedAt);
      await support.addMessage(pool, b, { ticketId: id, kind: 'operator', body: 'Şifrenizi sıfırladık.' });
      const replied = await ticketOf(id);
      assert.equal(replied.status, 'waiting_customer');
      assert.ok(replied.firstResponseAt);
      await assert.rejects(() => support.addMessage(pool, a, { ticketId: id, kind: 'internal', body: 'x', status: 'resolved' }), status(400));
    });

    await t.test('a customer message reopens a waiting or resolved ticket', async () => {
      await support.addMessage(pool, a, { ticketId: id, kind: 'customer', body: 'Hâlâ olmuyor.' });
      assert.equal((await ticketOf(id)).status, 'open');
      await support.addMessage(pool, a, { ticketId: id, kind: 'operator', body: 'Çözüldü sanırım.', status: 'resolved' });
      const resolved = await ticketOf(id);
      assert.equal(resolved.status, 'resolved');
      assert.ok(resolved.resolvedAt);
      await support.addMessage(pool, a, { ticketId: id, kind: 'customer', body: 'Yine bozuldu.' });
      const reopened = await ticketOf(id);
      assert.equal(reopened.status, 'open');
      assert.equal(reopened.resolvedAt, null);
    });

    await t.test('priority, assignment and status leave an audit line each', async () => {
      await support.setPriority(pool, a, { ticketId: id, priority: 'low' });
      await assert.rejects(() => support.setPriority(pool, a, { ticketId: id, priority: 'low' }), status(409));
      await support.assign(pool, b, { ticketId: id, assignTo: 'me' });
      assert.equal((await ticketOf(id)).assignedTo.name, 'Bora Operatör');
      await assert.rejects(() => support.assign(pool, b, { ticketId: id, assignTo: 'me' }), status(409));
      await assert.rejects(() => support.assign(pool, b, { ticketId: id, assignTo: a }), status(400), 'only "me" or null');
      await support.assign(pool, b, { ticketId: id, assignTo: null });
      assert.equal((await ticketOf(id)).assignedTo, null);
      await support.setStatus(pool, a, { ticketId: id, status: 'closed' });
      await assert.rejects(() => support.setStatus(pool, a, { ticketId: id, status: 'closed' }), status(409));
      const system = (await messages(id)).filter((m) => m.kind === 'system').map((m) => m.body);
      assert.ok(system.some((line) => line.startsWith('Öncelik: Acil → Düşük')), system.join('|'));
      assert.ok(system.some((line) => line === 'Kayıt üstlenildi'));
      assert.ok(system.some((line) => line === 'Durum: Açık → Kapalı'));
    });

    await t.test('a closed ticket takes no messages until reopened', async () => {
      await assert.rejects(() => support.addMessage(pool, a, { ticketId: id, kind: 'operator', body: 'Geç kaldık' }), status(409));
      await support.setStatus(pool, a, { ticketId: id, status: 'open' });
      assert.equal((await ticketOf(id)).resolvedAt, null);
      await support.addMessage(pool, a, { ticketId: id, kind: 'internal', body: 'Yeniden açıldı.' });
    });

    await t.test('lowering priority moves the target only until someone has responded', async () => {
      const fresh = await support.openTicket(pool, a, { ...base, priority: 'low' });
      const lowDue = new Date((await ticketOf(fresh.id)).responseDueAt).getTime();
      await support.setPriority(pool, a, { ticketId: fresh.id, priority: 'urgent' });
      const urgentDue = new Date((await ticketOf(fresh.id)).responseDueAt).getTime();
      assert.ok(urgentDue < lowDue);
      await support.addMessage(pool, a, { ticketId: fresh.id, kind: 'operator', body: 'Bakıyoruz.' });
      await support.setPriority(pool, a, { ticketId: fresh.id, priority: 'low' });
      assert.equal(new Date((await ticketOf(fresh.id)).responseDueAt).getTime(), urgentDue, 'target is fixed after the first response');
    });

    await t.test('summary counts overdue first responses and averages response time', async () => {
      const late = await support.openTicket(pool, a, { ...base, subject: 'Gecikmiş kayıt', priority: 'high' });
      await pool.query("UPDATE han_saas.support_tickets SET response_due_at = CURRENT_TIMESTAMP - interval '1 hour' WHERE id = $1", [late.id]);
      const { summary, tickets } = await support.listTickets(pool);
      assert.equal(summary.overdue, 1);
      assert.equal(tickets.find((k) => k.id === late.id).overdue, true);
      assert.ok(summary.open >= 2);
      assert.ok(summary.avgFirstResponseHours !== null && summary.avgFirstResponseHours >= 0);
      await support.addMessage(pool, a, { ticketId: late.id, kind: 'operator', body: 'Özür dileriz.' });
      assert.equal((await support.listTickets(pool)).summary.overdue, 0, 'a response clears the overdue flag');
    });

    await t.test('input is validated and unknown records are 404', async () => {
      const bad = (extra) => support.openTicket(pool, a, { ...base, ...extra });
      await assert.rejects(() => bad({ subject: 'ab' }), status(400));
      await assert.rejects(() => bad({ body: '   ' }), status(400));
      await assert.rejects(() => bad({ body: 'x'.repeat(5001) }), status(400));
      await assert.rejects(() => bad({ priority: 'critical' }), status(400));
      await assert.rejects(() => bad({ channel: 'fax' }), status(400));
      await assert.rejects(() => bad({ category: 'x' }), status(400));
      await assert.rejects(() => bad({ tenantId: '11111111-1111-4111-8111-111111111111' }), status(404));
      await assert.rejects(() => bad({ tenantId: 'not-a-uuid' }), status(404));
      await assert.rejects(() => support.ticketDetail(pool, { ticketId: '11111111-1111-4111-8111-111111111111' }), status(404));
      await assert.rejects(() => support.addMessage(pool, a, { ticketId: id, kind: 'system', body: 'x' }), status(400), 'clients cannot forge audit lines');
      await assert.rejects(() => support.addMessage(pool, a, { ticketId: id, kind: 'operator', body: '' }), status(400));
    });

    await t.test('the tables are control-plane only', async () => {
      const { rows } = await pool.query(
        `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'han_saas' AND c.relname IN ('support_tickets', 'support_messages')`,
      );
      assert.equal(rows.length, 2);
      assert.ok(rows.every((r) => r.relrowsecurity));
    });
  } finally {
    await pg.close();
  }
});

test('support console HTTP: authentication and the operator comes from the session', async () => {
  const { pg, pool } = await database();
  const server = await serve(createPlatformHandler({ pool, secureCookies: false }));
  try {
    const operator = await createPlatformAdmin(pool, { username: 'root', name: 'Kök Operatör', password: secret + '!' });
    const office = (
      await platform.openOffice(pool, operator.id, {
        slug: 'http-buro', name: 'Http Büro', admin: { name: 'Y', username: 'y', password: secret },
        userCount: 1, userPriceKurus: 1000, termMonths: 1, moduleCodes: [], paid: true,
      })
    ).office;
    const call = async (path, { method = 'GET', body, cookie } = {}) => {
      const response = await fetch(server.url + '/api/platform/' + path, {
        method,
        headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-Han-Request': '1' } : {}), ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: await response.json(), setCookie: response.headers.get('set-cookie') };
    };
    assert.equal((await call('support')).status, 401);
    assert.equal((await call('support', { method: 'POST', body: {} })).status, 401);
    const signedIn = await call('login', { method: 'POST', body: { username: 'root', password: secret + '!' } });
    const cookie = signedIn.setCookie.split(';')[0];

    const opened = await call('support', { method: 'POST', cookie, body: { tenantId: office.id, subject: 'Fatura sorusu', body: 'KDV nasıl?', category: 'billing' } });
    assert.equal(opened.status, 200, JSON.stringify(opened.json));
    const ticketId = opened.json.id;
    assert.equal((await call(`support/${ticketId}/messages`, { method: 'POST', cookie, body: { kind: 'operator', body: 'KDV dahildir.', ticketId: 'ignored' } })).status, 200);
    const detail = await call(`support/${ticketId}`, { cookie });
    assert.equal(detail.json.ticket.status, 'waiting_customer');
    assert.equal(detail.json.messages.find((m) => m.kind === 'operator').author, 'Kök Operatör');
    const list = await call('support', { cookie });
    assert.equal(list.json.tickets.length, 1);
    assert.equal(list.json.summary.waitingCustomer, 1);
    assert.equal((await call(`support/${ticketId}/assign`, { method: 'POST', cookie, body: { assignTo: 'me' } })).status, 200);
    assert.equal((await call(`support/${ticketId}/assign`, { method: 'POST', cookie, body: { assignTo: operator.id } })).status, 400);
    assert.equal((await call(`support/${ticketId}/status`, { method: 'POST', cookie, body: { status: 'resolved' } })).status, 200);
    assert.equal((await call(`support/${ticketId}/priority`, { method: 'POST', cookie, body: { priority: 'bogus' } })).status, 400);
    assert.equal((await call('support/not-a-uuid', { cookie })).status, 404);
  } finally {
    await server.close();
    await pg.close();
  }
});
