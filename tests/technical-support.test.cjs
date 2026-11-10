const test = require('node:test');
const assert = require('node:assert/strict');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { markStateRecords } = require('../lib/test-records.cjs');

test('test provenance is server-owned, survives edits and does not relabel existing real records', () => {
  const before = fixture();
  before.data['icrapro-v1'].docs.push({ id: 'real', notes: 'Gerçek kayıt' });
  const actor = { id: 'support', name: 'Teknik Destek', testAccount: true };
  const next = structuredClone(before);
  next.marketingProspects = [{ id: 'prospect', company: 'Örnek Firma', notes: 'Ziyaret notu' }];
  next.data['icrapro-v1'].docs[0].notes = 'Destek tarafından güncellendi';
  next.data['icrapro-v1'].docs.push({
    id: 'test',
    notes: 'Örnek not',
    conversations: [{ id: 'c', note: 'Görüşme' }],
  });
  markStateRecords(before, next, actor);
  const record = next.data['icrapro-v1'].docs[1];
  assert.equal(next.data['icrapro-v1'].docs[0].testRecord, undefined);
  assert.equal(record.testRecord.userId, actor.id);
  assert.match(record.notes, /Örnek not\nTEST KAYDI — Teknik Destek/);
  assert.match(record.conversations[0].note, /TEST KAYDI/);
  assert.match(next.marketingProspects[0].notes, /Ziyaret notu\nTEST KAYDI/);
  const edited = structuredClone(next);
  delete edited.data['icrapro-v1'].docs[1].testRecord;
  edited.data['icrapro-v1'].docs[1].notes = 'Düzenlenen açıklama';
  edited.data['icrapro-v1'].docs[0].testRecord = { userId: 'forged' };
  markStateRecords(next, edited, { id: 'normal', name: 'Yönetici' });
  assert.equal(edited.data['icrapro-v1'].docs[0].testRecord, undefined);
  assert.deepEqual(edited.data['icrapro-v1'].docs[1].testRecord, record.testRecord);
  assert.match(edited.data['icrapro-v1'].docs[1].notes, /Düzenlenen açıklama\nTEST KAYDI/);
  markStateRecords(next, edited, actor);
  assert.equal(edited.data['icrapro-v1'].docs[1].notes.match(/TEST KAYDI/g).length, 1);
});

