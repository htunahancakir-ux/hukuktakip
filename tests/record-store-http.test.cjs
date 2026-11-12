const { test } = require('node:test');

test('Personnel files stay private, survive payroll edits and load one attachment at a time', async () => {
  const crypto = require('node:crypto');
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    state.users.push(
      { ...state.users[0], id: 'file-admin', username: 'file-admin', role: 'admin' },
      { ...state.users[0], id: 'file-staff', username: 'file-staff', role: 'staff', permissions: [] },
    );
    state.data['icrapro-personnel-v1'] = [
      { id: 'person-one', name: 'Person One', officialSalary: 1000, unofficialSalary: 0, active: true },
      { id: 'person-two', name: 'Person Two', officialSalary: 2000, unofficialSalary: 0, active: false },
    ];
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    server = await serve(createApplication({ store: createStore(pool, { records: true }) }));
    const headers = {};
    for (const id of ['test-ceo', 'file-admin', 'file-staff']) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
        [crypto.createHash('sha256').update(token).digest('hex'), id, Date.now() + 600000],
      );
      headers[id] = {
        cookie: 'han_session=' + token,
        'Content-Type': 'application/json',
        'X-Han-Request': '1',
      };
    }
    const pdf = { id: 'staff-pdf', name: 'document.pdf', data: 'data:application/pdf;base64,JVBERi0x' },
      photo = { id: 'staff-photo', name: 'photo.png', data: 'data:image/png;base64,iVBORw0KGgo=' };
    const upload = (personnelId, attachment, user = 'test-ceo') =>
      fetch(server.url + '/api/record-attachments', {
        method: 'POST',
        headers: headers[user],
        body: JSON.stringify({ ownerType: 'personnel', ownerId: personnelId, attachment }),
      });
    for (const file of [pdf, photo]) {
      const response = await upload('person-one', file);
      assert.equal(response.status, 200, await response.text());
    }
    assert.equal((await upload('person-one', pdf)).status, 200);
    assert.equal((await upload('person-two', pdf, 'file-admin')).status, 200);
    assert.equal((await upload('person-one', { ...pdf, id: 'denied' }, 'file-staff')).status, 403);
    const get = (params, user = 'test-ceo') =>
      fetch(server.url + '/api/records/personnel-attachments?' + new URLSearchParams(params), {
        headers: headers[user],
      });
    assert.equal((await get({ personnelId: 'person-one' }, 'file-staff')).status, 403);
    const response = await get({ personnelId: 'person-one' }, 'file-admin');
    assert.equal(response.status, 200);
    const files = await response.json();
    assert.equal(files.items.length, 2);
    assert.equal(JSON.stringify(files).includes('base64,'), false);
    const viewed = await get({ personnelId: 'person-one', attachmentId: files.items[0].id });
    assert.equal(viewed.status, 200);
    assert.ok([pdf.data, photo.data].includes((await viewed.json()).attachment.data));
    assert.equal((await get({ personnelId: 'person-two', attachmentId: files.items[0].id })).status, 404);
    const edit = await fetch(server.url + '/api/data/patch?key=icrapro-personnel-v1', {
      method: 'PUT',
      headers: headers['test-ceo'],
      body: JSON.stringify({
        changes: [
          {
            path: [],
            id: 'person-one',
            field: 'officialSalary',
            before: { value: 1000 },
            after: { value: 1200 },
          },
        ],
      }),
    });
    assert.equal(edit.status, 200, await edit.text());
    const exported = await require('../lib/record-store/storage.cjs').exportRecords(pool);
    assert.equal(exported.personnelAttachments.length, 3);
    assert.equal(exported.data['icrapro-personnel-v1'][0].officialSalary, 1200);
    assert.equal(exported.data['icrapro-personnel-v1'][1].officialSalary, 2000);
    assert.equal(exported.data['icrapro-personnel-v1'][0].attachments, undefined);
    const { split, join } = require('../lib/record-store/codec.cjs');
    const decomposed = split(exported);
    assert.deepEqual(decomposed.metadata.personnelAttachments, []);
    assert.deepEqual(join(decomposed.metadata, decomposed.rows), exported);
    const bootstrap = await fetch(server.url + '/api/records/bootstrap', {
      headers: headers['file-staff'],
    }).then((r) => r.json());
    assert.equal(JSON.stringify(bootstrap).includes('base64,'), false);
    assert.ok(
      (await pool.query("SELECT count(*)::int AS n FROM han_private.han_audit WHERE area='Personel Ekleri'"))
        .rows[0].n >= 3,
    );
  } finally {
    await server?.close();
    await pg.close();
  }
});

