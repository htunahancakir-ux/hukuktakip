const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const legal = require('../outputs/icrapro/legal-charges.cjs');
const { balance } = require('../lib/record-store/balances.cjs');
const { fixture, database, serve } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createApplication } = require('../lib/application.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');

const today = '2026-11-13';
const parking = () => ({
  id: 'park',
  number: '1',
  client: 'c',
  debtor: 'Örnek',
  docType: 'Yediemin Park Ücreti',
  status: 'Derdest',
  amount: 500,
  parkingEntry: '2026-11-10',
  vehicleKind: 'Otomobil',
  vehiclePlate: '34 TEST 001',
  parkingCommissionRate: 20,
});

test('Legacy and claim-based parking files calculate from entry date and include both charges in the debt', () => {
  for (const shared of [false, true]) {
    const doc = parking();
    if (shared) doc.receivables = [{ ...doc, id: 'claim', preTrackingPayment: 0 }];
    assert.equal(legal.applyAutomaticLegalCharges(doc, [], today), true);
    assert.equal(doc.amount, 500, 'four inclusive parking days at 125 TL');
    assert.equal(doc.financeInterest, 1.27, 'three days of interest from entry, excluding calculation day');
    assert.equal(doc.financeFee, 500, 'the tariff minimum is capped by principal');
    assert.equal(doc.legalCalculation.start, '2026-11-10');
    assert.equal(balance(doc, [], today).target_cents, '100127');
    assert.equal(
      legal.applyAutomaticLegalCharges(doc, [], today),
      false,
      'unchanged calculations keep their timestamp',
    );
  }
});

test('Missing parking charges are recovered on paid open files; manual, imported and closed amounts stay frozen', () => {
  const doc = parking(),
    events = [{ id: 'partial', documentId: 'park', type: 'payment', date: '2026-11-11', amount: 1000 }];
  assert.equal(legal.applyAutomaticLegalCharges(doc, events, today), true);
  assert.equal(balance(doc, events, today).remaining_cents, '99127');
  assert.equal(legal.applyAutomaticLegalCharges(doc, events, '2026-11-14'), false);
  assert.equal(doc.financeInterest, 1.27);
  for (const extra of [
    { financeTermsManual: true },
    { status: 'İnfaz' },
    { status: 'İade' },
    { repaymentPlan: {} },
  ]) {
    const fixed = { ...parking(), financeInterest: 7, financeFee: 8, ...extra };
    assert.equal(legal.applyAutomaticLegalCharges(fixed, events, today), false);
    assert.equal(fixed.financeInterest, 7);
    assert.equal(fixed.financeFee, 8);
  }
});

test('Parking finance form shows calculated charges, permits manager edits and keeps actual-collection settlement', () => {
  const dom = new JSDOM('<dialog id="modal"></dialog>', {
    url: 'http://localhost',
    runScripts: 'dangerously',
  });
  try {
    const w = dom.window,
      doc = parking(),
      saved = [];
    for (const file of ['receivable-units.js', 'receivable-rules.js', 'parking-fees.js'])
      w.eval(fs.readFileSync('outputs/icrapro/' + file, 'utf8'));
    Object.assign(w, {
      $: (q) => w.document.querySelector(q),
      esc: String,
      money: String,
      financeCents: (v) => Math.round(Number(v || 0) * 100),
      hanAuth: { role: 'admin' },
      db: { docs: [doc], clients: [] },
      financeEvents: [],
      accounting: { accounts: [], entries: [] },
      structuredClone,
      toast() {},
      displayDate: String,
    });
    const constants = fs
      .readFileSync('outputs/icrapro/legal-charges.cjs', 'utf8')
      .split('function legalDate')[0];
    w.eval(constants + fs.readFileSync('outputs/icrapro/finance-operations.js', 'utf8'));
    w.businessDate = () => today;
    Object.assign(w, {
      saveDocumentFinance: (record) => saved.push(structuredClone(record)),
      field: (label, name, type, value, required) =>
        '<label>' +
        label +
        '<input name="' +
        name +
        '" type="' +
        type +
        '" value="' +
        (value ?? '') +
        '" ' +
        (required ? 'required' : '') +
        '></label>',
      staffSelect: (label, name) =>
        '<label>' +
        label +
        '<select name="' +
        name +
        '"><option value="p">Personel</option></select></label>',
      collectionAccountField: () =>
        '<label><select name="accountId"><option value="a">Banka</option></select></label>',
      setupFinanceOperationTabs() {},
      bindFinanceHistory() {},
      financeHistoryMarkup: () => '',
      authApi: () => ({ balance: 0 }),
    });
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    assert.equal(w.docFinance(doc).target, 100127);
    w.financialOperations('park');
    const form = w.document.querySelector('#financeTerms');
    assert.equal(form.elements.interest.value, '1.27');
    assert.equal(form.elements.fee.value, '500');
    assert.equal(form.elements.interest.disabled, false);
    assert.equal(form.elements.fee.disabled, false);
    form.elements.interest.value = '2.5';
    form.elements.fee.value = '75';
    form.onsubmit({ preventDefault() {} });
    assert.equal(saved.at(-1).financeInterest, 2.5);
    assert.equal(saved.at(-1).financeFee, 75);
    assert.equal(doc.financeTermsManual, true);
    assert.equal(w.docFinance(doc).target, 57750);
    w.financeEvents.push({ id: 'paid', documentId: 'park', type: 'payment', amount: 57750 });
    doc.status = 'İnfaz';
    assert.equal(w.clientPayoutTotals(doc).entitlement, 46200, 'client receives 80% of actual collections');
  } finally {
    dom.window.close();
  }
});

