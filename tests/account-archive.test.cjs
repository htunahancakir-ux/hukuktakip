const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, database, serve, password } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');
const { businessDate } = require('../lib/business-time.cjs');
const { accountBalances } = require('../lib/record-store/accounts.cjs');

for (const records of [false, true])
  test(
    'Zero-balance accounts can be archived without losing history or accepting new transactions: ' + records,
    async () => {
      const { pg, pool } = await database();
      let server;
      try {
        const s = fixture(),
          today = businessDate();
        s.data['hanhukuk-accounting-v1'] = {
          accounts: [
            { id: 'cash', name: 'Active Cash', type: 'cash' },
            { id: 'old', name: 'Old Bank', type: 'bank' },
          ],
          entries: [
            { id: 'initial', type: 'in', amount: 10000, accountId: 'cash', date: today, note: 'Opening' },
            {
              id: 'old-in',
              type: 'in',
              amount: 1000,
              accountId: 'old',
              date: today,
              note: 'Historic incoming',
            },
            {
              id: 'old-out',
              type: 'out',
              amount: 1000,
              expenseCategory: 'Masraf',
              accountId: 'old',
              date: today,
              note: 'Historic outgoing',
            },
          ],
        };
        s.data['icrapro-v1'].docs = [
          {
            id: 'd',
            number: '1',
            debtor: 'Test',
            docType: 'Senet',
            amount: 1000,
            status: 'Derdest',
            trackingDate: today,
          },
        ];
        await importState(pool, s);
        if (records) {
          await importRecords(pool);
          await activateRecords(pool);
        }
        const store = createStore(pool, { records });
        server = await serve(require('../lib/application.cjs').createApplication({ store }));
        const login = await fetch(server.url + '/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
          body: JSON.stringify({ username: 'test', password }),
        });
        assert.equal(login.status, 200);
        const headers = {
          cookie: login.headers.get('set-cookie').split(';')[0],
          'Content-Type': 'application/json',
          'X-Han-Request': '1',
        };
        const post = (url, data, method = 'POST') =>
          fetch(server.url + url, { method, headers, body: JSON.stringify(data) });
        const before = await store.readState();
        const archive = (account) =>
          post(
            '/api/data/patch?key=hanhukuk-accounting-v1',
            diff(
              'hanhukuk-accounting-v1',
              { accounts: [account], entries: [] },
              { accounts: [{ ...account, active: false }], entries: [] },
            ),
            'PUT',
          );
        const cash = before.data['hanhukuk-accounting-v1'].accounts.find((a) => a.id === 'cash');
        const old = before.data['hanhukuk-accounting-v1'].accounts.find((a) => a.id === 'old');
        assert.equal((await archive(cash)).status, 409, 'A nonzero balance cannot be silently hidden');
        const archived = await archive(old);
        assert.equal(archived.status, 200, await archived.text());
        const saved = await store.readState();
        assert.equal(saved.data['hanhukuk-accounting-v1'].accounts.find((a) => a.id === 'old').active, false);
        assert.deepEqual(
          saved.data['hanhukuk-accounting-v1'].entries,
          before.data['hanhukuk-accounting-v1'].entries,
        );
        assert.deepEqual(saved.data['hanhukuk-finance-v1'], before.data['hanhukuk-finance-v1']);
        if (records) {
          assert.deepEqual(await accountBalances(pool), { cash: '10000', old: '0' });
          const report = await fetch(server.url + '/api/records/accounting?account=old', { headers });
          assert.equal(report.status, 200);
          const data = await report.json();
          assert.equal(data.items.length, 2);
          assert.equal(data.accounts.find((a) => a.id === 'old').name, 'Old Bank');
        }
        for (const value of [
          { type: 'in', accountId: 'old' },
          { type: 'out', expenseCategory: 'Masraf', accountId: 'old' },
          { type: 'transfer', accountId: 'cash', destination: 'old' },
        ]) {
          const r = await post('/api/cash-entry', {
            id: 'rejected-' + value.type,
            amount: 1,
            date: today,
            note: 'Must not save',
            ...value,
          });
          assert.equal(r.status, 400);
        }
        const funding = await post('/api/expense-pool/fund', {
          id: 'rejected-funding',
          accountId: 'old',
          amount: 1,
          date: today,
          note: 'Must not save',
        });
        assert.equal(funding.status, 400);
        const payment = {
          id: 'rejected-payment',
          documentId: 'd',
          accountId: 'old',
          amount: 1,
          date: today,
          note: 'Must not save',
          type: 'payment',
          turnoverStaffId: 'turnover:bonus',
        };
        const raw = await post(
          '/api/data/patch?key=hanhukuk-finance-v1',
          diff('hanhukuk-finance-v1', [], [payment]),
          'PUT',
        );
        assert.equal(raw.status, 400);
        const after = await store.readState();
        assert.deepEqual(
          after.data['hanhukuk-accounting-v1'].entries,
          before.data['hanhukuk-accounting-v1'].entries,
        );
        assert.deepEqual(after.data['hanhukuk-finance-v1'], before.data['hanhukuk-finance-v1']);
      } finally {
        await server?.close();
        await pg.close();
      }
    },
  );
