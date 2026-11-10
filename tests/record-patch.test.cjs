const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diff, apply } = require('../outputs/icrapro/record-patch.js');
test('Independent edits preserve concurrent changes and only send changed fields', () => {
  const old = {
    clients: [{ id: 'c', name: 'A' }],
    docs: [
      { id: 'd', notes: 'old', phone: '1' },
      { id: 'e', notes: 'other' },
    ],
  };
  const next = structuredClone(old);
  next.docs[0].notes = 'new';
  const patch = diff('icrapro-v1', old, next);
  assert.equal(patch.changes.length, 1);
  assert.equal(patch.changes[0].field, 'notes');
  const concurrent = structuredClone(old);
  concurrent.docs[0].phone = '2';
  concurrent.docs.push({ id: 'f', notes: 'added elsewhere' });
  const merged = apply('icrapro-v1', concurrent, patch);
  assert.equal(merged.docs[0].notes, 'new');
  assert.equal(merged.docs[0].phone, '2');
  assert.equal(merged.docs.length, 3);
  assert.throws(() => apply('icrapro-v1', merged, patch), { status: 409 });
});
test('Partial loaded collections cannot remove unloaded records; explicit deletion checks entire record', () => {
  const old = { clients: [], docs: [{ id: 'd', notes: 'old' }] },
    next = { clients: [], docs: [] };
  const merged = apply(
    'icrapro-v1',
    { clients: [], docs: [{ id: 'd', notes: 'old' }, { id: 'other' }] },
    diff('icrapro-v1', old, next),
  );
  assert.deepEqual(merged.docs, [{ id: 'other' }]);
  assert.throws(
    () =>
      apply(
        'icrapro-v1',
        { clients: [], docs: [{ id: 'd', notes: 'changed' }] },
        diff('icrapro-v1', old, next),
      ),
    { status: 409 },
  );
});
test('Reject duplicate identities, arbitrary paths and prototype fields', () => {
  assert.throws(() => diff('hanhukuk-finance-v1', [], [{ id: 'x' }, { id: 'x' }]), { status: 400 });
  for (const change of [
    { path: ['users'], id: 'x', before: null, value: { id: 'x' } },
    { path: ['docs'], id: 'x', field: '__proto__', before: {}, after: { value: { polluted: true } } },
  ])
    assert.throws(() => apply('icrapro-v1', { clients: [], docs: [] }, { changes: [change] }), {
      status: 400,
    });
  assert.equal({}.polluted, undefined);
});
test('Noncollection fields and financial reordering retain the revision-checked compatibility path', () => {
  const old = { accounts: [], entries: [], excludedFinanceIds: [] },
    next = { ...old, excludedFinanceIds: ['x'] };
  assert.equal(diff('hanhukuk-accounting-v1', old, next), null);
  assert.equal(diff('hanhukuk-finance-v1', [{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'a' }]), null);
});

for (const role of ['admin', 'ceo'])
  test(`Aynı ${role} oturumunda farklı dosyalara arka arkaya yapılandırma kaydedilir`, () => {
    const { JSDOM } = require('jsdom');
    const fs = require('node:fs');
    const { parsers } = require('prettier/plugins/babel');
    const dom = new JSDOM('', { url: 'https://test.invalid', runScripts: 'dangerously' });
    const w = dom.window;
    try {
      const key = 'icrapro-v1';
      let server = {
        clients: [{ id: 'client', name: 'Müvekkil' }],
        docs: ['a', 'b', 'untouched'].map((id) => ({ id, number: id, status: 'Derdest', amount: 100 })),
      };
      const calls = [];
      Object.assign(w, {
        structuredClone,
        hanRecordsEnabled: true,
        hanAuth: { id: role, role, permissions: [] },
        hanStartupData: null,
        protectedKeys: new Set([key]),
        hanDataVersions: new Map(),
        hanDataBaselines: new Map(),
        financeEvents: [],
        accounting: { accounts: [], entries: [] },
      });
      w.crypto.randomUUID = require('node:crypto').randomUUID;
      const extract = (file, names) => {
        const s = fs.readFileSync(file, 'utf8');
        return parsers.babel
          .parse(s)
          .program.body.filter((n) => n.type === 'FunctionDeclaration' && names.includes(n.id.name))
          .map((n) => s.slice(n.start, n.end))
          .join('\n');
      };
      w.eval(fs.readFileSync('outputs/icrapro/record-patch.js', 'utf8'));
      w.eval(
        extract('outputs/icrapro/auth.js', ['authApi', 'installServerStorage']) +
          '\n' +
          extract('outputs/icrapro/app.js', ['save']) +
          '\n' +
          extract('outputs/icrapro/finance-operations.js', ['persistRepaymentPlan']),
      );
      w.XMLHttpRequest = class {
        open(method, url) {
          this.method = method;
          this.url = url;
        }
        setRequestHeader() {}
        getResponseHeader() {
          return null;
        }
        send(body) {
          calls.push({ method: this.method, url: this.url });
          this.status = 200;
          if (this.method === 'GET') {
            this.responseText = JSON.stringify(server);
            return;
          }
          const patch = JSON.parse(body);
          if (patch.changes.some((c) => !c.field && c.value === null)) {
            this.status = 403;
            this.responseText = JSON.stringify({ error: 'Yüklenmemiş kayıtlar silinemez.' });
            return;
          }
          server = apply(key, server, patch);
          const ids = [...new Set(patch.changes.filter((c) => c.path[0] === 'docs').map((c) => c.id))];
          this.responseText = JSON.stringify({
            ok: true,
            records: ids.map((id) => ({ path: ['docs'], id, value: server.docs.find((d) => d.id === id) })),
          });
        }
      };
      w.db = { clients: structuredClone(server.clients), docs: [] };
      w.hanDataBaselines.set(key, structuredClone(w.db));
      const hydrate = (id) => {
        for (const collection of [w.db, w.hanDataBaselines.get(key)]) {
          const doc = structuredClone(server.docs.find((d) => d.id === id));
          const index = collection.docs.findIndex((d) => d.id === id);
          if (index < 0) collection.docs.push(doc);
          else collection.docs[index] = doc;
        }
        return w.db.docs.find((d) => d.id === id);
      };
      w.installServerStorage();
      const plan = {
        method: 'equal',
        balance: 10000,
        targetAtCreation: 10000,
        receivedAtCreation: 0,
        discount: 0,
        installments: [{ due: '2026-11-10', amount: 10000 }],
      };
      w.persistRepaymentPlan(hydrate('a'), plan);
      w.persistRepaymentPlan(hydrate('b'), plan);
      w.persistRepaymentPlan(hydrate('a'), { ...plan, installments: [{ due: '2026-12-10', amount: 10000 }] });
      assert.equal(server.docs.find((d) => d.id === 'a').repaymentPlanHistory.length, 1);
      assert.ok(server.docs.find((d) => d.id === 'b').repaymentPlan);
      assert.equal(server.docs.find((d) => d.id === 'untouched').repaymentPlan, undefined);
      assert.equal(
        calls.filter((c) => c.method === 'GET').length,
        0,
        'A scoped save must not replace its baseline with a full workspace read',
      );
      assert.equal(calls.filter((c) => c.method === 'PUT').length, 3);
    } finally {
      dom.window.close();
    }
  });
