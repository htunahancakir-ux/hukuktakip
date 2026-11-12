const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const { database, fixture, serve } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createApplication } = require('../lib/application.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');
test('One editor wins; other users can read but not write documents, collections, payouts or attachments; release and expiry transfer editing', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const s = fixture();
    s.users.push({
      ...s.users[0],
      id: 'manager',
      username: 'manager',
      name: 'Second Manager',
      role: 'admin',
    });
    s.data['icrapro-v1'].clients = [{ id: 'c', name: 'Client' }];
    s.data['icrapro-v1'].docs = ['one', 'two'].map((id) => ({
      id,
      number: id,
      client: 'c',
      debtor: 'Borrower',
      docType: 'Senet',
      amount: 1000,
      originalAmount: 1000,
      preTrackingPayment: 0,
      financeInterest: 0,
      financeFee: 0,
      financeTermsManual: true,
      status: 'Derdest',
    }));
    s.data['hanhukuk-accounting-v1'].accounts = [{ id: 'cash', name: 'Cash' }];
    await importState(pool, s);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store, background: () => {} }));
    await pool.query("UPDATE han_private.han_jobs SET next_at=clock_timestamp()+interval '1 day'");
    const headers = {};
    for (const u of s.users) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
        [crypto.createHash('sha256').update(token).digest('hex'), u.id, Date.now() + 86400000],
      );
      headers[u.id] = {
        cookie: 'han_session=' + token,
        'X-Han-Request': '1',
        'Content-Type': 'application/json',
      };
    }
    const views = { 'test-ceo': crypto.randomUUID(), manager: crypto.randomUUID() };
    async function request(path, user, data, method = 'POST') {
      const r = await fetch(server.url + path, {
        method,
        headers: headers[user],
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      return { status: r.status, body: await r.json() };
    }
    const claim = (user, action = 'acquire', extra = {}) =>
      request('/api/documents/lease', user, { documentId: 'one', viewId: views[user], action, ...extra });
    const results = await Promise.all(s.users.map((u) => claim(u.id)));
    assert(
      results.every((r) => r.status === 200),
      JSON.stringify(results),
    );
    assert.equal(results.filter((r) => r.body.editable).length, 1);
    const owner = s.users[results.findIndex((r) => r.body.editable)].id,
      viewer = s.users.find((u) => u.id !== owner).id;
    assert.equal((await claim(owner)).body.editable, true);
    assert.equal((await claim(viewer)).body.ownerName, s.users.find((u) => u.id === owner).name);
    assert.equal((await request('/api/records/document?id=one', viewer, null, 'GET')).status, 200);
    const principal = { documentId: 'one', expectedPrincipal: 100000, amount: 90000 };
    const denied = await request('/api/documents/principal', viewer, principal);
    assert.equal(denied.status, 423, JSON.stringify(denied));
    let before = (await store.readState()).data['icrapro-v1'];
    let after = structuredClone(before);
    after.docs[0].debtor = 'Blocked edit';
    assert.equal(
      (await request('/api/data/patch?key=icrapro-v1', viewer, diff('icrapro-v1', before, after), 'PUT'))
        .status,
      423,
    );
    const payment = {
      id: 'blocked-payment',
      type: 'payment',
      documentId: 'one',
      amount: 10000,
      accountId: 'cash',
      date: new Date().toISOString().slice(0, 10),
      note: 'Synthetic',
      collectionStaffId: 'other:bonus',
    };
    // Exercise the shared transaction guard independently of individual command validation.
    for (const change of [
      (state) => state.data['hanhukuk-finance-v1'].push(payment),
      (state) =>
        state.data['hanhukuk-accounting-v1'].entries.push({
          id: 'blocked-payout',
          documentId: 'one',
          type: 'out',
          amount: 100,
        }),
      (state) => {
        state.data['icrapro-v1'].docs[0].fileData = 'synthetic attachment';
      },
    ])
      await assert.rejects(
        store.transaction(
          ({ state, saveState }) => {
            change(state);
            saveState(state);
          },
          {
            req: { headers: headers[viewer] },
            url: new URL('http://test/api/custom'),
            raw: Buffer.from('{}'),
          },
        ),
        { status: 423 },
      );
    assert.equal((await request('/api/documents/principal', owner, principal)).status, 200);
    assert.equal(
      (await request('/api/documents/principal', viewer, { ...principal, documentId: 'two' })).status,
      200,
    );
    // A viewer and an older view from the owner must not release the editor's lease.
    await claim(viewer, 'release');
    await claim(owner, 'release', { viewId: crypto.randomUUID() });
    assert.equal((await claim(viewer)).body.editable, false);
    await claim(owner, 'release');
    assert.equal((await claim(viewer)).body.editable, true);
    assert.equal(
      (
        await request('/api/documents/principal', viewer, {
          ...principal,
          expectedPrincipal: 90000,
          amount: 80000,
        })
      ).status,
      200,
    );
    await pool.query("UPDATE han_private.document_leases SET expires_at=$1 WHERE document_id='one'", [
      Date.now() - 1,
    ]);
    assert.equal((await claim(owner)).body.editable, true);
    // Revoked sessions cease to hold the file even before the heartbeat expires.
    await pool.query('DELETE FROM han_private.han_sessions WHERE account_id=$1', [owner]);
    assert.equal((await claim(viewer)).body.editable, true);
    assert.equal(
      (
        await request('/api/documents/lease', viewer, {
          documentId: 'missing',
          viewId: views[viewer],
          action: 'acquire',
        })
      ).status,
      404,
    );
    const saved = await store.readState();
    assert.equal(saved.data['hanhukuk-finance-v1'].length, 0);
    assert.equal(saved.data['icrapro-v1'].docs.find((d) => d.id === 'one').amount, 800);
  } finally {
    await server?.close();
    await pg.close();
  }
});
test('Viewer windows disable edits, retain navigation, update after owner closes, and release only when their final window closes', async () => {
  const { JSDOM } = require('jsdom'),
    fs = require('node:fs');
  const dom = new JSDOM(
    '<dialog id="a" open><div class="panelhead">Föy</div><input><button id="save">Kaydet</button><button role="tab">Alacak</button><button id="close">Kapat</button></dialog><dialog id="b" open><div class="panelhead">Diğer pencere</div><input disabled></dialog>',
    { runScripts: 'dangerously', url: 'https://test.invalid' },
  );
  try {
    const w = dom.window,
      requests = [];
    let editable = false,
      poll;
    Object.assign(w, {
      hanRecordsEnabled: true,
      setInterval: (callback) => {
        poll = callback;
      },
      recordAction: async (_id, callback) => callback(),
      fetch: async (_url, options) => {
        const input = JSON.parse(options.body);
        requests.push(input);
        return {
          ok: true,
          json: async () =>
            input.action === 'release'
              ? { released: true }
              : { editable, ownerName: editable ? 'Me' : 'Other User' },
        };
      },
    });
    w.eval(fs.readFileSync('outputs/icrapro/workspace-document-leases.js', 'utf8'));
    const a = w.document.querySelector('#a'),
      b = w.document.querySelector('#b');
    w.bindFolioLock(a, 'one');
    w.bindFolioLock(b, 'one');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(a.querySelector('input').disabled, true);
    assert.equal(a.querySelector('#save').disabled, true);
    assert.equal(a.querySelector('[role=tab]').disabled, false);
    assert.equal(a.querySelector('#close').disabled, false);
    assert.match(a.textContent, /İzleme modu.*Other User/);
    const added = w.document.createElement('button');
    added.textContent = 'Yeni işlem';
    a.append(added);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(added.disabled, true);
    editable = true;
    poll();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(a.querySelector('input').disabled, false);
    assert.equal(b.querySelector('input').disabled, true); // original permissions preserved
    assert.match(a.textContent, /İşlem modu/);
    a.removeAttribute('open');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(requests.filter((r) => r.action === 'release').length, 0);
    b.removeAttribute('open');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(requests.filter((r) => r.action === 'release').length, 1);
  } finally {
    dom.window.close();
  }
});
