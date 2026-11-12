// Scope only well-defined record patches. Other administrative operations keep a
// complete compatibility view until their dedicated repository replaces it.
async function patchScope(db, request) {
  if (['/api/account/contact', '/api/users/contact'].includes(request?.url?.pathname))
    return { tables: ['personnel'] };
  if (request?.url?.pathname === '/api/record-attachments' && request.req?.method === 'POST') {
    let input;
    try {
      input = JSON.parse(request.raw);
    } catch {
      throw Object.assign(Error('Geçersiz ek isteği.'), { status: 400 });
    }
    const collection = require('../record-attachments.cjs').owner(input);
    const user = await require('./queries.cjs').actor(db, request.req);
    if (collection === 'personnel') {
      if (!['ceo', 'admin'].includes(user.role))
        throw Object.assign(Error('Personel ekleri için yönetici yetkisi gerekli.'), { status: 403 });
      await db.query('SELECT id FROM han_data.personnel WHERE id=$1 AND active FOR UPDATE', [input.ownerId]);
      return { tables: ['personnel', 'attachments'], personnelAttachmentOwner: input.ownerId };
    }
    if (
      collection === 'clients' &&
      !['ceo', 'admin'].includes(user.role) &&
      !user.permissions?.includes('clients')
    )
      throw Object.assign(Error('Ek yükleme yetkiniz yok.'), { status: 403 });
    if (collection === 'clients') {
      await db.query('SELECT id FROM han_data.clients WHERE id=$1 AND active FOR UPDATE', [input.ownerId]);
      return { tables: ['clients', 'personnel', 'attachments'], clientIds: [input.ownerId], documentIds: [] };
    }
    const { rows } = await db.query(
      'SELECT client_id FROM han_data.documents WHERE id=$1 AND active FOR UPDATE',
      [input.ownerId],
    );
    return {
      tables: [
        'clients',
        'documents',
        'personnel',
        'attachments',
        'financial_events',
        'ledger_entries',
        'conversations',
      ],
      documentIds: [input.ownerId],
      clientIds: rows.map((row) => row.client_id).filter(Boolean),
    };
  }
  if (
    ['/api/ceo-pin/config', '/api/ceo-pin/verify'].includes(request?.url?.pathname) ||
    request?.url?.pathname?.startsWith('/api/marketing/')
  )
    return { tables: ['personnel'] };
  if (
    ['/api/documents/conversation-report', '/api/documents/conversations'].includes(request?.url?.pathname) &&
    request.req?.method === 'POST'
  ) {
    const user = await require('./queries.cjs').actor(db, request.req);
    let input;
    try {
      input = JSON.parse(request.raw);
    } catch {
      input = {};
    }
    if (typeof input.documentId !== 'string' || !input.documentId || input.documentId.length > 200)
      throw Object.assign(Error('Geçersiz dosya.'), { status: 400 });
    const { rows } = await db.query(
      'SELECT client_id,staff_id FROM han_data.documents WHERE id=$1 AND active FOR UPDATE',
      [input.documentId],
    );
    if (
      !rows.length ||
      (!['ceo', 'admin'].includes(user.role) && (!user.staffId || rows[0].staff_id !== user.staffId))
    )
      throw Object.assign(Error('Bu dosyaya erişilemiyor.'), { status: 403 });
    return {
      tables: ['clients', 'documents', 'personnel', 'conversations', 'financial_events'],
      documentIds: [input.documentId],
      clientIds: rows.map((r) => r.client_id).filter(Boolean),
    };
  }
  if (request?.system === 'maintenance') return require('./maintenance.cjs').maintenanceScope(db);
  if (request?.system === 'scheduled-reminders')
    return require('./activity-scope.cjs').reminderScope(db, request);
  if (request?.system === 'whatsapp-delivery')
    return require('./activity-scope.cjs').deliveryScope(db, request);
  if (require('./activity-scope.cjs').paths.includes(request?.url?.pathname))
    return require('./activity-scope.cjs').activityScope(db, request);
  if (request?.url?.pathname === '/api/cash-entry' && request.req?.method === 'POST')
    return require('./cash-entries.cjs').cashScope(db, request);
  if (request?.url?.pathname === '/api/client-payout' && request.req?.method === 'POST')
    return require('./client-payouts.cjs').payoutScope(db, request);
  if (request?.url?.pathname === '/api/documents/chain') {
    let value;
    try {
      value = JSON.parse(request.raw);
    } catch {
      return null;
    }
    const ids = [value.documentId, value.targetId];
    if (ids.some((id) => typeof id !== 'string' || !id || id.length > 200)) return null;
    const { rows } = await db.query('SELECT client_id FROM han_data.documents WHERE id=ANY($1::text[])', [
      ids,
    ]);
    return {
      tables: [
        'clients',
        'documents',
        'personnel',
        'financial_events',
        'ledger_entries',
        'conversations',
        'attachments',
      ],
      documentIds: ids,
      clientIds: rows.map((row) => row.client_id).filter(Boolean),
    };
  }
  if (request?.url?.pathname !== '/api/data/patch') return null;
  const key = request.url.searchParams.get('key');
  if (!['icrapro-v1', 'hanhukuk-finance-v1', 'hanhukuk-accounting-v1'].includes(key)) return null;
  let payload;
  try {
    payload = JSON.parse(request.raw);
  } catch {
    return null;
  }
  if (!Array.isArray(payload.changes) || payload.changes.length > 500) return null;
  if (key === 'hanhukuk-accounting-v1') {
    if (
      payload.changes.length &&
      payload.changes.every(
        (c) =>
          c.path?.length === 1 &&
          c.path[0] === 'accounts' &&
          (c.field !== undefined || (c.before === null && c.value?.id === c.id)),
      )
    )
      return { tables: ['personnel', 'accounts'] };
    return null;
  }
  if (request.url.searchParams.get('operation') === 'intake') {
    if (
      key !== 'icrapro-v1' ||
      !payload.changes.length ||
      payload.changes.some(
        (c) =>
          !Array.isArray(c.path) ||
          c.path.length !== 1 ||
          c.path[0] !== 'docs' ||
          typeof c.id !== 'string' ||
          !c.id ||
          c.id.length > 200 ||
          (c.field === undefined && (c.before !== null || c.value?.id !== c.id)),
      )
    )
      throw Object.assign(Error('Geçersiz evrak değişikliği.'), { status: 400 });
    const ids = [...new Set(payload.changes.map((c) => c.id))];
    if (ids.length !== 1) throw Object.assign(Error('Her istekte tek evrak kaydedin.'), { status: 400 });
    const clientIds = payload.changes
      .map((c) => c.value?.client || (c.field === 'client' ? c.after?.value : null))
      .filter(Boolean);
    const { rows } = await db.query('SELECT client_id FROM han_data.documents WHERE id=ANY($1::text[])', [
      ids,
    ]);
    return {
      tables: [
        'clients',
        'documents',
        'personnel',
        'financial_events',
        'ledger_entries',
        'conversations',
        'attachments',
      ],
      documentIds: ids,
      clientIds: [...new Set([...clientIds, ...rows.map((row) => row.client_id)].filter(Boolean))],
      documentIntake: true,
    };
  }
  if (
    key === 'icrapro-v1' &&
    payload.changes.length &&
    payload.changes.every(
      (c) =>
        Array.isArray(c.path) &&
        c.path.length === 1 &&
        c.path[0] === 'clients' &&
        typeof c.id === 'string' &&
        c.id &&
        c.id.length <= 200 &&
        (c.field !== undefined || (c.before === null && c.value?.id === c.id)),
    )
  ) {
    const clientIds = [...new Set(payload.changes.map((c) => c.id))];
    return {
      tables: ['clients', 'personnel', 'attachments'],
      clientIds,
      documentIds: [],
      clientMutation: true,
    };
  }
  // Identity/creation/deletion still need global uniqueness/archive checks.
  // Payroll is separately aggregated in PostgreSQL, never from this partial view.
  const safeFields = new Set([
    'notes',
    'phone1',
    'phone2',
    'referencePhone1',
    'referencePhone2',
    'officePhone1',
    'officePhone2',
    'additionalPhones',
    'address',
    'address2',
    'address2City',
    'address2District',
    'officeAddress3',
    'officeAddress3City',
    'officeAddress3District',
    'additionalAddresses',
    'city',
    'district',
    'tapuStatus',
    'tapuDetails',
    'vehicleStatus',
    'vehicleDetails',
    'sgkStatus',
    'sgkDetails',
    'captureStatus',
    'captureDetails',
    'updatedAt',
    'conversations',
    'financeInterest',
    'financeFee',
    'financeTermsManual',
    'legalCalculation',
    'legalCalculationError',
    'parkingCommissionRate',
    'status',
    'closedDate',
    'repaymentPlan',
    'repaymentPlanHistory',
    'debtDiscountCents',
    'discountHistory',
  ]);
  if (
    !payload.changes.length ||
    payload.changes.some((c) =>
      key === 'icrapro-v1'
        ? c.path?.[0] !== 'docs' || !safeFields.has(c.field)
        : !Array.isArray(c.path) || c.path.length !== 0,
    )
  )
    return null;
  const clientIds = new Set(),
    documentIds = new Set(),
    eventIds = new Set();
  for (const change of payload.changes) {
    if (typeof change.id !== 'string') return null;
    if (key === 'hanhukuk-finance-v1') {
      eventIds.add(change.id);
      const id = change.value?.documentId || (change.field === 'documentId' ? change.after?.value : null);
      if (id) documentIds.add(id);
    } else if (change.path?.[0] === 'docs') {
      documentIds.add(change.id);
      const id = change.value?.client || (change.field === 'client' ? change.after?.value : null);
      if (id) clientIds.add(id);
    } else if (change.path?.[0] === 'clients') clientIds.add(change.id);
    else return null;
  }
  if (eventIds.size) {
    const { rows } = await db.query(
      'SELECT document_id FROM han_data.financial_events WHERE id=ANY($1::text[])',
      [[...eventIds]],
    );
    for (const row of rows) if (row.document_id) documentIds.add(row.document_id);
  }
  const { rows: docs } = await db.query(
    'SELECT id,client_id FROM han_data.documents WHERE id=ANY($1::text[])',
    [[...documentIds]],
  );
  for (const row of docs) {
    documentIds.add(row.id);
    if (row.client_id) clientIds.add(row.client_id);
  }
  return { clientIds: [...clientIds], documentIds: [...documentIds], eventIds: [...eventIds] };
}
function selection(table, scope) {
  if (!scope) return { where: '', params: [] };
  if (table === 'attachments' && scope.personnelAttachmentOwner)
    return { where: " WHERE body->>'personnelId'=$1", params: [scope.personnelAttachmentOwner] };
  if (scope.tables && !scope.tables.includes(table)) return { where: ' WHERE false', params: [] };
  if (scope.workflowRanking && table === 'workflow_notices')
    return { where: " WHERE body->>'documentId'=ANY($1::text[])", params: [scope.documentIds] };
  if (scope.activityIds && table in scope.activityIds)
    return { where: ' WHERE id=ANY($1::text[])', params: [scope.activityIds[table]] };
  if (scope.cashId && table === 'ledger_entries') return { where: ' WHERE id=$1', params: [scope.cashId] };
  if (scope.payoutId && table === 'ledger_entries')
    return {
      where: ' WHERE document_id=ANY($1::text[]) OR id=$2',
      params: [scope.documentIds, scope.payoutId],
    };
  if (scope.tables && !scope.documentIds) return { where: '', params: [] };
  if (table === 'clients') return { where: ' WHERE id=ANY($1::text[])', params: [scope.clientIds] };
  if (table === 'documents') return { where: ' WHERE id=ANY($1::text[])', params: [scope.documentIds] };
  if (['financial_events', 'ledger_entries', 'conversations'].includes(table))
    return { where: ' WHERE document_id=ANY($1::text[])', params: [scope.documentIds] };
  if (table === 'attachments')
    return {
      where: ' WHERE document_id=ANY($1::text[]) OR client_id=ANY($2::text[])',
      params: [scope.documentIds, scope.clientIds],
    };
  // Workflow/security references and small configuration remain complete.
  return { where: '', params: [] };
}
module.exports = { patchScope, selection };
