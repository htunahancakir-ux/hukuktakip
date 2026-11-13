const { test } = require('node:test');
const assert = require('node:assert/strict');
const units = require('../outputs/icrapro/receivable-units.js');
const claims = require('../outputs/icrapro/receivable-rules.js');
const rates = require('../lib/collection-rates.cjs');
const collection = require('../lib/currency-collection.cjs');
const { balance } = require('../lib/record-store/balances.cjs');
const row = (id, currency, amount, extras = {}) => ({
  id,
  docType: 'Senet',
  currency,
  amount,
  preTrackingPayment: 0,
  due: '2026-01-01',
  ...extras,
});
function document(items) {
  const doc = {
    id: 'd',
    client: 'c',
    debtor: 'Örnek',
    number: '1',
    status: 'Derdest',
    financeTermsManual: true,
    financeInterest: 0,
    financeFee: 0,
    receivables: items,
  };
  claims.sync(doc, '2026-11-12', () => null);
  return doc;
}
const stateFor = (doc) => ({
  data: {
    'icrapro-v1': { clients: [{ id: 'c', name: 'Müvekkil' }], docs: [doc] },
    'hanhukuk-finance-v1': [],
    'icrapro-personnel-v1': [{ id: 'p', name: 'Personel', active: true }],
    'hanhukuk-accounting-v1': { accounts: [{ id: 'a', name: 'Banka' }], entries: [] },
  },
});
const user = { id: 'u', role: 'ceo', name: 'Yönetici' };
function inputFor(state, currency, amount, sequence = '1') {
  return {
    documentId: 'd',
    currency,
    amount,
    date: '2026-11-12',
    accountId: 'a',
    note: 'Dekont',
    turnoverStaffId: 'p',
    requestId: 'currency-request-' + sequence,
    quoteId: 'official-quote',
    revision: collection.summary(state, state.data['icrapro-v1'].docs[0], '2026-11-12').revision,
  };
}
const quote = (currency, rateMicros = 50000000) => ({
  id: 'official-quote',
  currency,
  date: '2026-11-12',
  rateDate: '2026-11-12',
  rateMicros,
  source: 'TCMB Döviz Satış',
  sourceUrl: 'https://www.tcmb.gov.tr/kurlar/202611/12112026.xml',
  sourceHash: 'source-proof',
});

test('Mixed TL, EUR, USD and gram gold stay independent, with three decimal places for gold', () => {
  const doc = document([
    row('t', 'TRY', 1000),
    row('e', 'EUR', 500),
    row('u', 'USD', 200),
    row('g', 'XAU', 2.125),
  ]);
  assert.equal(doc.amount, 1000);
  assert.equal(doc.originalAmount, 1000);
  assert.equal(doc.unitPrincipals.EUR.principal, 50000);
  assert.equal(doc.unitPrincipals.XAU.principal, 2125);
  assert.deepEqual(
    units.foreignBalances(doc, '2026-11-12').map((g) => [g.currency, g.remaining]),
    [
      ['EUR', 50000],
      ['USD', 20000],
      ['XAU', 2125],
    ],
  );
  assert.equal(units.minor('0.001', 'XAU'), 1);
  assert.throws(() => units.minor('0.0001', 'XAU'), /3 ondalık/);
  assert.throws(() => units.minor('1.001', 'EUR'), /2 ondalık/);
  assert.throws(() => units.currency('BTC'), /birimi/);
  assert.equal(units.convertTL(250000, 50000000, 'EUR'), 5000);
  assert.equal(units.convertTL(637500, 3000000000, 'XAU'), 2125);
  assert.equal(units.interestFor(row('g', 'XAU', 10, { interestRate: 10 }), '2027-01-01'), 1000);
  assert.doesNotThrow(() => units.interestFor(row('e', 'EUR', 100, { interestRate: 0.29 }), '2026-02-01'));
});

