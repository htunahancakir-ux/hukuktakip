const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { database, fixture, password, serve } = require('./support/postgres.cjs');
const { migrate, importState, createStore } = require('../lib/postgres-store.cjs');
const { createApplication } = require('../lib/application.cjs');
const { encryptState, decryptState } = require('../lib/backup-service.cjs');
const crypto = require('node:crypto');

test('Additive upgrade preserves the entire old payload, audit, unknown fields and backup round-trip', async () => {
  const { pg, pool } = await database(false);
  try {
    await pg.exec(fs.readFileSync(path.join(__dirname, '../migrations/001-state.sql'), 'utf8'));
    await pg.exec(fs.readFileSync(path.join(__dirname, '../migrations/002-audit.sql'), 'utf8'));
    const source = fixture();
    source.extension = { unknown: ['korunacak', 123], nested: { flag: true } };
    await importState(pool, source);
    await pool.query(
      "INSERT INTO han_private.han_audit(category,action,area) VALUES ('changes','create','Test')",
    );
    await migrate(pool);
    await migrate(pool);
    const saved = await createStore(pool).readState();
    assert.deepEqual(saved, source);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS count FROM han_private.han_audit')).rows[0].count,
      1,
    );
    const key = crypto.randomBytes(32);
    assert.deepEqual(decryptState(encryptState(saved, key), key), source);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS count FROM han_private.han_account_index')).rows[0].count,
      1,
    );
  } finally {
    await pg.close();
  }
});

test('Session, presence, list reads and no-op transactions cannot rewrite the business snapshot', async () => {
  const { pg, pool } = await database();
  const source = fixture();
  source.data['icrapro-v1'].docs = [{ id: 'd1', number: 'D-1', debtor: 'Sentetik', amount: 100 }];
  await importState(pool, source);
  await pg.exec(`CREATE FUNCTION han_private.deny_state_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'unexpected snapshot write'; END $$;
    CREATE TRIGGER deny_state_update BEFORE UPDATE ON han_private.han_state FOR EACH ROW EXECUTE FUNCTION han_private.deny_state_update();`);
  await pool.query("UPDATE han_private.han_jobs SET next_at=clock_timestamp()+interval '1 hour'");
  const store = createStore(pool),
    tasks = [];
  const app = await serve(createApplication({ store, background: (task) => tasks.push(task) }));
  try {
    const response = await fetch(app.url + '/api/login', {
      method: 'POST',
      headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test', password }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    for (const route of ['/api/session', '/api/presence', '/api/data?key=icrapro-v1', '/api/notifications']) {
      const result = await fetch(app.url + route, { headers: { cookie } });
      assert.equal(result.status, 200, route);
      await result.arrayBuffer();
    }
    const invalid = await fetch(app.url + '/api/presence', { method: 'POST', headers: { cookie } });
    assert.equal(invalid.status, 403, 'CSRF still applies to heartbeat');
    await Promise.all(tasks);
    await store.transaction(() => true);
    assert.deepEqual(await store.readState(), source);
    assert.equal((await pool.query('SELECT revision FROM han_private.han_state')).rows[0].revision, 1);
  } finally {
    await app.close();
    await pg.close();
  }
});

test('Rejected reset requests retain distributed throttle counts', async () => {
  const { pg, pool } = await database();
  await importState(pool, fixture());
  const app = await serve(createApplication({ store: createStore(pool) }));
  try {
    for (let i = 0; i < 8; i++) {
      const response = await fetch(app.url + '/api/password-reset/request', {
        method: 'POST',
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: '' }),
      });
      assert.equal(response.status, 400);
    }
    const blocked = await fetch(app.url + '/api/password-reset/request', {
      method: 'POST',
      headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'test' }),
    });
    assert.equal(blocked.status, 429);
    assert.equal(
      (
        await pool.query(
          "SELECT count FROM han_private.han_login_attempts WHERE key LIKE 'password-wa-request:%'",
        )
      ).rows[0].count,
      8,
    );
  } finally {
    await app.close();
    await pg.close();
  }
});

test('Maintenance is claimed once across instances and rolls back on failure', async () => {
  const { pg, pool } = await database();
  await importState(pool, fixture());
  await pool.query("INSERT INTO han_private.han_login_attempts(key,count,expires_at) VALUES ('expired',1,0)");
  const first = createStore(pool),
    second = createStore(pool);
  try {
    await assert.rejects(
      first.maintenance(({ state, saveState }) => {
        state.shouldNotExist = true;
        saveState(state);
        throw Error('injected');
      }),
    );
    assert.equal((await first.readState()).shouldNotExist, undefined);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS count FROM han_private.han_login_attempts')).rows[0].count,
      1,
      'A failed maintenance run also rolls back counter cleanup',
    );
    const run = ({ state, saveState }) => {
      state.maintenanceCount = (state.maintenanceCount || 0) + 1;
      saveState(state);
    };
    const results = await Promise.all([first.maintenance(run), second.maintenance(run)]);
    assert.deepEqual(results, [true, false]);
    assert.equal((await first.readState()).maintenanceCount, 1);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS count FROM han_private.han_login_attempts')).rows[0].count,
      0,
    );
  } finally {
    await pg.close();
  }
});
