const { inTransaction } = require('./db-transaction.cjs');
// Dedicated tables: no audio or growing call history in the application snapshot.
async function transaction(pool, records, work, scope = {}) {
  return inTransaction(pool, async (db) => {
    const { rows: configRows } = await db.query(
      'SELECT body FROM han_private.voip_config WHERE id=1' + (scope.configWrite ? ' FOR UPDATE' : ''),
    );
    const config = configRows[0]?.body || {},
      state = {
        voipConfig: config,
        voipCalls: [],
        users: [],
        data: { 'icrapro-v1': { docs: [], clients: [] } },
      };
    if (scope.aiConfig)
      state.aiConfig =
        (await db.query("SELECT payload->'aiConfig' AS config FROM han_private.han_state WHERE id=1")).rows[0]
          ?.config || {};
    if (scope.enqueueTranscription) {
      const input = scope.enqueueTranscription,
        values = [JSON.stringify(input.job)],
        clauses = [
          "body->>'recordingPresent'='true'",
          "status NOT IN ('starting','ringing','answered','unknown')",
          "COALESCE(body->'transcription'->>'status','') NOT IN ('queued','processing','completed')",
        ];
      if (input.mode === 'selected') {
        values.push(input.ids);
        clauses.push('id=ANY($' + values.length + '::text[])');
      }
      if (input.mode === 'filtered')
        clauses.push(...require('./voip-query.cjs').filters(input.filters, values));
      state.voipEnqueued = (
        await db.query(
          `WITH queued AS (UPDATE han_private.voip_calls SET body=jsonb_set(body,'{transcription}',CASE WHEN body->'transcription'->>'configHash'=($1::jsonb)->>'configHash' THEN $1::jsonb || jsonb_build_object('parts',COALESCE(body->'transcription'->'parts','[]'::jsonb)) ELSE $1::jsonb END,true) WHERE ${clauses.join(' AND ')} RETURNING 1) SELECT count(*)::int AS total FROM queued`,
          values,
        )
      ).rows[0].total;
    }
    if (scope.users)
      state.users = (await db.query('SELECT body FROM han_private.han_account_index WHERE enabled')).rows.map(
        (r) => r.body,
      );
    if (scope.documentId) {
      if (records) {
        state.data['icrapro-v1'].docs = (
          await db.query('SELECT body FROM han_data.documents WHERE id=$1 AND active', [scope.documentId])
        ).rows.map((r) => r.body);
        if (scope.fullHistory && state.data['icrapro-v1'].docs[0])
          state.data['icrapro-v1'].docs[0].conversations = (
            await db.query(
              "SELECT body->'value' AS value FROM han_data.conversations WHERE document_id=$1 AND active ORDER BY ordinal,id",
              [scope.documentId],
            )
          ).rows.map((r) => r.value);
        const client = state.data['icrapro-v1'].docs[0]?.client;
        if (client)
          state.data['icrapro-v1'].clients = (
            await db.query('SELECT body FROM han_data.clients WHERE id=$1', [client])
          ).rows.map((r) => r.body);
      } else {
        const { rows } = await db.query(
          "SELECT d FROM han_private.han_state s,jsonb_array_elements(s.payload->'data'->'icrapro-v1'->'docs') d WHERE s.id=1 AND d->>'id'=$1",
          [scope.documentId],
        );
        state.data['icrapro-v1'].docs = rows.map((r) => r.d);
        state.data['icrapro-v1'].clients = (
          await db.query(
            "SELECT c FROM han_private.han_state s,jsonb_array_elements(s.payload->'data'->'icrapro-v1'->'clients') c WHERE s.id=1 AND c->>'id'=$1",
            [rows[0]?.d.client || ''],
          )
        ).rows.map((r) => r.c);
      }
    }
    if (scope.reserve) {
      // Serialize reservations by user and destination; never hold DB locks over provider calls.
      for (const lock of ['phone:' + scope.phone, 'user:' + scope.userId].sort())
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lock]);
    }
    let sql = '',
      params = [];
    if (scope.id) {
      sql = 'SELECT body FROM han_private.voip_calls WHERE id=$1 FOR UPDATE';
      params = [scope.id];
    } else if (scope.webhook) {
      sql = `SELECT body FROM han_private.voip_calls WHERE body->>'providerId'=$1 OR (body->>'providerId' IS NULL AND status IN ('starting','unknown','ringing') AND phone=$2 AND body->>'extension'=$3) FOR UPDATE`;
      params = [
        scope.webhook.call_uuid,
        require('./voip.cjs').number(scope.webhook.destination_number),
        String(scope.webhook.connected_user || scope.webhook.dialed_user || ''),
      ];
    } else if (scope.documentId && scope.fullHistory) {
      sql = 'SELECT body FROM han_private.voip_calls WHERE document_id=$1 ORDER BY created_at DESC,id';
      params = [scope.documentId];
    } else if (scope.documentId) {
      const numbers = require('./voip.cjs')
        .phones(state.data['icrapro-v1'].docs[0] || {})
        .map((p) => p.phone);
      sql = `SELECT body FROM han_private.voip_calls WHERE id IN (
        SELECT id FROM han_private.voip_calls WHERE phone=ANY($1::text[]) OR document_id=$2 ORDER BY created_at DESC LIMIT 250
      ) OR id IN (SELECT DISTINCT ON(phone) id FROM han_private.voip_calls WHERE phone=ANY($1::text[]) ORDER BY phone,created_at DESC)
      OR ((user_id=$3 OR phone=ANY($1::text[])) AND status IN ('starting','ringing','answered','unknown'))`;
      params = [numbers, scope.documentId, scope.userId || ''];
      if (scope.reserve) {
        sql += ` OR (user_id=$4 AND request_id=$5) OR (phone=$6 AND status IN ('starting','ringing','answered','unknown'))`;
        params.push(scope.userId, scope.requestId, scope.phone);
      }
    } else if (scope.list) {
      const values = [],
        clauses = [];
      if (scope.list.q) {
        values.push(
          '%' +
            String(scope.list.q)
              .replace(/[\\%_]/g, '\\$&')
              .toLocaleLowerCase('tr') +
            '%',
        );
        clauses.push('search_text LIKE $' + values.length);
      }
      if (scope.list.date && /^\d{4}-\d{2}-\d{2}$/.test(scope.list.date)) {
        values.push(scope.list.date + 'T00:00:00+03:00');
        clauses.push(
          'created_at >= $' +
            values.length +
            '::timestamptz AND created_at < $' +
            values.length +
            "::timestamptz + interval '1 day'",
        );
      }
      if (scope.list.status) {
        values.push(
          scope.list.status === 'active'
            ? ['starting', 'ringing', 'answered', 'unknown']
            : [String(scope.list.status)],
        );
        clauses.push('status=ANY($' + values.length + '::text[])');
      }
      if (scope.list.result) {
        values.push(String(scope.list.result));
        clauses.push("body->>'result'=$" + values.length);
      }
      const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
      state.voipTotal = Number(
        (await db.query('SELECT count(*) AS n FROM han_private.voip_calls' + where, values)).rows[0].n,
      );
      state.voipPaged = true;
      sql =
        'SELECT body FROM han_private.voip_calls' +
        where +
        ' ORDER BY ' +
        require('./voip-sorting.cjs').sorting(scope.list).sql +
        ' LIMIT 50 OFFSET $' +
        (values.length + 1);
      params = [...values, Math.min(1000000, Math.max(0, Math.floor(Number(scope.list.offset) || 0)))];
    } else if (scope.transcriptionJobs) {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('han-voip-transcription-claim'))");
      sql = `SELECT body FROM han_private.voip_calls WHERE body->>'archivedAt' IS NOT NULL AND (body->'transcription'->>'status'='queued' OR (body->'transcription'->>'status'='processing' AND (body->'transcription'->>'leaseUntil')::timestamptz<=CURRENT_TIMESTAMP)) AND NOT EXISTS (SELECT 1 FROM han_private.voip_calls WHERE body->'transcription'->>'status'='processing' AND (body->'transcription'->>'leaseUntil')::timestamptz>CURRENT_TIMESTAMP) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    } else if (scope.jobs) {
      sql = `SELECT body FROM han_private.voip_calls WHERE body->>'archivedAt' IS NULL AND body->>'recordingMissing' IS NULL AND (body->>'recordingPresent'='true' OR status='completed')
        AND (body->>'nextArchiveAt' IS NULL OR (body->>'nextArchiveAt')::timestamptz<=CURRENT_TIMESTAMP)
        AND (body->>'archiveStartedAt' IS NULL OR (body->>'archiveStartedAt')::timestamptz<CURRENT_TIMESTAMP-interval '2 minutes')
        ORDER BY created_at LIMIT 2`;
    }
    if (sql) state.voipCalls = (await db.query(sql, params)).rows.map((r) => r.body);
    if (state.voipCalls.length && (scope.id || scope.transcriptionJobs)) {
      const ids = [...new Set(state.voipCalls.map((c) => c.documentId))];
      const rows = records
        ? (
            await db.query(
              "SELECT id,body->>'status' AS status FROM han_data.documents WHERE id=ANY($1::text[])",
              [ids],
            )
          ).rows
        : (
            await db.query(
              "SELECT d->>'id' AS id,d->>'status' AS status FROM han_private.han_state s,jsonb_array_elements(s.payload->'data'->'icrapro-v1'->'docs') d WHERE s.id=1 AND d->>'id'=ANY($1::text[])",
              [ids],
            )
          ).rows;
      state.voipDocumentStates = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    }
    state.voipGrants = scope.permissions
      ? (await db.query('SELECT body FROM han_private.voip_recording_access')).rows.map((r) => r.body)
      : [];
    state.voipAccessibleDocuments = [];
    if (scope.userId && state.voipCalls.length) {
      const current = records
        ? "SELECT id,body->>'relatedStaff' AS staff FROM han_data.documents WHERE active"
        : "SELECT d->>'id' AS id,d->>'relatedStaff' AS staff FROM han_private.han_state s,jsonb_array_elements(s.payload->'data'->'icrapro-v1'->'docs') d WHERE s.id=1";
      state.voipAccessibleDocuments = (
        await db.query(
          `SELECT d.id FROM han_private.voip_recording_access g JOIN han_private.han_account_index a ON a.id=g.user_id AND a.enabled JOIN (${current}) d ON d.staff=a.body->>'staffId' WHERE g.user_id=$1 AND g.body->>'staffId'=a.body->>'staffId' AND d.id=ANY($2::text[])`,
          [scope.userId, [...new Set(state.voipCalls.map((c) => c.documentId))]],
        )
      ).rows.map((r) => r.id);
    }
    const beforeConfig = JSON.stringify(config),
      beforeGrants = JSON.stringify(state.voipGrants),
      before = new Map(state.voipCalls.map((c) => [c.id, JSON.stringify(c)]));
    let saved;
    const result = await work({
      state,
      saveState: (next) => {
        saved = next;
      },
    });
    if (saved) {
      if (scope.permissionUserId && JSON.stringify(saved.voipGrants) !== beforeGrants) {
        const grant = saved.voipGrants.find((g) => g.userId === scope.permissionUserId);
        if (grant)
          await db.query(
            'INSERT INTO han_private.voip_recording_access(user_id,body) VALUES($1,$2::jsonb) ON CONFLICT(user_id) DO UPDATE SET body=excluded.body',
            [scope.permissionUserId, JSON.stringify(grant)],
          );
        else
          await db.query('DELETE FROM han_private.voip_recording_access WHERE user_id=$1', [
            scope.permissionUserId,
          ]);
      }
      if (JSON.stringify(saved.voipConfig) !== beforeConfig)
        await db.query('UPDATE han_private.voip_config SET body=$1::jsonb WHERE id=1', [
          JSON.stringify(saved.voipConfig),
        ]);
      for (const c of saved.voipCalls)
        if (JSON.stringify(c) !== before.get(c.id)) {
          const text = [c.clientName, c.documentNumber, c.debtorName, c.phone, c.staffName, c.result]
            .join(' ')
            .toLocaleLowerCase('tr');
          await db.query(
            `INSERT INTO han_private.voip_calls(id,document_id,phone,user_id,request_id,created_at,status,body,search_text)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body,search_text=excluded.search_text`,
            [
              c.id,
              c.documentId,
              c.phone,
              c.userId,
              c.requestId,
              c.createdAt,
              c.status,
              JSON.stringify(c),
              text,
            ],
          );
        }
    }
    return result;
  });
}
module.exports = { transaction };
async function exportData(db) {
  const data = {
    voipConfig: (await db.query('SELECT body FROM han_private.voip_config WHERE id=1')).rows[0]?.body || {},
    voipCalls: (await db.query('SELECT body FROM han_private.voip_calls ORDER BY created_at,id')).rows.map(
      (r) => r.body,
    ),
    voipGrants: (
      await db.query('SELECT body FROM han_private.voip_recording_access ORDER BY user_id')
    ).rows.map((r) => r.body),
  };
  return Object.keys(data.voipConfig).length || data.voipCalls.length || data.voipGrants.length ? data : {};
}
async function importData(db, state) {
  if (!state.voipConfig && !state.voipCalls?.length && !state.voipGrants?.length) return;
  if ((await db.query('SELECT id FROM han_private.voip_calls LIMIT 1')).rows.length)
    throw Error('Görüşme hedefi boş olmalıdır.');
  if (state.voipConfig)
    await db.query('UPDATE han_private.voip_config SET body=$1::jsonb WHERE id=1', [
      JSON.stringify(state.voipConfig),
    ]);
  for (let i = 0; i < (state.voipCalls || []).length; i += 250)
    await db.query(
      `INSERT INTO han_private.voip_calls(id,document_id,phone,user_id,request_id,created_at,status,body,search_text)
    SELECT c->>'id',c->>'documentId',c->>'phone',c->>'userId',c->>'requestId',(c->>'createdAt')::timestamptz,c->>'status',c,lower(concat_ws(' ',c->>'clientName',c->>'documentNumber',c->>'debtorName',c->>'phone',c->>'staffName',c->>'result')) FROM jsonb_array_elements($1::jsonb) c`,
      [JSON.stringify(state.voipCalls.slice(i, i + 250))],
    );
  for (const grant of state.voipGrants || [])
    await db.query('INSERT INTO han_private.voip_recording_access(user_id,body) VALUES($1,$2::jsonb)', [
      grant.userId,
      JSON.stringify(grant),
    ]);
}
module.exports.exportData = exportData;
module.exports.importData = importData;
