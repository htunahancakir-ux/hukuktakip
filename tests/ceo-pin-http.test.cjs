const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const pin = require('../lib/ceo-pin.cjs');
for (const records of [false, true])
  test(
    'CEO operations remain available with configured, missing or stale PIN proof: ' + records,
    async () => {
      const { pg, pool } = await database();
      let server;
      try {
        const state = fixture();
        state.data['icrapro-v1'].clients.push({ id: 'preserved-client', name: 'Preserved' });
        state.users.push({ ...state.users[0], id: 'test-admin', username: 'admin', role: 'admin' });
        state.ceoPin = {
          ...(await pin.createPin('2580')),
          scopes: pin.scopes,
          proofKey: crypto.randomBytes(32).toString('hex'),
        };
        await importState(pool, state);
        if (records) {
          await importRecords(pool);
          await activateRecords(pool);
        }
        const token = crypto.randomBytes(32).toString('hex');
        await pool.query(
          "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
          [crypto.createHash('sha256').update(token).digest('hex'), 'test-ceo', Date.now() + 600000],
        );
        const headers = {
          cookie: 'han_session=' + token,
          'X-Han-Request': '1',
          'Content-Type': 'application/json',
        };
        server = await serve(createApplication({ store: createStore(pool, { records }) }));
        const request = async (path, method = 'GET', value, proof) => {
          const response = await fetch(server.url + path, {
            method,
            headers: { ...headers, ...(proof ? { 'X-Han-Pin-Proof': proof } : {}) },
            ...(value ? { body: JSON.stringify(value) } : {}),
          });
          return {
            status: response.status,
            cookie: response.headers.get('set-cookie'),
            body: await response.json(),
          };
        };
        const status = await request('/api/ceo-pin/status');
        assert.deepEqual(status.body, { configured: true, scopes: pin.scopes, unlocked: false });
        assert.equal(
          JSON.stringify((await request('/api/data?key=icrapro-settings-v1')).body).includes(
            state.ceoPin.hash,
          ),
          false,
        );
        for (const path of ['/api/users', '/api/voip/config', '/api/operations/delete?type=clients'])
          assert.equal((await request(path)).status, 200);
        const verified = await request('/api/ceo-pin/verify', 'POST', { pin: '2580', scope: 'permissions' });
        assert.equal(verified.body.ok, true);
        assert.match(verified.cookie, /HttpOnly/);
        assert.doesNotMatch(verified.cookie, /Max-Age|Expires/i);
        headers.cookie += '; ' + verified.cookie.split(';')[0];
        assert.equal((await request('/api/ceo-pin/status')).body.unlocked, true);
        assert.equal((await request('/api/users')).status, 200);
        headers.cookie = 'han_session=' + token;
        assert.equal((await request('/api/ceo-pin/status')).body.unlocked, false);
        assert.equal((await request('/api/users', 'GET', null, verified.body.proof)).status, 200);
        assert.equal((await request('/api/voip/config', 'GET', null, verified.body.proof)).status, 200);
        assert.equal((await request('/api/users', 'GET', null, verified.body.proof + 'x')).status, 200);
        for (let i = 0; i < 5; i++)
          assert.equal(
            (await request('/api/ceo-pin/verify', 'POST', { pin: '0000', scope: 'permissions' })).body.ok,
            false,
          );
        assert.equal(
          (await request('/api/ceo-pin/verify', 'POST', { pin: '2580', scope: 'permissions' })).body.ok,
          false,
        );
        assert.equal(
          (
            await request('/api/ceo-pin/config', 'POST', {
              pin: '1470',
              currentPassword: 'wrong',
              scopes: pin.scopes,
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request('/api/ceo-pin/config', 'POST', {
              pin: '1470',
              currentPassword: password,
              scopes: pin.scopes,
            })
          ).status,
          200,
        );
        assert.equal((await request('/api/users', 'GET', null, verified.body.proof)).status, 200);
        assert.equal(
          (await request('/api/ceo-pin/verify', 'POST', { pin: '1470', scope: 'permissions' })).body.ok,
          true,
        );
        assert.equal((await request('/api/data?key=icrapro-v1')).body.clients[0].id, 'preserved-client');
        const adminToken = crypto.randomBytes(32).toString('hex');
        await pool.query(
          "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
          [crypto.createHash('sha256').update(adminToken).digest('hex'), 'test-admin', Date.now() + 600000],
        );
        headers.cookie = 'han_session=' + adminToken;
        assert.equal((await request('/api/users')).status, 200);
        assert.equal((await request('/api/ceo-pin/status')).status, 403);
      } finally {
        await server?.close();
        await pg.close();
      }
    },
  );
