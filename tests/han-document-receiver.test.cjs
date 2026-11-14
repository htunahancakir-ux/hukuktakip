const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture, database, serve } = require('./support/postgres.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { createApplication } = require('../lib/application.cjs');
const { calculateMarketingBonus } = require('../outputs/icrapro/marketing-bonus.cjs');
const { calculateOtherPersonnelBonus } = require('../outputs/icrapro/other-personnel-bonus.cjs');
const { HAN_RECEIVER_ID, isHanReceiver } = require('../lib/document-receivers.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');
const today = '2026-11-13';
function sample() {
  const state = fixture();
  state.data['icrapro-personnel-v1'] = [
    { id: 'p', name: 'Personel', active: true, department: 'Pazarlama' },
    { id: 'other', name: 'HAN', active: true, department: 'Diğer' },
  ];
  state.data['icrapro-v1'].clients = [
    { id: 'c', name: 'Firma', createdAt: today + 'T08:00:00Z', documentStaff: 'p' },
  ];
  state.data['icrapro-v1'].docs = Array.from({ length: 9 }, (_, i) => ({
    id: 'normal-' + i,
    number: String(i + 1),
    client: 'c',
    debtor: 'Borçlu ' + i,
    docType: 'Senet',
    amount: 1000,
    due: today,
    trackingDate: today,
    status: 'Derdest',
    receivedById: 'p',
    receivedBy: 'Personel',
    financeTermsManual: true,
  }));
  return state;
}
test('HAN claims never enter document, parking, new-firm or receiver-based bonuses, including legacy name matches', () => {
  const state = sample();
  state.data['icrapro-v1'].docs.push(
    {
      id: 'han',
      client: 'c',
      docType: 'Yediemin Park Ücreti',
      receivedById: HAN_RECEIVER_ID,
      receivedBy: 'HAN',
      trackingDate: today,
      receivables: Array.from({ length: 10 }, (_, i) => ({
        id: 'han-' + i,
        docType: 'Senet',
        amount: 1000,
        registeredOn: today,
      })),
    },
    {
      id: 'legacy-han',
      client: 'c',
      status: 'İnfaz',
      closedDate: today,
      receivedBy: ' han ',
      trackingDate: today,
      amount: 1000,
    },
  );
  state.data['hanhukuk-finance-v1'] = [
    { id: 'large', documentId: 'han', type: 'payment', date: today, amount: 200000000 },
    { id: 'other', documentId: 'legacy-han', type: 'payment', date: today, amount: 100000 },
  ];
  const rows = calculateMarketingBonus(state, '2026-11', today),
    row = rows.find((r) => r.staffId === 'p');
  assert.equal(row.documentCount, 9);
  assert.equal(row.documentBonus, 90000);
  assert.equal(row.newFirms[0].documentCount, 9);
  assert.equal(row.newFirmBonus, 0);
  assert.equal(row.parkingCollected, 0);
  assert.equal(row.parkingBonus, 0);
  assert.equal(
    rows.some((r) => r.staffId === HAN_RECEIVER_ID),
    false,
  );
  assert.equal(
    calculateOtherPersonnelBonus(state, '2026-11', today)[0].total,
    0,
    'legacy HAN label cannot award a namesake real person',
  );
  assert(isHanReceiver({ receivedById: HAN_RECEIVER_ID }));
  assert(isHanReceiver({ receivedBy: 'han' }));
});

test('HAN intake persists without a personnel record; dated reports count each claim, paginate and export full totals', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(today + 'T10:00:00Z') });
  const { pg, pool } = await database();
  let server;
  try {
    const state = sample();
    state.users.push({
      ...state.users[0],
      id: 'staff',
      username: 'staff',
      role: 'staff',
      staffId: 'p',
      permissions: ['documents'],
    });
    delete state.data['icrapro-v1'].docs[0].receivedById;
    state.data['icrapro-v1'].docs.push({
      id: 'old-han',
      number: '10',
      client: 'c',
      debtor: 'Eski HAN',
      docType: 'Senet',
      amount: 100,
      receivedBy: 'HAN',
      trackingDate: '2026-10-01',
      status: 'Derdest',
    });
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store }));
    async function headers(id) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
        [crypto.createHash('sha256').update(token).digest('hex'), id, Date.now() + 600000],
      );
      return { cookie: 'han_session=' + token, 'X-Han-Request': '1', 'Content-Type': 'application/json' };
    }
    const staff = await headers('staff'),
      ceo = await headers(state.users[0].id);
    const doc = {
      id: 'new-han',
      client: 'c',
      debtor: 'HAN Borçlusu',
      docType: 'Diğer',
      receivedById: HAN_RECEIVER_ID,
      receivedBy: 'HAN',
      recordedBy: 'p',
      deliveredBy: 'Teslim Eden',
      originalDocument: 'Alındı',
      phone1: '05551234567',
      city: 'İstanbul',
      district: 'Kadıköy',
      address: 'Adres',
      receivables: Array.from({ length: 10 }, (_, i) => ({
        id: 'claim-' + i,
        docType: i % 2 ? 'Fatura' : 'Senet',
        amount: 100,
        due: today,
        preTrackingPayment: 0,
      })),
    };
    let r = await fetch(server.url + '/api/data/patch?key=icrapro-v1&operation=intake', {
      method: 'PUT',
      headers: staff,
      body: JSON.stringify(diff('icrapro-v1', { clients: [], docs: [] }, { clients: [], docs: [doc] })),
    });
    assert.equal(r.status, 200, await r.text());
    let current = await store.readState(),
      saved = current.data['icrapro-v1'].docs.find((d) => d.id === 'new-han');
    assert.equal(saved.receivedBy, 'HAN');
    assert.equal(saved.receivedById, HAN_RECEIVER_ID);
    assert.equal(current.data['icrapro-personnel-v1'].length, 2);
    const query = new URLSearchParams({
      type: 'hanDocuments',
      receiver: HAN_RECEIVER_ID,
      from: today,
      to: today,
      client: 'c',
      limit: '1',
      undated: 'false',
    });
    async function page(params = query) {
      const response = await fetch(server.url + '/api/records/reports?' + params, { headers: ceo });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    }
    const first = await page();
    const all = await page(new URLSearchParams({ ...Object.fromEntries(query), receiver: '', limit: '50' }));
    assert.equal(all.count, '19', 'Evrak Raporu includes both personnel and HAN claims');
    assert.equal(all.totals.count, '19');
    assert.equal(
      (await page(new URLSearchParams({ ...Object.fromEntries(query), receiver: 'p' }))).count,
      '9',
    );
    assert.equal(
      (await page(new URLSearchParams({ ...Object.fromEntries(query), documentType: 'Fatura' }))).count,
      '5',
    );
    assert.equal(
      (
        await page(
          new URLSearchParams({ ...Object.fromEntries(query), receiver: 'p', documentType: 'Fatura' }),
        )
      ).count,
      '0',
    );
    assert.equal(
      (await page(new URLSearchParams({ ...Object.fromEntries(query), receiver: "p' OR true--" }))).count,
      '0',
    );
    const filteredExport = await fetch(
      server.url +
        '/api/records/reports/export?' +
        new URLSearchParams({ ...Object.fromEntries(query), documentType: 'Fatura', format: 'csv' }),
      { headers: ceo },
    );
    assert.equal(filteredExport.status, 200);
    const filteredCsv = await filteredExport.text();
    assert.equal(filteredCsv.trim().split(/\r?\n/).length, 6);
    assert.doesNotMatch(filteredCsv, /Senet|Borçlu 0/);
    const otherReport = await fetch(server.url + '/api/records/reports?type=finance&receiver=p', {
      headers: ceo,
    });
    assert.equal(otherReport.status, 400);
    assert.equal(first.count, '10');
    assert.equal(first.totals.count, '10');
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].cells.receiver, 'HAN');
    assert(first.next);
    const next = await page(new URLSearchParams({ ...Object.fromEntries(query), after: first.next }));
    assert.equal(next.count, '10');
    assert.notEqual(next.items[0].id, first.items[0].id);
    assert.equal(
      (await page(new URLSearchParams({ ...Object.fromEntries(query), query: 'Fatura' }))).count,
      '5',
    );
    assert.equal(
      (
        await page(
          new URLSearchParams({
            type: 'hanDocuments',
            from: '2026-10-01',
            to: '2026-10-01',
            undated: 'false',
          }),
        )
      ).count,
      '1',
    );
    for (const format of ['csv', 'html']) {
      r = await fetch(
        server.url +
          '/api/records/reports/export?' +
          new URLSearchParams({ ...Object.fromEntries(query), format }),
        { headers: ceo },
      );
      assert.equal(r.status, 200);
      const output = await r.text();
      assert.match(output, /HAN/);
      assert.match(output, /HAN Borçlusu/);
      if (format === 'csv')
        assert.equal(
          output.trim().split(/\r?\n/).length,
          11,
          'export includes all ten claims, not just one visible page',
        );
      else {
        assert.match(output, /TOPLAM/);
        assert.match(output, /<th>10<\/th>/);
      }
    }
    const { marketingPayrollInputs } = require('../lib/record-store/marketing-payroll.cjs');
    current.marketingPayrollInputs = await marketingPayrollInputs(
      pool,
      current.data['icrapro-personnel-v1'],
      '2026-11',
      '2026-11',
      today,
    );
    const bonus = calculateMarketingBonus(current, '2026-11', today)[0];
    assert.equal(bonus.documentCount, 9);
    assert.equal(bonus.newFirmBonus, 0);
    const changed = { ...saved, receivedById: 'p', receivedBy: 'Personel' };
    r = await fetch(server.url + '/api/data/patch?key=icrapro-v1&operation=intake', {
      method: 'PUT',
      headers: ceo,
      body: JSON.stringify(
        diff('icrapro-v1', { clients: [], docs: [saved] }, { clients: [], docs: [changed] }),
      ),
    });
    assert.equal(r.status, 200, await r.text());
    assert.equal((await page()).count, '0', 'switching receiver removes the file from HAN reporting');
  } finally {
    await server?.close();
    await pg.close();
  }
});
