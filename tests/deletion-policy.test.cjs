const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OWNER_ID, canDelete, assertDeletionAllowed } = require('../lib/deletion-policy.cjs');
const { handleDeletionRoutes } = require('../outputs/icrapro/access-deletion.cjs');
const { handleDocumentRoutes } = require('../outputs/icrapro/access-documents.cjs');
const owner = { id: OWNER_ID, role: 'ceo', name: 'HAN', active: true };
function fixture() {
  return {
    users: [],
    data: {
      'icrapro-v1': {
        clients: [{ id: 'client', name: 'Test' }],
        docs: [
          { id: 'doc', client: 'client', number: 'TEST-1', conversations: [{ id: 'call', note: 'Test' }] },
        ],
      },
      'hanhukuk-finance-v1': [{ id: 'payment', documentId: 'doc', type: 'payment', amount: 100 }],
      'hanhukuk-accounting-v1': {
        accounts: [{ id: 'cash' }],
        entries: [{ id: 'entry', type: 'clientPayout', documentId: 'doc', amount: 100 }],
      },
      'icrapro-personnel-v1': [{ id: 'staff' }],
      'icrapro-cases-v1': [{ id: 'case' }],
    },
    messages: [
      {
        id: 'msg',
        senderId: 'a',
        senderName: 'Ayşe',
        recipientIds: ['b'],
        recipientNames: ['Banu'],
        subject: 'Konu',
        text: 'Metin',
        createdAt: '2026-11-01T00:00:00.000Z',
        readBy: {},
      },
    ],
  };
}
function context(state, user = owner) {
  let saved;
  const ctx = {
    state,
    u: user,
    req: { method: 'GET' },
    res: {},
    url: new URL('http://localhost/api/operations/delete?type=accounting'),
    body: async () => ctx.input,
    send: (r, code, data) => {
      r.code = code;
      r.data = data;
    },
    fail: (code, msg) => Object.assign(Error(msg), { code }),
    persist: (next) => {
      assertDeletionAllowed(state, next, user);
      saved = next;
    },
  };
  return {
    ctx,
    get saved() {
      return saved;
    },
  };
}
test('Every active CEO has deletion capability; other roles remain blocked', () => {
  assert(canDelete(owner));
  assert(canDelete({ ...owner, id: 'other' }));
  for (const user of [
    null,
    { ...owner, role: 'admin' },
    { ...owner, active: false },
    { id: 'accountant', role: 'staff', accountingAccess: true, active: true },
  ])
    assert(!canDelete(user));
});
test('Nonowners cannot remove core records through bulk writes or hide financial events', () => {
  const before = fixture(),
    admin = { id: 'admin', role: 'admin' };
  for (const mutate of [
    (s) => (s.data['icrapro-v1'].clients = []),
    (s) => (s.data['icrapro-v1'].docs = []),
    (s) => (s.data['icrapro-v1'].docs[0].conversations = []),
    (s) => (s.data['hanhukuk-finance-v1'] = []),
    (s) => (s.data['hanhukuk-accounting-v1'].entries = []),
    (s) => (s.data['hanhukuk-accounting-v1'].accounts = []),
    (s) => (s.data['icrapro-personnel-v1'] = []),
    (s) => (s.data['icrapro-cases-v1'] = []),
    (s) => (s.messages = []),
    (s) => (s.data['hanhukuk-accounting-v1'].excludedFinanceIds = ['payment']),
  ]) {
    const next = structuredClone(before);
    mutate(next);
    assert.throws(() => assertDeletionAllowed(before, next, admin), { code: 403 });
    assert.doesNotThrow(() => assertDeletionAllowed(before, next, owner));
  }
  const edited = structuredClone(before);
  edited.data['icrapro-v1'].clients[0].name = 'Updated';
  assert.doesNotThrow(() => assertDeletionAllowed(before, edited, admin));
});
test('Deletion list and command reject other users and direct document delete rejects admins', async () => {
  for (const user of [
    { id: 'admin', role: 'admin' },
    { id: 'staff', role: 'staff' },
  ]) {
    const { ctx } = context(fixture(), user);
    await assert.rejects(handleDeletionRoutes(ctx), { code: 403 });
    ctx.req.method = 'POST';
    await assert.rejects(handleDeletionRoutes(ctx), { code: 403 });
    ctx.url = new URL('http://localhost/api/documents/delete');
    await assert.rejects(handleDocumentRoutes(ctx), { code: 403 });
  }
});
test('Each supported record type is archived on explicit owner deletion without changing the source snapshot', async () => {
  for (const type of [
    'clients',
    'documents',
    'finance',
    'accounting',
    'accounts',
    'personnel',
    'cases',
    'conversations',
    'messages',
  ]) {
    const state = fixture();
    if (type === 'clients') state.data['icrapro-v1'].docs = [];
    if (type === 'finance') state.data['hanhukuk-accounting-v1'].entries = [];
    const original = structuredClone(state),
      test = context(state),
      { ctx } = test;
    ctx.url.searchParams.set('type', type);
    await handleDeletionRoutes(ctx);
    const row = ctx.res.data.items[0];
    assert(row);
    ctx.req.method = 'POST';
    ctx.input = { type, ...row };
    await handleDeletionRoutes(ctx);
    assert.equal(ctx.res.code, 200);
    assert.equal(test.saved.deletedOperations.length, 1);
    assert.equal(test.saved.deletedOperations[0].deletedBy, OWNER_ID);
    assert.deepEqual(state, original);
  }
});
test('Revision conflict, dangling references and paid-out finance reject without persistence', async () => {
  for (const [type, code, mutate] of [
    ['accounting', 409, (i) => (i.revision = 'stale')],
    ['clients', 409, () => {}],
    ['finance', 409, () => {}],
  ]) {
    const t = context(fixture()),
      { ctx } = t;
    ctx.url.searchParams.set('type', type);
    await handleDeletionRoutes(ctx);
    ctx.req.method = 'POST';
    ctx.input = { type, ...ctx.res.data.items[0] };
    mutate(ctx.input);
    await assert.rejects(handleDeletionRoutes(ctx), { code });
    assert.equal(t.saved, undefined);
  }
});

