const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');

test('Client pages, selected attachments and isolated edits preserve totals, permissions and all other records', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture(),
      clients = Array.from({ length: 123 }, (_, i) => ({
        id: 'c' + i,
        name: 'Müvekkil ' + i,
        type: 'Şahıs',
        identity: String(10000000000 + i),
        notes: 'untouched',
        futureField: { retained: true },
      }));
    clients[0].name = 'IŞIK İNŞAAT %_';
    clients[2].name = 'Sakarya Mobilya';
    clients[80].name = 'SAK Beyaz Eşya';
    clients[81].name = 'İsak Tekstil';
    clients[121].tradeName = 'sak Ticaret';
    clients[0].attachments = [
      { id: 'a', name: 'test.pdf', kind: 'powerOfAttorney', data: 'data:application/pdf;base64,JVBERi0x' },
    ];
    clients[1].attachments = [
      { id: 'b', name: 'other.pdf', kind: 'powerOfAttorney', data: 'data:application/pdf;base64,JVBERi0y' },
    ];
    state.data['icrapro-v1'] = {
      clients,
      docs: [
        {
          id: 'd1',
          number: 'F-001',
          client: 'c0',
          debtor: 'Synthetic',
          identity: '20000000000',
          status: 'İnfaz',
          amount: 100,
          clientPaidAmount: 10,
        },
        { id: 'd2', client: 'c0', debtor: 'Second', status: 'İade', amount: 200 },
        { id: 'd3', client: 'c122', debtor: 'Third', status: 'Derdest', amount: 300 },
      ],
    };
    state.data['hanhukuk-accounting-v1'] = {
      accounts: [{ id: 'cash', name: 'Kasa' }],
      entries: [
        {
          id: 'paid',
          documentId: 'd1',
          accountId: 'cash',
          type: 'clientPayout',
          amount: 1500,
          date: '2026-11-01',
          accountName: 'Gönderen Banka',
          note: 'Kısmi ödeme',
        },
      ],
    };
    state.users.push(
      ...['allowed', 'denied'].map((username) => ({
        ...state.users[0],
        id: username,
        username,
        role: 'staff',
        permissions: username === 'allowed' ? ['clients'] : [],
      })),
    );
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store }));
    const login = async (username) => {
      const response = await fetch(server.url + '/api/login', {
        method: 'POST',
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(response.status, 200, await response.text());
      return {
        cookie: response.headers.get('set-cookie').split(';')[0],
        'X-Han-Request': '1',
        'Content-Type': 'application/json',
      };
    };
    const headers = await login('test');
    const get = async (path, auth = headers) => {
      const response = await fetch(server.url + path, { headers: auth });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    };
    const pages = [];
    let after = '';
    do {
      const result = await get('/api/records/clients?' + new URLSearchParams({ limit: 50, after }));
      assert.equal(result.count, '123');
      assert.deepEqual(result.summary, {
        clients: '123',
        documents: '3',
        amountCents: '60000',
        closed: '1',
        returned: '1',
        closedCents: '10000',
        paidCents: '2500',
      });
      assert(result.items.length <= 50);
      assert(result.items.every((c) => !('attachments' in c) && !('notes' in c)));
      pages.push(result);
      after = result.next;
    } while (after);
    assert.deepEqual(
      pages.map((p) => p.items.length),
      [50, 50, 23],
    );
    assert.equal(new Set(pages.flatMap((p) => p.items.map((c) => c.id))).size, 123);
    assert.equal(pages[0].items[0].documentCount, '2');
    const search = await get('/api/records/clients?' + new URLSearchParams({ q: 'isik insaat %_' }));
    assert.equal(search.count, '1');
    assert.deepEqual(search.summary, pages[0].summary);
    const prefix = await get('/api/records/clients?' + new URLSearchParams({ q: 'sak', limit: 2 }));
    assert.equal(prefix.count, '3');
    assert.deepEqual(
      prefix.items.map((c) => c.id),
      ['c2', 'c80'],
    );
    const rest = await get(
      '/api/records/clients?' + new URLSearchParams({ q: 'sak', limit: 2, after: prefix.next }),
    );
    assert.deepEqual(
      rest.items.map((c) => c.id),
      ['c121'],
    );
    const general = await get('/api/search?' + new URLSearchParams({ q: 'sak' }));
    assert.deepEqual(
      general.items
        .filter((c) => c.type === 'client')
        .slice(0, 3)
        .map((c) => c.id)
        .sort(),
      ['c121', 'c2', 'c80'],
    );
    assert.equal((await get('/api/records/clients?' + new URLSearchParams({ q: "' OR 1=1 --" }))).count, '0');
    assert.equal(
      (
        await fetch(
          server.url +
            '/api/records/clients?' +
            new URLSearchParams({ q: 'new query', after: pages[0].next }),
          { headers },
        )
      ).status,
      400,
    );
    const detail = await get('/api/records/client?id=c0');
    const statement = await get('/api/records/client?id=c0&section=statement');
    assert.equal(statement.totals.paid, '2500');
    assert.equal(statement.totals.count, '2');
    assert.ok(statement.items.every((e) => e.number === 'F-001'));
    const period = await get('/api/records/client?id=c0&section=statement&start=2026-11-01&end=2026-11-01');
    assert.equal(period.totals.paid, '1500');
    assert.equal(period.items[0].bank, 'Gönderen Banka');
    assert.equal(period.items[0].note, 'Kısmi ödeme');
    const otherStatement = await get('/api/records/client?id=c122&section=statement');
    assert.equal(otherStatement.totals.count, '0');
    assert.deepEqual(detail.record.attachments, []);
    assert.equal(detail.attachments.length, 1);
    const attachment = await get(
      '/api/records/client?' +
        new URLSearchParams({
          id: 'c0',
          section: 'attachment',
          attachmentId: detail.attachments[0].id,
          revision: detail.attachments[0].revision,
        }),
    );
    assert.deepEqual(attachment.value, clients[0].attachments[0]);
    assert.equal(
      (
        await fetch(
          server.url +
            '/api/records/client?' +
            new URLSearchParams({ id: 'c1', section: 'attachment', attachmentId: detail.attachments[0].id }),
          { headers },
        )
      ).status,
      404,
    );
    const before = await store.readState();
    const patch = (old, next, auth = headers) =>
      fetch(server.url + '/api/data/patch?key=icrapro-v1', {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify(
          diff('icrapro-v1', { clients: old ? [old] : [], docs: [] }, { clients: [next], docs: [] }),
        ),
      });
    const old = before.data['icrapro-v1'].clients[0],
      edited = { ...old, notes: 'updated alone' };
    const queried = [],
      connect = pool.connect;
    pool.connect = async () => {
      const db = await connect();
      return {
        release: db.release,
        query: async (sql, params) => {
          queried.push(sql);
          return db.query(sql, params);
        },
      };
    };
    const saved = await patch(old, edited);
    assert.equal(saved.status, 200, await saved.text());
    pool.connect = connect;
    assert(
      !queried.some((sql) => /SELECT id,body,ordinal,revision,active FROM han_data.documents/.test(sql)),
      'client save must not hydrate documents',
    );
    assert(
      queried.some((sql) => /FROM han_data.clients WHERE id=ANY/.test(sql)),
      'client save loads only requested IDs',
    );
    const afterEdit = await store.readState();
    const expected = structuredClone(before.data);
    expected['icrapro-v1'].clients[0].notes = 'updated alone';
    assert.deepEqual(afterEdit.data, expected, 'all unrelated data, attachments and unknown fields survive');
    assert.equal((await patch(old, { ...old, notes: 'stale overwrite' })).status, 409);
    assert.equal(
      (await patch(edited, { ...edited, identity: clients[122].identity })).status,
      409,
      'identity check covers clients beyond page one',
    );
    assert.equal(
      (await patch(null, { id: 'borrower-conflict', name: 'Duplicate', identity: '20000000000' })).status,
      409,
      'identity check includes all borrowers',
    );
    assert.equal((await patch(null, { id: 'new', name: 'New client', identity: '30000000000' })).status, 200);
    const allowed = await login('allowed'),
      denied = await login('denied');
    const staff = await get('/api/records/clients', allowed);
    assert.equal(
      (await fetch(server.url + '/api/records/client?id=c0&section=statement', { headers: allowed })).status,
      403,
    );
    assert.equal(staff.count, '124');
    assert.equal(staff.summary, null, 'staff cannot fetch financial summary');
    assert.equal((await fetch(server.url + '/api/records/clients', { headers: denied })).status, 403);
    assert.equal((await fetch(server.url + '/api/records/client?id=c0', { headers: denied })).status, 403);
    assert.equal((await patch(edited, { ...edited, notes: 'denied write' }, denied)).status, 403);
    assert.equal((await patch(edited, { ...edited, notes: 'allowed write' }, allowed)).status, 200);
    assert(
      (await pool.query("SELECT count(*)::int AS n FROM han_private.han_audit WHERE category='changes'"))
        .rows[0].n > 0,
    );
    assert.equal((await get('/api/records/clients')).summary.amountCents, '60000');
  } finally {
    await server?.close();
    await pg.close();
  }
});
