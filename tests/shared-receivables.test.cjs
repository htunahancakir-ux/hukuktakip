const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const rules = require('../outputs/icrapro/receivable-rules.js');
const legal = require('../outputs/icrapro/legal-charges.cjs');
const parking = require('../outputs/icrapro/parking-fees.js');
const { balance } = require('../lib/record-store/balances.cjs');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');
const items = () => [
  { id: 'senet', docType: 'Senet', amount: 1000, preTrackingPayment: 100, due: '2026-11-01', serial: 'S1' },
  { id: 'cek', docType: 'Çek', amount: 2000, due: '2026-11-05', serial: 'C1', bank: 'Banka', branch: 'Şube' },
];

test('Claim edits cannot bypass closed-file and paid-file protections through generic saves', () => {
  const { prepareState } = require('../lib/state-invariants.cjs');
  const state = fixture();
  state.data['icrapro-v1'].docs = [
    { id: 'case', docType: 'Diğer', status: 'Derdest', receivables: rules.normalize(items()), amount: 2900 },
  ];
  state.data['hanhukuk-finance-v1'] = [{ id: 'payment', documentId: 'case', type: 'payment', amount: 100 }];
  let next = structuredClone(state);
  next.data['icrapro-v1'].docs[0].receivables[0].amount += 10;
  assert.throws(() => prepareState(state, next, { role: 'staff' }, { skipPayroll: true }), /yalnızca CEO/);
  state.data['icrapro-v1'].docs[0].status = 'İnfaz';
  next = structuredClone(state);
  next.data['icrapro-v1'].docs[0].receivables.push({
    id: 'new',
    docType: 'Fatura',
    amount: 100,
    due: '2026-11-01',
  });
  assert.throws(() => prepareState(state, next, { role: 'ceo' }, { skipPayroll: true }), /Kapanmış/);
  next = structuredClone(state);
  delete next.data['icrapro-v1'].docs[0].receivables;
  assert.throws(() => prepareState(state, next, { role: 'ceo' }, { skipPayroll: true }), /korunmalıdır/);
});

test('One file combines principals and calculates interest separately by each due date', () => {
  const doc = { id: 'case', docType: 'Diğer', status: 'Derdest', receivables: items() };
  legal.applyAutomaticLegalCharges(doc, [], '2026-11-11');
  const expected =
    legal.calculateLegalInterest(90000, '2026-11-01', '2026-11-11').amount +
    legal.calculateLegalInterest(200000, '2026-11-05', '2026-11-11').amount;
  assert.equal(doc.amount, 2900);
  assert.equal(Math.round(doc.financeInterest * 100), expected);
  assert.equal(doc.legalCalculation.interest.receivables.length, 2);
  const result = balance(doc, [{ documentId: 'case', type: 'payment', amount: 50000 }], '2026-11-11');
  assert.equal(BigInt(result.target_cents) - BigInt(result.remaining_cents), 50000n);
  assert.throws(() => rules.normalize([items()[0], items()[0]]), /farklı/);
  assert.throws(() => rules.normalize([{ ...items()[0], amount: -1 }]), /pozitif/);
});

test('A mixed parking claim keeps daily pricing, excludes parking interest and retains office share', () => {
  const doc = {
    id: 'case',
    docType: 'Diğer',
    status: 'Derdest',
    receivables: [
      items()[0],
      {
        id: 'park',
        vehiclePlate: '34 TEST 001',
        docType: 'Yediemin Park Ücreti',
        amount: 125,
        parkingEntry: '2026-11-10',
        vehicleKind: 'Otomobil',
        parkingCommissionRate: 20,
      },
    ],
  };
  legal.applyAutomaticLegalCharges(doc, [], '2026-11-11');
  assert.equal(doc.amount, 1150);
  assert.equal(doc.mixedParkingCommissionCents, 5000);
  assert.equal(doc.legalCalculation.interest.receivables.length, 1);
  const total = Math.round((doc.amount + doc.financeInterest + doc.financeFee) * 100);
  doc.status = 'İnfaz';
  const event = {
    id: 'close',
    documentId: 'case',
    type: 'payment',
    amount: total,
    closes: true,
    principalAtCollection: 115000,
  };
  assert.equal(
    require('../outputs/icrapro/profit-rules.js').recognizedCollectionRevenue(event, [event], doc),
    total - 115000 + 5000,
  );
  const frozen = doc.amount;
  legal.applyAutomaticLegalCharges(doc, [event], '2026-11-12');
  assert.equal(doc.amount, frozen);
});

