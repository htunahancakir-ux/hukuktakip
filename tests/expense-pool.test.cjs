const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { database, fixture, serve } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { accountBalances } = require('../lib/record-store/accounts.cjs');
const { reportPage } = require('../lib/record-store/reports.cjs');
const { dashboard } = require('../lib/record-store/dashboard.cjs');
const { balance } = require('../lib/record-store/balances.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');

for (const records of [false, true]) {
  test(`Ortak avans yalnızca bir kez giderleşir ve kalan korunur (${records ? 'kayıt deposu' : 'durum deposu'})`, async () => {
    const { pg, pool } = await database();
    let server;
    try {
      const state = fixture();
      state.users.push({ ...state.users[0], id: 'staff', username: 'staff', role: 'staff', permissions: [] });
      state.users.push({
        ...state.users[0],
        id: 'reader',
        username: 'reader',
        role: 'admin',
        readOnly: true,
      });
      state.users.push({
        ...state.users[0],
        id: require('../lib/deletion-policy.cjs').OWNER_ID,
        username: 'owner',
      });
      state.data['icrapro-v1'] = {
        clients: [{ id: 'client', name: 'Test Müvekkil' }],
        docs: [
          {
            id: 'd1',
            number: 'DOSYA-1',
            client: 'client',
            debtor: 'A',
            docType: 'Senet',
            amount: 10000,
            status: 'Derdest',
          },
          {
            id: 'd2',
            number: 'DOSYA-2',
            client: 'client',
            debtor: 'B',
            docType: 'Senet',
            amount: 10000,
            status: 'Derdest',
          },
          {
            id: 'closed',
            number: 'DOSYA-3',
            client: 'client',
            debtor: 'C',
            docType: 'Senet',
            amount: 100,
            status: 'İnfaz',
          },
          {
            id: 'd4',
            number: 'DOSYA-4',
            client: 'client',
            debtor: 'D',
            docType: 'Senet',
            amount: 100,
            financeFee: 200,
            status: 'Derdest',
          },
        ],
      };
      state.data['hanhukuk-accounting-v1'] = {
        accounts: [{ id: 'cash', name: 'Kasa', type: 'cash' }],
        entries: [{ id: 'opening', accountId: 'cash', type: 'in', amount: 2000000, date: '2026-01-01' }],
      };
      state.data['hanhukuk-finance-v1'] = [
        { id: 'payment', documentId: 'd1', type: 'payment', amount: 10000, date: '2026-01-01' },
        { id: 'payment2', documentId: 'd4', type: 'payment', amount: 20000, date: '2026-01-01' },
      ];
      await importState(pool, state);
      if (records) {
        await importRecords(pool);
        await activateRecords(pool);
      }
      const headers = {};
      for (const u of state.users) {
        const token = crypto.randomBytes(32).toString('hex');
        await pool.query(
          "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
          [crypto.createHash('sha256').update(token).digest('hex'), u.id, Date.now() + 600000],
        );
        headers[u.id] = {
          'X-Han-Request': '1',
          'Content-Type': 'application/json',
          cookie: 'han_session=' + token,
        };
      }
      server = await serve(createApplication({ store: createStore(pool, { records }) }));
      async function request(path, method = 'GET', body, who = 'test-ceo') {
        const res = await fetch(server.url + path, {
          method,
          headers: headers[who],
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: res.status, body: await res.json() };
      }
      const common = { date: '2026-01-02', note: 'Test masrafı' };
      const funding = { ...common, id: 'fund-1', accountId: 'cash', amount: 1000000 };
      for (const invalid of [{ id: undefined }, { amount: true }, { amount: '100' }, { note: { text: 'x' } }])
        assert.equal(
          (await request('/api/expense-pool/fund', 'POST', { ...funding, ...invalid })).status,
          400,
        );
      assert.equal((await request('/api/expense-pool/fund', 'POST', funding, 'staff')).status, 403);
      assert.equal((await request('/api/expense-pool/fund', 'POST', funding, 'reader')).status, 403);
      assert.equal(
        (await request('/api/expense-pool/fund', 'POST', { ...funding, amount: 2000001 })).status,
        400,
      );
      assert.equal((await request('/api/expense-pool/fund', 'POST', funding)).status, 200);
      assert.equal((await request('/api/expense-pool/fund', 'POST', funding)).status, 200);
      assert.equal(
        (
          await request('/api/expense-pool/allocate', 'POST', {
            ...common,
            date: '2026-01-01',
            id: 'before-funding',
            documentId: 'd1',
            type: 'expense',
            amount: 1,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request('/api/expense-pool/allocate', 'POST', {
            ...common,
            id: 'a1',
            documentId: 'd1',
            type: 'expense',
            amount: 200000,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await request('/api/expense-pool/allocate', 'POST', {
            ...common,
            id: 'a1',
            documentId: 'd1',
            type: 'expense',
            amount: 200000,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await request('/api/expense-pool/allocate', 'POST', {
            ...common,
            id: 'a2',
            documentId: 'd2',
            type: 'costOnly',
            amount: 300000,
          })
        ).status,
        200,
      );
      const result = await request('/api/expense-pool');
      assert.deepEqual(
        [result.body.funded, result.body.allocated, result.body.balance],
        [1000000, 500000, 500000],
      );
      assert.equal(result.body.movements.length, 3);
      assert.equal(
        (
          await request('/api/expense-pool/allocate', 'POST', {
            ...common,
            id: 'over',
            documentId: 'd1',
            type: 'expense',
            amount: 500001,
          })
        ).status,
        400,
      );
      const payload = records
        ? await require('../lib/record-store/storage.cjs').exportRecords(pool)
        : (await pool.query('SELECT payload FROM han_private.han_state WHERE id=1')).rows[0].payload;
      const events = payload.data['hanhukuk-finance-v1'];
      assert.equal(balance(payload.data['icrapro-v1'].docs[0], events).target_cents, '1200000');
      assert.equal(balance(payload.data['icrapro-v1'].docs[1], events).target_cents, '1000000');
      assert.equal(
        payload.data['hanhukuk-accounting-v1'].entries.find((e) => e.id === 'fund-1').amount,
        1000000,
      );
      if (records) {
        assert.deepEqual(await accountBalances(pool), { cash: '1000000' });
        const req = { headers: headers['test-ceo'] };
        const day = await dashboard(pool, req, { period: 'day', date: '2026-01-02' });
        assert.equal(day.buckets[0].expenses, '1000000');
        const report = await reportPage(pool, req, { type: 'finance' });
        assert.equal(report.totals.expense, '1000000');
      }
      const edited = structuredClone(events);
      edited.find((e) => e.id === 'a1').amount = 1;
      const patch = diff('hanhukuk-finance-v1', events, edited);
      assert.equal((await request('/api/data/patch?key=hanhukuk-finance-v1', 'PUT', patch)).status, 403);
      const forged = structuredClone(events);
      forged.push({ ...forged.find((row) => row.id === 'a1'), id: 'forged' });
      assert.equal(
        (
          await request(
            '/api/data/patch?key=hanhukuk-finance-v1',
            'PUT',
            diff('hanhukuk-finance-v1', events, forged),
          )
        ).status,
        403,
      );
      const ledger = payload.data['hanhukuk-accounting-v1'];
      const alteredLedger = structuredClone(ledger);
      alteredLedger.entries.find((entry) => entry.id === 'fund-1').amount = 1;
      assert.equal(
        (
          await request(
            '/api/data/patch?key=hanhukuk-accounting-v1',
            'PUT',
            diff('hanhukuk-accounting-v1', ledger, alteredLedger),
          )
        ).status,
        403,
      );
      const termsBefore = payload.data['icrapro-v1'];
      const termsAfter = structuredClone(termsBefore);
      termsAfter.docs.find((doc) => doc.id === 'd1').financeFee = 50;
      const termsPatch = diff('icrapro-v1', termsBefore, termsAfter);
      assert.equal((await request('/api/data/patch?key=icrapro-v1', 'PUT', termsPatch, 'staff')).status, 403);
      assert.equal((await request('/api/data/patch?key=icrapro-v1', 'PUT', termsPatch)).status, 200);
      const updated = records
        ? await require('../lib/record-store/storage.cjs').exportRecords(pool)
        : (await pool.query('SELECT payload FROM han_private.han_state WHERE id=1')).rows[0].payload;
      assert.equal(updated.data['icrapro-v1'].docs.find((doc) => doc.id === 'd1').financeFee, 50);
      const tooLow = structuredClone(updated.data['icrapro-v1']);
      tooLow.docs.find((doc) => doc.id === 'd4').financeFee = 50;
      assert.equal(
        (
          await request(
            '/api/data/patch?key=icrapro-v1',
            'PUT',
            diff('icrapro-v1', updated.data['icrapro-v1'], tooLow),
          )
        ).status,
        400,
      );
      const equalToPaid = structuredClone(updated.data['icrapro-v1']);
      equalToPaid.docs.find((doc) => doc.id === 'd4').financeFee = 100;
      assert.equal(
        (
          await request(
            '/api/data/patch?key=icrapro-v1',
            'PUT',
            diff('icrapro-v1', updated.data['icrapro-v1'], equalToPaid),
          )
        ).status,
        400,
      );
      const closedAfter = structuredClone(termsBefore);
      closedAfter.docs.find((doc) => doc.id === 'closed').financeFee = 50;
      assert.equal(
        (await request('/api/data/patch?key=icrapro-v1', 'PUT', diff('icrapro-v1', termsBefore, closedAfter)))
          .status,
        403,
      );
      const deleted = await request('/api/operations/delete?type=accounting&q=Test');
      // The fixture CEO is not the installation owner and cannot delete.
      assert.equal(deleted.status, 403);
      const owner = require('../lib/deletion-policy.cjs').OWNER_ID;
      const fundingList = await request('/api/operations/delete?type=accounting&q=Test', 'GET', null, owner);
      const fundingRow = fundingList.body.items.find((item) => item.id === 'fund-1');
      assert.equal(
        (
          await request(
            '/api/operations/delete',
            'POST',
            { type: 'accounting', id: fundingRow.id, revision: fundingRow.revision },
            owner,
          )
        ).status,
        409,
      );
      const financeList = await request('/api/operations/delete?type=finance&q=Test', 'GET', null, owner);
      const allocatedRow = financeList.body.items.find((item) => item.id === 'a1');
      assert.equal(
        (
          await request(
            '/api/operations/delete',
            'POST',
            { type: 'finance', id: allocatedRow.id, revision: allocatedRow.revision },
            owner,
          )
        ).status,
        200,
      );
      assert.equal((await request('/api/expense-pool')).body.balance, 700000);
      const race = await Promise.all(
        ['r1', 'r2'].map((id) =>
          request('/api/expense-pool/allocate', 'POST', {
            ...common,
            id,
            documentId: 'd2',
            type: 'costOnly',
            amount: 600000,
          }),
        ),
      );
      assert.deepEqual(race.map((result) => result.status).sort(), [200, 400]);
      assert.equal((await request('/api/expense-pool')).body.balance, 100000);
    } finally {
      await server?.close();
      await pg.close();
    }
  });
}
