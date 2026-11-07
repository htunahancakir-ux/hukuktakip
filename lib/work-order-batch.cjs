function createWorkOrderBatch(state, input, actor, userEnabled, randomUUID) {
  const reject = (message) => {
    throw Object.assign(Error(message), { code: 400 });
  };
  const title = String(input.title || '').trim(),
    description = String(input.description || '').trim();
  const ids = [
    ...new Set(
      Array.isArray(input.assigneeIds) ? input.assigneeIds : input.assigneeId ? [input.assigneeId] : [],
    ),
  ];
  const assignees = ids.map((id) => state.users.find((user) => user.id === id));
  if (
    !ids.length ||
    ids.some((id) => typeof id !== 'string' || id === actor.id) ||
    assignees.some((user) => !user || !userEnabled(user)) ||
    !title ||
    title.length > 150 ||
    description.length > 10000
  )
    reject('Atanacak aktif kişileri ve iş başlığını seçin.');
  if (input.due && (!/^\d{4}-\d{2}-\d{2}$/.test(input.due) || !Number.isFinite(Date.parse(input.due))))
    reject('Geçerli son tarih girin.');
  const next = structuredClone(state),
    now = new Date().toISOString();
  const orders = assignees.map((user) => ({
    id: randomUUID(),
    title,
    description,
    assigneeId: user.id,
    assigneeName: user.name,
    assignerId: actor.id,
    assignerName: actor.name,
    due: input.due || '',
    status: 'pending',
    createdAt: now,
  }));
  next.workOrders = [...(next.workOrders || []), ...orders];
  next.messages = [
    ...(next.messages || []),
    ...orders.map((order) => ({
      id: randomUUID(),
      senderId: actor.id,
      senderName: actor.name,
      recipientIds: [order.assigneeId],
      recipientNames: [order.assigneeName],
      subject: ('Yeni iş emri: ' + title).slice(0, 150),
      text: description,
      workOrderId: order.id,
      systemType: 'workOrderAssigned',
      createdAt: now,
      readBy: {},
    })),
  ];
  return { next, orders, assignees };
}
module.exports = { createWorkOrderBatch };
