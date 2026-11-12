const { inTransaction } = require('../db-transaction.cjs');
const { actor } = require('./queries.cjs');
const { sessionKey } = require('../session-policy.cjs');
const { isDeepStrictEqual } = require('node:util');
const duration = 120000;
const fail = (status, message) => Object.assign(Error(message), { status });
async function liveLease(db, id, now) {
  return (
    await db.query(
      `SELECT l.* FROM han_private.document_leases l
    JOIN han_private.han_sessions s ON s.token_hash=l.session_hash AND s.account_id=l.account_id AND s.expires_at>$2
    JOIN han_private.han_account_index a ON a.id=l.account_id AND a.enabled
    WHERE l.document_id=$1 AND l.expires_at>$2`,
      [id, now],
    )
  ).rows[0];
}
async function documentLease(pool, req, input) {
  const { documentId: id, viewId, action } = input || {};
  if (
    typeof id !== 'string' ||
    !id ||
    id.length > 200 ||
    typeof viewId !== 'string' ||
    !/^[a-zA-Z0-9-]{16,80}$/.test(viewId) ||
    !['acquire', 'release'].includes(action)
  )
    throw fail(400, 'Geçerli föy ve pencere bilgisi girin.');
  return inTransaction(pool, async (db) => {
    const user = await actor(db, req, { allowBreak: true });
    const doc = await db.query('SELECT id FROM han_data.documents WHERE id=$1 AND active FOR UPDATE', [id]);
    if (!doc.rows.length) throw fail(404, 'Dosya bulunamadı.');
    const now = Date.now(),
      session = sessionKey(req);
    if (action === 'release') {
      await db.query(
        'DELETE FROM han_private.document_leases WHERE document_id=$1 AND account_id=$2 AND session_hash=$3 AND view_id=$4',
        [id, user.id, session, viewId],
      );
      return { released: true };
    }
    const lease = await liveLease(db, id, now);
    if (
      lease &&
      (lease.account_id !== user.id || lease.session_hash !== session || lease.view_id !== viewId)
    ) {
      const owner = (
        await db.query("SELECT body->>'name' AS name FROM han_private.han_account_index WHERE id=$1", [
          lease.account_id,
        ])
      ).rows[0];
      return {
        editable: false,
        ownerName: owner?.name || 'Başka bir kullanıcı',
        expiresAt: lease.expires_at,
      };
    }
    if (user.readOnly && user.role !== 'ceo') return { editable: false, ownerName: null };
    await db.query(
      `INSERT INTO han_private.document_leases(document_id,account_id,session_hash,view_id,expires_at) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(document_id) DO UPDATE SET account_id=EXCLUDED.account_id,session_hash=EXCLUDED.session_hash,view_id=EXCLUDED.view_id,expires_at=EXCLUDED.expires_at`,
      [id, user.id, session, viewId, now + duration],
    );
    return { editable: true, ownerName: user.name, expiresAt: now + duration };
  });
}
function changedDocumentIds(before, next) {
  const ids = new Set();
  for (const [left, right, documents] of [
    [before.data['icrapro-v1'].docs, next.data['icrapro-v1'].docs, true],
    [before.data['hanhukuk-finance-v1'], next.data['hanhukuk-finance-v1'], false],
    [before.data['hanhukuk-accounting-v1'].entries, next.data['hanhukuk-accounting-v1'].entries, false],
  ]) {
    const old = new Map(left.map((r) => [r.id, r])),
      current = new Map(right.map((r) => [r.id, r]));
    for (const id of new Set([...old.keys(), ...current.keys()])) {
      const a = old.get(id),
        b = current.get(id);
      if (isDeepStrictEqual(a, b)) continue;
      if (documents) ids.add(id);
      else for (const r of [a, b]) if (r?.documentId) ids.add(r.documentId);
    }
  }
  return [...ids].sort();
}
async function assertDocumentsWritable(db, before, next, request) {
  if (!request?.req || request.system) return;
  const ids = changedDocumentIds(before, next);
  if (!ids.length) return;
  const user = await actor(db, request.req);
  // Claims and writes take the same document row lock, so acquiring a lease
  // cannot race a write that has already passed this check.
  await db.query('SELECT id FROM han_data.documents WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [ids]);
  for (const id of ids) {
    const lease = await liveLease(db, id, Date.now());
    if (lease && (lease.account_id !== user.id || lease.session_hash !== sessionKey(request.req)))
      throw fail(
        423,
        'Bu föy başka bir kullanıcıda açık. İzleme modundasınız; föy kapatılınca işlem yapabilirsiniz.',
      );
  }
}
module.exports = { documentLease, assertDocumentsWritable, changedDocumentIds };
