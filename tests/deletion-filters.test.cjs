const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { handleDeletionRoutes } = require('../outputs/icrapro/access-deletion.cjs');
const { database, fixture, serve } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const owner = { id: 'test-ceo', role: 'ceo', active: true };
async function list(state, query, user = owner) {
  let result;
  await handleDeletionRoutes({
    state,
    u: user,
    req: { method: 'GET' },
    res: {},
    url: new URL('http://localhost/api/operations/delete?' + query),
    fail: (code, message) => Object.assign(Error(message), { code }),
    send: (_res, _code, data) => {
      result = data;
    },
  });
  return result;
}
function sample() {
  const s = fixture();
  s.data['icrapro-v1'].clients = [{ id: 'shared', name: 'Client', createdAt: '2026-11-20T09:00:00Z' }];
  s.messages = [
    { id: 'before', createdAt: '2026-11-19T20:59:59Z' },
    { id: 'shared', createdAt: '2026-11-19T21:00:00Z' },
    { id: 'end', createdAt: '2026-11-20T20:59:59Z' },
    { id: 'after', createdAt: '2026-11-20T21:00:00Z' },
    { id: 'undated' },
  ].map((m) => ({ ...m, subject: 'Test message', text: '', senderName: 'Test', recipientNames: [] }));
  return s;
}
test('All record types respect per-module deletion permissions and inclusive Istanbul date boundaries', async () => {
  const s = sample();
  const result = await list(s, 'type=all&from=2026-11-20&to=2026-11-20');
  assert.deepEqual(result.items.map((r) => r.type + ':' + r.id).sort(), [
    'clients:shared',
    'messages:end',
    'messages:shared',
  ]);
  assert.equal((await list(s, 'type=all')).total, 6);
  assert.equal((await list(s, 'type=all&from=2026-11-21')).total, 1);
  assert.equal((await list(s, 'type=messages&to=2026-11-19')).total, 1);
  assert.equal((await list(s, 'type=all&q=Client&from=2026-11-20')).total, 1);
  const restricted = {
    id: 'limited',
    role: 'admin',
    active: true,
    modulePermissions: { messages: { delete: true } },
  };
  const allowed = await list(s, 'type=all', restricted);
  assert.equal(allowed.total, 5);
  assert(allowed.items.every((r) => r.type === 'messages'));
  await assert.rejects(list(s, 'type=clients', restricted), { code: 403 });
  await assert.rejects(list(s, 'type=all', { role: 'staff' }), { code: 403 });
  for (const query of [
    'type=all&from=2026-02-30',
    'type=all&to=wrong',
    'type=all&from=2026-11-21&to=2026-11-20',
    'type=invalid',
  ])
    await assert.rejects(list(s, query), { code: 400 });
});
test('Record API pages a combined list once and deletes the selected row type even when IDs overlap', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const s = sample();
    s.messages = Array.from({ length: 60 }, (_, i) => ({
      id: i ? 'm' + i : 'shared',
      createdAt: '2026-11-20T09:00:00Z',
      senderId: 'test-ceo',
      senderName: 'Test',
      recipientIds: ['test-ceo'],
      recipientNames: ['Test'],
      subject: 'Message ' + i,
      text: 'Text',
      readBy: {},
    }));
    await importState(pool, s);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(
      require('../lib/application.cjs').createApplication({ store, background: () => {} }),
    );
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,'test-ceo','desktop',$2)",
      [crypto.createHash('sha256').update(token).digest('hex'), Date.now() + 600000],
    );
    const headers = {
      cookie: 'han_session=' + token,
      'X-Han-Request': '1',
      'Content-Type': 'application/json',
    };
    const get = async (query) => {
      const r = await fetch(server.url + '/api/operations/delete?' + query, { headers });
      assert.equal(r.status, 200);
      return r.json();
    };
    const query = 'type=all&from=2026-11-20&to=2026-11-20';
    const a = await get(query),
      b = await get(query + '&offset=50');
    assert.equal(a.total, 61);
    assert.equal(a.items.length, 50);
    assert.equal(b.items.length, 11);
    assert.equal(new Set([...a.items, ...b.items].map((r) => r.type + ':' + r.id)).size, 61);
    const row = [...a.items, ...b.items].find((r) => r.type === 'messages' && r.id === 'shared');
    const invalid = await fetch(server.url + '/api/operations/delete', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...row, type: 'all' }),
    });
    assert.equal(invalid.status, 400);
    const deleted = await fetch(server.url + '/api/operations/delete', {
      method: 'POST',
      headers,
      body: JSON.stringify(row),
    });
    assert.equal(deleted.status, 200, await deleted.text());
    const saved = await store.readState();
    assert(saved.data['icrapro-v1'].clients.some((c) => c.id === 'shared'));
    assert(!saved.messages.some((m) => m.id === 'shared'));
    assert(saved.deletedOperations.some((r) => r.type === 'messages' && r.record.id === 'shared'));
  } finally {
    await server?.close();
    await pg.close();
  }
});
test('Deletion dialog carries date filters through pages and sends the actual selected row type', async () => {
  const dom = new JSDOM('<body></body>', { runScripts: 'dangerously' });
  try {
    const w = dom.window,
      calls = [];
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    w.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    Object.assign(w, {
      hanMayDelete: (type) => ['messages', 'clients'].includes(type),
      toast() {},
      confirm: () => true,
      authApi: (url, method, body) => {
        calls.push({ url, method, body });
        return method === 'POST'
          ? { ok: true }
          : {
              total: 61,
              items: [
                { id: 'shared', type: 'messages', label: 'Message', revision: 'version', date: '2026-11-20' },
              ],
            };
      },
    });
    const source = fs.readFileSync('outputs/icrapro/auth.js', 'utf8');
    w.eval(
      source.slice(
        source.indexOf('async function openDeletionPanel()'),
        source.indexOf('\nfunction returnToMainMenu'),
      ),
    );
    await w.openDeletionPanel();
    const form = w.document.querySelector('[data-search]'),
      dialog = w.document.querySelector('dialog');
    assert.equal(form.elements.type.value, 'all');
    assert.equal(form.elements.type.options[0].textContent, 'Hepsi');
    form.elements.from.value = '2026-11-20';
    form.elements.to.value = '2026-11-20';
    form.onsubmit({ preventDefault() {} });
    dialog.querySelector('[data-next]').click();
    let params = new URL('http://localhost' + calls.at(-1).url).searchParams;
    assert.equal(params.get('offset'), '50');
    assert.equal(params.get('from'), '2026-11-20');
    assert.equal(params.get('to'), '2026-11-20');
    form.elements.from.onchange();
    params = new URL('http://localhost' + calls.at(-1).url).searchParams;
    assert.equal(params.get('offset'), '0');
    assert.match(dialog.querySelector('.delete-op-row').textContent, /Personel Mesajları/);
    dialog.querySelector('.delete-op-row button').click();
    assert.equal(calls.find((c) => c.method === 'POST').body.type, 'messages');
    form.elements.from.value = '2026-11-21';
    form.elements.from.onchange();
    assert.match(dialog.querySelector('[data-status]').textContent, /Başlangıç tarihi/);
    assert.equal(dialog.querySelectorAll('.delete-op-row').length, 0);
  } finally {
    dom.window.close();
  }
});
