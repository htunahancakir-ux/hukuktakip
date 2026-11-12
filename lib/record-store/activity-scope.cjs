const { actor } = require('./queries.cjs');
const paths = [
  '/api/messages',
  '/api/messages/read',
  '/api/work-orders',
  '/api/work-orders/complete',
  '/api/scheduled-reminders',
];
async function activityScope(db, request) {
  if (!paths.includes(request?.url?.pathname) || request.req?.method !== 'POST') return null;
  const user = await actor(db, request.req),
    path = request.url.pathname;
  let input;
  try {
    input = JSON.parse(request.raw);
    if (!input || typeof input !== 'object') throw Error();
  } catch {
    throw Object.assign(Error('Geçersiz işlem.'), { status: 400 });
  }
  const scope = {
    tables: ['personnel', 'messages', 'work_orders', 'reminders'],
    activityIds: { messages: [], work_orders: [], reminders: [] },
  };
  let table =
    path === '/api/messages/read'
      ? 'messages'
      : path === '/api/work-orders/complete'
        ? 'work_orders'
        : path === '/api/scheduled-reminders' && input.action !== 'create'
          ? 'reminders'
          : null;
  if (table === 'reminders') {
    if (typeof input.id !== 'string' || input.id.length > 200)
      throw Object.assign(Error('Geçersiz kayıt.'), { status: 400 });
    await db.query('SELECT id FROM han_private.han_account_index WHERE id=$1 FOR UPDATE', [user.id]);
    const { rows } = await db.query(
      "SELECT id,body FROM han_data.reminders WHERE id=$1 AND active AND body->>'accountId'=$2 FOR UPDATE",
      [input.id, user.id],
    );
    scope.activityIds.reminders = [input.id];
    const row = rows[0]?.body;
    if (input.action === 'cancel' && row?.repeat && row.repeat !== 'none')
      scope.activityIds.reminders = (
        await db.query(
          `SELECT id FROM han_data.reminders WHERE active AND body->>'accountId'=$1 AND (id=$2 OR (body->>'repeatSeriesId'=$3 AND coalesce(body->>'closedAt','')='')) ORDER BY id FOR UPDATE`,
          [user.id, input.id, row.repeatSeriesId || row.id],
        )
      ).rows.map((r) => r.id);
    table = null;
  }
  if (table) {
    if (typeof input.id !== 'string' || input.id.length > 200)
      throw Object.assign(Error('Geçersiz kayıt.'), { status: 400 });
    await db.query('SELECT id FROM han_data.' + table + ' WHERE id=$1 AND active FOR UPDATE', [input.id]);
    scope.activityIds[table] = [input.id];
  }
  if (path === '/api/scheduled-reminders' && input.action === 'create') {
    // Serialize per-user quota checks, without locking other users or loading their reminders.
    await db.query('SELECT id FROM han_private.han_account_index WHERE id=$1 FOR UPDATE', [user.id]);
    scope.activityIds.reminders = (
      await db.query(
        "SELECT id FROM han_data.reminders WHERE active AND body->>'accountId'=$1 AND coalesce(body->>'closedAt','')='' LIMIT 201",
        [user.id],
      )
    ).rows.map((r) => r.id);
    if (input.targetType) {
      if (
        !['client', 'document'].includes(input.targetType) ||
        typeof input.targetId !== 'string' ||
        input.targetId.length > 200
      )
        throw Object.assign(Error('Geçersiz hedef.'), { status: 400 });
      scope.tables.push('clients', 'documents');
      scope.clientIds = input.targetType === 'client' ? [input.targetId] : [];
      scope.documentIds = input.targetType === 'document' ? [input.targetId] : [];
    }
  }
  return scope;
}
async function reminderScope(db, request) {
  const ids = request.reminderIds;
  const rows = ids
    ? await db.query(
        'SELECT id FROM han_data.reminders WHERE active AND id=ANY($1::text[]) ORDER BY id FOR UPDATE',
        [ids],
      )
    : await db.query(
        "SELECT id FROM han_data.reminders WHERE active AND ((body->>'deliveryStatus'='pending' AND coalesce(body->>'closedAt','')='' AND body->>'dueAt'<=$1) OR (body->>'deliveryStatus'='sending' AND body->>'deliveryUpdatedAt'<=$2) OR (body->>'repeat' IN ('daily','weekly','monthly','yearly') AND coalesce(body->>'closedAt','')='' AND coalesce(body->>'nextReminderId','')='' AND body->>'dueAt'<=$1)) ORDER BY body->>'dueAt',id LIMIT 100 FOR UPDATE SKIP LOCKED",
        [
          new Date(request.now || Date.now()).toISOString(),
          new Date((request.now || Date.now()) - 180000).toISOString(),
        ],
      );
  return { tables: ['personnel', 'reminders'], activityIds: { reminders: rows.rows.map((r) => r.id) } };
}
module.exports = { activityScope, reminderScope, paths };
