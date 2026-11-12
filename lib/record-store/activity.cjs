const { inTransaction } = require('../db-transaction.cjs');
const { actor } = require('./queries.cjs');
const { createHash } = require('node:crypto');
const scheduled = require('../scheduled-reminders.cjs');
const invalid = () => Object.assign(Error('Geçersiz liste filtresi veya sayfa.'), { status: 400 });
function pageFilter(url, user) {
  const kind =
    url.pathname === '/api/messages'
      ? 'messages'
      : url.pathname === '/api/work-orders'
        ? 'work_orders'
        : 'reminders';
  const params = [],
    conditions = ['active'],
    bind = (v) => '$' + params.push(v),
    manager = ['ceo', 'admin'].includes(user.role);
  let order = "coalesce(body->>'createdAt','')",
    ascending = false;
  const box = url.searchParams.get('box') || 'inbox',
    scope = url.searchParams.get('scope') || 'mine',
    status = url.searchParams.get('status') || (kind === 'reminders' ? 'open' : 'pending');
  if (kind === 'messages') {
    if (!['inbox', 'sent', 'all'].includes(box)) throw invalid();
    if (box === 'all' && !manager) throw Object.assign(Error('Yönetici yetkisi gerekli.'), { status: 403 });
    if (box !== 'all')
      conditions.push(
        box === 'sent' ? "body->>'senderId'=" + bind(user.id) : "body->'recipientIds' ? " + bind(user.id),
      );
  } else if (kind === 'work_orders') {
    if (!['mine', 'created', 'all'].includes(scope) || !['pending', 'done', 'all'].includes(status))
      throw invalid();
    if (scope === 'all' && !manager) throw Object.assign(Error('Yönetici yetkisi gerekli.'), { status: 403 });
    if (scope !== 'all')
      conditions.push("body->>'" + (scope === 'mine' ? 'assigneeId' : 'assignerId') + "'=" + bind(user.id));
    if (status !== 'all') conditions.push("body->>'status'=" + bind(status));
    if (url.searchParams.get('notification') === '1' && manager)
      conditions.push("body->>'createdAt'>=" + bind(require('../daily-notifications.cjs').cutoff(user)));
  } else {
    if (!['open', 'closed'].includes(status)) throw invalid();
    conditions.push("body->>'accountId'=" + bind(user.id));
    conditions.push("coalesce(body->>'closedAt','')" + (status === 'closed' ? "<>''" : "=''"));
    ascending = status !== 'closed';
    order = "coalesce(body->>'" + (ascending ? 'dueAt' : 'closedAt') + "','')";
  }
  const offset = Number(url.searchParams.get('offset') || 0);
  if (!Number.isSafeInteger(offset) || offset < 0) throw invalid();
  const signature = createHash('sha256')
    .update(JSON.stringify([kind, box, scope, status, user.id]))
    .digest('hex');
  let cursor;
  const encoded = url.searchParams.get('after');
  if (encoded) {
    try {
      if (encoded.length > 2000) throw Error();
      cursor = JSON.parse(Buffer.from(encoded, 'base64url'));
      if (
        cursor.signature !== signature ||
        typeof cursor.id !== 'string' ||
        cursor.id.length > 200 ||
        typeof cursor.date !== 'string' ||
        cursor.date.length > 100
      )
        throw Error();
    } catch {
      throw invalid();
    }
  }
  return { kind, params, conditions, order, ascending, offset, signature, cursor };
}
async function summary(db, user) {
  const {
    rows: [r],
  } = await db.query(
    `SELECT
 (SELECT count(*)::int FROM han_data.messages WHERE active AND body->'recipientIds' ? $1 AND coalesce(body->'readBy'->>$1,'')='' AND ($3='' OR body->>'createdAt'>=$3)) AS unread,
 (SELECT count(*)::int FROM han_data.work_orders WHERE active AND body->>'assigneeId'=$1 AND body->>'status'='pending' AND ($3='' OR body->>'createdAt'>=$3)) AS pending,
 (SELECT count(*)::int FROM han_data.reminders WHERE active AND body->>'accountId'=$1 AND coalesce(body->>'closedAt','')='' AND body->>'dueAt'<=$2) AS due`,
    [user.id, new Date().toISOString(), require('../daily-notifications.cjs').cutoff(user)],
  );
  return { messages: { unread: r.unread, pendingWorkOrders: r.pending }, reminders: { dueCount: r.due } };
}
async function notifications(db, user, url) {
  const counts = await summary(db, user),
    raw = url.searchParams.get('after');
  if (raw !== null && (!Number.isSafeInteger(Number(raw)) || Number(raw) < 0)) throw invalid();
  const {
    rows: [m],
  } = await db.query('SELECT body FROM han_data.metadata WHERE id=1');
  const { rows: workflow } = await db.query(
    "SELECT body FROM han_data.workflow_notices WHERE active AND body->>'userId'=$1 AND coalesce(body->>'acknowledgedAt','')='' AND ($2='' OR body->>'createdAt'>=$2) ORDER BY ordinal,id LIMIT 100",
    [user.id, require('../daily-notifications.cjs').cutoff(user)],
  );
  const collections =
    raw === null
      ? []
      : (
          await db.query(
            "SELECT body FROM han_data.collection_notices WHERE active AND (body->>'sequence')::bigint>$1 ORDER BY (body->>'sequence')::bigint,id LIMIT 100",
            [raw],
          )
        ).rows.map((r) => r.body);
  return {
    ...counts,
    staffBreak: user.role === 'staff' ? user.activeBreak || null : null,
    workflow: { notices: workflow.map((r) => r.body) },
    collections: {
      cursor: collections.at(-1)?.sequence || Number(m.body.collectionNoticeSequence || 0),
      notices: collections,
    },
  };
}
async function activityPage(pool, req, url) {
  if (['/api/notifications', '/api/scheduled-reminders'].includes(url.pathname)) {
    const user = await actor(pool, req, { allowBreak: url.pathname === '/api/notifications' });
    if (!user.readOnly) await require('./reminder-repeat.cjs').refreshRepeatingReminders(pool, user.id);
  }
  return inTransaction(
    pool,
    async (db) => {
      const user = await actor(db, req, { allowBreak: url.pathname === '/api/notifications' });
      if (url.pathname === '/api/notifications') return notifications(db, user, url);
      if (url.pathname === '/api/messages/summary') return (await summary(db, user)).messages;
      const f = pageFilter(url, user),
        where = ' WHERE ' + f.conditions.join(' AND ');
      const {
        rows: [total],
      } = await db.query('SELECT count(*)::text AS total FROM han_data.' + f.kind + where, f.params);
      const values = [...f.params],
        conditions = [...f.conditions];
      if (f.cursor)
        conditions.push(
          `(${f.order},id) ${f.ascending ? '>' : '<'} ($${values.push(f.cursor.date)},$${values.push(f.cursor.id)})`,
        );
      const { rows } = await db.query(
        `SELECT id,body,${f.order} AS date FROM han_data.${f.kind} WHERE ${conditions.join(' AND ')} ORDER BY ${f.order} ${f.ascending ? 'ASC' : 'DESC'},id ${f.ascending ? 'ASC' : 'DESC'} LIMIT 51 OFFSET $${values.push(f.cursor ? 0 : f.offset)}`,
        values,
      );
      const items = rows.slice(0, 50),
        last = items.at(-1),
        next =
          rows.length > 50
            ? Buffer.from(JSON.stringify({ signature: f.signature, id: last.id, date: last.date })).toString(
                'base64url',
              )
            : null;
      const result = { total: Number(total.total), offset: f.offset, next };
      if (f.kind === 'messages')
        return {
          ...result,
          messages: items.map(({ body: m }) => ({
            id: m.id,
            senderId: m.senderId,
            senderName: m.senderName,
            recipientIds: m.recipientIds,
            recipientNames: m.recipientNames,
            subject: m.subject,
            text: m.text,
            workOrderId: m.workOrderId || '',
            systemType: m.systemType || '',
            createdAt: m.createdAt,
            isUnread:
              m.recipientIds.includes(user.id) &&
              !m.readBy?.[user.id] &&
              require('../daily-notifications.cjs').current(m, user),
            readCount: Object.keys(m.readBy || {}).length,
            ...require('../../outputs/icrapro/access-communications.cjs').whatsappView(m, user),
          })),
        };
      if (f.kind === 'work_orders') return { ...result, orders: items.map((r) => r.body) };
      const {
          rows: [meta],
        } = await db.query('SELECT body FROM han_data.metadata WHERE id=1'),
        state = structuredClone(meta.body);
      state.data['icrapro-personnel-v1'] = (
        await db.query('SELECT body FROM han_data.personnel WHERE active')
      ).rows.map((r) => r.body);
      const ids = items.map((r) => r.body.targetId).filter(Boolean);
      state.data['icrapro-v1'] = {
        clients: (
          await db.query('SELECT id,name FROM han_data.clients WHERE active AND id=ANY($1::text[])', [ids])
        ).rows,
        docs: (
          await db.query(
            'SELECT id,number,body->>\'debtor\' AS debtor,staff_id AS "relatedStaff",body->>\'enforcementFileNumber\' AS "enforcementFileNumber" FROM han_data.documents WHERE active AND id=ANY($1::text[])',
            [ids],
          )
        ).rows,
      };
      const counts = await summary(db, user);
      return {
        ...result,
        dueCount: counts.reminders.dueCount,
        whatsappAvailable: scheduled.deliveryAvailable(state, user, !!state.reminderScheduler?.hash),
        items: url.searchParams.has('summary')
          ? []
          : items.map(({ body: { phoneHash, targetType, targetId, ...row } }) => ({
              ...row,
              target: scheduled.targetFor(state, user, targetType, targetId),
            })),
      };
    },
    { readOnly: true },
  );
}
module.exports = { activityPage, pageFilter, summary };
