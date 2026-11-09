// Existing small screens continue to use their established permission checks,
// without loading documents, attachments and money history for a settings read.
async function readScope(url, db) {
  if (!url) return null;
  const tables = new Set(['personnel']);
  const predicates = {
    '/api/due-installments': "body->'repaymentPlan' IS NOT NULL AND body->'repaymentPlan'<>'null'::jsonb",
    '/api/payment-promises': "body->'paymentPromise' IS NOT NULL AND body->'paymentPromise'<>'null'::jsonb",
    '/api/call-reminders':
      "EXISTS(SELECT 1 FROM han_data.conversations c WHERE c.active AND c.document_id=d.id AND c.body->'value'->'callReminder' IS NOT NULL AND c.body->'value'->'callReminder'<>'null'::jsonb)",
  };
  if (db && predicates[url.pathname]) {
    const { rows } = await db.query(
      "SELECT id FROM han_data.documents d WHERE active AND status NOT IN ('İnfaz','İade') AND " +
        predicates[url.pathname],
    );
    return {
      tables: ['personnel', 'documents', 'financial_events', 'conversations'],
      documentIds: rows.map((row) => row.id),
      clientIds: [],
    };
  }
  if (url.pathname === '/api/data') {
    const selected = {
      'icrapro-v1': ['clients', 'documents', 'conversations', 'attachments', 'document_archives'],
      'icrapro-personnel-v1': [],
      'icrapro-settings-v1': [],
      'hanhukuk-finance-v1': ['financial_events'],
      'hanhukuk-accounting-v1': ['accounts', 'ledger_entries'],
      'icrapro-cases-v1': ['cases'],
    }[url.searchParams.get('key')];
    if (!selected) return null;
    selected.forEach((t) => tables.add(t));
  } else if (
    ![
      '/api/users',
      '/api/ceo-pin/status',
      '/api/message-users',
      '/api/payroll-report',
      '/api/account',
      '/api/whatsapp/settings',
      '/api/employee-terms',
      '/api/employee-terms/current',
      '/api/employee-terms/settings',
      '/api/employee-terms/history',
    ].includes(url.pathname)
  )
    return null;
  return { tables: [...tables] };
}
module.exports = { readScope };
