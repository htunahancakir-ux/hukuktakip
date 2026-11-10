const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { database, fixture, serve } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { payoutPage, payoutDetail } = require('../lib/record-store/client-payouts.cjs');
const { createApplication } = require('../lib/application.cjs');
test('Payout pages and scoped writes preserve complete totals, unrelated data, audit and idempotency', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture(),
      data = state.data;
    data['icrapro-v1'].clients = [{ id: 'c', name: 'IŞIK %_', iban: 'PRIVATE-IBAN' }];
    data['icrapro-v1'].docs = Array.from({ length: 123 }, (_, i) => ({
      id: 'd' + i,
      number: 'D-' + i,
      client: 'c',
      debtor: 'İPEK ' + i,
      amount: 100,
      status: 'İnfaz',
      docType: 'Senet',
      closedDate: '2026-01-02',
      trackingDate: '2026-01-01',
      fileData: 'unused-file-' + i,
    }));
    data['hanhukuk-finance-v1'] = data['icrapro-v1'].docs.map((d) => ({
      id: 'pay' + d.id,
      documentId: d.id,
      type: 'payment',
      amount: 10000,
      date: '2026-01-02',
      closes: true,
      accountId: 'cash',
    }));
    data['hanhukuk-accounting-v1'] = {
      accounts: [
        { id: 'cash', name: 'Kasa' },
        { id: 'bank', name: 'Banka' },
        { id: 'poor', name: 'Düşük Bakiye' },
      ],
      entries: [
        { id: 'fund', type: 'in', amount: 10000, accountId: 'bank', date: '2026-01-01' },
        {
          id: 'partial',
          type: 'clientPayout',
          amount: 2000,
          accountId: 'cash',
          documentId: 'd0',
          clientId: 'c',
          date: '2026-01-02',
        },
        { id: 'poor-fund', type: 'in', amount: 7000, accountId: 'poor', date: '2026-01-01' },
      ],
    };
    data['icrapro-v1'].docs[1].clientPaidAmount = 30;
    data['icrapro-v1'].docs[2].docType = 'Yediemin Park Ücreti';
    data['icrapro-v1'].docs[2].parkingCommissionRate = 20;
    data['icrapro-v1'].docs[3].status = 'Derdest';
    data['icrapro-v1'].docs[4].clientPaidAmount = 100;
    data['icrapro-v1'].docs[5].closedDate = '';
    data['hanhukuk-finance-v1'][5].closes = false;
    state.users.push({ ...state.users[0], id: 'staff', username: 'staff', role: 'staff' });
    state.data['icrapro-personnel-v1'].push({
      id: 'accountant-person',
      name: 'Accountant',
      department: 'Muhasebe',
      active: true,
    });
    state.users.push({
      ...state.users[0],
      id: 'accountant',
      username: 'accountant',
      role: 'staff',
      staffId: 'accountant-person',
      permissions: [],
    });
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const reqs = {};
    for (const id of ['test-ceo', 'staff', 'accountant']) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
        [crypto.createHash('sha256').update(token).digest('hex'), id, Date.now() + 600000],
      );
      reqs[id] = { headers: { cookie: 'han_session=' + token } };
    }
    const req = reqs['test-ceo'],
      first = await payoutPage(pool, req);
    assert.equal(first.items.length, 50);
    assert.equal(first.totals.count, '121');
    assert.equal((await payoutPage(pool, reqs.accountant)).totals.count, '121');
    assert.equal(first.totals.remaining, '1203000');
    const second = await payoutPage(pool, req, { after: first.next }),
      third = await payoutPage(pool, req, { after: second.next });
    assert.deepEqual(second.totals, first.totals);
    assert.equal(third.items.length, 21);
    assert.equal(new Set([...first.items, ...second.items, ...third.items].map((x) => x.id)).size, 121);
    assert.equal(JSON.stringify(first).includes('PRIVATE-IBAN'), false);
    assert.equal(JSON.stringify(first).includes('unused-file'), false);
    for (const [filter, count] of [
      [{ paymentState: 'partial' }, '2'],
      [{ paymentState: 'unpaid' }, '119'],
      [{ debtor: 'ipek 122' }, '1'],
      [{ start: '2026-01-02', end: '2026-01-02' }, '120'],
      [{ minCents: '8000', maxCents: '8000' }, '2'],
      [{ number: "' OR true --" }, '0'],
    ])
      assert.equal((await payoutPage(pool, req, filter)).totals.count, count);
    await assert.rejects(payoutPage(pool, req, { after: first.next, client: 'c' }), { status: 400 });
    await assert.rejects(payoutPage(pool, reqs.staff), { status: 403 });
    const detail = await payoutDetail(pool, req, 'd0');
    assert.equal(detail.totals.remaining, '8000');
    assert.equal(detail.client.iban, 'PRIVATE-IBAN');
    assert.equal(detail.record.fileData, undefined);
    const before = (
      await pool.query(
        "SELECT id,body,revision FROM han_data.documents WHERE id NOT IN ('d0','d7','d8','d9') ORDER BY id",
      )
    ).rows;
    const connect = pool.connect.bind(pool);
    let failWrite = false,
      failureCode;
    pool.connect = async () => {
      const connection = await connect();
      const query = connection.query;
      connection.query = async (sql, params) => {
        if (failWrite && sql.startsWith('INSERT INTO han_data.ledger_entries')) {
          failWrite = false;
          throw Object.assign(Error('Synthetic ledger failure'), { code: failureCode });
        }
        return query(sql, params);
      };
      return connection;
    };
    server = await serve(createApplication({ store: createStore(pool, { records: true }) }));
    const headers = { ...reqs.accountant.headers, 'X-Han-Request': '1', 'Content-Type': 'application/json' };
    async function pay(v, custom = headers) {
      const r = await fetch(server.url + '/api/client-payout', {
        method: 'POST',
        headers: custom,
        body: JSON.stringify({
          id: 'request1',
          documentId: 'd0',
          clientId: 'c',
          accountId: 'bank',
          amount: 3000,
          date: '2026-01-03',
          note: 'Test',
          ...v,
        }),
      });
      return { status: r.status, data: await r.json() };
    }
    const denied = await pay({}, { ...headers, ...reqs.staff.headers });
    assert.equal(denied.status, 403);
    assert.equal((await pay({ amount: 9000 })).status, 400);
    const auditBefore = (await pool.query('SELECT count(*)::text AS n FROM han_private.han_audit')).rows[0].n;
    failWrite = true;
    assert.ok((await pay({})).status >= 500);
    assert.equal(failWrite, false);
    assert.equal(
      (await pool.query("SELECT count(*)::text AS n FROM han_data.ledger_entries WHERE id='request1'"))
        .rows[0].n,
      '0',
    );
    assert.equal(
      (await pool.query('SELECT count(*)::text AS n FROM han_private.han_audit')).rows[0].n,
      auditBefore,
    );
    failWrite = true;
    failureCode = '40001';
    const ok = await pay({});
    assert.equal(failWrite, false);
    assert.equal(ok.status, 200, JSON.stringify(ok));
    assert.equal(ok.data.accountBalances.bank, '7000');
    assert.equal((await pay({})).status, 200);
    assert.equal((await pay({ amount: 2000 })).status, 409);
    assert.equal(
      (await pool.query("SELECT count(*)::text AS n FROM han_data.ledger_entries WHERE id='request1'"))
        .rows[0].n,
      '1',
    );
    assert.equal((await payoutDetail(pool, req, 'd0')).totals.remaining, '5000');
    const competing = await Promise.all([
      pay({ id: 'race1', documentId: 'd7', accountId: 'cash', amount: 6000 }),
      pay({ id: 'race2', documentId: 'd7', accountId: 'cash', amount: 6000 }),
    ]);
    assert.deepEqual(competing.map((x) => x.status).sort(), [200, 400]);
    const bankRace = await Promise.all([
      pay({ id: 'bankrace1', documentId: 'd8', accountId: 'poor', amount: 5000 }),
      pay({ id: 'bankrace2', documentId: 'd9', accountId: 'poor', amount: 5000 }),
    ]);
    assert.deepEqual(bankRace.map((x) => x.status).sort(), [200, 400]);
    assert.equal((await pay({ id: 'request2', amount: 5000 })).status, 200);
    await assert.rejects(payoutDetail(pool, req, 'd0'), { status: 409 });
    assert.deepEqual(
      (
        await pool.query(
          "SELECT id,body,revision FROM han_data.documents WHERE id NOT IN ('d0','d7','d8','d9') ORDER BY id",
        )
      ).rows,
      before,
    );
    assert.equal(
      (await pool.query('SELECT count(*)::text AS n FROM han_data.attachments WHERE active')).rows[0].n,
      '123',
    );
    assert.equal((await fetch(server.url + '/api/records/client-payouts', { headers })).status, 200);
    const audit = await (
      await fetch(server.url + '/api/audit?category=changes', { headers: req.headers })
    ).json();
    assert.match(JSON.stringify(audit), /client-payout|Müvekkil|Ödeme/i);
  } finally {
    await server?.close();
    await pg.close();
  }
});