test('TL collection reduces only selected debt, posts actual TL once and preserves historical rate', () => {
  const state = stateFor(document([row('t', 'TRY', 1000), row('e', 'EUR', 500), row('u', 'USD', 200)])),
    input = inputFor(state, 'EUR', 2500),
    rate = quote('EUR');
  const next = collection.append(state, input, user, rate, '2026-11-12'),
    doc = next.data['icrapro-v1'].docs[0],
    event = next.data['hanhukuk-finance-v1'][0];
  assert.equal(event.amount, 250000);
  assert.equal(event.unitAllocation.quantityMinor, 5000);
  assert.equal(event.unitAllocation.rateMicros, 50000000);
  assert.equal(event.unitAllocation.principalTLMinor, 250000);
  assert.equal(event.collectionStaffName, 'Personel');
  assert.equal(doc.status, 'Derdest');
  assert.deepEqual(
    units
      .foreignBalances(doc, '2026-11-12', next.data['hanhukuk-finance-v1'])
      .map((g) => [g.currency, g.remaining]),
    [
      ['EUR', 45000],
      ['USD', 20000],
    ],
  );
  assert.equal(
    balance(doc, next.data['hanhukuk-finance-v1'], '2026-11-12').remaining_cents,
    '100000',
    'TL debt is unchanged',
  );
  assert.equal(
    collection.append(next, input, user, null, '2026-11-12'),
    null,
    'a retry never adds another payment',
  );
  assert.throws(
    () => collection.append(next, { ...input, amount: 2501 }, user, null, '2026-11-12'),
    /farklı bilgiler/,
  );
  assert.throws(
    () => collection.append(next, { ...input, requestId: 'different-request-2' }, user, rate, '2026-11-12'),
    /hesabı değişti/,
  );
  assert.throws(
    () => collection.append(state, { ...input, quoteId: 'forged' }, user, rate, '2026-11-12'),
    /Günlük kur değişti/,
  );
  assert.throws(
    () => collection.append(state, { ...input, amount: 30000 }, user, rate, '2026-11-12'),
    /kalan alacağı aşamaz/,
  );
  assert.equal(state.data['hanhukuk-finance-v1'].length, 0, 'source snapshot is immutable');
});

test('Every currency must be settled before closure; native principal remains protected from manual closure', () => {
  const state = stateFor(document([row('e', 'EUR', 10), row('u', 'USD', 10)]));
  const first = collection.append(state, inputFor(state, 'EUR', 500), user, quote('EUR'), '2026-11-12');
  assert.equal(first.data['icrapro-v1'].docs[0].status, 'Derdest');
  assert.throws(
    () =>
      require('../lib/manual-closure.cjs').closeManually(
        first.data['icrapro-v1'].docs[0],
        first.data['hanhukuk-finance-v1'],
        user,
        '2026-11-12',
      ),
    /her birimde/,
  );
  const last = collection.append(first, inputFor(first, 'USD', 500, '2'), user, quote('USD'), '2026-11-12');
  assert.equal(last.data['icrapro-v1'].docs[0].status, 'İnfaz');
  const event = last.data['hanhukuk-finance-v1'][1];
  assert.equal(event.closes, true);
  assert.equal(event.principalAtCollection, 100000);
  assert.equal(event.revenuePart, 0);
});

test('Official TCMB selling price and BIST 24-karat gram price are validated by date and type', async () => {
  const xml =
    '<Tarih_Date Tarih="12.11.2026"><Currency CurrencyCode="EUR"><Unit>1</Unit><ForexBuying>49.9</ForexBuying><ForexSelling>50.2595</ForexSelling><BanknoteSelling>90</BanknoteSelling></Currency></Tarih_Date>';
  assert.equal(rates.parseTCMB(xml, '2026-11-12', 'EUR'), 50259500);
  assert.throws(() => rates.parseTCMB(xml, '2026-11-11', 'EUR'), /tarihi/);
  const gold = JSON.stringify({
    status: 'success',
    data: [
      {
        priceDate: '2026-11-12',
        priceRef: 'MTL',
        priceType: 'AU',
        priceCurrency: 'TRY',
        priceWeight: 'KG',
        priceValue: 6375000,
      },
      {
        priceDate: '2026-11-13',
        priceRef: 'MTL',
        priceType: 'AU',
        priceCurrency: 'TRY',
        priceWeight: 'KG',
        priceValue: 9999000,
      },
      {
        priceDate: '2026-11-12',
        priceRef: 'REF',
        priceType: 'AU',
        priceCurrency: 'TRY',
        priceWeight: 'KG',
        priceValue: 1,
      },
    ],
  });
  assert.deepEqual(rates.parseGold(gold, '2026-11-12'), { rateDate: '2026-11-12', rateMicros: 6375000000 });
  let requests = 0;
  const cacheStore = new Map();
  const options = {
    today: '2026-11-13',
    cacheStore,
    fetcher: async (url) => {
      requests++;
      if (url.includes('13112026')) return { status: 404 };
      return { status: 200, ok: true, headers: new Headers(), text: async () => xml };
    },
  };
  const q = await rates.quote('EUR', '2026-11-13', options);
  assert.equal(q.rateDate, '2026-11-12');
  assert.equal(q.rateMicros, 50259500);
  assert.equal(requests, 2);
  assert.equal((await rates.quote('EUR', '2026-11-13', options)).id, q.id);
  assert.equal(requests, 2);
  let failedCalls = 0;
  await assert.rejects(
    rates.quote('USD', '2026-11-13', {
      today: '2026-11-13',
      cacheStore: new Map(),
      fetcher: async () => {
        failedCalls++;
        return { status: 403, ok: false };
      },
    }),
    /yanıt vermiyor/,
  );
  assert.equal(failedCalls, 1, 'network/provider failures never substitute a guessed older price');
});

