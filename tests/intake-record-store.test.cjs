const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');

test('Intake allocates server numbers, isolates edits, searches all clients and preserves receipts and archives', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    state.data['icrapro-v1'] = {
      clients: Array.from({ length: 123 }, (_, i) => ({
        id: 'c' + i,
        name: 'Client ' + i,
        identity: String(10000000000 + i),
      })),
      docs: Array.from({ length: 75 }, (_, i) => ({
        id: 'd' + i,
        number: 'S-' + String(i + 1).padStart(4, '0'),
        docType: 'Senet',
        client: 'c' + i,
        debtor: i < 56 ? 'AYNI BORÇLU' : 'BORÇLU ' + i,
        identity: i < 56 ? '20000000000' : String(20000000000 + i),
        amount: 100,
        notes: 'unchanged',
        futureField: { retained: true },
      })),
      archivedNumbers: ['S-0200', 'ç-0009'],
    };
    state.data['icrapro-v1'].docs[2].number = 'S-0001'; // Historical duplicates must survive.
    state.data['icrapro-v1'].docs[0].fileData = 'data:application/pdf;base64,JVBERi0x';
    state.data['icrapro-v1'].docs[0].fileName = 'test.pdf';
    state.data['icrapro-v1'].docs[0].conversations = [{ id: 'talk', note: 'evidence' }];
    state.data['icrapro-v1'].docs[0].linkedDocumentIds = ['d2'];
    state.data['icrapro-personnel-v1'] = [{ id: 'p', name: 'Staff', active: true }];
    state.deletedDocuments = [
      {
        id: 'archived',
        document: { id: 'deleted', number: 'S-0150', docType: 'Senet', client: 'c0', amount: 150 },
      },
    ];
    state.data['hanhukuk-accounting-v1'].accounts = [{ id: 'cash', name: 'Cash' }];
    state.data['hanhukuk-finance-v1'] = [
      {
        id: 'payment',
        documentId: 'd0',
        accountId: 'cash',
        type: 'payment',
        amount: 1000,
        date: '2026-01-01',
      },
    ];
    state.users.push(
      ...['staff', 'denied'].map((name) => ({
        ...state.users[0],
        id: name,
        username: name,
        role: 'staff',
        permissions: name === 'staff' ? ['documents'] : [],
      })),
    );
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    const pristine = await store.readState();
    assert.deepEqual(pristine.data, state.data, 'import/restore triggers must never rewrite business data');
    assert.equal(
      (await pool.query("SELECT last_value::text AS n FROM han_data.document_sequences WHERE prefix='S'"))
        .rows[0].n,
      '200',
    );

    // Historical migration rehearsal now lives in tenant-isolation.test.cjs,
    // where it runs before tenant keys and policies are installed.
    server = await serve(createApplication({ store }));
    async function login(username) {
      const r = await fetch(server.url + '/api/login', {
        method: 'POST',
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(r.status, 200, await r.text());
      return {
        cookie: r.headers.get('set-cookie').split(';')[0],
        'X-Han-Request': '1',
        'Content-Type': 'application/json',
      };
    }
    const headers = await login('test');
    async function get(url, auth = headers) {
      const r = await fetch(server.url + url, { headers: auth }),
        body = await r.json();
      assert.equal(r.status, 200, JSON.stringify(body));
      return body;
    }
    async function patch(old, next, auth = headers) {
      const r = await fetch(server.url + '/api/data/patch?key=icrapro-v1&operation=intake', {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify(
          diff('icrapro-v1', { clients: [], docs: old ? [old] : [] }, { clients: [], docs: [next] }),
        ),
      });
      return { status: r.status, body: await r.json() };
    }
    const lookup = await get('/api/records/search?kind=client');
    assert.equal(lookup.items.length, 50);
    assert.equal(lookup.more, true);
    const allClients = [...lookup.items];
    let clientCursor = lookup.next;
    while (clientCursor) {
      const page = await get(
        '/api/records/search?' + new URLSearchParams({ kind: 'client', after: clientCursor }),
      );
      allClients.push(...page.items);
      clientCursor = page.next;
    }
    assert.equal(allClients.length, 123);
    assert.equal(new Set(allClients.map((item) => item.id)).size, 123);
    const matchingClients = [];
    clientCursor = '';
    do {
      const page = await get(
        '/api/records/search?' + new URLSearchParams({ kind: 'client', q: 'Client', after: clientCursor }),
      );
      matchingClients.push(...page.items);
      clientCursor = page.next;
    } while (clientCursor);
    assert.equal(new Set(matchingClients.map((item) => item.id)).size, 123);
    for (const after of [Buffer.from('null').toString('base64url'), lookup.next]) {
      const response = await fetch(
        server.url + '/api/records/search?' + new URLSearchParams({ kind: 'client', q: 'different', after }),
        { headers },
      );
      assert.equal(response.status, 400);
    }
    const found = await get('/api/records/search?kind=client&id=c122');
    assert.equal(found.items.length, 1);
    assert.equal(found.items[0].id, 'c122');
    assert.equal(
      (await get('/api/records/search?' + new URLSearchParams({ kind: 'client', id: "' OR 1=1 --" }))).items
        .length,
      0,
    );
    let after = '',
      numbers = [];
    do {
      const p = await get(
        '/api/records/documents?' +
          new URLSearchParams({ status: 'Tümü', limit: 50, sort: 'entryOrder', after }),
      );
      assert.equal(p.totals.count, '75');
      assert.equal(p.totals.principalCents, '750000');
      numbers.push(...p.items.map((d) => d.id));
      after = p.next;
    } while (after);
    assert.equal(new Set(numbers).size, 75);
    const related = await get('/api/records/related?id=d0');
    assert.equal(related.items.length, 50);
    const related2 = await get(
      '/api/records/related?' + new URLSearchParams({ id: 'd0', after: related.next }),
    );
    assert.equal(related2.items.length, 5);
    assert.equal(new Set([...related.items, ...related2.items].map((d) => d.id)).size, 55);
    const batch = await get(
      '/api/records/intake-batch?' +
        new URLSearchParams({ ids: JSON.stringify(['d0', 'd74', 'deleted', 'missing']) }),
    );
    assert.equal(batch.items.length, 2);
    assert.equal(batch.items.find((r) => r.record.id === 'd74').client.name, 'Client 74');
    assert(
      batch.items.every(
        (r) =>
          !r.record.fileData && !r.record.conversations?.length && !r.record.notes && !r.record.futureField,
      ),
    );
    assert.equal(
      (
        await fetch(
          server.url +
            '/api/records/intake-batch?' +
            new URLSearchParams({ ids: JSON.stringify(Array(101).fill('d0')) }),
          { headers },
        )
      ).status,
      400,
    );
    assert.equal((await fetch(server.url + '/api/records/related?id=d0')).status, 401);

    const queries = [],
      connect = pool.connect;
    pool.connect = async () => {
      const db = await connect();
      return {
        release: db.release,
        query: (sql, args) => {
          queries.push(sql);
          return db.query(sql, args);
        },
      };
    };
    const old = pristine.data['icrapro-v1'].docs[0];
    const saved = await patch(old, {
      ...old,
      notes: 'only selected changed',
      officeIdentity: '00123456789',
      phone1: '05321234567',
      phoneSources: { 5321234567: 'Eşi Ayşe' },
    });
    pool.connect = connect;
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert(
      !queries.some((sql) =>
        /SELECT id,body,ordinal,revision,active FROM han_data.(documents|clients) ORDER/.test(sql),
      ),
      'no full document/client hydration',
    );
    assert(queries.some((sql) => /FROM han_data.documents WHERE id=ANY/.test(sql)));
    const editedState = await store.readState();
    assert.deepEqual(editedState.data['icrapro-v1'].docs.slice(1), pristine.data['icrapro-v1'].docs.slice(1));
    for (const key of Object.keys(pristine.data).filter((k) => k !== 'icrapro-v1'))
      assert.deepEqual(editedState.data[key], pristine.data[key]);
    const edited = editedState.data['icrapro-v1'].docs.find((d) => d.id === 'd0');
    assert.equal(edited.futureField.retained, true);
    assert.equal(edited.officeIdentity, '00123456789');
    assert.deepEqual(edited.phoneSources, { 5321234567: 'Eşi Ayşe' });
    assert.equal(edited.fileData, old.fileData);
    assert.deepEqual(edited.conversations, old.conversations);
    assert.deepEqual(editedState.deletedDocuments, pristine.deletedDocuments);
    assert.equal((await patch(old, { ...old, notes: 'stale' })).status, 409);
    assert.equal(
      (await patch(edited, { ...edited, amount: 110 })).status,
      200,
      'CEO can edit financially active principal',
    );
    const ceoEdited = (await store.readState()).data['icrapro-v1'].docs.find((d) => d.id === 'd0');
    assert.equal((await patch(ceoEdited, { ...ceoEdited, amount: 100 })).status, 200);
    assert.equal((await patch(edited, { ...edited, number: 'S-9999' })).status, 400);

    const create = (id, overrides = {}) => ({
      id,
      docType: 'Senet',
      client: 'c122',
      debtor: 'YENİ BORÇLU',
      identity: '30000000000',
      amount: 100,
      officeIdentity: '',
      originalDocument: 'Alındı',
      recordedBy: 'p',
      receivedById: 'p',
      receivedBy: 'Staff',
      deliveredBy: 'Test',
      number: 'S-9999',
      created: '1990-01-01',
      trackingDate: '1990-01-01',
      ...overrides,
    });
    const attempts = await Promise.all([
      patch(null, create('new1', { identity: '' })),
      patch(null, create('new2')),
    ]);
    for (const result of attempts) assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(attempts[0].body.records[0].value.imatikFolioNumber, undefined);
    assert.equal(attempts[1].body.records[0].value.imatikFolioNumber, undefined);
    assert.deepEqual(attempts.map((r) => r.body.records[0].value.number).sort(), ['201', '202']);
    for (const r of attempts) assert.notEqual(r.body.records[0].value.trackingDate, '1990-01-01');
    assert.equal((await patch(null, create('new1'))).status, 409);
    assert.equal((await patch(null, create('bad-client', { client: 'missing' }))).status, 400);
    assert.equal((await patch(null, create('duplicate-client', { identity: '10000000122' }))).status, 409);
    assert.equal(
      (
        await patch(
          null,
          create('duplicate-borrower', { identity: '20000000074', debtor: 'DIFFERENT PERSON' }),
        )
      ).status,
      409,
    );
    assert.equal((await patch(null, create('deleted'))).status, 409);
    assert.equal((await patch(null, create('bad-field', { status: 'İnfaz' }))).status, 400);
    const staff = await login('staff'),
      denied = await login('denied');
    const officeDraft = (await store.readState()).data['icrapro-v1'].docs.find((d) => d.id === 'new1');
    assert.equal(
      (await patch(officeDraft, { ...officeDraft, officeIdentity: '00123456789' }, staff)).status,
      200,
    );
    const officeSaved = (await store.readState()).data['icrapro-v1'].docs.find((d) => d.id === 'new1');
    const clearedOffice = await patch(officeSaved, { ...officeSaved, officeIdentity: '' }, staff);
    assert.equal(clearedOffice.status, 200, JSON.stringify(clearedOffice.body));
    assert.equal(
      (await store.readState()).data['icrapro-v1'].docs.find((d) => d.id === 'new1').officeIdentity,
      '',
    );
    assert.equal((await patch(null, create('denied'), denied)).status, 403);
    assert.equal((await patch(null, create('bad-assignment', { relatedStaff: 'p' }), staff)).status, 403);
    const staffSaved = await patch(null, create('staff-created'), staff);
    assert.equal(staffSaved.status, 200, JSON.stringify(staffSaved.body));
    assert.equal(
      staffSaved.body.records[0].value.number,
      '203',
      'failed mutations roll back number allocation',
    );
    let commits = 0;
    pool.connect = async () => {
      const db = await connect();
      let businessTransaction = false;
      return {
        release: db.release,
        query: (sql, args) => {
          if (sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE') businessTransaction = true;
          if (businessTransaction && sql === 'COMMIT' && commits++ === 0)
            throw Object.assign(Error('Synthetic serialization failure'), { code: '40001' });
          return db.query(sql, args);
        },
      };
    };
    const retried = await patch(null, create('retried'));
    pool.connect = connect;
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.records[0].value.number, '204');
    assert.equal(commits, 2, 'serialization retries rerun the complete rolled-back transaction');
    const check = await patch(null, create('cheque', { docType: 'Çek', identity: '40000000000' }));
    assert.equal(check.status, 200, JSON.stringify(check.body));
    assert.equal(check.body.records[0].value.number, '205');

    const chain = await fetch(server.url + '/api/documents/chain', {
      method: 'POST',
      headers,
      body: JSON.stringify({ documentId: 'd0', targetId: 'new1', action: 'add' }),
    });
    assert.equal(chain.status, 200, await chain.text());
    const final = await store.readState(),
      d0 = final.data['icrapro-v1'].docs.find((d) => d.id === 'd0');
    assert.deepEqual(
      d0.linkedDocumentIds,
      ['d2', 'new1'],
      'linking another record must preserve older links',
    );
    assert.equal(d0.fileData, old.fileData);
    assert.deepEqual(
      final.data['icrapro-v1'].docs.filter((d) => /^d\d+$/.test(d.id) && d.id !== 'd0'),
      pristine.data['icrapro-v1'].docs.slice(1),
    );
    assert.equal(final.data['icrapro-v1'].docs.length, 80);
    assert.equal((await get('/api/records/documents?limit=1&status=Tümü')).totals.principalCents, '800000');
    assert(
      (await pool.query("SELECT count(*)::int AS n FROM han_private.han_audit WHERE category='changes'"))
        .rows[0].n > 0,
    );
  } finally {
    await server?.close();
    await pg.close();
  }
});
