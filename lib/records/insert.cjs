// SQL values are bound separately. Identifiers cannot use $1 placeholders, so
// this importer accepts only the tables and columns explicitly listed here.
const targets = new Map(
  Object.entries({
    migration_checkpoint: 'id source_revision source_payload source_sha256',
    parties: 'id name identity_no kind',
    personnel: 'id name active extras',
    clients: 'id party_id extras',
    accounts: 'id name kind extras',
    documents:
      'id number client_id assigned_staff_id debtor_id kind status principal_cents interest_cents fee_cents discount_cents due_on enforcement_number deleted_at extras',
    attachments: 'id document_id client_id name mime sha256 size_bytes content extras',
    conversations: 'document_id id occurred_on at_time note result operator_id extras',
    document_links: 'document_id linked_id',
    document_archives: 'document_id snapshot',
    financial_events: 'id document_id account_id kind amount_cents occurred_on operator_id note extras',
    ledger_entries:
      'id account_id destination_id document_id kind amount_cents occurred_on operator_id note extras',
    messages: 'id sender_id subject body created_at extras',
    message_recipients: 'message_id account_id read_at label_at_send',
    work_orders: 'id assigner_id assignee_id title description status due_on created_at extras',
    reminders: 'id account_id client_id document_id due_at note closed_at extras',
    terms_releases: 'version hash document',
    terms_acceptances: 'account_id version hash accepted_at snapshot',
    notice_events: 'account_id body',
    payroll_periods: 'month closed extras',
    payroll_rows: 'month staff_id snapshot',
    daily_bonuses: 'id staff_id occurred_on amount_cents extras',
    cases: 'id body',
    settings: 'key value',
  }).map(([table, columns]) => [table, new Set(columns.split(' '))]),
);

async function insertNormalizedRow(db, table, row) {
  const allowed = targets.get(table);
  if (!allowed || !row || typeof row !== 'object' || Array.isArray(row))
    throw new Error('Invalid import table or row');
  const keys = Object.keys(row);
  if (!keys.length || keys.some((key) => !allowed.has(key))) throw new Error('Invalid import columns');
  // Every interpolated identifier has passed the closed allowlist above.
  const columns = keys.map((key) => '"' + key + '"').join(',');
  const parameters = keys.map((_, index) => '$' + (index + 1)).join(',');
  return db.query(
    `INSERT INTO han_core."${table}" (${columns}) VALUES (${parameters})`,
    keys.map((key) => row[key]),
  );
}

module.exports = { insertNormalizedRow };