test('Multiple document and client attachments persist separately, preserve legacy files and safely retry', async () => {
  const crypto = require('node:crypto');
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    state.users.push({
      ...state.users[0],
      id: 'attachment-staff',
      username: 'attachment-staff',
      role: 'staff',
      permissions: [],
    });
    state.data['icrapro-v1'].clients = [{ id: 'attachment-client', name: 'Synthetic', attachments: [] }];
    state.data['icrapro-v1'].docs = [
      {
        id: 'attachment-doc',
        client: 'attachment-client',
        number: 'S-001',
        debtor: 'Synthetic',
        amount: 100,
        docType: 'Senet',
        fileData: 'data:application/pdf;base64,JVBERi0x',
        photoData: 'data:image/png;base64,iVBORw0KGgo=',
      },
    ];
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    server = await serve(createApplication({ store: createStore(pool, { records: true }) }));
    async function headers(id) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO han_private.han_sessions(token_hash,account_id,device_type,expires_at) VALUES($1,$2,'desktop',$3)",
        [crypto.createHash('sha256').update(token).digest('hex'), id, Date.now() + 600000],
      );
      return { cookie: 'han_session=' + token, 'Content-Type': 'application/json', 'X-Han-Request': '1' };
    }
    const ceo = await headers('test-ceo'),
      staff = await headers('attachment-staff');
    const pdf = {
      id: 'pdf',
      name: 'first.pdf',
      data: 'data:application/pdf;base64,' + Buffer.alloc(1700000, 65).toString('base64'),
    };
    const photo = {
      id: 'photo',
      name: 'second.png',
      data: 'data:image/png;base64,' + Buffer.alloc(1700000, 66).toString('base64'),
    };
    assert.ok(JSON.stringify([pdf, photo]).length > 4 * 1024 * 1024);
    const post = async (ownerType, ownerId, attachment, actor = ceo) => {
      const size = 524288,
        parts = Math.ceil(attachment.data.length / size);
      let response;
      for (let part = 0; part < parts; part++) {
        response = await fetch(server.url + '/api/record-attachments', {
          method: 'POST',
          headers: actor,
          body: JSON.stringify({
            ownerType,
            ownerId,
            part,
            parts,
            attachment: { ...attachment, data: attachment.data.slice(part * size, (part + 1) * size) },
          }),
        });
        if (!response.ok) return response;
        if (part < parts - 1) await response.text();
      }
      return response;
    };
    for (const [kind, id] of [
      ['document', 'attachment-doc'],
      ['client', 'attachment-client'],
    ]) {
      for (const file of [pdf, photo]) {
        const response = await post(kind, id, file);
        const body = await response.text();
        assert.equal(response.status, 200, body);
        assert.ok(body.length < 1000);
      }
      assert.equal((await post(kind, id, pdf)).status, 200);
      assert.equal((await post(kind, id, { ...pdf, name: 'conflict.pdf' })).status, 409);
    }
    assert.equal((await post('client', 'attachment-client', { ...pdf, id: 'denied' }, staff)).status, 403);
    const edge = {
      id: 'edge',
      name: 'ten-megabytes.pdf',
      data: 'data:application/pdf;base64,' + Buffer.alloc(10 * 1024 * 1024, 67).toString('base64'),
    };
    assert.throws(
      () =>
        require('../lib/record-attachments.cjs').appendAttachment(
          state,
          {
            ownerType: 'document',
            ownerId: 'attachment-doc',
            attachment: {
              id: 'oversized',
              name: 'large.pdf',
              data: 'data:application/pdf;base64,' + Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64'),
            },
          },
          state.users[0],
          () => true,
        ),
      /boyutu/,
    );
    const edgeResponse = await post('document', 'attachment-doc', edge);
    assert.equal(edgeResponse.status, 200, await edgeResponse.text());
    assert.equal(
      (
        await post('document', 'attachment-doc', {
          id: 'unsafe',
          name: 'x.svg',
          data: 'data:image/svg+xml;base64,PHN2Zz4=',
        })
      ).status,
      400,
    );
    const record = (await pool.query("SELECT body FROM han_data.documents WHERE id='attachment-doc'")).rows[0]
      .body;
    assert.deepEqual(record.attachments, []);
    assert.equal(record.fileData, undefined);
    const context = await fetch(server.url + '/api/records/document?id=attachment-doc&section=context', {
      headers: ceo,
    }).then((r) => r.json());
    assert.equal(context.attachments.length, 5);
    for (const file of context.attachments) {
      const response = await fetch(
        server.url +
          '/api/records/document?' +
          new URLSearchParams({ id: 'attachment-doc', section: 'attachment', attachmentId: file.id }),
        { headers: ceo },
      );
      assert.equal(response.status, 200);
      const loaded = await response.json();
      if (loaded.field === 'attachments' && loaded.value.name === edge.name) {
        let text = '',
          hash;
        for (;;) {
          const partResponse = await fetch(
            server.url +
              '/api/records/document?' +
              new URLSearchParams({
                id: 'attachment-doc',
                section: 'attachment',
                attachmentId: file.id,
                _hanChunk: String(text.length),
              }),
            { headers: { ...ceo, 'X-Han-Chunk-Transport': '1' } },
          );
          assert.equal(partResponse.headers.get('X-Han-Chunked'), '1');
          const part = await partResponse.json();
          assert.equal(part.offset, text.length);
          hash ||= part.hash;
          assert.equal(part.hash, hash);
          text += part.chunk;
          if (text.length === part.total) break;
        }
        assert.deepEqual(JSON.parse(text), loaded);
      }
      if (loaded.field === 'attachments')
        assert.ok([pdf.data, photo.data, edge.data].includes(loaded.value.data));
    }
    const exported = await require('../lib/record-store/storage.cjs').exportRecords(pool);
    const doc = exported.data['icrapro-v1'].docs[0];
    assert.equal(doc.fileData, state.data['icrapro-v1'].docs[0].fileData);
    assert.equal(doc.photoData, state.data['icrapro-v1'].docs[0].photoData);
    assert.deepEqual(
      doc.attachments.map((f) => f.name),
      ['first.pdf', 'second.png', 'ten-megabytes.pdf'],
    );
    assert.equal(exported.data['icrapro-v1'].clients[0].attachments.length, 2);
  } finally {
    await server?.close();
    await pg.close();
  }
});
const assert = require('node:assert/strict');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createApplication } = require('../lib/application.cjs');
const { importState, createStore } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { diff } = require('../outputs/icrapro/record-patch.js');