test('Native principal edits preserve milligrams, historical rates and paid client entitlement', () => {
  const principal = require('../lib/document-principal.cjs');
  const state = stateFor(document([row('g', 'XAU', 2.125)]));
  const paid = collection.append(
    state,
    inputFor(state, 'XAU', 6375),
    user,
    quote('XAU', 3000000000),
    '2026-11-12',
  );
  const input = {
    documentId: 'd',
    expectedPrincipal: 0,
    items: [{ id: 'g', expectedAmount: 2125, amount: 2126 }],
  };
  const adjusted = principal.adjustDocumentPrincipal(paid, input, user, '2026-11-12');
  assert.equal(adjusted.record.receivables[0].amount, 2.126);
  assert.equal(adjusted.record.receivables[0].currency, 'XAU');
  assert.equal(adjusted.record.status, 'Derdest');
  assert.equal(adjusted.record.principalAdjustment.afterUnits.XAU.principal, 2126);
  const down = principal.adjustDocumentPrincipal(
    paid,
    { ...input, items: [{ id: 'g', expectedAmount: 2125, amount: 2000 }] },
    user,
    '2026-11-12',
  );
  collection.synchronize(down.next, '2026-11-12', paid);
  assert.equal(down.record.unitPrincipalCostTLMinor, 600000);
  assert.equal(
    down.next.data['hanhukuk-finance-v1'][0].unitAllocation.principalTLMinor,
    637500,
    'historical snapshot remains unchanged',
  );
  paid.data['hanhukuk-accounting-v1'].entries.push({
    id: 'payout',
    type: 'clientPayout',
    documentId: 'd',
    amount: 620000,
  });
  assert.throws(
    () =>
      principal.adjustDocumentPrincipal(
        paid,
        { ...input, items: [{ id: 'g', expectedAmount: 2125, amount: 2000 }] },
        user,
        '2026-11-12',
      ),
    /daha önce ödenen/,
  );
});

test('Converted collections count toward TL office turnover without inflating mixed-file parking bonuses', () => {
  const state = stateFor(document([row('e', 'EUR', 100), row('g', 'XAU', 1)]));
  const doc = state.data['icrapro-v1'].docs[0];
  doc.receivedById = 'p';
  doc.trackingDate = '2026-11-01';
  doc.receivables.push({
    id: 'parking',
    docType: 'Yediemin Park Ücreti',
    amount: 1000,
    registeredOn: '2026-11-01',
  });
  state.data['icrapro-personnel-v1'][0].department = 'Pazarlama';
  state.data['hanhukuk-finance-v1'] = [
    { id: 'tl', documentId: 'd', type: 'payment', date: '2026-11-12', amount: 100000 },
    {
      id: 'eur',
      documentId: 'd',
      type: 'payment',
      date: '2026-11-12',
      amount: 500000,
      unitAllocation: { currency: 'EUR', quantityMinor: 10000 },
    },
  ];
  const bonus = require('../outputs/icrapro/marketing-bonus.cjs').calculateMarketingBonus(
    state,
    '2026-11',
  )[0];
  assert.equal(bonus.officeCollected, 600000);
  assert.equal(bonus.parkingCollected, 100000);
  assert.equal(bonus.documentCount, 3, 'native claims still count as documents');
});
