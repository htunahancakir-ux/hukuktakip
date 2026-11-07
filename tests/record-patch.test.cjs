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