test('Unchanged automatic charges preserve their timestamp; changed inputs are still recalculated', () => {
  const { applyAutomaticLegalCharges } = require('../outputs/icrapro/legal-charges.cjs');
  const doc = { id: 'automatic', docType: 'Senet', amount: 1000, due: '2026-11-01', status: 'Derdest' };
  assert.equal(applyAutomaticLegalCharges(doc, [], '2026-11-10'), true);
  doc.legalCalculation.calculatedAt = '2026-11-10T00:00:00.000Z';
  const before = structuredClone(doc);
  assert.equal(applyAutomaticLegalCharges(doc, [], '2026-11-10'), false);
  assert.deepEqual(doc, before);
  doc.amount = 2000;
  assert.equal(applyAutomaticLegalCharges(doc, [], '2026-11-10'), true);
  assert.equal(doc.legalCalculation.principal, 200000);
  doc.due = '2026-11-02';
  assert.equal(applyAutomaticLegalCharges(doc, [], '2026-11-10'), true);
  assert.equal(doc.legalCalculation.start, '2026-11-02');
  assert.equal(applyAutomaticLegalCharges(doc, [], '2026-11-11'), true);
  assert.equal(doc.legalCalculation.end, '2026-11-11');
});
test('Manual interest survives scoped saves; only CEO can override closed-file locks', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    state.users.push(
      { ...state.users[0], id: 'admin', username: 'admin', role: 'admin' },
      { ...state.users[0], id: 'staff', username: 'staff', role: 'staff' },
    );
    state.data['icrapro-v1'] = {
      clients: [{ id: 'client', name: 'Faiz Testi' }],
      docs: ['unpaid', 'paid', 'closed'].map((id) => ({
        id,
        number: id,
        client: 'client',
        debtor: id,
        docType: 'Senet',
        amount: 1000,
        due: '2026-11-01',
        status: id === 'closed' ? 'İnfaz' : 'Derdest',
        financeInterest: 50,
        financeFee: 100,
      })),
    };
    state.data['hanhukuk-accounting-v1'].accounts = [{ id: 'cash', name: 'Kasa' }];
    state.data['hanhukuk-finance-v1'] = ['paid', 'closed'].map((id) => ({
      id: 'payment-' + id,
      documentId: id,
      type: 'payment',
      accountId: 'cash',
      amount: id === 'closed' ? 115000 : 10000,
      date: '2026-11-02',
    }));
    require('../outputs/icrapro/legal-charges.cjs').applyAutomaticLegalCharges(
      state.data['icrapro-v1'].docs[0],
      [],
      require('../lib/business-time.cjs').businessDate(),
    );
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    server = await serve(createApplication({ store }));
    for (const username of ['test', 'admin', 'staff']) {
      const login = await fetch(server.url + '/api/login', {
        method: 'POST',
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(login.status, 200);
      const headers = {
        'X-Han-Request': '1',
        'Content-Type': 'application/json',
        cookie: login.headers.get('set-cookie').split(';')[0],
      };
      const load = async (id) =>
        (await fetch(server.url + '/api/records/document?id=' + id + '&section=context', { headers })).json();
      const patch = (before, after) =>
        fetch(server.url + '/api/data/patch?key=icrapro-v1', {
          method: 'PUT',
          headers,
          body: JSON.stringify(
            diff('icrapro-v1', { docs: [before], clients: [] }, { docs: [after], clients: [] }),
          ),
        });
      for (const id of ['unpaid', 'paid']) {
        const before = (await load(id)).record;
        const interest = username === 'admin' ? 450.75 : 325.25;
        const after = { ...before, financeInterest: interest, financeFee: 125.5, financeTermsManual: true };
        if (username === 'test' && id === 'unpaid') {
          // A background save must not alter the unchanged automatic calculation
          // and make the finance form's existing snapshot stale.
          const background = await patch(before, { ...before, notes: 'Başka oturumun notu' });
          assert.equal(background.status, 200, await background.text());
          delete after.legalCalculation;
          delete after.legalCalculationError;
        }
        const response = await patch(before, after);
        if (username === 'staff') {
          assert.equal(response.status, 403);
          const flagResponse = await patch(before, { ...before, financeTermsManual: false });
          assert.equal(flagResponse.status, 403);
          continue;
        }
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.records[0].value.financeInterest, interest);
        assert.equal(body.records[0].value.financeFee, 125.5);
        const reloaded = (await load(id)).record;
        assert.equal(reloaded.financeInterest, interest);
        assert.equal(reloaded.financeTermsManual, true);
        const noteResponse = await patch(reloaded, { ...reloaded, notes: 'Sonraki işlem' });
        assert.equal(noteResponse.status, 200, await noteResponse.text());
        const page = await (await fetch(server.url + '/api/records/documents?q=' + id, { headers })).json();
        const row = page.items.find((item) => item.id === id);
        assert.equal(row.targetCents, String(100000 + Math.round(interest * 100) + 12550));
        assert.equal(row.remainingCents, String(Number(row.targetCents) - (id === 'paid' ? 10000 : 0)));
        assert.equal(
          (await store.readState()).data['icrapro-v1'].docs.find((doc) => doc.id === id).financeInterest,
          interest,
        );
        if (username === 'test' && id === 'unpaid') {
          const current = (await load(id)).record;
          const concurrent = await patch(current, { ...current, financeInterest: interest + 10 });
          assert.equal(concurrent.status, 200, await concurrent.text());
          const stale = await patch(current, { ...current, financeInterest: interest + 20 });
          assert.equal(stale.status, 409, 'Actual concurrent edits of interest must remain protected');
          assert.equal((await load(id)).record.financeInterest, interest + 10);
        }
      }
      const closed = (await load('closed')).record;
      const closedEdit = await patch(closed, {
        ...closed,
        financeInterest: username === 'test' ? 400 : 500,
        financeTermsManual: true,
      });
      assert.equal(closedEdit.status, username === 'test' ? 200 : 403);
    }
  } finally {
    await server?.close();
    await pg.close();
  }
});

