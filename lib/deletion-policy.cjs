const { restricted } = require('./module-permissions.cjs');
// An explicit, server-managed grant delegates deletion to an active manager.
// The grant has no expiry; removing it revokes access on the next request.
const OWNER_ID = 'ef14702a-dcc8-49a6-b88e-ae8311fb5a77';
const canDelete = (user, module) =>
  user?.active !== false &&
  (user?.role === 'ceo' ||
    (user?.role === 'admin' &&
      user.readOnly !== true &&
      user.platformSupport !== true &&
      !restricted(user, module, 'delete') &&
      (user.deletionAccess === true || user.modulePermissions?.[module]?.delete === true)));
const denied = () => Object.assign(Error('Bu işlem için silme yetkiniz bulunmuyor.'), { code: 403 });
function assertDeletionAllowed(before, next, actor) {
  if (actor?.role === 'ceo' && canDelete(actor)) return;
  const removed = (old, rows) => (old || []).some((row) => row.id && !rows.has(row.id));
  const a = before.data,
    b = next.data;
  const oldRecords = a['icrapro-v1'],
    records = b['icrapro-v1'];
  const oldLedger = a['hanhukuk-accounting-v1'],
    ledger = b['hanhukuk-accounting-v1'];
  const ids = (rows) => new Set((rows || []).map((row) => row.id));
  for (const [module, old, rows] of [
    ['clients', oldRecords.clients, records.clients],
    ['documents', oldRecords.docs, records.docs],
    ['finance', a['hanhukuk-finance-v1'], b['hanhukuk-finance-v1']],
    ['accounting', oldLedger.entries, ledger.entries],
    ['accounting', oldLedger.accounts, ledger.accounts],
    ['personnel', a['icrapro-personnel-v1'], b['icrapro-personnel-v1']],
    ['cases', a['icrapro-cases-v1'], b['icrapro-cases-v1']],
    ['marketing', before.marketingProspects, next.marketingProspects],
    ['messages', before.messages, next.messages],
  ]) {
    if (!canDelete(actor, module) && removed(old, ids(rows))) throw denied();
  }
  if (
    !canDelete(actor, 'accounting') &&
    (ledger.excludedFinanceIds || []).some((id) => !(oldLedger.excludedFinanceIds || []).includes(id))
  )
    throw denied();
  if (!canDelete(actor, 'documents')) {
    const docs = new Map(records.docs.map((d) => [d.id, d]));
    for (const doc of oldRecords.docs) {
      const updated = docs.get(doc.id);
      if (updated && removed(doc.conversations, ids(updated.conversations))) throw denied();
    }
  }
}
module.exports = { OWNER_ID, canDelete, assertDeletionAllowed, denied };
