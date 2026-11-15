const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { database, fixture, serve } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createApplication } = require('../lib/application.cjs');
const maps = require('../lib/maps-settings.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');

test('Client types use the current route sectors, allow client staff without marketing access, reveal only labels and persist selected sectors', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    state.users.push(
      { ...state.users[0], id: 'client-staff', username: 'clients', role: 'staff', permissions: ['clients'] },
      { ...state.users[0], id: 'other-staff', username: 'other', role: 'staff', permissions: ['documents'] },
    );
    state.mapsConfig = {
      scraperUrl: 'https://private.example.invalid',
      sealedApiKey: 'private-key',
      sealedScraperAuth: 'private-auth',
    };
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
    const staff = await headers('client-staff'),
      denied = await headers('other-staff'),
      ceo = await headers(state.users[0].id);
    const get = async (h) => {
      const response = await fetch(server.url + '/api/client-categories', { headers: h });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await get({})).status, 401);
    assert.equal((await get(denied)).status, 403);
    const result = await get(staff);
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body), ['categories']);
    const routeResponse = await fetch(server.url + '/api/marketing/overview', { headers: ceo });
    assert.equal(routeResponse.status, 200);
    assert.deepEqual(result.body.categories, [
      ...(await routeResponse.json()).sectors.map((s) => s.label),
      'Diğer',
    ]);
    assert(!result.body.categories.includes('Hepsi'));
    assert(!JSON.stringify(result.body).includes('private'));
    assert.equal((await fetch(server.url + '/api/marketing/overview', { headers: staff })).status, 403);
    const config = maps.configure(
      {},
      { enabled: false, sectors: [{ id: 'perde', label: 'Perde', query: 'perde mağazası' }] },
    );
    await pool.query(
      "UPDATE han_data.metadata SET body=jsonb_set(body,'{mapsConfig}',$1::jsonb),revision=revision+1 WHERE id=1",
      [JSON.stringify(config)],
    );
    assert.deepEqual(
      (await get(staff)).body.categories,
      ['Perde', 'Diğer'],
      'catalog edits are reflected immediately',
    );
    const client = { id: 'new-client', name: 'Perde Firma', type: 'Şirket', clientCategory: 'Perde' };
    const save = await fetch(server.url + '/api/data/patch?key=icrapro-v1', {
      method: 'PUT',
      headers: staff,
      body: JSON.stringify(diff('icrapro-v1', { clients: [], docs: [] }, { clients: [client], docs: [] })),
    });
    assert.equal(save.status, 200, await save.clone().text());
    const detail = await fetch(server.url + '/api/records/client?id=new-client', { headers: staff });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).record.clientCategory, 'Perde');
    assert.deepEqual(
      await require('../lib/record-store/read-scope.cjs').readScope(
        new URL('/api/client-categories', 'http://localhost'),
      ),
      { tables: ['personnel'] },
    );
  } finally {
    await server?.close();
    await pg.close();
  }
});
