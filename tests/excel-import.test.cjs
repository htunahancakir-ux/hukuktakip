const { test } = require('node:test');
const assert = require('node:assert/strict');
const { excel } = require('./support/excel.cjs');
const workbook = require('../lib/excel-workbook.cjs');
const fields = require('../lib/excel-import-fields.cjs');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');

test('XLSX parser, templates, numeric precision and hostile workbook limits', async () => {
  const template = await workbook.makeTemplate(fields.fields('documents').map((f) => f.label));
  const parsed = await workbook.readWorkbook({
    fileName: 'template.xlsx',
    fileBase64: template.toString('base64'),
  });
  assert.equal(parsed[0].rows[0].cells.A, 'Borçlu Adı');
  assert.equal(Object.keys(parsed[0].rows[0].cells).length, fields.fields('documents').length);
  const numeric = await workbook.readWorkbook(await excel([{ rows: [['Tutar'], [1.125], ['1.125']] }]));
  assert.equal(fields.amount(numeric[0].rows[1].cells.A, 'Tutar'), 1.125);
  assert.equal(fields.amount(numeric[0].rows[2].cells.A, 'Tutar'), 1125);
  for (const extra of [
    { 'xl/vbaProject.bin': 'macro' },
    { 'xl/workbook.xml': '<!DOCTYPE workbook [<!ENTITY x SYSTEM "file:///sensitive">]><workbook/>' },
    { 'xl/worksheets/sheet0.xml': '<worksheet><row r="2"><c r="A3"><v>1</v></c></row></worksheet>' },
    { 'xl/worksheets/sheet0.xml': '<worksheet><row r="2"/><row r="2"/></worksheet>' },
    {
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="r0" Target="../secret.xml"/></Relationships>',
    },
  ])
    await assert.rejects(
      workbook.readWorkbook(await excel([{ rows: [['Ad'], ['Test']] }], extra)),
      (error) => error.status === 400,
    );
  await assert.rejects(workbook.readWorkbook({ fileName: 'old.xls', fileBase64: 'AA==' }));
  await assert.rejects(
    workbook.readWorkbook(await excel([{ rows: Array.from({ length: 551 }, () => ['test']) }])),
  );
});

