const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWorkOrderBatch } = require('../lib/work-order-batch.cjs');
const { handleCommunicationRoutes } = require('../outputs/icrapro/access-communications.cjs');
const actor = { id: 'owner', name: 'Test Owner', role: 'ceo' };
function fixture() {
  return {
    users: [
      actor,
      { id: 'a', name: 'Person A', active: true },
      { id: 'b', name: 'Person B', active: true },
      { id: 'inactive', active: false },
    ],
    workOrders: [{ id: 'old', title: 'Keep' }],
    messages: [{ id: 'old-message' }],
  };
}
test('Batch assigns an independent order and notification to each selected active person, preserving history', () => {
  const state = fixture(),
    original = structuredClone(state);
  let id = 0;
  const { next, orders } = createWorkOrderBatch(
    state,
    { assigneeIds: ['a', 'b', 'a'], title: 'Arama Yap', description: 'Test' },
    actor,
    (u) => u.active === true,
    () => String(++id),
  );
  assert.equal(orders.length, 2);
  assert.deepEqual(
    orders.map((o) => o.assigneeId),
    ['a', 'b'],
  );
  assert.notEqual(orders[0].id, orders[1].id);
  assert.equal(next.workOrders.length, 3);
  assert.equal(next.messages.length, 3);
  assert.deepEqual(next.workOrders[0], state.workOrders[0]);
  for (const order of orders) {
    const notice = next.messages.find((m) => m.workOrderId === order.id);
    assert.deepEqual(notice.recipientIds, [order.assigneeId]);
    assert.equal(order.assignerId, actor.id);
    assert.equal(order.status, 'pending');
  }
  assert.deepEqual(state, original);
});
test('Legacy single assignment remains supported; invalid batches cannot partially assign', () => {
  const state = fixture();
  assert.equal(
    createWorkOrderBatch(
      state,
      { assigneeId: 'a', title: 'Test' },
      actor,
      (u) => u.active,
      () => Math.random().toString(),
    ).orders.length,
    1,
  );
  for (const ids of [[], ['a', 'missing'], ['a', 'inactive'], ['a', 'owner'], [null], ['a', 5]]) {
    const original = structuredClone(state);
    assert.throws(
      () =>
        createWorkOrderBatch(
          state,
          { assigneeIds: ids, title: 'Test' },
          actor,
          (u) => u.active,
          () => '',
        ),
      { code: 400 },
    );
    assert.deepEqual(state, original);
  }
});
test('Route persists batch once and completing one order leaves the other pending', async () => {
  let state = fixture(),
    writes = 0,
    id = 0;
  const ctx = {
    get state() {
      return state;
    },
    u: actor,
    req: { method: 'POST' },
    res: {},
    url: new URL('http://localhost/api/work-orders'),
    input: { assigneeIds: ['a', 'b'], title: 'Arama Yap' },
    body: async () => ctx.input,
    userEnabled: (u) => u.active === true,
    crypto: { randomUUID: () => String(++id) },
    persist: (next) => {
      state = next;
      writes++;
    },
    send: (res, status, data) => {
      res.status = status;
      res.data = data;
    },
    fail: (code, msg) => Object.assign(Error(msg), { code }),
  };
  await handleCommunicationRoutes(ctx);
  assert.equal(ctx.res.status, 201);
  assert.equal(writes, 1);
  assert.equal(ctx.res.data.ids.length, 2);
  const [first, second] = state.workOrders.slice(1);
  ctx.url = new URL('http://localhost/api/work-orders/complete');
  ctx.u = state.users.find((u) => u.id === 'a');
  ctx.input = { id: first.id, result: 'Diğer' };
  await handleCommunicationRoutes(ctx);
  assert.equal(state.workOrders.find((o) => o.id === first.id).status, 'done');
  assert.equal(state.workOrders.find((o) => o.id === second.id).status, 'pending');
});
