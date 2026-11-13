// An explicit, server-managed grant delegates deletion to an active manager.
// The grant has no expiry; removing it revokes access on the next request.
const OWNER_ID = 'ef14702a-dcc8-49a6-b88e-ae8311fb5a77';
const canDelete = (user) =>
  user?.active !== false &&
  (user?.role === 'ceo' ||
    (user?.role === 'admin' &&
      user.deletionAccess === true &&
      user.readOnly !== true &&
      user.platformSupport !== true));
const denied = () => Object.assign(Error('Bu işlem için silme yetkiniz bulunmuyor.'), { code: 403 });
function assertDeletionAllowed(before, next, actor) {
  if (canDelete(actor)) return;
  const removed = (old, rows) =>
    (old || []).some((row) => row.id && !(rows || []).some((n) => n.id === row.id));
  const a = before.data,
    b = next.data;
  const oldRecords = a['icrapro-v1'],
    records = b['icrapro-v1'];
  const oldLedger = a['hanhukuk-accounting-v1'],
    ledger = b['hanhukuk-accounting-v1'];
  if (
    removed(oldRecords.clients, records.clients) ||
    removed(oldRecords.docs, records.docs) ||
    removed(a['hanhukuk-finance-v1'], b['hanhukuk-finance-v1']) ||
    removed(oldLedger.entries, ledger.entries) ||
    removed(oldLedger.accounts, ledger.accounts) ||
    removed(a['icrapro-personnel-v1'], b['icrapro-personnel-v1']) ||
    removed(a['icrapro-cases-v1'], b['icrapro-cases-v1']) ||
    removed(before.marketingProspects, next.marketingProspects) ||
    removed(before.messages, next.messages) ||
    (ledger.excludedFinanceIds || []).some((id) => !(oldLedger.excludedFinanceIds || []).includes(id))
  )
    throw denied();
  for (const doc of oldRecords.docs) {
    const updated = records.docs.find((d) => d.id === doc.id);
    if (updated && removed(doc.conversations, updated.conversations)) throw denied();
  }
}
module.exports = { OWNER_ID, canDelete, assertDeletionAllowed, denied };
