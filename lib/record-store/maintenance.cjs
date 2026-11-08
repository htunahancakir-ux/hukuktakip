const { businessDate } = require('../business-time.cjs');
async function maintenanceScope(db) {
  const {
    rows: [meta],
  } = await db.query('SELECT body FROM han_data.metadata WHERE id=1');
  const state = meta.body,
    today = businessDate();
  const query = (cursor) =>
    db.query(
      "SELECT id FROM han_data.documents WHERE active AND staff_id IS NOT NULL AND status NOT IN ('İnfaz','İade') AND id>$1 ORDER BY id LIMIT 200",
      [cursor],
    );
  let rows = (await query(state.workflowScanCursor || '')).rows;
  if (!rows.length && state.workflowScanCursor) rows = (await query('')).rows;
  const personnel = (await db.query('SELECT body FROM han_data.personnel WHERE active')).rows.map(
    (r) => r.body,
  );
  const users = state.users.filter(
    (u) => u.active && (!u.staffId || personnel.some((p) => p.id === u.staffId && p.active === true)),
  );
  const eligible = personnel.filter(
    (p) =>
      p.active === true &&
      users.some(
        (u) =>
          u.staffId === p.id && (['ceo', 'admin'].includes(u.role) || u.permissions?.includes('documents')),
      ),
  );
  const amounts = (
    await db.query(
      `SELECT coalesce(nullif(e.body->>'turnoverStaffId',''),nullif(e.body->>'collectionStaffId',''),d.staff_id) AS staff,sum(e.amount_cents)::text AS amount FROM han_data.financial_events e LEFT JOIN han_data.documents d ON d.id=e.document_id AND d.active WHERE e.active AND e.kind='payment' AND e.amount_cents>0 AND coalesce(e.occurred_on,'')<=$1 GROUP BY 1`,
      [today],
    )
  ).rows;
  const totals = new Map(amounts.map((r) => [r.staff, r.amount]));
  const ranking = eligible.map((p) => ({ ...p, collectionTotal: Number(totals.get(p.id) || 0) }));
  if (ranking.some((r) => !Number.isSafeInteger(r.collectionTotal)))
    throw Error('Tahsilat sıralaması güvenli tutar sınırını aşıyor.');
  ranking.sort(
    (a, b) =>
      b.collectionTotal - a.collectionTotal || a.name.localeCompare(b.name, 'tr') || a.id.localeCompare(b.id),
  );
  return {
    tables: ['documents', 'personnel', 'financial_events', 'conversations', 'workflow_notices'],
    documentIds: rows.map((r) => r.id),
    clientIds: [],
    workflowRanking: ranking.slice(0, 3),
    nextWorkflowCursor: rows.at(-1)?.id || '',
  };
}
module.exports = { maintenanceScope };