test('The intake editor keeps one borrower with multiple separately typed rows', () => {
  const dom = new JSDOM(
    '<form id="intakeForm"><div class="formbody"><label><input name="amount"></label><label><input name="due"></label><label><input name="serial"></label><label><input name="issued"></label><label><input name="preTrackingPayment"></label><div class="document-types"><button type="button" data-doc-type="Senet">Senet Ekle</button><button type="button" data-doc-type="Çek">Çek Ekle</button></div><select name="docType"><option>Senet</option></select><div id="typeFields"></div><section data-form-panel="debtor"><div class="grid"><input name="debtor" value="Borçlu"></div></section></div><div class="formbody"><input id="intakeAddAnother"></div></form>',
    { url: 'http://localhost', runScripts: 'dangerously' },
  );
  const w = dom.window;
  try {
    Object.assign(w, {
      esc: (v) => String(v ?? ''),
      money: (v) => String(v),
      businessDate: () => '2026-11-11',
      toast: () => {},
    });
    for (const file of [
      'form-inputs.js',
      'parking-fees.js',
      'receivable-units.js',
      'receivable-rules.js',
      'document-types.js',
      'workspace-receivables.js',
    ]) {
      const script = w.document.createElement('script');
      script.textContent = fs.readFileSync('outputs/icrapro/' + file, 'utf8');
      w.document.body.append(script);
    }
    const form = w.document.querySelector('form');
    form.elements.docType.onchange = () => {};
    w.setupReceivables(form, null);
    const ledger = form.querySelector('.receivable-table-scroll');
    const menuEvent = new w.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
    });
    ledger.dispatchEvent(menuEvent);
    assert.equal(menuEvent.defaultPrevented, true);
    const menu = w.document.querySelector('[role="menu"]');
    assert(menu);
    assert.equal(menu.querySelectorAll('[role="menuitem"]').length, 8);
    [...menu.querySelectorAll('button')].find((button) => button.textContent === 'Senet').click();
    assert.equal(w.document.querySelector('[role="menu"]'), null);
    assert.equal(form.querySelector('[data-claim-field="due"]').required, true);
    form.querySelector('[data-doc-type="Çek"]').click();
    const rows = form.querySelectorAll('[data-receivable-rows]>section');
    rows.forEach((row, i) => {
      row.querySelector('[data-claim-field="amount"]').value = String((i + 1) * 1000);
      row.querySelector('[data-claim-field="due"]').value = i ? '2026-11-05' : '2026-11-01';
      row.querySelector('[data-claim-field="serial"]').value = 'N' + i;
      row.querySelector('[data-claim-field="amount"]').dispatchEvent(new w.Event('input', { bubbles: true }));
    });
    assert.equal(form.querySelectorAll('[data-select-claim]').length, 2);
    assert.equal(form.querySelector('[data-receivable-gross]').textContent, '3.000,00');
    assert.equal(rows[0].hidden, true);
    assert.equal(rows[1].hidden, false);
    form.querySelector('[data-select-claim] button').click();
    assert.equal(rows[0].hidden, false);
    assert.equal(rows[1].hidden, true);
    rows[0].querySelector('[data-claim-field="preTrackingPayment"]').value = '100';
    rows[0]
      .querySelector('[data-claim-field="preTrackingPayment"]')
      .dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.match(form.querySelector('[data-receivable-total]').textContent, /2\.900,00 TL/);
    form
      .querySelector('[data-select-claim] button')
      .dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(rows[1].hidden, false);
    const firstDue = rows[0].querySelector('[data-claim-field="due"]');
    firstDue.value = '';
    assert.equal(form._prepareRequiredValidation(), true);
    assert.equal(rows[0].hidden, false, 'required validation reveals the incomplete document');
    firstDue.value = '2026-11-01';
    const saved = form.readReceivables();
    assert.equal(saved.length, 2);
    assert.deepEqual(
      Array.from(saved, (r) => r.docType),
      ['Senet', 'Çek'],
    );
    assert.equal(form.querySelectorAll('[name="debtor"]').length, 1);
    rows[1].querySelector('[data-remove-claim]').click();
    assert.equal(form.readReceivables().length, 1);
    assert.equal(rows[0].hidden, false, 'removing the active document keeps another editor visible');
  } finally {
    dom.window.close();
  }
});

