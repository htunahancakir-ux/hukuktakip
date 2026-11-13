const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { database, fixture, serve } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createApplication } = require('../lib/application.cjs');
const { createTenant } = require('../lib/saas/tenants.cjs');
const { createTenantPool } = require('../lib/saas/tenant-pool.cjs');
const { fromState, acknowledgement } = require('../lib/conflict-check.cjs');
const { partyNamesMatch, partyTokens, partyIdentity } = require('../outputs/icrapro/party-name.js');

function conflictState() {
  const state = fixture();
  state.data['icrapro-personnel-v1'].push(
    { id: 'owner', name: 'Dosya Sahibi', department: 'Tahsilat', active: true },
    { id: 'other', name: 'Başka Personel', department: 'Tahsilat', active: true },
  );
  state.data['icrapro-v1'].clients = [
    {
      id: 'c1',
      name: 'Yıldız İnşaat A.Ş.',
      tradeName: 'Yıldız İnşaat A.Ş.',
      type: 'Şirket',
      identity: '1234567890',
    },
    { id: 'c2', name: 'Ahmet Kaya', fullName: 'Ahmet Kaya', type: 'Şahıs', identity: '11111111110' },
  ];
  state.data['icrapro-v1'].docs = [
    {
      id: 'd1',
      number: 'D-001',
      debtor: 'Mehmet Ali Yılmaz',
      identity: '22222222220',
      client: 'c1',
      amount: 100,
      status: 'Derdest',
      relatedStaff: 'owner',
      guarantors: [{ id: 'g1', name: 'Fatma Demir', identity: '33333333330' }],
    },
    {
      id: 'd2',
      number: 'D-002',
      debtor: 'Zeynep Arslan',
      identity: '',
      client: 'c2',
      amount: 100,
      status: 'İnfaz',
      relatedStaff: 'other',
    },
  ];
  state.deletedDocuments = [
    {
      document: {
        id: 'd9',
        number: 'D-009',
        debtor: 'Silinmiş Borçlu',
        client: 'c1',
        amount: 100,
        status: 'Derdest',
      },
      deletedAt: '2026-01-01T00:00:00.000Z',
      deletedBy: 'test-ceo',
      deletedByName: 'Test',
    },
  ];
  return state;
}
const ceo = { role: 'ceo', permissions: [] },
  owner = { role: 'staff', staffId: 'owner', permissions: [] },
  stranger = { role: 'staff', staffId: 'other', permissions: [] };

test('Party names match across case, Turkish letters, punctuation and company suffixes', () => {
  assert.equal(partyNamesMatch('YILDIZ İNŞAAT ANONİM ŞİRKETİ', 'Yıldız inşaat a.ş.'), 'exact');
  assert.equal(partyNamesMatch('Mehmet Yılmaz', 'mehmet ali yılmaz'), 'partial');
  assert.equal(partyNamesMatch('Yılmaz', 'Mehmet Yılmaz'), null, 'one shared word is not a match');
  assert.equal(partyNamesMatch('Mehmet Yılmaz', 'Mehmet Kaya'), null);
  assert.equal(partyNamesMatch('', 'Mehmet'), null);
  assert.deepEqual(partyTokens('Öz-Ak Tic. ve San. Ltd. Şti.'), ['oz', 'ak']);
  assert.equal(partyIdentity(' 123 456 78901 '), '12345678901');
  assert.equal(partyIdentity('abc'), '');
});

test('A client entered as debtor or guarantor is a conflict; the same side is only information', () => {
  const state = conflictState();
  // New debtor who is an existing client: conflict by name and by tax number.
  let result = fromState(state, { kind: 'debtor', name: 'Yıldız İnşaat Anonim Şirketi' }, ceo);
  assert.equal(result.conflicts, 1);
  assert.deepEqual(
    result.items.map((item) => [item.role, item.conflict, item.nameMatch]),
    [['client', true, 'exact']],
  );
  result = fromState(state, { kind: 'guarantor', name: 'Başka Ad', identity: '1234567890' }, ceo);
  assert.equal(result.conflicts, 1);
  assert.equal(result.items[0].identityMatch, true);
  // New client who is a debtor in one file and a guarantor in the same file.
  result = fromState(state, { kind: 'client', name: 'Mehmet Yılmaz' }, ceo);
  assert.deepEqual(
    result.items.map((item) => [item.role, item.number, item.conflict, item.nameMatch, item.clientName]),
    [['debtor', 'D-001', true, 'partial', 'Yıldız İnşaat A.Ş.']],
  );
  result = fromState(state, { kind: 'client', name: 'Fatma Demir' }, ceo);
  assert.deepEqual(
    result.items.map((item) => [item.role, item.number]),
    [['guarantor', 'D-001']],
  );
  // The same debtor's second file is information, not a conflict.
  result = fromState(state, { kind: 'debtor', name: 'Mehmet Ali Yılmaz', identity: '22222222220' }, ceo);
  assert.equal(result.conflicts, 0);
  assert.equal(result.infos, 1);
  // Archived files are searched too.
  result = fromState(state, { kind: 'client', name: 'Silinmiş Borçlu' }, ceo);
  assert.deepEqual(
    result.items.map((item) => [item.number, item.archived]),
    [['D-009', true]],
  );
  // No names and no valid number: nothing to compare.
  assert.deepEqual(fromState(state, { kind: 'client', name: ' ', identity: '12' }, ceo).items, []);
  assert.throws(() => fromState(state, { kind: 'x', name: 'A B' }, ceo), { code: 400 });
});

