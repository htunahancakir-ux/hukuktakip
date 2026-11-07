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
  let state = structuredClone(original);
  const result = await work({
    state,
    sessions,
    scoped: !!scope,
    skipPayroll: true,
    attempts: new Map(),
    saveState(next) {
      state = next;
    },
    appendAudit: (events) => appendAudit(db, events),
  });
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
  for (const id of new Set(added.filter((row) => row.type === 'payment').map((row) => row.documentId))) {
    const doc = original.data['icrapro-v1'].docs.find((row) => row.id === id);
    if (!doc) throw Object.assign(Error('Dosya bulunamadı.'), { status: 404 });
    const remaining = BigInt(
      require('./balances.cjs').balance(doc, original.data['hanhukuk-finance-v1']).remaining_cents,
    );
    const incoming = added
      .filter((row) => row.documentId === id && row.type === 'payment')
      .reduce((sum, row) => sum + BigInt(row.amount), 0n);
    if (incoming > remaining)
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
  await writeChanges(db, data, state);
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
  const activityFields = [
    'messages',
    'workOrders',
    'workflowNotices',
    'collectionNotices',
    'scheduledReminders',
    'collectionNoticeSequence',
  ];
  if (activityFields.some((key) => !isDeepStrictEqual(original[key], state[key])))
    await db.query(`UPDATE han_private.han_activity SET body=$1::jsonb WHERE id=1`, [
      JSON.stringify({
        messages: state.messages || [],
        workOrders: state.workOrders || [],
        workflowNotices: state.workflowNotices || [],
        collectionNotices: state.collectionNotices || [],
        scheduledReminders: state.scheduledReminders || [],
        collectionNoticeSequence: state.collectionNoticeSequence || 0,
      }),
    ]);
  await flushSessions(db, previousSessions, sessions);
  return result;
}
async function recordTransaction(pool, work, appendAudit, request) {
  return inTransaction(pool, (db) => mutateRecords(db, work, appendAudit, request), {
    isolation: 'serializable',
  });
}
module.exports = { requireActive, readRecordState, readRecordContext, recordTransaction, mutateRecords };