test('Active record storage preserves existing HTTP commands, audit, auth and scoped edits', async () => {
  const { pg, pool } = await database();
  let server;
  try {
    const state = fixture();
    state.data['icrapro-v1'] = {
      clients: [{ id: 'c', name: 'Test' }],
      docs: [
        { id: 'a', number: 'A-1', client: 'c', debtor: 'Test A', amount: 100, notes: 'first' },
        { id: 'b', number: 'B-1', client: 'c', debtor: 'Test B', amount: 200, notes: 'second' },
      ],
    };
    state.payrollPeriods = { '2026-11': { marker: 'must survive partial edits' } };
    state.data['icrapro-v1'].docs[0].fileData = 'data:application/pdf;base64,JVBERi0x';
    state.data['icrapro-v1'].docs[0].fileName = 'test.pdf';
    state.data['hanhukuk-accounting-v1'].accounts = [{ id: 'cash', name: 'Kasa' }];
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const store = createStore(pool, { records: true });
    const application = createApplication({ store });
    server = await serve((req, res) => {
      const original = new URL(req.url, 'http://localhost');
      req.query = { ...Object.fromEntries(original.searchParams), route: original.pathname.slice(5) };
      req.url = '/api/index';
      req.url = require('../lib/api-request-url.cjs').apiRequestUrl(req);
      return application(req, res);
    });
    const login = await fetch(server.url + '/api/login', {
      method: 'POST',
      headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test', password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { 'X-Han-Request': '1', 'Content-Type': 'application/json', cookie };
    const initial = await (await fetch(server.url + '/api/records/bootstrap', { headers })).json();
    assert.equal(initial.summary.documents, '2');
    assert.equal(initial.summary.documentAmountCents, '30000');
    assert.deepEqual(initial.data['icrapro-v1'].docs, []);
    assert.deepEqual(initial.data['icrapro-v1'].clients, []);
    assert.deepEqual(initial.data['hanhukuk-finance-v1'], []);
    assert.equal(initial.data['hanhukuk-accounting-v1'].accounts.length, 1);
    const context = await (
      await fetch(server.url + '/api/records/document?id=a&section=context', { headers })
    ).json();
    assert.equal(context.record.fileData, undefined);
    assert.equal(context.attachments.length, 1);
    const attachment = await (
      await fetch(
        server.url +
          '/api/records/document?' +
          new URLSearchParams({ id: 'a', section: 'attachment', attachmentId: context.attachments[0].id }),
        { headers },
      )
    ).json();
    assert.equal(attachment.value, state.data['icrapro-v1'].docs[0].fileData);
    const crossDocument = await fetch(
      server.url +
        '/api/records/document?' +
        new URLSearchParams({ id: 'b', section: 'attachment', attachmentId: context.attachments[0].id }),
      { headers },
    );
    assert.equal(crossDocument.status, 404);
    const search = await (await fetch(server.url + '/api/search?q=Test%20A', { headers })).json();
    assert.equal(search.items.filter((item) => item.type === 'document').length, 1);
    const literalSearch = await (
      await fetch(server.url + '/api/records/search?kind=client&q=%25', { headers })
    ).json();
    assert.equal(literalSearch.items.length, 0);
    const get = await fetch(server.url + '/api/data?key=icrapro-v1', { headers }),
      before = await get.json(),
      after = structuredClone(before);
    after.docs[0].notes = 'only A changed';
    const response = await fetch(server.url + '/api/data/patch?key=icrapro-v1', {
      method: 'PUT',
      headers,
      body: JSON.stringify(diff('icrapro-v1', before, after)),
    });
    const responseBody = await response.json();
    assert.equal(response.status, 200, JSON.stringify(responseBody));
    assert.equal(responseBody.records[0].value.notes, 'only A changed');
    assert.equal(responseBody.records[0].value.fileData, undefined);
    assert(responseBody.records[0].preservedFields.includes('fileData'));
    const saved = await store.readState();
    assert.equal(saved.data['icrapro-v1'].docs[0].notes, 'only A changed');
    assert.equal(saved.data['icrapro-v1'].docs[0].fileData, state.data['icrapro-v1'].docs[0].fileData);
    assert.equal(saved.data['icrapro-v1'].docs[1].notes, 'second');
    assert.deepEqual(saved.payrollPeriods, state.payrollPeriods);
    assert(
      (await pool.query("SELECT count(*)::int AS n FROM han_private.han_audit WHERE category='changes'"))
        .rows[0].n > 0,
    );
    const page = await fetch(server.url + '/api/records/documents?limit=1', { headers });
    assert.equal(page.status, 200);
    const result = await page.json();
    assert.equal(result.items.length, 1);
    assert.equal(result.totals.count, '2');
    for (const [documentId, amount] of [
      ['a', 1200],
      ['b', 2800],
    ]) {
      // Two browsers both started with an empty finance list. Neither append
      // may erase the other's collection, and payroll uses all records.
      const payment = {
        id: 'pay-' + documentId,
        documentId,
        accountId: 'cash',
        type: 'payment',
        turnoverStaffId: 'turnover:bonus',
        date: require('../lib/business-time.cjs').businessDate(),
        amount,
      };
      const added = await fetch(server.url + '/api/data/patch?key=hanhukuk-finance-v1', {
        method: 'PUT',
        headers,
        body: JSON.stringify(diff('hanhukuk-finance-v1', [], [payment])),
      });
      assert.equal(added.status, 200, await added.text());
    }
    const paid = await (await fetch(server.url + '/api/records/documents?limit=1', { headers })).json();
    assert.equal(paid.totals.receivedCents, '4000');
    assert.equal((await store.readState()).data['hanhukuk-finance-v1'].length, 2);
    const writeEvent = (event) =>
      fetch(server.url + '/api/data/patch?key=hanhukuk-finance-v1', {
        method: 'PUT',
        headers,
        body: JSON.stringify(diff('hanhukuk-finance-v1', [], [event])),
      });
    const cost = {
      id: 'cost',
      documentId: 'a',
      accountId: 'cash',
      type: 'costOnly',
      date: require('../lib/business-time.cjs').businessDate(),
      amount: 2000,
    };
    const allowedCost = await writeEvent(cost);
    assert.equal(allowedCost.status, 200);
    assert.equal((await allowedCost.json()).accountBalances.cash, '2000');
    const tooMuchCost = await writeEvent({ ...cost, id: 'overdraft', amount: 3000 });
    assert.equal(tooMuchCost.status, 409);
    const tooMuchPayment = await writeEvent({
      ...cost,
      id: 'overpayment',
      type: 'payment',
      amount: 9500,
      turnoverStaffId: 'turnover:bonus',
    });
    assert.equal(tooMuchPayment.status, 409);
    assert.equal((await store.readState()).data['hanhukuk-finance-v1'].length, 3);
    const stale = await fetch(server.url + '/api/data/patch?key=icrapro-v1', {
      method: 'PUT',
      headers,
      body: JSON.stringify(diff('icrapro-v1', before, after)),
    });
    assert.equal(stale.status, 409);
    const backup = await store.exportBackup();
    assert.equal(backup._hanBackup.version, 2);
    assert(backup._hanBackup.audit.length > 0);
    const { restoreAudit } = require('../lib/record-store/backup.cjs');
    const { inTransaction } = require('../lib/db-transaction.cjs');
    // This target is a distinct, temporary database; never truncate live audit.
    const target = await database();
    try {
      const { _hanBackup, ...business } = backup;
      await inTransaction(target.pool, async (db) => {
        await importState(db, business);
        await restoreAudit(db, _hanBackup);
      });
      assert.equal(
        (await target.pool.query('SELECT count(*)::int AS n FROM han_private.han_audit')).rows[0].n,
        _hanBackup.audit.length,
      );
      assert.deepEqual(
        (await target.pool.query('SELECT payload FROM han_private.han_state WHERE id=1')).rows[0].payload,
        business,
      );
    } finally {
      await target.pg.close();
    }
  } finally {
    await server?.close();
    await pg.close();
  }
});
