const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { database, fixture, serve } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createApplication } = require('../lib/application.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');

test('CEO manages independent actions on live account sessions in the record store', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    for (const [id, role, deletionAccess] of [
      ['manager', 'admin', false],
      ['delegate', 'admin', true],
      ['staff', 'staff', false],
    ])
      state.users.push({ ...state.users[0], id, username: id, name: id, role, deletionAccess });
    const client = { id: 'client-1', name: 'Kayıtlı Müvekkil', type: 'Şahıs' };
    state.data['icrapro-v1'].clients.push(client);
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store, background: () => {} }));
    const cookies = {};
    async function session(id) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
        [crypto.createHash('sha256').update(token).digest('hex'), id, Date.now() + 600000],
      );
      cookies[id] = 'han_session=' + token;
    }
    for (const { id } of state.users) await session(id);
    async function request(id, path, method = 'GET', payload) {
      const res = await fetch(server.url + path, {
        method,
        headers: { cookie: cookies[id], 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      return { status: res.status, body: await res.json() };
    }
    const ceo = 'test-ceo';
    const endpoint = '/api/users/module-permissions';
    const listing = await request(ceo, endpoint);
    assert.equal(listing.status, 200);
    assert.deepEqual(listing.body.accounts.map((account) => account.id).sort(), [
      'delegate',
      'manager',
      'staff',
    ]);
    const revision = (id) => listing.body.accounts.find((account) => account.id === id).revision;
    const update = (actor, id, modulePermissions, expected = revision(id)) =>
      request(actor, endpoint, 'PUT', { id, revision: expected, modulePermissions });
    assert.equal((await request('manager', endpoint)).status, 403);
    assert.equal((await update('manager', 'manager', { clients: { delete: true } })).status, 403);
    assert.equal((await update(ceo, ceo, {}, '')).status, 404);
    assert.equal((await update(ceo, 'manager', { reports: { delete: true } })).status, 400);
    const saved = await update(ceo, 'manager', {
      clients: { create: true, update: false, delete: true },
      messages: { create: false },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await request('manager', '/api/session')).body.user, null);
    assert.equal((await update(ceo, 'manager', {})).status, 409);
    await session('manager');
    const rule = (await request('manager', '/api/session')).body.user;
    assert.deepEqual(rule.deletionTypes, ['clients']);
    assert.equal(rule.modulePermissions.clients.update, false);
    assert.equal((await request('manager', '/api/records/client?id=client-1')).status, 200);

    const patch = (old, next) =>
      request(
        'manager',
        '/api/data/patch?key=icrapro-v1',
        'PUT',
        diff('icrapro-v1', { clients: old, docs: [] }, { clients: next, docs: [] }),
      );
    const added = { id: 'client-2', name: 'Yeni Müvekkil', type: 'Şahıs' };
    const blocked = await patch([client], [{ ...client, name: 'Değiştirildi' }, added]);
    assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
    assert.equal((await request(ceo, '/api/records/client?id=client-2')).status, 404);
    const created = await patch([], [added]);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal((await request('manager', '/api/messages', 'POST', { subject: 'Konu' })).status, 403);
    assert.equal((await request('manager', '/api/operations/delete?type=documents')).status, 403);
    const deletable = await request('manager', '/api/operations/delete?type=clients&id=client-2');
    assert.equal(deletable.status, 200);
    const deleted = await request('manager', '/api/operations/delete', 'POST', {
      type: 'clients',
      id: added.id,
      revision: deletable.body.items[0].revision,
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal((await request(ceo, '/api/records/client?id=client-2')).status, 404);

    assert.equal((await update(ceo, 'delegate', { clients: { create: false, delete: false } })).status, 200);
    await session('delegate');
    assert.equal((await request('delegate', '/api/operations/delete?type=clients')).status, 403);
    assert.equal((await request('delegate', '/api/operations/delete?type=documents')).status, 200);
    const refusedCreate = await request(
      'delegate',
      '/api/data/patch?key=icrapro-v1',
      'PUT',
      diff('icrapro-v1', { clients: [], docs: [] }, { clients: [{ ...added, id: 'client-3' }], docs: [] }),
    );
    assert.equal(refusedCreate.status, 403);
    const removal = await request(
      'delegate',
      '/api/data/patch?key=icrapro-v1',
      'PUT',
      diff('icrapro-v1', { clients: [client], docs: [] }, { clients: [], docs: [] }),
    );
    assert.equal(removal.status, 403);
    const reset = await update(ceo, 'manager', {}, saved.body.revision);
    assert.equal(reset.status, 200);
    await session('manager');
    assert.equal((await patch([client], [{ ...client, name: 'Güncellendi' }])).status, 200);
    const audit = await store.listAudit({ category: 'changes', actor: 'test' });
    assert(
      audit.items.some(
        (entry) => entry.record_ref === 'manager' && entry.fields.includes('Modül işlem yetkileri'),
      ),
    );
  } finally {
    await server?.close();
    await pg.close();
  }
});

test('User Management saves the selected account and only explicit settings', () => {
  const dom = new JSDOM('<main id="content"></main>', { runScripts: 'outside-only' });
  const { window } = dom;
  window.$ = (selector) => window.document.querySelector(selector);
  window.esc = String;
  window.hanAuth = { role: 'ceo' };
  window.accountRoleLabel = () => 'Yönetici';
  const calls = [];
  window.authApi = (path, method, input) => {
    if (method === 'PUT') {
      calls.push({ path, input });
      return { ...input, revision: 'saved' };
    }
    return {
      actions: { create: 'Yeni kayıt', update: 'Düzenleme', delete: 'Silme' },
      modules: { clients: ['Müvekkiller', ['create', 'update', 'delete']] },
      accounts: [{ id: 'admin', name: 'Yönetici', username: 'admin', role: 'admin', revision: 'initial' }],
    };
  };
  try {
    for (const file of ['workspace-audit.js', 'workspace-access.js'])
      window.eval(fs.readFileSync(require.resolve('../outputs/icrapro/' + file), 'utf8'));
    window.userPermissionsPage();
    const select = window.$('#permissionAccount');
    select.value = 'admin';
    select.dispatchEvent(new window.Event('change'));
    const update = window.$('[data-permission-action="update"]');
    assert.equal(update.getAttribute('aria-label'), 'Müvekkiller · Düzenleme');
    update.value = 'false';
    assert.equal(calls.length, 0);
    window.$('#userPermissionsForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
      {
        path: '/api/users/module-permissions',
        input: { id: 'admin', revision: 'initial', modulePermissions: { clients: { update: false } } },
      },
    ]);
    assert.match(window.$('#userPermissionsStatus').textContent, /Yetkiler kaydedildi/);
    window.hanAuth.role = 'admin';
    assert.doesNotMatch(window.userAuditTabs('users'), /userPermissionsTab/);
  } finally {
    window.close();
  }
});