test('Intake persists mixed documents as one file with optional enforcement fields and one shared payment', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    state.data['icrapro-v1'].clients = [{ id: 'client', name: 'Client' }];
    state.data['icrapro-v1'].docs = [
      {
        id: 'legacy',
        number: 'S-0042',
        client: 'client',
        debtor: 'Eski Borçlu',
        docType: 'Senet',
        amount: 900,
        originalAmount: 1000,
        preTrackingPayment: 100,
        due: '2026-11-01',
      },
    ];
    state.data['hanhukuk-accounting-v1'].accounts = [{ id: 'cash', name: 'Kasa' }];
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store }));
    const login = await fetch(server.url + '/api/login', {
      method: 'POST',
      headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test', password }),
    });
    const headers = {
      cookie: login.headers.get('set-cookie').split(';')[0],
      'X-Han-Request': '1',
      'Content-Type': 'application/json',
    };
    const record = {
      id: 'case',
      client: 'client',
      debtor: 'Bir Borçlu',
      docType: 'Diğer',
      amount: 2900,
      originalAmount: 3000,
      preTrackingPayment: 100,
      receivables: rules.normalize(items()),
      enforcementOffice: 'İstanbul İcra',
      enforcementFileNumber: '2026/123',
    };
    const response = await fetch(server.url + '/api/data/patch?key=icrapro-v1&operation=intake', {
      method: 'PUT',
      headers,
      body: JSON.stringify(diff('icrapro-v1', { clients: [], docs: [] }, { clients: [], docs: [record] })),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    let doc = body.records[0].value;
    const number = doc.number;
    assert.equal(doc.receivables.length, 2);
    assert.equal(doc.enforcementFileNumber, '2026/123');
    assert.equal(doc.status, 'İcra');
    const append = {
      ...doc,
      receivables: [...doc.receivables, { id: 'invoice', docType: 'Fatura', amount: 500, due: '2026-11-07' }],
    };
    rules.sync(append, '2026-11-11', parking.parkingFeeInfo);
    append.mixedParkingCommissionCents = doc.mixedParkingCommissionCents;
    const appended = await fetch(server.url + '/api/data/patch?key=icrapro-v1&operation=intake', {
      method: 'PUT',
      headers,
      body: JSON.stringify(diff('icrapro-v1', { clients: [], docs: [doc] }, { clients: [], docs: [append] })),
    });
    const appendedBody = await appended.json();
    assert.equal(appended.status, 200, JSON.stringify(appendedBody));
    doc = appendedBody.records[0].value;
    assert.equal(doc.number, number);
    assert.equal(doc.amount, 3400);
    assert.equal(doc.receivables.length, 3);
    const legacy = (await store.readState()).data['icrapro-v1'].docs.find((d) => d.id === 'legacy');
    const converted = {
      ...legacy,
      docType: 'Diğer',
      receivables: [
        { ...legacy, id: 'old-item', amount: 1000 },
        { id: 'statement', docType: 'Cari Ekstre', amount: 200, due: '2026-11-05' },
      ],
    };
    rules.sync(converted, '2026-11-11', parking.parkingFeeInfo);
    delete converted.mixedParkingCommissionCents;
    const conversion = await fetch(server.url + '/api/data/patch?key=icrapro-v1&operation=intake', {
      method: 'PUT',
      headers,
      body: JSON.stringify(
        diff('icrapro-v1', { clients: [], docs: [legacy] }, { clients: [], docs: [converted] }),
      ),
    });
    const conversionBody = await conversion.json();
    assert.equal(conversion.status, 200, JSON.stringify(conversionBody));
    assert.equal(conversionBody.records[0].value.number, 'S-0042');
    assert.equal(conversionBody.records[0].value.amount, 1100);
    assert.equal(conversionBody.records[0].value.receivables.length, 2);
    const event = {
      id: 'pay',
      documentId: 'case',
      type: 'payment',
      turnoverStaffId: 'turnover:bonus',
      amount: 10000,
      date: require('../lib/business-time.cjs').businessDate(),
      accountId: 'cash',
    };
    const paid = await fetch(server.url + '/api/data/patch?key=hanhukuk-finance-v1', {
      method: 'PUT',
      headers,
      body: JSON.stringify(diff('hanhukuk-finance-v1', [], [event])),
    });
    assert.equal(paid.status, 200, await paid.text());
    const current = await store.readState();
    assert.equal(current.data['icrapro-v1'].docs.length, 2);
    assert.equal(current.data['hanhukuk-finance-v1'][0].documentId, 'case');
    const page = await (
      await fetch(server.url + '/api/records/documents?type=' + encodeURIComponent('Çek'), { headers })
    ).json();
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].kind, 'Alacak Föyü');
    assert.equal(Number(page.items[0].targetCents) - Number(page.items[0].remainingCents), 10000);
  } finally {
    await server?.close();
    await pg.close();
  }
});
