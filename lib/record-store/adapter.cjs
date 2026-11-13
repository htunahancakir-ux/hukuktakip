const { isDeepStrictEqual } = require('node:util');
const { inTransaction } = require('../db-transaction.cjs');
const { load, writeChanges } = require('./storage.cjs');
const { join } = require('./codec.cjs');
const { readSessions, flushSessions, sessionsMap } = require('../security-store.cjs');
const { sessionKey } = require('../session-policy.cjs');
async function requireActive(db, locking = false) {
  const { rows } = await db.query(
    "SELECT mode FROM han_data.control WHERE id=1 AND mode='active'" + (locking ? ' FOR SHARE' : ''),
  );
  if (!rows.length) throw Object.assign(Error('Kayıt deposu henüz etkinleştirilmedi.'), { status: 503 });
}
async function readRecordState(pool) {
  return inTransaction(
    pool,
    async (db) => {
      await requireActive(db);
      const data = await load(db);
      return join(data.metadata, data.rows);
    },
    { readOnly: true },
  );
}
async function readRecordContext(pool, req, url) {
  return inTransaction(
    pool,
    async (db) => {
      await requireActive(db);
      const { rows: sessions } = await db.query(
        `SELECT s.* FROM han_private.han_sessions s
        JOIN han_private.han_account_index a ON a.id=s.account_id AND a.enabled
        WHERE s.token_hash=$1 AND s.expires_at>$2`,
        [sessionKey(req), Date.now()],
      );
      if (!sessions.length) throw Object.assign(Error('Oturum açmanız gerekiyor.'), { status: 401 });
      const data = await load(db, await require('./read-scope.cjs').readScope(url, db));
      return { state: join(data.metadata, data.rows), sessions: sessionsMap(sessions) };
    },
    { readOnly: true },
  );
}
async function mutateRecords(db, work, appendAudit, request) {
  await requireActive(db, true);
  const scope = await require('./scope.cjs').patchScope(db, request);
  const data = await load(db, scope),
    original = join(data.metadata, data.rows),
    sessions = await readSessions(db);
  const previousSessions = structuredClone(sessions);
  const voip = await require('../voip-conversations.cjs').transactionContext(db, request);
  let state = structuredClone(original);
  if (scope?.workflowRanking) state.workflowScanCursor = scope.nextWorkflowCursor;
  const recordPatch = scope?.documentIntake
    ? await require('./intake.cjs').prepareIntakePatch(db, scope, original, request)
    : null;
  const result = await work({
    ...voip,
    state,
    workflowRanking: scope?.workflowRanking,
    payoutAccountBalances: scope?.payoutId ? await require('./accounts.cjs').accountBalances(db) : undefined,
    cashAccountBalances: scope?.cashId ? await require('./accounts.cjs').accountBalances(db) : undefined,
    recordPatch,
    sessions,
    scoped: !!scope,
    skipPayroll: true,
    attempts: new Map(),
    saveState(next) {
      state = next;
    },
    appendAudit: (events) => appendAudit(db, events),
  });
  await voip.flush?.();
  const originalFinance = new Map(original.data['hanhukuk-finance-v1'].map((row) => [row.id, row]));
  const added = state.data['hanhukuk-finance-v1'].filter((row) => !originalFinance.has(row.id));
  const changedAccounts = [...new Set(added.map((row) => row.accountId).filter(Boolean))].sort();
  if (changedAccounts.length)
    await db.query('SELECT id FROM han_data.accounts WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [
      changedAccounts,
    ]);
  for (const row of added) {
    if (
      !['payment', 'expense', 'costOnly'].includes(row.type) ||
      !Number.isSafeInteger(row.amount) ||
      row.amount <= 0
    )
      throw Object.assign(Error('Geçerli pozitif işlem tutarı girin.'), { status: 400 });
  }
  // Validate against the complete history of the touched documents, even when
  // two clients both opened an older version of the same account/file.
  for (const row of added)
    if (row.unitAllocation && !scope?.currencyCollection)
      throw Object.assign(Error('Döviz/altın tahsilatını günlük kur ekranından kaydedin.'), { status: 403 });
  for (const id of new Set(
    added.filter((row) => row.type === 'payment' && !row.unitAllocation).map((row) => row.documentId),
  )) {
    const doc = original.data['icrapro-v1'].docs.find((row) => row.id === id);
    if (!doc) throw Object.assign(Error('Dosya bulunamadı.'), { status: 404 });
    const remaining = BigInt(
      require('./balances.cjs').balance(doc, original.data['hanhukuk-finance-v1']).remaining_cents,
    );
    const incoming = added
      .filter((row) => row.documentId === id && row.type === 'payment' && !row.unitAllocation)
      .reduce((sum, row) => sum + BigInt(row.amount), 0n);
    if (doc.docType !== 'Yediemin Park Ücreti' && incoming > remaining)
      throw Object.assign(Error('Tahsilat güncel kalan borcu aşamaz. Dosyayı yeniden açın.'), {
        status: 409,
      });
  }
  if (scope?.clientMutation) {
    for (const row of data.rows.clients)
      if (!row.active && state.data['icrapro-v1'].clients.some((c) => c.id === row.id))
        throw Object.assign(Error('Arşivlenmiş kayıt kimliği yeniden kullanılamaz.'), { status: 409 });
    await require('./clients.cjs').assertClientIdentities(db, original, state);
  }
  if (scope?.documentIntake) {
    if (data.rows.documents.some((row) => !row.active))
      throw Object.assign(Error('Arşivlenmiş evrak yeniden oluşturulamaz.'), { status: 409 });
    await require('./intake.cjs').validateIntake(db, original, state, request.req);
  }
  await require('./document-leases.cjs').assertDocumentsWritable(db, original, state, request);
  await writeChanges(db, data, state);
  if (scope?.cashId && result?.body) {
    const balances = await require('./accounts.cjs').accountBalances(db);
    if (scope.cashOutgoing && (!(scope.cashAccount in balances) || BigInt(balances[scope.cashAccount]) < 0n))
      throw Object.assign(Error('Seçilen hesapta yeterli bakiye yok.'), { status: 409 });
    // Staff may enter money without viewing every account balance.
    const user = await require('./queries.cjs').actor(db, request.req);
    if (['ceo', 'admin'].includes(user.role))
      result.body = JSON.stringify({ ...JSON.parse(result.body), accountBalances: balances });
  }
  if (scope?.payoutId && result?.body) {
    const balances = await require('./accounts.cjs').accountBalances(db);
    if (!(scope.payoutAccount in balances) || BigInt(balances[scope.payoutAccount]) < 0n)
      throw Object.assign(Error('Seçilen hesapta yeterli bakiye yok.'), { status: 409 });
    result.body = JSON.stringify({ ...JSON.parse(result.body), accountBalances: balances });
  }
  if (changedAccounts.length) {
    const balances = await require('./accounts.cjs').accountBalances(db);
    for (const row of added.filter((row) => row.type !== 'payment'))
      if (!(row.accountId in balances) || BigInt(balances[row.accountId]) < 0n)
        throw Object.assign(Error('Seçilen kasa/banka hesabında yeterli bakiye yok.'), { status: 409 });
    if (result?.body) result.body = JSON.stringify({ ...JSON.parse(result.body), accountBalances: balances });
  }
  if (
    !isDeepStrictEqual(original.data['hanhukuk-finance-v1'], state.data['hanhukuk-finance-v1']) ||
    !isDeepStrictEqual(original.data['icrapro-personnel-v1'], state.data['icrapro-personnel-v1']) ||
    !isDeepStrictEqual(original.dailyBonuses, state.dailyBonuses) ||
    ([...original.data['icrapro-personnel-v1'], ...state.data['icrapro-personnel-v1']].some(
      (person) =>
        require('../../outputs/icrapro/marketing-bonus.cjs').isMarketing(person) ||
        require('../../outputs/icrapro/other-personnel-bonus.cjs').isOtherPersonnel(person),
    ) &&
      (!isDeepStrictEqual(original.data['icrapro-v1'].docs, state.data['icrapro-v1'].docs) ||
        !isDeepStrictEqual(original.data['icrapro-v1'].clients, state.data['icrapro-v1'].clients))) ||
    (state.payrollPeriodMonth &&
      state.payrollPeriodMonth !== require('../business-time.cjs').businessDate().slice(0, 7))
  )
    await require('./payroll.cjs').refreshPayroll(db);
  // The security index is derived, never a second independently writable source.
  if (
    !isDeepStrictEqual(original.users, state.users) ||
    !isDeepStrictEqual(original.data['icrapro-personnel-v1'], state.data['icrapro-personnel-v1']) ||
    !isDeepStrictEqual(original.employeeTerms, state.employeeTerms)
  )
    await db.query('SELECT han_private.refresh_access_index($1::jsonb)', [JSON.stringify(state)]);
  // Active record mode reads notification counts from indexed record tables.
  await flushSessions(db, previousSessions, sessions);
  return result;
}
async function recordTransaction(pool, work, appendAudit, request) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await inTransaction(pool, (db) => mutateRecords(db, work, appendAudit, request), {
        isolation: 'serializable',
      });
    } catch (error) {
      // Retry only rolled-back database serialization failures. Field-level
      // conflicts still return 409 and never silently overwrite a newer edit.
      if (
        attempt >= 2 ||
        (request?.url?.searchParams.get('operation') !== 'intake' &&
          ![
            '/api/client-payout',
            '/api/cash-entry',
            '/api/documents/principal',
            '/api/documents/manual-close',
            '/api/documents/conversation-report',
            '/api/expense-pool/fund',
            '/api/expense-pool/allocate',
            '/api/ceo-pin/verify',
            '/api/ceo-pin/config',
            '/api/marketing/routes',
            '/api/marketing/config',
          ].includes(request?.url?.pathname)) ||
        !['40001', '40P01'].includes(error.code)
      )
        throw error;
    }
  }
}
module.exports = { requireActive, readRecordState, readRecordContext, recordTransaction, mutateRecords };
