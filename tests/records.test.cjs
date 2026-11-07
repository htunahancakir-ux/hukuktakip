const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { database, fixture } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importNormalized } = require('../lib/records/import.cjs');
const { createRecordRepository, balance } = require('../lib/records/repository.cjs');
const { createOutboxDispatcher } = require('../lib/records/outbox.cjs');

async function setup(count = 2, mutate = () => {}) {
  const db = await database();
  const state = fixture();
  state.users.push({
    ...state.users[0],
    id: 'staff',
    username: 'staff',
    role: 'staff',
    staffId: 'p1',
    permissions: [],
  });
  state.data['icrapro-personnel-v1'] = [{ id: 'p1', name: 'Personel', active: true }];
  state.data['icrapro-v1'].clients = [{ id: 'c1', name: 'Sentetik Müvekkil' }];
  state.data['icrapro-v1'].docs = Array.from({ length: count }, (_, i) => ({
    id: 'd' + String(i).padStart(5, '0'),
    number: 'TST-' + i,
    client: 'c1',
    debtor: 'Sentetik Borçlu ' + i,
    amount: 1000,
    status: 'Derdest',
    docType: 'Diğer',
    relatedStaff: i === 0 ? 'p1' : '',
    notes: 'Sentetik açıklama. '.repeat(count > 100 ? 140 : 1),
    conversations: [
      {
        id: 'c' + i,
        date: '2026-11-01',
        time: '10:00',
        note: 'Test',
        result: 'Görüşüldü',
        operatorId: 'test-ceo',
      },
    ],
  }));
  state.data['hanhukuk-accounting-v1'].accounts = [
    { id: 'cash', name: 'Kasa', type: 'cash' },
    { id: 'bank', name: 'Banka', type: 'bank' },
  ];
  state.data['hanhukuk-accounting-v1'].entries = [
    { id: 'opening', accountId: 'cash', type: 'in', amount: 100000, date: '2026-11-01' },
  ];
  state.customUnknownField = { keep: 'eksiksiz' };
  mutate(state);
  await importState(db.pool, state);
  await db.pg.exec(
    fs.readFileSync(
      path.join(__dirname, '../database/next/20261107010408_normalized_record_backend.sql'),
      'utf8',
    ),
  );
  await db.pool.query(
    `INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at,seen_at)
    VALUES ('token','test-ceo','desktop',$1,$2),('staff-token','staff','desktop',$1,$2)`,
    [Date.now() + 600000, Date.now()],
  );
  return { ...db, state };
}

test('Normalized import preserves source, rejects overwrite and rolls back orphan references', async () => {
  const { pg, pool, state } = await setup();
  try {
    const result = await importNormalized(pool);
    assert.equal(result.documents, 2);
    assert.equal(result.conversations, 2);
    assert.deepEqual(
      (await pool.query('SELECT source_payload FROM han_core.migration_checkpoint')).rows[0].source_payload,
      state,
    );
    assert.deepEqual(await createStore(pool).readState(), state);
    await assert.rejects(importNormalized(pool), (e) => e.code === '23505');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM han_core.documents')).rows[0].n, 2);
  } finally {
    await pg.close();
  }
  const broken = await setup(2, (state) => {
    state.data['icrapro-v1'].docs[1].client = 'missing';
  });
  try {
    await assert.rejects(importNormalized(broken.pool), (e) => e.code === '23503');
    assert.equal((await broken.pool.query('SELECT count(*)::int AS n FROM han_core.documents')).rows[0].n, 0);
    assert.deepEqual(await createStore(broken.pool).readState(), broken.state);
  } finally {
    await broken.pg.close();
  }
});