test('Record APIs agree with the calculated debt; principal-only receipt stays partial and manager manual closure waives charges', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(today + 'T10:00:00Z') });
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    state.users.push(
      { ...state.users[0], id: 'manager', username: 'manager', role: 'admin' },
      { ...state.users[0], id: 'staff', username: 'staff', role: 'staff', permissions: ['documents'] },
    );
    state.data['icrapro-v1'] = {
      clients: [{ id: 'c', name: 'Müvekkil' }],
      docs: [{ ...parking(), parkingEntry: '2026-01-01', amount: 1000 }],
    };
    state.data['hanhukuk-accounting-v1'] = { accounts: [{ id: 'a', name: 'Kasa' }], entries: [] };
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store }));
    async function headers(user) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
        [crypto.createHash('sha256').update(token).digest('hex'), user, Date.now() + 600000],
      );
      return { cookie: 'han_session=' + token, 'X-Han-Request': '1', 'Content-Type': 'application/json' };
    }
    const manager = await headers('manager'),
      staff = await headers('staff');
    const page = await fetch(server.url + '/api/records/documents?q=Örnek', { headers: manager }).then((r) =>
      r.json(),
    );
    const doc = structuredClone(state.data['icrapro-v1'].docs[0]);
    require('../outputs/icrapro/parking-fees.js').applyParkingFee(doc, today);
    legal.applyAutomaticLegalCharges(doc, [], today);
    assert.equal(
      page.items[0].targetCents,
      String(Math.round((doc.amount + doc.financeInterest + doc.financeFee) * 100)),
    );
    const principal = Math.round(doc.amount * 100);
    const payment = {
      id: 'principal-only',
      documentId: 'park',
      type: 'payment',
      date: today,
      amount: principal,
      accountId: 'a',
      turnoverStaffId: 'turnover:bonus',
      note: 'Anapara tahsilatı',
      closes: false,
    };
    let r = await fetch(server.url + '/api/data/patch?key=hanhukuk-finance-v1', {
      method: 'PUT',
      headers: manager,
      body: JSON.stringify(diff('hanhukuk-finance-v1', [], [payment])),
    });
    assert.equal(r.status, 200, await r.text());
    let current = (await store.readState()).data['icrapro-v1'].docs[0];
    assert.notEqual(current.status, 'İnfaz');
    assert(current.financeInterest > 0);
    assert(current.financeFee > 0);
    const input = { documentId: 'park', expectedPrincipal: principal, expectedReceived: principal };
    r = await fetch(server.url + '/api/documents/manual-close', {
      method: 'POST',
      headers: staff,
      body: JSON.stringify(input),
    });
    assert.equal(r.status, 403);
    r = await fetch(server.url + '/api/documents/manual-close', {
      method: 'POST',
      headers: manager,
      body: JSON.stringify(input),
    });
    assert.equal(r.status, 200, await r.text());
    current = (await store.readState()).data['icrapro-v1'].docs[0];
    assert.equal(current.status, 'İnfaz');
    assert.equal(current.debtDiscountCents, Math.round((doc.financeInterest + doc.financeFee) * 100));
    assert.equal(
      balance(current, (await store.readState()).data['hanhukuk-finance-v1'], today).remaining_cents,
      '0',
    );
    assert.equal(
      (await store.readState()).data['hanhukuk-finance-v1'].length,
      1,
      'waiver creates no additional cash',
    );
  } finally {
    await server?.close();
    await pg.close();
  }
});

test('Existing automatic mixed-file charges are refreshed once to include parking, including paid files', () => {
  const doc = {
    ...parking(),
    docType: 'Diğer',
    financeInterest: 10,
    financeFee: 100,
    legalCalculation: { automatic: true },
    receivables: [
      { id: 'note', docType: 'Senet', amount: 1000, preTrackingPayment: 0, due: '2026-11-01' },
      { ...parking(), id: 'claim', preTrackingPayment: 0 },
    ],
  };
  const events = [{ id: 'partial', documentId: 'park', type: 'payment', date: '2026-11-11', amount: 1000 }];
  assert.equal(legal.applyAutomaticLegalCharges(doc, events, today), true);
  assert.equal(doc.legalCalculation.parkingIncluded, true);
  assert.equal(doc.legalCalculation.interest.receivables.length, 2);
  const amount = doc.financeInterest;
  assert.equal(legal.applyAutomaticLegalCharges(doc, events, '2026-11-14'), false);
  assert.equal(doc.financeInterest, amount);
});
