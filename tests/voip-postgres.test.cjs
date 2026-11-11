const test = require('node:test');
const assert = require('node:assert/strict');
const { database, fixture } = require('./support/postgres.cjs');
const { importState } = require('../lib/postgres-store.cjs');
const { transaction } = require('../lib/voip-store.cjs');
test('standalone VoIP calls persist without a document and are scoped by destination or caller', async () => {
  const { pg, pool } = await database();
  try {
    await importState(pool, fixture());
    const call = {
      id: 'standalone-1',
      documentId: '',
      phone: '905320000005',
      userId: 'test-ceo',
      requestId: 'standalone-request-001',
      createdAt: new Date().toISOString(),
      status: 'starting',
    };
    await transaction(
      pool,
      false,
      (tx) => {
        tx.state.voipCalls.push(call);
        tx.saveState(tx.state);
      },
      { standalone: true, reserve: true, phone: call.phone, userId: call.userId, requestId: call.requestId },
    );
    const rows = await transaction(pool, false, (tx) => tx.state.voipCalls, {
      standalone: true,
      phone: call.phone,
      userId: 'other',
    });
    assert.equal(rows[0].id, call.id);
    const other = await transaction(pool, false, (tx) => tx.state.voipCalls, {
      standalone: true,
      phone: '905320000099',
      userId: 'other',
    });
    assert.equal(other.length, 0);
    await transaction(
      pool,
      false,
      (tx) => {
        assert.equal(tx.state.voipCalls[0].id, call.id);
        tx.state.voipCalls[0].cancelRequested = true;
        tx.saveState(tx.state);
      },
      { cancelRequest: true, requestId: call.requestId, userId: call.userId },
    );
    const canceled = await transaction(pool, false, (tx) => tx.state.voipCalls, {
      cancelRequest: true,
      requestId: call.requestId,
      userId: call.userId,
    });
    assert.equal(canceled[0].cancelRequested, true);
    const unauthorized = await transaction(pool, false, (tx) => tx.state.voipCalls, {
      cancelRequest: true,
      requestId: call.requestId,
      userId: 'other',
    });
    assert.equal(unauthorized.length, 0);
  } finally {
    await pg.close();
  }
});
test('dedicated VoIP tables preserve snapshot, paginate history and enforce active-call uniqueness', async () => {
  const { pg, pool } = await database();
  try {
    const state = fixture();
    state.data['icrapro-v1'].clients = [{ id: 'c', name: 'Örnek müvekkil' }];
    state.data['icrapro-v1'].docs = [
      { id: 'd', client: 'c', phone1: '05320000000', relatedStaff: 'p', number: 'D-1' },
    ];
    state.users.push({ ...state.users[0], id: 's', username: 'staff', role: 'staff', staffId: 'p' });
    state.data['icrapro-personnel-v1'] = [{ id: 'p', name: 'Test staff', active: true }];
    await importState(pool, state);
    const before = JSON.stringify(
      (await pool.query('SELECT payload FROM han_private.han_state WHERE id=1')).rows[0].payload,
    );
    await transaction(
      pool,
      false,
      (tx) => {
        assert.equal(tx.state.data['icrapro-v1'].docs[0].id, 'd');
        tx.state.voipConfig = { provider: 'verimor' };
        for (let i = 0; i < 80; i++)
          tx.state.voipCalls.push({
            id: 'call-' + i,
            documentId: 'd',
            phone: '905320000000',
            userId: 'test-ceo',
            requestId: 'request-' + i,
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
            status: 'completed',
            staffName: 'Örnek kişi',
            clientName: 'Örnek müvekkil',
            result: i === 1 ? 'Olumlu' : '',
            duration: i,
            recordingPresent: i < 10,
            archivedAt: i < 5 ? '2026-01-01' : undefined,
          });
        tx.saveState(tx.state);
      },
      { documentId: 'd', configWrite: true },
    );
    const list = await transaction(
      pool,
      false,
      (tx) => ({ rows: tx.state.voipCalls, total: tx.state.voipTotal }),
      { list: { offset: 0 } },
    );
    assert.equal(list.total, 80);
    assert.equal(list.rows.length, 50);
    assert.equal(list.rows[0].id, 'call-79');
    const second = await transaction(pool, false, (tx) => tx.state.voipCalls, { list: { offset: 50 } });
    assert.equal(second.length, 30);
    assert.equal(second[0].id, 'call-29');
    const job = { status: 'queued', configHash: 'test', model: 'openai/gpt-transcribe', parts: [] };
    assert.equal(
      await transaction(pool, false, (tx) => tx.state.voipEnqueued, {
        enqueueTranscription: { mode: 'filtered', filters: { result: 'Olumlu' }, job },
      }),
      1,
    );
    assert.equal(
      await transaction(pool, false, (tx) => tx.state.voipEnqueued, {
        enqueueTranscription: { mode: 'filtered', filters: { result: 'Olumlu' }, job },
      }),
      0,
    );
    assert.equal(
      await transaction(pool, false, (tx) => tx.state.voipEnqueued, {
        enqueueTranscription: { mode: 'selected', ids: ['call-2'], job },
      }),
      1,
    );
    assert.equal(
      await transaction(pool, false, (tx) => tx.state.voipEnqueued, {
        enqueueTranscription: { mode: 'all', job },
      }),
      8,
    );
    const claimed = await transaction(
      pool,
      false,
      (tx) => {
        const c = tx.state.voipCalls[0];
        c.transcription.status = 'processing';
        c.transcription.leaseUntil = new Date(Date.now() + 60000).toISOString();
        tx.saveState(tx.state);
        return c.id;
      },
      { transcriptionJobs: true, aiConfig: true },
    );
    assert.equal(claimed, 'call-0');
    assert.equal(
      (await transaction(pool, false, (tx) => tx.state.voipCalls, { transcriptionJobs: true })).length,
      0,
      'another worker cannot claim while a valid lease is processing',
    );
    const ascending = await transaction(pool, false, (tx) => tx.state.voipCalls, {
      list: { sort: 'date', direction: 'asc' },
    });
    const ascendingNext = await transaction(pool, false, (tx) => tx.state.voipCalls, {
      list: { sort: 'date', direction: 'asc', offset: 50 },
    });
    assert.equal(ascending[0].id, 'call-0');
    assert.equal(ascendingNext[0].id, 'call-50');
    const byDuration = await transaction(pool, false, (tx) => tx.state.voipCalls, {
      list: { sort: 'duration', direction: 'desc' },
    });
    assert.equal(byDuration[0].duration, 79);
    for (const sort of ['client', 'document', 'staff', 'phone', 'status', 'result', 'recording']) {
      assert.equal(
        (await transaction(pool, false, (tx) => tx.state.voipCalls, { list: { sort, direction: 'asc' } }))
          .length,
        50,
      );
    }
    await assert.rejects(
      transaction(pool, false, () => {}, { list: { sort: 'created_at; DROP TABLE voip_calls' } }),
      (e) => e.status === 400,
    );
    const filtered = await transaction(
      pool,
      false,
      (tx) => ({ calls: tx.state.voipCalls, total: tx.state.voipTotal }),
      { list: { status: 'completed', result: 'Olumlu' } },
    );
    assert.equal(filtered.total, 1);
    assert.equal(filtered.calls[0].id, 'call-1');
    assert.equal(await transaction(pool, false, (tx) => tx.state.voipTotal, { list: { status: 'busy' } }), 0);
    const one = await transaction(pool, false, (tx) => tx.state.voipCalls, { id: 'call-1' });
    assert.equal(one.length, 1);
    const query = await transaction(pool, false, (tx) => tx.state.voipTotal, { list: { q: 'müvekkil' } });
    assert.equal(query, 80);
    await transaction(
      pool,
      false,
      (tx) => {
        tx.state.voipCalls[0].status = 'ringing';
        tx.saveState(tx.state);
      },
      { id: 'call-1' },
    );
    await assert.rejects(
      transaction(
        pool,
        false,
        (tx) => {
          tx.state.voipCalls[0].status = 'ringing';
          tx.saveState(tx.state);
        },
        { id: 'call-2' },
      ),
      (e) => e.code === '23505',
    );
    assert.equal(
      JSON.stringify(
        (await pool.query('SELECT payload FROM han_private.han_state WHERE id=1')).rows[0].payload,
      ),
      before,
    );
    await transaction(
      pool,
      false,
      (tx) => {
        tx.state.voipGrants = [{ userId: 's', staffId: 'p', grantedBy: 'test-ceo' }];
        tx.saveState(tx.state);
      },
      { permissions: true, permissionUserId: 's' },
    );
    assert.equal(
      (await pool.query('SELECT user_id FROM han_private.voip_recording_access')).rows[0].user_id,
      's',
    );
    assert.deepEqual(
      await transaction(pool, false, (tx) => tx.state.voipAccessibleDocuments, { id: 'call-1', userId: 's' }),
      ['d'],
    );
    await pool.query(
      "UPDATE han_private.han_state SET payload=jsonb_set(payload,'{data,icrapro-v1,docs,0,relatedStaff}', '\"other\"'::jsonb) WHERE id=1",
    );
    assert.deepEqual(
      await transaction(pool, false, (tx) => tx.state.voipAccessibleDocuments, { id: 'call-1', userId: 's' }),
      [],
    );
    const exported = await require('../lib/voip-store.cjs').exportData(pool);
    assert.equal(exported.voipCalls.length, 80);
    assert.equal(exported.voipGrants[0].userId, 's');
  } finally {
    await pg.close();
  }
});
test('inbound calls persist through the real webhook, keep their file and earlier caller, and never collide with dialing', async () => {
  const { pg, pool } = await database();
  process.env.VOIP_ENCRYPTION_KEY ||= 'ab'.repeat(32);
  const { createVoipHandler, configure } = require('../lib/voip.cjs');
  try {
    const state = fixture();
    state.data['icrapro-v1'].clients = [{ id: 'c', name: 'Örnek müvekkil' }];
    state.data['icrapro-v1'].docs = [
      {
        id: 'd',
        client: 'c',
        phone1: '05320000000',
        relatedStaff: 'p',
        number: 'D-1',
        debtor: 'Örnek borçlu',
      },
    ];
    state.users.push({
      ...state.users[0],
      id: 's',
      name: 'Test staff',
      username: 'staff',
      role: 'staff',
      staffId: 'p',
    });
    state.data['icrapro-personnel-v1'] = [{ id: 'p', name: 'Test staff', active: true }];
    await importState(pool, state);
    await transaction(
      pool,
      false,
      (tx) => {
        tx.state.voipConfig = configure(
          {},
          {
            provider: 'verimor',
            enabled: true,
            apiKey: 'test-only-secret',
            domainId: '123',
            extensions: { 'test-ceo': '1001', s: '1002' },
          },
          state.users,
        );
        // A finished call staff member "s" made to the debtor three days ago.
        tx.state.voipCalls.push({
          id: 'out-seed',
          requestId: 'seed-outbound-0001',
          provider: 'verimor',
          providerId: 'out-uuid-0001',
          documentId: 'd',
          documentNumber: 'D-1',
          clientName: 'Örnek müvekkil',
          debtorName: 'Örnek borçlu',
          phone: '905320000000',
          userId: 's',
          staffName: 'Test staff',
          extension: '1002',
          createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
          status: 'completed',
          duration: 30,
          result: 'Olumlu',
          note: '',
          recordingPresent: false,
        });
        tx.saveState(tx.state);
      },
      { configWrite: true },
    );
    const secret = (await pool.query('SELECT body FROM han_private.voip_config WHERE id=1')).rows[0].body
      .webhookSecret;
    let actor = { id: 's', name: 'Test staff', role: 'staff', staffId: 'p' };
    const jobs = [];
    const h = createVoipHandler({
      transaction: (work, scope) => transaction(pool, false, work, scope),
      authenticatedUser: async () => ({ ...actor }),
      readBody: async (req) => Buffer.from(req.raw || '{}'),
      fetcher: async () => new Response('00000000-0000-0000-0000-0000000000a1'),
      background: (p) => jobs.push(p),
      recordings: { available: false },
    });
    const call = async (route, method, input) => {
      const res = {
        writeHead(status) {
          this.status = status;
        },
        end(value) {
          this.body = value;
        },
      };
      await h(
        { method, headers: { 'content-type': 'application/json' }, raw: JSON.stringify(input) },
        res,
        new URL('http://localhost/api/voip/' + route),
      );
      return JSON.parse(res.body);
    };
    const hook = (extra) =>
      call('webhook?token=' + secret, 'POST', {
        domain_id: '123',
        event_type: 'ringing',
        direction: 'inbound',
        call_uuid: 'in-uuid-pg-0001',
        caller_id_number: '05320000000',
        destination_number: '908501234567',
        dialed_user: '1001',
        ...extra,
      });
    const row = async (uuid) =>
      (
        await pool.query(
          "SELECT document_id,user_id,phone,status,request_id,body FROM han_private.voip_calls WHERE body->>'providerId'=$1",
          [uuid],
        )
      ).rows;
    assert.deepEqual(await hook(), { ok: true });
    let [r] = await row('in-uuid-pg-0001');
    assert.equal(r.body.direction, 'inbound');
    assert.equal(r.document_id, 'd');
    assert.equal(r.phone, '905320000000');
    assert.equal(r.request_id, 'in:in-uuid-pg-0001');
    assert.equal(r.status, 'ringing');
    assert.equal(r.body.ownerUserId, 's');
    assert.equal(r.body.ownerName, 'Test staff');
    assert.equal(r.body.clientName, 'Örnek müvekkil');
    assert.equal(r.user_id, '');
    await hook({ event_type: 'answer', connected_user: '1001' });
    [r] = await row('in-uuid-pg-0001');
    assert.equal(r.status, 'answered');
    assert.equal(r.user_id, 'test-ceo');
    assert.equal(r.body.extension, '1001');
    // While the CEO talks to the debtor, staff can still dial the same number.
    const started = await call('start', 'POST', {
      documentId: 'd',
      phone: '05320000000',
      requestId: 'request-pg-inbound-01',
      confirmRecent: true,
    });
    assert.ok(started.call?.id, 'outbound start is not blocked by the active inbound call');
    const active = (
      await pool.query(
        "SELECT body->>'direction' AS direction,user_id FROM han_private.voip_calls WHERE phone='905320000000' AND status IN ('starting','ringing','answered','unknown') ORDER BY user_id",
      )
    ).rows;
    assert.deepEqual(
      active.map((a) => [a.direction || 'outbound', a.user_id]),
      [
        ['outbound', 's'],
        ['inbound', 'test-ceo'],
      ],
    );
    await hook({ event_type: 'hangup', answered: 'true', duration: '42' });
    await Promise.allSettled(jobs);
    [r] = await row('in-uuid-pg-0001');
    assert.equal(r.status, 'completed');
    assert.equal(r.user_id, 'test-ceo');
    assert.equal(r.body.ownerUserId, 's');
    assert.equal(r.body.duration, 42);
    assert.equal((await row('in-uuid-pg-0001')).length, 1);
    // Two callers ringing at once (nobody answered yet) coexist, then both are missed.
    await hook({ call_uuid: 'in-uuid-pg-0002', caller_id_number: '05551112233' });
    await hook({ call_uuid: 'in-uuid-pg-0003', caller_id_number: '05554445566' });
    const ringing = (
      await pool.query(
        "SELECT phone,user_id FROM han_private.voip_calls WHERE body->>'direction'='inbound' AND status='ringing' ORDER BY phone",
      )
    ).rows;
    assert.deepEqual(ringing, [
      { phone: '905551112233', user_id: '' },
      { phone: '905554445566', user_id: '' },
    ]);
    await hook({
      call_uuid: 'in-uuid-pg-0002',
      caller_id_number: '05551112233',
      event_type: 'hangup',
      answered: 'false',
      duration: '0',
    });
    await hook({
      call_uuid: 'in-uuid-pg-0003',
      caller_id_number: '05554445566',
      event_type: 'hangup',
      answered: 'false',
      duration: '0',
    });
    assert.equal((await row('in-uuid-pg-0002'))[0].status, 'unanswered');
    assert.equal((await row('in-uuid-pg-0003'))[0].status, 'unanswered');
    assert.equal((await row('in-uuid-pg-0002'))[0].document_id, '');
  } finally {
    await pg.close();
  }
});
test('inbound answer in Postgres records the answering staff name', async () => {
  const { pg, pool } = await database();
  process.env.VOIP_ENCRYPTION_KEY ||= 'ab'.repeat(32);
  const { createVoipHandler, configure } = require('../lib/voip.cjs');
  try {
    const state = fixture();
    state.users.push({
      ...state.users[0],
      id: 's',
      name: 'Test staff',
      username: 'staff',
      role: 'staff',
      staffId: 'p',
    });
    // A staff account is enabled only while its personnel record is active.
    state.data['icrapro-personnel-v1'].push({ id: 'p', name: 'Test staff', active: true });
    await importState(pool, state);
    await transaction(
      pool,
      false,
      (tx) => {
        tx.state.voipConfig = configure(
          {},
          {
            provider: 'verimor',
            enabled: true,
            apiKey: 'test-only-secret',
            domainId: '123',
            extensions: { s: '1002' },
          },
          state.users,
        );
        tx.saveState(tx.state);
      },
      { configWrite: true },
    );
    const secret = (await pool.query('SELECT body FROM han_private.voip_config WHERE id=1')).rows[0].body
      .webhookSecret;
    const h = createVoipHandler({
      transaction: (work, scope) => transaction(pool, false, work, scope),
      authenticatedUser: async () => ({ id: 'test-ceo', role: 'ceo', name: 'Test' }),
      readBody: async (req) => Buffer.from(req.raw || '{}'),
      fetcher: async () => new Response('', { status: 404 }),
      recordings: { available: false },
    });
    const hook = async (extra) => {
      const res = {
        writeHead() {},
        end(v) {
          this.body = v;
        },
      };
      const event = {
        domain_id: '123',
        event_type: 'ringing',
        direction: 'inbound',
        call_uuid: 'in-uuid-pg-0100',
        caller_id_number: '05551112233',
        destination_number: '908501234567',
        ...extra,
      };
      await h(
        { method: 'POST', headers: { 'content-type': 'application/json' }, raw: JSON.stringify(event) },
        res,
        new URL('http://localhost/api/voip/webhook?token=' + secret),
      );
    };
    await hook();
    await hook({ event_type: 'answer', connected_user: '1002' });
    const { rows } = await pool.query(
      "SELECT user_id,body FROM han_private.voip_calls WHERE body->>'providerId'='in-uuid-pg-0100'",
    );
    assert.equal(rows[0].user_id, 's');
    assert.equal(rows[0].body.staffName, 'Test staff');
  } finally {
    await pg.close();
  }
});
