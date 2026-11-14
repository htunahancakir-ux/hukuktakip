const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture, database, serve } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createApplication } = require('../lib/application.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');

test('New forms reserve distinct folios before saving; retries keep numbers, save preserves reservation and other users cannot claim it', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    state.users.push({ ...state.users[0], id: 'other', username: 'other', role: 'admin' });
    state.users.push({
      ...state.users[0],
      id: 'blocked',
      username: 'blocked',
      role: 'staff',
      permissions: [],
    });
    state.data['icrapro-v1'].clients = [{ id: 'client', name: 'Firma' }];
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store }));
    async function headers(id) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
        [crypto.createHash('sha256').update(token).digest('hex'), id, Date.now() + 600000],
      );
      return { cookie: 'han_session=' + token, 'X-Han-Request': '1', 'Content-Type': 'application/json' };
    }
    const owner = await headers(state.users[0].id),
      other = await headers('other'),
      blocked = await headers('blocked');
    const reserve = async (id, h = owner) => {
      const r = await fetch(server.url + '/api/records/folio-reservation', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ id }),
      });
      return { status: r.status, ...(await r.json()) };
    };
    const a = crypto.randomUUID(),
      b = crypto.randomUUID();
    const [first, second] = await Promise.all([reserve(a), reserve(b, other)]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.notEqual(first.number, second.number);
    assert.deepEqual([first.number, second.number].sort(), ['1', '2']);
    assert.deepEqual(await reserve(a), first, 'retried form opening consumes no new number');
    assert.equal((await reserve(a, other)).status, 409);
    assert.equal((await reserve(crypto.randomUUID(), blocked)).status, 403);
    assert.equal((await reserve('bad')).status, 400);
    assert.equal(
      (await store.readState()).data['icrapro-v1'].docs.length,
      0,
      'opening a form creates no empty debtor or financial record',
    );
    const doc = {
      id: a,
      number: '9999',
      client: 'client',
      debtor: 'Borçlu',
      docType: 'Senet',
      amount: 1000,
      due: '2026-11-01',
    };
    const save = async (h) =>
      fetch(server.url + '/api/data/patch?key=icrapro-v1&operation=intake', {
        method: 'PUT',
        headers: h,
        body: JSON.stringify(diff('icrapro-v1', { clients: [], docs: [] }, { clients: [], docs: [doc] })),
      });
    assert.equal((await save(other)).status, 409);
    const saved = await save(owner);
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.equal(
      (await store.readState()).data['icrapro-v1'].docs[0].number,
      first.number,
      'server keeps reserved number regardless of submitted number',
    );
    const third = await reserve(crypto.randomUUID());
    assert.equal(third.number, '3');
    assert.equal((await reserve(a)).status, 409, 'a saved ID cannot reserve a fresh number');
  } finally {
    await server?.close();
    await pg.close();
  }
});

test('The intake screen shows the reserved number before save and keeps it on reset and retry', async (t) => {
  const { JSDOM } = require('jsdom'),
    fs = require('node:fs');
  const dom = new JSDOM('<form><label><input id="intakeFolioNumber"><small></small></label></form>', {
    runScripts: 'dangerously',
    url: 'https://test.invalid',
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.crypto.randomUUID = crypto.randomUUID;
  const messages = [];
  w.toast = (m) => messages.push(m);
  let calls = 0;
  w.fetch = async (url, options) => {
    calls++;
    return { ok: true, json: async () => ({ id: JSON.parse(options.body).id, number: '143' }) };
  };
  w.eval(fs.readFileSync('outputs/icrapro/workspace-intake.js', 'utf8'));
  const form = w.document.querySelector('form');
  assert.deepEqual(await Promise.all([w.prepareIntakeFolio(form), w.prepareIntakeFolio(form)]), [true, true]);
  assert.equal(calls, 1);
  assert.equal(form.querySelector('input').value, '143');
  form.reset();
  assert.equal(form.querySelector('input').value, '143');
  await w.prepareIntakeFolio(form);
  assert.equal(calls, 1);
  assert.equal(messages.length, 0);
});

test('Reserved folio counters and draft IDs are isolated between offices sharing PostgreSQL', async () => {
  const { pg, pool } = await database();
  const { createTenant } = require('../lib/saas/tenants.cjs');
  const { createTenantPool, LEGACY_TENANT_ID } = require('../lib/saas/tenant-pool.cjs');
  const { reserveFolioNumber } = require('../lib/record-store/folio-numbers.cjs');
  try {
    const office = await createTenant(pool, {
      slug: 'folio-second',
      name: 'Second',
      ownerUserId: 'second-owner',
    });
    const a = createTenantPool(pool, LEGACY_TENANT_ID),
      b = createTenantPool(pool, office.id),
      state = fixture();
    await importState(a, state);
    await pool.query('INSERT INTO han_private.han_state(id,payload,tenant_id) VALUES(1,$1::jsonb,$2)', [
      JSON.stringify(state),
      office.id,
    ]);
    const requests = [];
    for (const db of [a, b]) {
      await importRecords(db);
      await activateRecords(db);
      const token = crypto.randomBytes(32).toString('hex');
      await db.query(
        "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
        [crypto.createHash('sha256').update(token).digest('hex'), state.users[0].id, Date.now() + 600000],
      );
      requests.push({ headers: { cookie: 'han_session=' + token } });
    }
    const id = crypto.randomUUID();
    assert.equal((await reserveFolioNumber(a, requests[0], { id })).number, '1');
    assert.equal((await reserveFolioNumber(b, requests[1], { id })).number, '1');
    assert.equal((await reserveFolioNumber(a, requests[0], { id: crypto.randomUUID() })).number, '2');
    assert.equal(
      Object.keys((await createStore(b, { records: true }).readState()).folioReservations).length,
      1,
    );
    await assert.rejects(
      reserveFolioNumber(b, requests[0], { id: crypto.randomUUID() }),
      (e) => e.status === 401,
    );
  } finally {
    await pg.close();
  }
});
