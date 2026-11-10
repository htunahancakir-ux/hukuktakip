const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, fixture, password, serve } = require('./support/postgres.cjs');
const { createTenant } = require('../lib/saas/tenants.cjs');
const { createTenantPool, LEGACY_TENANT_ID } = require('../lib/saas/tenant-pool.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createBackupService } = require('../lib/backup-service.cjs');

test('Shared PostgreSQL isolates tenant data, sessions and writes with RLS', async (t) => {
  const { pg, pool } = await database();
  const servers = [];
  try {
    const office = await createTenant(pool, {
      slug: 'second-office',
      name: 'Second Office',
      ownerUserId: 'owner-two',
    });
    const a = createTenantPool(pool, LEGACY_TENANT_ID);
    const b = createTenantPool(pool, office.id);
    const first = fixture(),
      second = fixture();
    first.data['icrapro-v1'].clients.push({ id: 'same-client', name: 'Private First' });
    second.data['icrapro-v1'].clients.push({ id: 'same-client', name: 'Private Second' });
    await importState(a, first);
    await pool.query('INSERT INTO han_private.han_state(id,payload,tenant_id) VALUES(1,$1::jsonb,$2)', [
      JSON.stringify(second), office.id,
    ]);

    await t.test('same user IDs, usernames and record IDs coexist in different offices', async () => {
      for (const [db, expected] of [
        [a, 'Private First'],
        [b, 'Private Second'],
      ]) {
        const state = await createStore(db).readState();
        assert.equal(state.data['icrapro-v1'].clients[0].name, expected);
        assert.equal(
          (await db.query('SELECT count(*)::int AS n FROM han_private.han_account_index')).rows[0].n,
          1,
        );
        const role = (await db.query('SELECT current_user AS role')).rows[0].role;
        assert.equal(role, 'han_tenant_runtime');
      }
    });

    await t.test('a missing tenant context sees no data and explicit foreign writes are denied', async () => {
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        await db.query('SET LOCAL ROLE han_tenant_runtime');
        assert.equal((await db.query('SELECT * FROM han_private.han_state')).rows.length, 0);
        await db.query('ROLLBACK');
      } finally {
        db.release();
      }
      await assert.rejects(
        a.query('INSERT INTO han_private.han_activity(id,body,tenant_id) VALUES(1,$1,$2)', ['{}', office.id]),
        (e) => e.code === '42501',
      );
      await assert.rejects(a.query('SELECT * FROM han_saas.tenants'), (e) => e.code === '42501');
      await assert.rejects(a.query('TRUNCATE han_data.clients'), (e) => e.code === '42501');
      await assert.rejects(
        a.query('UPDATE han_private.han_state SET tenant_id=$1', [office.id]),
        (e) => e.code === '42501',
      );
    });

    await t.test('HTTP login and session cookies cannot be reused across offices', async () => {
      const sa = await serve(createApplication({ store: createStore(a) }));
      const sb = await serve(createApplication({ store: createStore(b) }));
      servers.push(sa, sb);
      const login = await fetch(sa.url + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
        body: JSON.stringify({ username: 'test', password }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      assert.equal((await fetch(sa.url + '/api/session', { headers: { cookie } })).status, 200);
      const foreign = await (await fetch(sb.url + '/api/session', { headers: { cookie } })).json();
      assert.equal(foreign.user, null);
      assert.equal((await b.query('SELECT * FROM han_private.han_sessions')).rows.length, 0);
    });

    await t.test(
      'normalized records and composite foreign keys cannot reference another tenant',
      async () => {
        for (const db of [a, b]) {
          await importRecords(db);
          await activateRecords(db);
        }
        assert.equal((await a.query('SELECT name FROM han_data.clients')).rows[0].name, 'Private First');
        assert.equal((await b.query('SELECT name FROM han_data.clients')).rows[0].name, 'Private Second');
        await b.query(
          `INSERT INTO han_data.clients(id,body,ordinal) VALUES ('foreign-client','{"id":"foreign-client"}',2)`,
        );
        await assert.rejects(
          a.query(`INSERT INTO han_data.documents(id,body,ordinal)
        VALUES ('bad-reference','{"client":"foreign-client"}',1)`),
          (e) => e.code === '23503',
        );
        await a.query(
          `INSERT INTO han_data.documents(id,body,ordinal) VALUES ('same-doc','{"id":"same-doc","client":"same-client","number":"ICRA-9"}',1)`,
        );
        await b.query(
          `INSERT INTO han_data.documents(id,body,ordinal) VALUES ('same-doc','{"id":"same-doc","client":"same-client","number":"ICRA-3"}',1)`,
        );
        assert.equal(
          (await a.query('SELECT last_value::text FROM han_data.document_sequences')).rows[0].last_value,
          '9',
        );
        assert.equal(
          (await b.query('SELECT last_value::text FROM han_data.document_sequences')).rows[0].last_value,
          '3',
        );
      },
    );

    await t.test('updates, audit, maintenance and backups stay within the bound office', async () => {
      const sa = createStore(a, { records: true });
      const sb = createStore(b, { records: true });
      await sa.transaction(({ state, saveState }) => {
        state.data['icrapro-v1'].clients[0].name = 'Changed First';
        saveState(state);
      });
      assert.equal((await sb.readState()).data['icrapro-v1'].clients[0].name, 'Private Second');
      await sa.appendAudit([{ category: 'changes', action: 'update', area: 'private-one', fields: [] }]);
      assert.equal((await sb.listAudit({ category: 'changes' })).items.length, 0);
      const backup = await sa.exportBackup();
      assert.equal(backup.data['icrapro-v1'].clients.length, 1);
      assert.equal(backup._hanBackup.audit.length, 2);
      assert.equal(JSON.stringify(backup).includes('Private Second'), false);
      await a.query(`INSERT INTO han_private.han_jobs(name) VALUES('workspace-maintenance')
        ON CONFLICT(tenant_id,name) DO UPDATE SET next_at=CURRENT_TIMESTAMP,last_success_at=null`);
      await b.query("INSERT INTO han_private.han_jobs(name) VALUES('workspace-maintenance')");
      assert.equal(await sa.maintenance(() => {}), true);
      assert.equal(
        (await b.query('SELECT last_success_at FROM han_private.han_jobs')).rows[0].last_success_at,
        null,
      );
    });

    await t.test('VoIP calls, settings and active-call limits stay within each office', async () => {
      const voip = require('../lib/voip-store.cjs');
      const call = {
        id: 'same-call',
        documentId: 'same-doc',
        phone: '905320000000',
        userId: 'test-ceo',
        requestId: 'same-request',
        createdAt: '2026-11-10T09:00:00.000Z',
        status: 'ringing',
      };
      for (const [db, name] of [
        [a, 'first'],
        [b, 'second'],
      ])
        await voip.transaction(
          db,
          true,
          (tx) => {
            tx.state.voipConfig = { provider: 'verimor', label: name };
            tx.state.voipCalls.push({ ...call, staffName: name });
            tx.saveState(tx.state);
          },
          { configWrite: true },
        );
      for (const [db, name] of [
        [a, 'first'],
        [b, 'second'],
      ]) {
        const seen = await voip.transaction(
          db,
          true,
          (tx) => ({ config: tx.state.voipConfig, calls: tx.state.voipCalls }),
          { list: { offset: 0 } },
        );
        assert.equal(seen.config.label, name);
        assert.deepEqual(
          seen.calls.map((row) => row.staffName),
          [name],
        );
      }
    });

    await t.test('connection role and tenant settings are reset after rollback and reuse', async () => {
      await assert.rejects(a.query('SELECT 1/0'), (e) => e.code === '22012');
      assert.equal(
        (await b.query('SELECT tenant_id FROM han_private.han_state')).rows[0].tenant_id,
        office.id,
      );
      assert.notEqual((await pool.query('SELECT current_user AS role')).rows[0].role, 'han_tenant_runtime');
      assert.ok(!(await pool.query("SELECT current_setting('han.tenant_id',true) AS id")).rows[0].id);
    });

    await t.test('object storage rejects another office backup before contacting R2', async () => {
      let opened = false;
      const backups = createBackupService({
        store: createStore(b),
        cloud: true,
        r2Client: () => {
          opened = true;
          throw Error('Must not contact R2');
        },
      });
      const filename = '2026-11-08T00-00-00-000Z-00000000-0000-4000-8000-000000000001.hnb';
      for (const key of [
        `hanhukuk/production/${filename}`,
        `hanhukuk/${filename}`,
        `hanhukuk/tenants/${LEGACY_TENANT_ID}/production/${filename}`,
      ]) {
        await assert.rejects(
          backups.download(key, { id: 'test-ceo' }, () => {}),
          (e) => e.status === 404,
        );
      }
      assert.equal(opened, false);
    });
  } finally {
    for (const server of servers) await server.close();
    await pg.close();
  }
});

test('Tenant migration preserves existing active records, unknown metadata and audit', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { pg, pool } = await database(false);
  try {
    for (const name of ['001-state.sql', '002-audit.sql'])
      await pg.exec(fs.readFileSync(path.join(__dirname, '../migrations', name), 'utf8'));
    const directory = path.join(__dirname, '../supabase/migrations');
    const migration = '20261108093130_tenant_data_isolation.sql';
    const numberMigration = '20261107235838_intake_document_numbers.sql';
    const state = fixture();
    state.unknownMetadata = { preserved: 'Tarihsel bilgi' };
    state.data['icrapro-v1'].clients = [{ id: 'original-client', name: 'Original' }];
    state.data['icrapro-v1'].docs = [{ id: 'original-doc', client: 'original-client', number: 'S-0025' }];
    state.data['icrapro-v1'].archivedNumbers = ['S-0100', 'ç-0009'];
    let imported = false;
    for (const name of fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.sql') && name < migration)
      .sort()) {
      if (!imported && name >= numberMigration) {
        await importState(pool, state);
        imported = true;
      }
      await pg.exec('BEGIN');
      await pg.exec(fs.readFileSync(path.join(directory, name), 'utf8'));
      await pg.exec('COMMIT');
    }
    await importRecords(pool);
    await activateRecords(pool);
    await pool.query(
      "INSERT INTO han_private.han_audit(category,action,area,fields) VALUES('changes','create','historical', '{}')",
    );
    await pg.exec('BEGIN');
    await pg.exec(fs.readFileSync(path.join(directory, migration), 'utf8'));
    await pg.exec('COMMIT');
    const store = createStore(pool, { records: true });
    assert.deepEqual(await store.readState(), state);
    assert.deepEqual((await pool.query('SELECT payload FROM han_private.han_state')).rows[0].payload, state);
    assert.equal((await store.listAudit({ category: 'changes' })).items[0].area, 'historical');
    const counters = (
      await pool.query('SELECT prefix,last_value::text AS n FROM han_data.document_sequences ORDER BY prefix')
    ).rows;
    assert.ok(counters.some((r) => r.prefix === 'S' && r.n === '100'));
    assert.ok(counters.some((r) => r.prefix === 'Ç' && r.n === '9'));
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('han_private','han_data') AND c.relkind='r'
        AND c.relname<>'han_migrations' AND NOT c.relrowsecurity`);
    assert.equal(rows[0].n, 0);
  } finally {
    await pg.close();
  }
});

test('VoIP tables created after tenant isolation receive tenant keys and RLS', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { pg, pool } = await database(false);
  try {
    for (const name of ['001-state.sql', '002-audit.sql'])
      await pg.exec(fs.readFileSync(path.join(__dirname, '../migrations', name), 'utf8'));
    const directory = path.join(__dirname, '../supabase/migrations');
    const voipMigration = '20261110090000_tenant_voip_tables.sql';
    for (const name of fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.sql') && name < voipMigration)
      .sort()) {
      await pg.exec('BEGIN');
      await pg.exec(fs.readFileSync(path.join(directory, name), 'utf8'));
      await pg.exec('COMMIT');
    }
    // An office that adopted tenant isolation first, then deployed VoIP.
    await pg.exec(fs.readFileSync(path.join(__dirname, '../migrations/003-voip.sql'), 'utf8'));
    await pg.exec('BEGIN');
    await pg.exec(fs.readFileSync(path.join(directory, voipMigration), 'utf8'));
    await pg.exec('COMMIT');
    const { rows } = await pool.query(`SELECT c.relname, c.relrowsecurity AS rls,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id') AS tenant
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='han_private' AND c.relkind='r' AND c.relname LIKE 'voip%' ORDER BY c.relname`);
    assert.deepEqual(
      rows.map((row) => [row.relname, row.rls, row.tenant]),
      [
        ['voip_calls', true, true],
        ['voip_config', true, true],
        ['voip_recording_access', true, true],
      ],
    );
    const office = await createTenant(pool, { slug: 'late-voip', name: 'Late VoIP', ownerUserId: 'owner' });
    const voip = require('../lib/voip-store.cjs');
    for (const db of [createTenantPool(pool, LEGACY_TENANT_ID), createTenantPool(pool, office.id)])
      await voip.transaction(
        db,
        false,
        (tx) => {
          tx.state.voipCalls.push({
            id: 'call',
            documentId: 'doc',
            phone: '905320000000',
            userId: 'user',
            requestId: 'request',
            createdAt: '2026-11-10T09:00:00.000Z',
            status: 'answered',
          });
          tx.saveState(tx.state);
        },
        {},
      );
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM han_private.voip_calls')).rows[0].n, 2);
  } finally {
    await pg.close();
  }
});