test('Staff see details only for their own files; other matches are counted, not described', () => {
  const state = conflictState();
  let result = fromState(state, { kind: 'client', name: 'Mehmet Ali Yılmaz' }, owner);
  assert.equal(result.conflicts, 1);
  assert.equal(result.hidden, 0);
  assert.equal(result.items[0].number, 'D-001');
  result = fromState(state, { kind: 'client', name: 'Mehmet Ali Yılmaz' }, stranger);
  assert.equal(result.conflicts, 1, 'the conflict still has to be acknowledged');
  assert.equal(result.hidden, 1);
  assert.deepEqual(result.items, []);
  // Client records need the clients permission; archived files are for managers.
  assert.equal(fromState(state, { kind: 'debtor', name: 'Ahmet Kaya' }, owner).hidden, 1);
  assert.equal(
    fromState(state, { kind: 'debtor', name: 'Ahmet Kaya' }, { ...owner, permissions: ['clients'] }).items
      .length,
    1,
  );
  assert.equal(fromState(state, { kind: 'client', name: 'Silinmiş Borçlu' }, owner).hidden, 1);
  assert.throws(() => acknowledgement({ kind: 'client', name: 'A', reason: 'kısa' }), { code: 400 });
  assert.equal(
    acknowledgement({ kind: 'client', name: 'A', count: 2, reason: '  İsim   benzerliği, farklı kişi.  ' })
      .reason,
    'İsim benzerliği, farklı kişi.',
  );
});

test('The record store finds the same conflicts per office and records the acknowledgement', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = conflictState();
    state.users.push({ ...state.users[0], id: 'staff', username: 'staff', role: 'staff', staffId: 'other' });
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    const session = async (id) => {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
        [crypto.createHash('sha256').update(token).digest('hex'), id, Date.now() + 600000],
      );
      return { headers: { cookie: 'han_session=' + token } };
    };
    const manager = await session('test-ceo'),
      staff = await session('staff');
    const ask = (req, input) => store.recordQueries.conflicts(req, input);
    assert.deepEqual(
      (await ask(manager, { kind: 'debtor', name: 'yildiz insaat' })).items.map((item) => [
        item.role,
        item.conflict,
      ]),
      [['client', true]],
    );
    let result = await ask(manager, { kind: 'client', name: 'Mehmet Yılmaz' });
    assert.deepEqual(
      result.items.map((item) => [item.role, item.number, item.nameMatch]),
      [['debtor', 'D-001', 'partial']],
    );
    assert.equal(
      (await ask(manager, { kind: 'client', identity: '33333333330' })).items[0].role,
      'guarantor',
    );
    assert.equal((await ask(manager, { kind: 'client', name: 'Silinmiş Borçlu' })).items[0].archived, true);
    result = await ask(staff, { kind: 'client', name: 'Mehmet Ali Yılmaz' });
    assert.deepEqual([result.conflicts, result.hidden, result.items.length], [1, 1, 0]);
    assert.deepEqual((await ask(manager, { kind: 'client', name: "' OR 1=1 --" })).items, []);
    assert.deepEqual((await ask(manager, { kind: 'client', name: '%_' })).items, []);
    await assert.rejects(ask({ headers: {} }, { kind: 'client', name: 'Mehmet Yılmaz' }), { status: 401 });

    server = await serve(createApplication({ store }));
    const headers = { ...manager.headers, 'X-Han-Request': '1', 'Content-Type': 'application/json' };
    const http = await fetch(
      server.url + '/api/conflicts?kind=client&name=' + encodeURIComponent('Fatma Demir'),
      {
        headers,
      },
    );
    assert.equal(http.status, 200);
    assert.equal((await http.json()).items[0].role, 'guarantor');
    const ack = await fetch(server.url + '/api/conflicts/ack', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'client',
        name: 'Fatma Demir',
        count: 1,
        reason: 'İsim benzerliği; farklı kişi.',
      }),
    });
    assert.equal(ack.status, 200, await ack.clone().text());
    const audit = await fetch(server.url + '/api/audit', { headers }).then((r) => r.json());
    const entry = audit.items.find((row) => row.action === 'conflict');
    assert.ok(entry, JSON.stringify(audit).slice(0, 400));
    assert.equal(entry.record_ref, 'Fatma Demir');
    assert.ok(entry.fields.some((field) => field.includes('İsim benzerliği')));

    // Another office never sees these parties.
    const office = await createTenant(pool, {
        slug: 'other-office',
        name: 'Other Office',
        ownerUserId: 'owner-two',
      }),
      foreignPool = createTenantPool(pool, office.id);
    const { rows } = await foreignPool.query(
      'SELECT (SELECT count(*) FROM han_data.documents)::int AS documents,(SELECT count(*) FROM han_data.clients)::int AS clients',
    );
    assert.deepEqual(rows[0], { documents: 0, clients: 0 });
    await assert.rejects(
      createStore(foreignPool, { records: true }).recordQueries.conflicts(manager, {
        kind: 'client',
        name: 'Mehmet Yılmaz',
      }),
    );
  } finally {
    await server?.close();
    await pg.close();
  }
});