test('technical support has CEO settings access and normalized records retain visible test notes', async (t) => {
  const { pool, pg } = await database();
  const initial = fixture();
  Object.assign(initial.users[0], { name: 'Teknik Destek', role: 'ceo', readOnly: false, testAccount: true });
  initial.ceoPin = {
    ...(await require('../lib/ceo-pin.cjs').createPin('2468')),
    proofKey: 'ab'.repeat(32),
    scopes: ['integrations', 'permissions'],
  };
  initial.data['icrapro-v1'].docs.push({
    id: 'existing',
    number: 'D-1',
    debtor: 'Mevcut Borçlu',
    amount: 100,
  });
  initial.data['hanhukuk-accounting-v1'].accounts.push({ id: 'cash', name: 'Kasa', type: 'cash' });
  await importState(pool, initial);
  await importRecords(pool);
  await activateRecords(pool);
  const app = await serve(createApplication({ store: createStore(pool, { records: true }) }));
  t.after(async () => {
    await app.close();
    await pg.close();
  });
  const login = await fetch(app.url + '/api/login', {
    method: 'POST',
    headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test', password }),
  });
  assert.equal(login.status, 200);
  const user = await login.json();
  assert.equal(user.name, 'Teknik Destek');
  assert.equal(user.role, 'ceo');
  assert.equal(user.readOnly, false);
  assert.equal(user.testAccount, true);
  const headers = {
    cookie: login.headers.get('set-cookie').split(';')[0],
    'X-Han-Request': '1',
    'Content-Type': 'application/json',
  };
  for (const route of ['/api/ai/config', '/api/voip/config', '/api/users'])
    assert.equal(
      (await fetch(app.url + route, { headers })).status,
      200,
      'CEO support accounts have the same unrestricted access as other CEOs',
    );
  const unlock = await fetch(app.url + '/api/ceo-pin/verify', {
    method: 'POST',
    headers,
    body: JSON.stringify({ scope: 'integrations', pin: '2468' }),
  });
  assert.equal((await unlock.json()).ok, true);
  headers.cookie += '; ' + unlock.headers.get('set-cookie').split(';')[0];
  for (const route of ['/api/ai/config', '/api/voip/config', '/api/users', '/api/presence']) {
    const response = await fetch(app.url + route, { headers });
    assert.equal(response.status, 200, route + ': ' + (await response.text()));
  }
  const patch = async (key, changes) => {
    const response = await fetch(app.url + '/api/data/patch?key=' + key, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ version: 1, changes }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  await patch('icrapro-v1', [
    {
      path: ['clients'],
      id: 'new-client',
      before: null,
      value: { id: 'new-client', name: 'Örnek Müvekkil', notes: 'Elle girilen not' },
    },
  ]);
  const client = (await pool.query("SELECT body FROM han_data.clients WHERE id='new-client'")).rows[0].body;
  assert.equal(client.testRecord.userId, user.id);
  assert.match(client.notes, /Elle girilen not\nTEST KAYDI/);
  const clients = await (await fetch(app.url + '/api/records/clients', { headers })).json();
  assert.equal(clients.items.find((c) => c.id === 'new-client').testRecord.userId, user.id);
  const saved = await patch('icrapro-v1', [
    {
      path: ['clients'],
      id: 'new-client',
      field: 'notes',
      before: { value: client.notes },
      after: { value: 'Yeni açıklama' },
    },
  ]);
  assert.match(saved.records[0].value.notes, /Yeni açıklama\nTEST KAYDI/);
  await patch('icrapro-v1', [
    {
      path: ['docs'],
      id: 'existing',
      field: 'notes',
      before: {},
      after: { value: 'Gerçek kayıt güncellendi' },
    },
  ]);
  const real = (await pool.query("SELECT body FROM han_data.documents WHERE id='existing'")).rows[0].body;
  assert.equal(real.testRecord, undefined);
  const response = await fetch(app.url + '/api/documents/conversations', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      documentId: 'existing',
      date: '2026-01-01',
      time: '10:00',
      result: 'Görüşüldü',
      note: 'Elle girilen görüşme',
    }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.conversations[0].testRecord.userId, user.id);
  assert.match(result.conversations[0].note, /Elle girilen görüşme\nTEST KAYDI/);
  const conversation = (
    await pool.query("SELECT body FROM han_data.conversations WHERE document_id='existing'")
  ).rows[0].body.value;
  assert.equal(conversation.testRecord.userId, user.id);
  const post = async (route, value) => {
    const res = await fetch(app.url + route, { method: 'POST', headers, body: JSON.stringify(value) });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
  };
  const cash = {
    id: 'support-cash',
    type: 'in',
    accountId: 'cash',
    date: '2026-01-01',
    amount: 10000,
    note: 'Örnek kasa girişi',
  };
  await post('/api/cash-entry', cash);
  await post('/api/cash-entry', cash);
  const fund = {
    id: 'support-fund',
    accountId: 'cash',
    date: '2026-01-02',
    amount: 1000,
    note: 'Örnek masraf avansı',
  };
  await post('/api/expense-pool/fund', fund);
  await post('/api/expense-pool/fund', fund);
  const finance = (
    await pool.query("SELECT body FROM han_data.ledger_entries WHERE id IN ('support-cash','support-fund')")
  ).rows;
  assert.equal(finance.length, 2, 'Retrying must not create duplicate money movements');
  assert(finance.every((row) => row.body.testRecord.userId === user.id && /TEST KAYDI/.test(row.body.note)));
});