test('Record pages, per-record revision, financial idempotency, permissions and rollback', async () => {
  const { pg, pool } = await setup();
  try {
    await importNormalized(pool);
    const repo = createRecordRepository(pool);
    const first = await repo.listDocuments('token', { limit: 1 });
    assert.equal(first.items.length, 1);
    assert.ok(first.next);
    const next = await repo.listDocuments('token', { limit: 1, after: first.next });
    assert.equal(next.items.length, 1);
    assert.notEqual(first.items[0].id, next.items[0].id);
    assert.equal((await repo.listDocuments('staff-token')).items.length, 1);
    await assert.rejects(repo.listClients('staff-token'), (e) => e.status === 403);
    await assert.rejects(
      repo.updateDocumentNote('staff-token', 'denied-key', { id: 'd00001', revision: 1, note: 'no' }),
      (e) => e.status === 404,
    );
    const edits = await Promise.all([
      repo.updateDocumentNote('token', 'edit-key-a', { id: 'd00000', revision: 1, note: 'bir' }),
      repo.updateDocumentNote('token', 'edit-key-b', { id: 'd00001', revision: 1, note: 'iki' }),
    ]);
    assert.deepEqual(
      edits.map((r) => r.revision),
      ['2', '2'],
    );
    await assert.rejects(
      repo.updateDocumentNote('token', 'stale-key', { id: 'd00000', revision: 1, note: 'eski' }),
      (e) => e.status === 409,
    );
    const payment = {
      documentId: 'd00000',
      accountId: 'cash',
      amountCents: 5000,
      date: '2026-11-01',
      note: 'Test',
    };
    const paid = await repo.recordPayment('token', 'payment-key', payment);
    assert.deepEqual(await repo.recordPayment('token', 'payment-key', payment), paid);
    await assert.rejects(
      repo.recordPayment('token', 'payment-key', { ...payment, amountCents: 6000 }),
      (e) => e.status === 409,
    );
    await assert.rejects(
      repo.recordPayment('token', 'overflow-key', { ...payment, amountCents: 999999 }),
      (e) => e.status === 409,
    );
    await assert.rejects(repo.recordPayment('staff-token', 'staff-denied', payment), (e) => e.status === 403);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM han_core.financial_events')).rows[0].n, 1);
    const total = (await balance(pool, 'cash')) + (await balance(pool, 'bank'));
    await repo.transfer('token', 'transfer-key', {
      from: 'cash',
      to: 'bank',
      amountCents: 60000,
      date: '2026-11-01',
      note: 'Test',
    });
    assert.equal((await balance(pool, 'cash')) + (await balance(pool, 'bank')), total);
    await assert.rejects(
      repo.transfer('token', 'insufficient', {
        from: 'cash',
        to: 'bank',
        amountCents: 60000,
        date: '2026-11-01',
        note: 'Test',
      }),
      (e) => e.status === 409,
    );
    await pg.exec(`CREATE FUNCTION han_private.reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit failure'; END $$;
      CREATE TRIGGER reject_test_audit BEFORE INSERT ON han_private.han_audit FOR EACH ROW EXECUTE FUNCTION han_private.reject_test_audit();`);
    await assert.rejects(repo.recordPayment('token', 'audit-failure', { ...payment, amountCents: 1000 }));
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM han_core.financial_events')).rows[0].n,
      1,
      'financial entry rolled back with audit',
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM han_core.commands WHERE key='audit-failure'")).rows[0]
        .n,
      0,
    );
  } finally {
    await pg.close();
  }
});

test('Durable message queue survives a failed worker without automatic duplicate sends', async () => {
  const { pg, pool } = await setup();
  try {
    await importNormalized(pool);
    const repo = createRecordRepository(pool);
    const input = { recipientIds: ['staff'], subject: 'Test', text: 'Sentetik mesaj', whatsapp: true };
    const sent = await repo.enqueueMessage('token', 'message-key', input);
    assert.deepEqual(await repo.enqueueMessage('token', 'message-key', input), sent);
    let calls = 0;
    const worker = createOutboxDispatcher(pool, async () => {
      calls++;
      throw Error('unknown delivery');
    });
    assert.equal((await worker()).processed, 1);
    assert.equal((await worker()).processed, 0);
    assert.equal(calls, 1);
    assert.equal((await pool.query('SELECT status FROM han_core.outbox')).rows[0].status, 'unknown');
  } finally {
    await pg.close();
  }
});

test('A 2000-document source over 4 MiB is read in bounded record pages', async () => {
  const { pg, pool, state } = await setup(2000);
  try {
    assert.ok(Buffer.byteLength(JSON.stringify(state.data['icrapro-v1'])) > 4 * 1024 * 1024);
    await importNormalized(pool);
    const repo = createRecordRepository(pool);
    const result = await repo.listDocuments('token', { limit: 50 });
    assert.equal(result.items.length, 50);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 32768);
    const updated = await repo.updateDocumentNote('token', 'large-source-note', {
      id: result.items[0].id,
      revision: 1,
      note: 'Güncel',
    });
    assert.equal(updated.revision, '2');
    assert.ok(Buffer.byteLength(JSON.stringify(updated)) < 1024);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM han_core.documents')).rows[0].n, 2000);
  } finally {
    await pg.close();
  }
});

test('Normalized import and repository bind hostile values without executing SQL', async () => {
  const payload = "'); DELETE FROM han_core.documents; --";
  const { pg, pool } = await setup(2, (state) => {
    state.data['icrapro-v1'].clients[0].name = payload;
    state.data['icrapro-v1'].docs[0][payload] = payload;
  });
  try {
    await importNormalized(pool);
    assert.equal(
      (await pool.query("SELECT name FROM han_core.parties WHERE id='client:c1'")).rows[0].name,
      payload,
    );
    const repo = createRecordRepository(pool);
    await assert.rejects(repo.listDocuments("token' OR 1=1 --"), (e) => e.status === 401);
    await assert.rejects(
      repo.listDocuments('token', { limit: '1; DELETE FROM han_core.documents' }),
      (e) => e.status === 400,
    );
    await assert.rejects(
      repo.updateDocumentNote('token', 'hostile-id', {
        id: "d00000' OR '1'='1",
        revision: 1,
        note: 'not allowed',
      }),
      (e) => e.status === 404,
    );
    for (const options of [{ query: payload }, { after: "' OR 1=1 --" }]) {
      const result = await repo.listDocuments('staff-token', options);
      assert.ok(result.items.every((row) => row.assigned_staff_id === 'p1'));
    }
    await repo.updateDocumentNote('token', 'literal-note', { id: 'd00000', revision: 1, note: payload });
    const { rows } = await pool.query('SELECT id, extras FROM han_core.documents ORDER BY id');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].extras.notes, payload);
    assert.equal(rows[0].extras[payload], payload, 'Untrusted source keys stay JSON keys');
    assert.equal(rows[1].extras.notes, 'Sentetik açıklama. ');
  } finally {
    await pg.close();
  }
});
