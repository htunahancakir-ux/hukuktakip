const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { database, fixture, serve } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');
const rules = require('../outputs/icrapro/receivable-rules.js');
const units = require('../outputs/icrapro/receivable-units.js');
const { businessDate } = require('../lib/business-time.cjs');

test('Real currency collection API preserves TL cash, native balances, locks, idempotency, profit and client entitlement', async () => {
  const { pg, pool } = await database();
  let server;
  const realFetch = global.fetch,
    today = businessDate();
  global.fetch = async (url, options) => {
    const value = String(url);
    if (value.startsWith('https://www.tcmb.gov.tr/kurlar/')) {
      const match = value.match(/\/(\d{2})(\d{2})(\d{4})\.xml$/);
      assert(match);
      return new Response(
        '<Tarih_Date Tarih="' +
          match[1] +
          '.' +
          match[2] +
          '.' +
          match[3] +
          '"><Currency CurrencyCode="EUR"><Unit>1</Unit><ForexSelling>50.0000</ForexSelling></Currency><Currency CurrencyCode="USD"><Unit>1</Unit><ForexSelling>40.0000</ForexSelling></Currency></Tarih_Date>',
        { status: 200 },
      );
    }
    if (value.startsWith('https://www.borsaistanbul.com/metal-fiyatlari.php')) {
      const date = new URL(value).searchParams.get('endDate').replaceAll('/', '-');
      return Response.json({
        status: 'success',
        data: [
          {
            priceDate: date,
            priceRef: 'MTL',
            priceType: 'AU',
            priceCurrency: 'TRY',
            priceWeight: 'KG',
            priceValue: 6000000,
          },
        ],
      });
    }
    return realFetch(url, options);
  };
  try {
    const state = fixture(),
      ceo = state.users[0];
    state.users.push(
      { ...ceo, id: 'blocked', username: 'blocked', role: 'staff', permissions: [], readOnly: true },
      { ...ceo, id: 'viewer', username: 'viewer', role: 'staff', staffId: 'p', permissions: ['documents'] },
    );
    state.data['icrapro-personnel-v1'] = [
      { id: 'p', name: 'Ciro Personeli', active: true, department: 'Callcenter' },
    ];
    const doc = {
      id: 'd',
      number: '1',
      client: 'c',
      debtor: 'Borçlu',
      docType: 'Diğer',
      created: today + 'T07:00:00.000Z',
      trackingDate: today,
      status: 'Derdest',
      relatedStaff: 'p',
      financeTermsManual: true,
      financeInterest: 0,
      financeFee: 0,
      receivables: [
        ['t', 'TRY', 1000],
        ['e', 'EUR', 100],
        ['u', 'USD', 100],
        ['g', 'XAU', 1],
      ].map(([id, currency, amount]) => ({
        id,
        currency,
        amount,
        preTrackingPayment: 0,
        docType: 'Senet',
        due: today,
      })),
    };
    rules.sync(doc, today, () => null);
    state.data['icrapro-v1'] = { clients: [{ id: 'c', name: 'Müvekkil' }], docs: [doc] };
    state.data['hanhukuk-finance-v1'] = [];
    state.data['hanhukuk-accounting-v1'] = {
      ...state.data['hanhukuk-accounting-v1'],
      accounts: [{ id: 'a', name: 'Banka', type: 'bank' }],
      entries: [],
    };
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store }));
    async function session(id) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
        [crypto.createHash('sha256').update(token).digest('hex'), id, Date.now() + 600000],
      );
      return { cookie: 'han_session=' + token, 'X-Han-Request': '1', 'Content-Type': 'application/json' };
    }
    const headers = await session(ceo.id),
      blocked = await session('blocked'),
      viewer = await session('viewer');
    async function call(path, { method = 'GET', body, auth = headers } = {}) {
      const response = await realFetch(server.url + path, {
        method,
        headers: auth,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    }
    const get = async (path) => {
      const result = await call(path);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body;
    };
    const query = (unit) =>
      '/api/documents/currency-quote?' +
      new URLSearchParams({ documentId: 'd', currency: unit, date: today });
    assert.equal(
      (await call(query('EUR'), { auth: blocked })).status,
      200,
      'existing document visibility is retained for read-only accounts',
    );
    assert.equal((await realFetch(server.url + query('EUR'))).status, 401);
    async function payment(unit, amount, id) {
      const quote = await get(query(unit));
      const input = {
        documentId: 'd',
        currency: unit,
        amount,
        date: today,
        accountId: 'a',
        note: 'Dekont ' + id,
        turnoverStaffId: 'p',
        requestId: id,
        revision: quote.revision,
        quoteId: quote.quote.id,
      };
      const result = await call('/api/documents/currency-collection', { method: 'POST', body: input });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return { input, result: result.body };
    }
    const beforeTerms = await get(query('EUR'));
    const termInput = {
      documentId: 'd',
      currency: 'EUR',
      date: today,
      interest: 10,
      fee: 5,
      discount: 5,
      requestId: 'currency-terms-request',
      revision: beforeTerms.revision,
    };
    assert.equal(
      (await call('/api/documents/currency-terms', { method: 'POST', body: termInput, auth: viewer })).status,
      403,
    );
    assert.equal(
      (await call('/api/documents/currency-terms', { method: 'POST', body: termInput })).status,
      200,
    );
    assert.equal(
      (await call('/api/documents/currency-terms', { method: 'POST', body: termInput })).status,
      200,
      'terms retries are idempotent',
    );
    const first = await payment('EUR', 5500, 'currency-eur-request-1');
    assert.equal(
      (
        await call('/api/documents/currency-collection', {
          method: 'POST',
          body: { ...first.input, requestId: 'readonly-new-request' },
          auth: blocked,
        })
      ).status,
      403,
    );
    assert.equal(first.result.payment.amount, 550000);
    assert.equal(first.result.payment.unitAllocation.quantityMinor, 11000);
    assert.equal(first.result.payment.unitAllocation.principalTLMinor, 500000);
    assert.equal(first.result.payment.collectionStaffName, 'Ciro Personeli');
    assert.equal(first.result.record.status, 'Derdest');
    const afterFirst = await store.readState(),
      firstDoc = afterFirst.data['icrapro-v1'].docs[0];
    assert.deepEqual(
      units
        .foreignBalances(firstDoc, today, afterFirst.data['hanhukuk-finance-v1'])
        .map((g) => [g.currency, g.remaining]),
      [
        ['EUR', 0],
        ['USD', 10000],
        ['XAU', 1000],
      ],
    );
    assert.equal(
      require('../lib/record-store/balances.cjs').balance(
        firstDoc,
        afterFirst.data['hanhukuk-finance-v1'],
        today,
      ).remaining_cents,
      '100000',
    );
    assert.equal(
      (await call('/api/documents/currency-collection', { method: 'POST', body: first.input })).status,
      200,
    );
    assert.equal((await store.readState()).data['hanhukuk-finance-v1'].length, 1);
    const usd = await get(query('USD')),
      usdInput = {
        ...first.input,
        currency: 'USD',
        amount: 4000,
        note: 'USD dekont',
        requestId: 'currency-usd-locked',
        revision: usd.revision,
        quoteId: usd.quote.id,
      };
    assert.equal(
      (
        await call('/api/documents/lease', {
          method: 'POST',
          body: { documentId: 'd', viewId: 'owner-document-view', action: 'acquire' },
        })
      ).status,
      200,
    );
    assert.equal(
      (await call('/api/documents/currency-collection', { method: 'POST', body: usdInput, auth: viewer }))
        .status,
      423,
    );
    assert.equal((await store.readState()).data['hanhukuk-finance-v1'].length, 1);
    await call('/api/documents/lease', {
      method: 'POST',
      body: { documentId: 'd', viewId: 'owner-document-view', action: 'release' },
    });
    await payment('USD', 4000, 'currency-usd-request-2');
    await payment('XAU', 6000, 'currency-xau-request-3');
    let current = await store.readState();
    assert.equal(current.data['icrapro-v1'].docs[0].status, 'Derdest', 'TL principal still due');
    const events = current.data['hanhukuk-finance-v1'];
    const normal = {
      id: 'normal-tl-request',
      documentId: 'd',
      type: 'payment',
      date: today,
      amount: 100000,
      accountId: 'a',
      note: 'TL tahsilat',
      turnoverStaffId: 'p',
      closes: true,
      closedAmount: 100000,
    };
    const tl = await call('/api/data/patch?key=hanhukuk-finance-v1', {
      method: 'PUT',
      body: diff('hanhukuk-finance-v1', events, [...events, normal]),
    });
    assert.equal(tl.status, 200, JSON.stringify(tl.body));
    current = await store.readState();
    assert.equal(current.data['icrapro-v1'].docs[0].status, 'İnfaz');
    assert.equal(current.data['hanhukuk-finance-v1'].at(-1).principalAtCollection, 1600000);
    const bank = await require('../lib/record-store/accounts.cjs').accountBalances(pool);
    assert.equal(bank.a, '1650000');
    const dashboard = await get(
      '/api/records/dashboard?' + new URLSearchParams({ period: 'day', date: today }),
    );
    assert.equal(String(dashboard.buckets.reduce((n, row) => n + BigInt(row.collected), 0n)), '1650000');
    assert.equal(String(dashboard.buckets.reduce((n, row) => n + BigInt(row.revenue), 0n)), '50000');
    const payout = await get('/api/records/client-payouts');
    assert.equal(payout.items[0].entitlement, '1600000');
    assert.equal((await call('/api/documents/currency-report', { auth: viewer })).status, 403);
    const report = await get('/api/documents/currency-report?includeClosed=true');
    assert.equal(report.count, 3);
    assert.equal(report.totals.EUR.received, '11000');
    assert.equal(report.totals.XAU.remaining, '0');
    const old = current.data['hanhukuk-finance-v1'],
      forged = structuredClone(old);
    forged[0].unitAllocation.rateMicros = 1;
    assert.equal(
      (
        await call('/api/data/patch?key=hanhukuk-finance-v1', {
          method: 'PUT',
          body: diff('hanhukuk-finance-v1', old, forged),
        })
      ).status,
      403,
    );
    assert.equal(
      (await store.readState()).data['hanhukuk-finance-v1'][0].unitAllocation.rateMicros,
      50000000,
    );
    const pure = {
      id: 'd2',
      number: '',
      docType: 'Senet',
      client: 'c',
      debtor: 'Yalnız Euro Borçlusu',
      identity: '',
      phone1: '05551234567',
      address: 'Adres',
      city: 'İstanbul',
      district: 'Kadıköy',
      recordedBy: 'p',
      receivedById: 'p',
      receivedBy: 'Ciro Personeli',
      deliveredBy: 'Teslim Eden',
      relatedStaff: 'p',
      originalDocument: 'Alındı',
      receivables: [
        { id: 'pure-eur', docType: 'Senet', currency: 'EUR', amount: 100, preTrackingPayment: 0, due: today },
      ],
    };
    rules.sync(pure, today, () => null);
    const created = await call('/api/data/patch?key=icrapro-v1&scope=intake', {
      method: 'PUT',
      body: diff('icrapro-v1', { clients: [], docs: [] }, { clients: [], docs: [pure] }),
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const pureSaved = (await store.readState()).data['icrapro-v1'].docs.find((d) => d.id === 'd2');
    assert.equal(pureSaved.amount, 0);
    assert.equal(pureSaved.status || 'Derdest', 'Derdest');
    assert.equal(pureSaved.receivables[0].currency, 'EUR');
    const pureQuote = await get(
      '/api/documents/currency-quote?' +
        new URLSearchParams({ documentId: 'd2', currency: 'EUR', date: today }),
    );
    const paid = await call('/api/documents/currency-collection', {
      method: 'POST',
      auth: viewer,
      body: {
        documentId: 'd2',
        currency: 'EUR',
        amount: 5000,
        date: today,
        accountId: 'a',
        note: 'Personel tahsilatı',
        turnoverStaffId: 'p',
        requestId: 'pure-eur-staff-payment',
        revision: pureQuote.revision,
        quoteId: pureQuote.quote.id,
      },
    });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.record.status, 'İnfaz');
    assert.equal(paid.body.payment.amount, 500000);
    const adjusted = await call('/api/documents/principal', {
      method: 'POST',
      body: {
        documentId: 'd2',
        expectedPrincipal: 0,
        items: [{ id: 'pure-eur', expectedAmount: 10000, amount: 11000 }],
      },
    });
    assert.equal(adjusted.status, 200, JSON.stringify(adjusted.body));
    assert.equal(adjusted.body.record.status, 'Derdest');
    assert.equal(adjusted.body.record.unitPrincipals.EUR.principal, 11000);
    assert.equal(adjusted.body.record.unitPrincipalCostTLMinor, 500000);
    const adjustedFinance = await get('/api/documents/currency-finance?documentId=d2');
    assert.equal(adjustedFinance.groups[0].remaining, 1000);
  } finally {
    global.fetch = realFetch;
    await server?.close();
    await pg.close();
  }
});