test('Authenticated access exposes capability only to owner and enforces it on bulk writes', async () => {
  const { executeAccess } = require('../lib/access-executor.cjs'),
    crypto = require('node:crypto');
  const { sessionKey } = require('../lib/session-policy.cjs');
  for (const user of [
    owner,
    { ...owner, id: 'another-ceo' },
    { id: 'admin', role: 'admin', name: 'Admin', active: true },
  ]) {
    let state = fixture();
    state.users = [user];
    const req = {
      method: 'GET',
      headers: { cookie: 'han_session=synthetic', 'x-han-request': '1', host: 'localhost' },
      socket: {},
    };
    const sessions = new Map([
      [
        sessionKey(req),
        { id: user.id, deviceType: 'desktop', until: Date.now() + 600000, seenAt: Date.now() },
      ],
    ]);
    const context = {
      state,
      sessions,
      attempts: new Map(),
      saveState: (next) => {
        state = next;
      },
    };
    const options = { employeeTermsRequired: () => false };
    const session = await executeAccess(
      context,
      req,
      new URL('http://localhost/api/session'),
      Buffer.alloc(0),
      options,
    );
    assert.equal(JSON.parse(session.body).user.canDelete, user.role === 'ceo');
    const ledger = structuredClone(state.data['hanhukuk-accounting-v1']);
    ledger.entries = [];
    const tag =
      '"' +
      crypto.createHash('sha256').update(JSON.stringify(state.data['hanhukuk-accounting-v1'])).digest('hex') +
      '"';
    const result = await executeAccess(
      context,
      { ...req, method: 'PUT', headers: { ...req.headers, 'if-match': tag } },
      new URL('http://localhost/api/data?key=hanhukuk-accounting-v1'),
      Buffer.from(JSON.stringify({ value: ledger })),
      options,
    );
    assert.equal(result.statusCode, user.role === 'ceo' ? 200 : 403, result.body);
    assert.equal(state.data['hanhukuk-accounting-v1'].entries.length, user.role === 'ceo' ? 0 : 1);
  }
});