test('Authenticated Excel import previews, selects and atomically stores clients and grouped historical documents', async () => {
  const { pg, pool: rootPool } = await database();
  const { createTenantPool, LEGACY_TENANT_ID } = require('../lib/saas/tenant-pool.cjs');
  const pool = createTenantPool(rootPool, LEGACY_TENANT_ID);
  let server;
  try {
    const state = fixture();
    state.data['icrapro-v1'].clients = [
      {
        id: 'existing',
        name: 'Mevcut Müvekkil',
        identity: '1111111111',
        clientCode: 'LIVE-CODE',
        sourceImport: { clientCode: 'OLD-CODE' },
      },
    ];
    state.data['icrapro-personnel-v1'] = [{ id: 'source-staff', name: 'Kaynak Personel', active: true }];
    state.data['hanhukuk-accounting-v1'].accounts = [{ id: 'bank', name: 'Banka', openingBalance: 50000 }];
    state.users.push(
      ...['allowed', 'denied', 'readonly'].map((username) => ({
        ...state.users[0],
        id: username,
        username,
        role: 'staff',
        readOnly: username === 'readonly',
        permissions: username === 'denied' ? [] : ['clients', 'documents'],
      })),
    );
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store }));
    const login = async (username) => {
      const response = await fetch(server.url + '/api/login', {
        method: 'POST',
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return {
        'X-Han-Request': '1',
        'Content-Type': 'application/json',
        cookie: response.headers.get('set-cookie').split(';')[0],
      };
    };
    const headers = await login('test'),
      denied = await login('denied'),
      readonly = await login('readonly');
    const request = async (path, body, auth = headers) => {
      const response = await fetch(server.url + '/api/excel-import/' + path, {
        method: body ? 'POST' : 'GET',
        headers: auth,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json();
      return { status: response.status, data };
    };
    assert.equal((await request('options?kind=clients', null, {})).status, 401);
    assert.equal((await request('options?kind=clients', null, denied)).status, 403);
    assert.equal((await request('options?kind=documents', null, denied)).status, 403);
    const options = await request('options?kind=clients');
    assert.equal(options.status, 200);
    assert(options.data.categories.includes('Diğer'));
    const templateResponse = await fetch(server.url + '/api/excel-import/template?kind=clients', { headers });
    assert.equal(templateResponse.status, 200);
    assert(templateResponse.headers.get('content-type').includes('spreadsheetml'));
    const downloadedTemplate = Buffer.from(await templateResponse.arrayBuffer());
    assert.deepEqual(
      downloadedTemplate,
      require('node:fs').readFileSync('lib/templates/muvekkil-aktarim.xlsx'),
    );
    assert.equal(
      (
        await workbook.readWorkbook({
          fileName: 'template.xlsx',
          fileBase64: downloadedTemplate.toString('base64'),
        })
      )[0].rows[0].cells.A,
      'Müvekkil Adı',
    );
    const file = await excel([
      {
        name: 'Kimlik',
        rows: [
          ['Alacaklı Kodu', 'Alacaklı İsmi', 'Gerçek / Tüzel', 'Müvekkil Vergi No'],
          ['000-K1', 'Örnek Firma', 'Tüzel', '2222222222'],
          ['K2', 'Mevcut Müvekkil', 'Gerçek', '1111111111'],
          ['K3', 'Bozuk Kimlik', 'Tüzel', '12'],
        ],
      },
      {
        name: 'İletişim',
        rows: [
          ['Kod', 'İsim / Ünvan', 'Telefon 1', 'Telefon 2', 'Adres', 'İl', 'İlçe'],
          ['000-K1', 'Örnek Firma', '05320000001', '12345678901', 'Örnek Adres', 'Karabük', 'Merkez'],
        ],
      },
    ]);
    const input = { kind: 'clients', ...file };
    let preview = await request('preview', input);
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.deepEqual(preview.data.totals, { ready: 1, duplicate: 1, error: 1 });
    assert.equal((await store.readState()).data['icrapro-v1'].clients.length, 1, 'preview must not write');
    const allKeys = preview.data.items.map((r) => r.key);
    assert.equal((await request('commit', { ...input, keys: allKeys })).status, 400);
    assert.equal(
      (await store.readState()).data['icrapro-v1'].clients.length,
      1,
      'invalid selection rolls back everything',
    );
    const keys = preview.data.items.filter((r) => r.state === 'ready').map((r) => r.key);
    assert.equal((await request('commit', { ...input, keys }, readonly)).status, 403);
    const committed = await request('commit', { ...input, keys });
    assert.equal(committed.status, 200, JSON.stringify(committed.data));
    assert.equal(committed.data.imported, 1);
    const afterClient = (await store.readState()).data['icrapro-v1'].clients;
    const client = afterClient.find((c) => c.name === 'Örnek Firma');
    assert(client);
    assert.equal(client.clientCode, '000-K1');
    const reopenedClient = await fetch(server.url + '/api/records/client?id=' + client.id, { headers });
    assert.equal(reopenedClient.status, 200);
    assert.equal((await reopenedClient.json()).record.clientCode, '000-K1');
    assert.equal(client.type, 'Şirket');
    assert.equal(client.additionalPhones[0], '12345678901');
    assert.equal(client.address, 'Örnek Adres');
    assert.equal(client.sourceImport.sheets.length, 2);
    assert.equal((await request('commit', { ...input, keys })).data.imported, 0, 'retry is idempotent');
    const conflict = await request('preview', {
      kind: 'clients',
      ...(await excel([
        {
          rows: [
            ['Müvekkil Adı', 'TC / Vergi No'],
            ['Mevcut Müvekkil', '9999999999'],
          ],
        },
      ])),
    });
    assert.equal(conflict.data.totals.error, 1);
    const docs = {
      kind: 'documents',
      ...(await excel([
        {
          rows: [
            [
              'Föy No',
              'Borçlu Adı',
              'Müvekkil Adı',
              'TC / Vergi No',
              'Evrak Türü',
              'Evrak Tutarı',
              'Vade Tarihi',
              'Kayıt Tarihi',
              'Sorumlu',
              'Tahsilat Tutarı',
              'Tahsilat Tarihi',
              'Hesap',
              'Evrakı Alan Personel',
            ],
            [
              'ESKI-9',
              'Örnek Borçlu',
              'Örnek Firma',
              '33333333333',
              'Senet',
              1000,
              '01.01.2025',
              '30.07.2025',
              'Kaynak Personel',
              100,
              '02.01.2025',
              'Banka',
              'HAN',
            ],
            [
              'ESKI-9',
              'Örnek Borçlu',
              'Örnek Firma',
              '33333333333',
              'Fatura',
              500,
              '01.02.2025',
              '30.07.2025',
              'Kaynak Personel',
              50,
              '03.02.2025',
              'Banka',
              'HAN',
            ],
          ],
        },
      ])),
    };
    preview = await request('preview', docs);
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.totals.ready, 1, JSON.stringify(preview.data));
    assert.equal(preview.data.items[0].amount, 1500);
    const docKeys = preview.data.items.map((r) => r.key);
    const result = await request('commit', { ...docs, keys: docKeys });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.imported, 1);
    assert.equal(result.data.payments, 2);
    assert.match(result.data.records[0].number, /^\d+$/);
    const saved = await store.readState(),
      doc = saved.data['icrapro-v1'].docs[0],
      events = saved.data['hanhukuk-finance-v1'];
    assert.equal(doc.receivables.length, 2);
    assert.deepEqual(
      doc.receivables.map((r) => r.docType),
      ['Senet', 'Fatura'],
    );
    assert.equal(doc.amount, 1500);
    assert.equal(doc.financeInterest, 0);
    assert.equal(doc.financeFee, 0);
    assert.equal(doc.financeTermsManual, true);
    assert.equal(doc.relatedStaff, 'source-staff');
    assert.equal(doc.assignmentHistory[0].to, 'source-staff');
    assert(doc.assignmentHistory[0].date > '2025-07-30');
    assert.equal(doc.receivedById, 'receiver:han');
    assert.deepEqual(doc.previousFolioNumbers, ['ESKI-9']);
    assert.equal(events.length, 2);
    assert.equal(
      events.reduce((s, e) => s + e.amount, 0),
      15000,
    );
    assert(events.every((e) => e.turnoverStaffId === 'unassigned' && e.sourceImport.cashPosted === false));
    assert.deepEqual(
      new Set(saved.data['hanhukuk-accounting-v1'].excludedFinanceIds),
      new Set(events.map((e) => e.id)),
    );
    assert.deepEqual(saved.data['hanhukuk-accounting-v1'].entries, []);
    assert.deepEqual(
      saved.data['hanhukuk-accounting-v1'].accounts,
      state.data['hanhukuk-accounting-v1'].accounts,
    );
    assert.equal((await request('commit', { ...docs, keys: docKeys })).data.imported, 0);
    const badGroup = await request('preview', {
      kind: 'documents',
      ...(await excel([
        {
          rows: [
            ['Föy No', 'Borçlu Adı', 'Müvekkil Adı', 'Evrak Tutarı', 'Vade Tarihi'],
            ['S1', 'Bir', 'Örnek Firma', 100, '01.01.2025'],
            ['S1', 'İki', 'Örnek Firma', 100, '01.01.2025'],
          ],
        },
      ])),
    });
    assert.equal(badGroup.data.totals.ready, 0);
    assert.equal(badGroup.data.totals.error, 1);
    const foreign = {
      kind: 'documents',
      ...(await excel([
        {
          rows: [
            ['Borçlu Adı', 'Müvekkil Adı', 'Evrak Tutarı', 'Vade Tarihi', 'Para Birimi'],
            ['Döviz Borçlusu', 'Örnek Firma', 1.25, '01.01.2025', 'Euro'],
          ],
        },
      ])),
    };
    const fp = await request('preview', foreign);
    assert.equal(fp.data.totals.ready, 1, JSON.stringify(fp.data));
    const fr = await request('commit', { ...foreign, keys: fp.data.items.map((r) => r.key) });
    assert.equal(fr.data.imported, 1, JSON.stringify(fr.data));
    assert.notEqual(fr.data.records[0].number, result.data.records[0].number);
    assert.equal((await request('preview', { ...input, mergeSheets: 'false' })).status, 400);
    for (const [code, ready] of [
      ['LIVE-CODE', 1],
      ['OLD-CODE', 0],
    ]) {
      const byCode = await request('preview', {
        kind: 'documents',
        ...(await excel([
          {
            rows: [
              ['Borçlu Adı', 'Müvekkil Kodu', 'Evrak Tutarı', 'Vade Tarihi'],
              ['Kodla Eşleşen Borçlu', code, 100, '01.01.2025'],
            ],
          },
        ])),
      });
      assert.equal(byCode.data.totals.ready, ready, JSON.stringify(byCode.data));
      assert.equal(byCode.data.totals.error, 1 - ready);
    }
  } finally {
    if (server) await server.close();
    await pg.close();
  }
});
